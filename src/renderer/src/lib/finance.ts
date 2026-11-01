import { monthlyEquivalentCents, reservePerPaycheckCents } from '@shared/cadence'
import { creditAmountDue, creditCycle, previousCloseDate } from '@shared/credit'
import { addDaysISO, daysBetweenISO } from '@shared/dates'
import { nextBillOccurrence } from '@shared/occurrences'
import { debtPayoff, requiredPaymentCents } from '@shared/payoff'
import type {
  AccountKind,
  AccountWithBalance,
  AllocationBucket,
  Bill,
  GoalWithProgress,
  PayCadence,
  PaycheckWithAllocations,
  TransactionKind,
  TransactionRow
} from '@shared/types'

const CASH_KINDS = new Set(['checking', 'savings', 'cash'])

export const ACCOUNT_KIND_LABEL: Record<AccountKind, string> = {
  checking: 'Checking',
  savings: 'Savings',
  cash: 'Cash',
  investment: 'Investment',
  credit: 'Credit'
}

export const TRANSACTION_KIND_LABEL: Record<TransactionKind, string> = {
  income: 'Income',
  expense: 'Expense',
  bill_payment: 'Bill payment',
  transfer: 'Transfer',
  goal_funding: 'Goal funding',
  investment: 'Investment',
  adjustment: 'Adjustment'
}

export function cashOnHand(accounts: readonly AccountWithBalance[]): number {
  return accounts
    .filter((account) => CASH_KINDS.has(account.kind) && !account.isArchived)
    .reduce((total, account) => total + account.balanceCents, 0)
}

export function creditOwedCents(accounts: readonly AccountWithBalance[]): number {
  return accounts
    .filter((account) => account.kind === 'credit' && !account.isArchived)
    .reduce((total, account) => total + Math.max(0, -account.balanceCents), 0)
}

export function creditAvailableCents(accounts: readonly AccountWithBalance[]): number {
  return accounts
    .filter((account) => account.kind === 'credit' && !account.isArchived)
    .reduce((total, account) => {
      if (account.creditLimitCents === null) return total
      const owed = Math.max(0, -account.balanceCents)
      return total + Math.max(0, account.creditLimitCents - owed)
    }, 0)
}

export function accountDisplayBalanceCents(account: AccountWithBalance): number {
  return account.kind === 'credit' ? Math.max(0, -account.balanceCents) : account.balanceCents
}

/** How far along the card's cycle is, and what the next bill looks like. */
export interface CardStatus {
  closesOn: string
  dueOn: string
  daysUntilDue: number
  /** null when the statement balance was never recorded. */
  amountDueCents: number | null
  /** null when the balance cannot be cleared at the recorded minimum payment. */
  payoffMonths: number | null
  payoffInterestCents: number
  /** What one payment would have to be to clear the card in two years. */
  twoYearPaymentCents: number | null
}

/**
 * The cycle is only knowable when both statement days are set; the amount due
 * also needs the statement balance. Everything here is an estimate for the
 * screen, and each part degrades to "unknown" rather than to a guessed number.
 */
export function cardStatus(input: {
  account: AccountWithBalance
  transactions: readonly TransactionRow[]
  todayISO: string
}): CardStatus | null {
  const { account } = input
  if (account.kind !== 'credit') return null
  if (account.statementDay === null || account.paymentDueDay === null) return null

  const cycle = creditCycle({
    statementDay: account.statementDay,
    paymentDueDay: account.paymentDueDay,
    fromISO: input.todayISO
  })
  const close = previousCloseDate(account.statementDay, input.todayISO)
  const paymentsSinceClose = input.transactions
    .filter(
      (row) =>
        row.accountId === account.id &&
        row.kind === 'transfer' &&
        row.amountCents > 0 &&
        row.occurredOn > close
    )
    .reduce((total, row) => total + row.amountCents, 0)

  const amountDueCents =
    account.lastStatementBalanceCents === null
      ? null
      : creditAmountDue({
          lastStatementBalanceCents: account.lastStatementBalanceCents,
          paymentsSinceCloseCents: paymentsSinceClose
        })

  const owed = accountDisplayBalanceCents(account)
  const aprBps = account.aprBps ?? 0
  const minimum = account.minimumPaymentCents
  const plan =
    minimum !== null && owed > 0
      ? debtPayoff({ balanceCents: owed, aprBps, paymentCents: minimum })
      : null

  return {
    closesOn: cycle.closesOn,
    dueOn: cycle.dueOn,
    daysUntilDue: cycle.daysUntilDue,
    amountDueCents,
    payoffMonths: plan?.months ?? null,
    payoffInterestCents: plan?.totalInterestCents ?? 0,
    twoYearPaymentCents:
      owed > 0 ? requiredPaymentCents({ balanceCents: owed, aprBps, withinMonths: 24 }) : 0
  }
}

export interface UpcomingPayment {
  key: string
  name: string
  kind: 'bill' | 'card'
  dueOn: string
  daysUntil: number
  amountCents: number
}

/**
 * The next two weeks of money leaving, newest first left out on purpose: a bill
 * and a card payment are both due dates, so they share one queue. Card payments
 * only appear once the statement balance and the cycle are known, because a
 * guessed due date is worse than a missing one.
 */
export function upcomingPayments(input: {
  bills: readonly Bill[]
  accounts: readonly AccountWithBalance[]
  transactions: readonly TransactionRow[]
  todayISO: string
  horizonDays?: number
}): UpcomingPayment[] {
  const horizon = input.horizonDays ?? 14
  const limit = addDaysISO(input.todayISO, horizon)
  const items: UpcomingPayment[] = []

  for (const bill of input.bills) {
    if (!bill.isActive) continue
    const dueOn = nextBillOccurrence(bill, input.todayISO)
    if (dueOn > limit) continue
    items.push({
      key: `bill:${bill.id}`,
      name: bill.name,
      kind: 'bill',
      dueOn,
      daysUntil: daysBetweenISO(input.todayISO, dueOn),
      amountCents: bill.amountCents
    })
  }

  for (const account of input.accounts) {
    const card = cardStatus({
      account,
      transactions: input.transactions,
      todayISO: input.todayISO
    })
    if (!card || card.amountDueCents === null || card.amountDueCents <= 0) continue
    if (card.daysUntilDue > horizon) continue
    items.push({
      key: `card:${account.id}`,
      name: `${account.name} payment`,
      kind: 'card',
      dueOn: card.dueOn,
      daysUntil: card.daysUntilDue,
      amountCents: card.amountDueCents
    })
  }

  return items.sort(
    (a, b) => a.dueOn.localeCompare(b.dueOn) || a.name.localeCompare(b.name)
  )
}

/** 1 → "1st", 11 → "11th", 23 → "23rd". Used wherever a day of month is named. */
export function ordinal(value: number): string {
  const mod100 = value % 100
  if (mod100 >= 11 && mod100 <= 13) return `${value}th`
  switch (value % 10) {
    case 1:
      return `${value}st`
    case 2:
      return `${value}nd`
    case 3:
      return `${value}rd`
    default:
      return `${value}th`
  }
}

/** Only money you can actually reach can back a fund. */
export function fundableAccounts(accounts: readonly AccountWithBalance[]): AccountWithBalance[] {
  return accounts.filter(
    (account) =>
      !account.isArchived &&
      (account.kind === 'savings' || account.kind === 'checking' || account.kind === 'cash')
  )
}

export function activeBills(bills: readonly Bill[]): Bill[] {
  return bills.filter((bill) => bill.isActive)
}

export function monthlyWall(bills: readonly Bill[]): number {
  return bills.reduce(
    (total, bill) => total + monthlyEquivalentCents(bill.amountCents, bill.frequency),
    0
  )
}

export function perPaycheckWall(bills: readonly Bill[], cadence: PayCadence): number {
  return bills.reduce(
    (total, bill) => total + reservePerPaycheckCents(bill.amountCents, bill.frequency, cadence),
    0
  )
}

export function goalsSummary(goals: readonly GoalWithProgress[]): {
  targetCents: number
  fundedCents: number
  progress: number
} {
  const active = goals.filter((goal) => !goal.isArchived)
  const targetCents = active.reduce((total, goal) => total + goal.targetCents, 0)
  const fundedCents = active.reduce((total, goal) => total + goal.fundedCents, 0)
  return {
    targetCents,
    fundedCents,
    progress: targetCents > 0 ? fundedCents / targetCents : 0
  }
}

export function fundedGoalsCents(goals: readonly GoalWithProgress[]): number {
  return goals
    .filter((goal) => !goal.isArchived)
    .reduce((total, goal) => total + goal.fundedCents, 0)
}

export interface RoutingBreakdown {
  priorityCents: number
  growthCents: number
  debtCents: number
  leisureCents: number
  totalCents: number
}

/**
 * Month-to-date routing for the donut. Growth folds savings, investments and
 * goal funding together so every routed cent lands in one of four slices.
 */
export function monthRoutingBreakdown(
  paychecks: readonly PaycheckWithAllocations[],
  monthISO: string
): RoutingBreakdown {
  const inMonth = paychecks.filter((paycheck) => paycheck.receivedOn.startsWith(monthISO))
  const sum = (buckets: readonly AllocationBucket[]): number =>
    inMonth.reduce(
      (total, paycheck) =>
        total +
        paycheck.allocations
          .filter((allocation) => buckets.includes(allocation.bucket))
          .reduce((bucketTotal, allocation) => bucketTotal + allocation.amountCents, 0),
      0
    )

  const priorityCents = sum(['priority'])
  const growthCents = sum(['savings', 'investment', 'goal'])
  const debtCents = sum(['debt'])
  const leisureCents = sum(['leisure'])

  return {
    priorityCents,
    growthCents,
    debtCents,
    leisureCents,
    totalCents: priorityCents + growthCents + debtCents + leisureCents
  }
}

export function latestPaycheck(
  paychecks: readonly PaycheckWithAllocations[]
): PaycheckWithAllocations | null {
  return paychecks[0] ?? null
}

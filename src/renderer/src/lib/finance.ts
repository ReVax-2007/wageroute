import { monthlyEquivalentCents, reservePerPaycheckCents } from '@shared/cadence'
import type {
  AccountKind,
  AccountWithBalance,
  AllocationBucket,
  Bill,
  GoalWithProgress,
  PayCadence,
  PaycheckWithAllocations,
  TransactionKind
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

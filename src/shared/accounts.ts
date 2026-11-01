import type {
  AccountKind,
  AccountWithBalance,
  GoalWithProgress,
  PaycheckWithAllocations,
  TransactionRow
} from './types'

/**
 * Kinds whose balance a user can spend without thinking about it. Investment
 * and credit accounts are left out unless the account itself says otherwise.
 */
const SAFE_TO_SPEND_DEFAULT: ReadonlySet<AccountKind> = new Set(['checking', 'savings', 'cash'])

const BUCKET_ORDER = ['Cash', 'Saved for goals', 'Invested', 'Credit owed'] as const

/**
 * Whether an account's balance counts as money the user may spend freely.
 *
 * A dedicated account is excluded by default because its balance is already
 * reported as goal progress: counting it in the Safe-to-spend pool too would
 * let the same cent be spent twice. An explicit choice overrides the default in
 * both directions, so a dedicated account can still be treated as spendable.
 */
export function countsInSafeToSpend(account: AccountWithBalance): boolean {
  if (account.isArchived) return false
  if (account.inSafeToSpend !== null) return account.inSafeToSpend
  if (account.dedicatedGoalId !== null) return false
  return SAFE_TO_SPEND_DEFAULT.has(account.kind)
}

/**
 * The pool Safe to Spend is measured against. Deliberately separate from cash
 * on hand: an account can be tracked as cash and still be excluded from what
 * the user considers spendable.
 *
 * This uses `cashCents`, not the ledger balance: a paycheck dated next Friday
 * is planned money, not spendable money today.
 */
export function safeToSpendPoolCents(accounts: readonly AccountWithBalance[]): number {
  return accounts.reduce(
    (total, account) => (countsInSafeToSpend(account) ? total + account.cashCents : total),
    0
  )
}

/** Everything owned minus everything owed, across every live account kind. */
export function totalWealthCents(accounts: readonly AccountWithBalance[]): number {
  return accounts.reduce(
    (total, account) => (account.isArchived ? total : total + account.balanceCents),
    0
  )
}

/**
 * Goal money that Safe to Spend has to give up. A goal funded from a dedicated
 * account is not in the pool in the first place, so deducting its progress as
 * well would take the same money twice and drive the hero number negative.
 */
export function poolEarmarkedGoalsCents(goals: readonly GoalWithProgress[]): number {
  return goals
    .filter((goal) => !goal.isArchived && goal.fundedFrom !== 'account')
    .reduce((total, goal) => total + goal.fundedCents, 0)
}

/**
 * Money this month's routing promised to debt or investing that is still
 * sitting in a spendable account.
 *
 * Routing is a plan, not a movement (ADR 0013): the cents stay in checking
 * until a card payment or a transfer actually moves them. Deducting the whole
 * allocation forever would charge the same dollar twice once it *is* paid, so
 * a bucket is only deducted to the extent that no matching money has left the
 * pool since the paycheque arrived. Savings is deliberately absent — a savings
 * account in the pool is still spendable, and one outside it is already
 * excluded from the pool.
 */
export function unsettledRoutingCents(input: {
  paychecks: readonly PaycheckWithAllocations[]
  transactions: readonly TransactionRow[]
  accounts: readonly AccountWithBalance[]
  todayISO: string
}): number {
  const month = input.todayISO.slice(0, 7)
  const cycle = input.paychecks.filter((paycheck) => paycheck.receivedOn.startsWith(month))
  if (cycle.length === 0) return 0

  const since = cycle.reduce(
    (earliest, paycheck) => (paycheck.receivedOn < earliest ? paycheck.receivedOn : earliest),
    cycle[0].receivedOn
  )
  const routed = (bucket: 'debt' | 'investment'): number =>
    cycle.reduce(
      (total, paycheck) =>
        total +
        paycheck.allocations
          .filter((allocation) => allocation.bucket === bucket)
          .reduce((sum, allocation) => sum + allocation.amountCents, 0),
      0
    )

  const kindById = new Map(input.accounts.map((account) => [account.id, account.kind]))
  const movedTo = (kind: 'credit' | 'investment'): number =>
    input.transactions
      .filter(
        (transaction) =>
          transaction.occurredOn >= since &&
          transaction.amountCents > 0 &&
          kindById.get(transaction.accountId) === kind
      )
      .reduce((total, transaction) => total + transaction.amountCents, 0)

  return (
    Math.max(0, routed('debt') - movedTo('credit')) +
    Math.max(0, routed('investment') - movedTo('investment'))
  )
}

export interface WealthBucket {
  label: string
  cents: number
}

/**
 * Total wealth split by what the money is doing. Credit balances are already
 * stored negative, so summing the buckets reproduces totalWealthCents exactly.
 */
export function wealthBuckets(accounts: readonly AccountWithBalance[]): WealthBucket[] {
  const buckets = new Map<string, number>()
  for (const account of accounts) {
    if (account.isArchived) continue
    const label =
      account.kind === 'credit'
        ? 'Credit owed'
        : account.dedicatedGoalId !== null
          ? 'Saved for goals'
          : account.kind === 'investment'
            ? 'Invested'
            : 'Cash'
    buckets.set(label, (buckets.get(label) ?? 0) + account.balanceCents)
  }
  return BUCKET_ORDER.filter((label) => buckets.has(label)).map((label) => ({
    label,
    cents: buckets.get(label) as number
  }))
}

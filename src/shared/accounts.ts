import type {
  AccountKind,
  AccountWithBalance,
  GoalWithProgress,
  PaycheckWithAllocations,
  TransactionRow
} from './types'
import { formatMoney } from './money'
import { FLOOR_KINDS } from './writeRules'

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
  // Locked money still counts as wealth, but it cannot be moved, so it is not spendable.
  if (account.isLocked) return false
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
    (total, account) =>
      countsInSafeToSpend(account) ? total + usableCents(account, account.cashCents) : total,
    0
  )
}

/**
 * How much of the spendable accounts' cash their floors keep out of the pool,
 * so a screen can say why "cash you can spend" is less than the balances.
 */
export function floorHeldCents(accounts: readonly AccountWithBalance[]): number {
  return accounts.reduce(
    (total, account) =>
      countsInSafeToSpend(account)
        ? total + account.cashCents - usableCents(account, account.cashCents)
        : total,
    0
  )
}

type FloorAccount = Pick<AccountWithBalance, 'kind' | 'floorCents'>

/**
 * The floor that applies to an account, or null when it has none (ADR 0035).
 * A floor stored on a kind that cannot carry one is ignored, never enforced.
 */
export function accountFloorCents(account: FloorAccount): number | null {
  return account.floorCents !== null && FLOOR_KINDS.has(account.kind) ? account.floorCents : null
}

/**
 * What the app may offer as spendable from one account: the balance minus its
 * floor, never below zero. An account without a floor reads exactly as it did
 * before floors existed, overdraft included. The balance itself never changes.
 */
export function usableCents(
  account: FloorAccount & Pick<AccountWithBalance, 'balanceCents'>,
  balanceCents: number = account.balanceCents
): number {
  const floor = accountFloorCents(account)
  return floor === null ? balanceCents : Math.max(0, balanceCents - floor)
}

/** "$110.00 usable · $90.00 floor", or null for an account without a floor. */
export function usableLabel(
  account: FloorAccount & Pick<AccountWithBalance, 'balanceCents'>,
  currency: string,
  balanceCents: number = account.balanceCents
): string | null {
  const floor = accountFloorCents(account)
  if (floor === null) return null
  return `${formatMoney(usableCents(account, balanceCents), currency)} usable · ${formatMoney(floor, currency)} floor`
}

/**
 * Whether moving `deltaCents` would leave a balance under a floor. Only money
 * leaving counts: a deposit into an account already under its floor helps.
 */
export function breachesFloor(floorCents: number | null, balanceCents: number, deltaCents: number): boolean {
  return floorCents !== null && deltaCents < 0 && balanceCents + deltaCents < floorCents
}

export interface FloorBreach {
  accountName: string
  floorCents: number
  afterCents: number
}

/** The breach a write by the owner would cause, so the screen can ask first. */
export function floorBreach(
  account: FloorAccount & Pick<AccountWithBalance, 'balanceCents' | 'name'>,
  deltaCents: number
): FloorBreach | null {
  const floor = accountFloorCents(account)
  if (floor === null || !breachesFloor(floor, account.balanceCents, deltaCents)) return null
  return { accountName: account.name, floorCents: floor, afterCents: account.balanceCents + deltaCents }
}

/** The one question both devices ask before a write goes under a floor. */
export function floorBreachQuestion(
  breach: FloorBreach,
  currency: string
): { title: string; body: string; confirmLabel: string } {
  return {
    title: `Go under the ${breach.accountName} floor?`,
    body:
      `This leaves ${breach.accountName} at ${formatMoney(breach.afterCents, currency)}, ` +
      `below the ${formatMoney(breach.floorCents, currency)} you set as its floor. ` +
      'Save anyway, or cancel and change the amount.',
    confirmLabel: 'Save anyway'
  }
}

/**
 * Whether new money can be posted to or from an account: live, not archived,
 * not locked. Every account picker that leads to a write uses this.
 */
export function isUsableAccount(account: { isArchived: boolean; isLocked: boolean }): boolean {
  return !account.isArchived && !account.isLocked
}

/**
 * A card's balance read as money owed: positive when the user owes, negative
 * when the card is overpaid. Display badges clamp at zero; an edit form must
 * not, or the credit it is about to change silently starts at zero.
 */
export function cardOwedCents(account: AccountWithBalance): number {
  return account.kind === 'credit' ? -account.balanceCents : account.balanceCents
}

/**
 * The accounts a card payment can leave from. Another card cannot pay this one
 * — that is a balance transfer, not a payment — and a holding is money the user
 * has committed elsewhere, so only real spendable balances are offered.
 */
export function cardPaymentSources(
  accounts: readonly AccountWithBalance[]
): AccountWithBalance[] {
  return accounts.filter(
    (account) => isUsableAccount(account) && account.kind !== 'credit' && account.kind !== 'investment'
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
  const paycheckIds = new Set(cycle.map((paycheck) => paycheck.id))
  // Only money a plan actually moved settles the plan. An unrelated deposit,
  // card payment or market gain into the same account must not make this
  // month's routing look paid when it is still sitting in checking.
  const movedTo = (kind: 'credit' | 'investment'): number =>
    input.transactions
      .filter(
        (transaction) =>
          transaction.occurredOn >= since &&
          transaction.amountCents > 0 &&
          transaction.paycheckId !== null &&
          paycheckIds.has(transaction.paycheckId) &&
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

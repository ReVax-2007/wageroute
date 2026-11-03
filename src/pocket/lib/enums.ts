import type {
  AccountKind,
  AllocationBucket,
  BillFundingStrategy,
  BillReserveState,
  CategoryKind,
  Frequency,
  GoalFundingPace,
  PlanHealth,
  TransactionKind
} from '@shared/types'
import * as rules from '@shared/writeRules'

/**
 * The same value sets the desktop's write paths check against, read as sets
 * because an import asks "is this one of the allowed values" rather than
 * "return the narrow type". `@shared/writeRules` owns the lists, so a value the
 * phone accepts is a value the computer can store — and the reverse.
 */
export const ACCOUNT_KINDS: ReadonlySet<string> = new Set<AccountKind>(rules.ACCOUNT_KINDS)
export const TRANSACTION_KINDS: ReadonlySet<string> = new Set<TransactionKind>(
  rules.TRANSACTION_KINDS
)
export const FREQUENCIES: ReadonlySet<string> = new Set<Frequency>(rules.FREQUENCIES)
export const FUNDING_STRATEGIES: ReadonlySet<string> = new Set<BillFundingStrategy>(
  rules.BILL_FUNDING_STRATEGIES
)
export const CATEGORY_KINDS: ReadonlySet<string> = new Set<CategoryKind>(rules.CATEGORY_KINDS)
export const GOAL_FUNDING_PACES: ReadonlySet<string> = new Set<GoalFundingPace>(
  rules.GOAL_FUNDING_PACES
)

export const ALLOCATION_BUCKETS: ReadonlySet<string> = new Set<AllocationBucket>([
  'priority',
  'savings',
  'investment',
  'goal',
  'debt',
  'leisure'
])
export const PLAN_HEALTH: ReadonlySet<string> = new Set<PlanHealth>([
  'covered',
  'tight',
  'shortfall'
])
export const BILL_RESERVE_STATES: ReadonlySet<string> = new Set<BillReserveState>([
  'reserved',
  'paid'
])

/**
 * A backup may leave an enum out, so a missing value keeps the default. A
 * value that is present but unknown is caught before this point rather than
 * quietly becoming a different account kind or transaction kind.
 */
export function pick<T extends string>(
  allowed: ReadonlySet<string>,
  value: string,
  fallback: T
): T {
  return (allowed.has(value) ? value : fallback) as T
}

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

export const ACCOUNT_KINDS: ReadonlySet<string> = new Set<AccountKind>([
  'checking',
  'savings',
  'cash',
  'investment',
  'credit'
])
export const TRANSACTION_KINDS: ReadonlySet<string> = new Set<TransactionKind>([
  'income',
  'expense',
  'bill_payment',
  'transfer',
  'goal_funding',
  'investment',
  'adjustment'
])
export const FREQUENCIES: ReadonlySet<string> = new Set<Frequency>([
  'weekly',
  'biweekly',
  'semimonthly',
  'monthly',
  'quarterly',
  'annual'
])
export const FUNDING_STRATEGIES: ReadonlySet<string> = new Set<BillFundingStrategy>([
  'all_checks',
  'closest_due_date',
  'specific_check',
  'first_check',
  'last_check'
])
export const ALLOCATION_BUCKETS: ReadonlySet<string> = new Set<AllocationBucket>([
  'priority',
  'savings',
  'investment',
  'goal',
  'debt',
  'leisure'
])
export const CATEGORY_KINDS: ReadonlySet<string> = new Set<CategoryKind>([
  'expense',
  'income',
  'transfer',
  'other'
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
export const GOAL_FUNDING_PACES: ReadonlySet<string> = new Set<GoalFundingPace>([
  'asap',
  'by_date',
  'paused'
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

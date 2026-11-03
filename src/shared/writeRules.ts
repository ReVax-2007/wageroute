import { isISODate } from './dates'
import { RepositoryError } from './errors'
import type {
  AccountKind,
  CategoryKind,
  Frequency,
  GoalFundingPace,
  TransactionKind
} from './types'

/**
 * The rules a row has to satisfy before it is written, and nothing else.
 *
 * The desktop applies them inside its SQLite repositories; Pocket applies the
 * same ones to the JSON copy it keeps on the phone. They live here because two
 * devices that reject the same typo for the same sentence are far easier to
 * trust than two that invent their own. Nothing in this module may touch a
 * database, the filesystem or Electron.
 */

export const ACCOUNT_KINDS: readonly AccountKind[] = [
  'checking',
  'savings',
  'cash',
  'investment',
  'credit'
]

export const CATEGORY_KINDS: readonly CategoryKind[] = ['expense', 'income', 'transfer', 'other']

export const TRANSACTION_KINDS: readonly TransactionKind[] = [
  'income',
  'expense',
  'bill_payment',
  'transfer',
  'goal_funding',
  'investment',
  'adjustment'
]

export const FREQUENCIES: readonly Frequency[] = [
  'weekly',
  'biweekly',
  'semimonthly',
  'monthly',
  'quarterly',
  'annual'
]

export const BILL_FUNDING_STRATEGIES = [
  'all_checks',
  'closest_due_date',
  'specific_check',
  'first_check',
  'last_check'
] as const

export const GOAL_FUNDING_PACES = ['by_date', 'paused', 'asap'] as const

export function nowISO(): string {
  return new Date().toISOString()
}

export function assertText(value: unknown, label: string, max = 160): string {
  if (typeof value !== 'string') throw new RepositoryError('VALIDATION', `${label} must be text`)
  const trimmed = value.trim()
  if (!trimmed) throw new RepositoryError('VALIDATION', `${label} is required`)
  if (trimmed.length > max) throw new RepositoryError('VALIDATION', `${label} is too long`)
  return trimmed
}

/**
 * A field the form left empty — including one holding only spaces — is no value
 * at all, so it clears the column instead of refusing the whole write.
 */
export function optionalText(value: unknown, label: string, max = 160): string | null {
  if (value === null || value === undefined || value === '') return null
  if (typeof value === 'string' && value.trim() === '') return null
  return assertText(value, label, max)
}

export interface CentsOptions {
  allowNegative?: boolean
  allowZero?: boolean
}

export function assertCents(value: unknown, label: string, options: CentsOptions = {}): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new RepositoryError('VALIDATION', `${label} must be a number`)
  }
  const cents = Math.round(value)
  if (!Number.isSafeInteger(cents)) throw new RepositoryError('VALIDATION', `${label} is out of range`)
  if (!options.allowNegative && cents < 0) throw new RepositoryError('VALIDATION', `${label} cannot be negative`)
  if (!options.allowZero && cents === 0) throw new RepositoryError('VALIDATION', `${label} cannot be zero`)
  return cents
}

export function assertOneOf<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new RepositoryError('VALIDATION', `Invalid ${label}`)
  }
  return value as T
}

export function assertDate(value: unknown, label: string): string {
  if (!isISODate(value)) throw new RepositoryError('VALIDATION', `${label} must be a date in YYYY-MM-DD form`)
  return value
}

export function assertPriority(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 100
  return Math.round(value)
}

/**
 * A due day is a whole number 1–31; the date helpers clamp a 29–31 to the
 * month's length. Values outside that range are refused rather than silently
 * become the 31st, which hid a typo behind a plausible-looking bill. The label
 * names the column the form asked for — a statement day says so itself.
 */
export function assertDueDay(value: unknown, label = 'Due day'): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new RepositoryError('VALIDATION', `${label} must be a whole number from 1 to 31`, 'dueDay')
  }
  if (value < 1 || value > 31) {
    throw new RepositoryError('VALIDATION', `${label} must be a whole number from 1 to 31`, 'dueDay')
  }
  return value
}

/** Index into the guaranteed paycheck slots: the 1st through the 4th check. */
export function assertPaycheckIndex(value: unknown): number | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new RepositoryError('VALIDATION', 'Paycheck choice must be a number')
  }
  const index = Math.round(value)
  if (index < 1 || index > 4) {
    throw new RepositoryError('VALIDATION', 'Paycheck choice must be the 1st through the 4th check')
  }
  return index
}

export function assertSortOrder(value: unknown): number {
  if (value === undefined || value === null) return 0
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new RepositoryError('VALIDATION', 'Sort order must be a number')
  }
  return Math.round(value)
}

/** 0–1000% is a wide enough band to catch a typo like 1999 meaning 19.99%. */
export function assertAprBps(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new RepositoryError('VALIDATION', 'APR must be a number')
  }
  const rounded = Math.round(value)
  if (rounded < 0 || rounded > 100_000) {
    throw new RepositoryError('VALIDATION', 'APR must be between 0% and 1000%')
  }
  return rounded
}

/**
 * A field a patch may clear. `undefined` means "not in this patch", so a partial
 * edit never blanks a column the form did not show; `null` is an explicit clear.
 */
export function optionalCents(
  value: number | null | undefined,
  label: string,
  options: CentsOptions = {}
): number | null | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  return assertCents(value, label, options)
}

export function optionalAprBps(value: number | null | undefined): number | null | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  return assertAprBps(value)
}

export function optionalDay(
  value: number | null | undefined,
  label: string
): number | null | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new RepositoryError('VALIDATION', `${label} must be a number`)
  }
  return assertDueDay(value, label)
}

/**
 * A goal's pace is a three-way switch, and an unreadable value means "no pace
 * chosen yet" rather than a rejected write — the desktop has always treated a
 * missing pace as "as soon as the money allows".
 */
export function assertPace(value: unknown): GoalFundingPace {
  return value === 'by_date' || value === 'paused' ? value : 'asap'
}

export function flagColumn(value: unknown): 0 | 1 | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'boolean') return value ? 1 : 0
  if (value === 0 || value === 1) return value
  // `"false"` is a truthy string; coercing it silently would turn a flag on.
  throw new RepositoryError('VALIDATION', 'Expected a true or false value')
}

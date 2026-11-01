import type Database from 'better-sqlite3'
import { isISODate } from '@shared/dates'
import { RepositoryError } from '@shared/errors'
import type { AccountKind } from '@shared/types'

export type Db = Database.Database

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

export function optionalText(value: unknown, label: string, max = 160): string | null {
  if (value === null || value === undefined || value === '') return null
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

/** A due day is 1–31; the date helpers clamp a 29–31 to the month's length. */
export function assertDueDay(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new RepositoryError('VALIDATION', 'Due day must be a number')
  }
  return Math.min(31, Math.max(1, Math.round(value)))
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

export type Table = 'accounts' | 'bills' | 'goals' | 'transactions' | 'categories'

export function updateRow(
  db: Db,
  table: Table,
  id: string,
  userId: string,
  fields: Record<string, string | number | null | undefined>
): void {
  const entries = Object.entries(fields).filter(
    (entry): entry is [string, string | number | null] => entry[1] !== undefined
  )
  if (entries.length === 0) return

  const assignments = entries.map(([column]) => `${column} = ?`).join(', ')
  const result = db
    .prepare(
      `UPDATE ${table}
       SET ${assignments}, updated_at = ?, revision = revision + 1
       WHERE id = ? AND user_id = ? AND deleted_at IS NULL`
    )
    .run(...entries.map(([, value]) => value), nowISO(), id, userId)
  if (result.changes === 0) throw new RepositoryError('NOT_FOUND', 'That record no longer exists')
}

export function softDelete(db: Db, table: Table, id: string, userId: string): void {
  const ts = nowISO()
  const result = db
    .prepare(
      `UPDATE ${table}
       SET deleted_at = ?, updated_at = ?, revision = revision + 1
       WHERE id = ? AND user_id = ? AND deleted_at IS NULL`
    )
    .run(ts, ts, id, userId)
  if (result.changes === 0) throw new RepositoryError('NOT_FOUND', 'That record no longer exists')
}

export function requireAccount(
  db: Db,
  userId: string,
  accountId: string,
  options: { allowArchived?: boolean } = {}
): { id: string; kind: AccountKind } {
  const row = db
    .prepare(
      `SELECT id, kind, is_archived AS isArchived FROM accounts
       WHERE id = ? AND user_id = ? AND deleted_at IS NULL`
    )
    .get(accountId, userId) as { id: string; kind: AccountKind; isArchived: number } | undefined
  if (!row) throw new RepositoryError('NOT_FOUND', 'Account not found')
  // An archived account is out of every total and every picker on purpose.
  // Posting new money to it would change a balance nobody is looking at.
  if (row.isArchived === 1 && options.allowArchived !== true) {
    throw new RepositoryError('STATE', 'That account is archived — restore it before using it here')
  }
  return { id: row.id, kind: row.kind }
}

/**
 * dedicated_goal_id has no database foreign key (see the v4 migration note), so
 * every write path has to check the target exists.
 */
export function requireGoal(db: Db, userId: string, goalId: string): { id: string; name: string } {
  const row = db
    .prepare('SELECT id, name FROM goals WHERE id = ? AND user_id = ? AND deleted_at IS NULL')
    .get(goalId, userId) as { id: string; name: string } | undefined
  if (!row) throw new RepositoryError('NOT_FOUND', 'Goal not found')
  return row
}

export function flagColumn(value: unknown): 0 | 1 | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'boolean') return value ? 1 : 0
  if (value === 0 || value === 1) return value
  // `"false"` is a truthy string; coercing it silently would turn a flag on.
  throw new RepositoryError('VALIDATION', 'Expected a true or false value')
}

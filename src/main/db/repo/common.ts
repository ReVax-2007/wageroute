import type Database from 'better-sqlite3-multiple-ciphers'
import { RepositoryError } from '@shared/errors'
import type { AccountKind } from '@shared/types'
import { nowISO } from '@shared/writeRules'

export type Db = Database.Database

/**
 * The pure half of a write lives in `@shared/writeRules`, because Pocket applies
 * the same rules to its JSON copy on the phone. This module keeps that surface
 * under the same names the repositories already import, and adds the half that
 * can only exist against a database: the row that was updated, the row that was
 * retired, and the reference that has to point at something live.
 */
export {
  assertAprBps,
  assertCents,
  assertDate,
  assertDueDay,
  assertOneOf,
  assertPace,
  assertPaycheckIndex,
  assertPriority,
  assertSortOrder,
  assertText,
  flagColumn,
  nowISO,
  optionalAprBps,
  optionalCents,
  optionalDay,
  optionalText,
  type CentsOptions
} from '@shared/writeRules'

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

export type Table = 'accounts' | 'bills' | 'goals' | 'transactions' | 'categories'

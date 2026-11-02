import { RepositoryError } from '@shared/errors'
import type { User } from '@shared/types'
import { compact } from '../maintenance'
import { nowISO, type Db } from './common'

export function getUser(db: Db, userId: string): User {
  const row = db
    .prepare(
      `SELECT id, email, display_name AS displayName, currency,
              created_at AS createdAt, updated_at AS updatedAt,
              deleted_at AS deletedAt, revision
       FROM users WHERE id = ? AND deleted_at IS NULL`
    )
    .get(userId) as User | undefined
  if (!row) throw new RepositoryError('NOT_FOUND', 'Local user is missing')
  return row
}

/**
 * The name the Home screen greets the user with. Empty is a real answer: the
 * packaged seed asks for a name instead of inventing one, so clearing it must
 * restore the generic greeting rather than be refused as a blank field.
 */
export function setDisplayName(db: Db, userId: string, raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new RepositoryError('VALIDATION', 'Your name must be text')
  }
  const name = raw.trim()
  if (name.length > 60) {
    throw new RepositoryError('VALIDATION', 'Your name is too long', 'displayName')
  }
  // A line break would split the dashboard greeting across lines.
  if (/[\u0000-\u001f\u007f]/.test(name)) {
    throw new RepositoryError('VALIDATION', 'Your name cannot contain line breaks', 'displayName')
  }
  const result = db
    .prepare(
      `UPDATE users SET display_name = ?, updated_at = ?, revision = revision + 1
       WHERE id = ? AND deleted_at IS NULL`
    )
    .run(name, nowISO(), userId)
  if (result.changes === 0) throw new RepositoryError('NOT_FOUND', 'Local user is missing')
  return name
}

export function getLocalUserId(db: Db): string {
  const row = db
    .prepare('SELECT id FROM users WHERE deleted_at IS NULL ORDER BY created_at LIMIT 1')
    .get() as { id: string } | undefined
  if (!row) throw new RepositoryError('NOT_FOUND', 'No local user has been seeded')
  return row.id
}

// Every tenant table, children before parents. Literal names only; the reset
// path must never interpolate user input here.
const WIPE_TABLES = [
  'allocations',
  'bill_reserves',
  'balance_snapshots',
  'transactions',
  'paychecks',
  'goals',
  'bills',
  'categories',
  'accounts',
  'settings',
  'users'
] as const

export function wipeAllData(db: Db): void {
  db.pragma('foreign_keys = OFF')
  try {
    db.transaction(() => {
      for (const table of WIPE_TABLES) {
        db.prepare(`DELETE FROM ${table}`).run()
      }
    })()
  } finally {
    db.pragma('foreign_keys = ON')
  }
  // DELETE only marks pages free. Rebuild the file and truncate the WAL so the
  // erased ledger cannot be read back out of free space.
  compact(db)
}

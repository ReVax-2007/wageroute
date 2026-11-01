import { RepositoryError } from '@shared/errors'
import { isCurrencyCode } from '@shared/settings'
import { nowISO, type Db } from './common'

export function readSettings(db: Db, userId: string): Record<string, string> {
  const rows = db
    .prepare('SELECT key, value FROM settings WHERE user_id = ?')
    .all(userId) as { key: string; value: string }[]
  return Object.fromEntries(rows.map((row) => [row.key, row.value]))
}

export function writeSettings(
  db: Db,
  userId: string,
  values: Record<string, string>
): void {
  if (values.currency !== undefined && !isCurrencyCode(values.currency)) {
    throw new RepositoryError('VALIDATION', 'That currency code is not one this build supports', 'currency')
  }
  const statement = db.prepare(
    `INSERT INTO settings (user_id, key, value, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  )
  const ts = nowISO()
  db.transaction(() => {
    for (const [key, value] of Object.entries(values)) {
      statement.run(userId, key, value, ts)
    }
  })()
}

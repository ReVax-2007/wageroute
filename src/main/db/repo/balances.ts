import { randomUUID } from 'node:crypto'
import { addDaysISO, todayISO } from '@shared/dates'
import type { BalanceSnapshot } from '@shared/types'
import { nowISO, type Db } from './common'

const HISTORY_DAYS = 400

/**
 * Records every live account's balance once for the given day. A second launch
 * the same day changes nothing: the first read of the day is the record, and
 * later edits are visible through the live balance, not by rewriting history.
 * Returns how many rows were actually written.
 */
export function recordDailySnapshots(
  db: Db,
  userId: string,
  day: string = todayISO()
): number {
  const ts = nowISO()
  const accounts = db
    .prepare(
      `SELECT a.id,
              a.starting_balance_cents + COALESCE((
                SELECT SUM(t.amount_cents) FROM transactions t
                WHERE t.account_id = a.id AND t.deleted_at IS NULL AND t.occurred_on <= ?
              ), 0) AS balance
       FROM accounts a
       WHERE a.user_id = ? AND a.deleted_at IS NULL`
    )
    .all(day, userId) as { id: string; balance: number }[]

  const insert = db.prepare(
    `INSERT OR IGNORE INTO balance_snapshots
       (id, user_id, account_id, on_date, balance_cents,
        created_at, updated_at, deleted_at, revision)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 1)`
  )

  let written = 0
  db.transaction(() => {
    for (const account of accounts) {
      const result = insert.run(
        randomUUID(),
        userId,
        account.id,
        day,
        account.balance,
        ts,
        ts
      )
      written += result.changes
    }
  })()
  return written
}

/** The recent history, oldest first, so a chart can draw it without sorting. */
export function listBalanceSnapshots(
  db: Db,
  userId: string,
  until: string = todayISO()
): BalanceSnapshot[] {
  const since = addDaysISO(until, -HISTORY_DAYS)
  return db
    .prepare(
      `SELECT id, user_id AS userId, account_id AS accountId, on_date AS onDate,
              balance_cents AS balanceCents, created_at AS createdAt,
              updated_at AS updatedAt, deleted_at AS deletedAt, revision
       FROM balance_snapshots
       WHERE user_id = ? AND deleted_at IS NULL AND on_date >= ? AND on_date <= ?
       ORDER BY on_date, account_id`
    )
    .all(userId, since, until) as BalanceSnapshot[]
}

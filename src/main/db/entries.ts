import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { CsvEntry, CsvIssue } from '@shared/csv'

type Db = Database.Database

interface AccountLite {
  id: string
  name: string
  institution: string | null
}

export interface EntryMergeResult {
  added: number
  skipped: number
  issues: CsvIssue[]
}

function key(value: string | null | undefined): string {
  return (value ?? '').trim().toLocaleLowerCase()
}

/**
 * Inserts CSV entries straight into the ledger so historical rows do not trigger
 * round-up sweeps, and skips rows whose account cannot be matched locally.
 */
export function mergeEntries(
  db: Db,
  userId: string,
  entries: readonly CsvEntry[]
): EntryMergeResult {
  const accounts = db
    .prepare(`SELECT id, name, institution FROM accounts WHERE user_id = ? AND deleted_at IS NULL`)
    .all(userId) as AccountLite[]

  const insert = db.prepare(
    `INSERT INTO transactions
       (id, user_id, account_id, kind, amount_cents, occurred_on, memo, category,
        bill_id, goal_id, paycheck_id, counter_account_id, transfer_group_id,
        created_at, updated_at, deleted_at, revision)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?, NULL, 1)`
  )
  const countExisting = db.prepare(
    `SELECT COUNT(*) AS total FROM transactions
     WHERE user_id = ? AND account_id = ? AND kind = ? AND amount_cents = ?
       AND occurred_on = ? AND memo = ? AND category = ? AND deleted_at IS NULL`
  )

  const issues: CsvIssue[] = []
  const now = new Date().toISOString()
  let added = 0
  let skipped = 0

  const resolved: { entry: CsvEntry; accountId: string }[] = []
  for (const entry of entries) {
    const nameMatches = accounts.filter((account) => key(account.name) === key(entry.accountName))
    let candidates = nameMatches
    if (entry.institution) {
      const bankMatches = nameMatches.filter(
        (account) => key(account.institution) === key(entry.institution)
      )
      if (bankMatches.length > 0) candidates = bankMatches
    }

    if (candidates.length === 0) {
      issues.push({ line: entry.line, message: `no account named “${entry.accountName}”` })
      continue
    }
    if (candidates.length > 1) {
      issues.push({ line: entry.line, message: `“${entry.accountName}” matches more than one account` })
      continue
    }
    resolved.push({ entry, accountId: candidates[0].id })
  }

  // Rows in the file may legitimately repeat (two identical coffees on one
  // day), so allow each file occurrence to claim one row already on disk.
  const fingerprint = (entry: CsvEntry, accountId: string): string =>
    JSON.stringify([
      accountId,
      entry.kind,
      entry.amountCents,
      entry.occurredOn,
      entry.memo,
      entry.category
    ])
  const existing = new Map<string, number>()
  for (const { entry, accountId } of resolved) {
    const id = fingerprint(entry, accountId)
    if (existing.has(id)) continue
    const row = countExisting.get(
      userId,
      accountId,
      entry.kind,
      entry.amountCents,
      entry.occurredOn,
      entry.memo,
      entry.category
    ) as { total: number }
    existing.set(id, row.total)
  }

  db.transaction(() => {
    for (const { entry, accountId } of resolved) {
      const id = fingerprint(entry, accountId)
      const remaining = existing.get(id) ?? 0
      if (remaining > 0) {
        existing.set(id, remaining - 1)
        skipped += 1
        continue
      }

      insert.run(
        randomUUID(),
        userId,
        accountId,
        entry.kind,
        entry.amountCents,
        entry.occurredOn,
        entry.memo,
        entry.category,
        now,
        now
      )
      added += 1
    }
  })()

  return { added, skipped, issues }
}

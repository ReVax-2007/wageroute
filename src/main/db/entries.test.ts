import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import test from 'node:test'
import type { CsvEntry } from '@shared/csv'
import { mergeEntries } from './entries'
import { migrate } from './migrations'
import { createAccount, listTransactions } from './repositories'

const USER_ID = '11111111-2222-3333-4444-555555555555'

function freshDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  migrate(db)
  db.prepare(
    `INSERT INTO users (id, display_name, created_at, updated_at)
     VALUES (?, 'Tester', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
  ).run(USER_ID)
  return db
}

function account(db: Database.Database): string {
  return createAccount(db, USER_ID, {
    name: 'Chequing',
    kind: 'checking',
    institution: 'Chase',
    startingBalanceCents: 0,
    creditLimitCents: null
  })
}

/** A statement's lines carry no account name; the wizard supplies one answer. */
function statementLine(line: number, occurredOn: string, amountCents: number): CsvEntry {
  return {
    line,
    occurredOn,
    accountName: '',
    institution: 'Chase',
    kind: amountCents > 0 ? 'income' : 'expense',
    category: 'Uncategorized',
    memo: `line ${line}`,
    amountCents,
    externalId: null
  }
}

test('a statement lands on the account the wizard picked, and re-imports as duplicates', () => {
  const db = freshDb()
  const chequing = account(db)
  const entries = [statementLine(1, '2026-01-05', -425), statementLine(2, '2026-01-07', 250_000)]

  const first = mergeEntries(db, USER_ID, entries, { accountMap: { '': chequing } })
  assert.deepEqual([first.added, first.skipped, first.issues], [2, 0, []])
  assert.ok(listTransactions(db, USER_ID).every((row) => row.accountId === chequing))

  const again = mergeEntries(db, USER_ID, entries, { accountMap: { '': chequing } })
  assert.deepEqual([again.added, again.skipped], [0, 2], 'the same statement is not a second month')
})

test('an unanswered statement reports once, not once per line', () => {
  const db = freshDb()
  account(db)
  const entries = [statementLine(1, '2026-01-05', -425), statementLine(2, '2026-01-07', 250_000)]

  const quiet = mergeEntries(db, USER_ID, entries, { reportedNames: new Set(['']) })
  assert.deepEqual([quiet.added, quiet.skipped, quiet.issues.length], [0, 0, 0])

  const loud = mergeEntries(db, USER_ID, entries)
  assert.equal(loud.issues.length, 2, 'without the wizard the rows each explain themselves')
})

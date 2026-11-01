import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import test from 'node:test'
import { parseCsv, parseEntriesCsv, transactionsToCsv } from '@shared/csv'
import { mergeEntries } from './entries'
import { migrate } from './migrations'
import {
  createAccount,
  createTransaction,
  listAccounts,
  listAllTransactions,
  listTransactions
} from './repositories'

const USER_ID = '11111111-2222-3333-4444-555555555555'
const ROWS = 505

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

function account(db: Database.Database, name = 'Chequing'): string {
  return createAccount(db, USER_ID, {
    name,
    kind: 'checking',
    institution: 'Chase',
    startingBalanceCents: 0,
    creditLimitCents: null
  })
}

function day(index: number): string {
  return new Date(Date.UTC(2026, 0, 1 + index)).toISOString().slice(0, 10)
}

/** A ledger larger than the grid cap, exported and read back as a file would be. */
function seedLedger(db: Database.Database, accountId: string): void {
  db.transaction(() => {
    for (let index = 0; index < ROWS; index += 1) {
      const income = index % 2 === 0
      createTransaction(db, USER_ID, {
        accountId,
        kind: income ? 'income' : 'expense',
        amountCents: income ? 50_000 + index : -(100 + index),
        occurredOn: day(index),
        category: 'Misc',
        memo: `row ${index}`
      })
    }
  })()
}

test('an export larger than the grid cap carries every row, and re-imports whole', () => {
  const source = freshDb()
  const sourceAccount = account(source)
  seedLedger(source, sourceAccount)

  assert.equal(listTransactions(source, USER_ID).length, 500, 'the snapshot view is capped')
  const everything = listAllTransactions(source, USER_ID)
  assert.equal(everything.length, ROWS, 'the export is not capped')

  const csv = transactionsToCsv(everything, listAccounts(source, USER_ID), 'USD')
  assert.equal(parseCsv(csv).length, ROWS + 1, 'every row plus the header is written')

  const { entries, issues } = parseEntriesCsv(csv)
  assert.deepEqual(issues, [])
  assert.equal(entries.length, ROWS)

  const target = freshDb()
  const targetAccount = account(target)
  const merged = mergeEntries(target, USER_ID, entries, {
    accountMap: { chequing: targetAccount }
  })
  assert.deepEqual([merged.added, merged.skipped, merged.issues], [ROWS, 0, []])
  assert.equal(listAllTransactions(target, USER_ID).length, ROWS)

  const sum = (db: Database.Database): number =>
    (db
      .prepare('SELECT COALESCE(SUM(amount_cents), 0) AS total FROM transactions')
      .get() as { total: number }).total
  assert.equal(sum(target), sum(source), 'the money survives the round trip exactly')

  const again = mergeEntries(target, USER_ID, entries, {
    accountMap: { chequing: targetAccount }
  })
  assert.deepEqual([again.added, again.skipped, again.issues], [0, ROWS, []], 'a second import is not a second copy')
})

test('the cap is 500 by default but an explicit limit is honoured', () => {
  const db = freshDb()
  const chequing = account(db)
  seedLedger(db, chequing)

  assert.equal(listTransactions(db, USER_ID, 10).length, 10)
  assert.equal(listTransactions(db, USER_ID, ROWS * 2).length, ROWS)
})

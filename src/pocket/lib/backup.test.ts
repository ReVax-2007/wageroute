import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import test from 'node:test'
import { todayISO } from '@shared/dates'
import { buildBackup, backupToJson, mergeBackup, parseBackupJson } from '../../main/db/backup'
import { migrate } from '../../main/db/migrations'
import { seedDemoIfEmpty, seedIfEmpty } from '../../main/db/seed'
import { parseBackup, BackupFileError, backupToJson as pocketToJson } from './backup'
import { createEntryRow, EntryError, entryAccounts } from './entry'
import { text } from './rows'

const here = dirname(fileURLToPath(import.meta.url))
const example = readFileSync(join(here, '../../../examples/backup.example.json'), 'utf8')

function demoJson(): { db: Database.Database; userId: string; json: string } {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  migrate(db)
  const userId = seedDemoIfEmpty(db)
  return { db, userId, json: backupToJson(buildBackup(db, userId)) }
}

test('the example backup opens on the phone', () => {
  const backup = parseBackup(example)
  assert.equal(backup.format, 'cash-flow-routing-backup')
  assert.equal(backup.tables.accounts.length, 2)
  assert.equal(backup.tables.transactions.length, 4)
  assert.deepEqual(parseBackup(pocketToJson(backup)).tables, backup.tables)
})

test('a file that is not a WageRoute backup is refused with a plain reason', () => {
  const cases: [string, RegExp][] = [
    ['not json at all', /not valid JSON/],
    ['{"format":"other","version":10,"tables":{}}', /not a WageRoute backup/],
    ['{"format":"cash-flow-routing-backup","tables":{}}', /no version/],
    ['{"format":"cash-flow-routing-backup","version":1,"tables":{}}', /this old/],
    ['{"format":"cash-flow-routing-backup","version":10,"tables":{"accounts":"no"}}', /not a list/],
    ['{"format":"cash-flow-routing-backup","version":10,"tables":{"accounts":[1]}}', /not a record/],
    ['{"format":"cash-flow-routing-backup","version":10,"tables":{"accounts":[]}}', /no accounts/]
  ]
  for (const [text, expected] of cases) {
    assert.throws(() => parseBackup(text), (error: unknown) => {
      assert.ok(error instanceof BackupFileError)
      assert.match(error.message, expected)
      return true
    })
  }
})

test('a newer backup still opens, and says which schema it came from', () => {
  const newer = JSON.parse(example) as { version: number }
  newer.version = 99
  const backup = parseBackup(JSON.stringify(newer))
  assert.equal(backup.version, 99)
})

test('a same-version file with an unknown kind is refused instead of coerced', () => {
  const raw = JSON.parse(example) as { tables: { accounts: Record<string, unknown>[] } }
  raw.tables.accounts[0].kind = 'brokerage'
  assert.throws(() => parseBackup(JSON.stringify(raw)), /unknown account kind \(brokerage\)/)
})

test('dollars pasted into a cents column are refused, not rounded', () => {
  const raw = JSON.parse(example) as { tables: { transactions: Record<string, unknown>[] } }
  raw.tables.transactions[0].amount_cents = -12.5
  assert.throws(() => parseBackup(JSON.stringify(raw)), /amount that is not a whole number/)
})

test('whole numbers spelled as strings still open', () => {
  const raw = JSON.parse(example) as {
    tables: { accounts: Record<string, unknown>[]; transactions: Record<string, unknown>[] }
  }
  raw.tables.accounts[0].kind = 'cash'
  raw.tables.transactions[0].amount_cents = String(raw.tables.transactions[0].amount_cents)
  const backup = parseBackup(JSON.stringify(raw))
  assert.equal(backup.tables.accounts[0].kind, 'cash')
  assert.equal(typeof backup.tables.transactions[0].amount_cents, 'string')
})

test('a newer schema may carry a kind this build cannot name yet', () => {
  const raw = JSON.parse(example) as {
    version: number
    tables: { accounts: Record<string, unknown>[] }
  }
  raw.version = 99
  raw.tables.accounts[0].kind = 'brokerage'
  assert.equal(parseBackup(JSON.stringify(raw)).version, 99)
})

test('a partial backup fills the missing tables instead of refusing to open', () => {
  const backup = parseBackup(
    JSON.stringify({
      format: 'cash-flow-routing-backup',
      version: 10,
      tables: { accounts: [{ id: 'a', name: 'Cash', kind: 'cash', deleted_at: null }] }
    })
  )
  assert.equal(backup.tables.accounts.length, 1)
  assert.deepEqual(backup.tables.transactions, [])
})

test('an entry gets the sign its kind requires', () => {
  const { json } = demoJson()
  const tables = parseBackup(json).tables
  const account = entryAccounts(tables)[0]
  assert.ok(account)
  const accountId = text(account, 'id')

  const expense = createEntryRow(tables, {
    accountId,
    kind: 'expense',
    amountCents: 1250,
    occurredOn: todayISO(),
    memo: 'Coffee',
    categoryId: null,
    categoryName: 'Food'
  })
  const income = createEntryRow(tables, {
    accountId,
    kind: 'income',
    amountCents: 2500,
    occurredOn: todayISO(),
    memo: 'Refund',
    categoryId: null,
    categoryName: 'Income'
  })
  assert.equal(expense.amount_cents, -1250)
  assert.equal(expense.category, 'Food')
  assert.equal(income.amount_cents, 2500)
  assert.equal(expense.kind, 'expense')
  assert.equal(expense.bill_id, null)
  assert.equal(expense.revision, 1)
})

test('an entry that cannot be honest about itself is refused', () => {
  const { json } = demoJson()
  const tables = parseBackup(json).tables
  const accountId = text(entryAccounts(tables)[0]!, 'id')
  const base = {
    accountId,
    kind: 'expense' as const,
    amountCents: 100,
    occurredOn: todayISO(),
    memo: '',
    categoryId: null,
    categoryName: ''
  }

  const cases: [Parameters<typeof createEntryRow>[1], RegExp][] = [
    [{ ...base, accountId: 'missing' }, /Pick an account/],
    [{ ...base, amountCents: 0 }, /greater than zero/],
    [{ ...base, amountCents: -5 }, /greater than zero/],
    [{ ...base, occurredOn: '2999-01-01' }, /in the future/],
    [{ ...base, occurredOn: 'not-a-date' }, /real date/]
  ]
  for (const [draft, expected] of cases) {
    assert.throws(() => createEntryRow(tables, draft), (error: unknown) => {
      assert.ok(error instanceof EntryError)
      assert.match(error.message, expected)
      return true
    })
  }
})

test('a backup exported from the phone merges into the desktop without touching what is there', () => {
  const { json } = demoJson()
  const backup = parseBackup(json)
  const account = entryAccounts(backup.tables)[0]!
  const entry = createEntryRow(backup.tables, {
    accountId: text(account, 'id'),
    kind: 'expense',
    amountCents: 750,
    occurredOn: todayISO(),
    memo: 'Pharmacy',
    categoryId: null,
    categoryName: 'Health'
  })
  const exported = pocketToJson({
    ...backup,
    exportedAt: new Date().toISOString(),
    tables: { ...backup.tables, transactions: [...backup.tables.transactions, entry] }
  })

  const desktop = new Database(':memory:')
  desktop.pragma('foreign_keys = ON')
  migrate(desktop)
  const userId = seedIfEmpty(desktop)
  const initial = mergeBackup(desktop, userId, parseBackupJson(json))
  assert.equal(initial.issues.length, 0)
  const before = (desktop.prepare('SELECT COUNT(*) AS total FROM transactions').get() as { total: number })
    .total

  const merged = mergeBackup(desktop, userId, parseBackupJson(exported))
  assert.equal(merged.issues.length, 0)
  assert.equal(merged.added.transactions, 1)
  assert.equal(
    (desktop.prepare('SELECT COUNT(*) AS total FROM transactions').get() as { total: number }).total,
    before + 1
  )
  const stored = desktop
    .prepare('SELECT amount_cents, memo, kind, occurred_on FROM transactions WHERE id = ?')
    .get(text(entry, 'id')) as
    | { amount_cents: number; memo: string; kind: string; occurred_on: string }
    | undefined
  assert.ok(stored)
  assert.equal(stored.amount_cents, -750)
  assert.equal(stored.memo, 'Pharmacy')
  assert.equal(stored.kind, 'expense')
  assert.equal(stored.occurred_on, todayISO())

  // Importing the same file a second time is a no-op.
  const again = mergeBackup(desktop, userId, parseBackupJson(exported))
  assert.equal(again.added.transactions, 0)
})

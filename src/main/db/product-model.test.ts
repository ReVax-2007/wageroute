import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import test from 'node:test'
import { todayISO } from '@shared/dates'
import { DEFAULT_CATEGORIES } from '@shared/categories'
import type { LedgerQuery } from '@shared/types'
import { MIGRATIONS, migrate } from './migrations'
import {
  createAccount,
  createBill,
  createCategory,
  createTransaction,
  deleteCategory,
  deleteTransactions,
  listBalanceSnapshots,
  listCategories,
  postDueAutopay,
  queryTransactions,
  recordDailySnapshots,
  updateCategory
} from './repositories'

const USER_ID = '11111111-2222-3333-4444-555555555555'
const TS = '2026-01-01T00:00:00.000Z'

function freshDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  migrate(db)
  db.prepare(
    `INSERT INTO users (id, display_name, created_at, updated_at) VALUES (?, 'Tester', ?, ?)`
  ).run(USER_ID, TS, TS)
  return db
}

function migrateThrough(db: Database.Database, version: number): void {
  // `migrate()` suspends enforcement and keeps ALTER TABLE from rewriting the
  // REFERENCES clause in dependent tables; a helper that walks the same steps
  // has to do the same or v6 leaves transactions pointing at bills_v5_old.
  db.pragma('foreign_keys = OFF')
  db.pragma('legacy_alter_table = ON')
  try {
    for (const migration of MIGRATIONS) {
      if (migration.version > version) break
      db.transaction(() => {
        migration.up(db)
        db.pragma(`user_version = ${migration.version}`)
      })()
    }
  } finally {
    db.pragma('legacy_alter_table = OFF')
    db.pragma('foreign_keys = ON')
  }
}

function account(db: Database.Database, name = 'Chequing'): string {
  return createAccount(db, USER_ID, {
    name,
    kind: 'checking',
    institution: '',
    startingBalanceCents: 100_000
  })
}

function entry(
  db: Database.Database,
  accountId: string,
  input: {
    amountCents?: number
    kind?: 'expense' | 'income'
    occurredOn?: string
    memo?: string
    category?: string
    categoryId?: string | null
  } = {}
): string {
  return createTransaction(db, USER_ID, {
    accountId,
    kind: input.kind ?? 'expense',
    amountCents: input.amountCents ?? -1_000,
    occurredOn: input.occurredOn ?? '2026-10-05',
    memo: input.memo ?? 'Entry',
    category: input.category ?? 'Groceries',
    categoryId: input.categoryId ?? null
  })
}

function ledgerQuery(overrides: Partial<LedgerQuery> = {}): LedgerQuery {
  return {
    filter: {},
    sort: 'date_desc',
    limit: 50,
    offset: 0,
    ...overrides
  }
}

test('v8 seeds the default categories and links existing rows by name', () => {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  migrateThrough(db, 7)
  db.prepare(
    `INSERT INTO users (id, display_name, created_at, updated_at) VALUES (?, 'Tester', ?, ?)`
  ).run(USER_ID, TS, TS)
  db.prepare(
    `INSERT INTO accounts (id, user_id, name, kind, created_at, updated_at)
     VALUES ('acc-1', ?, 'Chequing', 'checking', ?, ?)`
  ).run(USER_ID, TS, TS)
  for (const [id, category] of [
    ['txn-1', 'Groceries'],
    ['txn-2', 'groceries'],
    ['txn-3', 'Something New']
  ]) {
    db.prepare(
      `INSERT INTO transactions
         (id, user_id, account_id, kind, amount_cents, occurred_on, category, created_at, updated_at)
       VALUES (?, ?, 'acc-1', 'expense', -1000, '2026-09-30', ?, ?, ?)`
    ).run(id, USER_ID, category, TS, TS)
  }

  migrate(db)

  const categories = listCategories(db, USER_ID)
  for (const seed of DEFAULT_CATEGORIES) {
    assert.ok(
      categories.some((category) => category.name === seed.name),
      `${seed.name} was seeded`
    )
  }

  const linked = db
    .prepare('SELECT id, category_id AS categoryId FROM transactions ORDER BY id')
    .all() as { id: string; categoryId: string | null }[]
  const groceries = categories.find((category) => category.name === 'Groceries')
  assert.ok(groceries)
  assert.equal(linked[0].categoryId, groceries.id)
  assert.equal(linked[1].categoryId, groceries.id, 'case does not split the category')
  const unknown = categories.find((category) => category.name === 'Something New')
  assert.ok(unknown, 'a name the ledger used becomes a category of its own')
  assert.equal(linked[2].categoryId, unknown.id)

  const snapshots = listBalanceSnapshots(db, USER_ID)
  assert.equal(snapshots.length, 1, 'today gets one row per live account')
  assert.equal(snapshots[0].onDate, todayISO())
  assert.equal(snapshots[0].balanceCents, -3_000, 'the opening snapshot includes the ledger')
  db.close()
})

test('categories dedupe by name, rename the ledger text and survive deletion', () => {
  const db = freshDb()
  const accountId = account(db)
  const first = createCategory(db, USER_ID, { name: 'Dining', kind: 'expense' })
  const again = createCategory(db, USER_ID, { name: '  dining ', kind: 'expense' })
  assert.equal(again, first, 'a second spelling returns the existing row')

  const entryId = entry(db, accountId, { category: 'Dining', categoryId: first })
  updateCategory(db, USER_ID, first, { name: 'Eating out' })

  const renamed = db
    .prepare('SELECT category, category_id AS categoryId FROM transactions WHERE id = ?')
    .get(entryId) as { category: string; categoryId: string }
  assert.equal(renamed.category, 'Eating out', 'the ledger text follows the rename')
  assert.equal(renamed.categoryId, first)

  deleteCategory(db, USER_ID, first)
  const after = db
    .prepare('SELECT category, category_id AS categoryId FROM transactions WHERE id = ?')
    .get(entryId) as { category: string; categoryId: string | null }
  assert.equal(after.categoryId, null, 'the link is released')
  assert.equal(after.category, 'Eating out', 'the text stays as history')
  assert.equal(
    listCategories(db, USER_ID).some((category) => category.id === first),
    false
  )
  db.close()
})

test('the ledger query filters, sorts and pages in SQL', () => {
  const db = freshDb()
  const chequing = account(db, 'Chequing')
  const savings = account(db, 'Savings')
  const trips = createCategory(db, USER_ID, { name: 'Trips', kind: 'expense' })

  entry(db, chequing, { amountCents: -1_000, occurredOn: '2026-10-01', memo: 'Coffee', category: 'Dining' })
  entry(db, chequing, { amountCents: -9_500, occurredOn: '2026-10-10', memo: 'Flight', category: 'Trips', categoryId: trips })
  entry(db, savings, { amountCents: 250_000, kind: 'income', occurredOn: '2026-10-15', memo: 'Paycheck', category: 'Income' })

  assert.equal(queryTransactions(db, USER_ID, ledgerQuery()).total, 3)

  const text = queryTransactions(db, USER_ID, ledgerQuery({ filter: { text: 'fli' } }))
  assert.deepEqual(
    text.rows.map((row) => row.memo),
    ['Flight'],
    'search is case-insensitive and matches the middle of a word'
  )

  const ranged = queryTransactions(
    db,
    USER_ID,
    ledgerQuery({ filter: { from: '2026-10-05', to: '2026-10-12' } })
  )
  assert.deepEqual(ranged.rows.map((row) => row.memo), ['Flight'])

  const byAccount = queryTransactions(db, USER_ID, ledgerQuery({ filter: { accountId: savings } }))
  assert.deepEqual(byAccount.rows.map((row) => row.memo), ['Paycheck'])

  const byKind = queryTransactions(db, USER_ID, ledgerQuery({ filter: { kind: 'expense' } }))
  assert.equal(byKind.total, 2)

  const byCategory = queryTransactions(
    db,
    USER_ID,
    ledgerQuery({ filter: { categoryId: trips } })
  )
  assert.deepEqual(byCategory.rows.map((row) => row.memo), ['Flight'])

  const largest = queryTransactions(db, USER_ID, ledgerQuery({ sort: 'amount_desc' }))
  assert.deepEqual(largest.rows.map((row) => row.memo), ['Paycheck', 'Flight', 'Coffee'])

  const secondPage = queryTransactions(db, USER_ID, ledgerQuery({ limit: 2, offset: 2 }))
  assert.equal(secondPage.total, 3, 'the total ignores the page window')
  assert.deepEqual(secondPage.rows.map((row) => row.memo), ['Coffee'])
  db.close()
})

test('a bulk delete removes each selected entry once and leaves the rest', () => {
  const db = freshDb()
  const accountId = account(db)
  const first = entry(db, accountId, { memo: 'One' })
  const second = entry(db, accountId, { memo: 'Two' })
  const third = entry(db, accountId, { memo: 'Three' })

  assert.equal(deleteTransactions(db, USER_ID, [first, second, first, 'missing']), 2)
  const left = queryTransactions(db, USER_ID, ledgerQuery()).rows
  assert.deepEqual(left.map((row) => row.id), [third])
  assert.equal(deleteTransactions(db, USER_ID, []), 0)
  db.close()
})

test('daily snapshots record once per day', () => {
  const db = freshDb()
  account(db)
  assert.equal(recordDailySnapshots(db, USER_ID, '2026-10-20'), 1)
  assert.equal(recordDailySnapshots(db, USER_ID, '2026-10-20'), 0, 'a second open adds nothing')
  assert.equal(recordDailySnapshots(db, USER_ID, '2026-10-21'), 1)
  assert.equal(listBalanceSnapshots(db, USER_ID, '2026-10-21').length, 2)
  db.close()
})

test('autopay posts a due bill once and never guesses an account', () => {
  const db = freshDb()
  const chequing = account(db)
  const bill = createBill(db, USER_ID, {
    name: 'Hydro',
    amountCents: 12_000,
    frequency: 'monthly',
    dueDay: 15,
    category: 'Utilities',
    accountId: chequing,
    autopay: true,
    isActive: true,
    nextDueOn: null
  })
  const orphan = createBill(db, USER_ID, {
    name: 'No account',
    amountCents: 5_000,
    frequency: 'monthly',
    dueDay: 15,
    category: 'Subscriptions',
    accountId: null,
    autopay: true,
    isActive: true,
    nextDueOn: null
  })

  const first = postDueAutopay(db, USER_ID, '2026-10-20')
  assert.deepEqual(first, { posted: 1, skipped: 1 })

  const payment = db
    .prepare(
      `SELECT kind, amount_cents AS amountCents, occurred_on AS occurredOn, memo, bill_id AS billId
       FROM transactions WHERE bill_id = ?`
    )
    .get(bill) as {
    kind: string
    amountCents: number
    occurredOn: string
    memo: string
    billId: string
  }
  assert.equal(payment.kind, 'bill_payment')
  assert.equal(payment.amountCents, -12_000, 'a payment is money out')
  assert.equal(payment.occurredOn, '2026-10-15', 'dated the day it was due')
  assert.equal(payment.memo, 'Hydro · autopay')

  assert.deepEqual(postDueAutopay(db, USER_ID, '2026-10-20'), { posted: 0, skipped: 1 })
  assert.equal(
    (db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE bill_id = ?').get(orphan) as { n: number }).n,
    0,
    'the bill with no account stays unpaid rather than guessed'
  )
  assert.equal(
    (db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE bill_id = ?').get(bill) as { n: number }).n,
    1,
    'the paid bill is not paid again on the next launch'
  )
  db.close()
})

test('autopay posts only the remainder after a part payment', () => {
  const db = freshDb()
  const chequing = account(db)
  const bill = createBill(db, USER_ID, {
    name: 'Water',
    amountCents: 12_000,
    frequency: 'monthly',
    dueDay: 15,
    category: 'Utilities',
    accountId: chequing,
    autopay: true,
    isActive: true,
    nextDueOn: null
  })
  createTransaction(db, USER_ID, {
    accountId: chequing,
    kind: 'bill_payment',
    amountCents: -5_000,
    occurredOn: '2026-10-15',
    memo: 'Water part',
    category: 'Utilities',
    billId: bill
  })

  assert.deepEqual(postDueAutopay(db, USER_ID, '2026-10-20'), { posted: 1, skipped: 0 })
  const posted = db
    .prepare("SELECT amount_cents AS amount FROM transactions WHERE bill_id = ? AND memo LIKE '%autopay'")
    .get(bill) as { amount: number }
  assert.equal(posted.amount, -7_000, 'the part payment is not charged twice')
  db.close()
})

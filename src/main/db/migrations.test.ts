import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import test from 'node:test'
import { MIGRATIONS, SCHEMA_VERSION, SchemaTooNewError, migrate } from './migrations'

const USER_ID = '11111111-2222-3333-4444-555555555555'
const ACCOUNT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const BILL_ID = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff'
const OTHER_BILL_ID = 'cccccccc-dddd-eeee-ffff-000000000000'
const TS = '2026-01-01T00:00:00.000Z'

function migrateThrough(db: Database.Database, version: number): void {
  for (const migration of MIGRATIONS) {
    if (migration.version > version) break
    db.transaction(() => {
      migration.up(db)
      db.pragma(`user_version = ${migration.version}`)
    })()
  }
}

/** A schema-5 database with one bill that a ledger entry points at. */
function v5Database(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  migrateThrough(db, 5)
  db.prepare(
    `INSERT INTO users (id, display_name, created_at, updated_at)
     VALUES (?, 'Tester', ?, ?)`
  ).run(USER_ID, TS, TS)
  db.prepare(
    `INSERT INTO accounts (id, user_id, name, kind, created_at, updated_at)
     VALUES (?, ?, 'Everyday Checking', 'checking', ?, ?)`
  ).run(ACCOUNT_ID, USER_ID, TS, TS)
  db.prepare(
    `INSERT INTO bills (id, user_id, name, amount_cents, frequency, due_day, created_at, updated_at)
     VALUES (?, ?, 'Rent', 185000, 'monthly', 1, ?, ?)`
  ).run(BILL_ID, USER_ID, TS, TS)
  db.prepare(
    `INSERT INTO transactions
       (id, user_id, account_id, kind, amount_cents, occurred_on, bill_id, created_at, updated_at)
     VALUES ('txn-1', ?, ?, 'bill_payment', -185000, '2026-01-01', ?, ?, ?)`
  ).run(USER_ID, ACCOUNT_ID, BILL_ID, TS, TS)
  return db
}

test('the v5 schema refuses the new strategy until v6 runs', () => {
  const db = v5Database()
  assert.throws(
    () => db.prepare('UPDATE bills SET funding_strategy = ?').run('last_check'),
    /CHECK/i
  )
  db.close()
})

test('v6 rebuilds bills, keeps every row and restores enforcement', () => {
  const db = v5Database()
  migrate(db)

  assert.equal(SCHEMA_VERSION, 8)
  assert.equal(db.pragma('user_version', { simple: true }), 8)
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1, 'enforcement is back on')
  assert.deepEqual(db.pragma('foreign_key_check'), [])
  assert.equal(db.pragma('integrity_check', { simple: true }), 'ok')

  const bill = db.prepare('SELECT id, name, amount_cents, funding_strategy FROM bills').get() as {
    id: string
    name: string
    amount_cents: number
    funding_strategy: string
  }
  assert.equal(bill.id, BILL_ID)
  assert.equal(bill.name, 'Rent')
  assert.equal(bill.amount_cents, 185_000)
  assert.equal(bill.funding_strategy, 'all_checks', 'existing bills keep the spread')

  const indexes = (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'bills'")
      .all() as { name: string }[]
  ).map((row) => row.name)
  assert.ok(indexes.includes('idx_bills_sync'), 'the sync index is recreated')

  db.prepare('UPDATE bills SET funding_strategy = ? WHERE id = ?').run('last_check', BILL_ID)
  assert.equal(
    (db.prepare('SELECT funding_strategy FROM bills WHERE id = ?').get(BILL_ID) as {
      funding_strategy: string
    }).funding_strategy,
    'last_check'
  )
  assert.throws(
    () => db.prepare('UPDATE bills SET funding_strategy = ? WHERE id = ?').run('sometimes', BILL_ID),
    /CHECK/i
  )
  assert.throws(
    () => db.prepare('DELETE FROM bills WHERE id = ?').run(BILL_ID),
    /FOREIGN KEY/i,
    'transactions.bill_id still points at bills'
  )
  db.close()
})

test('a dangling bill reference aborts the upgrade instead of being written', () => {
  const db = v5Database()
  db.pragma('foreign_keys = OFF')
  db.prepare(
    `INSERT INTO transactions
       (id, user_id, account_id, kind, amount_cents, occurred_on, bill_id, created_at, updated_at)
     VALUES ('txn-dangling', ?, ?, 'bill_payment', -100, '2026-01-02', ?, ?, ?)`
  ).run(USER_ID, ACCOUNT_ID, OTHER_BILL_ID, TS, TS)
  db.pragma('foreign_keys = ON')

  assert.throws(() => migrate(db), /dangling foreign key/)
  assert.equal(db.pragma('user_version', { simple: true }), 5, 'the failed upgrade rolled back')
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1, 'enforcement is restored on failure')
  assert.throws(
    () => db.prepare('UPDATE bills SET funding_strategy = ?').run('last_check'),
    /CHECK/i,
    'the bills table was not left half-rebuilt'
  )
  db.close()
})

test('v7 links round-ups, creates the wall lifecycle and drops dead settings', () => {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  migrateThrough(db, 6)
  db.prepare(
    `INSERT INTO users (id, display_name, created_at, updated_at)
     VALUES (?, 'Tester', ?, ?)`
  ).run(USER_ID, TS, TS)
  db.prepare(
    `INSERT INTO accounts (id, user_id, name, kind, created_at, updated_at)
     VALUES (?, ?, 'Everyday Checking', 'checking', ?, ?)`
  ).run(ACCOUNT_ID, USER_ID, TS, TS)
  db.prepare(
    `INSERT INTO bills (id, user_id, name, amount_cents, frequency, due_day, created_at, updated_at)
     VALUES (?, ?, 'Rent', 185000, 'monthly', 1, ?, ?)`
  ).run(BILL_ID, USER_ID, TS, TS)
  db.prepare(
    `INSERT INTO paychecks (id, user_id, amount_cents, received_on, health, created_at, updated_at)
     VALUES ('pay-1', ?, 240000, '2026-10-24', 'covered', ?, ?)`
  ).run(USER_ID, TS, TS)
  for (const key of ['emergencyAccountIds', 'insurance_floor_cents', 'round_up_enabled', 'currency']) {
    db.prepare(
      `INSERT INTO settings (user_id, key, value, updated_at) VALUES (?, ?, 'x', ?)`
    ).run(USER_ID, key, TS)
  }

  migrate(db)

  const columns = (
    db.prepare('PRAGMA table_info(transactions)').all() as { name: string }[]
  ).map((column) => column.name)
  assert.ok(columns.includes('round_up_source_id'), 'the sweep points at its purchase')

  const keys = (
    db.prepare('SELECT key FROM settings ORDER BY key').all() as { key: string }[]
  ).map((row) => row.key)
  assert.deepEqual(keys, ['currency'], 'only keys this build reads survive')

  db.prepare(
    `INSERT INTO bill_reserves
       (id, user_id, bill_id, paycheck_id, cycle, amount_cents, state, created_at, updated_at)
     VALUES ('r1', ?, ?, 'pay-1', '2026-10', 185000, 'reserved', ?, ?)`
  ).run(USER_ID, BILL_ID, TS, TS)
  assert.equal(
    (db.prepare('SELECT COUNT(*) AS n FROM bill_reserves').get() as { n: number }).n,
    1
  )

  const plan = db
    .prepare(
      `EXPLAIN QUERY PLAN
       SELECT * FROM transactions
       WHERE user_id = ? AND deleted_at IS NULL
       ORDER BY occurred_on DESC, created_at DESC`
    )
    .all(USER_ID) as { detail: string }[]
  assert.ok(
    plan.some((step) => step.detail.includes('idx_transactions_user_date')),
    'the ledger sort is served by the index'
  )
  assert.ok(
    !plan.some((step) => step.detail.includes('TEMP B-TREE')),
    'no temp B-tree for the snapshot order'
  )
  db.close()
})

/** A schema-1 database as the first release wrote it: no categories, no reserves. */
function v1Database(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  migrateThrough(db, 1)
  db.prepare(
    `INSERT INTO users (id, email, display_name, currency, created_at, updated_at)
     VALUES (?, 'me@example.com', 'Tester', 'EUR', ?, ?)`
  ).run(USER_ID, TS, TS)
  db.prepare(
    `INSERT INTO accounts
       (id, user_id, name, kind, institution, starting_balance_cents, created_at, updated_at)
     VALUES (?, ?, 'Everyday Checking', 'checking', 'Chase', 250000, ?, ?)`
  ).run(ACCOUNT_ID, USER_ID, TS, TS)
  db.prepare(
    `INSERT INTO settings (user_id, key, value, updated_at) VALUES (?, 'currency', 'EUR', ?)`
  ).run(USER_ID, TS)
  db.prepare(
    `INSERT INTO transactions
       (id, user_id, account_id, kind, amount_cents, occurred_on, memo, category, created_at, updated_at)
     VALUES ('txn-v1', ?, ?, 'expense', -1234, '2026-01-05', 'Coffee', 'Food', ?, ?)`
  ).run(USER_ID, ACCOUNT_ID, TS, TS)
  return db
}

test('a v1 database migrates to the current schema with its money and settings intact', () => {
  const db = v1Database()
  migrate(db)

  assert.equal(db.pragma('user_version', { simple: true }), SCHEMA_VERSION)
  assert.deepEqual(db.pragma('foreign_key_check'), [])
  assert.equal(db.pragma('integrity_check', { simple: true }), 'ok')

  const user = db.prepare('SELECT display_name, currency FROM users WHERE id = ?').get(USER_ID) as {
    display_name: string
    currency: string
  }
  assert.deepEqual(user, { display_name: 'Tester', currency: 'EUR' }, 'the currency is not rewritten')

  const account = db
    .prepare('SELECT starting_balance_cents FROM accounts WHERE id = ?')
    .get(ACCOUNT_ID) as { starting_balance_cents: number }
  assert.equal(account.starting_balance_cents, 250_000)

  const transaction = db
    .prepare(
      `SELECT amount_cents, occurred_on, category, category_id
       FROM transactions WHERE id = 'txn-v1'`
    )
    .get() as { amount_cents: number; occurred_on: string; category: string; category_id: string }
  assert.deepEqual(
    [transaction.amount_cents, transaction.occurred_on, transaction.category],
    [-1234, '2026-01-05', 'Food']
  )
  const category = db
    .prepare('SELECT name FROM categories WHERE id = ?')
    .get(transaction.category_id) as { name: string } | undefined
  assert.equal(category?.name, 'Food', 'the v8 backfill links the text to a category row')

  assert.equal(
    (db.prepare("SELECT value FROM settings WHERE key = 'currency'").get() as { value: string })
      .value,
    'EUR'
  )

  const tables = (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
  ).map((row) => row.name)
  for (const table of ['bill_reserves', 'categories', 'balance_snapshots', 'accounts']) {
    assert.ok(tables.includes(table), `${table} exists after the upgrade`)
  }
  db.close()
})

test('an allocation written on v2 survives every later rebuild, debt bucket included', () => {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  migrateThrough(db, 2)
  db.prepare(
    `INSERT INTO users (id, display_name, created_at, updated_at)
     VALUES (?, 'Tester', ?, ?)`
  ).run(USER_ID, TS, TS)
  db.prepare(
    `INSERT INTO paychecks (id, user_id, amount_cents, received_on, health, created_at, updated_at)
     VALUES ('pay-1', ?, 240000, '2026-02-01', 'covered', ?, ?)`
  ).run(USER_ID, TS, TS)
  db.prepare(
    `INSERT INTO allocations
       (id, user_id, paycheck_id, bucket, label, amount_cents, created_at, updated_at)
     VALUES ('alloc-1', ?, 'pay-1', 'debt', 'Debt payoff', 30000, ?, ?)`
  ).run(USER_ID, TS, TS)

  migrate(db)

  assert.equal(db.pragma('user_version', { simple: true }), SCHEMA_VERSION)
  assert.deepEqual(db.pragma('foreign_key_check'), [])
  assert.deepEqual(
    db.prepare("SELECT bucket, amount_cents FROM allocations WHERE id = 'alloc-1'").get(),
    { bucket: 'debt', amount_cents: 30_000 }
  )
  db.close()
})

test('a database from a newer build is refused, not silently opened', () => {
  const db = new Database(':memory:')
  migrateThrough(db, SCHEMA_VERSION)
  db.pragma('user_version = 99')

  assert.throws(
    () => migrate(db),
    (error: unknown) =>
      error instanceof SchemaTooNewError &&
      error.code === 'SCHEMA_TOO_NEW' &&
      error.found === 99 &&
      error.supported === SCHEMA_VERSION
  )
  assert.equal(db.pragma('user_version', { simple: true }), 99, 'the file is left alone')
  db.close()
})

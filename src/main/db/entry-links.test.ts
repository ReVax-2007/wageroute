import assert from 'node:assert/strict'
import Database from 'better-sqlite3-multiple-ciphers'
import test from 'node:test'
import { migrate } from './migrations'
import {
  createAccount,
  createBill,
  createGoal,
  createTransaction,
  listTransactions,
  queryTransactions,
  updateTransaction
} from './repositories'

const USER_ID = '11111111-2222-3333-4444-555555555555'
const OTHER_USER = '99999999-8888-7777-6666-555555555555'

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
    institution: '',
    startingBalanceCents: 0,
    creditLimitCents: null
  })
}

function bill(db: Database.Database, name = 'Water'): string {
  return createBill(db, USER_ID, {
    name,
    amountCents: 5_000,
    frequency: 'monthly',
    dueDay: 15,
    category: 'Utilities',
    accountId: null,
    autopay: false,
    isActive: true,
    nextDueOn: null
  })
}

function goal(db: Database.Database): string {
  return createGoal(db, USER_ID, {
    name: 'Vacation',
    targetCents: 100_000,
    targetDate: null,
    priority: 100,
    color: '#34D399',
    accountId: null
  })
}

function rejects(run: () => unknown, message: string | RegExp): void {
  assert.throws(run, (error: Error) => {
    assert.equal(error.name, 'RepositoryError')
    if (typeof message === 'string') assert.equal(error.message, message)
    else assert.match(error.message, message)
    return true
  })
}

test('a manual bill payment stores the link and the ledger shows the bill name', () => {
  const db = freshDb()
  const chequing = account(db)
  const water = bill(db)

  createTransaction(db, USER_ID, {
    accountId: chequing,
    kind: 'bill_payment',
    amountCents: -5_000,
    occurredOn: '2026-03-16',
    memo: 'Water',
    category: 'Utilities',
    billId: water
  })

  const [row] = listTransactions(db, USER_ID)
  assert.equal(row.billId, water)
  assert.equal(row.billName, 'Water', 'the read model joins the name for the grid')
  assert.equal(row.goalName, null)

  // The grid reads the capped page, not the list; both have to carry the name.
  const [paged] = queryTransactions(db, USER_ID, {
    filter: {},
    sort: 'date_desc',
    limit: 10,
    offset: 0
  }).rows
  assert.equal(paged.billId, water)
  assert.equal(paged.billName, 'Water', 'the paged ledger keeps the joined name')
  db.close()
})

test('a goal funding stores its goal and no bill', () => {
  const db = freshDb()
  const chequing = account(db)
  const vacation = goal(db)

  createTransaction(db, USER_ID, {
    accountId: chequing,
    kind: 'goal_funding',
    amountCents: -2_000,
    occurredOn: '2026-03-16',
    memo: 'Vacation',
    category: 'Savings',
    goalId: vacation
  })

  const [row] = listTransactions(db, USER_ID)
  assert.equal(row.goalId, vacation)
  assert.equal(row.goalName, 'Vacation')
  assert.equal(row.billName, null)
  db.close()
})

test('retyping an entry drops a link its new kind cannot carry', () => {
  const db = freshDb()
  const chequing = account(db)
  const water = bill(db)
  const vacation = goal(db)

  const payment = createTransaction(db, USER_ID, {
    accountId: chequing,
    kind: 'bill_payment',
    amountCents: -5_000,
    occurredOn: '2026-03-16',
    memo: 'Water',
    category: 'Utilities',
    billId: water
  })
  const funding = createTransaction(db, USER_ID, {
    accountId: chequing,
    kind: 'goal_funding',
    amountCents: -2_000,
    occurredOn: '2026-03-16',
    memo: 'Vacation',
    category: 'Savings',
    goalId: vacation
  })

  updateTransaction(db, USER_ID, payment, { kind: 'income' })
  updateTransaction(db, USER_ID, funding, { kind: 'expense' })

  const rows = new Map(listTransactions(db, USER_ID).map((row) => [row.id, row]))
  assert.equal(rows.get(payment)?.kind, 'income')
  assert.equal(rows.get(payment)?.billId, null, 'income cannot name a bill')
  assert.equal(rows.get(payment)?.billName, null)
  assert.equal(rows.get(payment)?.amountCents, 5_000, 'income flips the stored sign')
  assert.equal(rows.get(funding)?.goalId, null, 'an expense cannot name a goal')
  assert.equal(rows.get(funding)?.goalName, null)
  db.close()
})

test('retyping a bill payment to an expense keeps the link it may still carry', () => {
  const db = freshDb()
  const chequing = account(db)
  const water = bill(db)
  const payment = createTransaction(db, USER_ID, {
    accountId: chequing,
    kind: 'bill_payment',
    amountCents: -5_000,
    occurredOn: '2026-03-16',
    memo: 'Water',
    category: 'Utilities',
    billId: water
  })

  updateTransaction(db, USER_ID, payment, { kind: 'expense' })

  const [row] = listTransactions(db, USER_ID)
  assert.equal(row.kind, 'expense')
  assert.equal(row.billId, water)
  assert.equal(row.billName, 'Water')
  db.close()
})

test('a link is refused when the record is unknown, foreign or built for another kind', () => {
  const db = freshDb()
  const chequing = account(db)
  const water = bill(db)
  const vacation = goal(db)

  db.prepare(
    `INSERT INTO users (id, display_name, created_at, updated_at)
     VALUES (?, 'Other', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
  ).run(OTHER_USER)
  const foreignBill = createBill(db, OTHER_USER, {
    name: 'Rent',
    amountCents: 100_000,
    frequency: 'monthly',
    dueDay: 1,
    category: 'Housing',
    accountId: null,
    autopay: false,
    isActive: true,
    nextDueOn: null
  })

  const base = {
    accountId: chequing,
    occurredOn: '2026-03-16',
    memo: 'test',
    category: 'Misc'
  }

  rejects(
    () =>
      createTransaction(db, USER_ID, {
        ...base,
        kind: 'bill_payment',
        amountCents: -5_000,
        billId: '00000000-0000-4000-8000-000000000000'
      }),
    'That bill no longer exists'
  )
  rejects(
    () =>
      createTransaction(db, USER_ID, {
        ...base,
        kind: 'bill_payment',
        amountCents: -5_000,
        billId: foreignBill
      }),
    'That bill no longer exists'
  )
  rejects(
    () =>
      createTransaction(db, USER_ID, {
        ...base,
        kind: 'income',
        amountCents: 5_000,
        billId: water
      }),
    'This entry kind cannot name a bill'
  )
  rejects(
    () =>
      createTransaction(db, USER_ID, {
        ...base,
        kind: 'expense',
        amountCents: -5_000,
        goalId: vacation
      }),
    'Only a goal funding can name a goal'
  )
  rejects(
    () =>
      createTransaction(db, USER_ID, {
        ...base,
        kind: 'bill_payment',
        amountCents: -5_000,
        billId: water,
        goalId: vacation
      }),
    'An entry can name a bill or a goal, not both'
  )
  rejects(
    () =>
      createTransaction(db, USER_ID, {
        ...base,
        kind: 'transfer',
        amountCents: -5_000,
        counterAccountId: chequing,
        billId: water
      }),
    'This entry kind cannot name a bill'
  )
  assert.equal(listTransactions(db, USER_ID).length, 0, 'nothing was written')
  db.close()
})

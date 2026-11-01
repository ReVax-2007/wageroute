import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import test from 'node:test'
import { migrate } from './migrations'
import {
  commitPaycheck,
  createAccount,
  createBill,
  createTransaction,
  deleteBill,
  deleteTransaction,
  listBillReserves,
  reservedBillIdsFor,
  updateTransaction
} from './repositories'

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

function checking(db: Database.Database): string {
  return createAccount(db, USER_ID, {
    name: 'Chequing',
    kind: 'checking',
    institution: '',
    startingBalanceCents: 0
  })
}

function rent(db: Database.Database, accountId: string): string {
  return createBill(db, USER_ID, {
    name: 'Rent',
    amountCents: 120_000,
    frequency: 'monthly',
    dueDay: 15,
    category: 'Housing',
    accountId,
    autopay: false,
    isActive: true,
    nextDueOn: null,
    fundingStrategy: 'first_check',
    fundingPaycheckIndex: 1
  })
}

function route(
  db: Database.Database,
  accountId: string,
  receivedOn: string,
  incomeCents = 500_000,
  allowDuplicate = false
) {
  return commitPaycheck(db, USER_ID, {
    incomeCents,
    receivedOn,
    source: 'Paycheck',
    depositAccountId: accountId,
    payCadence: 'semimonthly',
    splits: { savingsPercent: 0, investmentPercent: 0, goalsPercent: 0, debtPercent: 0 },
    wholeDollarBuckets: false,
    allowDuplicate
  })
}

test('a route records the wall reservation for the month it funds', () => {
  const db = freshDb()
  const accountId = checking(db)
  rent(db, accountId)

  route(db, accountId, '2026-03-05')

  const [reserve] = listBillReserves(db, USER_ID)
  assert.equal(reserve.cycle, '2026-03')
  assert.equal(reserve.amountCents, 120_000)
  assert.equal(reserve.state, 'reserved')
  assert.deepEqual(reservedBillIdsFor(db, USER_ID, '2026-03'), [reserve.billId])
  assert.deepEqual(reservedBillIdsFor(db, USER_ID, '2026-04'), [])
})

test('a bill payment turns its reservation paid, and deleting it re-opens the month', () => {
  const db = freshDb()
  const accountId = checking(db)
  const billId = rent(db, accountId)
  route(db, accountId, '2026-03-05')

  const paymentId = createTransaction(db, USER_ID, {
    accountId,
    kind: 'bill_payment',
    amountCents: -120_000,
    occurredOn: '2026-03-14',
    memo: 'Rent',
    category: 'Housing',
    billId
  })
  assert.equal(listBillReserves(db, USER_ID)[0].state, 'paid')

  deleteTransaction(db, USER_ID, paymentId)
  assert.equal(listBillReserves(db, USER_ID)[0].state, 'reserved', 'the bill is owed again')
})

test('moving a payment to another month re-opens the month it left', () => {
  const db = freshDb()
  const accountId = checking(db)
  const billId = rent(db, accountId)
  route(db, accountId, '2026-03-05')
  const paymentId = createTransaction(db, USER_ID, {
    accountId,
    kind: 'bill_payment',
    amountCents: -120_000,
    occurredOn: '2026-03-14',
    memo: 'Rent',
    category: 'Housing',
    billId
  })

  updateTransaction(db, USER_ID, paymentId, { occurredOn: '2026-04-02' })
  assert.equal(listBillReserves(db, USER_ID)[0].state, 'reserved', 'March is not paid by April')

  updateTransaction(db, USER_ID, paymentId, { occurredOn: '2026-03-30' })
  assert.equal(listBillReserves(db, USER_ID)[0].state, 'paid')
})

test('a second cheque in the same month does not reserve a single-check bill twice', () => {
  const db = freshDb()
  const accountId = checking(db)
  const billId = rent(db, accountId)
  route(db, accountId, '2026-03-05')

  const second = route(db, accountId, '2026-03-20')
  assert.ok(second.plan)
  const line = second.plan.priorityReserves.find((reserve) => reserve.billId === billId)
  assert.equal(line?.reserveCents, 0, 'the bill already has a claim this month')
  assert.equal(listBillReserves(db, USER_ID).length, 1)
})

test('a shortfalling cheque records no reservation at all', () => {
  const db = freshDb()
  const accountId = checking(db)
  rent(db, accountId)

  const routed = route(db, accountId, '2026-03-05', 50_000)
  assert.ok(routed.plan)
  assert.ok(routed.plan.shortfallCents > 0)
  assert.deepEqual(listBillReserves(db, USER_ID), [])
})

test('the same deposit twice is refused until the user confirms it', () => {
  const db = freshDb()
  const accountId = checking(db)
  rent(db, accountId)
  route(db, accountId, '2026-03-05')

  assert.throws(() => route(db, accountId, '2026-03-05'), /already recorded on this date/)
  route(db, accountId, '2026-03-05', 500_000, true)
  assert.equal(
    listBillReserves(db, USER_ID).length,
    1,
    'the confirmed duplicate adds income but not a second claim'
  )
})

test('deleting a bill releases the reservations it was carrying', () => {
  const db = freshDb()
  const accountId = checking(db)
  const billId = rent(db, accountId)
  route(db, accountId, '2026-03-05')

  deleteBill(db, USER_ID, billId)
  assert.deepEqual(listBillReserves(db, USER_ID), [])
  assert.deepEqual(reservedBillIdsFor(db, USER_ID, '2026-03'), [])
})

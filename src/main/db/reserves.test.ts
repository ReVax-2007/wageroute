import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import test from 'node:test'
import type { BillFundingStrategy, PayCadence } from '@shared/types'
import { migrate } from './migrations'
import {
  commitPaycheck,
  createAccount,
  createBill,
  createTransaction,
  claimsThisMonthFor,
  deleteBill,
  deleteTransaction,
  listBillReserves,
  updateBill,
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

function rent(
  db: Database.Database,
  accountId: string,
  dueDay = 15,
  fundingStrategy: BillFundingStrategy = 'first_check'
): string {
  return createBill(db, USER_ID, {
    name: 'Rent',
    amountCents: 120_000,
    frequency: 'monthly',
    dueDay,
    category: 'Housing',
    accountId,
    autopay: false,
    isActive: true,
    nextDueOn: null,
    fundingStrategy,
    fundingPaycheckIndex: 1
  })
}

function route(
  db: Database.Database,
  accountId: string,
  receivedOn: string,
  incomeCents = 500_000,
  allowDuplicate = false,
  payCadence: PayCadence = 'semimonthly'
) {
  return commitPaycheck(db, USER_ID, {
    incomeCents,
    receivedOn,
    source: 'Paycheck',
    depositAccountId: accountId,
    payCadence,
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
  assert.equal(reserve.strategy, 'first_check', 'the claim records how it was written')
  assert.equal(reserve.settledBy, null)
  assert.deepEqual(claimsThisMonthFor(db, USER_ID, '2026-03'), [
    { billId: reserve.billId, amountCents: 120_000, strategy: 'first_check' }
  ])
  assert.deepEqual(claimsThisMonthFor(db, USER_ID, '2026-04'), [])
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

test('a later cheque does not close a month whose payment moved away', () => {
  const db = freshDb()
  const accountId = checking(db)
  const billId = rent(db, accountId, 15, 'first_check')
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
  const april = route(db, accountId, '2026-04-05')
  assert.ok(april.plan)

  const rows = listBillReserves(db, USER_ID)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].cycle, '2026-03')
  assert.equal(
    rows[0].state,
    'reserved',
    'the March claim was never spent, so April must not settle it'
  )
})

test('a payment next month settles the earlier cheque’s claim instead of stranding it', () => {
  const db = freshDb()
  const accountId = checking(db)
  const billId = rent(db, accountId, 1, 'last_check')
  route(db, accountId, '2026-01-31')

  const [january] = listBillReserves(db, USER_ID)
  assert.equal(january.cycle, '2026-01', 'the January cheque carries a bill due 1 February')

  createTransaction(db, USER_ID, {
    accountId,
    kind: 'bill_payment',
    amountCents: -120_000,
    occurredOn: '2026-02-01',
    memo: 'Rent',
    category: 'Housing',
    billId
  })

  const february = route(db, accountId, '2026-02-05')
  assert.ok(february.plan)
  assert.equal(
    february.plan.priorityReserves.find((line) => line.billId === billId)?.reserveCents,
    0,
    'February does not reserve a bill it already paid'
  )
  const rows = listBillReserves(db, USER_ID)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].state, 'paid', 'the January carry is closed, not left reserved for ever')
})

test('a cheque after the due day carries into the next month whatever the strategy', () => {
  const db = freshDb()
  const accountId = checking(db)
  const billId = rent(db, accountId, 1, 'first_check')
  route(db, accountId, '2026-01-31', 500_000, false, 'monthly')

  const [january] = listBillReserves(db, USER_ID)
  assert.equal(january.cycle, '2026-01')
  assert.equal(january.strategy, 'first_check')

  const paymentId = createTransaction(db, USER_ID, {
    accountId,
    kind: 'bill_payment',
    amountCents: -120_000,
    occurredOn: '2026-02-01',
    memo: 'Rent',
    category: 'Housing',
    billId
  })

  const rows = listBillReserves(db, USER_ID)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].state, 'paid', 'the 31 January cheque funded 1 February')
  assert.equal(rows[0].settledBy, paymentId, 'the carry names the payment that closed it')
})

test('a payment dated before this month’s cheque settles the carry, not the new claim', () => {
  const db = freshDb()
  const accountId = checking(db)
  const billId = rent(db, accountId, 1, 'first_check')
  route(db, accountId, '2026-01-31', 500_000, false, 'monthly')
  route(db, accountId, '2026-02-05', 500_000, false, 'monthly')

  createTransaction(db, USER_ID, {
    accountId,
    kind: 'bill_payment',
    amountCents: -120_000,
    occurredOn: '2026-02-01',
    memo: 'Rent',
    category: 'Housing',
    billId
  })

  const byCycle = new Map(listBillReserves(db, USER_ID).map((row) => [row.cycle, row]))
  assert.equal(byCycle.get('2026-01')?.state, 'paid', 'the carry is what the payment spent')
  assert.equal(
    byCycle.get('2026-02')?.state,
    'reserved',
    'the February cheque landed after the payment, so it still funds February'
  )
})

test('deleting the payment re-opens the carry it closed', () => {
  const db = freshDb()
  const accountId = checking(db)
  const billId = rent(db, accountId, 1, 'first_check')
  route(db, accountId, '2026-01-31', 500_000, false, 'monthly')
  route(db, accountId, '2026-02-05', 500_000, false, 'monthly')

  const paymentId = createTransaction(db, USER_ID, {
    accountId,
    kind: 'bill_payment',
    amountCents: -120_000,
    occurredOn: '2026-02-01',
    memo: 'Rent',
    category: 'Housing',
    billId
  })

  deleteTransaction(db, USER_ID, paymentId)
  const byCycle = new Map(listBillReserves(db, USER_ID).map((row) => [row.cycle, row]))
  assert.equal(byCycle.get('2026-01')?.state, 'reserved', 'January is owed again')
  assert.equal(byCycle.get('2026-01')?.settledBy, null)
  assert.equal(byCycle.get('2026-02')?.state, 'reserved')
})

test('switching a carried bill to every-check does not reserve it twice', () => {
  const db = freshDb()
  const accountId = checking(db)
  const billId = rent(db, accountId, 15, 'first_check')
  route(db, accountId, '2026-03-05')
  updateBill(db, USER_ID, billId, { fundingStrategy: 'all_checks' })

  const second = route(db, accountId, '2026-03-20')
  assert.ok(second.plan)
  const line = second.plan.priorityReserves.find((reserve) => reserve.billId === billId)
  assert.equal(line?.reserveCents, 0, 'the first-check claim already covers the month')
  assert.deepEqual(claimsThisMonthFor(db, USER_ID, '2026-03'), [
    { billId, amountCents: 120_000, strategy: 'first_check' }
  ])
})

test('switching a spread bill to one check reserves the month’s remainder', () => {
  const db = freshDb()
  const accountId = checking(db)
  const billId = rent(db, accountId, 15, 'all_checks')
  const first = route(db, accountId, '2026-03-05')
  assert.ok(first.plan)
  assert.equal(
    first.plan.priorityReserves.find((reserve) => reserve.billId === billId)?.reserveCents,
    60_000,
    'the spread takes its first instalment'
  )

  updateBill(db, USER_ID, billId, { fundingStrategy: 'last_check' })
  const second = route(db, accountId, '2026-03-20')
  assert.ok(second.plan)
  assert.equal(
    second.plan.priorityReserves.find((reserve) => reserve.billId === billId)?.reserveCents,
    60_000,
    'the last cheque covers only what the spread has not'
  )

  const claims = claimsThisMonthFor(db, USER_ID, '2026-03')
  assert.equal(claims.length, 2)
  assert.equal(claims.reduce((total, claim) => total + claim.amountCents, 0), 120_000)
  assert.equal(claims.find((claim) => claim.strategy === 'last_check')?.amountCents, 60_000)
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
  assert.deepEqual(claimsThisMonthFor(db, USER_ID, '2026-03'), [])
})

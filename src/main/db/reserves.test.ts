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

function creditCard(db: Database.Database): string {
  return createAccount(db, USER_ID, {
    name: 'Card',
    kind: 'credit',
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
  assert.equal(reserve.dueDay, 15, 'the claim records the due day it was written against')
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

test('one payment cannot close two months of carry', () => {
  const db = freshDb()
  const accountId = checking(db)
  const billId = rent(db, accountId, 1, 'first_check')
  route(db, accountId, '2025-12-31', 500_000, false, 'monthly')
  route(db, accountId, '2026-01-31', 500_000, false, 'monthly')

  const paymentId = createTransaction(db, USER_ID, {
    accountId,
    kind: 'bill_payment',
    amountCents: -120_000,
    occurredOn: '2026-02-01',
    memo: 'Rent',
    category: 'Housing',
    billId
  })
  // The February cheque's backstop sees the same February payment, but that
  // money already closed December's claim.
  route(db, accountId, '2026-02-05', 500_000, false, 'monthly')

  const rows = listBillReserves(db, USER_ID)
  const paid = rows.filter((row) => row.state === 'paid')
  assert.equal(paid.length, 1, 'one payment settles one claim')
  assert.equal(paid[0].cycle, '2025-12')
  assert.equal(paid[0].settledBy, paymentId)
  assert.equal(
    rows.find((row) => row.cycle === '2026-01')?.state,
    'reserved',
    'January’s claim was not paid by the money that settled December'
  )
})

test('deleting a payment leaves the claim a different payment closed paid', () => {
  const db = freshDb()
  const accountId = checking(db)
  const billId = rent(db, accountId, 1, 'first_check')
  route(db, accountId, '2026-01-31', 500_000, false, 'monthly')
  route(db, accountId, '2026-02-05', 500_000, false, 'monthly')

  const januaryPayment = createTransaction(db, USER_ID, {
    accountId,
    kind: 'bill_payment',
    amountCents: -120_000,
    occurredOn: '2026-02-01',
    memo: 'Rent January',
    category: 'Housing',
    billId
  })
  const februaryPayment = createTransaction(db, USER_ID, {
    accountId,
    kind: 'bill_payment',
    amountCents: -120_000,
    occurredOn: '2026-02-10',
    memo: 'Rent February',
    category: 'Housing',
    billId
  })

  deleteTransaction(db, USER_ID, januaryPayment)
  const byCycle = new Map(listBillReserves(db, USER_ID).map((row) => [row.cycle, row]))
  assert.equal(byCycle.get('2026-01')?.state, 'reserved', 'January is owed again')
  assert.equal(byCycle.get('2026-02')?.state, 'paid')
  assert.equal(
    byCycle.get('2026-02')?.settledBy,
    februaryPayment,
    'the February claim still names the payment that closed it'
  )
})

test('switching back to every-check after a whole-month claim reserves nothing more', () => {
  const db = freshDb()
  const accountId = checking(db)
  const billId = rent(db, accountId, 15, 'all_checks')
  route(db, accountId, '2026-03-05')
  updateBill(db, USER_ID, billId, { fundingStrategy: 'last_check' })
  route(db, accountId, '2026-03-20')
  updateBill(db, USER_ID, billId, { fundingStrategy: 'all_checks' })

  const third = route(db, accountId, '2026-03-25')
  assert.ok(third.plan)
  assert.equal(
    third.plan.priorityReserves.find((reserve) => reserve.billId === billId)?.reserveCents,
    0,
    'the two earlier claims already cover the month'
  )
  assert.equal(
    claimsThisMonthFor(db, USER_ID, '2026-03').reduce(
      (total, claim) => total + claim.amountCents,
      0
    ),
    120_000,
    'the month never claims more than the bill'
  )
})

test('changing the due day does not rewrite how an old claim carries', () => {
  const db = freshDb()
  const accountId = checking(db)
  const billId = rent(db, accountId, 1, 'first_check')
  route(db, accountId, '2026-01-31', 500_000, false, 'monthly')
  updateBill(db, USER_ID, billId, { dueDay: 31 })

  createTransaction(db, USER_ID, {
    accountId,
    kind: 'bill_payment',
    amountCents: -120_000,
    occurredOn: '2026-02-01',
    memo: 'Rent',
    category: 'Housing',
    billId
  })

  const [january] = listBillReserves(db, USER_ID)
  assert.equal(january.dueDay, 1, 'the claim kept the day it was written against')
  assert.equal(
    january.state,
    'paid',
    'the 31 January cheque still funds the 1 February due date'
  )
})

test('one payment closes only the claims its amount covers', () => {
  const db = freshDb()
  const accountId = checking(db)
  const billId = rent(db, accountId, 15, 'all_checks')
  route(db, accountId, '2026-03-05')
  updateBill(db, USER_ID, billId, { fundingStrategy: 'last_check' })
  route(db, accountId, '2026-03-20')
  assert.equal(claimsThisMonthFor(db, USER_ID, '2026-03').length, 2)

  createTransaction(db, USER_ID, {
    accountId,
    kind: 'bill_payment',
    amountCents: -60_000,
    occurredOn: '2026-03-25',
    memo: 'Rent part',
    category: 'Housing',
    billId
  })
  const afterFirst = listBillReserves(db, USER_ID)
  assert.equal(
    afterFirst.filter((row) => row.state === 'paid').length,
    1,
    '60,000 closes one 60,000 instalment, not both'
  )
  assert.equal(afterFirst.filter((row) => row.state === 'reserved').length, 1)

  createTransaction(db, USER_ID, {
    accountId,
    kind: 'bill_payment',
    amountCents: -60_000,
    occurredOn: '2026-03-26',
    memo: 'Rent rest',
    category: 'Housing',
    billId
  })
  assert.equal(
    listBillReserves(db, USER_ID).filter((row) => row.state === 'paid').length,
    2,
    'the second payment closes the other instalment'
  )
})

test('a payment smaller than the claim leaves it reserved', () => {
  const db = freshDb()
  const accountId = checking(db)
  const billId = rent(db, accountId, 15, 'first_check')
  route(db, accountId, '2026-03-05')

  createTransaction(db, USER_ID, {
    accountId,
    kind: 'bill_payment',
    amountCents: -60_000,
    occurredOn: '2026-03-10',
    memo: 'Rent part',
    category: 'Housing',
    billId
  })

  const [claim] = listBillReserves(db, USER_ID)
  assert.equal(claim.state, 'reserved', 'half of the claim was not half of the money')
  assert.equal(claim.settledBy, null)
})

test('a claim closed by a card charge does not block the cash reserve', () => {
  const db = freshDb()
  const accountId = checking(db)
  const cardId = creditCard(db)
  const billId = rent(db, accountId, 15, 'first_check')
  route(db, accountId, '2026-03-05')

  createTransaction(db, USER_ID, {
    accountId: cardId,
    kind: 'bill_payment',
    amountCents: -120_000,
    occurredOn: '2026-03-10',
    memo: 'Rent on card',
    category: 'Housing',
    billId
  })
  updateBill(db, USER_ID, billId, { fundingStrategy: 'all_checks' })

  const second = route(db, accountId, '2026-03-20')
  assert.ok(second.plan)
  assert.equal(
    second.plan.priorityReserves.find((reserve) => reserve.billId === billId)?.reserveCents,
    60_000,
    'the card did not shrink the cash pool'
  )
  assert.deepEqual(claimsThisMonthFor(db, USER_ID, '2026-03'), [
    { billId, amountCents: 60_000, strategy: 'all_checks' }
  ])
})

test('deleting a pre-v9 payment re-opens the claim it carried', () => {
  const db = freshDb()
  const accountId = checking(db)
  const billId = rent(db, accountId, 1, 'first_check')
  route(db, accountId, '2025-12-31', 500_000, false, 'monthly')

  const paymentId = createTransaction(db, USER_ID, {
    accountId,
    kind: 'bill_payment',
    amountCents: -120_000,
    occurredOn: '2026-01-02',
    memo: 'Rent',
    category: 'Housing',
    billId
  })
  // A row written by the pre-v9 build has no settled_by link.
  db.prepare('UPDATE bill_reserves SET settled_by = NULL WHERE bill_id = ?').run(billId)

  deleteTransaction(db, USER_ID, paymentId)

  const [december] = listBillReserves(db, USER_ID)
  assert.equal(december.cycle, '2025-12')
  assert.equal(december.state, 'reserved', 'the money returns to the wall')
  assert.equal(december.settledBy, null)
})

import assert from 'node:assert/strict'
import Database from 'better-sqlite3-multiple-ciphers'
import test from 'node:test'
import { isOneTimeBillDone } from '@shared/oneTimeBills'
import { backupToJson, buildBackup, mergeBackup, parseBackupJson } from './backup'
import { migrate } from './migrations'
import {
  commitPaycheck,
  createAccount,
  createBill,
  createTransaction,
  deleteTransactions,
  listBillPaymentsThisMonth,
  listBillReserves,
  listBills,
  listTransactions,
  postDueAutopay,
  updateBill
} from './repositories'

/** ADR 0037: a one-time bill is saved up for across paychecks, paid once and then done. */

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

function account(db: Database.Database): string {
  return createAccount(db, USER_ID, {
    name: 'Chequing',
    kind: 'checking',
    institution: '',
    startingBalanceCents: 500_000
  })
}

function tires(db: Database.Database, accountId: string, options: { autopay?: boolean } = {}): string {
  return createBill(db, USER_ID, {
    name: 'New tires',
    amountCents: 90_000,
    frequency: 'once',
    dueDay: 1,
    category: 'Car',
    accountId,
    autopay: options.autopay ?? false,
    isActive: true,
    nextDueOn: '2026-09-30',
    fundingStrategy: 'all_checks'
  })
}

function route(db: Database.Database, accountId: string, receivedOn: string): void {
  commitPaycheck(db, USER_ID, {
    incomeCents: 200_000,
    receivedOn,
    source: 'Paycheck',
    depositAccountId: accountId,
    payCadence: 'semimonthly',
    splits: { savingsPercent: 0, investmentPercent: 0, goalsPercent: 0, debtPercent: 0 },
    wholeDollarBuckets: false,
    allowDuplicate: false
  })
}

function pay(db: Database.Database, accountId: string, billId: string, cents: number, on: string): string {
  return createTransaction(db, USER_ID, {
    accountId,
    kind: 'bill_payment',
    amountCents: -cents,
    occurredOn: on,
    memo: 'New tires',
    category: 'Car',
    billId
  })
}

function paidCents(db: Database.Database, billId: string, month = '2026-11'): number {
  return (
    listBillPaymentsThisMonth(db, USER_ID, month, '2026-12-31').find((row) => row.billId === billId)
      ?.paidCents ?? 0
  )
}

test('a one-time bill is stored with its date, and its due day follows the date', () => {
  const db = freshDb()
  const billId = tires(db, account(db))
  const [bill] = listBills(db, USER_ID)
  assert.equal(bill.id, billId)
  assert.equal(bill.frequency, 'once')
  assert.equal(bill.nextDueOn, '2026-09-30')
  assert.equal(bill.dueDay, 30)

  updateBill(db, USER_ID, billId, { nextDueOn: '2026-10-12' })
  assert.equal(listBills(db, USER_ID)[0].dueDay, 12, 'moving the date moves the day')
  assert.throws(
    () => updateBill(db, USER_ID, billId, { nextDueOn: null }),
    /needs the date/,
    'a one-time bill cannot lose its date'
  )
  assert.throws(
    () =>
      createBill(db, USER_ID, {
        name: 'Course',
        amountCents: 10_000,
        frequency: 'once',
        dueDay: 1,
        category: 'Bills',
        accountId: null,
        autopay: false,
        isActive: true,
        nextDueOn: null
      }),
    /needs the date/
  )
})

test('the paychecks before the date each set aside a share, across months', () => {
  const db = freshDb()
  const accountId = account(db)
  const billId = tires(db, accountId)
  for (const date of ['2026-08-01', '2026-08-16', '2026-09-01', '2026-09-16']) route(db, accountId, date)

  const claims = listBillReserves(db, USER_ID)
    .filter((claim) => claim.billId === billId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.cycle.localeCompare(b.cycle))
  assert.deepEqual(
    claims.map((claim) => [claim.cycle, claim.amountCents, claim.state]).sort(),
    [
      ['2026-08', 22_500, 'reserved'],
      ['2026-08', 22_500, 'reserved'],
      ['2026-09', 22_500, 'reserved'],
      ['2026-09', 22_500, 'reserved']
    ],
    'four even shares, not $900 from one cheque'
  )

  // The bill is fully saved up: a later cheque asks nothing more for it.
  route(db, accountId, '2026-10-01')
  assert.equal(
    listBillReserves(db, USER_ID).filter((claim) => claim.billId === billId).length,
    4
  )
})

test('a cheque after the date carries everything still open: the bill is overdue', () => {
  const db = freshDb()
  const accountId = account(db)
  const billId = tires(db, accountId)
  route(db, accountId, '2026-10-01')
  const [claim] = listBillReserves(db, USER_ID).filter((row) => row.billId === billId)
  assert.equal(claim.amountCents, 90_000)
})

test('the payment that covers it closes every claim and the bill is done for good', () => {
  const db = freshDb()
  const accountId = account(db)
  const billId = tires(db, accountId)
  for (const date of ['2026-08-01', '2026-08-16', '2026-09-01', '2026-09-16']) route(db, accountId, date)

  pay(db, accountId, billId, 50_000, '2026-09-20')
  const bill = listBills(db, USER_ID)[0]
  assert.equal(isOneTimeBillDone(bill, paidCents(db, billId)), false, 'a part payment leaves it open')

  const rest = pay(db, accountId, billId, 40_000, '2026-09-30')
  assert.equal(paidCents(db, billId), 90_000, 'every month of payments counts toward it')
  assert.equal(isOneTimeBillDone(bill, paidCents(db, billId)), true)
  assert.deepEqual(
    [...new Set(listBillReserves(db, USER_ID).map((claim) => claim.state))],
    ['paid'],
    'one bill, one life: payments settle claims from every month'
  )

  // Done means no cheque reserves for it again.
  route(db, accountId, '2026-10-01')
  assert.equal(listBillReserves(db, USER_ID).length, 4)

  // Deleting the payment reopens it: "done" is derived, never stored.
  deleteTransactions(db, USER_ID, [rest])
  assert.equal(isOneTimeBillDone(bill, paidCents(db, billId)), false)
})

test('autopay posts it once and never again', () => {
  const db = freshDb()
  const accountId = account(db)
  const billId = tires(db, accountId, { autopay: true })
  assert.deepEqual(postDueAutopay(db, USER_ID, '2026-09-29'), { posted: 0, skipped: 0 })
  assert.deepEqual(postDueAutopay(db, USER_ID, '2026-10-02'), { posted: 1, skipped: 0 })
  assert.deepEqual(postDueAutopay(db, USER_ID, '2026-10-30'), { posted: 0, skipped: 0 })
  assert.deepEqual(postDueAutopay(db, USER_ID, '2027-10-02'), { posted: 0, skipped: 0 })
  const payments = listTransactions(db, USER_ID).filter((row) => row.billId === billId)
  assert.deepEqual(
    payments.map((row) => [row.occurredOn, row.amountCents]),
    [['2026-09-30', -90_000]]
  )
})

test('a backup carries the one-time bill, its date and the payment that closed it', () => {
  const source = freshDb()
  const accountId = account(source)
  const billId = tires(source, accountId)
  pay(source, accountId, billId, 90_000, '2026-09-30')

  const payload = parseBackupJson(backupToJson(buildBackup(source, USER_ID)))
  const row = payload.tables.bills.find((bill) => bill.id === billId)
  assert.equal(row?.frequency, 'once')
  assert.equal(row?.next_due_on, '2026-09-30')

  const target = freshDb()
  mergeBackup(target, USER_ID, payload)
  const [bill] = listBills(target, USER_ID)
  assert.equal(bill.frequency, 'once')
  assert.equal(bill.nextDueOn, '2026-09-30')
  assert.equal(isOneTimeBillDone(bill, paidCents(target, billId)), true)
})

test('a one-time bill left to the owner takes nothing from any paycheck (ADR 0038)', () => {
  const db = freshDb()
  const accountId = account(db)
  const billId = createBill(db, USER_ID, {
    name: 'Family gifts',
    amountCents: 50_000,
    frequency: 'once',
    dueDay: 1,
    category: 'Gifts',
    accountId,
    autopay: false,
    isActive: true,
    nextDueOn: '2026-12-20',
    fromPaychecks: false
  })
  assert.equal(listBills(db, USER_ID).find((bill) => bill.id === billId)?.fromPaychecks, false)

  for (const date of ['2026-11-01', '2026-11-16', '2026-12-01']) route(db, accountId, date)
  assert.equal(
    listBillReserves(db, USER_ID).filter((claim) => claim.billId === billId).length,
    0,
    'no cheque sets money aside for it'
  )

  // The purchases are recorded as they happen and still close the bill.
  pay(db, accountId, billId, 12_000, '2026-11-20')
  pay(db, accountId, billId, 38_000, '2026-12-05')
  const bill = listBills(db, USER_ID).find((row) => row.id === billId)
  assert.ok(bill && isOneTimeBillDone(bill, paidCents(db, billId, '2026-12')))

  // Turning it back on lets later cheques save up as before.
  updateBill(db, USER_ID, billId, { fromPaychecks: true })
  assert.equal(listBills(db, USER_ID).find((row) => row.id === billId)?.fromPaychecks, true)
})

test('a backup carries a bill left to the owner, and an older file saves up', () => {
  const source = freshDb()
  const accountId = account(source)
  createBill(source, USER_ID, {
    name: 'Family gifts',
    amountCents: 50_000,
    frequency: 'once',
    dueDay: 1,
    category: 'Gifts',
    accountId,
    autopay: false,
    isActive: true,
    nextDueOn: '2026-12-20',
    fromPaychecks: false
  })
  const text = backupToJson(buildBackup(source, USER_ID))
  const target = freshDb()
  mergeBackup(target, USER_ID, parseBackupJson(text))
  assert.equal(listBills(target, USER_ID)[0].fromPaychecks, false)

  const older = JSON.parse(text)
  for (const row of older.tables.bills) delete row.from_paychecks
  const fresh = freshDb()
  mergeBackup(fresh, USER_ID, parseBackupJson(JSON.stringify(older)))
  assert.equal(listBills(fresh, USER_ID)[0].fromPaychecks, true, 'a file without the key saves up')
})

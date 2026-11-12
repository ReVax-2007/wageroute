import assert from 'node:assert/strict'
import Database from 'better-sqlite3-multiple-ciphers'
import test from 'node:test'
import { backupToJson, buildBackup, mergeBackup, parseBackupJson } from './backup'
import { migrate } from './migrations'
import {
  commitPaycheck,
  createAccount,
  createBill,
  createTransaction,
  listBillPaymentsThisMonth,
  listBillReserves,
  listBills,
  listTransactions,
  postDueAutopay,
  updateBill,
  updateTransaction
} from './repositories'

/** ADR 0036: a variable bill is stored, cleared by its real figure and carried in backups. */

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

function account(db: Database.Database, kind: 'checking' | 'credit' = 'checking'): string {
  return createAccount(db, USER_ID, {
    name: kind === 'credit' ? 'Card' : 'Chequing',
    kind,
    institution: '',
    startingBalanceCents: 0
  })
}

function gas(db: Database.Database, accountId: string, options: { autopay?: boolean } = {}): string {
  return createBill(db, USER_ID, {
    name: 'Gas',
    amountCents: 7_000,
    frequency: 'monthly',
    dueDay: 15,
    category: 'Transport',
    accountId,
    autopay: options.autopay ?? false,
    isActive: true,
    nextDueOn: null,
    fundingStrategy: 'first_check',
    fundingPaycheckIndex: 1,
    isVariable: true
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

function payGas(db: Database.Database, accountId: string, billId: string, cents: number): string {
  return createTransaction(db, USER_ID, {
    accountId,
    kind: 'bill_payment',
    amountCents: -cents,
    occurredOn: '2026-03-10',
    memo: 'Gas',
    category: 'Transport',
    billId
  })
}

test('a bill is saved variable, switched back and forth, and fixed by default', () => {
  const db = freshDb()
  const accountId = account(db)
  const billId = gas(db, accountId)
  assert.equal(listBills(db, USER_ID)[0].isVariable, true)
  updateBill(db, USER_ID, billId, { isVariable: false })
  assert.equal(listBills(db, USER_ID)[0].isVariable, false)
  updateBill(db, USER_ID, billId, { name: 'Fuel' })
  assert.equal(listBills(db, USER_ID)[0].isVariable, false, 'an unrelated edit leaves it alone')
  updateBill(db, USER_ID, billId, { isVariable: true })
  assert.equal(listBills(db, USER_ID)[0].isVariable, true)
})

test('a $51 payment settles the $70 claim and the month reads paid, with the real figure kept', () => {
  const db = freshDb()
  const accountId = account(db)
  const billId = gas(db, accountId)
  route(db, accountId, '2026-03-01')
  assert.equal(listBillReserves(db, USER_ID)[0].state, 'reserved')

  payGas(db, accountId, billId, 5_100)

  assert.equal(listBillReserves(db, USER_ID)[0].state, 'paid', 'the $19 is no longer held')
  assert.deepEqual(listBillPaymentsThisMonth(db, USER_ID, '2026-03', '2026-03-31'), [
    { billId, paidCents: 7_000, actualCents: 5_100, creditCents: 0 }
  ])
})

test('an overage is what it was, and a fixed bill still counts the plain sum', () => {
  const db = freshDb()
  const accountId = account(db)
  const billId = gas(db, accountId)
  payGas(db, accountId, billId, 8_500)
  assert.deepEqual(listBillPaymentsThisMonth(db, USER_ID, '2026-03', '2026-03-31'), [
    { billId, paidCents: 8_500, actualCents: 8_500, creditCents: 0 }
  ])

  updateBill(db, USER_ID, billId, { isVariable: false })
  const id = listTransactions(db, USER_ID)[0].id
  updateTransaction(db, USER_ID, id, { amountCents: -5_100 })
  assert.deepEqual(listBillPaymentsThisMonth(db, USER_ID, '2026-03', '2026-03-31'), [
    { billId, paidCents: 5_100, actualCents: 5_100, creditCents: 0 }
  ])
})

test('editing a variable payment down keeps the claim settled', () => {
  const db = freshDb()
  const accountId = account(db)
  const billId = gas(db, accountId)
  route(db, accountId, '2026-03-01')
  const paymentId = payGas(db, accountId, billId, 7_000)
  updateTransaction(db, USER_ID, paymentId, { amountCents: -4_200 })
  assert.equal(listBillReserves(db, USER_ID)[0].state, 'paid')
})

test('a card payment keeps the real figure withheld and frees only the difference', () => {
  const db = freshDb()
  const card = account(db, 'credit')
  const billId = gas(db, card)
  payGas(db, card, billId, 5_100)
  const [total] = listBillPaymentsThisMonth(db, USER_ID, '2026-03', '2026-03-31')
  assert.equal(total.paidCents - total.creditCents, 1_900, 'the $51 card debt stays withheld')
})

test('autopay does not post a guessed figure for a variable bill', () => {
  const db = freshDb()
  const accountId = account(db)
  gas(db, accountId, { autopay: true })
  assert.deepEqual(postDueAutopay(db, USER_ID, '2026-03-20'), { posted: 0, skipped: 0 })
  assert.equal(listTransactions(db, USER_ID).length, 0)
})

test('a backup carries the flag, and a file without it reads as fixed', () => {
  const source = freshDb()
  const accountId = account(source)
  const billId = gas(source, accountId)
  const json = backupToJson(buildBackup(source, USER_ID))
  const payload = parseBackupJson(json)
  assert.equal(payload.version, 13)
  assert.equal(payload.tables.bills[0].is_variable, 1)

  const target = freshDb()
  mergeBackup(target, USER_ID, payload)
  assert.equal(listBills(target, USER_ID).find((bill) => bill.id === billId)?.isVariable, true)

  const old = parseBackupJson(json)
  old.version = 12
  for (const row of old.tables.bills) delete row.is_variable
  const fresh = freshDb()
  mergeBackup(fresh, USER_ID, old)
  assert.equal(listBills(fresh, USER_ID)[0].isVariable, false)
})

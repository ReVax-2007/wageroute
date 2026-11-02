import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import test from 'node:test'
import { todayISO } from '@shared/dates'
import { buildBackup, backupToJson } from '../../main/db/backup'
import { migrate } from '../../main/db/migrations'
import { getSnapshot } from '../../main/db/repo/read-models'
import { seedDemoIfEmpty } from '../../main/db/seed'
import {
  selectSafeToSpendCents,
  selectUnpaidWallCents
} from '../../renderer/src/store/selectors'
import { parseBackup } from './backup'
import { billLines, dueSoon, pocketView } from './compute'
import { createEntryRow } from './entry'
import { buildSnapshot } from './snapshot'
import { flag, isLive, text } from './rows'

function demo(): { db: Database.Database; userId: string; json: string } {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  migrate(db)
  const userId = seedDemoIfEmpty(db)
  return { db, userId, json: backupToJson(buildBackup(db, userId)) }
}

test('the phone rebuilds the same accounts, goals and bills the desktop reads', () => {
  const { db, userId, json } = demo()
  const desktop = getSnapshot(db, userId)
  const pocket = buildSnapshot(parseBackup(json).tables, todayISO())

  assert.ok(pocket.accounts.length > 0)
  assert.deepEqual(
    pocket.accounts.map((row) => [row.id, row.name, row.kind, row.balanceCents, row.cashCents]),
    desktop.accounts.map((row) => [row.id, row.name, row.kind, row.balanceCents, row.cashCents])
  )
  assert.deepEqual(
    pocket.bills.map((row) => [row.id, row.name, row.amountCents, row.isActive, row.dueDay]),
    desktop.bills.map((row) => [row.id, row.name, row.amountCents, row.isActive, row.dueDay])
  )
  assert.deepEqual(
    pocket.goals.map((row) => [row.id, row.fundedCents, row.fundedFrom, row.remainingCents]),
    desktop.goals.map((row) => [row.id, row.fundedCents, row.fundedFrom, row.remainingCents])
  )
  assert.equal(pocket.transactionTotal, desktop.transactionTotal)
  assert.equal(pocket.paycheckTotal, desktop.paycheckTotal)
  assert.deepEqual(
    pocket.transactions.map((row) => [row.id, row.accountName, row.amountCents, row.occurredOn]),
    desktop.transactions.map((row) => [row.id, row.accountName, row.amountCents, row.occurredOn])
  )
  assert.deepEqual(
    pocket.billReserves.map((row) => [row.id, row.state, row.cycle]),
    desktop.billReserves.map((row) => [row.id, row.state, row.cycle])
  )
  assert.deepEqual(
    pocket.paychecks.map((row) => [row.id, row.amountCents, row.allocations.length]),
    desktop.paychecks.map((row) => [row.id, row.amountCents, row.allocations.length])
  )
  assert.deepEqual(pocket.settings, desktop.settings)
})

test('Safe to Spend on the phone is the desktop’s own number', () => {
  const { db, userId, json } = demo()
  const desktop = getSnapshot(db, userId)
  const pocket = buildSnapshot(parseBackup(json).tables, todayISO())
  const view = pocketView(pocket, todayISO())

  assert.equal(view.safeToSpendCents, selectSafeToSpendCents({ snapshot: desktop }))
  assert.equal(view.unpaidWallCents, selectUnpaidWallCents({ snapshot: desktop }))
  assert.equal(view.poolCents, selectSafeToSpendCents({ snapshot: desktop }) + view.unpaidWallCents + view.goalMoneyCents + view.unsettledCents)
})

test('the wall marks paid and open bills from the same claims the desktop wrote', () => {
  const { json } = demo()
  const snapshot = buildSnapshot(parseBackup(json).tables, todayISO())
  const lines = billLines(snapshot, todayISO())
  const paidToday = snapshot.billPaymentsThisMonth

  assert.equal(lines.length, snapshot.bills.filter((bill) => bill.isActive).length)
  for (const line of lines) {
    if (line.paidCents > 0) assert.notEqual(line.state, 'open', `${line.bill.name} was paid`)
    if (line.daysUntil < 0) assert.equal(dueSoon([line]).length, 0, 'past bills are not due soon')
  }
  assert.equal(
    lines.filter((line) => line.state === 'paid').length >= paidToday.length,
    true,
    'every bill with a payment reads as paid'
  )
})

test('an entry added on the phone moves the same balances and agrees on Safe to Spend', () => {
  const { db, userId, json } = demo()
  const tables = parseBackup(json).tables
  const account = tables.accounts.find((row) => isLive(row) && text(row, 'kind') === 'checking')
  assert.ok(account)

  const before = buildSnapshot(tables, todayISO())
  const row = createEntryRow(tables, {
    accountId: text(account, 'id'),
    kind: 'expense',
    amountCents: 1250,
    occurredOn: todayISO(),
    memo: 'Coffee',
    categoryId: null,
    categoryName: ''
  })
  const after = buildSnapshot(
    { ...tables, transactions: [...tables.transactions, row] },
    todayISO()
  )
  const accountId = text(account, 'id')
  const beforeBalance = before.accounts.find((item) => item.id === accountId)?.balanceCents ?? 0
  const afterBalance = after.accounts.find((item) => item.id === accountId)?.balanceCents ?? 0

  assert.equal(afterBalance, beforeBalance - 1250)
  assert.equal(after.transactionTotal, before.transactionTotal + 1)
  assert.equal(after.transactions[0]?.id, text(row, 'id'))
  assert.equal(after.transactions[0]?.amountCents, -1250)
  assert.equal(after.transactions[0]?.memo, 'Coffee')

  // The desktop's selector cannot see the phone row, so only the pool drops;
  // the same file on the desktop would subtract exactly this much.
  const desktop = getSnapshot(db, userId)
  assert.equal(
    pocketView(after, todayISO()).safeToSpendCents,
    selectSafeToSpendCents({ snapshot: desktop }) - 1250
  )
})

test('money the phone adds is counted before today and future money stays in balance only', () => {
  const { json } = demo()
  const tables = parseBackup(json).tables
  const account = tables.accounts.find(
    (row) => isLive(row) && flag(row, 'in_safe_to_spend', true) && text(row, 'kind') === 'checking'
  )
  assert.ok(account)
  const today = todayISO()
  const future = '2999-01-01'
  const check = buildSnapshot(tables, today)
  const withFuture = buildSnapshot(
    {
      ...tables,
      transactions: [
        ...tables.transactions,
        {
          id: 'future-check',
          user_id: text(account, 'user_id'),
          account_id: text(account, 'id'),
          kind: 'expense',
          amount_cents: -5000,
          occurred_on: future,
          memo: 'Later',
          category: 'Bills',
          category_id: null,
          external_id: null,
          bill_id: null,
          goal_id: null,
          paycheck_id: null,
          counter_account_id: null,
          transfer_group_id: null,
          round_up_source_id: null,
          created_at: future,
          updated_at: future,
          deleted_at: null,
          revision: 1
        }
      ]
    },
    today
  )
  const id = text(account, 'id')
  const balance = withFuture.accounts.find((row) => row.id === id)?.balanceCents ?? 0
  const cash = withFuture.accounts.find((row) => row.id === id)?.cashCents ?? 0
  const oldBalance = check.accounts.find((row) => row.id === id)?.balanceCents ?? 0
  assert.equal(balance, oldBalance - 5000)
  assert.equal(cash, oldBalance, 'a future entry is not spendable today')
})

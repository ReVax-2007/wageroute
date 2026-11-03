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
import { emptyTables, parseBackup } from './backup'
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

test('accounts keep the desktop’s SQL order, including its name collation', () => {
  const tables = emptyTables()
  tables.accounts = [
    { id: 'z', name: 'Zebra', kind: 'checking', sort_order: 1, is_archived: 0, deleted_at: null },
    { id: 'a', name: 'apple', kind: 'checking', sort_order: 1, is_archived: 0, deleted_at: null },
    {
      id: 'old',
      name: 'Archived',
      kind: 'checking',
      sort_order: 0,
      is_archived: 1,
      deleted_at: null
    }
  ]

  const snapshot = buildSnapshot(tables, todayISO())
  assert.deepEqual(
    snapshot.accounts.map((account) => account.name),
    ['Zebra', 'apple', 'Archived'],
    'live accounts first, then sort order, then the same byte order SQLite uses'
  )
})

test('a stale next-due date still shows the real upcoming occurrence', () => {
  const { json } = demo()
  const snapshot = buildSnapshot(parseBackup(json).tables, todayISO())
  const today = todayISO()
  const weekly = {
    ...snapshot.bills[0]!,
    frequency: 'weekly' as const,
    nextDueOn: '2020-01-05'
  }
  const [line] = billLines({ ...snapshot, bills: [weekly] }, today)

  assert.ok(line)
  assert.ok(line.dueOn >= today, 'the due date is not five years in the past')
  assert.ok(line.daysUntil >= 0 && line.daysUntil <= 7, 'a weekly bill is due within a week')
})

test('the wall marks paid and open bills from the same claims the desktop wrote', () => {
  const { json } = demo()
  const snapshot = buildSnapshot(parseBackup(json).tables, todayISO())
  const lines = billLines(snapshot, todayISO())
  const paidToday = snapshot.billPaymentsThisMonth

  assert.equal(lines.length, snapshot.bills.filter((bill) => bill.isActive).length)
  for (const line of lines) {
    const paid = paidToday.find((total) => total.billId === line.bill.id)?.paidCents ?? 0
    if (paid >= line.bill.amountCents) {
      assert.notEqual(line.state, 'open', `${line.bill.name} was paid`)
    }
    if (line.daysUntil < 0) assert.equal(dueSoon([line]).length, 0, 'past bills are not due soon')
  }
  assert.equal(
    lines.filter((line) => line.state === 'paid').length >= paidToday.length,
    true,
    'every bill with a payment reads as paid'
  )
})

test('a bill paid by card is settled while the cash it freed stays held', () => {
  const { json } = demo()
  const snapshot = buildSnapshot(parseBackup(json).tables, todayISO())
  const bill = { ...snapshot.bills[0]!, isActive: true }
  const amount = bill.amountCents
  const base = { ...snapshot, bills: [bill], billReserves: [] }
  const unpaid = {
    ...base,
    billPaymentsThisMonth: []
  }
  const byCard = {
    ...base,
    billPaymentsThisMonth: [{ billId: bill.id, paidCents: amount, creditCents: amount }]
  }

  assert.equal(
    billLines(byCard)[0]?.state,
    'paid',
    'the card payment settled the bill, as it does on the desktop prompt'
  )
  // Paying by card did not take cash out, so the same money is still held for
  // the card itself; the phone must not release it.
  assert.equal(pocketView(byCard).unpaidWallCents, pocketView(unpaid).unpaidWallCents)
  assert.equal(pocketView(byCard).safeToSpendCents, pocketView(unpaid).safeToSpendCents)

  const inCash = {
    ...base,
    billPaymentsThisMonth: [{ billId: bill.id, paidCents: amount, creditCents: 0 }]
  }
  assert.equal(billLines(inCash)[0]?.state, 'paid')
  assert.ok(pocketView(inCash).safeToSpendCents > pocketView(unpaid).safeToSpendCents)
})

test('a part payment leaves the bill open with the money it already took', () => {
  const { json } = demo()
  const snapshot = buildSnapshot(parseBackup(json).tables, todayISO())
  const bill = { ...snapshot.bills[0]!, isActive: true }
  const half = Math.floor(bill.amountCents / 2)
  const partial = {
    ...snapshot,
    bills: [bill],
    billReserves: [],
    billPaymentsThisMonth: [{ billId: bill.id, paidCents: half, creditCents: 0 }]
  }

  const [line] = billLines(partial)
  assert.equal(line?.state, 'open', 'the bill still needs the rest')
  assert.equal(line?.paidCents, half, 'the part already paid is not lost')
})

test('a bill-linked adjustment is not part of the phone’s payment history', () => {
  const { json } = demo()
  const tables = parseBackup(json).tables
  const billRow = tables.bills.find((row) => isLive(row))
  const accountRow = tables.accounts.find((row) => isLive(row))
  assert.ok(billRow)
  assert.ok(accountRow)
  const today = todayISO()
  const tablesWithNote = {
    ...tables,
    transactions: [
      ...tables.transactions,
      {
        id: 'bill-note',
        user_id: text(accountRow, 'user_id'),
        account_id: text(accountRow, 'id'),
        kind: 'adjustment',
        amount_cents: -1000,
        occurred_on: today,
        memo: 'Corrected the bill',
        category: 'Bills',
        category_id: null,
        external_id: null,
        bill_id: text(billRow, 'id'),
        goal_id: null,
        paycheck_id: null,
        counter_account_id: null,
        transfer_group_id: null,
        round_up_source_id: null,
        created_at: today,
        updated_at: today,
        deleted_at: null,
        revision: 1
      }
    ]
  }

  const snapshot = buildSnapshot(tablesWithNote, today)
  assert.equal(
    snapshot.billPayments.some((row) => row.billId === text(billRow, 'id') && row.amountCents === -1000),
    false,
    'the note is not read back as a payment'
  )
})

test('bills due on the same day keep the desktop’s byte order', () => {
  const { json } = demo()
  const snapshot = buildSnapshot(parseBackup(json).tables, todayISO())
  const template = { ...snapshot.bills[0]!, isActive: true, dueDay: 10 }
  const lines = billLines(
    {
      ...snapshot,
      bills: [
        { ...template, id: 'lower', name: 'apple' },
        { ...template, id: 'upper', name: 'Zebra' }
      ],
      billReserves: [],
      billPaymentsThisMonth: []
    },
    todayISO()
  )

  assert.deepEqual(
    lines.map((line) => line.bill.name),
    ['Zebra', 'apple'],
    'SQLite BINARY puts an upper-case letter before a lower-case one'
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

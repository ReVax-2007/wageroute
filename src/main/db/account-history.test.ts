import assert from 'node:assert/strict'
import Database from 'better-sqlite3-multiple-ciphers'
import test from 'node:test'
import type { LedgerQuery, TransactionPage } from '@shared/types'
import { migrate } from './migrations'
import {
  createAccount,
  createSplitTransfer,
  createTransaction,
  listAccounts,
  queryTransactions
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

function open(
  db: Database.Database,
  name: string,
  kind: 'checking' | 'savings' | 'credit' | 'investment',
  cents = 0
): string {
  return createAccount(db, USER_ID, {
    name,
    kind,
    institution: '',
    startingBalanceCents: cents,
    creditLimitCents: kind === 'credit' ? 500_000 : null
  })
}

function history(
  db: Database.Database,
  accountId: string,
  patch: Partial<LedgerQuery> = {}
): TransactionPage {
  return queryTransactions(db, USER_ID, {
    filter: { accountId, ...patch.filter },
    sort: patch.sort ?? 'date_desc',
    limit: patch.limit ?? 100,
    offset: patch.offset ?? 0
  })
}

function balanceOf(db: Database.Database, accountId: string): number {
  return listAccounts(db, USER_ID).find((account) => account.id === accountId)!.balanceCents
}

/** Each page row with the balance the account held right after it. */
function lines(page: TransactionPage): [string, number, number][] {
  return page.rows.map((row) => [row.memo, row.amountCents, page.account!.balanceAfter[row.id]])
}

function money(
  db: Database.Database,
  accountId: string,
  kind: 'income' | 'expense' | 'investment' | 'adjustment',
  amountCents: number,
  occurredOn: string,
  memo: string
): string {
  return createTransaction(db, USER_ID, {
    accountId,
    kind,
    amountCents,
    occurredOn,
    memo,
    category: kind === 'income' ? 'Income' : 'Misc'
  })
}

function transfer(
  db: Database.Database,
  from: string,
  to: string,
  amountCents: number,
  occurredOn: string,
  memo: string
): string {
  return createTransaction(db, USER_ID, {
    accountId: from,
    counterAccountId: to,
    kind: 'transfer',
    amountCents,
    occurredOn,
    memo,
    category: 'Transfer'
  })
}

test('an account history lists transfers both ways with the other account and a running balance', () => {
  const db = freshDb()
  const chequing = open(db, 'Chequing', 'checking', 1_000_00)
  const savings = open(db, 'Savings', 'savings', 500_00)
  money(db, chequing, 'income', 2_000_00, '2026-11-01', 'Paycheck')
  transfer(db, chequing, savings, 300_00, '2026-11-02', 'To savings')
  transfer(db, savings, chequing, 50_00, '2026-11-03', 'Back from savings')
  money(db, chequing, 'expense', 40_00, '2026-11-04', 'Groceries')
  money(db, savings, 'income', 1_00, '2026-11-05', 'Interest')

  const page = history(db, chequing)
  assert.deepEqual(lines(page), [
    ['Groceries', -40_00, 2_710_00],
    ['Back from savings', 50_00, 2_750_00],
    ['To savings', -300_00, 2_700_00],
    ['Paycheck', 2_000_00, 3_000_00]
  ])
  assert.equal(page.account!.balanceAfter[page.rows[0].id], balanceOf(db, chequing), 'ends on the current balance')
  assert.deepEqual(
    page.rows.map((row) => row.counterAccountId),
    [null, savings, savings, null],
    'each transfer leg names the other account'
  )
  assert.equal(page.account!.inCents, 2_050_00)
  assert.equal(page.account!.outCents, 340_00)

  const other = history(db, savings)
  assert.deepEqual(lines(other), [
    ['Interest', 1_00, 751_00],
    ['Back from savings', -50_00, 750_00],
    ['To savings', 300_00, 800_00]
  ])
  db.close()
})

test('a filter narrows the rows and the totals but never the running balance', () => {
  const db = freshDb()
  const chequing = open(db, 'Chequing', 'checking', 100_00)
  money(db, chequing, 'expense', 10_00, '2026-10-01', 'Coffee old')
  money(db, chequing, 'income', 50_00, '2026-11-01', 'Refund')
  money(db, chequing, 'expense', 5_00, '2026-11-02', 'Coffee new')

  const coffee = history(db, chequing, { filter: { text: 'coffee' } })
  assert.deepEqual(lines(coffee), [
    ['Coffee new', -5_00, 135_00],
    ['Coffee old', -10_00, 90_00]
  ])
  assert.equal(coffee.account!.inCents, 0)
  assert.equal(coffee.account!.outCents, 15_00)

  const recent = history(db, chequing, { filter: { from: '2026-11-01' } })
  assert.deepEqual(lines(recent).map(([memo, , balance]) => [memo, balance]), [
    ['Coffee new', 135_00],
    ['Refund', 140_00]
  ])
  assert.deepEqual([recent.account!.inCents, recent.account!.outCents], [50_00, 5_00])

  // Oldest first and the second page both keep each row's own balance.
  const oldest = history(db, chequing, { sort: 'date_asc', limit: 1, offset: 1 })
  assert.deepEqual(lines(oldest), [['Refund', 50_00, 140_00]])
  assert.equal(oldest.total, 3)
  db.close()
})

test('split legs written in one instant keep a stable order against the running balance', () => {
  const db = freshDb()
  const source = open(db, 'A chequing', 'checking', 1_000_00)
  const via = open(db, 'B chequing', 'checking')
  const savings = open(db, 'B savings', 'savings')
  const visa = open(db, 'Visa', 'credit', -200_00)
  createSplitTransfer(db, USER_ID, {
    sourceAccountId: source,
    viaAccountId: via,
    occurredOn: '2026-11-10',
    lines: [
      { accountId: via, amountCents: 100_00 },
      { accountId: savings, amountCents: 250_00 },
      { accountId: visa, amountCents: 150_00 }
    ]
  })

  // The hub sees the hop in and two onward legs out, all on one day.
  const hub = history(db, via)
  assert.equal(hub.total, 3)
  assert.ok(hub.rows.every((row) => row.splitGroupId !== null && row.kind === 'transfer'))
  assert.equal(hub.account!.balanceAfter[hub.rows[0].id], balanceOf(db, via))
  assert.deepEqual([hub.account!.inCents, hub.account!.outCents], [500_00, 400_00])
  // Walking the rows newest first, each balance is the next one's plus this amount.
  for (let i = 0; i < hub.rows.length - 1; i++) {
    const row = hub.rows[i]
    const before = hub.account!.balanceAfter[hub.rows[i + 1].id]
    assert.equal(hub.account!.balanceAfter[row.id], before + row.amountCents)
  }
  const reversed = history(db, via, { sort: 'date_asc' })
  assert.deepEqual(
    reversed.rows.map((row) => row.id),
    [...hub.rows].reverse().map((row) => row.id),
    'oldest first is exactly newest first reversed'
  )
  db.close()
})

test('a card history shows charges and payments with a balance that ends at what is owed', () => {
  const db = freshDb()
  const chequing = open(db, 'Chequing', 'checking', 1_000_00)
  const visa = open(db, 'Visa', 'credit', -200_00)
  money(db, visa, 'expense', 60_00, '2026-11-01', 'Dinner')
  transfer(db, chequing, visa, 150_00, '2026-11-05', 'Pay Visa')
  money(db, visa, 'expense', 25_00, '2026-11-06', 'Fuel')

  const page = history(db, visa)
  assert.deepEqual(lines(page), [
    ['Fuel', -25_00, -135_00],
    ['Pay Visa', 150_00, -110_00],
    ['Dinner', -60_00, -260_00]
  ])
  assert.equal(page.rows[1].counterAccountId, chequing, 'the payment says where it came from')
  assert.equal(balanceOf(db, visa), -135_00)
  assert.deepEqual([page.account!.inCents, page.account!.outCents], [150_00, 85_00])
  db.close()
})

test('an investment history counts contributions, gains and losses', () => {
  const db = freshDb()
  const chequing = open(db, 'Chequing', 'checking', 1_000_00)
  const brokerage = open(db, 'Brokerage', 'investment', 5_000_00)
  transfer(db, chequing, brokerage, 200_00, '2026-11-01', 'Monthly contribution')
  money(db, brokerage, 'adjustment', 120_00, '2026-11-15', 'Market gain')
  money(db, brokerage, 'adjustment', -45_00, '2026-11-20', 'Market loss')
  money(db, brokerage, 'investment', 10_00, '2026-11-21', 'Fund fee')

  const page = history(db, brokerage, { filter: { kind: 'adjustment' } })
  assert.deepEqual(lines(page), [
    ['Market loss', -45_00, 5_275_00],
    ['Market gain', 120_00, 5_320_00]
  ])
  const all = history(db, brokerage)
  assert.equal(all.total, 4)
  assert.equal(all.account!.balanceAfter[all.rows[0].id], balanceOf(db, brokerage))
  assert.equal(balanceOf(db, brokerage), 5_265_00)
  db.close()
})

test('a ledger page without an account carries no account figures', () => {
  const db = freshDb()
  const chequing = open(db, 'Chequing', 'checking', 100_00)
  money(db, chequing, 'expense', 1_00, '2026-11-01', 'Gum')
  const page = queryTransactions(db, USER_ID, { filter: {}, sort: 'date_desc', limit: 10, offset: 0 })
  assert.equal(page.account, undefined)
  const empty = history(db, chequing, { filter: { text: 'nothing like this' } })
  assert.deepEqual(empty.account, { accountId: chequing, balanceAfter: {}, inCents: 0, outCents: 0 })
  db.close()
})

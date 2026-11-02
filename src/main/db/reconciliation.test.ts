import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import test from 'node:test'
import { ledgerStatementCents, reconcileStatement } from '@shared/statements'
import { migrate } from './migrations'
import {
  accountBalanceOn,
  createAccount,
  createTransaction,
  listTransactions,
  reconcileAccountOn
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

function account(
  db: Database.Database,
  name: string,
  kind = 'checking',
  startingBalanceCents = 0
): string {
  return createAccount(db, USER_ID, {
    name,
    kind: kind as never,
    institution: '',
    startingBalanceCents,
    creditLimitCents: null
  })
}

function entry(
  db: Database.Database,
  accountId: string,
  kind: 'expense' | 'income',
  amountCents: number,
  occurredOn: string
): string {
  return createTransaction(db, USER_ID, {
    accountId,
    kind,
    amountCents,
    occurredOn,
    category: 'Misc',
    memo: 'test'
  })
}

test('a balance on a date counts that day and nothing after it', () => {
  const db = freshDb()
  const chequing = account(db, 'Chequing') // opening balance 0
  entry(db, chequing, 'expense', 2_000, '2026-03-05')
  entry(db, chequing, 'income', 5_000, '2026-03-10')

  assert.deepEqual(accountBalanceOn(db, USER_ID, chequing, '2026-03-04'), {
    name: 'Chequing',
    kind: 'checking',
    balanceCents: 0
  })
  assert.equal(accountBalanceOn(db, USER_ID, chequing, '2026-03-05')?.balanceCents, -2_000)
  assert.equal(accountBalanceOn(db, USER_ID, chequing, '2026-03-10')?.balanceCents, 3_000)
  assert.equal(accountBalanceOn(db, USER_ID, 'missing', '2026-03-10'), null)
})

test('the opening balance is part of what the account held on a date', () => {
  const db = freshDb()
  const savings = account(db, 'Savings', 'savings', 80_000)
  entry(db, savings, 'income', 20_000, '2026-04-01')

  assert.equal(accountBalanceOn(db, USER_ID, savings, '2026-03-31')?.balanceCents, 80_000)
  assert.equal(accountBalanceOn(db, USER_ID, savings, '2026-04-01')?.balanceCents, 100_000)
})

test('a card statement prints what is owed and the ledger holds it negative', () => {
  const db = freshDb()
  const card = account(db, 'Visa', 'credit')
  entry(db, card, 'expense', 120_000, '2026-03-02')
  entry(db, card, 'income', 20_000, '2026-03-20')

  // The bank prints 1,000.00 owed; the ledger holds −1,000.00.
  assert.equal(accountBalanceOn(db, USER_ID, card, '2026-03-31')?.balanceCents, -100_000)
  assert.equal(ledgerStatementCents(100_000, 'credit'), -100_000)
  assert.equal(ledgerStatementCents(-100_000, 'credit'), -100_000)
  assert.equal(ledgerStatementCents(100_000, 'checking'), 100_000)

  // They agree, so reconciling posts nothing.
  assert.equal(reconcileAccountOn(db, USER_ID, card, 100_000, '2026-03-31'), 0)
  assert.equal(listTransactions(db, USER_ID).length, 2)
})

test('a disagreement posts one adjustment on the statement day and leaves later entries alone', () => {
  const db = freshDb()
  const chequing = account(db, 'Chequing')
  entry(db, chequing, 'expense', 1_000, '2026-03-05')
  entry(db, chequing, 'income', 5_000, '2026-03-10')

  // The bank closed at 950.00 on the 5th while the ledger held −10.00.
  const posted = reconcileAccountOn(db, USER_ID, chequing, 95_000, '2026-03-05')
  assert.equal(posted, 96_000)
  assert.equal(accountBalanceOn(db, USER_ID, chequing, '2026-03-05')?.balanceCents, 95_000)
  // The income on the 10th is still there on top of the reconciled balance.
  assert.equal(accountBalanceOn(db, USER_ID, chequing, '2026-03-10')?.balanceCents, 100_000)

  const adjustment = listTransactions(db, USER_ID).find((row) => row.kind === 'adjustment')
  assert.ok(adjustment)
  assert.equal(adjustment.amountCents, 96_000)
  assert.equal(adjustment.occurredOn, '2026-03-05')
  assert.equal(adjustment.memo, 'Statement reconciliation')

  // Running it again finds the two figures equal and writes nothing.
  assert.equal(reconcileAccountOn(db, USER_ID, chequing, 95_000, '2026-03-05'), 0)
  assert.equal(listTransactions(db, USER_ID).length, 3)
})

test('reconciling a deleted account is refused rather than posted nowhere', () => {
  const db = freshDb()
  assert.throws(
    () => reconcileAccountOn(db, USER_ID, 'missing', 1_000, '2026-03-05'),
    /no longer exists/
  )
})

test('the shared comparison reports the gap in the ledger’s own sign', () => {
  const card = reconcileStatement({
    accountId: 'a',
    accountName: 'Visa',
    accountKind: 'credit',
    statementCents: 50_000,
    ledgerCents: -40_000,
    balanceOn: '2026-03-31'
  })
  assert.deepEqual(card, {
    accountId: 'a',
    accountName: 'Visa',
    accountKind: 'credit',
    balanceOn: '2026-03-31',
    statementCents: -50_000,
    ledgerCents: -40_000,
    differenceCents: -10_000
  })

  const chequing = reconcileStatement({
    accountId: 'b',
    accountName: 'Chequing',
    accountKind: 'checking',
    statementCents: 95_000,
    ledgerCents: 95_000,
    balanceOn: '2026-03-05'
  })
  assert.equal(chequing.differenceCents, 0)
})

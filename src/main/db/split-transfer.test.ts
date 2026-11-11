import assert from 'node:assert/strict'
import Database from 'better-sqlite3-multiple-ciphers'
import test from 'node:test'
import { CREDIT_CARD_SOURCE_REFUSAL } from '@shared/writeRules'
import { migrate } from './migrations'
import {
  createAccount,
  createSplitTransfer,
  listAccounts,
  listTransactions,
  setAccountArchived
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

function open(db: Database.Database, name: string, kind: 'checking' | 'savings' | 'credit', cents = 0): string {
  return createAccount(db, USER_ID, {
    name,
    kind,
    institution: '',
    startingBalanceCents: cents,
    creditLimitCents: kind === 'credit' ? 500_000 : null
  })
}

function balances(db: Database.Database): Record<string, number> {
  return Object.fromEntries(
    listAccounts(db, USER_ID).map((account) => [account.name, account.balanceCents])
  )
}

test('a split through another bank writes the hop and each onward transfer at once', () => {
  const db = freshDb()
  const a1 = open(db, 'A chequing', 'checking', 1_000_00)
  const b1 = open(db, 'B chequing', 'checking')
  const b2 = open(db, 'B savings', 'savings')
  const visa = open(db, 'Visa', 'credit', -200_00)

  const ids = createSplitTransfer(db, USER_ID, {
    sourceAccountId: a1,
    viaAccountId: b1,
    occurredOn: '2026-11-10',
    lines: [
      { accountId: b1, amountCents: 100_00 },
      { accountId: b2, amountCents: 250_00, category: 'Savings' },
      { accountId: visa, amountCents: 150_00 }
    ]
  })

  assert.equal(ids.length, 3, 'one outgoing leg per transfer: the hop and two onward moves')
  const rows = listTransactions(db, USER_ID)
  assert.equal(rows.length, 6)
  assert.ok(rows.every((row) => row.kind === 'transfer'))
  // Every transfer is an ordinary pair: two legs, one group, opposite signs.
  const groups = new Map<string, number[]>()
  for (const row of rows) groups.set(row.transferGroupId!, [...(groups.get(row.transferGroupId!) ?? []), row.amountCents])
  assert.equal(groups.size, 3)
  for (const legs of groups.values()) assert.equal(legs[0] + legs[1], 0)

  assert.deepEqual(balances(db), {
    'A chequing': 500_00,
    'B chequing': 100_00,
    'B savings': 250_00,
    Visa: -50_00
  })
  assert.ok(rows.some((row) => row.accountId === b2 && row.category === 'Savings'))
})

test('a refusal on any line leaves the ledger untouched', () => {
  const db = freshDb()
  const a1 = open(db, 'A chequing', 'checking', 1_000_00)
  const b1 = open(db, 'B chequing', 'checking')
  const b2 = open(db, 'B savings', 'savings')
  setAccountArchived(db, USER_ID, b2, true)

  // The last line fails inside the transaction, after the first was written.
  assert.throws(
    () =>
      createSplitTransfer(db, USER_ID, {
        sourceAccountId: a1,
        occurredOn: '2026-11-10',
        lines: [
          { accountId: b1, amountCents: 100_00 },
          { accountId: b2, amountCents: 50_00 }
        ]
      }),
    /archived/
  )
  assert.equal(listTransactions(db, USER_ID).length, 0)
  assert.equal(balances(db)['A chequing'], 1_000_00)
})

test('a card is never the source or the account a split passes through', () => {
  const db = freshDb()
  const a1 = open(db, 'A chequing', 'checking', 1_000_00)
  const b1 = open(db, 'B chequing', 'checking')
  const visa = open(db, 'Visa', 'credit')
  for (const input of [
    { sourceAccountId: visa, lines: [{ accountId: b1, amountCents: 10_00 }] },
    { sourceAccountId: a1, viaAccountId: visa, lines: [{ accountId: b1, amountCents: 10_00 }] }
  ]) {
    assert.throws(
      () => createSplitTransfer(db, USER_ID, { occurredOn: '2026-11-10', ...input }),
      (error: Error) => error.message === CREDIT_CARD_SOURCE_REFUSAL
    )
  }
  assert.equal(listTransactions(db, USER_ID).length, 0)
})

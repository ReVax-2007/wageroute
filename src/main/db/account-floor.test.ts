import assert from 'node:assert/strict'
import Database from 'better-sqlite3-multiple-ciphers'
import test from 'node:test'
import { todayISO } from '@shared/dates'
import { patchAccount } from '../../pocket/lib/write'
import { backupToJson, buildBackup, mergeBackup, parseBackupJson } from './backup'
import { migrate } from './migrations'
import {
  createAccount,
  createTransaction,
  listAccounts,
  listTransactions,
  updateAccount
} from './repositories'
import { writeSettings } from './repo/settings'

/** ADR 0035: an account floor is stored, synced and respected by the app's own moves. */

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
  kind: 'checking' | 'savings' | 'credit',
  startingBalanceCents: number,
  floorCents: number | null = null
): string {
  return createAccount(db, USER_ID, {
    name,
    kind,
    institution: '',
    startingBalanceCents,
    creditLimitCents: kind === 'credit' ? 500_000 : null,
    floorCents
  })
}

function floorOf(db: Database.Database, id: string): number | null | undefined {
  return listAccounts(db, USER_ID).find((item) => item.id === id)?.floorCents
}

test('a floor is stored, changed and cleared, and the balance never moves', () => {
  const db = freshDb()
  const chequing = account(db, 'Chequing', 'checking', 200_00, 90_00)
  assert.equal(floorOf(db, chequing), 90_00)

  updateAccount(db, USER_ID, chequing, { floorCents: 0 })
  assert.equal(floorOf(db, chequing), 0, 'a zero floor is a floor, not "none"')
  updateAccount(db, USER_ID, chequing, { name: 'Main' })
  assert.equal(floorOf(db, chequing), 0, 'a patch without the field leaves it alone')
  updateAccount(db, USER_ID, chequing, { floorCents: null })
  assert.equal(floorOf(db, chequing), null)

  const [row] = listAccounts(db, USER_ID)
  assert.equal(row?.balanceCents, 200_00)
  assert.throws(() => updateAccount(db, USER_ID, chequing, { floorCents: -1 }), /Floor/)
})

test('an account without a floor reads exactly as before, and a card never keeps one', () => {
  const db = freshDb()
  const plain = account(db, 'Plain', 'checking', 50_00)
  const card = account(db, 'Visa', 'credit', -100_00, 90_00)
  assert.equal(floorOf(db, plain), null)
  assert.equal(floorOf(db, card), null, 'a card’s floor is its limit, so a sent floor is dropped')
})

test('a round-up sweep that would go under the floor is skipped; one with room still runs', () => {
  const db = freshDb()
  const chequing = account(db, 'Chequing', 'checking', 100_00, 90_00)
  const savings = account(db, 'Savings', 'savings', 0)
  writeSettings(db, USER_ID, {
    roundUpEnabled: 'true',
    roundUpAccountId: savings,
    roundUpToCents: '100'
  })

  // $100.00 − $9.40 leaves $90.60; sweeping 60¢ more would land exactly on the
  // floor, which is allowed.
  createTransaction(db, USER_ID, {
    accountId: chequing,
    kind: 'expense',
    amountCents: -9_40,
    occurredOn: todayISO(),
    category: 'Food',
    memo: 'Lunch'
  })
  assert.equal(listTransactions(db, USER_ID).length, 3, 'the purchase and both sweep legs')

  // Now at $90.00; a 70¢ sweep after a $0.30 coffee would leave $89.00.
  createTransaction(db, USER_ID, {
    accountId: chequing,
    kind: 'expense',
    amountCents: -30,
    occurredOn: todayISO(),
    category: 'Food',
    memo: 'Coffee'
  })
  assert.equal(listTransactions(db, USER_ID).length, 4, 'the coffee is saved, the sweep is not')
  const after = listAccounts(db, USER_ID).find((item) => item.id === chequing)
  assert.equal(after?.balanceCents, 89_70, 'only the owner’s own entry took it under')
})

test('a floor survives a backup written to JSON and restored into another ledger', () => {
  const source = freshDb()
  const chequing = account(source, 'Chequing', 'checking', 200_00, 90_00)
  account(source, 'Savings', 'savings', 50_00)

  const file = backupToJson(buildBackup(source, USER_ID))
  const target = freshDb()
  const result = mergeBackup(target, USER_ID, parseBackupJson(file))

  assert.deepEqual(result.issues, [])
  assert.equal(floorOf(target, chequing), 90_00)
  const savings = listAccounts(target, USER_ID).find((item) => item.name === 'Savings')
  assert.equal(savings?.floorCents, null, 'no floor stays no floor')
})

test('a floor set on the phone arrives on the computer through the merge', () => {
  const db = freshDb()
  const chequing = account(db, 'Chequing', 'checking', 200_00)
  const phone = structuredClone(buildBackup(db, USER_ID).tables)

  const edited = patchAccount(phone, chequing, { floorCents: 90_00 })
  const payload = buildBackup(db, USER_ID)
  payload.exportedAt = new Date(Date.now() + 60_000).toISOString()
  payload.tables = edited
  const result = mergeBackup(db, USER_ID, payload)

  assert.deepEqual(result.issues, [])
  assert.equal(floorOf(db, chequing), 90_00)
})

test('a backup from before floors existed restores every account without one', () => {
  const source = freshDb()
  const chequing = account(source, 'Chequing', 'checking', 200_00)
  const payload = buildBackup(source, USER_ID)
  payload.version = 11
  for (const row of payload.tables.accounts) delete (row as Record<string, unknown>).floor_cents

  const target = freshDb()
  const result = mergeBackup(target, USER_ID, parseBackupJson(backupToJson(payload)))
  assert.deepEqual(result.issues, [])
  assert.equal(floorOf(target, chequing), null)
})

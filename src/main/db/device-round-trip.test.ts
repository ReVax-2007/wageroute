import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import test from 'node:test'
import type { ImportTables } from '@shared/importRepair'
import { todayISO } from '@shared/dates'
import type { BillInput, GoalInput, TransactionInput } from '@shared/types'
import { createEntry, createGoal, deleteEntries, payBill, patchBill } from '../../pocket/lib/write'
import { buildBackup, mergeBackup } from './backup'
import { migrate } from './migrations'
import {
  createAccount,
  createBill,
  createTransaction,
  listAccounts,
  listAllTransactions,
  listBills,
  listGoals
} from './repositories'

/**
 * The promise of the phone's write path is that its rows need no translation:
 * what `src/pocket/lib/write.ts` puts in the tables is what the desktop's own
 * merge accepts, and the ledger read back says the same thing the phone showed.
 * Every case here is one file crossing that boundary and being read again.
 */

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

function account(db: Database.Database, name: string, kind: 'checking' | 'savings'): string {
  return createAccount(db, USER_ID, {
    name,
    kind,
    institution: '',
    startingBalanceCents: 500_000,
    creditLimitCents: null
  })
}

const BILL: Omit<BillInput, 'accountId'> = {
  name: 'Internet',
  amountCents: 7599,
  frequency: 'monthly',
  dueDay: 15,
  category: 'Bills',
  autopay: true,
  isActive: true,
  nextDueOn: null
}

const GOAL: GoalInput = {
  name: 'Future house',
  targetCents: 900_000,
  targetDate: null,
  priority: 1,
  color: '#38BDF8',
  accountId: null
}

function expense(accountId: string, memo: string, amountCents: number): TransactionInput {
  return { accountId, kind: 'expense', amountCents, occurredOn: todayISO(), category: 'Misc', memo }
}

/** The phone's copy of the desktop's ledger, exactly as a backup carries it. */
function phoneCopyOf(db: Database.Database): ImportTables {
  return structuredClone(buildBackup(db, USER_ID).tables)
}

/** The file the phone would hand back after those edits. */
function exportedFrom(db: Database.Database, tables: ImportTables) {
  const payload = buildBackup(db, USER_ID)
  // A file is written after the edits it carries, so no stamp is capped away.
  payload.exportedAt = new Date(Date.now() + 60_000).toISOString()
  payload.tables = tables
  return payload
}

test('a bill paid and corrected on the phone imports as the desktop’s own row', () => {
  const db = freshDb()
  const chequing = account(db, 'Chequing', 'checking')
  const billId = createBill(db, USER_ID, { ...BILL, accountId: chequing })

  const paid = payBill(phoneCopyOf(db), billId)
  const edited = patchBill(paid.tables, billId, { amountCents: 8000 })
  const result = mergeBackup(db, USER_ID, exportedFrom(db, edited))

  assert.deepEqual(result.issues, [])
  const [bill] = listBills(db, USER_ID)
  assert.equal(bill?.amountCents, 8000, 'the corrected amount is what the computer now charges')
  assert.equal(bill?.revision, 2, 'the row carries the revision the phone bumped')
  assert.equal(result.added.transactions, 1, 'the payment arrives as one new entry')

  const payments = listAllTransactions(db, USER_ID).filter((row) => row.kind === 'bill_payment')
  assert.equal(payments.length, 1)
  assert.equal(payments[0]?.billId, billId, 'the payment is still linked to the bill')
  assert.equal(payments[0]?.amountCents, -7599, 'it pays what the bill owed when it was written')

  // Read the other way: the phone's next import must not undo its own edit.
  const againOnPhone = patchBill(phoneCopyOf(db), billId, { name: 'Internet fibre' })
  mergeBackup(db, USER_ID, exportedFrom(db, againOnPhone))
  const [after] = listBills(db, USER_ID)
  assert.equal(after?.name, 'Internet fibre')
  assert.equal(after?.amountCents, 8000, 'the amount the phone set survives the second merge')
})

test('an entry, a transfer pair and a goal added on the phone land whole', () => {
  const db = freshDb()
  const chequing = account(db, 'Chequing', 'checking')
  const savings = account(db, 'Savings', 'savings')

  const added = createEntry(phoneCopyOf(db), expense(chequing, 'Bus pass', 2500))
  const paired = createEntry(added.tables, {
    ...expense(savings, 'Rent saved', 30_000),
    kind: 'transfer',
    counterAccountId: chequing
  })
  const goal = createGoal(paired.tables, { ...GOAL, accountId: savings, fundingAccountIds: [savings] })
  mergeBackup(db, USER_ID, exportedFrom(db, goal.tables))

  const rows = listAllTransactions(db, USER_ID)
  const legs = rows.filter((row) => row.kind === 'transfer')
  assert.equal(legs.length, 2, 'both legs of the transfer arrive')
  assert.equal(legs[0]?.transferGroupId, legs[1]?.transferGroupId)
  assert.deepEqual(
    [legs[0]?.amountCents, legs[1]?.amountCents].sort((a, b) => (a ?? 0) - (b ?? 0)),
    [-30_000, 30_000],
    'the pair still nets to nothing'
  )
  assert.ok(rows.some((row) => row.memo === 'Bus pass' && row.amountCents === -2500))

  const [phoneGoal] = listGoals(db, USER_ID).filter((item) => item.id === goal.id)
  assert.ok(phoneGoal, 'the goal the phone made is in the desktop’s list')
  assert.equal(phoneGoal?.targetCents, 900_000)
  assert.equal(phoneGoal?.fundedFrom, 'account', 'the dedicated account measures its progress')
  const [savingsRow] = listAccounts(db, USER_ID).filter((item) => item.id === savings)
  assert.equal(savingsRow?.dedicatedGoalId, goal.id)
})

test('an entry deleted on the phone is gone from the desktop as well', () => {
  const db = freshDb()
  const chequing = account(db, 'Chequing', 'checking')
  const keptId = createTransaction(db, USER_ID, expense(chequing, 'Mistyped entry', 900))
  const tables = phoneCopyOf(db)

  const { tables: after, removed } = deleteEntries(tables, [keptId])
  assert.equal(removed.length, 1)
  const result = mergeBackup(db, USER_ID, exportedFrom(db, after))

  assert.deepEqual(
    listAllTransactions(db, USER_ID).map((row) => row.id),
    [],
    'the row leaves the desktop’s ledger'
  )
  assert.equal(result.removed.transactions, 1, 'the import report counts the retirement')
})

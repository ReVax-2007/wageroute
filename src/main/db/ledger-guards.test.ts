import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import test from 'node:test'
import { mergeEntries } from './entries'
import { migrate } from './migrations'
import {
  accountEntryCount,
  commitPaycheck,
  createAccount,
  createGoal,
  createTransaction,
  deleteAccount,
  getSnapshot,
  listAccounts,
  listTransactions,
  setAccountArchived,
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

function account(db: Database.Database, name: string, kind = 'checking'): string {
  return createAccount(db, USER_ID, {
    name,
    kind: kind as never,
    institution: '',
    startingBalanceCents: 0,
    creditLimitCents: null
  })
}

function entry(
  db: Database.Database,
  accountId: string,
  input: { kind?: string; amountCents: number; counterAccountId?: string }
): string {
  return createTransaction(db, USER_ID, {
    accountId,
    kind: (input.kind ?? 'expense') as never,
    amountCents: input.amountCents,
    occurredOn: '2026-03-01',
    category: 'Misc',
    memo: 'test',
    counterAccountId: input.counterAccountId ?? null
  })
}

test('the repository writes the sign its kind demands', () => {
  const db = freshDb()
  const chequing = account(db, 'Chequing')

  entry(db, chequing, { kind: 'expense', amountCents: 4_200 })
  entry(db, chequing, { kind: 'income', amountCents: -90_000 })

  const amounts = listTransactions(db, USER_ID).map((row) => row.amountCents)
  assert.deepEqual(amounts.sort((a, b) => a - b), [-4_200, 90_000])
})

test('turning a single entry into a transfer is refused', () => {
  const db = freshDb()
  const chequing = account(db, 'Chequing')
  account(db, 'Savings', 'savings')
  const id = entry(db, chequing, { amountCents: -1_000 })

  assert.throws(() => updateTransaction(db, USER_ID, id, { kind: 'transfer' }), /need two accounts/)
})

test('a transfer leg keeps its account and kind, and edits mirror onto its twin', () => {
  const db = freshDb()
  const chequing = account(db, 'Chequing')
  const savings = account(db, 'Savings', 'savings')
  account(db, 'Credit', 'credit')
  const outId = entry(db, chequing, {
    kind: 'transfer',
    amountCents: -25_000,
    counterAccountId: savings
  })

  assert.throws(
    () => updateTransaction(db, USER_ID, outId, { accountId: account(db, 'Credit', 'credit') }),
    /Paired transfers keep their accounts/
  )

  updateTransaction(db, USER_ID, outId, { amountCents: 30_000 })
  const legs = listTransactions(db, USER_ID)
    .filter((row) => row.kind === 'transfer')
    .map((row) => row.amountCents)
    .sort((a, b) => a - b)
  assert.deepEqual(legs, [-30_000, 30_000])
})

test('an account with entries cannot be deleted without saying so', () => {
  const db = freshDb()
  const chequing = account(db, 'Chequing')
  entry(db, chequing, { amountCents: -1_500 })

  assert.equal(accountEntryCount(db, USER_ID, chequing), 1)
  assert.throws(() => deleteAccount(db, USER_ID, chequing), /still has entries/)

  deleteAccount(db, USER_ID, chequing, { withEntries: true })
  assert.equal(accountEntryCount(db, USER_ID, chequing), 0)
  assert.equal(listAccounts(db, USER_ID).length, 0)
})

test('deleting an account with entries takes both legs of its transfers', () => {
  const db = freshDb()
  const chequing = account(db, 'Chequing')
  const savings = account(db, 'Savings', 'savings')
  entry(db, chequing, { kind: 'transfer', amountCents: -40_000, counterAccountId: savings })

  deleteAccount(db, USER_ID, chequing, { withEntries: true })

  assert.deepEqual(listTransactions(db, USER_ID), [])
  assert.equal(accountEntryCount(db, USER_ID, savings), 0, 'the other leg goes too')
})

test('archiving keeps an account and its history out of the working totals', () => {
  const db = freshDb()
  const chequing = account(db, 'Chequing')
  entry(db, chequing, { amountCents: -2_500 })

  setAccountArchived(db, USER_ID, chequing, true)

  const [archived] = listAccounts(db, USER_ID)
  assert.equal(archived?.isArchived, true)
  assert.equal(archived?.balanceCents, -2_500, 'the history still adds up')
  assert.equal(listTransactions(db, USER_ID).length, 1)
})

test('a CSV row whose sign contradicts its kind is reported, not written', () => {
  const db = freshDb()
  account(db, 'Chequing')

  const result = mergeEntries(db, USER_ID, [
    {
      line: 2,
      occurredOn: '2026-03-04',
      accountName: 'Chequing',
      institution: null,
      kind: 'expense',
      category: 'Misc',
      memo: 'wrong way round',
      amountCents: 9_900
    },
    {
      line: 3,
      occurredOn: '2026-03-05',
      accountName: 'Chequing',
      institution: null,
      kind: 'expense',
      category: 'Misc',
      memo: 'fine',
      amountCents: -9_900
    }
  ])

  assert.equal(result.added, 1)
  assert.equal(result.issues.length, 1)
  assert.match(result.issues[0]?.message ?? '', /row 2: An expense must be a negative amount/)
})

test('an archived goal gets no slice of a paycheck', () => {
  const db = freshDb()
  const chequing = account(db, 'Chequing')
  const goalId = createGoal(db, USER_ID, {
    name: 'New laptop',
    targetCents: 200_000,
    targetDate: null,
    priority: 1,
    color: '#38BDF8',
    accountId: null,
    isEmergency: false
  })
  db.prepare('UPDATE goals SET is_archived = 1 WHERE id = ?').run(goalId)

  const { plan } = commitPaycheck(db, USER_ID, {
    incomeCents: 400_000,
    receivedOn: '2026-03-15',
    source: 'Paycheck',
    depositAccountId: chequing,
    payCadence: 'semimonthly',
    splits: { savingsPercent: 0, investmentPercent: 0, goalsPercent: 0, debtPercent: 0 },
    wholeDollarBuckets: false
  })

  assert.equal(plan.goalFundings.length, 0)
  assert.equal(getSnapshot(db, USER_ID).goals[0]?.fundedCents, 0)
})

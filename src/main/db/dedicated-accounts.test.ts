import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import test from 'node:test'
import { migrate } from './migrations'
import {
  createAccount,
  createGoal,
  deleteGoal,
  insertPaycheckRecord,
  listAccounts,
  listGoals,
  updateAccount
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

function goal(db: Database.Database, name = 'Emergency fund', targetCents = 600_000): string {
  return createGoal(db, USER_ID, {
    name,
    targetCents,
    targetDate: null,
    priority: 1,
    color: '#38BDF8',
    accountId: null,
    isEmergency: false
  })
}

/** Routes a paycheck so the goal has a real allocation total to be replaced. */
function allocate(db: Database.Database, goalId: string, cents: number): void {
  insertPaycheckRecord(db, USER_ID, {
    incomeCents: cents,
    receivedOn: '2026-02-15',
    source: 'Paycheck',
    depositAccountId: null,
    priorityCents: 0,
    surplusCents: 0,
    leisureCents: 0,
    health: 'covered',
    recordIncome: false,
    allocations: [{ bucket: 'goal', goalId, label: 'Funded', amountCents: cents }]
  })
}

test('a dedicated account and its Safe-to-spend choice round-trip', () => {
  const db = freshDb()
  const goalId = goal(db)
  const accountId = createAccount(db, USER_ID, {
    name: 'Emergency Savings',
    kind: 'savings',
    institution: 'Tangerine',
    startingBalanceCents: 250_000,
    creditLimitCents: null,
    dedicatedGoalId: goalId,
    inSafeToSpend: false
  })

  const [account] = listAccounts(db, USER_ID).filter((item) => item.id === accountId)
  assert.equal(account.dedicatedGoalId, goalId)
  assert.equal(account.inSafeToSpend, false)

  updateAccount(db, USER_ID, accountId, { inSafeToSpend: null })
  const [cleared] = listAccounts(db, USER_ID).filter((item) => item.id === accountId)
  assert.equal(cleared.inSafeToSpend, null, 'null means follow the account type again')

  updateAccount(db, USER_ID, accountId, { dedicatedGoalId: null })
  const [detached] = listAccounts(db, USER_ID).filter((item) => item.id === accountId)
  assert.equal(detached.dedicatedGoalId, null)
})

test('pointing an account at a goal that does not exist is refused', () => {
  const db = freshDb()
  assert.throws(
    () =>
      createAccount(db, USER_ID, {
        name: 'Future House',
        kind: 'savings',
        institution: '',
        startingBalanceCents: 0,
        dedicatedGoalId: 'no-such-goal'
      }),
    /Goal not found/
  )
})

test('a dedicated account’s balance is the progress, replacing allocations', () => {
  const db = freshDb()
  const goalId = goal(db, 'Emergency fund', 600_000)
  allocate(db, goalId, 100_000)

  let [recorded] = listGoals(db, USER_ID)
  assert.equal(recorded.fundedFrom, 'allocations')
  assert.equal(recorded.fundedCents, 100_000)

  createAccount(db, USER_ID, {
    name: 'Emergency Savings',
    kind: 'savings',
    institution: '',
    startingBalanceCents: 420_000,
    dedicatedGoalId: goalId
  })

  ;[recorded] = listGoals(db, USER_ID)
  assert.equal(recorded.fundedFrom, 'account')
  assert.equal(recorded.fundedCents, 420_000, 'the routed total is replaced, not added to')
  assert.deepEqual(recorded.dedicatedAccountNames, ['Emergency Savings'])
  assert.equal(recorded.remainingCents, 180_000)
})

test('an overdraft in a dedicated account reads as zero progress', () => {
  const db = freshDb()
  const goalId = goal(db)
  createAccount(db, USER_ID, {
    name: 'Future House',
    kind: 'savings',
    institution: '',
    startingBalanceCents: -15_000,
    dedicatedGoalId: goalId
  })

  const [tracked] = listGoals(db, USER_ID)
  assert.equal(tracked.fundedFrom, 'account')
  assert.equal(tracked.fundedCents, 0)
})

test('archiving the dedicated account hands progress back to the allocations', () => {
  const db = freshDb()
  const goalId = goal(db)
  allocate(db, goalId, 100_000)
  const accountId = createAccount(db, USER_ID, {
    name: 'Emergency Savings',
    kind: 'savings',
    institution: '',
    startingBalanceCents: 420_000,
    dedicatedGoalId: goalId
  })
  db.prepare('UPDATE accounts SET is_archived = 1 WHERE id = ?').run(accountId)

  const [released] = listGoals(db, USER_ID)
  assert.equal(released.fundedFrom, 'allocations')
  assert.equal(released.fundedCents, 100_000)
})

test('removing a goal detaches every account dedicated to it', () => {
  const db = freshDb()
  const goalId = goal(db)
  const accountId = createAccount(db, USER_ID, {
    name: 'Emergency Savings',
    kind: 'savings',
    institution: '',
    startingBalanceCents: 10_000,
    dedicatedGoalId: goalId
  })

  deleteGoal(db, USER_ID, goalId)

  const [orphan] = listAccounts(db, USER_ID).filter((item) => item.id === accountId)
  assert.equal(orphan.dedicatedGoalId, null, 'no account may point at a removed goal')
  assert.equal(listGoals(db, USER_ID).length, 0)
})

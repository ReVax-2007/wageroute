import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import test from 'node:test'
import { RepositoryError } from '@shared/errors'
import type { Allocation } from '@shared/types'
import { migrate } from './migrations'
import {
  applyPaycheckPlan,
  commitPaycheck,
  createAccount,
  createBill,
  createGoal,
  createTransaction,
  listBillPaymentsThisMonth,
  listPaychecks,
  listTransactions
} from './repositories'

const USER_ID = '11111111-2222-3333-4444-555555555555'
const DRAFT_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

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
  kind: 'checking' | 'savings' | 'credit' | 'investment'
): string {
  return createAccount(db, USER_ID, {
    name,
    kind,
    institution: '',
    startingBalanceCents: 0,
    creditLimitCents: kind === 'credit' ? 1_000_000 : null
  })
}

interface SplitSplits {
  savingsPercent: number
  investmentPercent: number
  goalsPercent: number
  debtPercent: number
}

function splits(percent: Partial<SplitSplits> = {}): SplitSplits {
  return {
    savingsPercent: 0,
    investmentPercent: 0,
    goalsPercent: 0,
    debtPercent: 0,
    ...percent
  }
}

function route(
  db: Database.Database,
  depositAccountId: string,
  receivedOn: string,
  options: {
    incomeCents?: number
    splits?: SplitSplits
    draftId?: string
    allowDuplicate?: boolean
  } = {}
) {
  return commitPaycheck(db, USER_ID, {
    incomeCents: options.incomeCents ?? 500_000,
    receivedOn,
    source: 'Paycheck',
    depositAccountId,
    payCadence: 'semimonthly',
    splits: options.splits ?? splits(),
    wholeDollarBuckets: false,
    draftId: options.draftId,
    allowDuplicate: options.allowDuplicate
  })
}

function errorCode(run: () => unknown): string {
  try {
    run()
  } catch (error) {
    if (error instanceof RepositoryError) return error.code
    throw error
  }
  throw new Error('expected the call to throw')
}

function allocationOf(db: Database.Database, bucket: Allocation['bucket']): Allocation {
  const [paycheck] = listPaychecks(db, USER_ID)
  const allocation = paycheck.allocations.find((line) => line.bucket === bucket)
  assert.ok(allocation, `expected a ${bucket} allocation`)
  return allocation
}

test('a retried draft id returns the first paycheck instead of writing a second', () => {
  const db = freshDb()
  const checking = account(db, 'Chequing', 'checking')

  const first = route(db, checking, '2026-03-05', { draftId: DRAFT_ID })
  const retry = route(db, checking, '2026-03-05', { draftId: DRAFT_ID })

  assert.equal(first.paycheckId, DRAFT_ID)
  assert.equal(retry.paycheckId, DRAFT_ID)
  assert.equal(retry.plan, null)
  assert.equal(retry.alreadyCommitted, true)
  assert.equal(listPaychecks(db, USER_ID).length, 1)
  assert.equal(listTransactions(db, USER_ID).length, 1, 'income posted once')
})

test('a second deposit on the same day needs the duplicate flag', () => {
  const db = freshDb()
  const checking = account(db, 'Chequing', 'checking')
  route(db, checking, '2026-03-05')

  assert.equal(
    errorCode(() => route(db, checking, '2026-03-05', { incomeCents: 700_000 })),
    'CONFLICT'
  )
  route(db, checking, '2026-03-05', { incomeCents: 700_000, allowDuplicate: true })
  assert.equal(listPaychecks(db, USER_ID).length, 2)
})

test('the same amount within three days is refused, beyond it is allowed', () => {
  const db = freshDb()
  const checking = account(db, 'Chequing', 'checking')
  route(db, checking, '2026-03-05')

  assert.equal(
    errorCode(() => route(db, checking, '2026-03-08')),
    'CONFLICT',
    'three days after is inside the window'
  )
  route(db, checking, '2026-03-09')
  assert.equal(listPaychecks(db, USER_ID).length, 2, 'four days after is a new deposit')
})

test('a bill already paid this month is not withheld again', () => {
  const db = freshDb()
  const checking = account(db, 'Chequing', 'checking')
  const rent = createBill(db, USER_ID, {
    name: 'Rent',
    amountCents: 120_000,
    frequency: 'monthly',
    dueDay: 15,
    category: 'Housing',
    accountId: checking,
    autopay: false,
    isActive: true,
    nextDueOn: null
  })
  createTransaction(db, USER_ID, {
    accountId: checking,
    kind: 'bill_payment',
    amountCents: -120_000,
    occurredOn: '2026-03-02',
    memo: 'Rent',
    category: 'Housing',
    billId: rent
  })

  const committed = route(db, checking, '2026-03-05')

  assert.equal(
    committed.plan?.priorityFundedCents,
    0,
    'the wall is already paid, so this check has nothing to hold back for it'
  )
  assert.equal(committed.plan?.leisureCents, 500_000)
})

test('a partly paid bill is only withheld for what is still owed', () => {
  const db = freshDb()
  const checking = account(db, 'Chequing', 'checking')
  const rent = createBill(db, USER_ID, {
    name: 'Rent',
    amountCents: 120_000,
    frequency: 'monthly',
    dueDay: 15,
    category: 'Housing',
    accountId: checking,
    autopay: false,
    isActive: true,
    nextDueOn: null
  })
  createTransaction(db, USER_ID, {
    accountId: checking,
    kind: 'bill_payment',
    amountCents: -30_000,
    occurredOn: '2026-03-02',
    memo: 'Rent part',
    category: 'Housing',
    billId: rent
  })

  const committed = route(db, checking, '2026-03-05')

  assert.equal(
    committed.plan?.priorityFundedCents,
    45_000,
    'half of the remaining 90,000 falls on this check'
  )
})

test('a payment made in another month does not release this month', () => {
  const db = freshDb()
  const checking = account(db, 'Chequing', 'checking')
  const rent = createBill(db, USER_ID, {
    name: 'Rent',
    amountCents: 120_000,
    frequency: 'monthly',
    dueDay: 15,
    category: 'Housing',
    accountId: checking,
    autopay: false,
    isActive: true,
    nextDueOn: null
  })
  createTransaction(db, USER_ID, {
    accountId: checking,
    kind: 'bill_payment',
    amountCents: -120_000,
    occurredOn: '2026-02-02',
    memo: 'February rent',
    category: 'Housing',
    billId: rent
  })

  // The routing preview asks by the pay date's month, so the query must keep
  // the two months apart instead of releasing a wall February already paid.
  assert.deepEqual(listBillPaymentsThisMonth(db, USER_ID, '2026-03'), [])
  assert.deepEqual(listBillPaymentsThisMonth(db, USER_ID, '2026-02'), [
    { billId: rent, paidCents: 120_000, creditCents: 0 }
  ])

  const committed = route(db, checking, '2026-03-05')
  assert.equal(
    committed.plan?.priorityFundedCents,
    60_000,
    'March still owes the full wall, half of it on this cheque'
  )
})

test('applying a plan posts one paired transfer per line', () => {
  const db = freshDb()
  const checking = account(db, 'Chequing', 'checking')
  const savings = account(db, 'Savings', 'savings')
  const routed = route(db, checking, '2026-03-05', {
    splits: splits({ savingsPercent: 20 })
  })
  const line = allocationOf(db, 'savings')

  const applied = applyPaycheckPlan(db, USER_ID, routed.paycheckId, [
    { allocationId: line.id, accountId: savings }
  ])

  assert.equal(applied.transfers, 1)
  assert.equal(applied.movedCents, line.amountCents)
  assert.deepEqual(applied.alreadyMoved, [])

  const legs = listTransactions(db, USER_ID).filter((entry) => entry.transferGroupId)
  assert.equal(legs.length, 2, 'a transfer has two legs')
  const out = legs.find((entry) => entry.accountId === checking)
  const into = legs.find((entry) => entry.accountId === savings)
  assert.ok(out && into)
  assert.equal(out.amountCents, -line.amountCents)
  assert.equal(into.amountCents, line.amountCents)
  assert.equal(out.transferGroupId, into.transferGroupId)
  assert.equal(out.paycheckId, routed.paycheckId, 'the transfer settles this paycheck')
})

test('applying the same plan twice moves nothing the second time', () => {
  const db = freshDb()
  const checking = account(db, 'Chequing', 'checking')
  const savings = account(db, 'Savings', 'savings')
  const routed = route(db, checking, '2026-03-05', {
    splits: splits({ savingsPercent: 20 })
  })
  const line = allocationOf(db, 'savings')
  const targets = [{ allocationId: line.id, accountId: savings }]

  applyPaycheckPlan(db, USER_ID, routed.paycheckId, targets)
  const again = applyPaycheckPlan(db, USER_ID, routed.paycheckId, targets)

  assert.equal(again.transfers, 0)
  assert.equal(again.movedCents, 0)
  assert.deepEqual(again.alreadyMoved, ['Savings'])
  assert.equal(
    listTransactions(db, USER_ID).filter((entry) => entry.transferGroupId).length,
    2,
    'the first pair is still the only pair'
  )
})

test('a later press moves only the lines that have not moved yet', () => {
  const db = freshDb()
  const checking = account(db, 'Chequing', 'checking')
  const savings = account(db, 'Savings', 'savings')
  const investment = account(db, 'Brokerage', 'investment')
  const routed = route(db, checking, '2026-03-05', {
    splits: splits({ savingsPercent: 10, investmentPercent: 10 })
  })
  const savingsLine = allocationOf(db, 'savings')
  const investmentLine = allocationOf(db, 'investment')

  applyPaycheckPlan(db, USER_ID, routed.paycheckId, [
    { allocationId: savingsLine.id, accountId: savings }
  ])
  const second = applyPaycheckPlan(db, USER_ID, routed.paycheckId, [
    { allocationId: savingsLine.id, accountId: savings },
    { allocationId: investmentLine.id, accountId: investment }
  ])

  assert.equal(second.transfers, 1)
  assert.equal(second.movedCents, investmentLine.amountCents)
  assert.deepEqual(second.alreadyMoved, ['Savings'])
})

test('a savings share cannot land in a checking account', () => {
  const db = freshDb()
  const checking = account(db, 'Chequing', 'checking')
  const routed = route(db, checking, '2026-03-05', {
    splits: splits({ savingsPercent: 20 })
  })
  const line = allocationOf(db, 'savings')

  assert.equal(
    errorCode(() =>
      applyPaycheckPlan(db, USER_ID, routed.paycheckId, [
        { allocationId: line.id, accountId: checking }
      ])
    ),
    'VALIDATION'
  )
  assert.equal(
    listTransactions(db, USER_ID).filter((entry) => entry.transferGroupId).length,
    0,
    'nothing is written when one line is invalid'
  )
})

test('a goal share can only move into that goal’s own account', () => {
  const db = freshDb()
  const checking = account(db, 'Chequing', 'checking')
  const goalId = createGoal(db, USER_ID, {
    name: 'New laptop',
    targetCents: 200_000,
    targetDate: null,
    priority: 1,
    color: '#38BDF8',
    accountId: null
  })
  const routed = route(db, checking, '2026-03-05', {
    splits: splits({ goalsPercent: 20 })
  })
  const line = allocationOf(db, 'goal')
  assert.equal(line.goalId, goalId)

  assert.equal(
    errorCode(() =>
      applyPaycheckPlan(db, USER_ID, routed.paycheckId, [
        { allocationId: line.id, accountId: checking }
      ])
    ),
    'VALIDATION'
  )

  const laptopAccount = createAccount(db, USER_ID, {
    name: 'Laptop fund',
    kind: 'savings',
    institution: '',
    startingBalanceCents: 0,
    dedicatedGoalId: goalId
  })
  const applied = applyPaycheckPlan(db, USER_ID, routed.paycheckId, [
    { allocationId: line.id, accountId: laptopAccount }
  ])
  assert.equal(applied.transfers, 1)
})

test('a plan line without a matching account kind is refused before writing', () => {
  const db = freshDb()
  const checking = account(db, 'Chequing', 'checking')
  const routed = route(db, checking, '2026-03-05', {
    splits: splits({ debtPercent: 10 })
  })
  const line = allocationOf(db, 'debt')

  assert.equal(
    errorCode(() =>
      applyPaycheckPlan(db, USER_ID, routed.paycheckId, [
        { allocationId: line.id, accountId: checking }
      ])
    ),
    'VALIDATION'
  )
})

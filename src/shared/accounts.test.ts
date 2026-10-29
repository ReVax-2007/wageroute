import assert from 'node:assert/strict'
import test from 'node:test'
import { buildAllocationPlan } from './allocator'
import {
  countsInSafeToSpend,
  poolEarmarkedGoalsCents,
  safeToSpendPoolCents,
  totalWealthCents,
  wealthBuckets
} from './accounts'
import type { AllocatorGoal, AllocationPlan } from './allocator'
import type { AccountKind, AccountWithBalance, GoalWithProgress } from './types'

function allocated(plan: AllocationPlan): number {
  return (
    plan.priorityFundedCents +
    plan.savingsCents +
    plan.investmentCents +
    plan.goalsCents +
    plan.debtCents +
    plan.leisureCents
  )
}

function account(overrides: Partial<AccountWithBalance> = {}): AccountWithBalance {
  return {
    id: 'acc-1',
    userId: 'user-1',
    name: 'Everyday Chequing',
    kind: 'checking',
    institution: 'Tangerine',
    startingBalanceCents: 0,
    creditLimitCents: null,
    color: null,
    isArchived: false,
    sortOrder: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    deletedAt: null,
    revision: 1,
    dedicatedGoalId: null,
    inSafeToSpend: null,
    balanceCents: 100_00,
    ...overrides
  }
}

function kindAccount(kind: AccountKind): AccountWithBalance {
  return account({ id: `acc-${kind}`, kind, name: kind })
}

function goal(overrides: Partial<GoalWithProgress> = {}): GoalWithProgress {
  return {
    id: 'goal-1',
    userId: 'user-1',
    name: 'Emergency Savings',
    targetCents: 500_00,
    targetDate: null,
    priority: 1,
    color: '#888888',
    accountId: null,
    isEmergency: false,
    isArchived: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    deletedAt: null,
    revision: 1,
    fundedCents: 0,
    remainingCents: 500_00,
    fundedFrom: 'allocations',
    dedicatedAccounts: [],
    ...overrides
  }
}

test('goal money already outside the pool is not deducted from it again', () => {
  const dedicated = goal({ id: 'goal-acc', fundedCents: 420_00, fundedFrom: 'account' })
  const enveloped = goal({ id: 'goal-env', fundedCents: 30_00, fundedFrom: 'allocations' })
  assert.equal(poolEarmarkedGoalsCents([dedicated, enveloped]), 30_00)
  const pool = safeToSpendPoolCents([account({ balanceCents: 120_00 })])
  assert.equal(pool - poolEarmarkedGoalsCents([dedicated, enveloped]), 90_00)
})

test('an explicit Safe-to-spend choice beats the kind default', () => {
  assert.equal(countsInSafeToSpend(kindAccount('checking')), true)
  assert.equal(countsInSafeToSpend(kindAccount('investment')), false)
  assert.equal(countsInSafeToSpend(kindAccount('credit')), false)
  assert.equal(countsInSafeToSpend(account({ kind: 'investment', inSafeToSpend: true })), true)
  assert.equal(countsInSafeToSpend(account({ kind: 'cash', inSafeToSpend: false })), false)
})

test('a dedicated account is spendable money twice over unless the user says so', () => {
  const dedicated = account({ dedicatedGoalId: 'goal-1' })
  assert.equal(countsInSafeToSpend(dedicated), false)
  assert.equal(countsInSafeToSpend(account({ dedicatedGoalId: 'goal-1', inSafeToSpend: true })), true)
})

test('archived accounts count for nothing', () => {
  const archived = account({ isArchived: true, inSafeToSpend: true })
  assert.equal(countsInSafeToSpend(archived), false)
  assert.equal(totalWealthCents([archived]), 0)
})

test('the Safe-to-spend pool is the chosen accounts, not all cash', () => {
  const accounts = [
    account({ id: 'a', kind: 'checking', balanceCents: 50_000 }),
    account({ id: 'b', kind: 'savings', balanceCents: 30_000, inSafeToSpend: false }),
    account({ id: 'c', kind: 'investment', balanceCents: 90_000, inSafeToSpend: true }),
    account({ id: 'd', kind: 'credit', balanceCents: -12_000 })
  ]
  assert.equal(safeToSpendPoolCents(accounts), 140_000)
})

test('credit balances subtract from total wealth', () => {
  const accounts = [
    account({ id: 'a', kind: 'checking', balanceCents: 50_000 }),
    account({ id: 'b', kind: 'investment', balanceCents: 90_000 }),
    account({ id: 'c', kind: 'credit', balanceCents: -12_000 })
  ]
  assert.equal(totalWealthCents(accounts), 128_000)
})

test('wealth buckets partition the total, so no cent is counted twice', () => {
  const accounts = [
    account({ id: 'a', kind: 'checking', balanceCents: 50_000 }),
    account({ id: 'b', kind: 'cash', balanceCents: 5_000 }),
    account({ id: 'c', kind: 'savings', balanceCents: 20_000, dedicatedGoalId: 'goal-1' }),
    account({ id: 'd', kind: 'investment', balanceCents: 90_000 }),
    account({ id: 'e', kind: 'credit', balanceCents: -12_000 })
  ]
  const split = wealthBuckets(accounts)
  assert.deepEqual(
    split.map((bucket) => bucket.label),
    ['Cash', 'Saved for goals', 'Invested', 'Credit owed']
  )
  assert.equal(
    split.reduce((total, bucket) => total + bucket.cents, 0),
    totalWealthCents(accounts)
  )
})

function allocatableGoal(overrides: Partial<AllocatorGoal> = {}): AllocatorGoal {
  return {
    id: 'goal-2',
    name: 'Dentist',
    targetCents: 30_000,
    fundedCents: 0,
    priority: 2,
    targetDate: null,
    ...overrides
  }
}

function plan(goals: AllocatorGoal[]): AllocationPlan {
  return buildAllocationPlan({
    incomeCents: 100_000,
    payCadence: 'biweekly',
    bills: [],
    goals,
    splits: { savingsPercent: 0, investmentPercent: 0, goalsPercent: 50, debtPercent: 0 }
  })
}

test('a goal funded by a dedicated account is left out of paycheck routing', () => {
  const dedicated = allocatableGoal({
    id: 'goal-1',
    name: 'Emergency Fund',
    targetCents: 50_000,
    fundedCents: 20_000,
    priority: 1,
    fundedFrom: 'account'
  })
  const result = plan([dedicated, allocatableGoal()])

  assert.deepEqual(
    result.goalFundings.map((funding) => funding.goalId),
    ['goal-2']
  )
  assert.equal(result.goalsCents, 30_000)
  assert.equal(result.savingsCents, 20_000)
  assert.equal(allocated(result), result.incomeCents)
})

test('when every goal has its own account the goal budget falls through to savings', () => {
  const result = plan([allocatableGoal({ id: 'goal-1', fundedFrom: 'account' })])

  assert.deepEqual(result.goalFundings, [])
  assert.equal(result.goalsCents, 0)
  assert.ok(result.warnings.some((warning) => warning.code === 'no_goals'))
  assert.equal(allocated(result), result.incomeCents)
})

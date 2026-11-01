import assert from 'node:assert/strict'
import test from 'node:test'
import { buildAllocationPlan } from './allocator'
import {
  countsInSafeToSpend,
  poolEarmarkedGoalsCents,
  safeToSpendPoolCents,
  totalWealthCents,
  unsettledRoutingCents,
  wealthBuckets
} from './accounts'
import type { AllocatorGoal, AllocationPlan } from './allocator'
import type {
  AccountKind,
  AccountWithBalance,
  AllocationBucket,
  GoalWithProgress,
  PaycheckWithAllocations,
  TransactionRow
} from './types'

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
  const balanceCents = overrides.balanceCents ?? 100_00
  return {
    id: 'acc-1',
    userId: 'user-1',
    name: 'Everyday Chequing',
    kind: 'checking',
    institution: 'Tangerine',
    startingBalanceCents: 0,
    creditLimitCents: null,
    aprBps: null,
    minimumPaymentCents: null,
    statementDay: null,
    paymentDueDay: null,
    lastStatementBalanceCents: null,
    color: null,
    isArchived: false,
    sortOrder: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    deletedAt: null,
    revision: 1,
    dedicatedGoalId: null,
    inSafeToSpend: null,
    // Nothing in these fixtures is dated in the future, so settled cash and the
    // ledger balance agree unless a test says otherwise.
    cashCents: balanceCents,
    ...overrides,
    balanceCents
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

test('a dedicated account is excluded unless explicitly opted in', () => {
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

function paycheck(
  receivedOn: string,
  buckets: Partial<Record<AllocationBucket, number>>
): PaycheckWithAllocations {
  return {
    id: `pay-${receivedOn}`,
    userId: 'user-1',
    amountCents: 150_000,
    receivedOn,
    source: 'Employer',
    depositAccountId: 'acc-1',
    priorityCents: 21_313,
    surplusCents: 128_687,
    leisureCents: 12_869,
    health: 'covered',
    createdAt: `${receivedOn}T00:00:00.000Z`,
    updatedAt: `${receivedOn}T00:00:00.000Z`,
    deletedAt: null,
    revision: 1,
    allocations: Object.entries(buckets).map(([bucket, cents], index) => ({
      id: `alloc-${receivedOn}-${index}`,
      userId: 'user-1',
      paycheckId: `pay-${receivedOn}`,
      bucket: bucket as AllocationBucket,
      goalId: null,
      label: bucket,
      amountCents: cents ?? 0,
      createdAt: `${receivedOn}T00:00:00.000Z`,
      updatedAt: `${receivedOn}T00:00:00.000Z`,
      deletedAt: null,
      revision: 1
    }))
  }
}

function entry(
  accountId: string,
  occurredOn: string,
  amountCents: number
): TransactionRow {
  return {
    id: `tx-${accountId}-${occurredOn}-${amountCents}`,
    userId: 'user-1',
    accountId,
    kind: 'transfer',
    amountCents,
    occurredOn,
    memo: '',
    category: 'Transfer',
    categoryId: null,
    externalId: null,
    billId: null,
    goalId: null,
    paycheckId: null,
    counterAccountId: null,
    transferGroupId: null,
    createdAt: `${occurredOn}T00:00:00.000Z`,
    updatedAt: `${occurredOn}T00:00:00.000Z`,
    deletedAt: null,
    revision: 1,
    accountName: accountId,
    accountInstitution: null
  }
}

test('routed debt and investing leave Safe to Spend until the money actually moves', () => {
  const accounts = [
    account({ id: 'chequing', kind: 'checking' }),
    account({ id: 'card', kind: 'credit' }),
    account({ id: 'broker', kind: 'investment' })
  ]
  const routed = paycheck('2026-11-02', { debt: 115_800, investment: 40_000 })
  const today = '2026-11-10'

  assert.equal(
    unsettledRoutingCents({ paychecks: [routed], transactions: [], accounts, todayISO: today }),
    155_800,
    'nothing has moved yet'
  )

  const paid = [
    entry('card', '2026-11-04', 115_800),
    entry('broker', '2026-11-05', 10_000)
  ]
  assert.equal(
    unsettledRoutingCents({ paychecks: [routed], transactions: paid, accounts, todayISO: today }),
    30_000,
    'the card payment settles debt; only the unmoved investment remains'
  )
})

test('money moved before the paycheque does not settle this cycle', () => {
  const accounts = [
    account({ id: 'chequing', kind: 'checking' }),
    account({ id: 'card', kind: 'credit' })
  ]
  const moved = [entry('card', '2026-10-28', 115_800)]
  assert.equal(
    unsettledRoutingCents({
      paychecks: [paycheck('2026-11-02', { debt: 115_800 })],
      transactions: moved,
      accounts,
      todayISO: '2026-11-10'
    }),
    115_800
  )
})

test('last month’s routing is not deducted from this month', () => {
  assert.equal(
    unsettledRoutingCents({
      paychecks: [paycheck('2026-10-16', { debt: 115_800 })],
      transactions: [],
      accounts: [account({ id: 'chequing', kind: 'checking' })],
      todayISO: '2026-11-10'
    }),
    0
  )
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
  assert.ok(result.warnings.some((warning) => warning.code === 'goals_account_funded'))
  assert.equal(allocated(result), result.incomeCents)
})

test('saving everything is not the same as running short', () => {
  const result = buildAllocationPlan({
    incomeCents: 100_000,
    payCadence: 'monthly',
    bills: [{ id: 'rent', name: 'Rent', amountCents: 50_000, frequency: 'monthly' }],
    goals: [],
    splits: { savingsPercent: 100, investmentPercent: 0, goalsPercent: 0, debtPercent: 0 }
  })
  assert.equal(result.leisureCents, 0)
  assert.equal(result.health, 'covered', 'a deliberate saver is funded, not tight')
})

test('a paycheck swallowed whole by bills is tight, and one that cannot cover them is a shortfall', () => {
  const tight = buildAllocationPlan({
    incomeCents: 100_000,
    payCadence: 'monthly',
    bills: [{ id: 'rent', name: 'Rent', amountCents: 100_000, frequency: 'monthly' }],
    goals: [],
    splits: { savingsPercent: 0, investmentPercent: 0, goalsPercent: 0, debtPercent: 0 }
  })
  assert.equal(tight.health, 'tight')
  assert.ok(tight.warnings.some((warning) => warning.code === 'tight_margin'))

  const short = buildAllocationPlan({
    incomeCents: 100_000,
    payCadence: 'monthly',
    bills: [{ id: 'rent', name: 'Rent', amountCents: 150_000, frequency: 'monthly' }],
    goals: [],
    splits: { savingsPercent: 0, investmentPercent: 0, goalsPercent: 0, debtPercent: 0 }
  })
  assert.equal(short.health, 'shortfall')
  assert.equal(short.shortfallCents, 50_000)
  assert.ok(short.warnings.some((warning) => warning.code === 'shortfall'))
})

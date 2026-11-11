import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  AccountWithBalance,
  Bill,
  BillPaymentTotal,
  GoalWithProgress,
  Snapshot
} from '@shared/types'
import {
  selectCashOnHandCents,
  selectFundedGoalsCents,
  selectMonthlyWallCents,
  selectPoolEarmarkedGoalsCents,
  selectSafeToSpendCents,
  selectSafeToSpendPoolCents,
  selectTotalWealthCents,
  selectUnpaidWallCents
} from './selectors'

function snapshotWith(payments: BillPaymentTotal[]): { snapshot: Snapshot } {
  return {
    snapshot: {
      bills: [
        {
          id: 'rent',
          name: 'Rent',
          amountCents: 120_000,
          frequency: 'monthly',
          isActive: true
        }
      ],
      billPaymentsThisMonth: payments
    } as unknown as Snapshot
  }
}

test('an unpaid bill stays on the wall', () => {
  assert.equal(selectUnpaidWallCents(snapshotWith([])), 120_000)
})

test('a bill paid from a spendable account releases its part of the wall', () => {
  assert.equal(
    selectUnpaidWallCents(
      snapshotWith([{ billId: 'rent', paidCents: 120_000, creditCents: 0 }])
    ),
    0
  )
})

test('a bill paid on a credit card stays withheld: the pool never fell', () => {
  assert.equal(
    selectUnpaidWallCents(
      snapshotWith([{ billId: 'rent', paidCents: 120_000, creditCents: 120_000 }])
    ),
    120_000
  )
})

test('only the card-funded part stays withheld when a bill is paid from both', () => {
  assert.equal(
    selectUnpaidWallCents(
      snapshotWith([{ billId: 'rent', paidCents: 120_000, creditCents: 60_000 }])
    ),
    60_000
  )
})

function accountRow(
  id: string,
  kind: AccountWithBalance['kind'],
  balanceCents: number,
  overrides: Partial<AccountWithBalance> = {}
): AccountWithBalance {
  return {
    id,
    userId: 'user',
    name: id,
    kind,
    institution: null,
    startingBalanceCents: 0,
    balanceCents,
    cashCents: balanceCents,
    creditLimitCents: null,
    color: null,
    dedicatedGoalId: null,
    inSafeToSpend: null,
    isArchived: false,
    isLocked: false,
    floorCents: null,
    sortOrder: 0,
    aprBps: null,
    minimumPaymentCents: null,
    statementDay: null,
    paymentDueDay: null,
    lastStatementBalanceCents: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    deletedAt: null,
    revision: 1,
    ...overrides
  }
}

function goalRow(
  id: string,
  fundedCents: number,
  overrides: Partial<GoalWithProgress> = {}
): GoalWithProgress {
  return {
    id,
    userId: 'user',
    name: id,
    targetCents: 100_000,
    targetDate: null,
    priority: 1,
    color: 'var(--savings)',
    accountId: null,
    isEmergency: false,
    isArchived: false,
    fundingPace: 'asap',
    fundedCents,
    remainingCents: 0,
    fundedFrom: 'allocations',
    dedicatedAccounts: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    deletedAt: null,
    revision: 1,
    ...overrides
  }
}

test('every headline selector is zero without a snapshot', () => {
  const empty = { snapshot: null }
  assert.equal(selectCashOnHandCents(empty), 0)
  assert.equal(selectTotalWealthCents(empty), 0)
  assert.equal(selectSafeToSpendPoolCents(empty), 0)
  assert.equal(selectMonthlyWallCents(empty), 0)
  assert.equal(selectUnpaidWallCents(empty), 0)
  assert.equal(selectFundedGoalsCents(empty), 0)
  assert.equal(selectPoolEarmarkedGoalsCents(empty), 0)
  assert.equal(selectSafeToSpendCents(empty), 0)
})

test('wealth counts every live account while the pool counts only spendable cash', () => {
  const state = {
    snapshot: {
      accounts: [
        accountRow('chequing', 'checking', 250_000),
        accountRow('card', 'credit', -40_000),
        accountRow('brokerage', 'investment', 900_000),
        accountRow('old', 'checking', 50_000, { isArchived: true }),
        accountRow('earmarked', 'savings', 80_000, { dedicatedGoalId: 'trip' }),
        accountRow('excluded', 'cash', 30_000, { inSafeToSpend: false })
      ],
      bills: [],
      goals: [],
      transactions: [],
      paychecks: [],
      billPaymentsThisMonth: []
    } as unknown as Snapshot
  }
  assert.equal(selectTotalWealthCents(state), 1_220_000, 'credit subtracts, archived is out')
  assert.equal(selectCashOnHandCents(state), 360_000, 'cash kinds only, archived out')
  assert.equal(
    selectSafeToSpendPoolCents(state),
    250_000,
    'a dedicated account and a manually excluded one never join the pool'
  )
})

test('safe to spend subtracts the unpaid wall, earmarked goals and unsettled routing', () => {
  const bills = [
    {
      id: 'rent',
      name: 'Rent',
      amountCents: 120_000,
      frequency: 'monthly',
      isActive: true
    } as Bill
  ]
  const goals = [
    goalRow('trip', 20_000),
    goalRow('car', 80_000, { fundedFrom: 'account' }),
    goalRow('old', 5_000, { isArchived: true })
  ]
  const state = {
    snapshot: {
      accounts: [
        accountRow('chequing', 'checking', 100_000),
        accountRow('card', 'credit', -10_000),
        accountRow('car-fund', 'savings', 80_000, { dedicatedGoalId: 'car' })
      ],
      bills,
      goals,
      transactions: [],
      paychecks: [],
      billPaymentsThisMonth: []
    } as unknown as Snapshot
  }

  assert.equal(selectMonthlyWallCents(state), 120_000)
  assert.equal(selectFundedGoalsCents(state), 100_000, 'archived goals are not progress')
  assert.equal(selectPoolEarmarkedGoalsCents(state), 20_000, 'an account-funded goal is not deducted')
  assert.equal(selectSafeToSpendCents(state), -40_000, '100,000 - 120,000 - 20,000')
})

test('a paid bill leaves the withheld wall, a credit-paid one does not', () => {
  const state = snapshotWith([{ billId: 'rent', paidCents: 120_000, creditCents: 0 }])
  assert.equal(selectUnpaidWallCents(state), 0)
  assert.equal(
    selectUnpaidWallCents(
      snapshotWith([{ billId: 'rent', paidCents: 120_000, creditCents: 120_000 }])
    ),
    120_000
  )
})

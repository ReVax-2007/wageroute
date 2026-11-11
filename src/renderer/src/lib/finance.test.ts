import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  AccountWithBalance,
  Bill,
  GoalWithProgress,
  PaycheckWithAllocations
} from '@shared/types'
import {
  accountDisplayBalanceCents,
  cashOnHand,
  creditAvailableCents,
  creditOwedCents,
  activeBills,
  fundableAccounts,
  goalsSummary,
  monthRoutingBreakdown,
  monthlyWall,
  ordinal,
  perPaycheckWall,
  retypeChoices,
  upcomingPayments
} from './finance'

const META = {
  userId: 'user',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  deletedAt: null,
  revision: 1
}

function account(
  id: string,
  kind: AccountWithBalance['kind'],
  balanceCents: number,
  overrides: Partial<AccountWithBalance> = {}
): AccountWithBalance {
  return {
    ...META,
    id,
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
    ...overrides
  }
}

function bill(
  id: string,
  amountCents: number,
  frequency: Bill['frequency'],
  overrides: Partial<Bill> = {}
): Bill {
  return {
    ...META,
    id,
    name: id,
    amountCents,
    frequency,
    dueDay: 15,
    category: 'Housing',
    accountId: null,
    autopay: false,
    isActive: true,
    nextDueOn: null,
    fundingStrategy: 'all_checks',
    fundingPaycheckIndex: null,
    ...overrides
  }
}

function goal(
  id: string,
  fundedCents: number,
  overrides: Partial<GoalWithProgress> = {}
): GoalWithProgress {
  return {
    ...META,
    id,
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
    ...overrides
  }
}

test('cash on hand counts only live spending accounts, not credit or investments', () => {
  const accounts = [
    account('chequing', 'checking', 250_000),
    account('savings', 'savings', 100_000),
    account('wallet', 'cash', 5_000),
    account('card', 'credit', -40_000),
    account('brokerage', 'investment', 900_000),
    account('old', 'checking', 50_000, { isArchived: true })
  ]
  assert.equal(cashOnHand(accounts), 355_000)
})

test('credit owed and available clamp at zero and skip archived cards', () => {
  const accounts = [
    account('owing', 'credit', -40_000, { creditLimitCents: 500_000 }),
    account('overpaid', 'credit', 12_000, { creditLimitCents: 500_000 }),
    account('unlimited', 'credit', -10_000),
    account('closed', 'credit', -99_000, { creditLimitCents: 100_000, isArchived: true }),
    account('chequing', 'checking', 100_000)
  ]
  assert.equal(creditOwedCents(accounts), 50_000)
  assert.equal(creditAvailableCents(accounts), 960_000, 'a card with no limit adds nothing')
  assert.equal(accountDisplayBalanceCents(accounts[0]), 40_000, 'a card shows what is owed')
  assert.equal(accountDisplayBalanceCents(accounts[1]), 0, 'an overpaid card never shows negative')
  assert.equal(accountDisplayBalanceCents(accounts[3]), 99_000)
})

test('only reachable money can back a fund', () => {
  const accounts = [
    account('chequing', 'checking', 1),
    account('savings', 'savings', 1),
    account('wallet', 'cash', 1),
    account('card', 'credit', 1),
    account('brokerage', 'investment', 1),
    account('old', 'savings', 1, { isArchived: true })
  ]
  assert.deepEqual(
    fundableAccounts(accounts).map((row) => row.id),
    ['chequing', 'savings', 'wallet']
  )
})

test('the wall is smoothed to a month and then to a cheque', () => {
  const bills = [
    bill('rent', 120_000, 'monthly'),
    bill('insurance', 60_000, 'annual'),
    bill('paused', 999_999, 'monthly', { isActive: false })
  ]
  assert.deepEqual(activeBills(bills).map((row) => row.id), ['rent', 'insurance'])
  assert.equal(monthlyWall(activeBills(bills)), 125_000, 'an annual bill is one twelfth a month')
  assert.equal(perPaycheckWall(activeBills(bills), 'semimonthly'), 62_500)
})

test('goal totals ignore archived goals', () => {
  const goals = [goal('emergency', 300_000), goal('trip', 50_000), goal('done', 10_000, { isArchived: true })]
  const summary = goalsSummary(goals)
  assert.equal(summary.targetCents, 200_000)
  assert.equal(summary.fundedCents, 350_000)
  assert.equal(summary.progress, 1.75)
})

test('monthly routing folds every bucket into four slices', () => {
  const paycheck = {
    ...META,
    id: 'pay',
    receivedOn: '2026-03-05',
    allocations: [
      { bucket: 'priority', amountCents: 1_000 },
      { bucket: 'savings', amountCents: 2_000 },
      { bucket: 'investment', amountCents: 3_000 },
      { bucket: 'goal', amountCents: 4_000 },
      { bucket: 'debt', amountCents: 5_000 },
      { bucket: 'leisure', amountCents: 6_000 }
    ]
  } as unknown as PaycheckWithAllocations

  assert.deepEqual(monthRoutingBreakdown([paycheck], '2026-03'), {
    priorityCents: 1_000,
    growthCents: 9_000,
    debtCents: 5_000,
    leisureCents: 6_000,
    totalCents: 21_000
  })
  assert.equal(monthRoutingBreakdown([paycheck], '2026-04').totalCents, 0)
})

test('the upcoming queue holds bills and card payments inside the horizon', () => {
  const items = upcomingPayments({
    bills: [
      bill('rent', 120_000, 'monthly', { dueDay: 20 }),
      bill('later', 5_000, 'monthly', { dueDay: 28 }),
      bill('paused', 1_000, 'monthly', { isActive: false })
    ],
    accounts: [],
    transactions: [],
    todayISO: '2026-03-10',
    horizonDays: 14
  })
  assert.deepEqual(
    items.map((item) => [item.name, item.dueOn, item.daysUntil]),
    [['rent', '2026-03-20', 10]]
  )
})

test('day ordinals read the way a calendar writes them', () => {
  assert.deepEqual(
    [1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 31].map(ordinal),
    ['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '23rd', '31st']
  )
})

test('the spreadsheet cannot retype a row into a kind that needs its own dialog', () => {
  assert.deepEqual(retypeChoices('expense'), ['income', 'expense', 'investment', 'adjustment'])
  // An existing bill payment keeps its own kind in the list so it can be
  // changed away, but no row can be retyped into a bill or goal payment.
  assert.deepEqual(retypeChoices('bill_payment'), [
    'bill_payment',
    'income',
    'expense',
    'investment',
    'adjustment'
  ])
  assert.equal(retypeChoices('expense').includes('transfer'), false)
  assert.equal(retypeChoices('expense').includes('goal_funding'), false)
  assert.equal(retypeChoices('goal_funding').includes('goal_funding'), true)
})

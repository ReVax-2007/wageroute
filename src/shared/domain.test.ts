import assert from 'node:assert/strict'
import test from 'node:test'
import { buildAllocationPlan, type AllocationPlan } from './allocator'
import { dueBillPrompts } from './billPrompts'
import { monthlyEquivalentCents, reservePerPaycheckCents } from './cadence'
import { parseCsv, parseEntriesCsv, toCsv, transactionsToCsv } from './csv'
import { addMonthsISO, nextDueDateISO, previousDueDateISO } from './dates'
import {
  averageMonthlyVariableCents,
  emergencyCoverageMonths,
  emergencyMonthlyEssentialsCents,
  recommendedEmergencyTargetCents
} from './emergency'
import { centsToEditable, parseMoneyToCents } from './money'
import { projectUpcoming } from './projections'
import { parseSettings, settingsToRecord } from './settings'
import { roundUpRemainderCents, transferLegs } from './transfers'
import type { Account, TransactionRow } from './types'

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

test('money parsing never loses cents to floating point', () => {
  assert.equal(parseMoneyToCents('$1,234.56'), 123456)
  assert.equal(parseMoneyToCents('12'), 1200)
  assert.equal(parseMoneyToCents('-3.5'), -350)
  assert.equal(parseMoneyToCents('(42.00)'), -4200)
  assert.equal(parseMoneyToCents('0.05'), 5)
  assert.equal(parseMoneyToCents('1.234'), null)
  assert.equal(parseMoneyToCents('abc'), null)
  assert.equal(parseMoneyToCents(''), null)
  assert.equal(centsToEditable(-350), '-3.50')
  assert.equal(centsToEditable(5), '0.05')
})

test('bill cadence is smoothed into per-paycheck reserves', () => {
  assert.equal(monthlyEquivalentCents(60000, 'annual'), 5000)
  assert.equal(monthlyEquivalentCents(120000, 'monthly'), 120000)
  assert.equal(reservePerPaycheckCents(120000, 'monthly', 'biweekly'), 55385)
  assert.equal(reservePerPaycheckCents(120000, 'monthly', 'monthly'), 120000)
})

test('date maths clamps to real month lengths', () => {
  assert.equal(addMonthsISO('2026-01-31', 1), '2026-02-28')
  assert.equal(addMonthsISO('2026-01-15', 1), '2026-02-15')
  assert.equal(nextDueDateISO(15, '2026-10-27'), '2026-11-15')
  assert.equal(nextDueDateISO(20, '2026-10-27'), '2026-11-20')
  assert.equal(previousDueDateISO(15, '2026-10-27'), '2026-10-15')
  assert.equal(previousDueDateISO(27, '2026-10-27'), '2026-10-27')
  assert.equal(previousDueDateISO(31, '2026-10-27'), '2026-09-30')
})

test('priority wall is funded before any surplus is split', () => {
  const plan = buildAllocationPlan({
    incomeCents: 500000,
    payCadence: 'monthly',
    bills: [{ id: 'rent', name: 'Rent', amountCents: 100000, frequency: 'monthly' }],
    goals: [
      {
        id: 'tattoo',
        name: 'Tattoo Fund',
        targetCents: 40000,
        fundedCents: 0,
        priority: 10,
        targetDate: null
      }
    ],
    splits: { savingsPercent: 25, investmentPercent: 25, goalsPercent: 25, debtPercent: 0 }
  })

  assert.equal(plan.priorityRequiredCents, 100000)
  assert.equal(plan.priorityFundedCents, 100000)
  assert.equal(plan.shortfallCents, 0)
  assert.equal(plan.surplusCents, 400000)
  assert.equal(plan.goalFundings[0].amountCents, 40000)
  assert.equal(plan.goalsCents, 40000)
  // Unused goal budget (60,000) sweeps to savings instead of evaporating.
  assert.equal(plan.savingsCents, 160000)
  assert.equal(plan.investmentCents, 100000)
  assert.equal(plan.leisureCents, 100000)
  assert.equal(allocated(plan), plan.incomeCents)
  assert.equal(plan.health, 'covered')
  assert.deepEqual(
    plan.warnings.map((warning) => warning.code),
    ['goal_overflow']
  )
})

test('shortfall halts allocation and reports the gap', () => {
  const plan = buildAllocationPlan({
    incomeCents: 50000,
    payCadence: 'monthly',
    bills: [{ id: 'rent', name: 'Rent', amountCents: 100000, frequency: 'monthly' }],
    goals: [],
    splits: { savingsPercent: 20, investmentPercent: 20, goalsPercent: 20, debtPercent: 0 }
  })

  assert.equal(plan.health, 'shortfall')
  assert.equal(plan.shortfallCents, 50000)
  assert.equal(plan.priorityFundedCents, 50000)
  assert.equal(plan.surplusCents, 0)
  assert.equal(plan.leisureCents, 0)
  assert.equal(allocated(plan), plan.incomeCents)
  assert.deepEqual(
    plan.warnings.map((warning) => warning.code),
    ['shortfall']
  )
})

test('splits over 100% are scaled down without creating money', () => {
  const plan = buildAllocationPlan({
    incomeCents: 200000,
    payCadence: 'monthly',
    bills: [],
    goals: [],
    splits: { savingsPercent: 60, investmentPercent: 60, goalsPercent: 0, debtPercent: 0 }
  })

  assert.equal(plan.savingsCents, 100000)
  assert.equal(plan.investmentCents, 100000)
  assert.equal(plan.leisureCents, 0)
  assert.equal(allocated(plan), plan.incomeCents)
  assert.ok(plan.warnings.some((warning) => warning.code === 'splits_scaled'))
  assert.ok(plan.warnings.some((warning) => warning.code === 'no_bills'))
})

test('goals are funded in priority order, then stop at their target', () => {
  const plan = buildAllocationPlan({
    incomeCents: 700000,
    payCadence: 'monthly',
    bills: [],
    goals: [
      {
        id: 'later',
        name: 'Later',
        targetCents: 500000,
        fundedCents: 0,
        priority: 20,
        targetDate: null
      },
      {
        id: 'sooner',
        name: 'Sooner',
        targetCents: 500000,
        fundedCents: 0,
        priority: 10,
        targetDate: '2027-01-01'
      }
    ],
    splits: { savingsPercent: 0, investmentPercent: 0, goalsPercent: 100, debtPercent: 0 }
  })

  assert.deepEqual(
    plan.goalFundings.map((funding) => [funding.goalId, funding.amountCents]),
    [
      ['sooner', 500000],
      ['later', 200000]
    ]
  )
  assert.equal(plan.leisureCents, 0)
  assert.equal(allocated(plan), plan.incomeCents)
})

test('whole-dollar buckets sweep the dust into leisure', () => {
  const plan = buildAllocationPlan({
    incomeCents: 33333,
    payCadence: 'monthly',
    bills: [],
    goals: [],
    splits: { savingsPercent: 33, investmentPercent: 33, goalsPercent: 0, debtPercent: 0 },
    wholeDollarBuckets: true
  })

  assert.equal(plan.savingsCents % 100, 0)
  assert.equal(plan.investmentCents % 100, 0)
  assert.ok(plan.leisureCents > 0)
  assert.equal(allocated(plan), plan.incomeCents)
})

test('projections list upcoming bills and goal deadlines in date order', () => {
  const rows = projectUpcoming({
    fromISO: '2026-10-27',
    horizonDays: 60,
    bills: [
      {
        id: 'electric',
        name: 'Electric',
        category: 'Utilities',
        amountCents: 9500,
        frequency: 'monthly',
        dueDay: 15,
        nextDueOn: null
      }
    ],
    goals: [
      {
        id: 'tattoo',
        name: 'Tattoo Fund',
        targetDate: '2026-12-01',
        remainingCents: 40000
      }
    ]
  })

  assert.deepEqual(
    rows.map((row) => [row.date, row.name]),
    [
      ['2026-11-15', 'Electric'],
      ['2026-12-01', 'Tattoo Fund'],
      ['2026-12-15', 'Electric']
    ]
  )
})

test('settings fall back safely when the record is empty or corrupt', () => {
  const defaults = parseSettings({})
  assert.equal(defaults.payCadence, 'biweekly')
  assert.equal(defaults.savingsPercent, 20)
  assert.equal(defaults.debtPercent, 0)

  const corrupt = parseSettings({
    payCadence: 'hourly',
    savingsPercent: 'lots',
    currency: 'dollars'
  })
  assert.equal(corrupt.payCadence, 'biweekly')
  assert.equal(corrupt.savingsPercent, 20)
  assert.equal(corrupt.currency, 'USD')
})

test('debt is a first-class slice of the surplus', () => {
  const plan = buildAllocationPlan({
    incomeCents: 400000,
    payCadence: 'monthly',
    bills: [],
    goals: [],
    splits: { savingsPercent: 25, investmentPercent: 25, goalsPercent: 0, debtPercent: 25 }
  })

  assert.equal(plan.savingsCents, 100000)
  assert.equal(plan.investmentCents, 100000)
  assert.equal(plan.debtCents, 100000)
  assert.equal(plan.leisureCents, 100000)
  assert.equal(plan.health, 'covered')
  assert.equal(allocated(plan), plan.incomeCents)
})

test('four-way splits over 100% are scaled without creating money', () => {
  const plan = buildAllocationPlan({
    incomeCents: 300000,
    payCadence: 'monthly',
    bills: [],
    goals: [],
    splits: { savingsPercent: 40, investmentPercent: 40, goalsPercent: 0, debtPercent: 40 }
  })

  assert.ok(plan.warnings.some((warning) => warning.code === 'splits_scaled'))
  assert.equal(plan.savingsCents + plan.investmentCents + plan.debtCents, 300000)
  assert.equal(plan.leisureCents, 0)
  assert.equal(allocated(plan), plan.incomeCents)
})

test('chronology engine prompts only for unconfirmed past-due bills', () => {
  const bills = [
    {
      id: 'rent',
      name: 'Rent',
      amountCents: 185000,
      frequency: 'monthly' as const,
      dueDay: 1,
      nextDueOn: null,
      category: 'Housing',
      accountId: 'checking',
      isActive: true,
      autopay: true
    },
    {
      id: 'internet',
      name: 'Internet',
      amountCents: 6000,
      frequency: 'monthly' as const,
      dueDay: 20,
      nextDueOn: null,
      category: 'Utilities',
      accountId: 'checking',
      isActive: true,
      autopay: true
    },
    {
      id: 'paused',
      name: 'Paused bill',
      amountCents: 5000,
      frequency: 'monthly' as const,
      dueDay: 1,
      nextDueOn: null,
      category: 'Bills',
      accountId: null,
      isActive: false,
      autopay: false
    }
  ]

  const payments = [
    // Rent paid a few days before its due date still counts for the cycle.
    { billId: 'rent', occurredOn: '2026-09-28', amountCents: -185000 },
    // A category-only expense must not silence Internet.
    { billId: null, occurredOn: '2026-10-20', amountCents: -6000 }
  ]

  const prompts = dueBillPrompts({ bills, payments, todayISO: '2026-10-27' })
  assert.deepEqual(
    prompts.map((prompt) => [prompt.billId, prompt.dueOn, prompt.daysLate]),
    [['internet', '2026-10-20', 7]]
  )

  // Today's due date is never "past due"; the prompt starts the next day.
  const onDueDay = dueBillPrompts({
    bills: [bills[1]],
    payments: [],
    todayISO: '2026-10-20'
  })
  assert.equal(onDueDay.length, 0)
})

test('a part payment is surfaced with what is already matched, not hidden', () => {
  const bill = {
    id: 'rent',
    name: 'Rent',
    amountCents: 185000,
    frequency: 'monthly' as const,
    dueDay: 1,
    nextDueOn: null,
    category: 'Housing',
    accountId: null,
    isActive: true,
    autopay: false
  }

  const [partial] = dueBillPrompts({
    bills: [bill],
    payments: [{ billId: 'rent', occurredOn: '2026-10-02', amountCents: -85000 }],
    todayISO: '2026-10-05'
  })
  assert.equal(partial.billId, 'rent')
  assert.equal(partial.paidCents, 85000, 'the payment counts toward this cycle')

  const settled = dueBillPrompts({
    bills: [bill],
    payments: [
      { billId: 'rent', occurredOn: '2026-10-02', amountCents: -85000 },
      { billId: 'rent', occurredOn: '2026-10-04', amountCents: -100000 }
    ],
    todayISO: '2026-10-05'
  })
  assert.deepEqual(settled, [], 'two parts that add up to the bill close the prompt')
})

test('round-up sweeps the remainder to the next increment, never the exact amount', () => {
  assert.equal(roundUpRemainderCents(1240, 100), 60)
  assert.equal(roundUpRemainderCents(1200, 100), 0)
  assert.equal(roundUpRemainderCents(1240, 200), 160)
  assert.equal(roundUpRemainderCents(1240, 500), 260)
  assert.equal(roundUpRemainderCents(-1240, 100), 60)
  assert.equal(roundUpRemainderCents(5, 0), 0)
  assert.deepEqual(transferLegs(4200), { outCents: -4200, inCents: 4200 })
  assert.deepEqual(transferLegs(-4200), { outCents: -4200, inCents: 4200 })
})

test('emergency calculator averages only variable expenses inside the window', () => {
  const transactions = [
    { kind: 'expense', amountCents: -10000, occurredOn: '2026-08-10' },
    { kind: 'expense', amountCents: -20000, occurredOn: '2026-09-15' },
    { kind: 'expense', amountCents: -30000, occurredOn: '2026-10-01' },
    { kind: 'bill_payment', amountCents: -185000, occurredOn: '2026-10-01' },
    { kind: 'income', amountCents: 500000, occurredOn: '2026-10-05' },
    { kind: 'transfer', amountCents: -40000, occurredOn: '2026-10-06' },
    { kind: 'expense', amountCents: -90000, occurredOn: '2025-12-01' }
  ] as const

  const variable = averageMonthlyVariableCents(transactions, '2026-10-27')
  assert.equal(variable, 20000)

  const essentials = emergencyMonthlyEssentialsCents({
    wallMonthlyCents: 250000,
    variableMonthlyCents: variable,
    includeVariable: true
  })
  assert.equal(essentials, 270000)
  assert.equal(
    emergencyMonthlyEssentialsCents({
      wallMonthlyCents: 250000,
      variableMonthlyCents: variable,
      includeVariable: false
    }),
    250000
  )

  assert.equal(recommendedEmergencyTargetCents(essentials, 3), 810000)
  assert.equal(emergencyCoverageMonths(405000, essentials), 1.5)
  assert.equal(emergencyCoverageMonths(405000, 0), 0)
})

test('CSV export quotes commas, quotes and newlines', () => {
  assert.equal(
    toCsv([['a,b', 'say "hi"', 'line\nbreak']]),
    '"a,b","say ""hi""","line\nbreak"'
  )

  const accounts: Account[] = [
    {
      id: 'acc-1',
      userId: 'user-1',
      name: 'Chequing',
      kind: 'checking',
      institution: 'Tangerine',
      startingBalanceCents: 0,
      creditLimitCents: null,
      color: null,
      dedicatedGoalId: null,
      inSafeToSpend: null,
      isArchived: false,
      sortOrder: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      deletedAt: null,
      revision: 1
    }
  ]
  const transactions: TransactionRow[] = [
    {
      id: 'tx-1',
      userId: 'user-1',
      accountId: 'acc-1',
      accountName: 'Chequing',
      kind: 'expense',
      amountCents: -1240,
      occurredOn: '2026-10-27',
      memo: 'Coffee, large',
      category: 'Food',
      billId: null,
      goalId: null,
      paycheckId: null,
      counterAccountId: null,
      transferGroupId: null,
      createdAt: '2026-10-27T00:00:00.000Z',
      updatedAt: '2026-10-27T00:00:00.000Z',
      deletedAt: null,
      revision: 1
    }
  ]

  assert.equal(
    transactionsToCsv(transactions, accounts, 'CAD'),
    [
      'Date,Account,Institution,Kind,Category,Description,Amount,Currency',
      '2026-10-27,Chequing,Tangerine,expense,Food,"Coffee, large",-12.40,CAD'
    ].join('\r\n')
  )
})

test('entries CSV round-trips exports and tolerates bank-style dates', () => {
  const text = [
    '\uFEFFDate,Account,Institution,Kind,Category,Description,Amount,Currency',
    '2026-10-01,Everyday Checking,Tangerine,expense,Groceries,"Metro, downtown",-42.15,CAD',
    '',
    '10/02/2026,Savings,Wealthsimple,deposit,,"Paycheck ""October""",1500.00,CAD',
    '2026-10-03,Everyday Checking,Tangerine,transfer,Round-up,Round-up sweep,-0.60,CAD',
    '2026-02-31,Everyday Checking,Tangerine,expense,Food,Bad date,-1.00,CAD'
  ].join('\r\n')

  const parsed = parseEntriesCsv(text)

  assert.equal(parsed.entries.length, 2)
  assert.deepEqual(parsed.entries[0], {
    line: 2,
    occurredOn: '2026-10-01',
    accountName: 'Everyday Checking',
    institution: 'Tangerine',
    kind: 'expense',
    category: 'Groceries',
    memo: 'Metro, downtown',
    amountCents: -4215
  })
  assert.equal(parsed.entries[1].occurredOn, '2026-10-02')
  assert.equal(parsed.entries[1].kind, 'income')
  assert.equal(parsed.entries[1].memo, 'Paycheck "October"')
  assert.equal(parsed.entries[1].amountCents, 150000)

  assert.equal(parsed.issues.length, 2)
  assert.match(parsed.issues[0].message, /transfer/)
  assert.match(parsed.issues[1].message, /date/)
})

test('CSV parsing keeps quoted newlines and skips blank rows', () => {
  assert.deepEqual(parseCsv('a,"b\r\nc"\r\n\r\nd,e\r\n'), [
    ['a', 'b\r\nc'],
    ['d', 'e']
  ])
})

test('settings default to dark theme, round-up off and auto emergency target', () => {
  const defaults = parseSettings({})
  assert.equal(defaults.theme, 'dark')
  assert.equal(defaults.paydayLabel, '')
  assert.equal(defaults.defaultDepositAccountId, null)
  assert.equal(defaults.roundUpEnabled, false)
  assert.equal(defaults.roundUpAccountId, null)
  assert.equal(defaults.roundUpToCents, 100)
  assert.equal(defaults.emergencyMode, 'auto')
  assert.equal(defaults.emergencyMonths, 3)
  assert.equal(defaults.emergencyIncludeVariable, true)
  assert.equal(defaults.emergencyManualTargetCents, 0)
  assert.equal(defaults.emergencyActive, true)

  const parsed = parseSettings({
    theme: 'light',
    paydayLabel: '  15th and last day  ',
    defaultDepositAccountId: 'acc-checking',
    roundUpEnabled: 'true',
    roundUpAccountId: 'acc-1',
    roundUpToCents: '200',
    emergencyMode: 'manual',
    emergencyMonths: '5',
    emergencyIncludeVariable: 'false',
    emergencyManualTargetCents: '1200000',
    emergencyActive: 'false'
  })
  assert.equal(parsed.theme, 'light')
  assert.equal(parsed.paydayLabel, '15th and last day', 'labels are stored trimmed')
  assert.equal(parsed.defaultDepositAccountId, 'acc-checking')
  assert.equal(parsed.roundUpEnabled, true)
  assert.equal(parsed.roundUpAccountId, 'acc-1')
  assert.equal(parsed.roundUpToCents, 200)
  assert.equal(parsed.emergencyMode, 'manual')
  assert.equal(parsed.emergencyMonths, 5)
  assert.equal(parsed.emergencyIncludeVariable, false)
  assert.equal(parsed.emergencyManualTargetCents, 1200000)
  assert.equal(parsed.emergencyActive, false)

  const invalid = parseSettings({
    theme: 'neon',
    paydayLabel: '   ',
    defaultDepositAccountId: '',
    roundUpToCents: '300',
    emergencyMode: 'guess',
    emergencyMonths: '18',
    emergencyManualTargetCents: '-1'
  })
  assert.equal(invalid.theme, 'dark')
  assert.equal(invalid.paydayLabel, '')
  assert.equal(invalid.defaultDepositAccountId, null, 'an empty pointer means "no default"')
  assert.equal(invalid.roundUpToCents, 100)
  assert.equal(invalid.emergencyMode, 'auto')
  assert.equal(invalid.emergencyMonths, 3)
  assert.equal(invalid.emergencyManualTargetCents, 0)
  assert.equal(invalid.emergencyActive, true)

  assert.deepEqual(parseSettings(settingsToRecord(parsed)), parsed)
})

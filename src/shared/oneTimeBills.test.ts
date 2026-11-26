import assert from 'node:assert/strict'
import test from 'node:test'
import { buildAllocationPlan } from './allocator'
import { dueBillPrompts } from './billPrompts'
import { billFundingReserveCents, monthlyEquivalentCents, unpaidMonthlyWallCents } from './cadence'
import { deriveClaimStates } from './claims'
import { billOccurrencesBetween, nextBillOccurrence } from './occurrences'
import {
  chequesUntilDue,
  inBillCycle,
  isOneTimeBillDone,
  leftToOwner,
  oneTimeCloseAtCents,
  oneTimeDueOn,
  oneTimeReserveCents,
  oneTimeSetAsideCents
} from './oneTimeBills'
import { projectUpcoming } from './projections'
import { assertBillSchedule } from './writeRules'

/** ADR 0037: a bill that is due once, saved up for, and done once paid. */

const tires = {
  id: 'tires',
  name: 'New tires',
  category: 'Car',
  amountCents: 90_000,
  frequency: 'once' as const,
  dueDay: 30,
  nextDueOn: '2026-09-30',
  createdAt: '2026-08-01T10:00:00.000Z'
}

test('a one-time bill needs its date, and its due day follows the date', () => {
  assert.deepEqual(assertBillSchedule('once', 1, '2026-09-30'), {
    dueDay: 30,
    nextDueOn: '2026-09-30'
  })
  assert.throws(() => assertBillSchedule('once', 1, null), /needs the date/)
  assert.throws(() => assertBillSchedule('once', 1, '30/09/2026'), /YYYY-MM-DD/)
  assert.deepEqual(assertBillSchedule('monthly', 5, null), { dueDay: 5, nextDueOn: null })
})

test('it has no recurring share: the monthly figures read it as zero', () => {
  assert.equal(monthlyEquivalentCents(tires.amountCents, 'once'), 0)
})

test('it occurs exactly once, on its date, and is never rolled forward', () => {
  assert.deepEqual(billOccurrencesBetween(tires, '2026-01-01', '2027-12-31'), ['2026-09-30'])
  assert.deepEqual(billOccurrencesBetween(tires, '2026-10-01', '2027-12-31'), [])
  // Past its date, the next occurrence is still that date: it is overdue.
  assert.equal(nextBillOccurrence(tires, '2026-11-17'), '2026-09-30')
})

test('projections show it once, on its date', () => {
  const rows = projectUpcoming({ bills: [tires], goals: [], fromISO: '2026-08-01', horizonDays: 90 })
  assert.deepEqual(
    rows.map((row) => [row.date, row.amountCents]),
    [['2026-09-30', 90_000]]
  )
})

test('cheques before the due date are counted per pay cycle', () => {
  assert.equal(chequesUntilDue('2026-08-01', '2026-09-30', 'semimonthly'), 4)
  assert.equal(chequesUntilDue('2026-08-16', '2026-09-30', 'semimonthly'), 3)
  assert.equal(chequesUntilDue('2026-08-07', '2026-09-30', 'biweekly'), 4)
  assert.equal(chequesUntilDue('2026-08-07', '2026-09-30', 'weekly'), 8)
  assert.equal(chequesUntilDue('2026-08-20', '2026-09-10', 'monthly'), 1)
  assert.equal(chequesUntilDue('2026-10-01', '2026-09-30', 'semimonthly'), 0)
  // A count that misjudges the paydays only moves money between cheques: each
  // one re-divides what is still open, and the last before the date takes the rest.
  assert.equal(
    oneTimeReserveCents({
      amountCents: 90_000,
      dueOn: '2026-09-30',
      cadence: 'semimonthly',
      paycheckDate: '2026-09-29',
      claimedCents: 60_000
    }),
    30_000
  )
})

test('the paychecks before the date share it instead of one cheque taking it all', () => {
  const plan = (paycheckDate: string, claimedCents: number) =>
    oneTimeReserveCents({
      amountCents: 90_000,
      dueOn: '2026-09-30',
      cadence: 'semimonthly',
      paycheckDate,
      claimedCents
    })
  let claimed = 0
  const shares: number[] = []
  for (const date of ['2026-08-01', '2026-08-16', '2026-09-01', '2026-09-16']) {
    const share = plan(date, claimed)
    shares.push(share)
    claimed += share
  }
  assert.deepEqual(shares, [22_500, 22_500, 22_500, 22_500])
  // A cheque after the date carries whatever is still open: the bill is overdue.
  assert.equal(plan('2026-10-01', 45_000), 45_000)
  // A payment already made shrinks what is left to share.
  assert.equal(
    oneTimeReserveCents({
      amountCents: 90_000,
      dueOn: '2026-09-30',
      cadence: 'semimonthly',
      paycheckDate: '2026-09-01',
      paidCents: 50_000
    }),
    20_000
  )
})

test('the allocator reserves a one-time bill through the same entry point', () => {
  assert.equal(
    billFundingReserveCents({
      amountCents: 90_000,
      frequency: 'once',
      cadence: 'semimonthly',
      dueDay: 30,
      fundingStrategy: 'first_check',
      paycheckDate: '2026-08-01',
      dueOn: '2026-09-30'
    }),
    22_500,
    'a funding strategy does not move a one-time bill onto one cheque'
  )
  const plan = buildAllocationPlan({
    incomeCents: 200_000,
    payCadence: 'semimonthly',
    paycheckDate: '2026-08-16',
    monthClaims: [{ billId: 'tires', amountCents: 22_500, strategy: 'all_checks' }],
    bills: [tires],
    goals: [],
    splits: { savingsPercent: 0, investmentPercent: 0, goalsPercent: 0, debtPercent: 0 }
  })
  assert.equal(plan.priorityReserves[0].reserveCents, 22_500)
})

test('Left to spend holds what the saving-up has reached, not just one month', () => {
  const paid = new Map<string, number>()
  assert.equal(unpaidMonthlyWallCents([tires], paid, '2026-08'), 45_000)
  assert.equal(unpaidMonthlyWallCents([tires], paid, '2026-09'), 90_000)
  assert.equal(unpaidMonthlyWallCents([tires], paid, '2026-11'), 90_000, 'overdue holds it all')
  assert.equal(unpaidMonthlyWallCents([tires], new Map([['tires', 30_000]]), '2026-09'), 60_000)
  assert.equal(oneTimeSetAsideCents(tires, '2026-07'), 0)
})

test('it is done when its payments cover it, and a variable one after any payment', () => {
  assert.equal(isOneTimeBillDone(tires, 89_999), false)
  assert.equal(isOneTimeBillDone(tires, 90_000), true)
  assert.equal(isOneTimeBillDone({ ...tires, frequency: 'monthly' }, 90_000), false)
  assert.equal(inBillCycle(tires, '2026-05-02', '2026-09'), true, 'every payment counts')
  assert.equal(inBillCycle({ frequency: 'monthly' }, '2026-05-02', '2026-09'), false)
})

test('an unpaid one past its date is overdue; once paid it never asks again', () => {
  const bill = { ...tires, accountId: null, isActive: true, autopay: true }
  const overdue = dueBillPrompts({ bills: [bill], payments: [], todayISO: '2026-11-17' })
  assert.equal(overdue.length, 1)
  assert.equal(overdue[0].dueOn, '2026-09-30')
  assert.equal(overdue[0].daysLate, 48)
  // Paid early, months before the date: still covered.
  const paidEarly = dueBillPrompts({
    bills: [bill],
    payments: [{ billId: 'tires', occurredOn: '2026-06-01', amountCents: -90_000 }],
    todayISO: '2027-11-17'
  })
  assert.deepEqual(paidEarly, [])
  assert.deepEqual(
    dueBillPrompts({ bills: [bill], payments: [], todayISO: '2026-09-29' }),
    [],
    'nothing asks before the date'
  )
})

test('one payment settles every month of claims the saving-up wrote', () => {
  const claim = (id: string, cycle: string, receivedOn: string) => ({
    id,
    cycle,
    amountCents: 22_500,
    state: 'reserved' as const,
    settledBy: null,
    dueDay: 30,
    receivedOn,
    createdAt: `${receivedOn}T00:00:00.000Z`,
    frequency: 'once' as const
  })
  const outcomes = deriveClaimStates(
    [
      claim('a', '2026-08', '2026-08-01'),
      claim('b', '2026-08', '2026-08-15'),
      claim('c', '2026-09', '2026-09-01'),
      claim('d', '2026-09', '2026-09-15')
    ],
    [{ id: 'pay', occurredOn: '2026-09-30', amountCents: -90_000, createdAt: '2026-09-30T00:00:00.000Z' }]
  )
  assert.deepEqual(
    outcomes.map((outcome) => outcome.state),
    ['paid', 'paid', 'paid', 'paid']
  )
})

test('a bill written without a date falls back to its due day in the month it was written', () => {
  assert.equal(
    oneTimeDueOn({ nextDueOn: null, dueDay: 31, createdAt: '2026-02-03T00:00:00.000Z' }),
    '2026-02-28'
  )
})

test('a one-time bill paid in parts closes at what was paid, and only then', () => {
  const gifts = { amountCents: 50_000, frequency: 'once' as const, isVariable: false }
  assert.equal(oneTimeCloseAtCents(gifts, 45_000), 45_000, 'under budget closes at the total')
  assert.equal(oneTimeCloseAtCents(gifts, 0), null, 'nothing paid, nothing to close at')
  assert.equal(oneTimeCloseAtCents(gifts, 50_000), null, 'covered is already done')
  assert.equal(oneTimeCloseAtCents({ ...gifts, isVariable: true }, 20_000), null, 'a variable bill clears on one payment')
  assert.equal(oneTimeCloseAtCents({ ...gifts, frequency: 'monthly' as const }, 20_000), null)
})

test('a one-time bill left to the owner asks nothing of a cheque or of Left to spend (ADR 0038)', () => {
  const gifts = {
    id: 'gifts',
    amountCents: 50_000,
    frequency: 'once' as const,
    dueDay: 20,
    nextDueOn: '2026-12-20',
    createdAt: '2026-11-01T00:00:00.000Z',
    fromPaychecks: false
  }
  assert.equal(leftToOwner(gifts), true)
  assert.equal(leftToOwner({ ...gifts, frequency: 'monthly' as const }), false, 'only a one-time bill')
  assert.equal(leftToOwner({ ...gifts, fromPaychecks: undefined }), false, 'missing means it saves up')
  assert.equal(
    billFundingReserveCents({
      amountCents: gifts.amountCents,
      frequency: gifts.frequency,
      fromPaychecks: false,
      cadence: 'semimonthly',
      dueDay: 20,
      paycheckDate: '2026-11-15',
      dueOn: gifts.nextDueOn
    }),
    0
  )
  assert.equal(unpaidMonthlyWallCents([gifts], new Map(), '2026-12'), 0, 'nothing held back')
  assert.equal(
    unpaidMonthlyWallCents([{ ...gifts, fromPaychecks: true }], new Map(), '2026-12'),
    50_000,
    'saving up holds the whole amount by the due month'
  )
})

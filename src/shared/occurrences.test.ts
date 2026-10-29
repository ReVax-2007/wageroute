import assert from 'node:assert/strict'
import test from 'node:test'
import { daysBetweenISO } from './dates'
import {
  billOccurrencesBetween,
  billSeriesAnchor,
  nextBillOccurrence,
  previousBillOccurrence,
  semimonthlyDays,
  type RecurringBill
} from './occurrences'
import type { Frequency } from './types'

function bill(
  frequency: Frequency,
  dueDay: number,
  nextDueOn: string | null = null
): RecurringBill {
  return { id: 'bill-1', amountCents: 1000, frequency, dueDay, nextDueOn }
}

test('a weekly series lands every seventh day, month boundaries included', () => {
  const weekly = bill('weekly', 2, '2026-03-02')
  assert.deepEqual(billOccurrencesBetween(weekly, '2026-03-01', '2026-04-05'), [
    '2026-03-02',
    '2026-03-09',
    '2026-03-16',
    '2026-03-23',
    '2026-03-30'
  ])

  const march = billOccurrencesBetween(weekly, '2026-01-01', '2026-12-31')
  for (const date of march) {
    const offset = daysBetweenISO('2026-03-02', date)
    assert.equal(((offset % 7) + 7) % 7, 0, `${date} stays on the grid`)
  }
})

test('a biweekly series walks backwards to the cycle that is already running', () => {
  const biweekly = bill('biweekly', 5, '2026-01-09')
  assert.deepEqual(billOccurrencesBetween(biweekly, '2026-03-01', '2026-04-01'), [
    '2026-03-06',
    '2026-03-20'
  ])
  assert.equal(previousBillOccurrence(biweekly, '2026-03-12'), '2026-03-06')
  assert.equal(nextBillOccurrence(biweekly, '2026-03-12'), '2026-03-20')
})

test('a monthly bill pinned to day 31 stays on the real month end and never drifts', () => {
  const rent = bill('monthly', 31)
  assert.deepEqual(billOccurrencesBetween(rent, '2026-01-01', '2026-05-31'), [
    '2026-01-31',
    '2026-02-28',
    '2026-03-31',
    '2026-04-30',
    '2026-05-31'
  ])
})

test('quarterly months are counted from the anchor month, not its day', () => {
  const insurance = bill('quarterly', 10, '2026-02-10')
  assert.deepEqual(billOccurrencesBetween(insurance, '2026-01-01', '2026-12-31'), [
    '2026-02-10',
    '2026-05-10',
    '2026-08-10',
    '2026-11-10'
  ])
})

test('an annual bill recurs once a year in its anchor month', () => {
  const registration = bill('annual', 28, '2026-04-28')
  assert.deepEqual(billOccurrencesBetween(registration, '2026-01-01', '2029-12-31'), [
    '2026-04-28',
    '2027-04-28',
    '2028-04-28',
    '2029-04-28'
  ])
})

test('semimonthly derives its partner day from the due day', () => {
  assert.deepEqual(semimonthlyDays(15), [15, 30])
  assert.deepEqual(semimonthlyDays(1), [1, 16])
  assert.deepEqual(semimonthlyDays(31), [16, 31])

  const twice = bill('semimonthly', 15)
  assert.deepEqual(billOccurrencesBetween(twice, '2026-02-01', '2026-03-31'), [
    '2026-02-15',
    '2026-02-28',
    '2026-03-15',
    '2026-03-30'
  ])
})

test('a bill without next_due_on is phased from its due day in the reference month', () => {
  const cable = bill('monthly', 15)
  assert.equal(billSeriesAnchor(cable, '2026-03-09'), '2026-03-15')
  assert.equal(previousBillOccurrence(cable, '2026-03-09'), '2026-02-15')
  assert.equal(nextBillOccurrence(cable, '2026-03-09'), '2026-03-15')
})

test('a known next_due_on beats the due day as the series anchor', () => {
  const moved = bill('monthly', 1, '2026-03-20')
  assert.equal(billSeriesAnchor(moved, '2026-01-05'), '2026-03-20')
  assert.equal(previousBillOccurrence(moved, '2026-03-24'), '2026-03-01')
})

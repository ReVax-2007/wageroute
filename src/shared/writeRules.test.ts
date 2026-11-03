import assert from 'node:assert/strict'
import test from 'node:test'
import { RepositoryError } from './errors'
import {
  ACCOUNT_KINDS,
  BILL_FUNDING_STRATEGIES,
  CATEGORY_KINDS,
  FREQUENCIES,
  GOAL_FUNDING_PACES,
  TRANSACTION_KINDS,
  optionalAprBps,
  optionalCents,
  optionalDay,
  assertAprBps,
  assertCents,
  assertDate,
  assertDueDay,
  assertOneOf,
  assertPace,
  assertPaycheckIndex,
  assertSortOrder,
  assertText,
  flagColumn,
  nowISO,
  optionalText
} from './writeRules'

/** Run a rule and return the sentence it refuses with, or null when it accepted. */
function refusal(action: () => unknown): string | null {
  try {
    action()
    return null
  } catch (error) {
    assert.ok(error instanceof RepositoryError, `expected a RepositoryError, got ${String(error)}`)
    assert.equal(error.code, 'VALIDATION')
    return error.message
  }
}

test('the enums are the only kinds either device will write', () => {
  assert.deepEqual([...ACCOUNT_KINDS], ['checking', 'savings', 'cash', 'investment', 'credit'])
  assert.deepEqual([...CATEGORY_KINDS], ['expense', 'income', 'transfer', 'other'])
  assert.deepEqual([...TRANSACTION_KINDS], [
    'income',
    'expense',
    'bill_payment',
    'transfer',
    'goal_funding',
    'investment',
    'adjustment'
  ])
  assert.deepEqual([...FREQUENCIES], [
    'weekly',
    'biweekly',
    'semimonthly',
    'monthly',
    'quarterly',
    'annual'
  ])
  assert.deepEqual([...GOAL_FUNDING_PACES], ['by_date', 'paused', 'asap'])
  assert.ok(BILL_FUNDING_STRATEGIES.includes('closest_due_date'))
})

test('text is trimmed, required and capped', () => {
  assert.equal(assertText('  Rent  ', 'Bill name'), 'Rent')
  assert.equal(refusal(() => assertText('   ', 'Bill name')), 'Bill name is required')
  assert.equal(refusal(() => assertText(7, 'Bill name')), 'Bill name must be text')
  assert.equal(refusal(() => assertText('x'.repeat(161), 'Bill name')), 'Bill name is too long')
  assert.equal(assertText('x'.repeat(160), 'Bill name').length, 160)

  assert.equal(optionalText('', 'Memo'), null)
  assert.equal(optionalText('   ', 'Memo'), null, 'spaces are an empty field, not a refusal')
  assert.equal(optionalText(undefined, 'Memo'), null)
  assert.equal(optionalText(null, 'Memo'), null)
  assert.equal(optionalText(' Paid ', 'Memo'), 'Paid')
  assert.equal(refusal(() => optionalText('x'.repeat(241), 'Memo', 240)), 'Memo is too long')
})

test('cents are whole, in range, and only negative when the caller allows it', () => {
  assert.equal(assertCents(1250.4, 'Amount'), 1250)
  assert.equal(refusal(() => assertCents(0, 'Amount')), 'Amount cannot be zero')
  assert.equal(refusal(() => assertCents(-500, 'Amount')), 'Amount cannot be negative')
  assert.equal(assertCents(-500, 'Amount', { allowNegative: true }), -500)
  assert.equal(assertCents(0, 'Amount', { allowZero: true }), 0)
  assert.equal(refusal(() => assertCents('12', 'Amount')), 'Amount must be a number')
  assert.equal(refusal(() => assertCents(Number.NaN, 'Amount')), 'Amount must be a number')
  assert.equal(
    refusal(() => assertCents(Number.MAX_SAFE_INTEGER + 1, 'Amount')),
    'Amount is out of range'
  )
})

test('a patch can leave a column alone, clear it, or set it', () => {
  assert.equal(optionalCents(undefined, 'Credit limit'), undefined)
  assert.equal(optionalCents(null, 'Credit limit'), null)
  assert.equal(optionalCents(250_000, 'Credit limit'), 250_000)
  assert.equal(optionalAprBps(undefined), undefined)
  assert.equal(optionalAprBps(null), null)
  assert.equal(optionalAprBps(2_399), 2_399)
  assert.equal(optionalDay(undefined, 'Due day'), undefined)
  assert.equal(optionalDay(null, 'Due day'), null)
  assert.equal(refusal(() => optionalDay(0, 'Due day')), 'Due day must be a whole number from 1 to 31')
  assert.equal(
    refusal(() => optionalDay(32, 'Statement day')),
    'Statement day must be a whole number from 1 to 31',
    'the sentence names the column the form actually asked for'
  )
})

test('one of a list, or the sentence says which list', () => {
  assert.equal(assertOneOf('monthly', FREQUENCIES, 'frequency'), 'monthly')
  assert.equal(refusal(() => assertOneOf('fortnightly', FREQUENCIES, 'frequency')), 'Invalid frequency')
  assert.equal(refusal(() => assertOneOf(3, FREQUENCIES, 'frequency')), 'Invalid frequency')
})

test('a date has to be the form the database sorts by', () => {
  assert.equal(assertDate('2026-03-07', 'Date'), '2026-03-07')
  assert.equal(
    refusal(() => assertDate('07/03/2026', 'Date')),
    'Date must be a date in YYYY-MM-DD form'
  )
  assert.equal(
    refusal(() => assertDate('2026-02-30', 'Date')),
    'Date must be a date in YYYY-MM-DD form'
  )
})

test('a due day is a real day of a month, and 31 stays 31', () => {
  assert.equal(assertDueDay(1), 1)
  assert.equal(assertDueDay(31), 31)
  for (const bad of [0, 32, 1.5, Number.NaN, '12']) {
    assert.equal(
      refusal(() => assertDueDay(bad)),
      'Due day must be a whole number from 1 to 31'
    )
  }
})

test('a paycheck choice is one of the four guaranteed slots', () => {
  assert.equal(assertPaycheckIndex(null), null)
  assert.equal(assertPaycheckIndex(undefined), null)
  assert.equal(assertPaycheckIndex(3), 3)
  assert.equal(assertPaycheckIndex(2.4), 2)
  for (const bad of [0, 5]) {
    assert.equal(
      refusal(() => assertPaycheckIndex(bad)),
      'Paycheck choice must be the 1st through the 4th check'
    )
  }
  for (const bad of [Number.NaN, 'first']) {
    assert.equal(refusal(() => assertPaycheckIndex(bad)), 'Paycheck choice must be a number')
  }
})

test('an APR outside the plausible band is a typo, not a rate', () => {
  assert.equal(assertAprBps(0), 0)
  assert.equal(assertAprBps(23_990), 23_990)
  assert.equal(refusal(() => assertAprBps(-1)), 'APR must be between 0% and 1000%')
  assert.equal(refusal(() => assertAprBps(100_001)), 'APR must be between 0% and 1000%')
  assert.equal(refusal(() => assertAprBps('19.99')), 'APR must be a number')
})

test('sort order is a whole number but never refuses a write', () => {
  assert.equal(assertSortOrder(12), 12)
  assert.equal(assertSortOrder(12.6), 13)
  assert.equal(assertSortOrder(undefined), 0)
  assert.equal(assertSortOrder(null), 0)
  assert.equal(refusal(() => assertSortOrder('first')), 'Sort order must be a number')
})

test('a goal pace that cannot be read means as soon as the money allows', () => {
  assert.equal(assertPace('by_date'), 'by_date')
  assert.equal(assertPace('paused'), 'paused')
  assert.equal(assertPace('asap'), 'asap')
  assert.equal(assertPace(undefined), 'asap')
  assert.equal(assertPace('whenever'), 'asap')
})

test('a flag is a real boolean, never a string that happens to be truthy', () => {
  assert.equal(flagColumn(true), 1)
  assert.equal(flagColumn(false), 0)
  assert.equal(flagColumn(1), 1)
  assert.equal(flagColumn(0), 0)
  assert.equal(flagColumn(null), null)
  assert.equal(flagColumn(undefined), null)
  assert.equal(refusal(() => flagColumn('false')), 'Expected a true or false value')
  assert.equal(refusal(() => flagColumn(2)), 'Expected a true or false value')
})

test('stamps sort after the row they describe', () => {
  const first = nowISO()
  const second = nowISO()
  assert.ok(first <= second, 'two stamps from the same clock have to be comparable')
})

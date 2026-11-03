import assert from 'node:assert/strict'
import test from 'node:test'
import { RepositoryError } from './errors'
import type { AccountFormText } from './writeRules'
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
  optionalText,
  validateAccountForm
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

const BLANK_ACCOUNT_FORM: AccountFormText = {
  name: '',
  startingBalance: '',
  creditLimit: '',
  apr: '',
  minimumPayment: '',
  lastStatementBalance: '',
  statementDay: '',
  paymentDueDay: ''
}

function accountForm(overrides: Partial<AccountFormText> = {}): AccountFormText {
  return { ...BLANK_ACCOUNT_FORM, name: 'Tangerine Chequing', ...overrides }
}

test('an account form reads to cents, basis points and days', () => {
  const read = validateAccountForm(
    accountForm({
      startingBalance: ' 2,450.00 ',
      creditLimit: '5,000.00',
      apr: '19.99',
      minimumPayment: '25.00',
      lastStatementBalance: '420.00',
      statementDay: '18',
      paymentDueDay: '8'
    })
  )
  assert.deepEqual(read.problems, {})
  assert.ok(read.parsed, 'a well-typed form has to be readable')
  assert.equal(read.parsed.name, 'Tangerine Chequing')
  assert.equal(read.parsed.startingBalanceCents, 245_000)
  assert.equal(read.parsed.creditLimitCents, 500_000)
  assert.equal(read.parsed.aprBps, 1_999)
  assert.equal(read.parsed.minimumPaymentCents, 2_500)
  assert.equal(read.parsed.lastStatementBalanceCents, 42_000)
  assert.equal(read.parsed.statementDay, 18)
  assert.equal(read.parsed.paymentDueDay, 8)
})

test('a term left blank is no term, not a zero', () => {
  const parsed = validateAccountForm(accountForm({ startingBalance: '' })).parsed
  assert.ok(parsed)
  assert.equal(parsed.startingBalanceCents, 0)
  assert.equal(parsed.creditLimitCents, null)
  assert.equal(parsed.aprBps, null)
  assert.equal(parsed.minimumPaymentCents, null)
  assert.equal(parsed.lastStatementBalanceCents, null)
  assert.equal(parsed.statementDay, null)
  assert.equal(parsed.paymentDueDay, null)
})

test('a term typed with a sign is read as its size, not its direction', () => {
  const parsed = validateAccountForm(
    accountForm({ startingBalance: '-420.00', minimumPayment: '-25.00' })
  ).parsed
  assert.ok(parsed)
  // The dialog turns a card's opening balance into money owed itself; a minimum
  // payment is stored as a size because it can never be a credit.
  assert.equal(parsed.startingBalanceCents, -42_000)
  assert.equal(parsed.minimumPaymentCents, 2_500)
})

test('every account form refusal names the field it refused', () => {
  const cases: { form: Partial<AccountFormText>; field: keyof AccountFormText; words: string }[] = [
    { form: { name: '   ' }, field: 'name', words: 'Give the account a name' },
    { form: { startingBalance: 'lots' }, field: 'startingBalance', words: 'Starting balance must be a number' },
    { form: { creditLimit: 'lots' }, field: 'creditLimit', words: 'Credit limit must be a number' },
    { form: { creditLimit: '-50.00' }, field: 'creditLimit', words: 'Credit limit cannot be negative' },
    { form: { apr: '200' }, field: 'apr', words: 'APR must be a percentage between 0 and 100' },
    { form: { apr: '-1' }, field: 'apr', words: 'APR must be a percentage between 0 and 100' },
    {
      form: { minimumPayment: 'lots' },
      field: 'minimumPayment',
      words: 'Minimum payment must be a number'
    },
    {
      form: { lastStatementBalance: 'lots' },
      field: 'lastStatementBalance',
      words: 'Last statement balance must be a number'
    },
    {
      form: { lastStatementBalance: '-1.00' },
      field: 'lastStatementBalance',
      words: 'Last statement balance cannot be negative'
    },
    {
      form: { statementDay: 'lots' },
      field: 'statementDay',
      words: 'Statement day must be a whole number from 1 to 31'
    },
    {
      form: { statementDay: '32' },
      field: 'statementDay',
      words: 'Statement day must be a whole number from 1 to 31'
    },
    {
      form: { paymentDueDay: '0' },
      field: 'paymentDueDay',
      words: 'Due day must be a whole number from 1 to 31'
    }
  ]
  for (const testCase of cases) {
    const read = validateAccountForm(accountForm({ startingBalance: '10.00', ...testCase.form }))
    assert.equal(read.parsed, null, `${testCase.field} has to stop the write`)
    assert.equal(read.problems[testCase.field], testCase.words)
  }
})

test('a day of the month is whole, in range, and 31 stays allowed', () => {
  const parsed = validateAccountForm(accountForm({ statementDay: '31', paymentDueDay: ' 1 ' })).parsed
  assert.ok(parsed)
  assert.equal(parsed.statementDay, 31)
  assert.equal(parsed.paymentDueDay, 1)
})

test('several bad fields are all reported at once', () => {
  const read = validateAccountForm(accountForm({ name: '', creditLimit: 'lots', statementDay: '99' }))
  assert.equal(Object.keys(read.problems).length, 3)
  assert.equal(read.parsed, null)
})

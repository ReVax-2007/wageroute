import assert from 'node:assert/strict'
import test from 'node:test'
import { creditAmountDue, creditCycle, owedCentsAtUtilization, parseUtilizationPercent, previousCloseDate } from './credit'

test('a cycle walks the close first and the due day after it', () => {
  const cycle = creditCycle({ statementDay: 18, paymentDueDay: 8, fromISO: '2026-10-05' })
  assert.deepEqual(cycle, {
    closesOn: '2026-10-18',
    dueOn: '2026-11-08',
    daysUntilClose: 13,
    daysUntilDue: 34
  })
})

test('a due day that lands before the close belongs to the same cycle', () => {
  const cycle = creditCycle({ statementDay: 28, paymentDueDay: 5, fromISO: '2026-10-10' })
  assert.equal(cycle.closesOn, '2026-10-28')
  assert.equal(cycle.dueOn, '2026-11-05', 'the 5th of next month, not this one')
})

test('a day past the end of a short month clamps to its last day', () => {
  const cycle = creditCycle({ statementDay: 31, paymentDueDay: 31, fromISO: '2026-02-01' })
  assert.equal(cycle.closesOn, '2026-02-28')
  assert.equal(cycle.dueOn, '2026-03-31')
})

test('the amount due is the statement minus what has been paid since', () => {
  assert.equal(
    creditAmountDue({ lastStatementBalanceCents: 50_000, paymentsSinceCloseCents: 20_000 }),
    30_000
  )
  assert.equal(
    creditAmountDue({ lastStatementBalanceCents: 50_000, paymentsSinceCloseCents: 75_000 }),
    0,
    'an overpayment is a credit, never a negative bill'
  )
})

test('the previous close is the one that opened the current cycle', () => {
  assert.equal(previousCloseDate(18, '2026-10-20'), '2026-10-18')
  assert.equal(previousCloseDate(18, '2026-10-18'), '2026-10-18', 'the close day itself counts')
  assert.equal(previousCloseDate(18, '2026-10-17'), '2026-09-18')
})

test('a close day past the end of a short month steps back inside the month', () => {
  // 2026-02-28 is the clamped February close; the January close is the 31st.
  assert.equal(previousCloseDate(31, '2026-02-10'), '2026-01-31')
  assert.equal(previousCloseDate(31, '2026-02-28'), '2026-02-28', 'the close day itself counts')
  assert.equal(previousCloseDate(31, '2026-03-05'), '2026-02-28', 'February clamps to its last day')
})

test('a utilisation is percentage points, not cents', () => {
  assert.equal(parseUtilizationPercent('5'), 5)
  assert.equal(parseUtilizationPercent('42.5'), 42.5)
  assert.equal(parseUtilizationPercent('0.25'), 0.25)
  assert.equal(parseUtilizationPercent(''), null)
  assert.equal(parseUtilizationPercent('.'), null)
  assert.equal(parseUtilizationPercent('5%'), null)
  assert.equal(parseUtilizationPercent('1.234'), null, 'the field keeps at most two decimals')
  assert.equal(parseUtilizationPercent('-5'), null, 'a negative share is not a utilisation')
})

test('utilisation resolves to the amount owed it implies', () => {
  assert.equal(owedCentsAtUtilization(500_000, 5), 25_000, '5% of a $5,000 limit is $250')
  assert.equal(owedCentsAtUtilization(500_000, 42.5), 212_500)
  assert.equal(owedCentsAtUtilization(500_000, 0), 0)
  assert.equal(owedCentsAtUtilization(500_000, 120), 600_000, 'over the limit is allowed')
  assert.equal(owedCentsAtUtilization(500_000, Number.NaN), null)
  assert.equal(owedCentsAtUtilization(500_000, -1), null)
})

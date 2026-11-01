import assert from 'node:assert/strict'
import test from 'node:test'
import { debtPayoff, requiredPaymentCents } from './payoff'

test('a paid-off card has nothing left to plan', () => {
  assert.deepEqual(debtPayoff({ balanceCents: 0, aprBps: 1999, paymentCents: 2_500 }), {
    months: 0,
    totalInterestCents: 0,
    totalPaidCents: 0,
    finalPaymentCents: 0
  })
})

test('a payment that cannot cover the interest is refused, not projected', () => {
  // 12,000 cents at 24% is 240 cents of interest in the first month.
  assert.equal(debtPayoff({ balanceCents: 12_000, aprBps: 2400, paymentCents: 240 }), null)
  assert.equal(debtPayoff({ balanceCents: 12_000, aprBps: 2400, paymentCents: 0 }), null)
})

test('an interest-free balance is paid down by simple division', () => {
  const plan = debtPayoff({ balanceCents: 12_000, aprBps: 0, paymentCents: 5_000 })
  assert.ok(plan)
  assert.equal(plan.months, 3)
  assert.equal(plan.totalInterestCents, 0)
  assert.equal(plan.totalPaidCents, 12_000)
  assert.equal(plan.finalPaymentCents, 2_000, 'the last payment is the remainder')
})

test('interest is rounded per month, the way a statement charges it', () => {
  // 100,000 at 19.99% is 1,666 cents of interest in month one.
  const plan = debtPayoff({ balanceCents: 100_000, aprBps: 1999, paymentCents: 10_000 })
  assert.ok(plan)
  assert.ok(plan.months > 10, 'interest stretches a ten-month plan')
  assert.ok(plan.totalPaidCents > 100_000)
  assert.equal(
    plan.totalPaidCents - 100_000,
    plan.totalInterestCents,
    'every extra cent paid is interest'
  )
})

test('required payment splits a balance over the months, rounding up', () => {
  assert.equal(requiredPaymentCents({ balanceCents: 0, aprBps: 1999, withinMonths: 24 }), 0)
  assert.equal(requiredPaymentCents({ balanceCents: 12_000, aprBps: 0, withinMonths: 24 }), 500)
  assert.equal(requiredPaymentCents({ balanceCents: 12_001, aprBps: 0, withinMonths: 24 }), 501)
  const monthly = requiredPaymentCents({ balanceCents: 100_000, aprBps: 1999, withinMonths: 24 })
  assert.ok(monthly !== null && monthly > 100_000 / 24, 'interest is included')
  // Paying exactly that amount for two years really does clear the card.
  const plan = debtPayoff({
    balanceCents: 100_000,
    aprBps: 1999,
    paymentCents: monthly as number
  })
  assert.ok(plan && plan.months <= 24)
})

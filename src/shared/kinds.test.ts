import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeSignedCents, signForKind, signedAmountError } from './kinds'

test('each kind carries the sign the ledger depends on', () => {
  assert.equal(signForKind('income'), 1)
  for (const kind of ['expense', 'bill_payment', 'transfer', 'goal_funding', 'investment'] as const) {
    assert.equal(signForKind(kind), -1, kind)
  }
  assert.equal(signForKind('adjustment'), 0)
})

test('normalizing rewrites an unsigned amount to the sign of its kind', () => {
  assert.equal(normalizeSignedCents('expense', 1_250), -1_250)
  assert.equal(normalizeSignedCents('income', -1_250), 1_250)
  assert.equal(normalizeSignedCents('bill_payment', -1_250), -1_250)
  assert.equal(normalizeSignedCents('income', 1_250), 1_250)
})

test('an adjustment keeps whichever direction it was written in', () => {
  assert.equal(normalizeSignedCents('adjustment', -900), -900)
  assert.equal(normalizeSignedCents('adjustment', 900), 900)
})

test('zero never contradicts a kind', () => {
  assert.equal(normalizeSignedCents('expense', 0), 0)
  assert.equal(signedAmountError('income', 0), null)
  assert.equal(signedAmountError('expense', 0), null)
})

test('a mismatched sign is reported with the kind in the message', () => {
  assert.match(signedAmountError('expense', 500) ?? '', /expense must be a negative amount/)
  assert.match(signedAmountError('income', -500) ?? '', /Income must be a positive amount/)
  assert.equal(signedAmountError('expense', -500), null)
  assert.equal(signedAmountError('adjustment', -500), null)
})

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { recommendedEmergencyTargetCents } from './emergency'

test('the auto target is months of essentials', () => {
  assert.equal(recommendedEmergencyTargetCents(200_000, 3), 600_000)
  assert.equal(recommendedEmergencyTargetCents(200_000, 6), 1_200_000)
})

test('a manual buffer is added on top of the months', () => {
  assert.equal(recommendedEmergencyTargetCents(200_000, 3, 50_000), 650_000)
})

test('a missing, negative or broken buffer changes nothing', () => {
  assert.equal(recommendedEmergencyTargetCents(200_000, 3, 0), 600_000)
  assert.equal(recommendedEmergencyTargetCents(200_000, 3, -5_000), 600_000)
  assert.equal(recommendedEmergencyTargetCents(200_000, 3, Number.NaN), 600_000)
})

test('zero essentials still honours the buffer', () => {
  assert.equal(recommendedEmergencyTargetCents(0, 3, 25_000), 25_000)
})

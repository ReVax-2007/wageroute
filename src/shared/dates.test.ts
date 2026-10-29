import assert from 'node:assert/strict'
import test from 'node:test'
import { isISODate, addDaysISO, fromISODate } from './dates'

test('isISODate accepts real calendar dates', () => {
  for (const value of ['2026-10-29', '2024-02-29', '2026-01-31', '1999-12-31']) {
    assert.equal(isISODate(value), true, value)
  }
})

test('isISODate rejects impossible days and months', () => {
  for (const value of ['2026-02-31', '2026-13-01', '2026-00-10', '2026-04-31', '0000-00-00']) {
    assert.equal(isISODate(value), false, value)
  }
})

test('isISODate rejects the wrong shape', () => {
  for (const value of ['2026-1-05', '26-01-05', '2026/01/05', ' 2026-01-05', 20260105, null]) {
    assert.equal(isISODate(value), false, String(value))
  }
})

test('a 29 February in a common year is not a date', () => {
  assert.equal(isISODate('2023-02-29'), false)
  assert.equal(isISODate('2023-03-01'), true)
})

test('date arithmetic still round-trips through a leap day', () => {
  assert.equal(addDaysISO('2024-02-28', 1), '2024-02-29')
  assert.equal(addDaysISO('2024-02-29', 1), '2024-03-01')
  assert.equal(fromISODate('2024-02-29').getUTCDate(), 29)
})

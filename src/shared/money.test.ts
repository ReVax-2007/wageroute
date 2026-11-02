import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseMoneyToCents, sanitizeMoneyInput, sanitizePercentInput } from './money'

test('money input keeps digits, one point and two decimals', () => {
  assert.equal(sanitizeMoneyInput('1234.56'), '1234.56')
  assert.equal(sanitizeMoneyInput('12.3'), '12.3')
  assert.equal(sanitizeMoneyInput('12.'), '12.')
  assert.equal(sanitizeMoneyInput('1.234'), '1.23')
  assert.equal(sanitizeMoneyInput('1.2.3'), '1.23')
})

test('money input strips symbols, spaces and thousand separators', () => {
  assert.equal(sanitizeMoneyInput('$1,850.00'), '1850.00')
  assert.equal(sanitizeMoneyInput('USD 1 850'), '1850')
  assert.equal(sanitizeMoneyInput('abc'), '')
  assert.equal(sanitizeMoneyInput(''), '')
})

test('a minus survives only when negatives are allowed and it leads', () => {
  assert.equal(sanitizeMoneyInput('-45.10', { allowNegative: true }), '-45.10')
  assert.equal(sanitizeMoneyInput('-45.10'), '45.10')
  assert.equal(sanitizeMoneyInput('4-5', { allowNegative: true }), '45')
  assert.equal(sanitizeMoneyInput('--5', { allowNegative: true }), '-5')
  assert.equal(sanitizeMoneyInput('5-', { allowNegative: true }), '5')
})

test('percent input never carries a sign and caps at two decimals', () => {
  assert.equal(sanitizePercentInput('-12.5'), '12.5')
  assert.equal(sanitizePercentInput('99.999'), '99.99')
  assert.equal(sanitizePercentInput(' 20 % '), '20')
})

test('sanitized money still parses to the same cents', () => {
  for (const raw of ['$1,850.00', '1,850', '1850.0', '1850.01']) {
    assert.equal(parseMoneyToCents(sanitizeMoneyInput(raw)), parseMoneyToCents(raw))
  }
})

test('a comma reads as a decimal when that is the only sensible reading', () => {
  assert.equal(parseMoneyToCents('12,50'), 1250)
  assert.equal(parseMoneyToCents('0,99'), 99)
  assert.equal(parseMoneyToCents(',50'), 50)
})

test('a comma reads as grouping when every group is three digits', () => {
  assert.equal(parseMoneyToCents('1,850'), 185000)
  assert.equal(parseMoneyToCents('1,250'), 125000)
  assert.equal(parseMoneyToCents('1,234,567'), 123456700)
})

test('two separators follow the rightmost one', () => {
  assert.equal(parseMoneyToCents('1.234,56'), 123456)
  assert.equal(parseMoneyToCents('1,234.56'), 123456)
  assert.equal(parseMoneyToCents('1.234.567,89'), 123456789)
})

test('malformed grouping is refused rather than guessed at', () => {
  assert.equal(parseMoneyToCents('1,2345'), null)
  assert.equal(parseMoneyToCents('1.23,45'), null)
  assert.equal(parseMoneyToCents('1,23.45'), null)
  assert.equal(parseMoneyToCents('1,'), null)
})

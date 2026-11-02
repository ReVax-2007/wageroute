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

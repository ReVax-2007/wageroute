import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ADJUSTMENT_PRESETS,
  adjustmentFor,
  adjustmentPresetsFor
} from './adjustments'

test('every adjustment reason posts one truthful memo and category', () => {
  assert.deepEqual(adjustmentFor('correction'), {
    memo: 'Balance adjustment',
    category: 'Adjustment'
  })
  assert.deepEqual(adjustmentFor('rounding'), {
    memo: 'Rounding adjustment',
    category: 'Adjustment'
  })
  assert.deepEqual(adjustmentFor('interest_earned'), {
    memo: 'Interest earned',
    category: 'Income'
  })
  assert.deepEqual(adjustmentFor('interest_charged'), {
    memo: 'Interest charged',
    category: 'Adjustment'
  })
  assert.deepEqual(adjustmentFor('investment_gain'), {
    memo: 'Investment gain',
    category: 'Investing'
  })
  assert.deepEqual(adjustmentFor('investment_loss'), {
    memo: 'Investment loss',
    category: 'Investing'
  })
})

test('each reason appears once and writes its own label', () => {
  const values = ADJUSTMENT_PRESETS.map((preset) => preset.value)
  assert.equal(new Set(values).size, values.length)
  for (const preset of ADJUSTMENT_PRESETS) {
    assert.equal(preset.label.length > 0, true)
    assert.equal(preset.hint.length > 0, true)
    assert.notEqual(preset.memo, '')
    assert.notEqual(preset.category, '')
  }
})

test('an account only offers reasons that make sense for it', () => {
  const checking = adjustmentPresetsFor('checking').map((preset) => preset.value)
  assert.ok(checking.includes('interest_earned'))
  assert.ok(!checking.includes('investment_gain'))
  assert.ok(!checking.includes('interest_charged'))

  const credit = adjustmentPresetsFor('credit').map((preset) => preset.value)
  assert.ok(credit.includes('interest_charged'))
  assert.ok(!credit.includes('interest_earned'))
  assert.ok(!credit.includes('investment_loss'))

  const investment = adjustmentPresetsFor('investment').map((preset) => preset.value)
  assert.ok(investment.includes('investment_gain'))
  assert.ok(investment.includes('investment_loss'))
  assert.ok(investment.includes('interest_earned'))
  assert.ok(!investment.includes('interest_charged'))
})

test('every account keeps the plain correction and rounding options', () => {
  for (const kind of ['checking', 'savings', 'cash', 'investment', 'credit'] as const) {
    const values = adjustmentPresetsFor(kind).map((preset) => preset.value)
    assert.ok(values.includes('correction'), `${kind} can correct a mistake`)
    assert.ok(values.includes('rounding'), `${kind} can record a rounding difference`)
  }
})

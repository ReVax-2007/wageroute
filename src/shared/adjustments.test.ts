import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ADJUSTMENT_PRESETS,
  adjustmentFor,
  adjustmentPresetsFor,
  resolveAdjustBalance
} from './adjustments'
import type { AdjustMode } from './adjustments'

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

test('the three credit answers reach the same owed figure', () => {
  const card = { kind: 'credit', balanceCents: -42_000, creditLimitCents: 200_000 } as const
  const forms: { mode: AdjustMode; value: string }[] = [
    { mode: 'owed', value: '420.00' },
    { mode: 'available', value: '1,580.00' },
    { mode: 'percent', value: '21' }
  ]
  const targets = forms.map((form) =>
    resolveAdjustBalance(card, { ...form, reason: 'correction' }).targetBalanceCents
  )
  assert.deepEqual(targets, [-42_000, -42_000, -42_000])
})

test('a utilization is percentage points, never money', () => {
  const card = { kind: 'credit', balanceCents: -42_000, creditLimitCents: 200_000 } as const
  const asPercent = resolveAdjustBalance(card, {
    mode: 'percent',
    value: '5',
    reason: 'correction'
  })
  const asMoney = resolveAdjustBalance(card, { mode: 'owed', value: '5.00', reason: 'correction' })
  assert.equal(asPercent.targetBalanceCents, -10_000)
  assert.equal(asMoney.targetBalanceCents, -500)
})

test('a card with no limit can only be adjusted by the amount itself', () => {
  const card = { kind: 'credit', balanceCents: -42_000, creditLimitCents: null } as const
  const resolved = resolveAdjustBalance(card, {
    mode: 'available',
    value: '100.00',
    reason: 'correction'
  })
  assert.equal(resolved.mode, 'owed')
  assert.equal(resolved.targetBalanceCents, -10_000)
  assert.equal(resolved.owedAfterCents, null)
})

test('an amount written as credit is read as credit', () => {
  const overpaid = { kind: 'credit', balanceCents: 5_000, creditLimitCents: 200_000 } as const
  const resolved = resolveAdjustBalance(overpaid, {
    mode: 'owed',
    value: '-50.00',
    reason: 'correction'
  })
  assert.equal(resolved.targetBalanceCents, 5_000)
  assert.equal(resolved.deltaCents, 0)
})

test('a reason that contradicts the direction is refused in words', () => {
  const savings = { kind: 'savings', balanceCents: 100_000, creditLimitCents: null } as const
  const earned = resolveAdjustBalance(savings, {
    mode: 'owed',
    value: '50.00',
    reason: 'interest_earned'
  })
  assert.equal(
    earned.problem,
    'Interest earned should raise the balance. Pick a loss or interest charged instead.'
  )
  assert.equal(earned.targetBalanceCents, null)

  const holding = { kind: 'investment', balanceCents: 100_00, creditLimitCents: null } as const
  const loss = resolveAdjustBalance(holding, {
    mode: 'owed',
    value: '150.00',
    reason: 'investment_loss'
  })
  assert.equal(
    loss.problem,
    'Investment loss should lower the balance. Pick a gain or interest earned instead.'
  )

  // A reason that this account type cannot offer falls back to the plain
  // correction, so the refusal still names something the person can pick.
  const notOffered = resolveAdjustBalance(savings, {
    mode: 'owed',
    value: '1,500.00',
    reason: 'investment_loss'
  })
  assert.equal(
    notOffered.problem,
    'Correct a mistake should lower the balance. Pick a gain or interest earned instead.'
  )
})

test('an unusable amount says which kind of answer is missing', () => {
  const card = { kind: 'credit', balanceCents: -42_000, creditLimitCents: 200_000 } as const
  assert.equal(
    resolveAdjustBalance(card, { mode: 'owed', value: ' ', reason: 'correction' }).problem,
    'Enter a balance'
  )
  assert.equal(
    resolveAdjustBalance(card, { mode: 'percent', value: '12.345', reason: 'correction' }).problem,
    'Enter a utilization percentage'
  )
})

test('the preview states the three figures the card would show', () => {
  const card = { kind: 'credit', balanceCents: -42_000, creditLimitCents: 200_000 } as const
  const resolved = resolveAdjustBalance(card, { mode: 'percent', value: '30', reason: 'correction' })
  assert.equal(resolved.owedAfterCents, 60_000)
  assert.equal(resolved.availableAfterCents, 140_000)
  assert.equal(resolved.usedPercentAfter, 30)
  assert.equal(resolved.deltaCents, -18_000)
})

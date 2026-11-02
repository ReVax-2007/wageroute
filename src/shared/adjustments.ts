import type { AccountKind } from './types'

export type AdjustmentReason =
  | 'correction'
  | 'rounding'
  | 'interest_earned'
  | 'interest_charged'
  | 'investment_gain'
  | 'investment_loss'

export interface AdjustmentPreset {
  value: AdjustmentReason
  label: string
  memo: string
  category: string
  hint: string
  kinds?: readonly AccountKind[]
}

const CASH_KINDS: readonly AccountKind[] = ['checking', 'savings', 'cash']

/**
 * The reason decides the memo and category, so a gain is never filed as a
 * generic correction and reports can tell interest from a typo fix.
 */
export const ADJUSTMENT_PRESETS: readonly AdjustmentPreset[] = [
  {
    value: 'correction',
    label: 'Correct a mistake',
    memo: 'Balance adjustment',
    category: 'Adjustment',
    hint: 'Use this when the ledger and the bank disagree for no clearer reason.'
  },
  {
    value: 'rounding',
    label: 'Rounding or small difference',
    memo: 'Rounding adjustment',
    category: 'Adjustment',
    hint: 'For a few cents left over from a purchase or a split.'
  },
  {
    value: 'interest_earned',
    label: 'Interest earned',
    memo: 'Interest earned',
    category: 'Income',
    hint: 'The bank or broker paid interest into this account.',
    kinds: [...CASH_KINDS, 'investment']
  },
  {
    value: 'interest_charged',
    label: 'Interest charged',
    memo: 'Interest charged',
    category: 'Adjustment',
    hint: 'Interest was added to the card balance.',
    kinds: ['credit']
  },
  {
    value: 'investment_gain',
    label: 'Investment gain',
    memo: 'Investment gain',
    category: 'Investing',
    hint: 'The holding is worth more than the ledger says.',
    kinds: ['investment']
  },
  {
    value: 'investment_loss',
    label: 'Investment loss',
    memo: 'Investment loss',
    category: 'Investing',
    hint: 'The holding is worth less than the ledger says.',
    kinds: ['investment']
  }
]

export function adjustmentPresetsFor(kind: AccountKind): readonly AdjustmentPreset[] {
  return ADJUSTMENT_PRESETS.filter((preset) => !preset.kinds || preset.kinds.includes(kind))
}

export function adjustmentFor(reason: AdjustmentReason): { memo: string; category: string } {
  const preset = ADJUSTMENT_PRESETS.find((candidate) => candidate.value === reason)
  return preset
    ? { memo: preset.memo, category: preset.category }
    : { memo: 'Balance adjustment', category: 'Adjustment' }
}

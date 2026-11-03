import { owedCentsAtUtilization, parseUtilizationPercent } from './credit'
import { parseMoneyToCents } from './money'
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

/** Which of a card's three figures the person is typing into. */
export type AdjustMode = 'owed' | 'available' | 'percent'

export const ADJUST_MODES: readonly { value: AdjustMode; label: string }[] = [
  { value: 'owed', label: 'Amount owed' },
  { value: 'available', label: 'Available credit' },
  { value: 'percent', label: 'Utilization' }
]

export interface AdjustBalanceContext {
  kind: AccountKind
  balanceCents: number
  creditLimitCents: number | null
}

export interface AdjustBalanceForm {
  mode: AdjustMode
  /** Raw text from the money or the percentage field, exactly as typed. */
  value: string
  reason: AdjustmentReason
}

export interface AdjustBalanceResult {
  /** One sentence, in the desktop's own words, when the answer cannot be used. */
  problem: string | null
  preset: AdjustmentPreset
  /** The mode the form can actually offer — a card without a limit has one. */
  mode: AdjustMode
  /** What the account balance becomes, in the ledger's signed cents. */
  targetBalanceCents: number | null
  deltaCents: number | null
  owedAfterCents: number | null
  availableAfterCents: number | null
  usedPercentAfter: number | null
}

/**
 * One reading of the adjust-balance form, used by the desktop dialog and the
 * phone sheet alike.
 *
 * A card is stored as a negative balance and shown as money owed, and a bank
 * answers "what do you want the card to say" three different ways — the amount
 * owed, the room left under the limit, or the percentage of it in use. Every
 * answer is resolved to an owed figure first and flipped into the ledger's sign
 * last, so the same target is reached whichever box was typed into. Utilisation
 * is percentage points, never money: `5` means five per cent of the limit, and
 * reading it as cents would ask for fifty times the card.
 */
export function resolveAdjustBalance(
  context: AdjustBalanceContext,
  form: AdjustBalanceForm
): AdjustBalanceResult {
  const presets = adjustmentPresetsFor(context.kind)
  const preset = presets.find((candidate) => candidate.value === form.reason) ?? presets[0]
  const isCredit = context.kind === 'credit'
  const limit = context.creditLimitCents
  // Room left and utilisation both describe a limit. Without one the form only
  // has the amount itself, on either device.
  const canUseCreditModes = isCredit && limit !== null && limit > 0
  const mode: AdjustMode = canUseCreditModes ? form.mode : 'owed'

  const refused = (problem: string): AdjustBalanceResult => ({
    problem,
    preset,
    mode,
    targetBalanceCents: null,
    deltaCents: null,
    owedAfterCents: null,
    availableAfterCents: null,
    usedPercentAfter: null
  })

  let owedCents: number
  if (mode === 'percent') {
    const percent = parseUtilizationPercent(form.value)
    const derived = percent === null || limit === null ? null : owedCentsAtUtilization(limit, percent)
    if (derived === null) return refused('Enter a utilization percentage')
    owedCents = derived
  } else {
    const typed = parseMoneyToCents(form.value)
    if (typed === null) return refused('Enter a balance')
    owedCents = mode === 'available' && limit !== null ? limit - typed : typed
  }

  const targetBalanceCents = Math.round(isCredit ? -owedCents : owedCents)
  const deltaCents = targetBalanceCents - context.balanceCents
  const raises = form.reason === 'investment_gain' || form.reason === 'interest_earned'
  const lowers = form.reason === 'investment_loss' || form.reason === 'interest_charged'
  if (raises && deltaCents < 0) {
    return refused(`${preset.label} should raise the balance. Pick a loss or interest charged instead.`)
  }
  if (lowers && deltaCents > 0) {
    return refused(`${preset.label} should lower the balance. Pick a gain or interest earned instead.`)
  }

  return {
    problem: null,
    preset,
    mode,
    targetBalanceCents,
    deltaCents,
    owedAfterCents: canUseCreditModes ? owedCents : null,
    availableAfterCents:
      canUseCreditModes && limit !== null ? Math.max(0, limit - owedCents) : null,
    usedPercentAfter:
      canUseCreditModes && limit !== null
        ? Math.max(0, Math.round((owedCents / limit) * 1000) / 10)
        : null
  }
}

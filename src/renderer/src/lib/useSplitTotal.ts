import { useState, type Dispatch, type SetStateAction } from 'react'
import { centsToEditable, parseMoneyToCents } from '@shared/money'
import {
  FULL_BPS,
  centsToBps,
  formatBps,
  parsePercentToBps,
  resolveSplitShares,
  restOnLine,
  splitEvenly,
  splitTotalBalance,
  splitTotalProblem,
  type RoundingAdjustment,
  type SplitShare
} from '@shared/splitTotal'

/** Add the lines up to a total, or start from the total and share it out. */
export type SplitEntry = 'lines' | 'total'
export type ShareUnit = 'amount' | 'percent'

export const NO_SHARE: SplitShare = { kind: 'cents', cents: 0 }

/** What a split line needs for both ways of entering it. */
export interface ShareLine {
  key: number
  /** The typed amount when adding the lines up. */
  amount: string
  /** The share when splitting a total, in the unit it was last set in. */
  share: SplitShare
}

/** "Travel takes 1¢ less" for each line rounding moved, so nobody wonders. */
export function roundingNote(
  adjustments: readonly RoundingAdjustment[],
  nameOf: (index: number) => string
): string | null {
  if (adjustments.length === 0) return null
  const parts = adjustments.map(
    ({ index, deltaCents }) =>
      `${nameOf(index)} takes ${Math.abs(deltaCents)}¢ ${deltaCents > 0 ? 'more' : 'less'}`
  )
  return `Rounding: ${parts.join(', ')} so the lines add up to the cent.`
}

/**
 * The "Split a total" state the desktop form and the phone sheet share: the
 * total, the unit shares are typed in, the field being typed in, and the
 * line amounts that follow from them. The arithmetic is `@shared/splitTotal`.
 */
export function useSplitTotal<L extends ShareLine>(
  lines: readonly L[],
  setLines: Dispatch<SetStateAction<L[]>>,
  currency: string
) {
  const [entry, setEntry] = useState<SplitEntry>('lines')
  const [unit, setUnitState] = useState<ShareUnit>('amount')
  const [goalText, setGoalText] = useState('')
  // The share field being typed in keeps its own text until focus leaves.
  const [editing, setEditing] = useState<{ key: number; text: string } | null>(null)
  // An even split says which line rounding moved until a share changes again.
  const [evenAdjustments, setEvenAdjustments] = useState<RoundingAdjustment[]>([])

  const splitting = entry === 'total'
  const goalCents = Math.max(0, parseMoneyToCents(goalText) ?? 0)
  const resolved = resolveSplitShares(
    goalCents,
    lines.map((line) => line.share)
  )
  const balance = splitTotalBalance(goalCents, resolved.cents)
  const goalProblem = splitting ? splitTotalProblem(goalCents, resolved.cents, currency) : null

  const setShare = (key: number, share: SplitShare) => {
    setEvenAdjustments([])
    setLines((current) => current.map((line) => (line.key === key ? { ...line, share } : line)))
  }

  const shareText = (line: L, index: number): string => {
    if (editing?.key === line.key) return editing.text
    const cents = resolved.cents[index] ?? 0
    if (unit === 'percent') {
      const bps = line.share.kind === 'bps' ? line.share.bps : centsToBps(goalCents, cents)
      return bps > 0 ? formatBps(bps) : ''
    }
    return cents > 0 ? centsToEditable(cents) : ''
  }

  return {
    entry,
    splitting,
    unit,
    goalText,
    goalCents,
    resolved,
    balance,
    goalProblem,

    /** The amount a line saves with, whichever way the split is entered. */
    lineCents: (line: L, index: number): number =>
      splitting ? (resolved.cents[index] ?? 0) : (parseMoneyToCents(line.amount) ?? 0),

    note: (nameOf: (index: number) => string): string | null =>
      splitting
        ? roundingNote(evenAdjustments.length > 0 ? evenAdjustments : resolved.adjustments, nameOf)
        : null,

    /** Switching carries what was typed across instead of starting over. */
    switchEntry: (next: SplitEntry) => {
      if (next === entry) return
      setEditing(null)
      setEvenAdjustments([])
      if (next === 'total') {
        const typed = lines.map((line) => Math.max(0, parseMoneyToCents(line.amount) ?? 0))
        const sum = typed.reduce((total, cents) => total + cents, 0)
        if (!goalText && sum > 0) setGoalText(centsToEditable(sum))
        setLines((current) =>
          current.map((line, index) => ({ ...line, share: { kind: 'cents', cents: typed[index] ?? 0 } }))
        )
      } else {
        setLines((current) =>
          current.map((line, index) => {
            const cents = resolved.cents[index] ?? 0
            return { ...line, amount: cents > 0 ? centsToEditable(cents) : '' }
          })
        )
      }
      setEntry(next)
    },

    setGoal: (text: string) => {
      setGoalText(text)
      setEvenAdjustments([])
    },

    setUnit: (next: ShareUnit) => {
      setEditing(null)
      setUnitState(next)
    },

    shareText,
    focusShare: (line: L, index: number) => setEditing({ key: line.key, text: shareText(line, index) }),
    blurShare: () => setEditing(null),

    typeShare: (key: number, text: string) => {
      setEditing({ key, text })
      setShare(
        key,
        unit === 'percent'
          ? { kind: 'bps', bps: parsePercentToBps(text) ?? 0 }
          : { kind: 'cents', cents: Math.max(0, parseMoneyToCents(text) ?? 0) }
      )
    },

    /** A slider's value: basis points by percent, cents by amount. */
    slide: (key: number, value: number) => {
      setEditing(null)
      const clean = Math.max(0, Math.round(Number.isFinite(value) ? value : 0))
      setShare(
        key,
        unit === 'percent'
          ? { kind: 'bps', bps: Math.min(FULL_BPS, clean) }
          : { kind: 'cents', cents: Math.min(goalCents, clean) }
      )
    },

    takeRest: (key: number, index: number) => {
      setEditing(null)
      setShare(key, { kind: 'cents', cents: restOnLine(goalCents, resolved.cents, index) })
    },

    splitEven: () => {
      setEditing(null)
      const even = splitEvenly(goalCents, lines.length)
      setLines((current) =>
        current.map((line, index) => ({ ...line, share: { kind: 'cents', cents: even.cents[index] ?? 0 } }))
      )
      setEvenAdjustments(even.adjustments)
    },

    /** Adding or removing a line makes an earlier rounding note stale. */
    linesChanged: () => setEvenAdjustments([]),

    /** After a save: percent shares are the part that repeats; amounts start again. */
    reset: () => {
      setLines((current) =>
        current.map((line) => ({ ...line, share: line.share.kind === 'bps' ? line.share : NO_SHARE }))
      )
      setGoalText('')
      setEditing(null)
      setEvenAdjustments([])
    }
  }
}

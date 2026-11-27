import { formatMoney, sanitizePercentInput } from './money'

/**
 * "Split a total": the person names the amount to move first, then shares it
 * out across the split's lines by amount or by percent (ADR 0033 addendum).
 * Everything here is integer cents and integer basis points (1% = 100 bps), so
 * the lines always add up to the cent and the desktop and the phone agree.
 * Saving still goes through `planSplitTransfer`: this only decides each line's
 * `amountCents`.
 */

export const FULL_BPS = 10_000

/** A line's share, kept in the unit it was last set in. */
export type SplitShare = { kind: 'cents'; cents: number } | { kind: 'bps'; bps: number }

export interface RoundingAdjustment {
  /** The line whose amount was nudged so the lines add up exactly. */
  index: number
  /** +1 when it took an extra cent, -1 when it gave one up. */
  deltaCents: number
}

export interface DistributedCents {
  cents: number[]
  /** Lines that differ from plain rounding, so the form can say which. */
  adjustments: RoundingAdjustment[]
}

const whole = (value: number): number => (Number.isSafeInteger(value) && value > 0 ? value : 0)

/**
 * Shares `totalCents` out by `weights` so the parts add up to the total
 * exactly. Each part starts at its floor; the cents left over go one each to
 * the parts with the largest fractional remainder, ties to the earlier line.
 */
export function distributeCents(totalCents: number, weights: readonly number[]): DistributedCents {
  const total = whole(totalCents)
  const clean = weights.map(whole)
  const weightSum = clean.reduce((sum, weight) => sum + weight, 0)
  if (total === 0 || weightSum === 0) {
    return { cents: clean.map(() => 0), adjustments: [] }
  }
  // Integer arithmetic: total × weight stays well inside a safe integer for
  // any real balance and weights up to FULL_BPS.
  const cents = clean.map((weight) => Math.floor((total * weight) / weightSum))
  const remainders = clean.map((weight, index) => ({
    index,
    remainder: (total * weight) % weightSum
  }))
  let left = total - cents.reduce((sum, part) => sum + part, 0)
  remainders.sort((a, b) => b.remainder - a.remainder || a.index - b.index)
  for (const { index } of remainders) {
    if (left === 0) break
    cents[index] += 1
    left -= 1
  }
  const adjustments: RoundingAdjustment[] = []
  cents.forEach((part, index) => {
    const plain = Math.round((total * clean[index]) / weightSum)
    if (part !== plain) adjustments.push({ index, deltaCents: part - plain })
  })
  return { cents, adjustments }
}

/** An even split: $500 three ways is $166.67, $166.67 and $166.66. */
export function splitEvenly(totalCents: number, lines: number): DistributedCents {
  return distributeCents(totalCents, Array.from({ length: Math.max(0, lines) }, () => 1))
}

/** A percent of the total in cents, rounded half away from zero. */
export function bpsToCents(totalCents: number, bps: number): number {
  return Math.round((whole(totalCents) * whole(bps)) / FULL_BPS)
}

/** What share of the total an amount is, in basis points (0 when there is no total). */
export function centsToBps(totalCents: number, cents: number): number {
  const total = whole(totalCents)
  if (total === 0) return 0
  return Math.round((whole(cents) * FULL_BPS) / total)
}

/**
 * Every line's amount in cents. Amount lines keep their cents. Percent lines
 * share, between them, their combined percent of the total rounded once, so
 * percents that add up to 100% always land on the total to the cent.
 */
export function resolveSplitShares(totalCents: number, shares: readonly SplitShare[]): DistributedCents {
  const percentIndexes: number[] = []
  const cents = shares.map((share, index) => {
    if (share.kind === 'cents') return whole(share.cents)
    percentIndexes.push(index)
    return 0
  })
  const weights = percentIndexes.map((index) => {
    const share = shares[index]
    return share.kind === 'bps' ? whole(share.bps) : 0
  })
  const percentTotal = bpsToCents(totalCents, weights.reduce((sum, bps) => sum + bps, 0))
  const shared = distributeCents(percentTotal, weights)
  percentIndexes.forEach((index, at) => {
    cents[index] = shared.cents[at]
  })
  return {
    cents,
    adjustments: shared.adjustments.map((adjustment) => ({
      ...adjustment,
      index: percentIndexes[adjustment.index]
    }))
  }
}

export interface SplitTotalBalance {
  allocatedCents: number
  /** What is still to place: negative when the lines are over the total. */
  leftCents: number
}

export function splitTotalBalance(totalCents: number, cents: readonly number[]): SplitTotalBalance {
  const allocatedCents = cents.reduce((sum, part) => sum + whole(part), 0)
  return { allocatedCents, leftCents: whole(totalCents) - allocatedCents }
}

/**
 * Why the shares cannot be saved yet, or `null` when they add up to the total
 * exactly. The line-by-line rules (accounts, credit cards, duplicates) stay
 * with `splitTransferProblem`.
 */
export function splitTotalProblem(
  totalCents: number,
  cents: readonly number[],
  currency = 'USD'
): string | null {
  if (whole(totalCents) === 0) return 'Enter the total to move'
  const { leftCents } = splitTotalBalance(totalCents, cents)
  if (leftCents > 0) return `${formatMoney(leftCents, currency)} is still to place`
  if (leftCents < 0) return `The lines are ${formatMoney(-leftCents, currency)} over the total`
  return null
}

/** The amount that makes one line take whatever is left (or give back what is over). */
export function restOnLine(totalCents: number, cents: readonly number[], index: number): number {
  const { leftCents } = splitTotalBalance(totalCents, cents)
  return Math.max(0, whole(cents[index] ?? 0) + leftCents)
}

/** A typed percent (`33.33`, `12,5`, `40%`) in basis points, capped at 100%. */
export function parsePercentToBps(raw: string): number | null {
  const text = sanitizePercentInput(raw)
  if (!text || text === '.') return null
  const value = Number(text)
  if (!Number.isFinite(value)) return null
  return Math.min(FULL_BPS, Math.round(value * 100))
}

/** Basis points as a percent with at most two decimals: 3333 → "33.33", 5000 → "50". */
export function formatBps(bps: number): string {
  const value = whole(bps)
  const units = Math.floor(value / 100)
  const hundredths = value % 100
  if (hundredths === 0) return String(units)
  return `${units}.${String(hundredths).padStart(2, '0').replace(/0$/, '')}`
}

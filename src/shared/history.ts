import { addDaysISO, daysBetweenISO } from './dates'
import type { Account, BalanceSnapshot } from './types'

export interface NetWorthPoint {
  onDate: string
  netWorthCents: number
  /** Accounts with a recorded balance on or before this date. */
  accountCount: number
}

/**
 * Turns the sparse daily rows into a continuous series. A day the app was not
 * opened does not mean the balance was zero, so each account carries its last
 * known value forward; only accounts already seen count towards a date.
 *
 * The result is per-day between the first recorded date and `untilISO`, which
 * lets the dashboard draw a flat line for a quiet week instead of a gap.
 */
export function netWorthSeries(input: {
  snapshots: readonly BalanceSnapshot[]
  accounts: readonly Account[]
  untilISO: string
  /** Cap the series so a decade-old ledger does not draw 4,000 points. */
  maxPoints?: number
}): NetWorthPoint[] {
  const include = new Set(input.accounts.map((account) => account.id))
  const rows = input.snapshots
    .filter((row) => include.has(row.accountId) && row.onDate <= input.untilISO)
    .sort((a, b) => a.onDate.localeCompare(b.onDate))
  if (rows.length === 0) return []

  const balanceByAccount = new Map<string, number>()
  const points: NetWorthPoint[] = []
  const firstDate = rows[0].onDate
  let cursor = 0
  let day = firstDate

  // Walk calendar days and fold in every row dated that day. Days before an
  // account's first row leave it out, so the line starts with what was known.
  const span = Math.max(0, daysBetweenISO(firstDate, input.untilISO))
  for (let offset = 0; offset <= span; offset += 1) {
    day = addDaysISO(firstDate, offset)
    while (cursor < rows.length && rows[cursor].onDate === day) {
      balanceByAccount.set(rows[cursor].accountId, rows[cursor].balanceCents)
      cursor += 1
    }
    if (balanceByAccount.size === 0) continue
    let total = 0
    for (const cents of balanceByAccount.values()) total += cents
    points.push({ onDate: day, netWorthCents: total, accountCount: balanceByAccount.size })
  }

  const maxPoints = input.maxPoints ?? 90
  if (points.length <= maxPoints) return points
  // Keep the newest point for each bucket so the last day is always exact.
  const step = Math.ceil(points.length / maxPoints)
  const sampled = points.filter((_, index) => index % step === 0)
  const last = points[points.length - 1]
  if (sampled[sampled.length - 1]?.onDate !== last.onDate) sampled.push(last)
  return sampled
}

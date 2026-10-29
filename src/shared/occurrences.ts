import { addDaysISO, daysBetweenISO, fromISODate, toISODate } from './dates'
import type { Frequency } from './types'

/**
 * One recurrence engine for every screen that needs bill dates: the chronology
 * prompts, the 90-day projection and the wall's reserve cycles. Frequency is
 * part of the schedule instead of being treated as "monthly".
 */
export interface RecurringBill {
  id: string
  amountCents: number
  frequency: Frequency
  dueDay: number
  /** A known occurrence; takes over as the series anchor when present. */
  nextDueOn: string | null
}

const DAY_STEPS: Partial<Record<Frequency, number>> = {
  weekly: 7,
  biweekly: 14
}

const MONTH_STEPS: Partial<Record<Frequency, number>> = {
  monthly: 1,
  quarterly: 3,
  annual: 12
}

const SEARCH_DAYS = 400

function clampDay(day: number): number {
  const rounded = Math.round(day)
  return Number.isFinite(rounded) ? Math.min(31, Math.max(1, rounded)) : 1
}

function daysInMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate()
}

function dayInMonth(year: number, monthIndex: number, day: number): string {
  const clamped = Math.min(clampDay(day), daysInMonth(year, monthIndex))
  return toISODate(new Date(Date.UTC(year, monthIndex, clamped)))
}

function monthIndexOf(iso: string): number {
  const date = fromISODate(iso)
  return date.getUTCFullYear() * 12 + date.getUTCMonth()
}

function monthStartOf(index: number, day: number): string {
  const year = Math.floor(index / 12)
  const month = index % 12
  return dayInMonth(year, month, day)
}

/** The two days-of-month a semimonthly bill lands on, derived from its due day. */
export function semimonthlyDays(dueDay: number): [number, number] {
  const day = clampDay(dueDay)
  const partner = day <= 15 ? day + 15 : day - 15
  return [Math.min(day, partner), Math.max(day, partner)]
}

/**
 * The known occurrence the series is projected from. Without `nextDueOn` the
 * bill's due day in the reference month stands in, which keeps an imported or
 * hand-entered bill in the right phase of its cycle.
 */
export function billSeriesAnchor(bill: RecurringBill, referenceISO: string): string {
  if (bill.nextDueOn) return bill.nextDueOn
  const month = monthIndexOf(referenceISO)
  return monthStartOf(month, bill.dueDay)
}

/**
 * Every occurrence in `[fromISO, toISO]`, ascending. The anchor month (or day)
 * is walked in both directions, so a series whose `nextDueOn` is in the past
 * still produces the current cycle.
 */
export function billOccurrencesBetween(
  bill: RecurringBill,
  fromISO: string,
  toISO: string
): string[] {
  if (fromISO > toISO) return []
  const anchor = billSeriesAnchor(bill, fromISO)
  const dates: string[] = []

  const dayStep = DAY_STEPS[bill.frequency]
  if (dayStep) {
    const offset = daysBetweenISO(anchor, fromISO)
    const first = Math.floor(offset / dayStep) - 1
    const last = Math.ceil(daysBetweenISO(anchor, toISO) / dayStep) + 1
    for (let k = first; k <= last; k += 1) {
      const date = addDaysISO(anchor, k * dayStep)
      if (date >= fromISO && date <= toISO) dates.push(date)
    }
    return dates.sort()
  }

  const anchorMonth = monthIndexOf(anchor)
  const fromMonth = monthIndexOf(fromISO)
  const toMonth = monthIndexOf(toISO)
  const step = bill.frequency === 'semimonthly' ? 1 : (MONTH_STEPS[bill.frequency] ?? 1)
  const days =
    bill.frequency === 'semimonthly'
      ? semimonthlyDays(bill.dueDay)
      : [clampDay(bill.dueDay)]

  const startMonth = Math.min(anchorMonth, fromMonth) - step
  const endMonth = Math.max(anchorMonth, toMonth) + step
  for (let month = startMonth; month <= endMonth; month += 1) {
    if (((month - anchorMonth) % step + step) % step !== 0) continue
    for (const day of days) {
      const date = monthStartOf(month, day)
      if (date >= fromISO && date <= toISO) dates.push(date)
    }
  }

  return dates.sort()
}

/** The most recent occurrence on or before `onOrBeforeISO`. */
export function previousBillOccurrence(bill: RecurringBill, onOrBeforeISO: string): string {
  const window = billOccurrencesBetween(
    bill,
    addDaysISO(onOrBeforeISO, -SEARCH_DAYS),
    onOrBeforeISO
  )
  return window.length > 0
    ? window[window.length - 1]
    : addDaysISO(onOrBeforeISO, -SEARCH_DAYS)
}

/** The next occurrence on or after `onOrAfterISO`. */
export function nextBillOccurrence(bill: RecurringBill, onOrAfterISO: string): string {
  const window = billOccurrencesBetween(
    bill,
    onOrAfterISO,
    addDaysISO(onOrAfterISO, SEARCH_DAYS)
  )
  return window.length > 0 ? window[0] : addDaysISO(onOrAfterISO, SEARCH_DAYS)
}

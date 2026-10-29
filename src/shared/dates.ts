import type { Frequency } from './types'

const MS_PER_DAY = 86_400_000

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

export function isISODate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(0)
  date.setUTCFullYear(year, month - 1, day)
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  )
}

export function todayISO(date = new Date()): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export function toISODate(date: Date): string {
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
}

export function fromISODate(iso: string): Date {
  const [year, month, day] = iso.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day))
}

export function addDaysISO(iso: string, days: number): string {
  return toISODate(new Date(fromISODate(iso).getTime() + days * MS_PER_DAY))
}

export function addMonthsISO(iso: string, months: number): string {
  const source = fromISODate(iso)
  const year = source.getUTCFullYear()
  const month = source.getUTCMonth() + months
  const day = source.getUTCDate()
  const daysInTarget = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
  return toISODate(new Date(Date.UTC(year, month, Math.min(day, daysInTarget))))
}

export function daysBetweenISO(from: string, to: string): number {
  return Math.round((fromISODate(to).getTime() - fromISODate(from).getTime()) / MS_PER_DAY)
}

export function monthsUntil(targetISO: string, fromISO: string): number {
  const days = daysBetweenISO(fromISO, targetISO)
  return Math.max(1, Math.ceil(days / 30.4375))
}

export function nextDueDateISO(dueDay: number, fromISO: string): string {
  const from = fromISODate(fromISO)
  const day = Math.min(Math.max(1, Math.round(dueDay)), 31)
  const daysThisMonth = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 0)).getUTCDate()
  const candidate = new Date(
    Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), Math.min(day, daysThisMonth))
  )
  if (candidate.getTime() < from.getTime()) {
    return addMonthsISO(toISODate(candidate), 1)
  }
  return toISODate(candidate)
}

/**
 * The most recent occurrence of a monthly due day on or before `fromISO`.
 * Used by the chronology engine to ask whether a bill has already cleared.
 */
export function previousDueDateISO(dueDay: number, fromISO: string): string {
  const from = fromISODate(fromISO)
  const day = Math.min(Math.max(1, Math.round(dueDay)), 31)
  const daysThisMonth = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 0)).getUTCDate()
  const candidate = new Date(
    Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), Math.min(day, daysThisMonth))
  )
  if (candidate.getTime() > from.getTime()) {
    return addMonthsISO(toISODate(candidate), -1)
  }
  return toISODate(candidate)
}

const dateLabelFormatter = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC'
})

const dateLongFormatter = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'UTC'
})

export function formatDateLabel(iso: string): string {
  return dateLabelFormatter.format(fromISODate(iso))
}

export function formatDateLong(iso: string): string {
  return dateLongFormatter.format(fromISODate(iso))
}

const monthFormatter = new Intl.DateTimeFormat(undefined, {
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC'
})

export function formatMonthLong(monthISO: string): string {
  return monthFormatter.format(fromISODate(`${monthISO.slice(0, 7)}-01`))
}

const STEP_DAYS: Partial<Record<Frequency, number>> = {
  weekly: 7,
  biweekly: 14,
  semimonthly: 15
}

const STEP_MONTHS: Partial<Record<Frequency, number>> = {
  monthly: 1,
  quarterly: 3,
  annual: 12
}

export function advanceByFrequency(iso: string, frequency: Frequency): string {
  const days = STEP_DAYS[frequency]
  if (days) return addDaysISO(iso, days)
  const months = STEP_MONTHS[frequency]
  if (months) return addMonthsISO(iso, months)
  return iso
}

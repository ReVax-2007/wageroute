import { addDaysISO, addMonthsISO } from './dates'
import type { TransactionRow } from './types'

export const EMERGENCY_MONTH_OPTIONS = [3, 4, 5, 6] as const

function monthKey(iso: string): string {
  return iso.slice(0, 7)
}

function monthsInclusive(fromISO: string, toISO: string): number {
  const [fromYear, fromMonth] = monthKey(fromISO).split('-').map(Number)
  const [toYear, toMonth] = monthKey(toISO).split('-').map(Number)
  return Math.max(1, (toYear - fromYear) * 12 + (toMonth - fromMonth) + 1)
}

/**
 * Average monthly variable spending over the recent window, excluding bills
 * (the Priority Wall already covers those) and transfers.
 *
 * Only completed months are averaged. Counting the month in progress makes the
 * figure swing with whenever the screen is opened: a single large purchase on
 * the 1st would read as a whole month's spending, and a quiet first week would
 * read as a frugal month. Until one month has completed, the current month is
 * the only history there is, so it is used as a fallback.
 */
export function averageMonthlyVariableCents(
  transactions: readonly Pick<TransactionRow, 'kind' | 'amountCents' | 'occurredOn'>[],
  todayISO: string,
  windowMonths = 6
): number {
  const currentMonthStart = `${monthKey(todayISO)}-01`
  const lastCompleteDay = addDaysISO(currentMonthStart, -1)
  const windowStart = addMonthsISO(currentMonthStart, -windowMonths)

  const isVariableExpense = (
    transaction: Pick<TransactionRow, 'kind' | 'amountCents'>
  ): boolean => transaction.kind === 'expense' && transaction.amountCents < 0

  const completed = transactions.filter(
    (transaction) =>
      isVariableExpense(transaction) &&
      transaction.occurredOn >= windowStart &&
      transaction.occurredOn <= lastCompleteDay
  )
  if (completed.length > 0) {
    const earliest = completed.reduce(
      (min, transaction) => (transaction.occurredOn < min ? transaction.occurredOn : min),
      completed[0].occurredOn
    )
    const months = monthsInclusive(earliest, lastCompleteDay)
    const total = completed.reduce((sum, transaction) => sum + Math.abs(transaction.amountCents), 0)
    return Math.round(total / months)
  }

  const thisMonth = transactions.filter(
    (transaction) =>
      isVariableExpense(transaction) &&
      transaction.occurredOn >= currentMonthStart &&
      transaction.occurredOn <= todayISO
  )
  if (thisMonth.length === 0) return 0
  return thisMonth.reduce((sum, transaction) => sum + Math.abs(transaction.amountCents), 0)
}

export function emergencyMonthlyEssentialsCents(input: {
  wallMonthlyCents: number
  variableMonthlyCents: number
  includeVariable: boolean
}): number {
  return Math.max(0, input.wallMonthlyCents + (input.includeVariable ? input.variableMonthlyCents : 0))
}

export function recommendedEmergencyTargetCents(
  monthlyEssentialsCents: number,
  months: number
): number {
  const safeMonths = Math.max(0, Math.round(months))
  return Math.max(0, Math.round(monthlyEssentialsCents * safeMonths))
}

export function emergencyCoverageMonths(
  fundedCents: number,
  monthlyEssentialsCents: number
): number {
  if (monthlyEssentialsCents <= 0) return 0
  return Math.max(0, fundedCents) / monthlyEssentialsCents
}

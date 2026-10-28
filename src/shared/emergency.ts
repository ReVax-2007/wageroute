import { addMonthsISO } from './dates'
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
 */
export function averageMonthlyVariableCents(
  transactions: readonly Pick<TransactionRow, 'kind' | 'amountCents' | 'occurredOn'>[],
  todayISO: string,
  windowMonths = 6
): number {
  const currentMonthStart = `${monthKey(todayISO)}-01`
  const windowStart = addMonthsISO(currentMonthStart, -(windowMonths - 1))

  const expenses = transactions.filter(
    (transaction) =>
      transaction.kind === 'expense' &&
      transaction.amountCents < 0 &&
      transaction.occurredOn >= windowStart &&
      transaction.occurredOn <= todayISO
  )
  if (expenses.length === 0) return 0

  const earliest = expenses.reduce(
    (min, transaction) => (transaction.occurredOn < min ? transaction.occurredOn : min),
    expenses[0].occurredOn
  )
  const months = monthsInclusive(earliest, todayISO)
  const total = expenses.reduce((sum, transaction) => sum + Math.abs(transaction.amountCents), 0)
  return Math.round(total / months)
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

import { addDaysISO, daysBetweenISO, nextDueDateISO, previousDueDateISO } from './dates'

export interface CreditCycle {
  /** The next statement close, on or after the reference day. */
  closesOn: string
  /** The payment date that follows that close. */
  dueOn: string
  daysUntilClose: number
  daysUntilDue: number
}

/**
 * A card closes its statement on one day of the month and asks for the money
 * on another. Walking the close date first, then the first due day after it,
 * handles both orders (due before close, or close before due) without a table.
 */
export function creditCycle(input: {
  statementDay: number
  paymentDueDay: number
  fromISO: string
}): CreditCycle {
  const closesOn = nextDueDateISO(input.statementDay, input.fromISO)
  // The due day belongs to the cycle that just closed, so it must come after it.
  const dueOn = nextDueDateISO(input.paymentDueDay, addDaysISO(closesOn, 1))
  return {
    closesOn,
    dueOn,
    daysUntilClose: daysBetweenISO(input.fromISO, closesOn),
    daysUntilDue: daysBetweenISO(input.fromISO, dueOn)
  }
}

/**
 * What the card will ask for: last statement's balance minus payments recorded
 * since it closed. Never negative — an overpayment is a credit, not a bill.
 */
export function creditAmountDue(input: {
  lastStatementBalanceCents: number
  paymentsSinceCloseCents: number
}): number {
  return Math.max(0, Math.round(input.lastStatementBalanceCents) - Math.round(input.paymentsSinceCloseCents))
}

/** The single close date that opened the cycle a given date belongs to. */
export function previousCloseDate(statementDay: number, fromISO: string): string {
  // Clamping per month matters here: stepping back from 28 February would name
  // 28 January as the close, and the last three days of January would then be
  // counted against the wrong statement.
  return previousDueDateISO(statementDay, fromISO)
}

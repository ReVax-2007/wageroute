import { addDaysISO, daysBetweenISO } from './dates'
import { nextBillOccurrence, previousBillOccurrence, type RecurringBill } from './occurrences'

/** How early a payment is allowed to land and still count for the same cycle. */
const EARLY_WINDOW_DAYS = 5

export interface PromptBill extends RecurringBill {
  name: string
  category: string
  accountId: string | null
  isActive: boolean
  autopay: boolean
}

export interface PromptPayment {
  billId: string | null
  occurredOn: string
  amountCents: number
}

export interface BillPrompt {
  billId: string
  name: string
  amountCents: number
  category: string
  accountId: string | null
  autopay: boolean
  dueOn: string
  daysLate: number
  /** Money already matched against this cycle; anything below the bill is partial. */
  paidCents: number
}

/**
 * Chronology engine: an active bill whose latest occurrence has passed without
 * enough matching payment is considered unconfirmed. The occurrence comes from
 * the shared recurrence engine, so a weekly bill is checked weekly and an annual
 * bill once a year. Payments are matched by bill id and summed, so a token
 * adjustment no longer silences a full bill, and a part payment is surfaced as
 * such instead of disappearing.
 */
export function dueBillPrompts(input: {
  bills: readonly PromptBill[]
  payments: readonly PromptPayment[]
  todayISO: string
}): BillPrompt[] {
  const prompts: BillPrompt[] = []

  // Group once instead of scanning every payment for every bill.
  const byBill = new Map<string, PromptPayment[]>()
  for (const payment of input.payments) {
    if (!payment.billId) continue
    const bucket = byBill.get(payment.billId)
    if (bucket) bucket.push(payment)
    else byBill.set(payment.billId, [payment])
  }

  for (const bill of input.bills) {
    if (!bill.isActive) continue

    const dueOn = previousBillOccurrence(bill, input.todayISO)
    if (dueOn >= input.todayISO) continue

    const nextOn = nextBillOccurrence(bill, addDaysISO(dueOn, 1))
    const windowStart = addDaysISO(dueOn, -EARLY_WINDOW_DAYS)
    const paidCents = (byBill.get(bill.id) ?? [])
      .filter(
        (payment) => payment.occurredOn >= windowStart && payment.occurredOn < nextOn
      )
      .reduce((total, payment) => total + Math.abs(payment.amountCents), 0)
    if (paidCents >= bill.amountCents) continue

    prompts.push({
      billId: bill.id,
      name: bill.name,
      amountCents: bill.amountCents,
      category: bill.category,
      accountId: bill.accountId,
      autopay: bill.autopay,
      dueOn,
      daysLate: daysBetweenISO(dueOn, input.todayISO),
      paidCents
    })
  }

  return prompts.sort(
    (a, b) => a.dueOn.localeCompare(b.dueOn) || a.name.localeCompare(b.name)
  )
}

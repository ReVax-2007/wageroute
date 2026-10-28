import { addDaysISO, daysBetweenISO, nextDueDateISO, previousDueDateISO } from './dates'

/** How early a payment is allowed to land and still count for the same cycle. */
const EARLY_WINDOW_DAYS = 5

export interface PromptBill {
  id: string
  name: string
  amountCents: number
  dueDay: number
  category: string
  accountId: string | null
  isActive: boolean
  autopay: boolean
}

export interface PromptPayment {
  billId: string | null
  occurredOn: string
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
}

/**
 * Chronology engine: an active bill whose latest due date has passed with no
 * matching payment in the cycle window is considered unconfirmed. Payments are
 * matched by bill_id, not category, so an unrelated "Housing" expense never
 * silences the prompt.
 */
export function dueBillPrompts(input: {
  bills: readonly PromptBill[]
  payments: readonly PromptPayment[]
  todayISO: string
}): BillPrompt[] {
  const prompts: BillPrompt[] = []

  for (const bill of input.bills) {
    if (!bill.isActive) continue

    const dueOn = previousDueDateISO(bill.dueDay, input.todayISO)
    if (dueOn >= input.todayISO) continue

    const nextDueOn = nextDueDateISO(bill.dueDay, input.todayISO)
    const windowStart = addDaysISO(dueOn, -EARLY_WINDOW_DAYS)
    const paid = input.payments.some(
      (payment) =>
        payment.billId === bill.id &&
        payment.occurredOn >= windowStart &&
        payment.occurredOn < nextDueOn
    )
    if (paid) continue

    prompts.push({
      billId: bill.id,
      name: bill.name,
      amountCents: bill.amountCents,
      category: bill.category,
      accountId: bill.accountId,
      autopay: bill.autopay,
      dueOn,
      daysLate: daysBetweenISO(dueOn, input.todayISO)
    })
  }

  return prompts.sort(
    (a, b) => a.dueOn.localeCompare(b.dueOn) || a.name.localeCompare(b.name)
  )
}

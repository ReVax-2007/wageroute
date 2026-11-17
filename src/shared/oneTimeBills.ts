import { addDaysISO, addMonthsISO } from './dates'
import type { Frequency, PayCadence } from './types'

/**
 * One-time bills: new tires, a course fee, a repair quote (ADR 0037).
 *
 * A one-time bill is an ordinary bill row whose frequency is `once` and whose
 * `next_due_on` is the day it is due. It has no recurring share, so the monthly
 * figures (`monthlyEquivalentCents`, `reservePerPaycheckCents`) read it as zero
 * and the rules below say what it asks of a month and of a cheque instead.
 *
 * Its "cycle" is its whole life: every payment linked to it counts, whatever
 * month it landed in, and every claim a cheque wrote for it is still part of
 * the same saving-up. Once the payments cover the amount the bill is done. That
 * is derived, never stored, exactly like a claim's state (ADR 0028), so deleting
 * the payment reopens it on both devices.
 */

export interface OneTimeBillFacts {
  amountCents: number
  frequency: Frequency
  nextDueOn: string | null
  dueDay: number
  /** When the bill was written; the saving-up starts that month. */
  createdAt: string
}

export function isOneTimeBill(bill: { frequency: Frequency }): boolean {
  return bill.frequency === 'once'
}

/**
 * The day the bill is due. The write rules always store one; a hand-edited
 * backup without it falls back to the due day in the month the bill was written,
 * which is where the form would have put it.
 */
export function oneTimeDueOn(bill: Pick<OneTimeBillFacts, 'nextDueOn' | 'dueDay' | 'createdAt'>): string {
  if (bill.nextDueOn) return bill.nextDueOn
  const month = (bill.createdAt || '1970-01-01').slice(0, 7)
  const year = Number.parseInt(month.slice(0, 4), 10)
  const monthNumber = Number.parseInt(month.slice(5, 7), 10)
  const last = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate()
  const day = Math.min(Math.max(1, Math.round(bill.dueDay) || 1), last)
  return `${month}-${String(day).padStart(2, '0')}`
}

/**
 * Whether a one-time bill has been paid for good. `paidCents` is what its
 * payments count for — the credited total of `BillPaymentTotal.paidCents`, so a
 * variable one-time bill is done after one payment of any size (ADR 0036). A
 * recurring bill is never done.
 */
export function isOneTimeBillDone(
  bill: { amountCents: number; frequency: Frequency },
  paidCents: number
): boolean {
  return isOneTimeBill(bill) && paidCents >= bill.amountCents
}

/**
 * Whether a payment dated, or a claim held for, `dateOrMonth` belongs to the
 * bill's figures for `monthISO`. A recurring bill's month is the calendar month;
 * a one-time bill's is its whole life.
 */
export function inBillCycle(
  bill: { frequency: Frequency },
  dateOrMonth: string,
  monthISO: string
): boolean {
  return isOneTimeBill(bill) || dateOrMonth.slice(0, 7) === monthISO
}

function monthIndex(monthISO: string): number {
  return Number.parseInt(monthISO.slice(0, 4), 10) * 12 + Number.parseInt(monthISO.slice(5, 7), 10) - 1
}

/**
 * How much of a one-time bill Left to spend holds back by the end of `monthISO`.
 *
 * The amount is set aside evenly over the months from the one the bill was
 * written in to the one it is due in, and what was set aside stays held: a $900
 * bill written in January and due in March holds $300 in January, $600 in
 * February and all $900 from March on. A recurring bill's smoothed share is
 * released each month because the next occurrence asks for it again; a one-time
 * bill has no next occurrence, so releasing it would leave the due month to find
 * the whole amount at once.
 */
export function oneTimeSetAsideCents(bill: OneTimeBillFacts, monthISO: string): number {
  const dueMonth = monthIndex(oneTimeDueOn(bill))
  const startMonth = Math.min(monthIndex(bill.createdAt || oneTimeDueOn(bill)), dueMonth)
  const month = monthIndex(monthISO)
  if (month >= dueMonth) return bill.amountCents
  if (month < startMonth) return 0
  const months = dueMonth - startMonth + 1
  return Math.round((bill.amountCents * (month - startMonth + 1)) / months)
}

/** The payday after `iso` on a pay cycle that repeats from that date. */
function followingPayday(iso: string, cadence: PayCadence): string {
  if (cadence === 'weekly') return addDaysISO(iso, 7)
  if (cadence === 'biweekly') return addDaysISO(iso, 14)
  if (cadence === 'monthly') return addMonthsISO(iso, 1)
  // Twice a month: the 1st and the 16th, the 15th and the last day — fifteen
  // days on within the month, or the partner day of the next month.
  const day = Number.parseInt(iso.slice(8, 10), 10)
  return day <= 15 ? addDaysISO(iso, 15) : addDaysISO(addMonthsISO(iso, 1), -15)
}

/**
 * How many cheques, this one included, arrive on or before the due date,
 * counting forward from this cheque's own date on its pay cycle. A cheque dated
 * after the due date has none left to share the bill with.
 *
 * Twice-a-month pay has no anchor to say which two days, so the count can be
 * one off. That only moves money between cheques: each cheque re-divides what
 * is still open, so the last one before the date always tops it up.
 */
export function chequesUntilDue(paycheckDate: string, dueOn: string, cadence: PayCadence): number {
  let count = 0
  // Bounded: a bill years out on weekly pay is still a few hundred steps.
  for (let date = paycheckDate; date <= dueOn && count < 1_000; date = followingPayday(date, cadence)) {
    count += 1
  }
  return count
}

/**
 * What one cheque sets aside for a one-time bill: what is still open — the
 * amount less what was paid and what earlier cheques already hold — shared
 * evenly by the cheques left before the due date. A $900 bill two months out on
 * biweekly pay asks about $180 from each of the next five cheques, not $900
 * from one. A cheque after the due date carries everything still open, since
 * the bill is overdue. Funding strategies do not apply: there is no month to
 * pick a cheque of.
 */
export function oneTimeReserveCents(input: {
  amountCents: number
  dueOn: string
  cadence: PayCadence
  paycheckDate?: string | null
  /** What the bill's payments already cover, from cash. */
  paidCents?: number
  /** What earlier cheques' live claims already hold, from any month. */
  claimedCents?: number
}): number {
  const paid = Math.max(0, Math.round(input.paidCents ?? 0))
  const claimed = Math.max(0, Math.round(input.claimedCents ?? 0))
  const open = Math.max(0, input.amountCents - paid - claimed)
  if (open === 0 || !input.paycheckDate) return open
  const cheques = chequesUntilDue(input.paycheckDate, input.dueOn, input.cadence)
  return cheques <= 1 ? open : Math.round(open / cheques)
}

import {
  poolEarmarkedGoalsCents,
  safeToSpendPoolCents,
  totalWealthCents,
  unsettledRoutingCents
} from '@shared/accounts'
import {
  monthlyEquivalentCents,
  nextPaydayISO,
  reservePerPaycheckCents,
  unpaidMonthlyWallCents
} from '@shared/cadence'
import { daysBetweenISO, todayISO } from '@shared/dates'
import { nextBillOccurrence } from '@shared/occurrences'
import { isOneTimeBill, oneTimeDueOn, oneTimeReserveCents } from '@shared/oneTimeBills'
import { parseSettings } from '@shared/settings'
import type { AppSettings, Bill, Snapshot } from '@shared/types'
import {
  activeBills,
  cashOnHand,
  doneOneTimeBills,
  goalsSummary,
  monthlyWall,
  perPaycheckWall
} from '../../renderer/src/lib/finance'
import { byName } from './rows'

/** Everything the phone shows, worked out with the desktop's own formulas. */
export interface PocketView {
  settings: AppSettings
  poolCents: number
  unpaidWallCents: number
  goalMoneyCents: number
  unsettledCents: number
  safeToSpendCents: number
  cashCents: number
  wealthCents: number
  monthlyBillsCents: number
  perCheckBillsCents: number
  nextPayday: string | null
  goals: ReturnType<typeof goalsSummary>
}

export function pocketView(snapshot: Snapshot, today: string = todayISO()): PocketView {
  const settings = parseSettings(snapshot.settings)
  const active = activeBills(snapshot.bills, snapshot.billPaymentsThisMonth)
  const paid = new Map(
    snapshot.billPaymentsThisMonth.map((row) => [
      row.billId,
      Math.max(0, row.paidCents - row.creditCents)
    ])
  )
  const poolCents = safeToSpendPoolCents(snapshot.accounts)
  const unpaidWallCents = unpaidMonthlyWallCents(active, paid, today.slice(0, 7))
  const goalMoneyCents = poolEarmarkedGoalsCents(snapshot.goals)
  const unsettledCents = unsettledRoutingCents({
    paychecks: snapshot.paychecks,
    transactions: snapshot.transactions,
    accounts: snapshot.accounts,
    todayISO: today
  })
  return {
    settings,
    poolCents,
    unpaidWallCents,
    goalMoneyCents,
    unsettledCents,
    safeToSpendCents: poolCents - unpaidWallCents - goalMoneyCents - unsettledCents,
    cashCents: cashOnHand(snapshot.accounts),
    wealthCents: totalWealthCents(snapshot.accounts),
    monthlyBillsCents: monthlyWall(active),
    perCheckBillsCents: perPaycheckWall(active, settings.payCadence),
    nextPayday: settings.payAnchorDate
      ? nextPaydayISO(today, settings.payCadence, settings.payAnchorDate)
      : null,
    goals: goalsSummary(snapshot.goals)
  }
}

/** `overdue` is a one-time bill past its date and not yet covered (ADR 0037). */
export type BillState = 'paid' | 'reserved' | 'open' | 'overdue'

export interface BillLine {
  bill: Bill
  monthlyCents: number
  perCheckCents: number
  dueOn: string
  daysUntil: number
  state: BillState
  accountName: string | null
  paidCents: number
  /** What really left this month; differs from `paidCents` only on a variable bill. */
  actualCents: number
}

/**
 * A bill is settled for the month when a matching payment closed its claim or
 * when this month's payments cover its amount — whichever account paid. A card
 * payment settles the bill even though the cash stayed in the pool; Safe to
 * spend still holds that cash because the card itself now has to be paid.
 */
export function billLines(snapshot: Snapshot, today: string = todayISO()): BillLine[] {
  const settings = parseSettings(snapshot.settings)
  const cycle = today.slice(0, 7)
  const liveBillIds = new Set(snapshot.bills.map((bill) => bill.id))
  const reserves = snapshot.billReserves.filter(
    (reserve) => reserve.cycle === cycle && liveBillIds.has(reserve.billId)
  )
  const paid = new Map(
    snapshot.billPaymentsThisMonth.map((row) => [row.billId, Math.max(0, row.paidCents)])
  )
  const actual = new Map(
    snapshot.billPaymentsThisMonth.map((row) => [row.billId, Math.max(0, row.actualCents)])
  )
  const accounts = new Map(snapshot.accounts.map((account) => [account.id, account.name]))

  return activeBills(snapshot.bills, snapshot.billPaymentsThisMonth)
    .map((bill) => {
      const claims = reserves.filter((reserve) => reserve.billId === bill.id)
      const paidCents = paid.get(bill.id) ?? 0
      const oneTime = isOneTimeBill(bill)
      // A one-time bill that is paid is not listed here at all; one still open is
      // either waiting for its date or overdue, whatever a month's claims say.
      const state: BillState = oneTime
        ? oneTimeDueOn(bill) < today
          ? 'overdue'
          : 'open'
        : claims.some((claim) => claim.state === 'reserved')
          ? 'reserved'
          : claims.length > 0 || paidCents >= bill.amountCents
            ? 'paid'
            : 'open'
      // The same recurrence engine the desktop uses: a weekly bill is due in a
      // week even when its stored `next_due_on` is months stale.
      const dueOn = nextBillOccurrence(bill, today)
      return {
        bill,
        monthlyCents: monthlyEquivalentCents(bill.amountCents, bill.frequency),
        perCheckCents: oneTime
          ? oneTimeReserveCents({
              amountCents: bill.amountCents,
              dueOn: oneTimeDueOn(bill),
              cadence: settings.payCadence,
              paycheckDate: today,
              paidCents
            })
          : reservePerPaycheckCents(bill.amountCents, bill.frequency, settings.payCadence),
        dueOn,
        daysUntil: daysBetweenISO(today, dueOn),
        state,
        accountName: bill.accountId ? (accounts.get(bill.accountId) ?? null) : null,
        paidCents,
        actualCents: actual.get(bill.id) ?? 0
      }
    })
    .sort((a, b) => a.bill.dueDay - b.bill.dueDay || byName(a.bill.name, b.bill.name))
}

/**
 * One-time bills that are paid and done (ADR 0037), as lines the Bills screen
 * can list and open. They ask nothing of any paycheck.
 */
export function doneLines(snapshot: Snapshot, today: string = todayISO()): BillLine[] {
  const totals = new Map(snapshot.billPaymentsThisMonth.map((row) => [row.billId, row]))
  const accounts = new Map(snapshot.accounts.map((account) => [account.id, account.name]))
  return doneOneTimeBills(snapshot.bills, snapshot.billPaymentsThisMonth)
    .map((bill) => {
      const dueOn = oneTimeDueOn(bill)
      return {
        bill,
        monthlyCents: 0,
        perCheckCents: 0,
        dueOn,
        daysUntil: daysBetweenISO(today, dueOn),
        state: 'paid' as const,
        accountName: bill.accountId ? (accounts.get(bill.accountId) ?? null) : null,
        paidCents: Math.max(0, totals.get(bill.id)?.paidCents ?? 0),
        actualCents: Math.max(0, totals.get(bill.id)?.actualCents ?? 0)
      }
    })
    .sort((a, b) => b.dueOn.localeCompare(a.dueOn) || byName(a.bill.name, b.bill.name))
}

/**
 * Bills not yet settled that fall due in the next two weeks, and one-time bills
 * already past their date: those are never rolled forward, so they stay here
 * until they are paid.
 */
export function dueSoon(lines: readonly BillLine[], days = 14): BillLine[] {
  return lines
    .filter(
      (line) =>
        line.state === 'overdue' ||
        (line.state !== 'paid' && line.daysUntil >= 0 && line.daysUntil <= days)
    )
    .sort((a, b) => a.daysUntil - b.daysUntil)
}

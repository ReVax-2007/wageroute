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
import { parseSettings } from '@shared/settings'
import type { AppSettings, Bill, Snapshot } from '@shared/types'
import {
  activeBills,
  cashOnHand,
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
  const active = activeBills(snapshot.bills)
  const paid = new Map(
    snapshot.billPaymentsThisMonth.map((row) => [
      row.billId,
      Math.max(0, row.paidCents - row.creditCents)
    ])
  )
  const poolCents = safeToSpendPoolCents(snapshot.accounts)
  const unpaidWallCents = unpaidMonthlyWallCents(active, paid)
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

export type BillState = 'paid' | 'reserved' | 'open'

export interface BillLine {
  bill: Bill
  monthlyCents: number
  perCheckCents: number
  dueOn: string
  daysUntil: number
  state: BillState
  accountName: string | null
  paidCents: number
}

/**
 * A bill is settled for the month when a matching payment closed its claim, or
 * when cash actually left the pool for it. A card payment is netted out, so
 * "Paid" here agrees with Safe to spend, which still holds the cash that will
 * pay the card.
 */
export function billLines(snapshot: Snapshot, today: string = todayISO()): BillLine[] {
  const settings = parseSettings(snapshot.settings)
  const cycle = today.slice(0, 7)
  const liveBillIds = new Set(snapshot.bills.map((bill) => bill.id))
  const reserves = snapshot.billReserves.filter(
    (reserve) => reserve.cycle === cycle && liveBillIds.has(reserve.billId)
  )
  const paid = new Map(
    snapshot.billPaymentsThisMonth.map((row) => [
      row.billId,
      Math.max(0, row.paidCents - row.creditCents)
    ])
  )
  const accounts = new Map(snapshot.accounts.map((account) => [account.id, account.name]))

  return activeBills(snapshot.bills)
    .map((bill) => {
      const claims = reserves.filter((reserve) => reserve.billId === bill.id)
      const paidCents = paid.get(bill.id) ?? 0
      const state: BillState =
        claims.some((claim) => claim.state === 'reserved')
          ? 'reserved'
          : claims.length > 0 || paidCents > 0
            ? 'paid'
            : 'open'
      // The same recurrence engine the desktop uses: a weekly bill is due in a
      // week even when its stored `next_due_on` is months stale.
      const dueOn = nextBillOccurrence(bill, today)
      return {
        bill,
        monthlyCents: monthlyEquivalentCents(bill.amountCents, bill.frequency),
        perCheckCents: reservePerPaycheckCents(bill.amountCents, bill.frequency, settings.payCadence),
        dueOn,
        daysUntil: daysBetweenISO(today, dueOn),
        state,
        accountName: bill.accountId ? (accounts.get(bill.accountId) ?? null) : null,
        paidCents
      }
    })
    .sort((a, b) => a.bill.dueDay - b.bill.dueDay || byName(a.bill.name, b.bill.name))
}

/** Bills not yet settled that fall due in the next two weeks. */
export function dueSoon(lines: readonly BillLine[], days = 14): BillLine[] {
  return lines
    .filter((line) => line.state !== 'paid' && line.daysUntil >= 0 && line.daysUntil <= days)
    .sort((a, b) => a.daysUntil - b.daysUntil)
}

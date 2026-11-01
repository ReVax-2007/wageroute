import {
  poolEarmarkedGoalsCents,
  safeToSpendPoolCents,
  totalWealthCents,
  unsettledRoutingCents
} from '@shared/accounts'
import { unpaidMonthlyWallCents } from '@shared/cadence'
import { todayISO } from '@shared/dates'
import { activeBills, cashOnHand, fundedGoalsCents, monthlyWall } from '../lib/finance'
import type { FinanceState } from './types'

/**
 * Derived selectors return numbers only, so Zustand's default Object.is check
 * keeps consumers from re-rendering on unrelated snapshot refreshes.
 */
type SnapshotState = Pick<FinanceState, 'snapshot'>

export function selectCashOnHandCents(state: SnapshotState): number {
  return state.snapshot ? cashOnHand(state.snapshot.accounts) : 0
}

/** Every live account summed, so credit balances subtract and investments count. */
export function selectTotalWealthCents(state: SnapshotState): number {
  return state.snapshot ? totalWealthCents(state.snapshot.accounts) : 0
}

export function selectSafeToSpendPoolCents(state: SnapshotState): number {
  return state.snapshot ? safeToSpendPoolCents(state.snapshot.accounts) : 0
}

/** The whole smoothed obligation, before this month's payments are taken off. */
export function selectMonthlyWallCents(state: SnapshotState): number {
  return state.snapshot ? monthlyWall(activeBills(state.snapshot.bills)) : 0
}

/**
 * The wall as money still owed: each bill's monthly share less what has already
 * been paid against it this calendar month. The pool already fell by the
 * payment, so deducting the full wall as well would charge it twice.
 */
export function selectUnpaidWallCents(state: SnapshotState): number {
  if (!state.snapshot) return 0
  const paid = new Map(
    state.snapshot.billPaymentsThisMonth.map((row) => [row.billId, row.paidCents])
  )
  return unpaidMonthlyWallCents(activeBills(state.snapshot.bills), paid)
}

export function selectFundedGoalsCents(state: SnapshotState): number {
  return state.snapshot ? fundedGoalsCents(state.snapshot.goals) : 0
}

export function selectPoolEarmarkedGoalsCents(state: SnapshotState): number {
  return state.snapshot ? poolEarmarkedGoalsCents(state.snapshot.goals) : 0
}

/**
 * This month's debt and investment routing that has not left the pool yet.
 * The allocator's own arithmetic: money routed to a card or a brokerage is
 * spoken for even though routing itself moves nothing (ADR 0013).
 */
export function selectUnsettledRoutingCents(state: SnapshotState): number {
  if (!state.snapshot) return 0
  return unsettledRoutingCents({
    paychecks: state.snapshot.paychecks,
    transactions: state.snapshot.transactions,
    accounts: state.snapshot.accounts,
    todayISO: todayISO()
  })
}

/**
 * Safe to Spend = the accounts the user treats as spendable − the Priority Wall
 * still unpaid this month − the funded goals whose money sits in that pool −
 * this month's routing to debt and investing that has not been settled. The
 * pool is not "cash on hand": an account can be tracked as cash and still be
 * excluded. A goal funded from a dedicated account is already outside the pool,
 * so it is not deducted again — only the committed-spending meter below is
 * measured against all cash. A bill already paid is not withheld again: the
 * payment already left the pool.
 */
export function selectSafeToSpendCents(state: SnapshotState): number {
  return (
    selectSafeToSpendPoolCents(state) -
    selectUnpaidWallCents(state) -
    selectPoolEarmarkedGoalsCents(state) -
    selectUnsettledRoutingCents(state)
  )
}

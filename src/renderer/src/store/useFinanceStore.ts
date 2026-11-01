import { create } from 'zustand'
import { createDataSlice } from './data'
import { createSessionSlice } from './session'
import type { FinanceState } from './types'

/**
 * The one store the screens read. Session (what the window is showing) and data
 * (the ledger and its writes) live in separate slices; this module only joins
 * them, so neither half owns the other's concerns.
 */
export const useFinanceStore = create<FinanceState>()((...args) => ({
  ...createSessionSlice(...args),
  ...createDataSlice(...args)
}))

export type { ConfirmRequest, FinanceState, Notice, Screen } from './types'
export {
  selectCashOnHandCents,
  selectFundedGoalsCents,
  selectMonthlyWallCents,
  selectPoolEarmarkedGoalsCents,
  selectSafeToSpendCents,
  selectSafeToSpendPoolCents,
  selectTotalWealthCents,
  selectUnpaidWallCents,
  selectUnsettledRoutingCents
} from './selectors'

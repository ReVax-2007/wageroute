import { create } from 'zustand'
import type { ImportCounts, ImportPreview } from '@shared/api'
import type { ImportAnswer } from '@shared/importRepair'
import { DEFAULT_SETTINGS, parseSettings } from '@shared/settings'
import type {
  AccountInput,
  AccountWithBalance,
  AppSettings,
  BillInput,
  GoalInput,
  PaycheckDraftInput,
  Snapshot,
  TransactionInput,
  TransactionPatch
} from '@shared/types'
import { activeBills, cashOnHand, fundedGoalsCents, monthlyWall } from '../lib/finance'

export type Screen = 'dashboard' | 'wall' | 'goals' | 'accounts' | 'ledger' | 'settings'

interface Notice {
  text: string
  tone: 'success' | 'error'
}

interface FinanceState {
  status: 'loading' | 'ready' | 'error'
  error: string | null
  snapshot: Snapshot | null
  settings: AppSettings
  dbPath: string
  screen: Screen
  allocatorOpen: boolean
  importPreview: ImportPreview | null
  importStep: 'fix' | 'review'
  busy: boolean
  notice: Notice | null
  snoozedBillIds: string[]

  init: () => Promise<void>
  refresh: () => Promise<void>
  go: (screen: Screen) => void
  openAllocator: () => void
  closeAllocator: () => void
  snoozeBill: (billId: string) => void
  notify: (text: string, tone?: Notice['tone']) => void
  dismissNotice: () => void

  createAccount: (input: AccountInput) => Promise<void>
  updateAccount: (id: string, input: Partial<AccountInput>) => Promise<void>
  deleteAccount: (id: string) => Promise<void>
  adjustAccountBalance: (
    account: AccountWithBalance,
    targetBalanceCents: number,
    occurredOn: string
  ) => Promise<void>
  createBill: (input: BillInput) => Promise<void>
  updateBill: (id: string, input: Partial<BillInput>) => Promise<void>
  deleteBill: (id: string) => Promise<void>
  createGoal: (input: GoalInput) => Promise<void>
  updateGoal: (id: string, input: Partial<GoalInput>) => Promise<void>
  deleteGoal: (id: string) => Promise<void>
  createTransaction: (input: TransactionInput) => Promise<void>
  updateTransaction: (id: string, patch: TransactionPatch) => Promise<void>
  deleteTransaction: (id: string) => Promise<void>
  commitPaycheck: (input: PaycheckDraftInput) => Promise<boolean>
  saveSettings: (next: AppSettings) => Promise<void>
  exportBackup: () => Promise<void>
  exportCsv: () => Promise<void>
  openImport: () => Promise<void>
  closeImport: () => void
  goImportStep: (step: 'fix' | 'review') => void
  runImport: (answers: ImportAnswer[]) => Promise<void>
  resetData: () => Promise<void>
}

let noticeTimer: ReturnType<typeof setTimeout> | undefined

function messageOf(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  return raw
    .replace(/^Error invoking remote method '[^']+': /, '')
    .replace(/^Error: /, '')
}

export const useFinanceStore = create<FinanceState>((set, get) => {
  const run = async (task: () => Promise<unknown>, success?: string): Promise<boolean> => {
    set({ busy: true })
    try {
      await task()
      const snapshot = await window.api.getSnapshot()
      set({ snapshot, settings: parseSettings(snapshot.settings) })
      if (success) get().notify(success, 'success')
      return true
    } catch (error) {
      get().notify(messageOf(error), 'error')
      return false
    } finally {
      set({ busy: false })
    }
  }

  return {
    status: 'loading',
    error: null,
    snapshot: null,
    settings: DEFAULT_SETTINGS,
    dbPath: '',
    screen: 'dashboard',
    allocatorOpen: false,
    importPreview: null,
    importStep: 'fix',
    busy: false,
    notice: null,
    snoozedBillIds: [],

    init: async () => {
      try {
        const [snapshot, dbPath] = await Promise.all([
          window.api.getSnapshot(),
          window.api.getDatabasePath()
        ])
        set({
          snapshot,
          settings: parseSettings(snapshot.settings),
          dbPath,
          status: 'ready'
        })
      } catch (error) {
        set({ status: 'error', error: messageOf(error) })
      }
    },

    refresh: async () => {
      const snapshot = await window.api.getSnapshot()
      set({ snapshot, settings: parseSettings(snapshot.settings) })
    },

    go: (screen) => set({ screen }),
    openAllocator: () => set({ allocatorOpen: true }),
    closeAllocator: () => set({ allocatorOpen: false }),
    snoozeBill: (billId) =>
      set((state) =>
        state.snoozedBillIds.includes(billId)
          ? state
          : { snoozedBillIds: [...state.snoozedBillIds, billId] }
      ),

    notify: (text, tone = 'success') => {
      if (noticeTimer) clearTimeout(noticeTimer)
      set({ notice: { text, tone } })
      noticeTimer = setTimeout(() => set({ notice: null }), 4200)
    },

    dismissNotice: () => {
      if (noticeTimer) clearTimeout(noticeTimer)
      set({ notice: null })
    },

    createAccount: async (input) => {
      await run(() => window.api.createAccount(input), 'Account added')
    },
    updateAccount: async (id, input) => {
      await run(() => window.api.updateAccount(id, input), 'Account updated')
    },
    deleteAccount: async (id) => {
      await run(() => window.api.deleteAccount(id), 'Account removed')
    },
    adjustAccountBalance: async (account, targetBalanceCents, occurredOn) => {
      const delta = Math.round(targetBalanceCents) - account.balanceCents
      if (delta === 0) {
        get().notify('That balance is already correct')
        return
      }
      await run(
        () =>
          window.api.createTransaction({
            accountId: account.id,
            kind: 'adjustment',
            amountCents: delta,
            occurredOn,
            memo: 'Balance adjustment',
            category: 'Adjustment'
          }),
        'Balance adjusted'
      )
    },
    createBill: async (input) => {
      await run(() => window.api.createBill(input), 'Bill locked into the wall')
    },
    updateBill: async (id, input) => {
      await run(() => window.api.updateBill(id, input), 'Bill updated')
    },
    deleteBill: async (id) => {
      await run(() => window.api.deleteBill(id), 'Bill removed from the wall')
    },
    createGoal: async (input) => {
      await run(() => window.api.createGoal(input), 'Goal created')
    },
    updateGoal: async (id, input) => {
      await run(() => window.api.updateGoal(id, input), 'Goal updated')
    },
    deleteGoal: async (id) => {
      await run(() => window.api.deleteGoal(id), 'Goal archived')
    },
    createTransaction: async (input) => {
      await run(() => window.api.createTransaction(input), 'Entry added')
    },
    updateTransaction: async (id, patch) => {
      await run(() => window.api.updateTransaction(id, patch), 'Entry saved')
    },
    deleteTransaction: async (id) => {
      await run(() => window.api.deleteTransaction(id), 'Entry removed')
    },

    commitPaycheck: async (input) => {
      const ok = await run(() => window.api.commitPaycheck(input), 'Paycheck routed')
      if (ok) set({ allocatorOpen: false, screen: 'dashboard' })
      return ok
    },

    saveSettings: async (next) => {
      set({ settings: next })
      try {
        await window.api.saveSettings(next)
      } catch (error) {
        get().notify(messageOf(error), 'error')
      }
    },

    exportBackup: async () => {
      set({ busy: true })
      try {
        const path = await window.api.exportBackup()
        if (path) get().notify(`Backup saved: ${fileNameOf(path)}`)
      } catch (error) {
        get().notify(messageOf(error), 'error')
      } finally {
        set({ busy: false })
      }
    },

    exportCsv: async () => {
      set({ busy: true })
      try {
        const path = await window.api.exportTransactionsCsv()
        if (path) get().notify(`CSV saved: ${fileNameOf(path)}`)
      } catch (error) {
        get().notify(messageOf(error), 'error')
      } finally {
        set({ busy: false })
      }
    },

    openImport: async () => {
      set({ busy: true })
      try {
        const preview = await window.api.previewImport()
        if (!preview) return
        set({ importPreview: preview, importStep: preview.problems.length > 0 ? 'fix' : 'review' })
      } catch (error) {
        get().notify(messageOf(error), 'error')
      } finally {
        set({ busy: false })
      }
    },

    closeImport: () => set({ importPreview: null, importStep: 'fix' }),

    goImportStep: (step) => set({ importStep: step }),

    runImport: async (answers) => {
      const preview = get().importPreview
      if (!preview) return

      set({ busy: true })
      try {
        const result = await window.api.confirmImport(preview.token, answers)
        if (!result) return
        set({ importPreview: null, importStep: 'fix' })
        const snapshot = await window.api.getSnapshot()
        set({ snapshot, settings: parseSettings(snapshot.settings) })

        const added = totalCounts(result.added)
        const skipped = totalCounts(result.skipped)
        const dropped = result.dropped.length
        const refused = result.issues.length
        const noun = result.format === 'entries' ? 'entries' : 'records'

        if (added === 0) {
          if (dropped > 0 || refused > 0) {
            get().notify(
              `Nothing imported — ${dropped + refused} ${dropped + refused === 1 ? 'row' : 'rows'} left out`,
              'error'
            )
          } else {
            get().notify(
              skipped > 0
                ? 'Nothing new — those records are already in your data'
                : 'That file had nothing to import'
            )
          }
          return
        }

        const parts = [`Imported ${added} new ${noun}`]
        if (skipped > 0) parts.push(`${skipped} already present`)
        if (dropped > 0) parts.push(`${dropped} ${dropped === 1 ? 'row' : 'rows'} left out`)
        if (refused > 0) parts.push(`${refused} ${refused === 1 ? 'row' : 'rows'} refused by the database`)
        get().notify(parts.join(' · '))
      } catch (error) {
        get().notify(messageOf(error), 'error')
      } finally {
        set({ busy: false })
      }
    },

    resetData: async () => {
      const ok = await run(() => window.api.resetData(), 'All data erased — back to a blank profile.')
      if (ok) set({ screen: 'dashboard' })
    }
  }
})

function totalCounts(counts: ImportCounts): number {
  return Object.values(counts).reduce((sum, value) => sum + value, 0)
}

function fileNameOf(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}

/**
 * Derived selectors return numbers only, so Zustand's default Object.is check
 * keeps consumers from re-rendering on unrelated snapshot refreshes.
 */
type SnapshotState = Pick<FinanceState, 'snapshot'>

export function selectCashOnHandCents(state: SnapshotState): number {
  return state.snapshot ? cashOnHand(state.snapshot.accounts) : 0
}

export function selectMonthlyWallCents(state: SnapshotState): number {
  return state.snapshot ? monthlyWall(activeBills(state.snapshot.bills)) : 0
}

export function selectFundedGoalsCents(state: SnapshotState): number {
  return state.snapshot ? fundedGoalsCents(state.snapshot.goals) : 0
}

/**
 * Safe to Spend = cash asset balances − Priority Wall − funded sinking goals.
 */
export function selectSafeToSpendCents(state: SnapshotState): number {
  return (
    selectCashOnHandCents(state) -
    selectMonthlyWallCents(state) -
    selectFundedGoalsCents(state)
  )
}

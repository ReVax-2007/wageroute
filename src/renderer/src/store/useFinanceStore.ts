import { create } from 'zustand'
import { poolEarmarkedGoalsCents, safeToSpendPoolCents, totalWealthCents } from '@shared/accounts'
import type { AppInfo, ImportCounts, ImportPreview } from '@shared/api'
import { apiErrorMessage } from '@shared/errors'
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
  appInfo: AppInfo | null
  screen: Screen
  allocatorOpen: boolean
  importPreview: ImportPreview | null
  importStep: 'fix' | 'review'
  busy: boolean
  notice: Notice | null
  snoozedPrompts: string[]

  init: () => Promise<void>
  refresh: () => Promise<void>
  go: (screen: Screen) => void
  openAllocator: () => void
  closeAllocator: () => void
  snoozePrompt: (key: string) => void
  unsnoozePrompt: (key: string) => void
  notify: (text: string, tone?: Notice['tone']) => void
  dismissNotice: () => void
  pauseNotice: () => void
  resumeNotice: () => void

  createAccount: (input: AccountInput) => Promise<boolean>
  updateAccount: (id: string, input: Partial<AccountInput>) => Promise<boolean>
  deleteAccount: (id: string, withEntries?: boolean) => Promise<boolean>
  archiveAccount: (id: string, archived: boolean) => Promise<boolean>
  accountEntryCount: (id: string) => Promise<number>
  adjustAccountBalance: (
    account: AccountWithBalance,
    targetBalanceCents: number,
    occurredOn: string
  ) => Promise<boolean>
  createBill: (input: BillInput) => Promise<boolean>
  updateBill: (id: string, input: Partial<BillInput>) => Promise<boolean>
  deleteBill: (id: string) => Promise<boolean>
  createGoal: (input: GoalInput) => Promise<boolean>
  updateGoal: (id: string, input: Partial<GoalInput>) => Promise<boolean>
  deleteGoal: (id: string) => Promise<boolean>
  archiveGoal: (id: string, archived: boolean) => Promise<boolean>
  createTransaction: (input: TransactionInput) => Promise<boolean>
  updateTransaction: (id: string, patch: TransactionPatch) => Promise<boolean>
  deleteTransaction: (id: string) => Promise<boolean>
  commitPaycheck: (input: PaycheckDraftInput) => Promise<boolean>
  saveSettings: (next: AppSettings) => Promise<boolean>
  exportBackup: () => Promise<void>
  exportCsv: () => Promise<void>
  openImport: () => Promise<void>
  closeImport: () => void
  goImportStep: (step: 'fix' | 'review') => void
  /** Resolves to an error message on failure, or null once the wizard can close. */
  runImport: (answers: ImportAnswer[]) => Promise<string | null>
  resetData: () => Promise<void>
}

let noticeTimer: ReturnType<typeof setTimeout> | undefined

function messageOf(error: unknown): string {
  return apiErrorMessage(error)
}

export const useFinanceStore = create<FinanceState>((set, get) => {
  // Writes run one at a time so a fast second edit cannot land before the first
  // and overwrite it by arrival order.
  let queue: Promise<unknown> = Promise.resolve()
  const enqueue = <T,>(task: () => Promise<T>): Promise<T> => {
    const next = queue.then(task, task)
    queue = next.catch(() => undefined)
    return next
  }

  /**
   * Runs a write and then refreshes the snapshot. A failed write returns false
   * and leaves the state alone; a write that *committed* but could not be read
   * back returns true, because the data is safe and the caller should close.
   */
  const run = async (task: () => Promise<unknown>, success?: string): Promise<boolean> => {
    set({ busy: true })
    try {
      await enqueue(task)
    } catch (error) {
      get().notify(messageOf(error), 'error')
      return false
    } finally {
      // The write is done (or failed); the refresh below must not keep the
      // whole app disabled if it is slow.
      set({ busy: false })
    }

    try {
      const snapshot = await window.api.getSnapshot()
      set({ snapshot, settings: parseSettings(snapshot.settings) })
      if (success) get().notify(success, 'success')
    } catch (error) {
      get().notify(`Saved, but the screen could not refresh — ${messageOf(error)}`, 'error')
    }
    return true
  }

  return {
    status: 'loading',
    error: null,
    snapshot: null,
    settings: DEFAULT_SETTINGS,
    dbPath: '',
    appInfo: null,
    screen: 'dashboard',
    allocatorOpen: false,
    importPreview: null,
    importStep: 'fix',
    busy: false,
    notice: null,
    snoozedPrompts: [],

    init: async () => {
      try {
        const [snapshot, dbPath, appInfo] = await Promise.all([
          window.api.getSnapshot(),
          window.api.getDatabasePath(),
          window.api.getAppInfo()
        ])
        set({
          snapshot,
          settings: parseSettings(snapshot.settings),
          dbPath,
          appInfo,
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
    // Snoozing is per occurrence, not per bill: a skipped cycle should not hide
    // the next month's prompt.
    snoozePrompt: (key) =>
      set((state) =>
        state.snoozedPrompts.includes(key)
          ? state
          : { snoozedPrompts: [...state.snoozedPrompts, key] }
      ),
    unsnoozePrompt: (key) =>
      set((state) => ({
        snoozedPrompts: state.snoozedPrompts.filter((item) => item !== key)
      })),

    notify: (text, tone = 'success') => {
      if (noticeTimer) clearTimeout(noticeTimer)
      set({ notice: { text, tone } })
      // Successes are transient; an error stays until it is read or dismissed.
      noticeTimer =
        tone === 'error' ? undefined : setTimeout(() => set({ notice: null }), 4200)
    },

    pauseNotice: () => {
      if (noticeTimer) clearTimeout(noticeTimer)
      noticeTimer = undefined
    },

    resumeNotice: () => {
      if (noticeTimer) clearTimeout(noticeTimer)
      if (!get().notice || get().notice?.tone === 'error') return
      noticeTimer = setTimeout(() => set({ notice: null }), 4200)
    },

    dismissNotice: () => {
      if (noticeTimer) clearTimeout(noticeTimer)
      noticeTimer = undefined
      set({ notice: null })
    },

    createAccount: (input) => run(() => window.api.createAccount(input), 'Account added'),
    updateAccount: (id, input) => run(() => window.api.updateAccount(id, input), 'Account updated'),
    deleteAccount: (id, withEntries = false) =>
      run(
        () => window.api.deleteAccount(id, { withEntries }),
        withEntries ? 'Account and its entries removed' : 'Account removed'
      ),
    archiveAccount: (id, archived) =>
      run(
        () => window.api.archiveAccount(id, archived),
        archived ? 'Account archived' : 'Account restored'
      ),
    accountEntryCount: (id) => window.api.accountEntryCount(id),
    adjustAccountBalance: async (account, targetBalanceCents, occurredOn) => {
      const delta = Math.round(targetBalanceCents) - account.balanceCents
      if (delta === 0) {
        get().notify('That balance is already correct')
        return true
      }
      return run(
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
    createBill: (input) => run(() => window.api.createBill(input), 'Bill locked into the wall'),
    updateBill: (id, input) => run(() => window.api.updateBill(id, input), 'Bill updated'),
    deleteBill: (id) => run(() => window.api.deleteBill(id), 'Bill deleted'),
    createGoal: (input) => run(() => window.api.createGoal(input), 'Goal created'),
    updateGoal: (id, input) => run(() => window.api.updateGoal(id, input), 'Goal updated'),
    deleteGoal: (id) => run(() => window.api.deleteGoal(id), 'Goal deleted'),
    archiveGoal: (id, archived) =>
      run(
        () => window.api.archiveGoal(id, archived),
        archived ? 'Goal archived — restore it any time' : 'Goal restored'
      ),
    createTransaction: (input) => run(() => window.api.createTransaction(input), 'Entry added'),
    updateTransaction: (id, patch) =>
      run(() => window.api.updateTransaction(id, patch), 'Entry saved'),
    deleteTransaction: (id) => run(() => window.api.deleteTransaction(id), 'Entry removed'),

    commitPaycheck: async (input) => {
      const ok = await run(() => window.api.commitPaycheck(input), 'Paycheck routed')
      if (ok) set({ allocatorOpen: false, screen: 'dashboard' })
      return ok
    },

    saveSettings: async (next) => {
      const previous = get().settings
      set({ settings: next })
      try {
        await enqueue(() => window.api.saveSettings(next))
        return true
      } catch (error) {
        // Settings are applied optimistically; a failed save must not leave the
        // screen showing a split the database never received.
        set({ settings: previous })
        get().notify(messageOf(error), 'error')
        return false
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
      if (!preview) return null

      set({ busy: true })
      try {
        const result = await window.api.confirmImport(preview.token, answers)
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
          return null
        }

        const parts = [`Imported ${added} new ${noun}`]
        if (skipped > 0) parts.push(`${skipped} already present`)
        if (dropped > 0) parts.push(`${dropped} ${dropped === 1 ? 'row' : 'rows'} left out`)
        if (refused > 0) parts.push(`${refused} ${refused === 1 ? 'row' : 'rows'} refused by the database`)
        get().notify(parts.join(' · '))
        return null
      } catch (error) {
        const message = messageOf(error)
        get().notify(message, 'error')
        return message
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

/** Every live account summed, so credit balances subtract and investments count. */
export function selectTotalWealthCents(state: SnapshotState): number {
  return state.snapshot ? totalWealthCents(state.snapshot.accounts) : 0
}

export function selectSafeToSpendPoolCents(state: SnapshotState): number {
  return state.snapshot ? safeToSpendPoolCents(state.snapshot.accounts) : 0
}

export function selectMonthlyWallCents(state: SnapshotState): number {
  return state.snapshot ? monthlyWall(activeBills(state.snapshot.bills)) : 0
}

export function selectFundedGoalsCents(state: SnapshotState): number {
  return state.snapshot ? fundedGoalsCents(state.snapshot.goals) : 0
}

export function selectPoolEarmarkedGoalsCents(state: SnapshotState): number {
  return state.snapshot ? poolEarmarkedGoalsCents(state.snapshot.goals) : 0
}

/**
 * Safe to Spend = the accounts the user treats as spendable − Priority Wall −
 * the funded goals whose money sits in that pool. The pool is not "cash on
 * hand": an account can be tracked as cash and still be excluded. A goal funded
 * from a dedicated account is already outside the pool, so it is not deducted
 * again — only the committed-spending meter below is measured against all cash.
 */
export function selectSafeToSpendCents(state: SnapshotState): number {
  return (
    selectSafeToSpendPoolCents(state) -
    selectMonthlyWallCents(state) -
    selectPoolEarmarkedGoalsCents(state)
  )
}

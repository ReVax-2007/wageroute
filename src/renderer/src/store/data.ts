import type { StateCreator } from 'zustand'
import { SNAPSHOT_TRANSACTION_LIMIT, type ImportCounts, type WriteResult } from '@shared/api'
import { apiErrorMessage } from '@shared/errors'
import { formatMoney } from '@shared/money'
import { DEFAULT_SETTINGS, parseSettings } from '@shared/settings'
import type { SnapshotPatch, TransactionRow, TransactionRowsPatch } from '@shared/types'
import type { DataSlice, FinanceState } from './types'

function messageOf(error: unknown): string {
  return apiErrorMessage(error)
}

function totalCounts(counts: ImportCounts): number {
  return Object.values(counts).reduce((sum, value) => sum + value, 0)
}

function fileNameOf(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}

/** Same order the snapshot query uses: newest date, then newest write. */
function mergeTransactionRows(
  current: readonly TransactionRow[],
  rows: TransactionRowsPatch
): TransactionRow[] {
  const removed = new Set(rows.remove)
  const changed = new Set(rows.upsert.map((row) => row.id))
  return current
    .filter((row) => !removed.has(row.id) && !changed.has(row.id))
    .concat(rows.upsert)
    .sort(
      (a, b) =>
        b.occurredOn.localeCompare(a.occurredOn) || b.createdAt.localeCompare(a.createdAt)
    )
    .slice(0, SNAPSHOT_TRANSACTION_LIMIT)
}

/** The ledger and every write that changes it. */
export const createDataSlice: StateCreator<FinanceState, [], [], DataSlice> = (set, get) => {
  // Writes run one at a time so a fast second edit cannot land before the first
  // and overwrite it by arrival order.
  let queue: Promise<unknown> = Promise.resolve()
  const enqueue = <T,>(task: () => Promise<T>): Promise<T> => {
    const next = queue.then(task, task)
    queue = next.catch(() => undefined)
    return next
  }

  /**
   * Folds the tables a write touched into the snapshot the screen already has.
   * The main process computed them from the same database, so this is the same
   * data a full read would return, minus the tables the write never changed.
   */
  const applyPatch = (patch: SnapshotPatch): void => {
    set((state) => {
      if (!state.snapshot) return state
      return {
        snapshot: { ...state.snapshot, ...patch },
        settings: patch.settings ? parseSettings(patch.settings) : state.settings
      }
    })
  }

  /**
   * Applies a write's result. Ledger edits carry the changed rows instead of a
   * fresh 500-row window, so the grid learns about one save without paying for
   * the whole ledger.
   */
  const applyResult = (result: WriteResult<unknown>): void => {
    const rows = result.rows?.transactions
    applyPatch(result.patch)
    if (!rows) return
    set((state) => {
      const snapshot = state.snapshot
      if (!snapshot) return state
      const transactions = mergeTransactionRows(snapshot.transactions, rows)
      return {
        snapshot: {
          ...snapshot,
          transactions,
          transactionTotal: rows.total,
          billPaymentsThisMonth: rows.billPayments
        }
      }
    })
  }

  /**
   * Runs a write and applies the patch it returned. A failed write returns false
   * and leaves the state alone; a write that *committed* but whose follow-up
   * read failed returns true, because the data is safe and the caller should
   * close, and says on screen that the view may be stale.
   *
   * A `key` marks the one row being written instead of disabling the window:
   * grid edits are frequent and unrelated to the dialogs they run beside.
   */
  const run = async (
    task: () => Promise<WriteResult<unknown>>,
    success?: string,
    key?: string
  ): Promise<boolean> => {
    if (key) set((state) => ({ pending: { ...state.pending, [key]: true } }))
    else set({ busy: true })
    let result: WriteResult<unknown>
    try {
      result = await enqueue(task)
    } catch (error) {
      get().notify(messageOf(error), 'error')
      return false
    } finally {
      if (key) {
        set((state) => {
          const pending = { ...state.pending }
          delete pending[key]
          return { pending }
        })
      } else {
        // The write is done (or failed); nothing below keeps the app disabled.
        set({ busy: false })
      }
    }

    if (result.refreshError) {
      get().notify(`Saved, but the screen could not refresh — ${result.refreshError}`, 'error')
      return true
    }
    applyResult(result)
    if (success) get().notify(success, 'success')
    return true
  }

  return {
    status: 'loading',
    error: null,
    snapshot: null,
    settings: DEFAULT_SETTINGS,
    dbPath: '',
    appInfo: null,
    importPreview: null,
    importStep: 'fix',
    busy: false,
    pending: {},

    init: async () => {
      // The ledger is the only call that can block the app; the path and the
      // build info are conveniences, so one failure must not hide the other.
      const [snapshot, dbPath, appInfo] = await Promise.allSettled([
        window.api.getSnapshot(),
        window.api.getDatabasePath(),
        window.api.getAppInfo()
      ])
      if (snapshot.status === 'rejected') {
        // The path is what support will ask for, and the error screen offers it.
        set({
          status: 'error',
          error: `The ledger could not be read — ${messageOf(snapshot.reason)}`,
          dbPath: dbPath.status === 'fulfilled' ? dbPath.value : ''
        })
        return
      }
      set({
        snapshot: snapshot.value,
        settings: parseSettings(snapshot.value.settings),
        dbPath: dbPath.status === 'fulfilled' ? dbPath.value : '',
        appInfo: appInfo.status === 'fulfilled' ? appInfo.value : null,
        status: 'ready'
      })
    },

    refresh: async () => {
      const snapshot = await window.api.getSnapshot()
      set({ snapshot, settings: parseSettings(snapshot.settings) })
    },

    createAccount: (input) => run(() => window.api.createAccount(input), 'Account added'),
    updateAccount: (id, input) =>
      run(() => window.api.updateAccount(id, input), 'Account updated'),
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
    createCategory: (input) => run(() => window.api.createCategory(input), 'Category added'),
    updateCategory: (id, input) =>
      run(() => window.api.updateCategory(id, input), 'Category updated'),
    deleteCategory: (id) =>
      run(
        () => window.api.deleteCategory(id),
        'Category removed — its entries keep their label'
      ),
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
      run(() => window.api.updateTransaction(id, patch), 'Entry saved', id),
    deleteTransaction: (id) => run(() => window.api.deleteTransaction(id), 'Entry removed', id),

    deleteTransactions: async (ids) => {
      const unique = [...new Set(ids)]
      if (unique.length === 0) return 0
      set({ busy: true })
      try {
        const result = await enqueue(() => window.api.deleteTransactions(unique))
        if (result.refreshError) {
          get().notify(
            `Removed ${result.value}, but the screen could not refresh — ${result.refreshError}`,
            'error'
          )
          return result.value
        }
        applyResult(result)
        get().notify(
          result.value === 1 ? 'Entry removed' : `${result.value} entries removed`,
          'success'
        )
        return result.value
      } catch (error) {
        get().notify(messageOf(error), 'error')
        return null
      } finally {
        set({ busy: false })
      }
    },

    queryTransactions: (query) => window.api.queryTransactions(query),

    commitPaycheck: async (input) => {
      const ok = await run(() => window.api.commitPaycheck(input), 'Paycheck routed')
      if (ok) set({ allocatorOpen: false, screen: 'dashboard' })
      return ok
    },

    applyPaycheckPlan: async (paycheckId, targets) => {
      if (targets.length === 0) return null
      set({ busy: true })
      try {
        const result = await enqueue(() => window.api.applyPaycheckPlan(paycheckId, targets))
        if (result.refreshError) {
          get().notify(
            `Moved ${formatMoney(result.value.movedCents, get().settings.currency)}, but the screen could not refresh — ${result.refreshError}`,
            'error'
          )
          return result.value
        }
        applyPatch(result.patch)
        const { movedCents, transfers, alreadyMoved } = result.value
        if (transfers === 0) {
          get().notify(
            alreadyMoved.length > 0 ? 'That plan was already moved' : 'Nothing to move'
          )
        } else {
          get().notify(
            `Moved ${formatMoney(movedCents, get().settings.currency)} in ${transfers} transfer${transfers === 1 ? '' : 's'}`
          )
        }
        return result.value
      } catch (error) {
        get().notify(messageOf(error), 'error')
        return null
      } finally {
        set({ busy: false })
      }
    },

    saveSettings: async (next) => {
      const previous = get().settings
      set({ settings: next })
      try {
        const result = await enqueue(() => window.api.saveSettings(next))
        if (result.refreshError) {
          get().notify(
            `Saved, but the screen could not refresh — ${result.refreshError}`,
            'error'
          )
          return true
        }
        applyPatch(result.patch)
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
        set({
          importPreview: preview,
          importStep: preview.problems.length > 0 ? 'fix' : 'review'
        })
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
        if (refused > 0)
          parts.push(`${refused} ${refused === 1 ? 'row' : 'rows'} could not be imported`)
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
      const ok = await run(
        () => window.api.resetData(),
        'All data erased — back to a blank profile.'
      )
      if (ok) set({ screen: 'dashboard' })
    }
  }
}

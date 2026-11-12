import type { AdjustmentReason } from '@shared/adjustments'
import type { AppInfo, BillDeletionSummary, ImportNeedsPassphrase, ImportPreview } from '@shared/api'
import type { ImportAnswer } from '@shared/importRepair'
import type { StatementReconciliation } from '@shared/statements'
import type {
  AccountInput,
  AccountWithBalance,
  AppliedPlan,
  AppSettings,
  BillInput,
  CategoryInput,
  GoalInput,
  LedgerQuery,
  PaycheckDraftInput,
  PlanMoveTarget,
  Snapshot,
  SplitTransferInput,
  TransactionInput,
  TransactionPage,
  TransactionPatch
} from '@shared/types'

export type Screen = 'dashboard' | 'wall' | 'goals' | 'accounts' | 'transfers' | 'ledger' | 'settings'

export interface Notice {
  text: string
  tone: 'success' | 'error'
}

/** A question the renderer asks through the shared dialog, never window.confirm. */
export interface ConfirmRequest {
  title: string
  body: string
  confirmLabel?: string
  danger?: boolean
}

/** What the window is showing: navigation, notices, prompts and the open dialog. */
export interface SessionSlice {
  screen: Screen
  allocatorOpen: boolean
  confirmRequest: (ConfirmRequest & { resolve: (ok: boolean) => void }) | null
  notice: Notice | null
  snoozedPrompts: string[]
  /** The account the Spreadsheet opens on; set by an account's History action. */
  ledgerAccountId: string | null

  go: (screen: Screen) => void
  /** The Spreadsheet scoped to one account, with its running balance. */
  openAccountHistory: (accountId: string) => void
  askConfirm: (request: ConfirmRequest) => Promise<boolean>
  resolveConfirm: (ok: boolean) => void
  openAllocator: () => void
  closeAllocator: () => void
  snoozePrompt: (key: string) => void
  unsnoozePrompt: (key: string) => void
  notify: (text: string, tone?: Notice['tone']) => void
  dismissNotice: () => void
  pauseNotice: () => void
  resumeNotice: () => void
}

/** The ledger itself, plus every write that changes it. */
export interface DataSlice {
  status: 'loading' | 'ready' | 'error'
  error: string | null
  snapshot: Snapshot | null
  settings: AppSettings
  dbPath: string
  appInfo: AppInfo | null
  importPreview: ImportPreview | ImportNeedsPassphrase | null
  importStep: 'fix' | 'review'
  /** A just-imported statement whose closing balance disagrees with the ledger. */
  reconciliation: StatementReconciliation | null
  /** Boot, import, reset and export: everything that blocks the whole window. */
  busy: boolean
  /** Row-level writes in flight, keyed by id, so one save does not freeze the app. */
  pending: Record<string, true>

  init: () => Promise<void>
  refresh: () => Promise<void>

  createAccount: (input: AccountInput) => Promise<boolean>
  updateAccount: (id: string, input: Partial<AccountInput>) => Promise<boolean>
  deleteAccount: (id: string, withEntries?: boolean) => Promise<boolean>
  archiveAccount: (id: string, archived: boolean) => Promise<boolean>
  lockAccount: (id: string, locked: boolean) => Promise<boolean>
  /** Live entries a delete of this account retires, or null when the read failed. */
  countAccountDeletion: (id: string) => Promise<number | null>
  adjustAccountBalance: (
    account: AccountWithBalance,
    targetBalanceCents: number,
    occurredOn: string,
    reason?: AdjustmentReason
  ) => Promise<boolean>
  createBill: (input: BillInput) => Promise<boolean>
  updateBill: (id: string, input: Partial<BillInput>) => Promise<boolean>
  deleteBill: (id: string) => Promise<boolean>
  /** What a delete of this bill does to the rows around it, or null when the read failed. */
  countBillDeletion: (id: string) => Promise<BillDeletionSummary | null>
  createCategory: (input: CategoryInput) => Promise<boolean>
  updateCategory: (id: string, input: Partial<CategoryInput>) => Promise<boolean>
  deleteCategory: (id: string) => Promise<boolean>
  createGoal: (input: GoalInput) => Promise<boolean>
  updateGoal: (id: string, input: Partial<GoalInput>) => Promise<boolean>
  deleteGoal: (id: string) => Promise<boolean>
  archiveGoal: (id: string, archived: boolean) => Promise<boolean>
  createTransaction: (input: TransactionInput) => Promise<boolean>
  createSplitTransfer: (input: SplitTransferInput) => Promise<boolean>
  updateTransaction: (id: string, patch: TransactionPatch) => Promise<boolean>
  deleteTransaction: (id: string) => Promise<boolean>
  /** Resolves to how many rows went, or null when the batch failed. */
  deleteTransactions: (ids: string[]) => Promise<number | null>
  /** How many live entries a delete of this selection would retire. */
  countEntryDeletion: (ids: string[]) => Promise<number>
  /** A filtered page of the ledger, read straight from the database. */
  queryTransactions: (query: LedgerQuery) => Promise<TransactionPage>
  commitPaycheck: (input: PaycheckDraftInput) => Promise<boolean>
  applyPaycheckPlan: (
    paycheckId: string,
    targets: PlanMoveTarget[]
  ) => Promise<AppliedPlan | null>
  saveSettings: (next: AppSettings) => Promise<boolean>
  setDisplayName: (name: string) => Promise<boolean>
  /** A phrase seals the export into an envelope; `null` writes the readable file. */
  exportBackup: (passphrase: string | null) => Promise<void>
  exportCsv: () => Promise<void>
  openImport: () => Promise<void>
  /** The phrase for a sealed file. Null once it opens; otherwise why it stayed shut, and whether typing again can help. */
  unlockImport: (
    passphrase: string
  ) => Promise<{ message: string; retry: boolean } | null>
  closeImport: () => void
  goImportStep: (step: 'fix' | 'review') => void
  /** Resolves to an error message on failure, or null once the wizard can close. */
  runImport: (answers: ImportAnswer[]) => Promise<string | null>
  /** Posts the one entry that brings the account to the statement's figure. */
  reconcileStatement: (reconciliation: StatementReconciliation) => Promise<boolean>
  dismissReconciliation: () => void
  resetData: () => Promise<void>
}

export type FinanceState = SessionSlice & DataSlice

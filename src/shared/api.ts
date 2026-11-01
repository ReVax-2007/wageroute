import type { AllocationPlan } from './allocator'
import type {
  ImportAnswer,
  ImportChoice,
  ImportChoiceTable,
  ImportProblem,
  ImportTable
} from './importRepair'
import type {
  AccountInput,
  AppSettings,
  BillInput,
  BillPaymentTotal,
  CategoryInput,
  GoalInput,
  AppliedPlan,
  LedgerQuery,
  PaycheckDraftInput,
  PlanMoveTarget,
  Snapshot,
  SnapshotPatch,
  TransactionInput,
  TransactionPage,
  TransactionPatch,
  TransactionRowsPatch
} from './types'
import type { StatementInfo } from './statements'

export interface CommittedPaycheck {
  paycheckId: string
  /** Null on an idempotent retry: the first attempt already planned this draft. */
  plan: AllocationPlan | null
  /** True when this draft had already committed; nothing was written twice. */
  alreadyCommitted?: boolean
}

/**
 * What a write hands back. `patch` holds only the snapshot tables the write
 * touched, so the screen can update itself without a second full read; when
 * that follow-up read failed the write still committed, and `refreshError`
 * says so instead of inviting the user to write again.
 *
 * `rows.transactions` is the narrower path for ledger edits: the changed rows
 * themselves instead of a re-read of the capped window.
 */
export interface WriteResult<T> {
  value: T
  patch: SnapshotPatch
  rows?: { transactions?: TransactionRowsPatch }
  refreshError?: string
}

/** The newest entries a snapshot carries, and the grid shows. */
export const SNAPSHOT_TRANSACTION_LIMIT = 500

export interface ImportCounts {
  accounts: number
  balance_snapshots: number
  categories: number
  bills: number
  goals: number
  paychecks: number
  allocations: number
  bill_reserves: number
  transactions: number
  settings: number
}

export interface ImportIssue {
  /** CSV entry rows report the file line; backup rows report the table. */
  line?: number
  table?: ImportTable
  message: string
}

/** A row the wizard left out, with the reason and how to repair the file. */
export interface ImportDroppedRow {
  rowLabel: string
  reason: string
  fixHint: string
}

export interface ImportPreview {
  /** Handle for the file held open in the main process until the import runs. */
  token: string
  path: string
  format: 'backup' | 'entries'
  exportedAt: string
  /** How many rows the file carries per table. */
  fileRows: ImportCounts
  /** Rows that cannot import as they stand; the wizard asks about each one. */
  problems: ImportProblem[]
  /** Local rows a reference can be pointed at. */
  choices: Record<ImportChoiceTable, ImportChoice[]>
  /** Present when the file is a bank statement rather than an entry list. */
  statement?: StatementInfo
  /** Rows the parser already left out, with the line they came from. */
  issues?: ImportIssue[]
}

export interface ImportResult {
  path: string
  format: 'backup' | 'entries'
  exportedAt: string
  added: ImportCounts
  skipped: ImportCounts
  dropped: ImportDroppedRow[]
  issues: ImportIssue[]
}

export function emptyImportCounts(): ImportCounts {
  return {
    accounts: 0,
    balance_snapshots: 0,
    categories: 0,
    bills: 0,
    goals: 0,
    paychecks: 0,
    allocations: 0,
    bill_reserves: 0,
    transactions: 0,
    settings: 0
  }
}

/**
 * What the installed bundle reports about itself. `version` comes from
 * `app.getVersion()` — the value baked into the build, not `package.json` on disk.
 */
export interface AppInfo {
  version: string
  schemaVersion: number
  electron: string
}

/**
 * Everything a bug report needs and nothing it does not: no account names, no
 * amounts, no settings. The row counts say whether the ledger is empty, not
 * what is in it.
 */
export interface AppDiagnostics {
  generatedAt: string
  version: string
  schemaVersion: number
  electron: string
  chrome: string
  node: string
  platform: string
  arch: string
  packaged: boolean
  databasePath: string
  databaseBytes: number
  backupsPath: string
  logPath: string
  logTail: string
  counts: ImportCounts
}

/** The licence the app ships under and the notices for the code it carries. */
export interface LegalTexts {
  license: string
  notices: string
}

export interface FinanceApi {
  getSnapshot(): Promise<Snapshot>
  getDatabasePath(): Promise<string>
  getAppInfo(): Promise<AppInfo>
  getDiagnostics(): Promise<AppDiagnostics>
  getLegalTexts(): Promise<LegalTexts>

  createAccount(input: AccountInput): Promise<WriteResult<string>>
  updateAccount(id: string, input: Partial<AccountInput>): Promise<WriteResult<void>>
  /**
   * Deletes an account. An account with entries is refused unless `withEntries`
   * is set, because deleting it alone would hide those entries from every total.
   */
  deleteAccount(
    id: string,
    options?: { withEntries?: boolean }
  ): Promise<WriteResult<void>>
  archiveAccount(id: string, archived: boolean): Promise<WriteResult<void>>
  accountEntryCount(id: string): Promise<number>

  createBill(input: BillInput): Promise<WriteResult<string>>
  updateBill(id: string, input: Partial<BillInput>): Promise<WriteResult<void>>
  deleteBill(id: string): Promise<WriteResult<void>>
  /**
   * What each bill has already been paid in one `YYYY-MM` month. The routing
   * preview asks for the pay date's month, which the snapshot (keyed to today)
   * cannot answer when a paycheck is dated into another month.
   */
  billPayments(month: string): Promise<BillPaymentTotal[]>

  createCategory(input: CategoryInput): Promise<WriteResult<string>>
  updateCategory(id: string, input: Partial<CategoryInput>): Promise<WriteResult<void>>
  /** Removes the category; entries keep their last text and lose the pointer. */
  deleteCategory(id: string): Promise<WriteResult<void>>

  createGoal(input: GoalInput): Promise<WriteResult<string>>
  updateGoal(id: string, input: Partial<GoalInput>): Promise<WriteResult<void>>
  deleteGoal(id: string): Promise<WriteResult<void>>
  archiveGoal(id: string, archived: boolean): Promise<WriteResult<void>>

  createTransaction(input: TransactionInput): Promise<WriteResult<string>>
  updateTransaction(id: string, input: TransactionPatch): Promise<WriteResult<void>>
  deleteTransaction(id: string): Promise<WriteResult<void>>
  /** Deletes a selection, removing both legs of any transfer it touches. */
  deleteTransactions(ids: string[]): Promise<WriteResult<number>>
  /** One filtered, sorted page of the ledger, with the filter's own total. */
  queryTransactions(query: LedgerQuery): Promise<TransactionPage>

  commitPaycheck(input: PaycheckDraftInput): Promise<WriteResult<CommittedPaycheck>>
  /**
   * Moves the money a committed paycheck reserved to its target accounts.
   * Posting the same plan twice moves nothing the second time.
   */
  applyPaycheckPlan(paycheckId: string, targets: PlanMoveTarget[]): Promise<WriteResult<AppliedPlan>>
  saveSettings(settings: AppSettings): Promise<WriteResult<void>>

  exportBackup(): Promise<string | null>
  exportTransactionsCsv(): Promise<string | null>
  /** Opens the file picker and reports what the import would need fixed. */
  previewImport(): Promise<ImportPreview | null>
  /** Runs the import for a preview token, applying the wizard's answers. */
  confirmImport(token: string, answers: ImportAnswer[]): Promise<ImportResult>
  resetData(): Promise<WriteResult<void>>
}

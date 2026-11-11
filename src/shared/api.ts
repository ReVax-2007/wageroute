import type { AllocationPlan } from './allocator'
import type {
  EnableEncryptionRequest,
  EncryptionChange,
  EncryptionStatus,
  KeyCustodyChange
} from './encryption'
import type {
  DroppedRow,
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
  SplitTransferInput,
  TransactionInput,
  TransactionPage,
  TransactionPatch,
  TransactionRowsPatch
} from './types'
import type { StatementInfo, StatementReconciliation } from './statements'

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
export type ImportDroppedRow = DroppedRow

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

/**
 * The file is a sealed envelope, so nothing can be counted until it opens. The
 * wizard gets this instead of a preview and asks for the passphrase; the token
 * is the held file, and `supplyPassphrase` trades it for a real preview.
 */
export interface ImportNeedsPassphrase {
  sealed: true
  token: string
  path: string
  /** Read straight off the header, which is in the clear. Empty when unusable. */
  exportedAt: string
}

export interface ImportResult {
  path: string
  format: 'backup' | 'entries'
  exportedAt: string
  added: ImportCounts
  /** Rows the file holds a newer version of; a second device's edits land here. */
  updated: ImportCounts
  /** Rows the file marks deleted with a tombstone newer than the local row. */
  removed: ImportCounts
  skipped: ImportCounts
  dropped: ImportDroppedRow[]
  issues: ImportIssue[]
  /**
   * Present when a statement carried a closing balance and its account was
   * mapped. The comparison is made after the import, so it describes the
   * ledger as it stands rather than a projection.
   */
  reconciliation?: StatementReconciliation
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
 * what is in it. The encryption line is booleans and a cipher name — enough to
 * tell a refused open from a damaged file, and never a key, a wrap or a phrase.
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
  encryption: EncryptionStatus
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

/** Where the ledger and its safety copies currently live. */
export interface StorageLocationInfo {
  directory: string
  defaultDirectory: string
  backupsDirectory: string
  isDefault: boolean
}

/** What a picked folder holds, before the user decides what to do with it. */
export interface StorageCandidate {
  directory: string
  hasLedger: boolean
  schemaVersion: number | null
  locked: boolean
  lockedBy: string | null
}

/**
 * `adopt` opens a ledger that is already in the folder (another computer's data,
 * or this computer's earlier copy). `move` copies this computer's ledger into an
 * empty folder. `fresh` starts a new empty ledger there.
 */
export type StorageMoveMode = 'adopt' | 'move' | 'fresh'

export interface StorageMoveResult {
  directory: string
  restartRequired: true
}

/**
 * What a delete of one bill would do to the rows around it, read before the
 * write so the question can say it. `reserves` are the set-asides that go with
 * the bill; `linkedEntries` are the ledger rows that stay, released from the bill
 * they used to prove. Both are counted with the same filter the write uses, so
 * the numbers cannot describe a different delete from the one being offered.
 */
export interface BillDeletionSummary {
  reserves: number
  linkedEntries: number
}

export interface FinanceApi {
  getSnapshot(): Promise<Snapshot>
  getDatabasePath(): Promise<string>
  getAppInfo(): Promise<AppInfo>
  getDiagnostics(): Promise<AppDiagnostics>
  getLegalTexts(): Promise<LegalTexts>
  /** Where the ledger lives now, and whether that is the app's own folder. */
  getStorageLocation(): Promise<StorageLocationInfo>
  /** Opens the folder picker and inspects what is there; null when cancelled. */
  chooseStorageDirectory(): Promise<StorageCandidate | null>
  /**
   * Points WageRoute at a folder and restarts it. The call does not resolve when
   * the switch succeeds: the process exits so the next launch opens the new data.
   */
  applyStorageDirectory(directory: string, mode: StorageMoveMode): Promise<StorageMoveResult>
  /** Returns to the per-user folder this computer keeps, and restarts. */
  useDefaultStorage(): Promise<StorageMoveResult>

  /** What the ledger's own bytes say about encryption, plus who can open it. */
  getEncryptionStatus(): Promise<EncryptionStatus>
  /**
   * Rewrites every page of the ledger, then restarts the app. The transition
   * cannot run with this session's handle still holding the file, and that
   * handle is bound to the state it opened in, so there is no continuation
   * here — only a restart, whichever way the change went.
   */
  enableEncryption(request: EnableEncryptionRequest): Promise<EncryptionChange>
  /** The same journey back to plaintext, with the same restart. */
  disableEncryption(): Promise<EncryptionChange>
  /**
   * Add, remove or replace a way of holding the key. No page moves and nothing
   * restarts: this re-wraps 32 bytes and answers with the new status.
   */
  changeKeyCustody(change: KeyCustodyChange): Promise<EncryptionStatus>

  /** What the ledger's own bytes say about encryption, plus who can open it. */
  getEncryptionStatus(): Promise<EncryptionStatus>
  /**
   * Rewrites every page of the ledger, then restarts the app. The call resolves
   * only to say a restart is coming: the transition cannot run with this
   * session's handle still holding the file, and that handle is bound to the
   * state it opened in.
   */
  enableEncryption(request: EnableEncryptionRequest): Promise<EncryptionChange>
  /** The same journey back to plaintext, with the same restart. */
  disableEncryption(): Promise<EncryptionChange>
  /**
   * Add, remove or replace a way of holding the key. This one does not rewrite
   * the ledger and does not restart anything: it re-wraps 32 bytes.
   */
  changeKeyCustody(change: KeyCustodyChange): Promise<EncryptionStatus>

  /** Sets or clears the name used in the Home greeting. */
  setDisplayName(name: string): Promise<WriteResult<void>>

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
  /**
   * How many live entries deleting this account would retire. It is larger than
   * the rows recorded in the account whenever a transfer's twin or a purchase's
   * sweep leg stands in another account, which is what leaves the ledger rather
   * than what was recorded here.
   */
  countAccountDeletion(id: string): Promise<number>

  createBill(input: BillInput): Promise<WriteResult<string>>
  updateBill(id: string, input: Partial<BillInput>): Promise<WriteResult<void>>
  deleteBill(id: string): Promise<WriteResult<void>>
  /**
   * What each bill has already been paid in one `YYYY-MM` month. The routing
   * preview asks for the pay date's month, which the snapshot (keyed to today)
   * cannot answer when a paycheck is dated into another month.
   */
  billPayments(month: string): Promise<BillPaymentTotal[]>
  /**
   * What deleting this bill would do to the rows around it: the set-asides that
   * go with it and the entries that stay in the ledger without it.
   */
  countBillDeletion(id: string): Promise<BillDeletionSummary>

  createCategory(input: CategoryInput): Promise<WriteResult<string>>
  updateCategory(id: string, input: Partial<CategoryInput>): Promise<WriteResult<void>>
  /** Removes the category; entries keep their last text and lose the pointer. */
  deleteCategory(id: string): Promise<WriteResult<void>>

  createGoal(input: GoalInput): Promise<WriteResult<string>>
  updateGoal(id: string, input: Partial<GoalInput>): Promise<WriteResult<void>>
  deleteGoal(id: string): Promise<WriteResult<void>>
  archiveGoal(id: string, archived: boolean): Promise<WriteResult<void>>

  createTransaction(input: TransactionInput): Promise<WriteResult<string>>
  /** One source to several accounts, written as ordinary transfers all at once. */
  createSplitTransfer(input: SplitTransferInput): Promise<WriteResult<string[]>>
  updateTransaction(id: string, input: TransactionPatch): Promise<WriteResult<void>>
  deleteTransaction(id: string): Promise<WriteResult<void>>
  /** Deletes a selection, removing both legs of any transfer it touches. */
  deleteTransactions(ids: string[]): Promise<WriteResult<number>>
  /**
   * How many live entries a delete of this selection would retire, including a
   * transfer's matching leg and the sweep legs a rounded-up purchase owns, so a
   * confirmation can name the rows that go rather than the rows that were picked.
   */
  countEntryDeletion(ids: string[]): Promise<number>
  /** One filtered, sorted page of the ledger, with the filter's own total. */
  queryTransactions(query: LedgerQuery): Promise<TransactionPage>

  commitPaycheck(input: PaycheckDraftInput): Promise<WriteResult<CommittedPaycheck>>
  /**
   * Moves the money a committed paycheck reserved to its target accounts.
   * Posting the same plan twice moves nothing the second time.
   */
  applyPaycheckPlan(paycheckId: string, targets: PlanMoveTarget[]): Promise<WriteResult<AppliedPlan>>
  saveSettings(settings: AppSettings): Promise<WriteResult<void>>

  /**
   * Writes a full backup and reports the file. A passphrase seals it into an
   * envelope nobody can open without it; `null` writes the plain JSON backup.
   */
  exportBackup(passphrase: string | null): Promise<string | null>
  exportTransactionsCsv(): Promise<string | null>
  /** Opens the file picker and reports what the import would need fixed. */
  previewImport(): Promise<ImportPreview | ImportNeedsPassphrase | null>
  /** The passphrase for a sealed file, traded for the preview it should have had. */
  supplyPassphrase(token: string, passphrase: string): Promise<ImportPreview>
  /** Runs the import for a preview token, applying the wizard's answers. */
  confirmImport(token: string, answers: ImportAnswer[]): Promise<ImportResult>
  /**
   * Posts one adjustment so the account's balance on `balanceOn` equals the
   * statement's closing figure. Resolves to the amount posted; zero means the
   * ledger already agreed and nothing was written.
   */
  reconcileStatement(
    accountId: string,
    statementCents: number,
    balanceOn: string
  ): Promise<WriteResult<number>>
  resetData(): Promise<WriteResult<void>>
}

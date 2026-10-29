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
  GoalInput,
  PaycheckDraftInput,
  Snapshot,
  TransactionInput,
  TransactionPatch
} from './types'

export interface CommittedPaycheck {
  paycheckId: string
  plan: AllocationPlan
}

export interface ImportCounts {
  accounts: number
  bills: number
  goals: number
  paychecks: number
  allocations: number
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
    bills: 0,
    goals: 0,
    paychecks: 0,
    allocations: 0,
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

export interface FinanceApi {
  getSnapshot(): Promise<Snapshot>
  getDatabasePath(): Promise<string>
  getAppInfo(): Promise<AppInfo>

  createAccount(input: AccountInput): Promise<void>
  updateAccount(id: string, input: Partial<AccountInput>): Promise<void>
  deleteAccount(id: string): Promise<void>

  createBill(input: BillInput): Promise<void>
  updateBill(id: string, input: Partial<BillInput>): Promise<void>
  deleteBill(id: string): Promise<void>

  createGoal(input: GoalInput): Promise<void>
  updateGoal(id: string, input: Partial<GoalInput>): Promise<void>
  deleteGoal(id: string): Promise<void>

  createTransaction(input: TransactionInput): Promise<void>
  updateTransaction(id: string, input: TransactionPatch): Promise<void>
  deleteTransaction(id: string): Promise<void>

  commitPaycheck(input: PaycheckDraftInput): Promise<CommittedPaycheck>
  saveSettings(settings: AppSettings): Promise<void>

  exportBackup(): Promise<string | null>
  exportTransactionsCsv(): Promise<string | null>
  /** Opens the file picker and reports what the import would need fixed. */
  previewImport(): Promise<ImportPreview | null>
  /** Runs the import for a preview token, applying the wizard's answers. */
  confirmImport(token: string, answers: ImportAnswer[]): Promise<ImportResult | null>
  resetData(): Promise<void>
}

import type { AllocationPlan } from './allocator'
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
  line: number
  message: string
}

export interface ImportResult {
  path: string
  format: 'backup' | 'entries'
  exportedAt: string
  added: ImportCounts
  skipped: ImportCounts
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

export interface FinanceApi {
  getSnapshot(): Promise<Snapshot>
  getDatabasePath(): Promise<string>

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
  importData(): Promise<ImportResult | null>
  resetData(): Promise<void>
}

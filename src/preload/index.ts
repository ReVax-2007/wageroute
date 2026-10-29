import { contextBridge, ipcRenderer } from 'electron'
import type { FinanceApi } from '@shared/api'
import type { ImportAnswer } from '@shared/importRepair'
import type {
  AccountInput,
  AppSettings,
  BillInput,
  GoalInput,
  PaycheckDraftInput,
  TransactionInput,
  TransactionPatch
} from '@shared/types'

const invoke = ipcRenderer.invoke.bind(ipcRenderer)

const api: FinanceApi = {
  getSnapshot: () => invoke('snapshot:get'),
  getDatabasePath: () => invoke('db:path'),
  getAppInfo: () => invoke('app:info'),

  createAccount: (input: AccountInput) => invoke('account:create', input),
  updateAccount: (id: string, input: Partial<AccountInput>) => invoke('account:update', id, input),
  deleteAccount: (id: string, options?: { withEntries?: boolean }) =>
    invoke('account:delete', id, options),
  archiveAccount: (id: string, archived: boolean) => invoke('account:archive', id, archived),
  accountEntryCount: (id: string) => invoke('account:entry-count', id),

  createBill: (input: BillInput) => invoke('bill:create', input),
  updateBill: (id: string, input: Partial<BillInput>) => invoke('bill:update', id, input),
  deleteBill: (id: string) => invoke('bill:delete', id),

  createGoal: (input: GoalInput) => invoke('goal:create', input),
  updateGoal: (id: string, input: Partial<GoalInput>) => invoke('goal:update', id, input),
  deleteGoal: (id: string) => invoke('goal:delete', id),
  archiveGoal: (id: string, archived: boolean) => invoke('goal:archive', id, archived),

  createTransaction: (input: TransactionInput) => invoke('transaction:create', input),
  updateTransaction: (id: string, input: TransactionPatch) =>
    invoke('transaction:update', id, input),
  deleteTransaction: (id: string) => invoke('transaction:delete', id),

  commitPaycheck: (input: PaycheckDraftInput) => invoke('paycheck:commit', input),
  saveSettings: (settings: AppSettings) => invoke('settings:save', settings),

  exportBackup: () => invoke('backup:export'),
  exportTransactionsCsv: () => invoke('csv:export'),
  previewImport: () => invoke('data:preview'),
  confirmImport: (token: string, answers: ImportAnswer[]) => invoke('data:confirm', token, answers),
  resetData: () => invoke('data:reset')
}

contextBridge.exposeInMainWorld('api', api)

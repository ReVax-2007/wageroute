import type { FinanceApi } from '@shared/api'
import type { IpcCaller } from '@shared/channels'

/**
 * The bridge's whole surface, built from the shared channel contract. Kept free
 * of Electron imports so a test can call every method and prove each one reaches
 * a declared channel.
 */
export function createFinanceApi(call: IpcCaller): FinanceApi {
  return {
    getSnapshot: () => call('snapshot:get'),
    getDatabasePath: () => call('db:path'),
    getAppInfo: () => call('app:info'),
    getDiagnostics: () => call('app:diagnostics'),
    getLegalTexts: () => call('app:legal'),

    createAccount: (input) => call('account:create', input),
    updateAccount: (id, input) => call('account:update', id, input),
    deleteAccount: (id, options) => call('account:delete', id, options),
    archiveAccount: (id, archived) => call('account:archive', id, archived),
    accountEntryCount: (id) => call('account:entry-count', id),

    createBill: (input) => call('bill:create', input),
    updateBill: (id, input) => call('bill:update', id, input),
    deleteBill: (id) => call('bill:delete', id),
    billPayments: (month) => call('bill:payments', month),

    createCategory: (input) => call('category:create', input),
    updateCategory: (id, input) => call('category:update', id, input),
    deleteCategory: (id) => call('category:delete', id),

    createGoal: (input) => call('goal:create', input),
    updateGoal: (id, input) => call('goal:update', id, input),
    deleteGoal: (id) => call('goal:delete', id),
    archiveGoal: (id, archived) => call('goal:archive', id, archived),

    createTransaction: (input) => call('transaction:create', input),
    updateTransaction: (id, input) => call('transaction:update', id, input),
    deleteTransaction: (id) => call('transaction:delete', id),
    deleteTransactions: (ids) => call('transaction:delete-many', ids),
    queryTransactions: (query) => call('transaction:query', query),

    commitPaycheck: (input) => call('paycheck:commit', input),
    applyPaycheckPlan: (id, targets) => call('paycheck:apply', id, targets),
    saveSettings: (settings) => call('settings:save', settings),

    exportBackup: () => call('backup:export'),
    exportTransactionsCsv: () => call('csv:export'),
    reconcileStatement: (accountId, statementCents, balanceOn) =>
      call('statement:reconcile', accountId, statementCents, balanceOn),
    previewImport: () => call('data:preview'),
    confirmImport: (token, answers) => call('data:confirm', token, answers),
    resetData: () => call('data:reset')
  }
}

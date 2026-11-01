/**
 * The ledger's public write/read surface, kept as one import for callers. The
 * implementation lives with each aggregate under `./repo`; this file only
 * re-exports, so a change to accounts cannot reach into transactions by accident.
 */
export { getUser, getLocalUserId, wipeAllData } from './repo/users'
export { readSettings, writeSettings } from './repo/settings'
export {
  listAccounts,
  createAccount,
  updateAccount,
  accountEntryCount,
  deleteAccount,
  setAccountArchived,
  type DeleteAccountOptions
} from './repo/accounts'
export { listBills, createBill, updateBill, deleteBill } from './repo/bills'
export { listBillReserves, reservedBillIdsFor } from './repo/bills'
export {
  listGoals,
  createGoal,
  updateGoal,
  deleteGoal,
  setGoalArchived
} from './repo/goals'
export {
  listTransactions,
  listAllTransactions,
  transactionCount,
  insertTransactionRow,
  createTransaction,
  updateTransaction,
  deleteTransaction,
  type NewTransactionInput
} from './repo/transactions'
export {
  listPaychecks,
  insertPaycheckRecord,
  commitPaycheck,
  paycheckCount,
  type PaycheckRecordAllocation,
  type PaycheckRecordInput
} from './repo/paychecks'
export {
  listImportChoices,
  getSnapshot,
  readSnapshotParts,
  type SnapshotPart
} from './repo/read-models'

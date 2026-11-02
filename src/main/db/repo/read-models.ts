import { SNAPSHOT_TRANSACTION_LIMIT } from '@shared/api'
import type { ImportChoice, ImportChoiceTable } from '@shared/importRepair'
import type { Snapshot, SnapshotPatch } from '@shared/types'
import { listAccounts } from './accounts'
import { listBalanceSnapshots } from './balances'
import { listBillReserves, listBills } from './bills'
import { listCategories } from './categories'
import { getUser } from './users'
import { listGoals } from './goals'
import { listPaychecks, paycheckCount } from './paychecks'
import { readSettings } from './settings'
import {
  listBillPaymentsSince,
  listBillPaymentsThisMonth,
  listTransactions,
  transactionCount
} from './transactions'
import type { Db } from './common'
import { addDaysISO, todayISO } from '@shared/dates'

/**
 * Bill prompts compare the latest occurrence of an annual bill with its
 * payment, so the history has to reach a year back; the ledger window does not.
 */
const BILL_PAYMENT_HISTORY_DAYS = 370

/** The tables a write can change; a patch names only the ones it touched. */
export type SnapshotPart =
  | 'user'
  | 'settings'
  | 'accounts'
  | 'categories'
  | 'bills'
  | 'goals'
  | 'transactions'
  | 'paychecks'
  | 'billReserves'
  | 'balanceSnapshots'

/**
 * Rows an import can point at when a reference is missing or dangling. There is
 * no cap: a row dropped from this list would be reported as unmapped, and a
 * ledger with more than a couple of hundred accounts is unusual but not
 * impossible. These tables are small enough that the wizard can hold them all.
 */
export function listImportChoices(
  db: Db,
  userId: string
): Record<ImportChoiceTable, ImportChoice[]> {
  const rows = (sql: string): ImportChoice[] => db.prepare(sql).all(userId) as ImportChoice[]

  return {
    accounts: rows(
      `SELECT id, name AS label FROM accounts
       WHERE user_id = ? AND deleted_at IS NULL
       ORDER BY sort_order, name`
    ),
    categories: rows(
      `SELECT id, name AS label FROM categories
       WHERE user_id = ? AND deleted_at IS NULL
       ORDER BY sort_order, name`
    ),
    bills: rows(
      `SELECT id, name AS label FROM bills
       WHERE user_id = ? AND deleted_at IS NULL
       ORDER BY name`
    ),
    goals: rows(
      `SELECT id, name AS label FROM goals
       WHERE user_id = ? AND deleted_at IS NULL
       ORDER BY priority, name`
    ),
    paychecks: rows(
      `SELECT id, received_on || ' · ' || source AS label FROM paychecks
       WHERE user_id = ? AND deleted_at IS NULL
       ORDER BY received_on DESC`
    )
  }
}

// ---------------------------------------------------------------- snapshot

export function getSnapshot(db: Db, userId: string): Snapshot {
  // One read transaction: the separate statements could otherwise straddle a
  // write and hand the UI a snapshot that never existed.
  return db.transaction(
    (): Snapshot => ({
      user: getUser(db, userId),
      settings: readSettings(db, userId),
      accounts: listAccounts(db, userId),
      categories: listCategories(db, userId),
      bills: listBills(db, userId),
      goals: listGoals(db, userId),
      transactions: listTransactions(db, userId),
      transactionTotal: transactionCount(db, userId),
      billPaymentsThisMonth: listBillPaymentsThisMonth(db, userId, todayISO().slice(0, 7)),
      billPayments: listBillPaymentsSince(
        db,
        userId,
        addDaysISO(todayISO(), -BILL_PAYMENT_HISTORY_DAYS)
      ),
      paychecks: listPaychecks(db, userId),
      paycheckTotal: paycheckCount(db, userId),
      billReserves: listBillReserves(db, userId),
      balanceSnapshots: listBalanceSnapshots(db, userId)
    })
  )()
}

/**
 * The same reads, restricted to the tables a write touched. Every statement
 * still runs in one transaction, so a patch never mixes two moments.
 */
export function readSnapshotParts(
  db: Db,
  userId: string,
  parts: readonly SnapshotPart[]
): SnapshotPatch {
  const wanted = new Set(parts)
  return db.transaction((): SnapshotPatch => {
    const patch: SnapshotPatch = {}
    if (wanted.has('user')) patch.user = getUser(db, userId)
    if (wanted.has('settings')) patch.settings = readSettings(db, userId)
    if (wanted.has('accounts')) patch.accounts = listAccounts(db, userId)
    if (wanted.has('categories')) patch.categories = listCategories(db, userId)
    if (wanted.has('bills')) patch.bills = listBills(db, userId)
    if (wanted.has('goals')) patch.goals = listGoals(db, userId)
    if (wanted.has('transactions')) {
      patch.transactions = listTransactions(db, userId, SNAPSHOT_TRANSACTION_LIMIT)
      patch.transactionTotal = transactionCount(db, userId)
      patch.billPaymentsThisMonth = listBillPaymentsThisMonth(db, userId, todayISO().slice(0, 7))
      patch.billPayments = listBillPaymentsSince(
        db,
        userId,
        addDaysISO(todayISO(), -BILL_PAYMENT_HISTORY_DAYS)
      )
    }
    if (wanted.has('paychecks')) {
      patch.paychecks = listPaychecks(db, userId)
      patch.paycheckTotal = paycheckCount(db, userId)
    }
    if (wanted.has('billReserves')) patch.billReserves = listBillReserves(db, userId)
    if (wanted.has('balanceSnapshots')) {
      patch.balanceSnapshots = listBalanceSnapshots(db, userId)
    }
    return patch
  })()
}

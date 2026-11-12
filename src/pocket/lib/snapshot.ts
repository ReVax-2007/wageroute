import type { ImportTables } from '@shared/importRepair'
import { addDaysISO, todayISO } from '@shared/dates'
import type {
  AccountKind,
  AccountWithBalance,
  Allocation,
  BalanceSnapshot,
  Bill,
  BillPaymentEntry,
  BillPaymentTotal,
  BillReserve,
  BillReserveState,
  Category,
  GoalFundingPace,
  GoalFundingSource,
  GoalWithProgress,
  PaycheckWithAllocations,
  Snapshot,
  TransactionRow
} from '@shared/types'
import { SNAPSHOT_TRANSACTION_LIMIT } from '@shared/api'
import { creditedPaymentCents } from '@shared/variableBills'
import {
  ACCOUNT_KINDS,
  ALLOCATION_BUCKETS,
  BILL_RESERVE_STATES,
  CATEGORY_KINDS,
  FREQUENCIES,
  FUNDING_STRATEGIES,
  GOAL_FUNDING_PACES,
  PLAN_HEALTH,
  TRANSACTION_KINDS,
  pick
} from './enums'
import { byName, cents, flag, integer, isLive, nullableInteger, nullableText, settingRecord, text, type Row } from './rows'

/** The ledger window the desktop reads, so both show the same latest entries. */
export { SNAPSHOT_TRANSACTION_LIMIT }

const BILL_PAYMENT_HISTORY_DAYS = 370
const PAYCHECK_LIMIT = 24
const BALANCE_HISTORY_DAYS = 400

function sync(row: Row): {
  createdAt: string
  updatedAt: string
  deletedAt: string | null
  revision: number
} {
  return {
    createdAt: text(row, 'created_at'),
    updatedAt: text(row, 'updated_at'),
    deletedAt: nullableText(row, 'deleted_at'),
    revision: integer(row, 'revision', 1)
  }
}

/**
 * Every live entry as a ledger row, newest first, with the desktop's
 * tie-break (date, then written time, then id). The snapshot keeps the newest
 * window; an account's history reads all of them.
 */
export function ledgerRows(
  tables: ImportTables,
  entries: readonly Row[] = tables.transactions.filter(isLive)
): TransactionRow[] {
  const accountById = new Map<string, Row>()
  for (const row of tables.accounts) accountById.set(text(row, 'id'), row)
  // The ledger describes a link by name; the file is the only source on a phone.
  const billNames = new Map<string, string>()
  for (const row of tables.bills) billNames.set(text(row, 'id'), text(row, 'name', 'Bill'))
  const goalNames = new Map<string, string>()
  for (const row of tables.goals) goalNames.set(text(row, 'id'), text(row, 'name', 'Goal'))
  return entries
    .map((row) => {
      const account = accountById.get(text(row, 'account_id'))
      return {
        id: text(row, 'id'),
        userId: text(row, 'user_id'),
        accountId: text(row, 'account_id'),
        kind: pick(TRANSACTION_KINDS, text(row, 'kind'), 'expense'),
        amountCents: cents(row, 'amount_cents'),
        occurredOn: text(row, 'occurred_on'),
        memo: text(row, 'memo'),
        category: text(row, 'category', 'Uncategorized'),
        categoryId: nullableText(row, 'category_id'),
        externalId: nullableText(row, 'external_id'),
        billId: nullableText(row, 'bill_id'),
        goalId: nullableText(row, 'goal_id'),
        paycheckId: nullableText(row, 'paycheck_id'),
        counterAccountId: nullableText(row, 'counter_account_id'),
        transferGroupId: nullableText(row, 'transfer_group_id'),
        splitGroupId: nullableText(row, 'split_group_id'),
        ...sync(row),
        accountName: account ? text(account, 'name') : 'Unknown account',
        accountInstitution: account ? nullableText(account, 'institution') : null,
        billName: billNames.get(text(row, 'bill_id')) ?? null,
        goalName: goalNames.get(text(row, 'goal_id')) ?? null
      }
    })
    .sort(
      (a, b) =>
        b.occurredOn.localeCompare(a.occurredOn) ||
        b.createdAt.localeCompare(a.createdAt) ||
        b.id.localeCompare(a.id)
    )
}

/** One account's entries, newest first, with the balance after each. */
export interface AccountHistory {
  rows: TransactionRow[]
  balanceAfter: Map<string, number>
}

/**
 * Every live entry on one account, read from the whole file rather than the
 * snapshot's newest window, walked back from the balance the account shows so
 * the newest row always ends on it — the desktop's running balance, by the
 * same order.
 */
export function accountHistory(
  tables: ImportTables,
  account: Pick<AccountWithBalance, 'id' | 'balanceCents'>
): AccountHistory {
  const entries = tables.transactions.filter(
    (row) => isLive(row) && text(row, 'account_id') === account.id
  )
  const rows = ledgerRows(tables, entries)
  const balanceAfter = new Map<string, number>()
  let balance = account.balanceCents
  for (const row of rows) {
    balanceAfter.set(row.id, balance)
    balance -= row.amountCents
  }
  return { rows, balanceAfter }
}

/**
 * Rebuilds what the main process would hand the screens, from the rows in a
 * backup. The same shared modules then do the money maths, so a phone and a
 * desktop with the same file agree on every number.
 */
export function buildSnapshot(
  tables: ImportTables,
  today: string = todayISO()
): Snapshot {
  const liveAccounts = tables.accounts.filter(isLive)

  // Balances are derived exactly as the desktop derives them: starting money
  // plus every live entry, with cash stopping at today.
  const entries = tables.transactions.filter(isLive)
  const movement = new Map<string, { balance: number; cash: number }>()
  for (const entry of entries) {
    const accountId = text(entry, 'account_id')
    const running = movement.get(accountId) ?? { balance: 0, cash: 0 }
    const amount = cents(entry, 'amount_cents')
    running.balance += amount
    if (text(entry, 'occurred_on') <= today) running.cash += amount
    movement.set(accountId, running)
  }

  const accounts: AccountWithBalance[] = liveAccounts
    .map((row) => {
      const id = text(row, 'id')
      const starting = cents(row, 'starting_balance_cents')
      const moved = movement.get(id) ?? { balance: 0, cash: 0 }
      const inSafe = nullableInteger(row, 'in_safe_to_spend')
      return {
        id,
        userId: text(row, 'user_id'),
        name: text(row, 'name', 'Account'),
        kind: pick(ACCOUNT_KINDS, text(row, 'kind'), 'checking'),
        institution: nullableText(row, 'institution'),
        startingBalanceCents: starting,
        creditLimitCents: nullableInteger(row, 'credit_limit_cents'),
        color: nullableText(row, 'color'),
        dedicatedGoalId: nullableText(row, 'dedicated_goal_id'),
        inSafeToSpend: inSafe === null ? null : inSafe === 1,
        isArchived: flag(row, 'is_archived'),
        isLocked: flag(row, 'is_locked'),
        floorCents: nullableInteger(row, 'floor_cents'),
        sortOrder: integer(row, 'sort_order'),
        aprBps: nullableInteger(row, 'apr_bps'),
        minimumPaymentCents: nullableInteger(row, 'minimum_payment_cents'),
        statementDay: nullableInteger(row, 'statement_day'),
        paymentDueDay: nullableInteger(row, 'payment_due_day'),
        lastStatementBalanceCents: nullableInteger(row, 'last_statement_balance_cents'),
        ...sync(row),
        balanceCents: starting + moved.balance,
        cashCents: starting + moved.cash
      }
    })
    .sort(
      (a, b) =>
        Number(a.isArchived) - Number(b.isArchived) ||
        a.sortOrder - b.sortOrder ||
        byName(a.name, b.name)
    )

  const transactions: TransactionRow[] = ledgerRows(tables, entries)
    .slice(0, SNAPSHOT_TRANSACTION_LIMIT)

  const bills: Bill[] = tables.bills
    .filter(isLive)
    .map((row) => ({
      id: text(row, 'id'),
      userId: text(row, 'user_id'),
      name: text(row, 'name', 'Bill'),
      amountCents: cents(row, 'amount_cents'),
      frequency: pick(FREQUENCIES, text(row, 'frequency'), 'monthly'),
      dueDay: integer(row, 'due_day', 1),
      category: text(row, 'category', 'Bills'),
      accountId: nullableText(row, 'account_id'),
      autopay: flag(row, 'autopay'),
      isActive: flag(row, 'is_active', true),
      nextDueOn: nullableText(row, 'next_due_on'),
      fundingStrategy: pick(FUNDING_STRATEGIES, text(row, 'funding_strategy'), 'all_checks'),
      fundingPaycheckIndex: nullableInteger(row, 'funding_paycheck_index'),
      isVariable: flag(row, 'is_variable'),
      ...sync(row)
    }))
    .sort(
      (a, b) =>
        Number(b.isActive) - Number(a.isActive) ||
        a.dueDay - b.dueDay ||
        byName(a.name, b.name)
    )

  const allocationTotals = new Map<string, number>()
  const allocationsByPaycheck = new Map<string, Allocation[]>()
  for (const row of tables.allocations.filter(isLive)) {
    const allocation: Allocation = {
      id: text(row, 'id'),
      userId: text(row, 'user_id'),
      paycheckId: text(row, 'paycheck_id'),
      bucket: pick(ALLOCATION_BUCKETS, text(row, 'bucket'), 'priority'),
      goalId: nullableText(row, 'goal_id'),
      label: text(row, 'label'),
      amountCents: cents(row, 'amount_cents'),
      ...sync(row)
    }
    const list = allocationsByPaycheck.get(allocation.paycheckId) ?? []
    list.push(allocation)
    allocationsByPaycheck.set(allocation.paycheckId, list)
    if (allocation.bucket === 'goal' && allocation.goalId) {
      allocationTotals.set(
        allocation.goalId,
        (allocationTotals.get(allocation.goalId) ?? 0) + allocation.amountCents
      )
    }
  }
  for (const list of allocationsByPaycheck.values()) {
    list.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
  }

  // A dedicated account's balance is the goal's progress, exactly as on the
  // desktop; the allocation total is replaced, never added to.
  const dedicatedByGoal = new Map<string, { id: string; name: string; balanceCents: number }[]>()
  for (const account of accounts) {
    if (account.isArchived || account.dedicatedGoalId === null) continue
    const list = dedicatedByGoal.get(account.dedicatedGoalId) ?? []
    list.push({ id: account.id, name: account.name, balanceCents: account.balanceCents })
    dedicatedByGoal.set(account.dedicatedGoalId, list)
  }

  const goals: GoalWithProgress[] = tables.goals
    .filter(isLive)
    .map((row) => {
      const id = text(row, 'id')
      const sources = dedicatedByGoal.get(id) ?? []
      const fundedFrom: GoalFundingSource = sources.length > 0 ? 'account' : 'allocations'
      const fundedCents =
        fundedFrom === 'account'
          ? Math.max(0, sources.reduce((total, source) => total + source.balanceCents, 0))
          : (allocationTotals.get(id) ?? 0)
      const targetCents = cents(row, 'target_cents')
      return {
        id,
        userId: text(row, 'user_id'),
        name: text(row, 'name', 'Goal'),
        targetCents,
        targetDate: nullableText(row, 'target_date'),
        priority: integer(row, 'priority'),
        color: text(row, 'color', '#3ddc97'),
        accountId: nullableText(row, 'account_id'),
        isEmergency: flag(row, 'is_emergency'),
        isArchived: flag(row, 'is_archived'),
        fundingPace: pick<GoalFundingPace>(
          GOAL_FUNDING_PACES,
          text(row, 'funding_pace'),
          'asap'
        ),
        ...sync(row),
        fundedCents,
        remainingCents: Math.max(0, targetCents - fundedCents),
        fundedFrom,
        dedicatedAccounts: sources
      }
    })
    .sort(
      (a, b) =>
        Number(a.isArchived) - Number(b.isArchived) ||
        a.priority - b.priority ||
        byName(a.name, b.name)
    )

  const accountKind = new Map<string, AccountKind>()
  for (const row of tables.accounts) {
    accountKind.set(text(row, 'id'), pick(ACCOUNT_KINDS, text(row, 'kind'), 'checking'))
  }

  const month = today.slice(0, 7)
  // A deleted bill's entries were released from it, so only live bills credit.
  const billById = new Map(bills.map((bill) => [bill.id, bill]))
  const paidByBill = new Map<string, BillPaymentTotal>()
  for (const entry of entries) {
    const billId = nullableText(entry, 'bill_id')
    const kind = text(entry, 'kind')
    if (!billId || (kind !== 'bill_payment' && kind !== 'expense')) continue
    const occurredOn = text(entry, 'occurred_on')
    if (occurredOn.slice(0, 7) !== month || occurredOn > today) continue
    const total = paidByBill.get(billId) ?? { billId, paidCents: 0, actualCents: 0, creditCents: 0 }
    const amount = -cents(entry, 'amount_cents')
    const bill = billById.get(billId)
    total.paidCents += bill ? -creditedPaymentCents(bill, -amount) : amount
    total.actualCents += amount
    if (accountKind.get(text(entry, 'account_id')) === 'credit') total.creditCents += amount
    paidByBill.set(billId, total)
  }

  const since = addDaysISO(today, -BILL_PAYMENT_HISTORY_DAYS)
  const billPayments: BillPaymentEntry[] = entries
    .filter((entry) => {
      const kind = text(entry, 'kind')
      return (
        nullableText(entry, 'bill_id') !== null &&
        (kind === 'bill_payment' || kind === 'expense') &&
        text(entry, 'occurred_on') >= since
      )
    })
    .map((entry) => ({
      billId: text(entry, 'bill_id'),
      occurredOn: text(entry, 'occurred_on'),
      amountCents: cents(entry, 'amount_cents')
    }))
    .sort((a, b) => b.occurredOn.localeCompare(a.occurredOn))

  const paychecks: PaycheckWithAllocations[] = tables.paychecks
    .filter(isLive)
    .map((row) => {
      const id = text(row, 'id')
      return {
        id,
        userId: text(row, 'user_id'),
        amountCents: cents(row, 'amount_cents'),
        receivedOn: text(row, 'received_on'),
        source: text(row, 'source', 'Paycheck'),
        depositAccountId: nullableText(row, 'deposit_account_id'),
        priorityCents: cents(row, 'priority_cents'),
        surplusCents: cents(row, 'surplus_cents'),
        leisureCents: cents(row, 'leisure_cents'),
        health: pick(PLAN_HEALTH, text(row, 'health'), 'covered'),
        ...sync(row),
        allocations: allocationsByPaycheck.get(id) ?? []
      }
    })
    .sort(
      (a, b) =>
        b.receivedOn.localeCompare(a.receivedOn) || b.createdAt.localeCompare(a.createdAt)
    )
    .slice(0, PAYCHECK_LIMIT)

  const billReserves: BillReserve[] = tables.bill_reserves
    .filter(isLive)
    .map((row) => ({
      id: text(row, 'id'),
      userId: text(row, 'user_id'),
      billId: text(row, 'bill_id'),
      paycheckId: text(row, 'paycheck_id'),
      cycle: text(row, 'cycle'),
      amountCents: cents(row, 'amount_cents'),
      state: pick<BillReserveState>(
        BILL_RESERVE_STATES,
        text(row, 'state'),
        'reserved'
      ),
      strategy: pick(FUNDING_STRATEGIES, text(row, 'strategy'), 'all_checks'),
      dueDay: integer(row, 'due_day', 1),
      settledBy: nullableText(row, 'settled_by'),
      ...sync(row)
    }))
    .sort(
      (a, b) =>
        b.cycle.localeCompare(a.cycle) || b.createdAt.localeCompare(a.createdAt)
    )

  const balanceSince = addDaysISO(today, -BALANCE_HISTORY_DAYS)
  const balanceSnapshots: BalanceSnapshot[] = tables.balance_snapshots
    .filter((row) => {
      if (!isLive(row)) return false
      const onDate = text(row, 'on_date')
      return onDate >= balanceSince && onDate <= today
    })
    .map((row) => ({
      id: text(row, 'id'),
      userId: text(row, 'user_id'),
      accountId: text(row, 'account_id'),
      onDate: text(row, 'on_date'),
      balanceCents: cents(row, 'balance_cents'),
      ...sync(row)
    }))
    .sort(
      (a, b) => a.onDate.localeCompare(b.onDate) || a.accountId.localeCompare(b.accountId)
    )

  const categories: Category[] = tables.categories
    .filter(isLive)
    .map((row) => ({
      id: text(row, 'id'),
      userId: text(row, 'user_id'),
      name: text(row, 'name', 'Category'),
      kind: pick(CATEGORY_KINDS, text(row, 'kind'), 'expense'),
      color: nullableText(row, 'color'),
      sortOrder: integer(row, 'sort_order'),
      ...sync(row)
    }))
    .sort((a, b) => a.sortOrder - b.sortOrder || byName(a.name, b.name))

  const settings = settingRecord(tables.settings)
  const userId =
    accounts[0]?.userId ||
    paychecks[0]?.userId ||
    text(tables.settings[0] ?? {}, 'user_id') ||
    'local'

  return {
    user: {
      id: userId,
      email: null,
      displayName: '',
      currency: settings.currency ?? 'USD',
      createdAt: '',
      updatedAt: '',
      deletedAt: null,
      revision: 1
    },
    settings,
    accounts,
    bills,
    goals,
    categories,
    transactions,
    transactionTotal: entries.length,
    billPaymentsThisMonth: [...paidByBill.values()],
    billPayments,
    paychecks,
    paycheckTotal: tables.paychecks.filter(isLive).length,
    billReserves,
    balanceSnapshots
  }
}

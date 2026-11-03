import type { ImportTables } from '@shared/importRepair'
import {
  CATEGORY_NAME_MAX,
  categoryKey,
  defaultCategoryKind,
  normalizeCategoryName
} from '@shared/categories'
import { todayISO } from '@shared/dates'
import { RepositoryError } from '@shared/errors'
import { normalizeSignedCents, signedAmountError } from '@shared/kinds'
import { parseSettings } from '@shared/settings'
import { roundUpRemainderCents, transferLegs } from '@shared/transfers'
import type {
  AccountInput,
  AccountKind,
  BillInput,
  CategoryInput,
  GoalInput,
  TransactionInput,
  TransactionKind
} from '@shared/types'
import * as rules from '@shared/writeRules'
import { cents, flag, integer, isLive, nullableText, settingRecord, text, type Row } from './rows'

/**
 * The phone's write path.
 *
 * A Pocket edit produces exactly the row the desktop's repository would have
 * written: the same columns, the same defaults, the same enum sets and the same
 * refusal sentences, all read from `@shared/writeRules`. That is what lets an
 * edit made here travel back in a backup without a translation step — a merged
 * row is indistinguishable from a row the computer typed itself.
 *
 * Every writer takes the tables and returns new tables; nothing mutates in place,
 * so a failed save leaves the on-screen ledger exactly as it was.
 */

export type WritableTable = keyof ImportTables

type ColumnValue = string | number | null | undefined
type Columns = Record<string, ColumnValue>

export interface Written {
  tables: ImportTables
  id: string
}

function withRows(tables: ImportTables, table: WritableTable, rows: Row[]): ImportTables {
  return { ...tables, [table]: rows }
}

/** The id every row in this ledger belongs to; a backup only ever holds one user. */
export function ledgerUserId(tables: ImportTables): string {
  for (const table of ['accounts', 'transactions', 'bills', 'goals', 'categories'] as const) {
    for (const row of tables[table]) {
      const userId = row.user_id
      if (typeof userId === 'string' && userId) return userId
    }
  }
  throw new RepositoryError('STATE', 'This phone has no ledger to write to')
}

/**
 * A phone edit must always look newer than the copy it replaces, even when two
 * devices stamp the same instant or this clock runs behind: the merge breaks a
 * full tie by revision, so the stamp never goes backwards and the counter always
 * moves up.
 */
export function stampAfter(row: Row | undefined, now: string): { updated_at: string; revision: number } {
  const previous = row && typeof row.updated_at === 'string' ? Date.parse(row.updated_at) : Number.NaN
  const timestamp = Date.parse(now)
  const updated_at =
    Number.isFinite(previous) && previous >= timestamp ? new Date(previous + 1).toISOString() : now
  const revision = typeof row?.revision === 'number' && Number.isFinite(row.revision) ? row.revision : 0
  return { updated_at, revision: revision + 1 }
}

export function requireLiveRow(tables: ImportTables, table: WritableTable, id: string): Row {
  const row = tables[table].find((candidate) => isLive(candidate) && text(candidate, 'id') === id)
  if (!row) throw new RepositoryError('NOT_FOUND', 'That record no longer exists')
  return row
}

function patchRow(tables: ImportTables, table: WritableTable, id: string, fields: Columns): ImportTables {
  const rows = tables[table]
  const index = rows.findIndex((row) => isLive(row) && text(row, 'id') === id)
  if (index === -1) throw new RepositoryError('NOT_FOUND', 'That record no longer exists')
  // `undefined` means the column is not in this patch, exactly as the desktop's
  // UPDATE leaves it out of its SET list; only `null` clears.
  const changes = Object.entries(fields).filter(
    (entry): entry is [string, string | number | null] => entry[1] !== undefined
  )
  if (changes.length === 0) return tables
  const current = rows[index]
  const next = [...rows]
  next[index] = { ...current, ...Object.fromEntries(changes), ...stampAfter(current, rules.nowISO()) }
  return withRows(tables, table, next)
}

/** Retire rows by id. Unknown ids are ignored, so a cascade can name twins freely. */
function tombstoneRows(tables: ImportTables, table: WritableTable, ids: Iterable<string>): ImportTables {
  const wanted = new Set(ids)
  if (wanted.size === 0) return tables
  const now = rules.nowISO()
  const next = tables[table].map((row) => {
    if (!isLive(row) || !wanted.has(text(row, 'id'))) return row
    const stamp = stampAfter(row, now)
    return { ...row, deleted_at: stamp.updated_at, ...stamp }
  })
  return withRows(tables, table, next)
}

function insertRow(tables: ImportTables, table: WritableTable, columns: Columns): Written {
  const id = crypto.randomUUID()
  const now = rules.nowISO()
  const row: Row = {
    id,
    user_id: ledgerUserId(tables),
    ...columns,
    created_at: now,
    updated_at: now,
    deleted_at: null,
    revision: 1
  }
  return { tables: withRows(tables, table, [...tables[table], row]), id }
}

// --------------------------------------------------------------- references

/** The desktop's `requireAccount`, read from the copy on this phone. */
export function requireAccountRow(
  tables: ImportTables,
  accountId: string,
  options: { allowArchived?: boolean } = {}
): Row {
  const row = tables.accounts.find((candidate) => isLive(candidate) && text(candidate, 'id') === accountId)
  if (!row) throw new RepositoryError('NOT_FOUND', 'Account not found')
  if (flag(row, 'is_archived') && options.allowArchived !== true) {
    throw new RepositoryError('STATE', 'That account is archived — restore it before using it here')
  }
  return row
}

function requireGoalRow(tables: ImportTables, goalId: string): Row {
  const row = tables.goals.find((candidate) => isLive(candidate) && text(candidate, 'id') === goalId)
  if (!row) throw new RepositoryError('NOT_FOUND', 'Goal not found')
  return row
}

function requireBillRow(tables: ImportTables, billId: string): Row {
  const row = tables.bills.find((candidate) => isLive(candidate) && text(candidate, 'id') === billId)
  if (!row) throw new RepositoryError('VALIDATION', 'That bill no longer exists')
  return row
}

function requirePaycheckRow(tables: ImportTables, paycheckId: string): void {
  if (!tables.paychecks.some((row) => isLive(row) && text(row, 'id') === paycheckId)) {
    throw new RepositoryError('VALIDATION', 'That paycheck no longer exists')
  }
}

// ------------------------------------------------------------------- bills

export function createBill(tables: ImportTables, input: BillInput): Written {
  const accountId = input.accountId ? rules.optionalText(input.accountId, 'Account') : null
  if (accountId) requireAccountRow(tables, accountId)
  return insertRow(tables, 'bills', {
    name: rules.assertText(input.name, 'Bill name'),
    amount_cents: rules.assertCents(input.amountCents, 'Bill amount'),
    frequency: rules.assertOneOf(input.frequency, rules.FREQUENCIES, 'frequency'),
    due_day: rules.assertDueDay(input.dueDay),
    category: input.category ? rules.assertText(input.category, 'Category', 60) : 'Bills',
    account_id: accountId,
    autopay: input.autopay ? 1 : 0,
    is_active: input.isActive === false ? 0 : 1,
    next_due_on: input.nextDueOn ? rules.assertDate(input.nextDueOn, 'Next due date') : null,
    funding_strategy: input.fundingStrategy
      ? rules.assertOneOf(input.fundingStrategy, rules.BILL_FUNDING_STRATEGIES, 'funding strategy')
      : 'all_checks',
    funding_paycheck_index: rules.assertPaycheckIndex(input.fundingPaycheckIndex)
  })
}

export function patchBill(tables: ImportTables, id: string, patch: Partial<BillInput>): ImportTables {
  if (patch.accountId) {
    // A bill that still points at an account the user archived would otherwise be
    // uneditable: the picker sends that same id back, so only a new destination is
    // checked — the desktop refuses it for exactly this reason.
    const current = requireLiveRow(tables, 'bills', id)
    if (nullableText(current, 'account_id') !== patch.accountId) requireAccountRow(tables, patch.accountId)
  }
  return patchRow(tables, 'bills', id, {
    name: patch.name === undefined ? undefined : rules.assertText(patch.name, 'Bill name'),
    amount_cents:
      patch.amountCents === undefined ? undefined : rules.assertCents(patch.amountCents, 'Bill amount'),
    frequency:
      patch.frequency === undefined
        ? undefined
        : rules.assertOneOf(patch.frequency, rules.FREQUENCIES, 'frequency'),
    due_day: patch.dueDay === undefined ? undefined : rules.assertDueDay(patch.dueDay),
    category:
      patch.category === undefined ? undefined : rules.assertText(patch.category, 'Category', 60),
    account_id: patch.accountId === undefined ? undefined : patch.accountId || null,
    autopay: patch.autopay === undefined ? undefined : patch.autopay ? 1 : 0,
    is_active: patch.isActive === undefined ? undefined : patch.isActive ? 1 : 0,
    next_due_on:
      patch.nextDueOn === undefined
        ? undefined
        : patch.nextDueOn
          ? rules.assertDate(patch.nextDueOn, 'Next due date')
          : null,
    funding_strategy:
      patch.fundingStrategy === undefined
        ? undefined
        : rules.assertOneOf(patch.fundingStrategy, rules.BILL_FUNDING_STRATEGIES, 'funding strategy'),
    funding_paycheck_index:
      patch.fundingPaycheckIndex === undefined
        ? undefined
        : rules.assertPaycheckIndex(patch.fundingPaycheckIndex)
  })
}

export function deleteBill(tables: ImportTables, id: string): ImportTables {
  requireLiveRow(tables, 'bills', id)
  const now = rules.nowISO()
  // The bill is gone, so a live payment must not keep pointing at its tombstone:
  // the entry stays as an ordinary expense, with its own memo.
  const transactions = tables.transactions.map((row) => {
    if (!isLive(row) || nullableText(row, 'bill_id') !== id) return row
    const kind = text(row, 'kind')
    return {
      ...row,
      bill_id: null,
      kind: kind === 'bill_payment' ? 'expense' : kind,
      ...stampAfter(row, now)
    }
  })
  const reserves = tables.bill_reserves.map((row) => {
    if (!isLive(row) || nullableText(row, 'bill_id') !== id) return row
    const stamp = stampAfter(row, now)
    return { ...row, deleted_at: stamp.updated_at, ...stamp }
  })
  const merged = withRows(withRows(tables, 'transactions', transactions), 'bill_reserves', reserves)
  return tombstoneRows(merged, 'bills', [id])
}

/** What this month's payments already cover, by the rule the phone displays. */
export function billPaidThisMonthCents(tables: ImportTables, billId: string, today: string): number {
  const month = today.slice(0, 7)
  let paid = 0
  for (const entry of tables.transactions) {
    if (!isLive(entry) || nullableText(entry, 'bill_id') !== billId) continue
    const kind = text(entry, 'kind')
    if (kind !== 'bill_payment' && kind !== 'expense') continue
    const occurredOn = text(entry, 'occurred_on')
    if (occurredOn.slice(0, 7) !== month || occurredOn > today) continue
    paid += Math.max(0, -cents(entry, 'amount_cents'))
  }
  return paid
}

/**
 * The desktop's own "did this clear?" answer: one bill payment for whatever the
 * month still owes, from the bill's account, dated no later than today.
 */
export function payBill(
  tables: ImportTables,
  billId: string,
  options: { occurredOn?: string; accountId?: string } = {}
): Written {
  const bill = requireBillRow(tables, billId)
  const today = todayISO()
  const occurredOn = rules.assertDate(options.occurredOn ?? today, 'Date')
  if (occurredOn > today) throw new RepositoryError('VALIDATION', 'That date is in the future')

  const openAccounts = tables.accounts.filter((row) => isLive(row) && !flag(row, 'is_archived'))
  const liveIds = new Set(openAccounts.map((row) => text(row, 'id')))
  const billAccountId = nullableText(bill, 'account_id')
  const fallback = openAccounts.find((row) => text(row, 'kind') === 'checking') ?? openAccounts[0] ?? null
  // A bill can outlive the account it pays from. Posting into an archived account
  // would move money out of a balance no total counts, so fall back to the
  // checking account the desktop would have used instead.
  const accountId =
    options.accountId ??
    (billAccountId && liveIds.has(billAccountId) ? billAccountId : null) ??
    (billAccountId ? null : fallback ? text(fallback, 'id') : null)
  if (!accountId) throw new RepositoryError('STATE', 'No active account can pay this bill')

  const remaining = cents(bill, 'amount_cents') - billPaidThisMonthCents(tables, billId, occurredOn)
  if (remaining <= 0) throw new RepositoryError('STATE', 'This bill is already paid for the month')

  return createEntry(tables, {
    accountId,
    kind: 'bill_payment',
    amountCents: -remaining,
    occurredOn,
    memo: text(bill, 'name'),
    category: text(bill, 'category') || 'Bills',
    billId
  })
}

// -------------------------------------------------------------- categories

function nextCategorySort(tables: ImportTables): number {
  return tables.categories.filter(isLive).reduce((max, row) => Math.max(max, integer(row, 'sort_order')), -1) + 1
}

function categoryByKey(tables: ImportTables, name: string): Row | undefined {
  const key = categoryKey(name)
  return tables.categories.find((row) => isLive(row) && categoryKey(text(row, 'name')) === key)
}

export function createCategory(tables: ImportTables, input: CategoryInput): Written {
  const name = normalizeCategoryName(rules.assertText(input.name, 'Category name', CATEGORY_NAME_MAX))
  const existing = categoryByKey(tables, name)
  if (existing) return { tables, id: text(existing, 'id') }
  return insertRow(tables, 'categories', {
    name,
    kind: rules.assertOneOf(input.kind, rules.CATEGORY_KINDS, 'category kind'),
    color: rules.optionalText(input.color, 'Color', 30),
    sort_order: nextCategorySort(tables)
  })
}

export function patchCategory(tables: ImportTables, id: string, patch: Partial<CategoryInput>): ImportTables {
  const current = requireLiveRow(tables, 'categories', id)
  let nextName: string | undefined
  if (patch.name !== undefined) {
    nextName = normalizeCategoryName(rules.assertText(patch.name, 'Category name', CATEGORY_NAME_MAX))
    const clash = categoryByKey(tables, nextName)
    if (clash && text(clash, 'id') !== id) {
      throw new RepositoryError('CONFLICT', 'A category with that name already exists')
    }
  }
  const patched = patchRow(tables, 'categories', id, {
    name: nextName,
    kind:
      patch.kind === undefined ? undefined : rules.assertOneOf(patch.kind, rules.CATEGORY_KINDS, 'category kind'),
    color:
      patch.color === undefined
        ? undefined
        : patch.color
          ? rules.assertText(patch.color, 'Color', 30)
          : null
  })
  if (nextName === undefined || nextName === text(current, 'name')) return patched

  // The text column is what search, CSV export and a bill's own label read, so a
  // rename has to reach the rows that still carry the old spelling — otherwise the
  // next autopay mints the old category again.
  const now = rules.nowISO()
  const oldKey = categoryKey(text(current, 'name'))
  const transactions = patched.transactions.map((row) =>
    isLive(row) && nullableText(row, 'category_id') === id
      ? { ...row, category: nextName, ...stampAfter(row, now) }
      : row
  )
  const bills = patched.bills.map((row) =>
    isLive(row) && categoryKey(text(row, 'category')) === oldKey
      ? { ...row, category: nextName, ...stampAfter(row, now) }
      : row
  )
  return withRows(withRows(patched, 'transactions', transactions), 'bills', bills)
}

/**
 * Removing a category keeps the ledger: rows lose the pointer and keep their
 * last text, so no entry disappears from a report because its label did.
 */
export function deleteCategory(tables: ImportTables, id: string): ImportTables {
  requireLiveRow(tables, 'categories', id)
  const now = rules.nowISO()
  const transactions = tables.transactions.map((row) =>
    isLive(row) && nullableText(row, 'category_id') === id
      ? { ...row, category_id: null, ...stampAfter(row, now) }
      : row
  )
  return tombstoneRows(withRows(tables, 'transactions', transactions), 'categories', [id])
}

/** Resolves a written name to a live row, creating it the first time. */
function ensureCategoryRow(
  tables: ImportTables,
  name: string,
  kind: TransactionKind
): { tables: ImportTables; id: string | null; name: string } {
  const cleaned = normalizeCategoryName(name).slice(0, CATEGORY_NAME_MAX)
  if (!cleaned) return { tables, id: null, name: '' }
  const existing = categoryByKey(tables, cleaned)
  if (existing) return { tables, id: text(existing, 'id'), name: text(existing, 'name') }
  const created = insertRow(tables, 'categories', {
    name: cleaned,
    kind: defaultCategoryKind(kind),
    color: null,
    sort_order: nextCategorySort(tables)
  })
  return { tables: created.tables, id: created.id, name: cleaned }
}

// ------------------------------------------------------------------ goals

export function createGoal(tables: ImportTables, input: GoalInput): Written {
  const accountId = input.accountId ? rules.optionalText(input.accountId, 'Account') : null
  if (accountId) requireAccountRow(tables, accountId)
  const inserted = insertRow(tables, 'goals', {
    name: rules.assertText(input.name, 'Goal name'),
    target_cents: rules.assertCents(input.targetCents, 'Goal target'),
    target_date: input.targetDate ? rules.assertDate(input.targetDate, 'Target date') : null,
    priority: rules.assertPriority(input.priority),
    color: input.color ? rules.assertText(input.color, 'Color', 20) : '#34D399',
    account_id: accountId,
    is_emergency: input.isEmergency ? 1 : 0,
    is_archived: 0,
    funding_pace: rules.assertPace(input.fundingPace)
  })
  return input.fundingAccountIds
    ? { tables: applyFundingAccounts(inserted.tables, inserted.id, input.fundingAccountIds), id: inserted.id }
    : inserted
}

export function patchGoal(tables: ImportTables, id: string, patch: Partial<GoalInput>): ImportTables {
  if (patch.accountId) requireAccountRow(tables, patch.accountId)
  requireGoalRow(tables, id)
  const patched = patchRow(tables, 'goals', id, {
    name: patch.name === undefined ? undefined : rules.assertText(patch.name, 'Goal name'),
    target_cents:
      patch.targetCents === undefined ? undefined : rules.assertCents(patch.targetCents, 'Goal target'),
    target_date:
      patch.targetDate === undefined
        ? undefined
        : patch.targetDate
          ? rules.assertDate(patch.targetDate, 'Target date')
          : null,
    priority: patch.priority === undefined ? undefined : rules.assertPriority(patch.priority),
    color: patch.color === undefined ? undefined : rules.assertText(patch.color, 'Color', 20),
    account_id: patch.accountId === undefined ? undefined : patch.accountId || null,
    is_emergency: patch.isEmergency === undefined ? undefined : patch.isEmergency ? 1 : 0,
    funding_pace: patch.fundingPace === undefined ? undefined : rules.assertPace(patch.fundingPace)
  })
  return patch.fundingAccountIds ? applyFundingAccounts(patched, id, patch.fundingAccountIds) : patched
}

/** Points exactly this set of accounts at the goal; an archived one is refused. */
function applyFundingAccounts(
  tables: ImportTables,
  goalId: string,
  accountIds: readonly string[]
): ImportTables {
  const now = rules.nowISO()
  const keep = new Set(accountIds)
  let accounts = tables.accounts.map((row) =>
    isLive(row) && nullableText(row, 'dedicated_goal_id') === goalId && !keep.has(text(row, 'id'))
      ? { ...row, dedicated_goal_id: null, ...stampAfter(row, now) }
      : row
  )
  for (const accountId of keep) {
    requireAccountRow(tables, accountId, { allowArchived: true })
    const index = accounts.findIndex((row) => isLive(row) && text(row, 'id') === accountId)
    if (index === -1 || flag(accounts[index], 'is_archived')) {
      throw new RepositoryError('STATE', 'Archived accounts cannot fund a goal')
    }
    accounts = [...accounts]
    accounts[index] = {
      ...accounts[index],
      dedicated_goal_id: goalId,
      ...stampAfter(accounts[index], now)
    }
  }
  return withRows(tables, 'accounts', accounts)
}

export function setGoalArchived(tables: ImportTables, id: string, archived: boolean): ImportTables {
  return patchRow(tables, 'goals', id, { is_archived: archived ? 1 : 0 })
}

export function deleteGoal(tables: ImportTables, id: string): ImportTables {
  requireGoalRow(tables, id)
  const now = rules.nowISO()
  const accounts = tables.accounts.map((row) =>
    isLive(row) && nullableText(row, 'dedicated_goal_id') === id
      ? { ...row, dedicated_goal_id: null, ...stampAfter(row, now) }
      : row
  )
  return tombstoneRows(withRows(tables, 'accounts', accounts), 'goals', [id])
}

// ---------------------------------------------------------------- accounts

export function createAccount(tables: ImportTables, input: AccountInput): Written {
  const dedicatedGoalId = rules.optionalText(input.dedicatedGoalId, 'Dedicated goal')
  if (dedicatedGoalId) requireGoalRow(tables, dedicatedGoalId)
  return insertRow(tables, 'accounts', {
    name: rules.assertText(input.name, 'Account name'),
    kind: rules.assertOneOf(input.kind, rules.ACCOUNT_KINDS, 'account kind'),
    institution: rules.optionalText(input.institution, 'Institution'),
    starting_balance_cents: rules.assertCents(input.startingBalanceCents, 'Starting balance', {
      allowNegative: true,
      allowZero: true
    }),
    credit_limit_cents:
      input.creditLimitCents === undefined || input.creditLimitCents === null
        ? null
        : rules.assertCents(input.creditLimitCents, 'Credit limit', { allowZero: true }),
    color: rules.optionalText(input.color, 'Color', 30),
    dedicated_goal_id: dedicatedGoalId,
    in_safe_to_spend: rules.flagColumn(input.inSafeToSpend),
    apr_bps: rules.optionalAprBps(input.aprBps) ?? null,
    minimum_payment_cents:
      rules.optionalCents(input.minimumPaymentCents, 'Minimum payment', { allowZero: true }) ?? null,
    statement_day: rules.optionalDay(input.statementDay, 'Statement day') ?? null,
    payment_due_day: rules.optionalDay(input.paymentDueDay, 'Payment due day') ?? null,
    last_statement_balance_cents:
      rules.optionalCents(input.lastStatementBalanceCents, 'Statement balance', { allowZero: true }) ?? null,
    is_archived: 0,
    sort_order: rules.assertSortOrder(input.sortOrder)
  })
}

export function patchAccount(
  tables: ImportTables,
  id: string,
  patch: Partial<AccountInput>
): ImportTables {
  return patchRow(tables, 'accounts', id, {
    name: patch.name === undefined ? undefined : rules.assertText(patch.name, 'Account name'),
    kind:
      patch.kind === undefined
        ? undefined
        : rules.assertOneOf(patch.kind, rules.ACCOUNT_KINDS, 'account kind'),
    institution:
      patch.institution === undefined ? undefined : rules.optionalText(patch.institution, 'Institution'),
    starting_balance_cents:
      patch.startingBalanceCents === undefined
        ? undefined
        : rules.assertCents(patch.startingBalanceCents, 'Starting balance', {
            allowNegative: true,
            allowZero: true
          }),
    credit_limit_cents: rules.optionalCents(patch.creditLimitCents, 'Credit limit', { allowZero: true }),
    color:
      patch.color === undefined
        ? undefined
        : patch.color
          ? rules.assertText(patch.color, 'Color', 30)
          : null,
    dedicated_goal_id:
      patch.dedicatedGoalId === undefined
        ? undefined
        : patch.dedicatedGoalId
          ? text(requireGoalRow(tables, patch.dedicatedGoalId), 'id')
          : null,
    in_safe_to_spend:
      patch.inSafeToSpend === undefined ? undefined : rules.flagColumn(patch.inSafeToSpend),
    apr_bps: rules.optionalAprBps(patch.aprBps),
    minimum_payment_cents: rules.optionalCents(patch.minimumPaymentCents, 'Minimum payment', {
      allowZero: true
    }),
    statement_day: rules.optionalDay(patch.statementDay, 'Statement day'),
    payment_due_day: rules.optionalDay(patch.paymentDueDay, 'Payment due day'),
    last_statement_balance_cents: rules.optionalCents(patch.lastStatementBalanceCents, 'Statement balance', {
      allowZero: true
    }),
    sort_order: patch.sortOrder === undefined ? undefined : rules.assertSortOrder(patch.sortOrder)
  })
}

export function setAccountArchived(tables: ImportTables, id: string, archived: boolean): ImportTables {
  const patched = patchRow(tables, 'accounts', id, { is_archived: archived ? 1 : 0 })
  return archived ? disableRoundUpAt(patched, id) : patched
}

/** A sweep can only land in a live account, so archiving its destination stops it. */
function disableRoundUpAt(tables: ImportTables, accountId: string): ImportTables {
  const settings = parseSettings(settingRecord(tables.settings))
  if (settings.roundUpAccountId !== accountId) return tables
  if (!settings.roundUpEnabled) return tables
  return writeSetting(tables, 'roundUpEnabled', 'false')
}

function writeSetting(tables: ImportTables, key: string, value: string): ImportTables {
  const now = rules.nowISO()
  const index = tables.settings.findIndex((row) => isLive(row) && text(row, 'key') === key)
  if (index === -1) {
    return withRows(tables, 'settings', [
      ...tables.settings,
      {
        id: key,
        user_id: ledgerUserId(tables),
        key,
        value,
        created_at: now,
        updated_at: now,
        deleted_at: null,
        revision: 1
      }
    ])
  }
  const rows = [...tables.settings]
  rows[index] = { ...rows[index], value, ...stampAfter(rows[index], now) }
  return withRows(tables, 'settings', rows)
}

export interface DeleteAccountOptions {
  /** Also remove every entry in the account, as the desktop's dialog offers. */
  withEntries?: boolean
}

export function accountEntryCount(tables: ImportTables, accountId: string): number {
  return tables.transactions.filter(
    (row) => isLive(row) && nullableText(row, 'account_id') === accountId
  ).length
}

export function deleteAccount(tables: ImportTables, id: string, options: DeleteAccountOptions = {}): ImportTables {
  if (!tables.accounts.some((row) => isLive(row) && text(row, 'id') === id)) {
    throw new RepositoryError('NOT_FOUND', 'Account not found')
  }
  const entries = accountEntryCount(tables, id)
  if (entries > 0 && options.withEntries !== true) {
    throw new RepositoryError(
      'CONFLICT',
      'That account still has entries — archive it to keep them, or delete it with its entries'
    )
  }

  let next = tables
  if (entries > 0) {
    // The same cascade an entry delete uses: a leg takes its twin, a purchase
    // takes its sweep.
    const own = next.transactions
      .filter((row) => isLive(row) && nullableText(row, 'account_id') === id)
      .map((row) => text(row, 'id'))
    next = tombstoneRows(next, 'transactions', expandDeletion(next, own))
  }

  const now = rules.nowISO()
  const nullReference = (rows: Row[], column: string): Row[] =>
    rows.map((row) =>
      isLive(row) && nullableText(row, column) === id
        ? { ...row, [column]: null, ...stampAfter(row, now) }
        : row
    )
  next = withRows(next, 'bills', nullReference(next.bills, 'account_id'))
  next = withRows(next, 'goals', nullReference(next.goals, 'account_id'))
  next = withRows(next, 'paychecks', nullReference(next.paychecks, 'deposit_account_id'))
  next = disableRoundUpAt(next, id)
  return tombstoneRows(next, 'accounts', [id])
}

// ------------------------------------------------------------ transactions

/** Labels the app writes itself belong to a seeded category. */
const INTERNAL_CATEGORY_ALIASES: Record<string, string> = {
  'round-up': 'Transfer',
  'credit payment': 'Debt',
  paycheck: 'Income'
}

interface EntryFields extends Columns {
  account_id: string
  kind: TransactionKind
  amount_cents: number
  occurred_on: string
  memo: string
  category: string
  category_id: string | null
  bill_id?: string | null
  goal_id?: string | null
  paycheck_id?: string | null
  counter_account_id?: string | null
  transfer_group_id?: string | null
  round_up_source_id?: string | null
}

function findTransaction(tables: ImportTables, id: string): Row | undefined {
  return tables.transactions.find((row) => text(row, 'id') === id)
}

function checkEntryLinks(
  tables: ImportTables,
  kind: TransactionKind,
  billId: string | null,
  goalId: string | null
): void {
  if (billId && goalId) {
    throw new RepositoryError('VALIDATION', 'An entry can name a bill or a goal, not both')
  }
  if (billId) {
    // An adjustment can name a bill as a note, but the link still has to point at
    // one of the bills this ledger still holds.
    if (kind !== 'bill_payment' && kind !== 'expense' && kind !== 'adjustment') {
      throw new RepositoryError('VALIDATION', 'This entry kind cannot name a bill')
    }
    requireBillRow(tables, billId)
  }
  if (goalId) {
    if (kind !== 'goal_funding') {
      throw new RepositoryError('VALIDATION', 'Only a goal funding can name a goal')
    }
    // The desktop's ledger has its own words for a link that no longer points at
    // a goal, so a re-typed entry refuses with the sentence the computer gives.
    if (!tables.goals.some((row) => isLive(row) && text(row, 'id') === goalId)) {
      throw new RepositoryError('VALIDATION', 'That goal no longer exists')
    }
  }
}

function resolveEntryCategory(
  tables: ImportTables,
  kind: TransactionKind,
  input: { category: string; categoryId?: string | null }
): { tables: ImportTables; id: string | null; name: string } {
  if (input.categoryId) {
    const row = tables.categories.find(
      (candidate) => isLive(candidate) && text(candidate, 'id') === input.categoryId
    )
    if (!row) throw new RepositoryError('NOT_FOUND', 'Category not found')
    return { tables, id: text(row, 'id'), name: text(row, 'name') }
  }
  const raw = rules.optionalText(input.category, 'Category', 60) ?? 'Uncategorized'
  const name = INTERNAL_CATEGORY_ALIASES[raw.toLocaleLowerCase()] ?? raw
  const ensured = ensureCategoryRow(tables, name, kind)
  return { tables: ensured.tables, id: ensured.id, name: ensured.name }
}

function insertEntryRow(tables: ImportTables, fields: EntryFields): Written {
  return insertRow(tables, 'transactions', {
    account_id: fields.account_id,
    kind: fields.kind,
    amount_cents: fields.amount_cents,
    occurred_on: fields.occurred_on,
    memo: fields.memo,
    category: fields.category,
    category_id: fields.category_id,
    external_id: null,
    bill_id: fields.bill_id ?? null,
    goal_id: fields.goal_id ?? null,
    paycheck_id: fields.paycheck_id ?? null,
    counter_account_id: fields.counter_account_id ?? null,
    transfer_group_id: fields.transfer_group_id ?? null,
    round_up_source_id: fields.round_up_source_id ?? null
  })
}

/**
 * Round-up is a real sweep, not a note: a paired transfer that moves the
 * remainder from the spending account to the destination, with both legs
 * carrying the id of the purchase that caused them.
 */
function applyRoundUp(
  tables: ImportTables,
  input: {
    sourceId: string
    accountId: string
    accountKind: AccountKind
    amountCents: number
    occurredOn: string
    memo: string
  }
): ImportTables {
  const settings = parseSettings(settingRecord(tables.settings))
  if (!settings.roundUpEnabled || !settings.roundUpAccountId) return tables
  if (settings.roundUpAccountId === input.accountId) return tables
  // Tangerine-style rounding applies to debit spending, never to a credit card.
  if (input.accountKind !== 'checking' && input.accountKind !== 'cash') return tables

  const destination = tables.accounts.find(
    (row) => isLive(row) && !flag(row, 'is_archived') && text(row, 'id') === settings.roundUpAccountId
  )
  if (!destination) return tables
  const destinationKind = text(destination, 'kind') as AccountKind
  if (destinationKind === 'credit' || destinationKind === 'investment') return tables

  const sweepCents = roundUpRemainderCents(input.amountCents, settings.roundUpToCents)
  if (sweepCents <= 0) return tables

  const groupId = crypto.randomUUID()
  const composed = input.memo ? `Round-up · ${input.memo}` : 'Round-up sweep'
  const memo = composed.length > 240 ? `${composed.slice(0, 239)}…` : composed
  let next = insertEntryRow(tables, {
    account_id: input.accountId,
    kind: 'transfer',
    amount_cents: -sweepCents,
    occurred_on: input.occurredOn,
    memo,
    category: 'Round-up',
    category_id: null,
    counter_account_id: settings.roundUpAccountId,
    transfer_group_id: groupId,
    round_up_source_id: input.sourceId
  }).tables
  next = insertEntryRow(next, {
    account_id: settings.roundUpAccountId,
    kind: 'transfer',
    amount_cents: sweepCents,
    occurred_on: input.occurredOn,
    memo,
    category: 'Round-up',
    category_id: null,
    counter_account_id: input.accountId,
    transfer_group_id: groupId,
    round_up_source_id: input.sourceId
  }).tables
  return next
}

export function createEntry(tables: ImportTables, input: TransactionInput): Written {
  const kind = rules.assertOneOf(input.kind, rules.TRANSACTION_KINDS, 'transaction kind')
  // The kind decides the sign: income can never post negative and an expense can
  // never post positive, whatever the caller typed.
  const amountCents = normalizeSignedCents(
    kind,
    rules.assertCents(input.amountCents, 'Amount', { allowNegative: true, allowZero: false })
  )
  const occurredOn = rules.assertDate(input.occurredOn, 'Date')
  const memo = rules.optionalText(input.memo, 'Memo', 240) ?? ''
  const account = requireAccountRow(tables, input.accountId)
  const billId = input.billId ?? null
  const goalId = input.goalId ?? null
  checkEntryLinks(tables, kind, billId, goalId)
  if (input.paycheckId) requirePaycheckRow(tables, input.paycheckId)

  const resolved = resolveEntryCategory(tables, kind, {
    category: input.category,
    categoryId: input.categoryId ?? null
  })

  if (kind === 'transfer') {
    if (!input.counterAccountId) {
      throw new RepositoryError('VALIDATION', 'Transfers need a destination account')
    }
    if (input.counterAccountId === input.accountId) {
      throw new RepositoryError('VALIDATION', 'Choose two different accounts')
    }
    requireAccountRow(resolved.tables, input.counterAccountId)
    const groupId = crypto.randomUUID()
    const legs = transferLegs(amountCents)
    const out = insertEntryRow(resolved.tables, {
      account_id: input.accountId,
      kind,
      amount_cents: legs.outCents,
      occurred_on: occurredOn,
      memo,
      category: resolved.name,
      category_id: resolved.id,
      counter_account_id: input.counterAccountId,
      transfer_group_id: groupId,
      paycheck_id: input.paycheckId ?? null
    })
    // The receiving leg carries the text but no pointer, exactly as the desktop
    // posts it: the two copies have to be the same rows.
    const back = insertEntryRow(out.tables, {
      account_id: input.counterAccountId,
      kind,
      amount_cents: legs.inCents,
      occurred_on: occurredOn,
      memo,
      category: resolved.name,
      category_id: null,
      counter_account_id: input.accountId,
      transfer_group_id: groupId,
      paycheck_id: input.paycheckId ?? null
    })
    return { tables: back.tables, id: out.id }
  }

  if (input.counterAccountId) {
    throw new RepositoryError('VALIDATION', 'Only a transfer has a destination account')
  }
  const inserted = insertEntryRow(resolved.tables, {
    account_id: input.accountId,
    kind,
    amount_cents: amountCents,
    occurred_on: occurredOn,
    memo,
    category: resolved.name,
    category_id: resolved.id,
    bill_id: billId,
    goal_id: goalId,
    paycheck_id: input.paycheckId ?? null
  })
  if (kind === 'expense' && amountCents < 0) {
    return {
      tables: applyRoundUp(inserted.tables, {
        sourceId: inserted.id,
        accountId: input.accountId,
        accountKind: text(account, 'kind') as AccountKind,
        amountCents,
        occurredOn,
        memo
      }),
      id: inserted.id
    }
  }
  return inserted
}

export interface EntryPatch {
  accountId?: string
  kind?: TransactionKind
  amountCents?: number
  occurredOn?: string
  memo?: string
  category?: string
  categoryId?: string | null
}

function groupRows(tables: ImportTables, groupId: string): Row[] {
  return tables.transactions.filter(
    (row) => isLive(row) && nullableText(row, 'transfer_group_id') === groupId
  )
}

function sweepIdsFor(tables: ImportTables, sourceId: string): string[] {
  return tables.transactions
    .filter((row) => isLive(row) && nullableText(row, 'round_up_source_id') === sourceId)
    .map((row) => text(row, 'id'))
}

/**
 * Edit one entry — or a whole transfer pair — with the desktop's refusals. A
 * sweep is derived from its purchase and a transfer leg from its twin, so both
 * are re-made from the row the user actually meant rather than patched loose.
 */
export function patchEntry(tables: ImportTables, id: string, patch: EntryPatch): ImportTables {
  if (patch.accountId) requireAccountRow(tables, patch.accountId)
  const existing = requireLiveRow(tables, 'transactions', id)
  const existingGroupId = nullableText(existing, 'transfer_group_id')
  const existingKind = text(existing, 'kind') as TransactionKind
  const billId = nullableText(existing, 'bill_id')
  const goalId = nullableText(existing, 'goal_id')

  if (
    nullableText(existing, 'round_up_source_id') !== null &&
    (patch.amountCents !== undefined ||
      patch.occurredOn !== undefined ||
      patch.accountId !== undefined ||
      patch.kind !== undefined)
  ) {
    throw new RepositoryError(
      'CONFLICT',
      'This is a round-up sweep — edit the purchase it came from instead'
    )
  }

  const wantsCategory = patch.category !== undefined || patch.categoryId !== undefined

  if (existingGroupId) {
    if (patch.accountId || patch.kind) {
      throw new RepositoryError(
        'CONFLICT',
        'Paired transfers keep their accounts — delete and re-enter to change them'
      )
    }
    const magnitude =
      patch.amountCents === undefined
        ? null
        : Math.abs(rules.assertCents(patch.amountCents, 'Amount', { allowNegative: true }))
    const occurredOn =
      patch.occurredOn === undefined ? undefined : rules.assertDate(patch.occurredOn, 'Date')
    const memo =
      patch.memo === undefined ? undefined : rules.optionalText(patch.memo, 'Memo', 240) ?? ''
    const resolved = wantsCategory
      ? resolveEntryCategory(tables, existingKind, {
          category: patch.category ?? text(existing, 'category'),
          categoryId: patch.categoryId
        })
      : null
    const base = resolved ? resolved.tables : tables
    const targets = new Set(groupRows(base, existingGroupId).map((row) => text(row, 'id')))
    const now = rules.nowISO()
    const transactions = base.transactions.map((row) => {
      if (!isLive(row) || !targets.has(text(row, 'id'))) return row
      const sign = cents(row, 'amount_cents') < 0 ? -1 : 1
      return {
        ...row,
        amount_cents: magnitude === null ? cents(row, 'amount_cents') : sign * magnitude,
        occurred_on: occurredOn ?? text(row, 'occurred_on'),
        memo: memo ?? text(row, 'memo'),
        category: resolved ? resolved.name : text(row, 'category'),
        category_id: resolved ? resolved.id : nullableText(row, 'category_id'),
        ...stampAfter(row, now)
      }
    })
    return withRows(base, 'transactions', transactions)
  }

  const nextKind =
    patch.kind === undefined
      ? existingKind
      : rules.assertOneOf(patch.kind, rules.TRANSACTION_KINDS, 'transaction kind')
  // A transfer only exists as a pair. Turning a single row into one, or one leg
  // into something else, would strand the other side of the ledger.
  if (nextKind === 'transfer' && existingKind !== 'transfer') {
    throw new RepositoryError(
      'CONFLICT',
      'Transfers need two accounts — delete this entry and record a transfer instead'
    )
  }
  if (existingKind === 'transfer' && nextKind !== 'transfer') {
    throw new RepositoryError('CONFLICT', 'Paired transfers keep their kind — delete and re-enter to change it')
  }

  // A link only means something for the kinds that can carry it, so a retype
  // drops the one the new kind could never have been created with.
  const carriesBill = nextKind === 'bill_payment' || nextKind === 'expense' || nextKind === 'adjustment'
  const dropBill = billId !== null && !carriesBill
  const dropGoal = goalId !== null && nextKind !== 'goal_funding'

  const touchesAmount = patch.amountCents !== undefined || patch.kind !== undefined
  let nextAmount = cents(existing, 'amount_cents')
  if (patch.amountCents !== undefined) {
    nextAmount = rules.assertCents(patch.amountCents, 'Amount', { allowNegative: true })
    const signProblem = signedAmountError(nextKind, nextAmount)
    if (signProblem) throw new RepositoryError('VALIDATION', signProblem)
  } else if (patch.kind !== undefined) {
    // Changing only the kind flips the stored sign to match it.
    nextAmount = normalizeSignedCents(nextKind, nextAmount)
  }
  const nextOccurredOn =
    patch.occurredOn === undefined ? text(existing, 'occurred_on') : rules.assertDate(patch.occurredOn, 'Date')
  const nextMemo =
    patch.memo === undefined ? text(existing, 'memo') : rules.optionalText(patch.memo, 'Memo', 240) ?? ''
  const nextAccountId = patch.accountId ?? text(existing, 'account_id')
  const resolved = wantsCategory
    ? resolveEntryCategory(tables, nextKind, {
        category: patch.category ?? text(existing, 'category'),
        categoryId: patch.categoryId
      })
    : null

  let patched = patchRow(tables, 'transactions', id, {
    account_id: patch.accountId,
    kind: patch.kind === undefined ? undefined : nextKind,
    amount_cents: touchesAmount ? nextAmount : undefined,
    occurred_on: patch.occurredOn === undefined ? undefined : nextOccurredOn,
    memo: patch.memo === undefined ? undefined : nextMemo,
    category: resolved?.name,
    category_id: resolved ? resolved.id : undefined,
    bill_id: dropBill ? null : undefined,
    goal_id: dropGoal ? null : undefined
  })
  if (resolved) patched = resolved.tables

  // A purchase's sweep is derived from it: remove the old pair, then let the same
  // rule that created it decide whether a new one is still owed.
  if (touchesAmount || patch.occurredOn !== undefined || patch.accountId !== undefined) {
    patched = tombstoneRows(patched, 'transactions', sweepIdsFor(patched, id))
    if (nextKind === 'expense' && nextAmount < 0) {
      const account = requireAccountRow(patched, nextAccountId)
      patched = applyRoundUp(patched, {
        sourceId: id,
        accountId: nextAccountId,
        accountKind: text(account, 'kind') as AccountKind,
        amountCents: nextAmount,
        occurredOn: nextOccurredOn,
        memo: nextMemo
      })
    }
  }
  return patched
}

/**
 * The rows a removal takes with it: a transfer's twin leg and a purchase's
 * sweep, so no half-pair is left behind reading as money that moved on its own.
 */
export function expandDeletion(tables: ImportTables, ids: Iterable<string>): Set<string> {
  const doomed = new Set<string>()
  for (const id of ids) {
    const row = findTransaction(tables, id)
    if (!row || !isLive(row)) continue
    doomed.add(id)
    const group = nullableText(row, 'transfer_group_id')
    if (group) {
      for (const leg of groupRows(tables, group)) doomed.add(text(leg, 'id'))
    }
    for (const sweepId of sweepIdsFor(tables, id)) doomed.add(sweepId)
  }
  return doomed
}

export function deleteEntries(
  tables: ImportTables,
  ids: Iterable<string>
): { tables: ImportTables; removed: string[] } {
  const doomed = expandDeletion(tables, ids)
  return { tables: tombstoneRows(tables, 'transactions', doomed), removed: [...doomed] }
}

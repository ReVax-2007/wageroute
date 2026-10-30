import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { buildAllocationPlan } from '@shared/allocator'
import type { CommittedPaycheck } from '@shared/api'
import { isISODate } from '@shared/dates'
import { RepositoryError } from '@shared/errors'
import type { ImportChoice, ImportChoiceTable } from '@shared/importRepair'
import { normalizeSignedCents, signedAmountError } from '@shared/kinds'
import { parseSettings, isCurrencyCode } from '@shared/settings'
import { roundUpRemainderCents, transferLegs } from '@shared/transfers'
import { compact } from './maintenance'
import type {
  AccountInput,
  AccountKind,
  AccountWithBalance,
  Allocation,
  Bill,
  BillFundingStrategy,
  BillInput,
  BillReserve,
  Frequency,
  Goal,
  GoalFundingSource,
  GoalInput,
  GoalWithProgress,
  PayCadence,
  Paycheck,
  PaycheckDraftInput,
  PaycheckWithAllocations,
  PlanHealth,
  Snapshot,
  Transaction,
  TransactionInput,
  TransactionKind,
  TransactionPatch,
  TransactionRow,
  User
} from '@shared/types'

type Db = Database.Database

const ACCOUNT_KINDS: readonly AccountKind[] = ['checking', 'savings', 'cash', 'investment', 'credit']
const BILL_FUNDING_STRATEGIES: readonly BillFundingStrategy[] = [
  'all_checks',
  'closest_due_date',
  'specific_check',
  'first_check',
  'last_check'
]
const FREQUENCIES: readonly Frequency[] = [
  'weekly',
  'biweekly',
  'semimonthly',
  'monthly',
  'quarterly',
  'annual'
]
const TRANSACTION_KINDS: readonly TransactionKind[] = [
  'income',
  'expense',
  'bill_payment',
  'transfer',
  'goal_funding',
  'investment',
  'adjustment'
]
const PAY_CADENCES: readonly PayCadence[] = ['weekly', 'biweekly', 'semimonthly', 'monthly']

function nowISO(): string {
  return new Date().toISOString()
}

function assertText(value: unknown, label: string, max = 160): string {
  if (typeof value !== 'string') throw new RepositoryError('VALIDATION', `${label} must be text`)
  const trimmed = value.trim()
  if (!trimmed) throw new RepositoryError('VALIDATION', `${label} is required`)
  if (trimmed.length > max) throw new RepositoryError('VALIDATION', `${label} is too long`)
  return trimmed
}

function optionalText(value: unknown, label: string, max = 160): string | null {
  if (value === null || value === undefined || value === '') return null
  return assertText(value, label, max)
}

interface CentsOptions {
  allowNegative?: boolean
  allowZero?: boolean
}

function assertCents(value: unknown, label: string, options: CentsOptions = {}): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new RepositoryError('VALIDATION', `${label} must be a number`)
  }
  const cents = Math.round(value)
  if (!Number.isSafeInteger(cents)) throw new RepositoryError('VALIDATION', `${label} is out of range`)
  if (!options.allowNegative && cents < 0) throw new RepositoryError('VALIDATION', `${label} cannot be negative`)
  if (!options.allowZero && cents === 0) throw new RepositoryError('VALIDATION', `${label} cannot be zero`)
  return cents
}

function assertOneOf<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new RepositoryError('VALIDATION', `Invalid ${label}`)
  }
  return value as T
}

function assertDate(value: unknown, label: string): string {
  if (!isISODate(value)) throw new RepositoryError('VALIDATION', `${label} must be a date in YYYY-MM-DD form`)
  return value
}

function assertPriority(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 100
  return Math.round(value)
}

type Table = 'accounts' | 'bills' | 'goals' | 'transactions'

function updateRow(
  db: Db,
  table: Table,
  id: string,
  userId: string,
  fields: Record<string, string | number | null | undefined>
): void {
  const entries = Object.entries(fields).filter(
    (entry): entry is [string, string | number | null] => entry[1] !== undefined
  )
  if (entries.length === 0) return

  const assignments = entries.map(([column]) => `${column} = ?`).join(', ')
  db.prepare(
    `UPDATE ${table}
     SET ${assignments}, updated_at = ?, revision = revision + 1
     WHERE id = ? AND user_id = ? AND deleted_at IS NULL`
  ).run(...entries.map(([, value]) => value), nowISO(), id, userId)
}

function softDelete(db: Db, table: Table, id: string, userId: string): void {
  const ts = nowISO()
  db.prepare(
    `UPDATE ${table}
     SET deleted_at = ?, updated_at = ?, revision = revision + 1
     WHERE id = ? AND user_id = ? AND deleted_at IS NULL`
  ).run(ts, ts, id, userId)
}

function requireAccount(
  db: Db,
  userId: string,
  accountId: string,
  options: { allowArchived?: boolean } = {}
): { id: string; kind: AccountKind } {
  const row = db
    .prepare(
      `SELECT id, kind, is_archived AS isArchived FROM accounts
       WHERE id = ? AND user_id = ? AND deleted_at IS NULL`
    )
    .get(accountId, userId) as { id: string; kind: AccountKind; isArchived: number } | undefined
  if (!row) throw new RepositoryError('NOT_FOUND', 'Account not found')
  // An archived account is out of every total and every picker on purpose.
  // Posting new money to it would change a balance nobody is looking at.
  if (row.isArchived === 1 && options.allowArchived !== true) {
    throw new RepositoryError('STATE', 'That account is archived — restore it before using it here')
  }
  return { id: row.id, kind: row.kind }
}

/**
 * dedicated_goal_id has no database foreign key (see the v4 migration note), so
 * every write path has to check the target exists.
 */
function requireGoal(db: Db, userId: string, goalId: string): { id: string; name: string } {
  const row = db
    .prepare('SELECT id, name FROM goals WHERE id = ? AND user_id = ? AND deleted_at IS NULL')
    .get(goalId, userId) as { id: string; name: string } | undefined
  if (!row) throw new RepositoryError('NOT_FOUND', 'Goal not found')
  return row
}

function flagColumn(value: unknown): 0 | 1 | null {
  if (value === null || value === undefined) return null
  return value ? 1 : 0
}

// ---------------------------------------------------------------- users

export function getUser(db: Db, userId: string): User {
  const row = db
    .prepare(
      `SELECT id, email, display_name AS displayName, currency,
              created_at AS createdAt, updated_at AS updatedAt,
              deleted_at AS deletedAt, revision
       FROM users WHERE id = ? AND deleted_at IS NULL`
    )
    .get(userId) as User | undefined
  if (!row) throw new RepositoryError('NOT_FOUND', 'Local user is missing')
  return row
}

export function getLocalUserId(db: Db): string {
  const row = db
    .prepare('SELECT id FROM users WHERE deleted_at IS NULL ORDER BY created_at LIMIT 1')
    .get() as { id: string } | undefined
  if (!row) throw new RepositoryError('NOT_FOUND', 'No local user has been seeded')
  return row.id
}

/**
 * Rows an import can point at when a reference is missing or dangling.
 * Capped so a huge ledger cannot bloat the wizard.
 */
export function listImportChoices(
  db: Db,
  userId: string
): Record<ImportChoiceTable, ImportChoice[]> {
  const limit = 200
  const rows = (sql: string): ImportChoice[] =>
    db.prepare(sql).all(userId, limit) as ImportChoice[]

  return {
    accounts: rows(
      `SELECT id, name AS label FROM accounts
       WHERE user_id = ? AND deleted_at IS NULL
       ORDER BY sort_order, name LIMIT ?`
    ),
    bills: rows(
      `SELECT id, name AS label FROM bills
       WHERE user_id = ? AND deleted_at IS NULL
       ORDER BY name LIMIT ?`
    ),
    goals: rows(
      `SELECT id, name AS label FROM goals
       WHERE user_id = ? AND deleted_at IS NULL
       ORDER BY priority, name LIMIT ?`
    ),
    paychecks: rows(
      `SELECT id, received_on || ' · ' || source AS label FROM paychecks
       WHERE user_id = ? AND deleted_at IS NULL
       ORDER BY received_on DESC LIMIT ?`
    )
  }
}

// Every tenant table, children before parents. Literal names only; the reset
// path must never interpolate user input here.
const WIPE_TABLES = [
  'allocations',
  'bill_reserves',
  'transactions',
  'paychecks',
  'goals',
  'bills',
  'accounts',
  'settings',
  'users'
] as const

export function wipeAllData(db: Db): void {
  db.pragma('foreign_keys = OFF')
  try {
    db.transaction(() => {
      for (const table of WIPE_TABLES) {
        db.prepare(`DELETE FROM ${table}`).run()
      }
    })()
  } finally {
    db.pragma('foreign_keys = ON')
  }
  // DELETE only marks pages free. Rebuild the file and truncate the WAL so the
  // erased ledger cannot be read back out of free space.
  compact(db)
}

// ---------------------------------------------------------------- settings

export function readSettings(db: Db, userId: string): Record<string, string> {
  const rows = db
    .prepare('SELECT key, value FROM settings WHERE user_id = ?')
    .all(userId) as { key: string; value: string }[]
  return Object.fromEntries(rows.map((row) => [row.key, row.value]))
}

export function writeSettings(
  db: Db,
  userId: string,
  values: Record<string, string>
): void {
  if (values.currency !== undefined && !isCurrencyCode(values.currency)) {
    throw new RepositoryError('VALIDATION', 'That currency code is not one this build supports', 'currency')
  }
  const statement = db.prepare(
    `INSERT INTO settings (user_id, key, value, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  )
  const ts = nowISO()
  db.transaction(() => {
    for (const [key, value] of Object.entries(values)) {
      statement.run(userId, key, value, ts)
    }
  })()
}

// ---------------------------------------------------------------- accounts

type AccountRow = Omit<AccountWithBalance, 'isArchived' | 'inSafeToSpend'> & {
  isArchived: number
  inSafeToSpend: number | null
}

function mapAccount(row: AccountRow): AccountWithBalance {
  const { isArchived, inSafeToSpend, ...rest } = row
  return {
    ...rest,
    isArchived: isArchived === 1,
    inSafeToSpend: inSafeToSpend === null ? null : inSafeToSpend === 1
  }
}

export function listAccounts(db: Db, userId: string): AccountWithBalance[] {
  const rows = db
    .prepare(
      `SELECT a.id, a.user_id AS userId, a.name, a.kind, a.institution,
              a.starting_balance_cents AS startingBalanceCents,
              a.credit_limit_cents AS creditLimitCents,
              a.color,
              a.dedicated_goal_id AS dedicatedGoalId,
              a.in_safe_to_spend AS inSafeToSpend,
              a.is_archived AS isArchived, a.sort_order AS sortOrder,
              a.created_at AS createdAt, a.updated_at AS updatedAt,
              a.deleted_at AS deletedAt, a.revision,
              a.starting_balance_cents + COALESCE((
                SELECT SUM(t.amount_cents) FROM transactions t
                WHERE t.account_id = a.id AND t.deleted_at IS NULL
              ), 0) AS balanceCents
       FROM accounts a
       WHERE a.user_id = ? AND a.deleted_at IS NULL
       ORDER BY a.is_archived, a.sort_order, a.name`
    )
    .all(userId) as AccountRow[]

  return rows.map(mapAccount)
}

export function createAccount(db: Db, userId: string, input: AccountInput): string {
  const id = randomUUID()
  const ts = nowISO()
  const dedicatedGoalId = optionalText(input.dedicatedGoalId, 'Dedicated goal')
  if (dedicatedGoalId) requireGoal(db, userId, dedicatedGoalId)
  db.prepare(
    `INSERT INTO accounts
       (id, user_id, name, kind, institution, starting_balance_cents, credit_limit_cents,
        color, dedicated_goal_id, in_safe_to_spend,
        is_archived, sort_order, created_at, updated_at, deleted_at, revision)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, NULL, 1)`
  ).run(
    id,
    userId,
    assertText(input.name, 'Account name'),
    assertOneOf(input.kind, ACCOUNT_KINDS, 'account kind'),
    optionalText(input.institution, 'Institution'),
    assertCents(input.startingBalanceCents, 'Starting balance', {
      allowNegative: true,
      allowZero: true
    }),
    input.creditLimitCents === undefined || input.creditLimitCents === null
      ? null
      : assertCents(input.creditLimitCents, 'Credit limit', { allowZero: true }),
    optionalText(input.color, 'Color', 30),
    dedicatedGoalId,
    flagColumn(input.inSafeToSpend),
    input.sortOrder ?? 0,
    ts,
    ts
  )
  return id
}

export function updateAccount(
  db: Db,
  userId: string,
  id: string,
  patch: Partial<AccountInput>
): void {
  updateRow(db, 'accounts', id, userId, {
    name: patch.name === undefined ? undefined : assertText(patch.name, 'Account name'),
    kind:
      patch.kind === undefined ? undefined : assertOneOf(patch.kind, ACCOUNT_KINDS, 'account kind'),
    institution:
      patch.institution === undefined
        ? undefined
        : optionalText(patch.institution, 'Institution'),
    starting_balance_cents:
      patch.startingBalanceCents === undefined
        ? undefined
        : assertCents(patch.startingBalanceCents, 'Starting balance', {
            allowNegative: true,
            allowZero: true
          }),
    credit_limit_cents:
      patch.creditLimitCents === undefined
        ? undefined
        : patch.creditLimitCents === null
          ? null
          : assertCents(patch.creditLimitCents, 'Credit limit', { allowZero: true }),
    color:
      patch.color === undefined
        ? undefined
        : patch.color
          ? assertText(patch.color, 'Color', 30)
          : null,
    dedicated_goal_id:
      patch.dedicatedGoalId === undefined
        ? undefined
        : patch.dedicatedGoalId
          ? requireGoal(db, userId, patch.dedicatedGoalId).id
          : null,
    in_safe_to_spend:
      patch.inSafeToSpend === undefined ? undefined : flagColumn(patch.inSafeToSpend),
    sort_order: patch.sortOrder
  })
}

export interface DeleteAccountOptions {
  /**
   * Also remove every entry in the account (and both legs of any transfer that
   * touches it). Without this a delete is refused, because leaving the entries
   * behind makes them vanish from every total while still sitting in the grid.
   */
  withEntries?: boolean
}

export function accountEntryCount(db: Db, userId: string, id: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS total FROM transactions
       WHERE account_id = ? AND user_id = ? AND deleted_at IS NULL`
    )
    .get(id, userId) as { total: number }
  return row.total
}

export function deleteAccount(
  db: Db,
  userId: string,
  id: string,
  options: DeleteAccountOptions = {}
): void {
  const ts = nowISO()
  const entries = accountEntryCount(db, userId, id)
  if (entries > 0 && !options.withEntries) {
    throw new RepositoryError(
      'CONFLICT',
      'That account still has entries — archive it to keep them, or delete it with its entries'
    )
  }

  db.transaction(() => {
    if (entries > 0) {
      // A transfer leg is meaningless without its twin, so every group that
      // touches this account goes as a pair.
      const groups = db
        .prepare(
          `SELECT DISTINCT transfer_group_id AS groupId FROM transactions
           WHERE account_id = ? AND user_id = ? AND deleted_at IS NULL
             AND transfer_group_id IS NOT NULL`
        )
        .all(id, userId) as { groupId: string }[]
      for (const group of groups) {
        db.prepare(
          `UPDATE transactions
           SET deleted_at = ?, updated_at = ?, revision = revision + 1
           WHERE transfer_group_id = ? AND user_id = ? AND deleted_at IS NULL`
        ).run(ts, ts, group.groupId, userId)
      }
      db.prepare(
        `UPDATE transactions
         SET deleted_at = ?, updated_at = ?, revision = revision + 1
         WHERE account_id = ? AND user_id = ? AND deleted_at IS NULL`
      ).run(ts, ts, id, userId)
    }

    db.prepare(
      'UPDATE bills SET account_id = NULL, updated_at = ?, revision = revision + 1 WHERE account_id = ? AND user_id = ?'
    ).run(ts, id, userId)
    db.prepare(
      'UPDATE goals SET account_id = NULL, updated_at = ?, revision = revision + 1 WHERE account_id = ? AND user_id = ?'
    ).run(ts, id, userId)
    db.prepare(
      'UPDATE paychecks SET deposit_account_id = NULL, updated_at = ?, revision = revision + 1 WHERE deposit_account_id = ? AND user_id = ?'
    ).run(ts, id, userId)
    softDelete(db, 'accounts', id, userId)
  })()
}

export function setAccountArchived(
  db: Db,
  userId: string,
  id: string,
  archived: boolean
): void {
  updateRow(db, 'accounts', id, userId, { is_archived: archived ? 1 : 0 })
}

// ---------------------------------------------------------------- bills

type BillRow = Omit<Bill, 'autopay' | 'isActive'> & { autopay: number; isActive: number }

function mapBill(row: BillRow): Bill {
  return { ...row, autopay: row.autopay === 1, isActive: row.isActive === 1 }
}

const BILL_SELECT = `
  SELECT id, user_id AS userId, name, amount_cents AS amountCents, frequency,
         due_day AS dueDay, category, account_id AS accountId, autopay,
         is_active AS isActive, next_due_on AS nextDueOn,
         funding_strategy AS fundingStrategy,
         funding_paycheck_index AS fundingPaycheckIndex,
         created_at AS createdAt, updated_at AS updatedAt,
         deleted_at AS deletedAt, revision
  FROM bills`

export function listBills(db: Db, userId: string): Bill[] {
  const rows = db
    .prepare(
      `${BILL_SELECT}
       WHERE user_id = ? AND deleted_at IS NULL
       ORDER BY is_active DESC, due_day, name`
    )
    .all(userId) as BillRow[]
  return rows.map(mapBill)
}

export function createBill(db: Db, userId: string, input: BillInput): string {
  const id = randomUUID()
  const ts = nowISO()
  const accountId = input.accountId ? optionalText(input.accountId, 'Account') : null
  if (accountId) requireAccount(db, userId, accountId)

  const fundingStrategy = input.fundingStrategy
    ? assertOneOf(input.fundingStrategy, BILL_FUNDING_STRATEGIES, 'funding strategy')
    : 'all_checks'

  db.prepare(
    `INSERT INTO bills
       (id, user_id, name, amount_cents, frequency, due_day, category, account_id,
        autopay, is_active, next_due_on, funding_strategy, funding_paycheck_index,
        created_at, updated_at, deleted_at, revision)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1)`
  ).run(
    id,
    userId,
    assertText(input.name, 'Bill name'),
    assertCents(input.amountCents, 'Bill amount'),
    assertOneOf(input.frequency, FREQUENCIES, 'frequency'),
    Math.min(31, Math.max(1, Math.round(input.dueDay))),
    input.category ? assertText(input.category, 'Category', 60) : 'Bills',
    accountId,
    input.autopay ? 1 : 0,
    input.isActive === false ? 0 : 1,
    input.nextDueOn ? assertDate(input.nextDueOn, 'Next due date') : null,
    fundingStrategy,
    input.fundingPaycheckIndex ?? null,
    ts,
    ts
  )
  return id
}

export function updateBill(
  db: Db,
  userId: string,
  id: string,
  patch: Partial<BillInput>
): void {
  if (patch.accountId) requireAccount(db, userId, patch.accountId)

  updateRow(db, 'bills', id, userId, {
    name: patch.name === undefined ? undefined : assertText(patch.name, 'Bill name'),
    amount_cents:
      patch.amountCents === undefined ? undefined : assertCents(patch.amountCents, 'Bill amount'),
    frequency:
      patch.frequency === undefined
        ? undefined
        : assertOneOf(patch.frequency, FREQUENCIES, 'frequency'),
    due_day:
      patch.dueDay === undefined ? undefined : Math.min(31, Math.max(1, Math.round(patch.dueDay))),
    category:
      patch.category === undefined ? undefined : assertText(patch.category, 'Category', 60),
    account_id: patch.accountId === undefined ? undefined : patch.accountId || null,
    autopay: patch.autopay === undefined ? undefined : patch.autopay ? 1 : 0,
    is_active: patch.isActive === undefined ? undefined : patch.isActive ? 1 : 0,
    next_due_on:
      patch.nextDueOn === undefined
        ? undefined
        : patch.nextDueOn
          ? assertDate(patch.nextDueOn, 'Next due date')
          : null,
    funding_strategy:
      patch.fundingStrategy === undefined
        ? undefined
        : assertOneOf(patch.fundingStrategy, BILL_FUNDING_STRATEGIES, 'funding strategy'),
    funding_paycheck_index:
      patch.fundingPaycheckIndex === undefined ? undefined : patch.fundingPaycheckIndex
  })
}

export function deleteBill(db: Db, userId: string, id: string): void {
  db.transaction(() => {
    softDeleteBillReserves(db, userId, { billId: id })
    softDelete(db, 'bills', id, userId)
  })()
}

// ------------------------------------------------------------ bill reserves

function softDeleteBillReserves(
  db: Db,
  userId: string,
  filter: { billId?: string; paycheckId?: string }
): void {
  const ts = nowISO()
  const column = filter.billId ? 'bill_id' : 'paycheck_id'
  const value = filter.billId ?? filter.paycheckId
  db.prepare(
    `UPDATE bill_reserves
     SET deleted_at = ?, updated_at = ?, revision = revision + 1
     WHERE ${column} = ? AND user_id = ? AND deleted_at IS NULL`
  ).run(ts, ts, value, userId)
}

export function listBillReserves(db: Db, userId: string): BillReserve[] {
  return db
    .prepare(
      `SELECT id, user_id AS userId, bill_id AS billId, paycheck_id AS paycheckId,
              cycle, amount_cents AS amountCents, state,
              created_at AS createdAt, updated_at AS updatedAt,
              deleted_at AS deletedAt, revision
       FROM bill_reserves
       WHERE user_id = ? AND deleted_at IS NULL
       ORDER BY cycle DESC, created_at DESC`
    )
    .all(userId) as BillReserve[]
}

/**
 * Single-check bills an earlier cheque in this cycle already carried. A second
 * cheque in the same month must route its surplus, not reserve the same bills
 * again. `all_checks` bills are spread deliberately and are not deduplicated.
 */
export function reservedBillIdsFor(db: Db, userId: string, cycle: string): string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT r.bill_id AS id
       FROM bill_reserves r
       JOIN bills b ON b.id = r.bill_id
       WHERE r.user_id = ? AND r.cycle = ? AND r.deleted_at IS NULL
         AND b.funding_strategy <> 'all_checks'`
    )
    .all(userId, cycle) as { id: string }[]
  return rows.map((row) => row.id)
}

function recordBillReserves(
  db: Db,
  userId: string,
  paycheckId: string,
  cycle: string,
  reserves: readonly { billId: string; reserveCents: number }[]
): void {
  const ts = nowISO()
  const insert = db.prepare(
    `INSERT INTO bill_reserves
       (id, user_id, bill_id, paycheck_id, cycle, amount_cents, state,
        created_at, updated_at, deleted_at, revision)
     VALUES (?, ?, ?, ?, ?, ?, 'reserved', ?, ?, NULL, 1)`
  )
  for (const reserve of reserves) {
    if (reserve.reserveCents <= 0) continue
    insert.run(
      randomUUID(),
      userId,
      reserve.billId,
      paycheckId,
      cycle,
      reserve.reserveCents,
      ts,
      ts
    )
  }
}

function setBillReserveState(
  db: Db,
  userId: string,
  billId: string,
  occurredOn: string,
  state: BillReserve['state']
): void {
  const ts = nowISO()
  db.prepare(
    `UPDATE bill_reserves
     SET state = ?, updated_at = ?, revision = revision + 1
     WHERE user_id = ? AND bill_id = ? AND cycle = ? AND deleted_at IS NULL AND state <> ?`
  ).run(state, ts, userId, billId, occurredOn.slice(0, 7), state)
}

// ---------------------------------------------------------------- goals

type GoalRow = Omit<
  GoalWithProgress,
  'isArchived' | 'isEmergency' | 'fundedCents' | 'fundedFrom' | 'dedicatedAccounts'
> & {
  isArchived: number
  isEmergency: number
  allocationCents: number
}

interface DedicatedAccountRow {
  dedicatedGoalId: string
  id: string
  name: string
  balanceCents: number
}

export function listGoals(db: Db, userId: string): GoalWithProgress[] {
  const rows = db
    .prepare(
      `SELECT g.id, g.user_id AS userId, g.name, g.target_cents AS targetCents,
              g.target_date AS targetDate, g.priority, g.color, g.account_id AS accountId,
              g.is_emergency AS isEmergency, g.is_archived AS isArchived, g.created_at AS createdAt,
              g.updated_at AS updatedAt, g.deleted_at AS deletedAt, g.revision,
              COALESCE((
                SELECT SUM(a.amount_cents) FROM allocations a
                WHERE a.goal_id = g.id AND a.user_id = g.user_id
                  AND a.deleted_at IS NULL AND a.bucket = 'goal'
              ), 0) AS allocationCents
       FROM goals g
       WHERE g.user_id = ? AND g.deleted_at IS NULL
       ORDER BY g.is_archived, g.priority, g.name`
    )
    .all(userId) as GoalRow[]

  // A dedicated account's live balance *is* the progress, so it replaces the
  // allocation total rather than adding to it. Grouped in JS instead of
  // GROUP_CONCAT so account names containing commas survive.
  const dedicated = db
    .prepare(
      `SELECT dedicated_goal_id AS dedicatedGoalId, id, name,
              starting_balance_cents + COALESCE((
                SELECT SUM(t.amount_cents) FROM transactions t
                WHERE t.account_id = accounts.id AND t.deleted_at IS NULL
              ), 0) AS balanceCents
       FROM accounts
       WHERE user_id = ? AND deleted_at IS NULL AND is_archived = 0
         AND dedicated_goal_id IS NOT NULL
       ORDER BY sort_order, name`
    )
    .all(userId) as DedicatedAccountRow[]

  const byGoal = new Map<string, DedicatedAccountRow[]>()
  for (const row of dedicated) {
    const existing = byGoal.get(row.dedicatedGoalId)
    if (existing) existing.push(row)
    else byGoal.set(row.dedicatedGoalId, [row])
  }

  return rows.map((row) => {
    const sources = byGoal.get(row.id) ?? []
    const fundedFrom: GoalFundingSource = sources.length > 0 ? 'account' : 'allocations'
    const fundedCents =
      fundedFrom === 'account'
        ? Math.max(
            0,
            sources.reduce((total, source) => total + source.balanceCents, 0)
          )
        : row.allocationCents

    return {
      ...row,
      isArchived: row.isArchived === 1,
      isEmergency: row.isEmergency === 1,
      fundedFrom,
      dedicatedAccounts: sources.map((source) => ({
        id: source.id,
        name: source.name,
        balanceCents: source.balanceCents
      })),
      fundedCents,
      remainingCents: Math.max(0, row.targetCents - fundedCents)
    }
  })
}

/**
 * Points exactly this set of accounts at the goal. An account funds one goal
 * only, so a tick that already belonged to another goal moves here — the dialog
 * names that goal before the change is saved. Callers run this inside the same
 * transaction as the goal write, so a save is all-or-nothing.
 */
function applyFundingAccounts(
  db: Db,
  userId: string,
  goalId: string,
  accountIds: readonly string[]
): void {
  const ts = nowISO()
  const keep = new Set(accountIds)
  db.prepare(
    `UPDATE accounts SET dedicated_goal_id = NULL, updated_at = ?, revision = revision + 1
     WHERE dedicated_goal_id = ? AND user_id = ? AND deleted_at IS NULL`
  ).run(ts, goalId, userId)
  if (keep.size === 0) return

  const link = db.prepare(
    `UPDATE accounts SET dedicated_goal_id = ?, updated_at = ?, revision = revision + 1
     WHERE id = ? AND user_id = ? AND deleted_at IS NULL AND is_archived = 0`
  )
  for (const accountId of keep) {
    // The UPDATE below already filters archived rows, and its own message says
    // why; this call only proves the account exists in this ledger.
    requireAccount(db, userId, accountId, { allowArchived: true })
    if (link.run(goalId, ts, accountId, userId).changes === 0) {
      throw new RepositoryError('STATE', 'Archived accounts cannot fund a goal')
    }
  }
}

export function createGoal(db: Db, userId: string, input: GoalInput): string {
  const id = randomUUID()
  const ts = nowISO()
  const accountId = input.accountId ? optionalText(input.accountId, 'Account') : null
  if (accountId) requireAccount(db, userId, accountId)

  db.transaction(() => {
    db.prepare(
      `INSERT INTO goals
         (id, user_id, name, target_cents, target_date, priority, color, account_id,
          is_emergency, is_archived, created_at, updated_at, deleted_at, revision)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, NULL, 1)`
    ).run(
      id,
      userId,
      assertText(input.name, 'Goal name'),
      assertCents(input.targetCents, 'Goal target'),
      input.targetDate ? assertDate(input.targetDate, 'Target date') : null,
      assertPriority(input.priority),
      input.color ? assertText(input.color, 'Color', 20) : '#34D399',
      accountId,
      input.isEmergency ? 1 : 0,
      ts,
      ts
    )
    if (input.fundingAccountIds) applyFundingAccounts(db, userId, id, input.fundingAccountIds)
  })()
  return id
}

export function updateGoal(
  db: Db,
  userId: string,
  id: string,
  patch: Partial<GoalInput>
): void {
  if (patch.accountId) requireAccount(db, userId, patch.accountId)
  // updateRow no-ops on a missing row, so without this a dangling
  // dedicated_goal_id could be written for a goal that does not exist.
  requireGoal(db, userId, id)

  db.transaction(() => {
    updateRow(db, 'goals', id, userId, {
      name: patch.name === undefined ? undefined : assertText(patch.name, 'Goal name'),
      target_cents:
        patch.targetCents === undefined ? undefined : assertCents(patch.targetCents, 'Goal target'),
      target_date:
        patch.targetDate === undefined
          ? undefined
          : patch.targetDate
            ? assertDate(patch.targetDate, 'Target date')
            : null,
      priority: patch.priority === undefined ? undefined : assertPriority(patch.priority),
      color: patch.color === undefined ? undefined : assertText(patch.color, 'Color', 20),
      account_id: patch.accountId === undefined ? undefined : patch.accountId || null,
      is_emergency: patch.isEmergency === undefined ? undefined : patch.isEmergency ? 1 : 0
    })
    if (patch.fundingAccountIds) {
      applyFundingAccounts(db, userId, id, patch.fundingAccountIds)
    }
  })()
}

export function deleteGoal(db: Db, userId: string, id: string): void {
  const ts = nowISO()
  db.transaction(() => {
    db.prepare(
      'UPDATE accounts SET dedicated_goal_id = NULL, updated_at = ?, revision = revision + 1 WHERE dedicated_goal_id = ? AND user_id = ? AND deleted_at IS NULL'
    ).run(ts, id, userId)
    softDelete(db, 'goals', id, userId)
  })()
}

/**
 * Archive keeps the goal, its allocations and its history, and stops the
 * allocator from funding it. Unlike a delete it can be undone.
 */
export function setGoalArchived(
  db: Db,
  userId: string,
  id: string,
  archived: boolean
): void {
  updateRow(db, 'goals', id, userId, { is_archived: archived ? 1 : 0 })
}

// ---------------------------------------------------------------- transactions

const TRANSACTION_SELECT = `
  SELECT t.id, t.user_id AS userId, t.account_id AS accountId, t.kind,
         t.amount_cents AS amountCents, t.occurred_on AS occurredOn, t.memo, t.category,
         t.bill_id AS billId, t.goal_id AS goalId, t.paycheck_id AS paycheckId,
         t.counter_account_id AS counterAccountId, t.transfer_group_id AS transferGroupId,
         t.created_at AS createdAt,
         t.updated_at AS updatedAt, t.deleted_at AS deletedAt, t.revision,
         a.name AS accountName
  FROM transactions t
  JOIN accounts a ON a.id = t.account_id
  WHERE t.user_id = ? AND t.deleted_at IS NULL
  ORDER BY t.occurred_on DESC, t.created_at DESC`

export function listTransactions(db: Db, userId: string, limit = 500): TransactionRow[] {
  return db
    .prepare(`${TRANSACTION_SELECT} LIMIT ?`)
    .all(userId, limit) as TransactionRow[]
}

/** Every live entry, for exports. The grid keeps its own capped query. */
export function listAllTransactions(db: Db, userId: string): TransactionRow[] {
  return db.prepare(TRANSACTION_SELECT).all(userId) as TransactionRow[]
}

export interface NewTransactionInput {
  accountId: string
  kind: TransactionKind
  amountCents: number
  occurredOn: string
  memo: string
  category: string
  billId?: string | null
  goalId?: string | null
  paycheckId?: string | null
  counterAccountId?: string | null
  transferGroupId?: string | null
  roundUpSourceId?: string | null
}

export function insertTransactionRow(db: Db, userId: string, input: NewTransactionInput): string {
  const id = randomUUID()
  const ts = nowISO()
  db.prepare(
    `INSERT INTO transactions
       (id, user_id, account_id, kind, amount_cents, occurred_on, memo, category,
        bill_id, goal_id, paycheck_id, counter_account_id, transfer_group_id,
        round_up_source_id, created_at, updated_at, deleted_at, revision)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1)`
  ).run(
    id,
    userId,
    input.accountId,
    input.kind,
    input.amountCents,
    input.occurredOn,
    input.memo,
    input.category,
    input.billId ?? null,
    input.goalId ?? null,
    input.paycheckId ?? null,
    input.counterAccountId ?? null,
    input.transferGroupId ?? null,
    input.roundUpSourceId ?? null,
    ts,
    ts
  )
  return id
}

/**
 * Round-up is a real sweep, not a note: it posts a paired transfer so the
 * spending account and the destination both move by the rounded cents.
 *
 * Both legs carry the id of the expense that caused them, so a later edit or
 * delete of that expense can find the sweep instead of leaving it behind.
 */
function applyRoundUp(
  db: Db,
  userId: string,
  input: {
    sourceId: string
    accountId: string
    accountKind: AccountKind
    amountCents: number
    occurredOn: string
    memo: string
  }
): void {
  const settings = parseSettings(readSettings(db, userId))
  if (!settings.roundUpEnabled || !settings.roundUpAccountId) return
  if (settings.roundUpAccountId === input.accountId) return
  // Tangerine-style rounding applies to debit spending, never to a credit card.
  if (input.accountKind !== 'checking' && input.accountKind !== 'cash') return

  const destination = db
    .prepare(
      `SELECT kind FROM accounts
       WHERE id = ? AND user_id = ? AND deleted_at IS NULL AND is_archived = 0`
    )
    .get(settings.roundUpAccountId, userId) as { kind: AccountKind } | undefined
  if (!destination || destination.kind === 'credit' || destination.kind === 'investment') return

  const sweepCents = roundUpRemainderCents(input.amountCents, settings.roundUpToCents)
  if (sweepCents <= 0) return

  const groupId = randomUUID()
  // The composed memo has to fit the same 240-character column as any other.
  const composed = input.memo ? `Round-up · ${input.memo}` : 'Round-up sweep'
  const memo = composed.length > 240 ? `${composed.slice(0, 239)}…` : composed
  insertTransactionRow(db, userId, {
    accountId: input.accountId,
    kind: 'transfer',
    amountCents: -sweepCents,
    occurredOn: input.occurredOn,
    memo,
    category: 'Round-up',
    counterAccountId: settings.roundUpAccountId,
    transferGroupId: groupId,
    roundUpSourceId: input.sourceId
  })
  insertTransactionRow(db, userId, {
    accountId: settings.roundUpAccountId,
    kind: 'transfer',
    amountCents: sweepCents,
    occurredOn: input.occurredOn,
    memo,
    category: 'Round-up',
    counterAccountId: input.accountId,
    transferGroupId: groupId,
    roundUpSourceId: input.sourceId
  })
}

export function createTransaction(db: Db, userId: string, input: TransactionInput): string {
  const kind = assertOneOf(input.kind, TRANSACTION_KINDS, 'transaction kind')
  // The kind decides the sign: income can never post negative and an expense
  // can never post positive, whatever the caller typed.
  const amountCents = normalizeSignedCents(
    kind,
    assertCents(input.amountCents, 'Amount', { allowNegative: true, allowZero: false })
  )
  const occurredOn = assertDate(input.occurredOn, 'Date')
  const memo = optionalText(input.memo, 'Memo', 240) ?? ''
  const category = optionalText(input.category, 'Category', 60) ?? 'Uncategorized'
  const account = requireAccount(db, userId, input.accountId)

  if (kind === 'transfer') {
    if (!input.counterAccountId) throw new RepositoryError('VALIDATION', 'Transfers need a destination account')
    if (input.counterAccountId === input.accountId) {
      throw new RepositoryError('VALIDATION', 'Choose two different accounts')
    }
    requireAccount(db, userId, input.counterAccountId)
    const counterAccountId = input.counterAccountId

    return db.transaction(() => {
      const legs = transferLegs(amountCents)
      const groupId = randomUUID()
      const outId = insertTransactionRow(db, userId, {
        accountId: input.accountId,
        kind,
        amountCents: legs.outCents,
        occurredOn,
        memo,
        category,
        counterAccountId,
        transferGroupId: groupId
      })
      insertTransactionRow(db, userId, {
        accountId: counterAccountId,
        kind,
        amountCents: legs.inCents,
        occurredOn,
        memo,
        category,
        counterAccountId: input.accountId,
        transferGroupId: groupId
      })
      return outId
    })()
  }

  return db.transaction(() => {
    if (input.counterAccountId) {
      throw new RepositoryError('VALIDATION', 'Only a transfer has a destination account')
    }
    const id = insertTransactionRow(db, userId, {
      accountId: input.accountId,
      kind,
      amountCents,
      occurredOn,
      memo,
      category,
      billId: input.billId ?? null,
      goalId: input.goalId ?? null
    })
    if (kind === 'expense' && amountCents < 0) {
      applyRoundUp(db, userId, {
        sourceId: id,
        accountId: input.accountId,
        accountKind: account.kind,
        amountCents,
        occurredOn,
        memo
      })
    }
    // A bill payment closes the wall's reservation for that cycle.
    if (input.billId && (kind === 'bill_payment' || kind === 'expense')) {
      setBillReserveState(db, userId, input.billId, occurredOn, 'paid')
    }
    return id
  })()
}

interface TransferGroupRow {
  id: string
  amountCents: number
}

function transferGroupRows(db: Db, userId: string, groupId: string): TransferGroupRow[] {
  return db
    .prepare(
      `SELECT id, amount_cents AS amountCents FROM transactions
       WHERE transfer_group_id = ? AND user_id = ? AND deleted_at IS NULL`
    )
    .all(groupId, userId) as TransferGroupRow[]
}

export function updateTransaction(
  db: Db,
  userId: string,
  id: string,
  patch: TransactionPatch
): void {
  if (patch.accountId) requireAccount(db, userId, patch.accountId)

  const existing = db
    .prepare(
      `SELECT transfer_group_id AS groupId, round_up_source_id AS roundUpSourceId,
              bill_id AS billId, amount_cents AS amountCents, kind, account_id AS accountId,
              occurred_on AS occurredOn, memo
       FROM transactions
       WHERE id = ? AND user_id = ? AND deleted_at IS NULL`
    )
    .get(id, userId) as
    | {
        groupId: string | null
        roundUpSourceId: string | null
        billId: string | null
        amountCents: number
        kind: TransactionKind
        accountId: string
        occurredOn: string
        memo: string
      }
    | undefined
  if (!existing) throw new RepositoryError('NOT_FOUND', 'Entry not found')

  if (existing.roundUpSourceId) {
    // A sweep is derived: its amount, date and account are whatever the purchase
    // says. Editing either leg directly would desync the pair from its source.
    if (
      patch.amountCents !== undefined ||
      patch.occurredOn !== undefined ||
      patch.accountId !== undefined ||
      patch.kind !== undefined
    ) {
      throw new RepositoryError('CONFLICT', 'This is a round-up sweep — edit the purchase it came from instead')
    }
  }

  if (existing.groupId) {
    if (patch.accountId || patch.kind) {
      throw new RepositoryError('CONFLICT', 'Paired transfers keep their accounts — delete and re-enter to change them')
    }
    const magnitude =
      patch.amountCents === undefined
        ? null
        : Math.abs(assertCents(patch.amountCents, 'Amount', { allowNegative: true, allowZero: true }))
    const occurredOn =
      patch.occurredOn === undefined ? undefined : assertDate(patch.occurredOn, 'Date')
    const memo = patch.memo === undefined ? undefined : optionalText(patch.memo, 'Memo', 240) ?? ''
    const category =
      patch.category === undefined
        ? undefined
        : optionalText(patch.category, 'Category', 60) ?? 'Uncategorized'

    db.transaction(() => {
      for (const leg of transferGroupRows(db, userId, existing.groupId!)) {
        const sign = leg.amountCents < 0 ? -1 : 1
        updateRow(db, 'transactions', leg.id, userId, {
          amount_cents: magnitude === null ? undefined : sign * magnitude,
          occurred_on: occurredOn,
          memo,
          category
        })
      }
    })()
    return
  }

  const nextKind =
    patch.kind === undefined
      ? existing.kind
      : assertOneOf(patch.kind, TRANSACTION_KINDS, 'transaction kind')
  // A transfer only exists as a pair. Turning a single row into one (or one leg
  // into something else) would strand the other side of the ledger.
  if (nextKind === 'transfer' && existing.kind !== 'transfer') {
    throw new RepositoryError('CONFLICT', 'Transfers need two accounts — delete this entry and record a transfer instead')
  }
  if (existing.kind === 'transfer' && nextKind !== 'transfer') {
    throw new RepositoryError('CONFLICT', 'Paired transfers keep their kind — delete and re-enter to change it')
  }

  const patchTouchesAmount = patch.amountCents !== undefined || patch.kind !== undefined
  let nextAmount = existing.amountCents
  if (patch.amountCents !== undefined) {
    nextAmount = assertCents(patch.amountCents, 'Amount', { allowNegative: true, allowZero: true })
    const signProblem = signedAmountError(nextKind, nextAmount)
    if (signProblem) throw new RepositoryError('VALIDATION', signProblem)
  } else if (patch.kind !== undefined) {
    // Changing only the kind flips the stored sign to match it.
    nextAmount = normalizeSignedCents(nextKind, nextAmount)
  }

  const nextOccurredOn =
    patch.occurredOn === undefined ? existing.occurredOn : assertDate(patch.occurredOn, 'Date')
  const nextMemo = patch.memo === undefined ? existing.memo : optionalText(patch.memo, 'Memo', 240) ?? ''
  const nextAccountId = patch.accountId ?? existing.accountId

  db.transaction(() => {
    updateRow(db, 'transactions', id, userId, {
      account_id: patch.accountId,
      kind: patch.kind === undefined ? undefined : nextKind,
      amount_cents: patchTouchesAmount ? nextAmount : undefined,
      occurred_on: patch.occurredOn === undefined ? undefined : nextOccurredOn,
      memo: patch.memo === undefined ? undefined : nextMemo,
      category:
        patch.category === undefined
          ? undefined
          : optionalText(patch.category, 'Category', 60) ?? 'Uncategorized'
    })

    // A purchase's sweep is derived from it: remove the old pair, then let the
    // same rule that created it decide whether a new one is still owed.
    if (patchTouchesAmount || patch.occurredOn !== undefined || patch.accountId !== undefined) {
      removeRoundUpFor(db, userId, id)
      if (nextKind === 'expense' && nextAmount < 0) {
        const account = requireAccount(db, userId, nextAccountId)
        applyRoundUp(db, userId, {
          sourceId: id,
          accountId: nextAccountId,
          accountKind: account.kind,
          amountCents: nextAmount,
          occurredOn: nextOccurredOn,
          memo: nextMemo
        })
      }
    }

    // Editing a bill payment re-opens its old cycle and closes the new one, so
    // the wall never shows a bill as paid on a date it no longer covers.
    if (
      existing.billId &&
      (patchTouchesAmount || patch.kind !== undefined || patch.occurredOn !== undefined)
    ) {
      setBillReserveState(db, userId, existing.billId, existing.occurredOn, 'reserved')
      if (nextKind === 'bill_payment' || nextKind === 'expense') {
        setBillReserveState(db, userId, existing.billId, nextOccurredOn, 'paid')
      }
    }
  })()
}

/**
 * Soft-deletes every sweep leg that a purchase spawned. The source row stays;
 * the next edit is free to create a fresh, correct sweep.
 */
function removeRoundUpFor(db: Db, userId: string, sourceId: string): void {
  const ts = nowISO()
  db.prepare(
    `UPDATE transactions
     SET deleted_at = ?, updated_at = ?, revision = revision + 1
     WHERE round_up_source_id = ? AND user_id = ? AND deleted_at IS NULL`
  ).run(ts, ts, sourceId, userId)
}

export function deleteTransaction(db: Db, userId: string, id: string): void {
  const existing = db
    .prepare(
      `SELECT transfer_group_id AS groupId, round_up_source_id AS roundUpSourceId,
              bill_id AS billId, occurred_on AS occurredOn
       FROM transactions
       WHERE id = ? AND user_id = ? AND deleted_at IS NULL`
    )
    .get(id, userId) as
    | {
        groupId: string | null
        roundUpSourceId: string | null
        billId: string | null
        occurredOn: string
      }
    | undefined

  if (existing?.groupId) {
    db.transaction(() => {
      for (const leg of transferGroupRows(db, userId, existing.groupId!)) {
        softDelete(db, 'transactions', leg.id, userId)
      }
    })()
    return
  }

  // Deleting a purchase takes its sweep with it; a sweep that no longer
  // corresponds to spending would quietly move money to savings.
  db.transaction(() => {
    removeRoundUpFor(db, userId, id)
    softDelete(db, 'transactions', id, userId)
    if (existing?.billId) {
      setBillReserveState(db, userId, existing.billId, existing.occurredOn, 'reserved')
    }
  })()
}

// ---------------------------------------------------------------- paychecks

type PaycheckRow = Omit<Paycheck, 'health'> & { health: PlanHealth }

export function listPaychecks(db: Db, userId: string, limit = 24): PaycheckWithAllocations[] {
  const rows = db
    .prepare(
      `SELECT id, user_id AS userId, amount_cents AS amountCents, received_on AS receivedOn,
              source, deposit_account_id AS depositAccountId, priority_cents AS priorityCents,
              surplus_cents AS surplusCents, leisure_cents AS leisureCents, health,
              created_at AS createdAt, updated_at AS updatedAt, deleted_at AS deletedAt, revision
       FROM paychecks
       WHERE user_id = ? AND deleted_at IS NULL
       ORDER BY received_on DESC, created_at DESC
       LIMIT ?`
    )
    .all(userId, limit) as PaycheckRow[]

  if (rows.length === 0) return []

  const placeholders = rows.map(() => '?').join(',')
  const allocations = db
    .prepare(
      `SELECT id, user_id AS userId, paycheck_id AS paycheckId, bucket,
              goal_id AS goalId, label, amount_cents AS amountCents,
              created_at AS createdAt, updated_at AS updatedAt,
              deleted_at AS deletedAt, revision
       FROM allocations
       WHERE paycheck_id IN (${placeholders}) AND user_id = ? AND deleted_at IS NULL
       ORDER BY created_at, id`
    )
    .all(...rows.map((row) => row.id), userId) as Allocation[]

  const byPaycheck = new Map<string, Allocation[]>()
  for (const allocation of allocations) {
    const list = byPaycheck.get(allocation.paycheckId) ?? []
    list.push(allocation)
    byPaycheck.set(allocation.paycheckId, list)
  }

  return rows.map((row) => ({ ...row, allocations: byPaycheck.get(row.id) ?? [] }))
}

export interface PaycheckRecordAllocation {
  bucket: Allocation['bucket']
  goalId: string | null
  label: string
  amountCents: number
}

export interface PaycheckRecordInput {
  incomeCents: number
  receivedOn: string
  source: string
  depositAccountId: string | null
  priorityCents: number
  surplusCents: number
  leisureCents: number
  health: PlanHealth
  allocations: PaycheckRecordAllocation[]
  recordIncome: boolean
}

export function insertPaycheckRecord(
  db: Db,
  userId: string,
  input: PaycheckRecordInput
): string {
  const paycheckId = randomUUID()
  const ts = nowISO()

  db.prepare(
    `INSERT INTO paychecks
       (id, user_id, amount_cents, received_on, source, deposit_account_id,
        priority_cents, surplus_cents, leisure_cents, health,
        created_at, updated_at, deleted_at, revision)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1)`
  ).run(
    paycheckId,
    userId,
    input.incomeCents,
    input.receivedOn,
    input.source,
    input.depositAccountId,
    input.priorityCents,
    input.surplusCents,
    input.leisureCents,
    input.health,
    ts,
    ts
  )

  const insertAllocation = db.prepare(
    `INSERT INTO allocations
       (id, user_id, paycheck_id, bucket, goal_id, label, amount_cents,
        created_at, updated_at, deleted_at, revision)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1)`
  )

  for (const line of input.allocations) {
    if (line.amountCents <= 0) continue
    insertAllocation.run(
      randomUUID(),
      userId,
      paycheckId,
      line.bucket,
      line.goalId,
      line.label,
      line.amountCents,
      ts,
      ts
    )
  }

  if (input.recordIncome && input.depositAccountId) {
    insertTransactionRow(db, userId, {
      accountId: input.depositAccountId,
      kind: 'income',
      amountCents: input.incomeCents,
      occurredOn: input.receivedOn,
      memo: input.source,
      category: 'Paycheck',
      paycheckId
    })
  }

  return paycheckId
}

export function commitPaycheck(
  db: Db,
  userId: string,
  input: PaycheckDraftInput
): CommittedPaycheck {
  const incomeCents = assertCents(input.incomeCents, 'Income')
  const receivedOn = assertDate(input.receivedOn, 'Pay date')
  const payCadence = assertOneOf(input.payCadence, PAY_CADENCES, 'pay cadence')
  const source = optionalText(input.source, 'Source', 80) ?? 'Paycheck'
  const depositAccountId = input.depositAccountId
  if (!depositAccountId) throw new RepositoryError('VALIDATION', 'Choose the account this paycheck landed in')
  requireAccount(db, userId, depositAccountId)

  // A double-click or a re-entry of the same deposit would reserve the wall
  // twice and add phantom income. The renderer asks before passing the flag.
  if (!input.allowDuplicate) {
    const duplicate = db
      .prepare(
        `SELECT id FROM paychecks
         WHERE user_id = ? AND deleted_at IS NULL
           AND deposit_account_id = ? AND amount_cents = ? AND received_on = ?`
      )
      .get(userId, depositAccountId, incomeCents, receivedOn)
    if (duplicate) {
      throw new RepositoryError(
        'CONFLICT',
        'A paycheck of this amount already exists on this date in this account. Confirm the second deposit if it really is separate.'
      )
    }
  }

  const settings = parseSettings(readSettings(db, userId))
  const cycle = receivedOn.slice(0, 7)
  const bills = listBills(db, userId).filter((bill) => bill.isActive)
  const goals = listGoals(db, userId).filter(
    (goal) => !goal.isArchived && !(goal.isEmergency && !settings.emergencyActive)
  )

  const plan = buildAllocationPlan({
    incomeCents,
    payCadence,
    paycheckDate: receivedOn,
    payAnchorDate: settings.payAnchorDate,
    reservedBillIds: reservedBillIdsFor(db, userId, cycle),
    bills,
    goals,
    splits: input.splits,
    wholeDollarBuckets: input.wholeDollarBuckets
  })

  const lines: PaycheckRecordAllocation[] = [
    {
      bucket: 'priority',
      goalId: null,
      label: 'Priority Wall reserve',
      amountCents: plan.priorityFundedCents
    },
    { bucket: 'savings', goalId: null, label: 'Savings', amountCents: plan.savingsCents },
    {
      bucket: 'investment',
      goalId: null,
      label: 'Investments',
      amountCents: plan.investmentCents
    },
    { bucket: 'debt', goalId: null, label: 'Debt payoff', amountCents: plan.debtCents },
    ...plan.goalFundings.map<PaycheckRecordAllocation>((funding) => ({
      bucket: 'goal',
      goalId: funding.goalId,
      label: funding.name,
      amountCents: funding.amountCents
    })),
    {
      bucket: 'leisure',
      goalId: null,
      label: 'Guilt-free spending',
      amountCents: plan.leisureCents
    }
  ]

  const run = db.transaction(() => {
    const paycheckId = insertPaycheckRecord(db, userId, {
      incomeCents: plan.incomeCents,
      receivedOn,
      source,
      depositAccountId,
      priorityCents: plan.priorityFundedCents,
      surplusCents: plan.surplusCents,
      leisureCents: plan.leisureCents,
      health: plan.health,
      allocations: lines,
      recordIncome: true
    })
    // A shortfall means the wall was not fully funded, so no per-bill claim is
    // recorded; the next cheque gets another chance instead of a false receipt.
    if (plan.shortfallCents === 0) {
      recordBillReserves(db, userId, paycheckId, cycle, plan.priorityReserves)
    }
    return paycheckId
  })

  return { paycheckId: run(), plan }
}

// ---------------------------------------------------------------- snapshot

export function getSnapshot(db: Db, userId: string): Snapshot {
  // One read transaction: eight separate statements could otherwise straddle a
  // write and hand the UI a snapshot that never existed.
  return db.transaction(
    (): Snapshot => ({
      user: getUser(db, userId),
      settings: readSettings(db, userId),
      accounts: listAccounts(db, userId),
      bills: listBills(db, userId),
      goals: listGoals(db, userId),
      transactions: listTransactions(db, userId),
      paychecks: listPaychecks(db, userId),
      billReserves: listBillReserves(db, userId)
    })
  )()
}

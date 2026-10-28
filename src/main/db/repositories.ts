import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { buildAllocationPlan } from '@shared/allocator'
import type { CommittedPaycheck } from '@shared/api'
import { isISODate } from '@shared/dates'
import { parseSettings } from '@shared/settings'
import { roundUpRemainderCents, transferLegs } from '@shared/transfers'
import type {
  AccountInput,
  AccountKind,
  AccountWithBalance,
  Allocation,
  Bill,
  BillInput,
  Frequency,
  Goal,
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
  if (typeof value !== 'string') throw new Error(`${label} must be text`)
  const trimmed = value.trim()
  if (!trimmed) throw new Error(`${label} is required`)
  if (trimmed.length > max) throw new Error(`${label} is too long`)
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
    throw new Error(`${label} must be a number`)
  }
  const cents = Math.round(value)
  if (!Number.isSafeInteger(cents)) throw new Error(`${label} is out of range`)
  if (!options.allowNegative && cents < 0) throw new Error(`${label} cannot be negative`)
  if (!options.allowZero && cents === 0) throw new Error(`${label} cannot be zero`)
  return cents
}

function assertOneOf<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new Error(`Invalid ${label}`)
  }
  return value as T
}

function assertDate(value: unknown, label: string): string {
  if (!isISODate(value)) throw new Error(`${label} must be a date in YYYY-MM-DD form`)
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

function requireAccount(db: Db, userId: string, accountId: string): { id: string; kind: AccountKind } {
  const row = db
    .prepare('SELECT id, kind FROM accounts WHERE id = ? AND user_id = ? AND deleted_at IS NULL')
    .get(accountId, userId) as { id: string; kind: AccountKind } | undefined
  if (!row) throw new Error('Account not found')
  return row
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
  if (!row) throw new Error('Local user is missing')
  return row
}

export function getLocalUserId(db: Db): string {
  const row = db
    .prepare('SELECT id FROM users WHERE deleted_at IS NULL ORDER BY created_at LIMIT 1')
    .get() as { id: string } | undefined
  if (!row) throw new Error('No local user has been seeded')
  return row.id
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

type AccountRow = Omit<AccountWithBalance, 'isArchived'> & { isArchived: number }

function mapAccount(row: AccountRow): AccountWithBalance {
  return { ...row, isArchived: row.isArchived === 1 }
}

export function listAccounts(db: Db, userId: string): AccountWithBalance[] {
  const rows = db
    .prepare(
      `SELECT a.id, a.user_id AS userId, a.name, a.kind, a.institution,
              a.starting_balance_cents AS startingBalanceCents,
              a.credit_limit_cents AS creditLimitCents,
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
  db.prepare(
    `INSERT INTO accounts
       (id, user_id, name, kind, institution, starting_balance_cents, credit_limit_cents,
        is_archived, sort_order, created_at, updated_at, deleted_at, revision)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, NULL, 1)`
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
    sort_order: patch.sortOrder
  })
}

export function deleteAccount(db: Db, userId: string, id: string): void {
  const ts = nowISO()
  db.transaction(() => {
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

// ---------------------------------------------------------------- bills

type BillRow = Omit<Bill, 'autopay' | 'isActive'> & { autopay: number; isActive: number }

function mapBill(row: BillRow): Bill {
  return { ...row, autopay: row.autopay === 1, isActive: row.isActive === 1 }
}

const BILL_SELECT = `
  SELECT id, user_id AS userId, name, amount_cents AS amountCents, frequency,
         due_day AS dueDay, category, account_id AS accountId, autopay,
         is_active AS isActive, next_due_on AS nextDueOn,
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

  db.prepare(
    `INSERT INTO bills
       (id, user_id, name, amount_cents, frequency, due_day, category, account_id,
        autopay, is_active, next_due_on, created_at, updated_at, deleted_at, revision)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1)`
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
          : null
  })
}

export function deleteBill(db: Db, userId: string, id: string): void {
  softDelete(db, 'bills', id, userId)
}

// ---------------------------------------------------------------- goals

type GoalRow = Omit<GoalWithProgress, 'isArchived' | 'isEmergency'> & {
  isArchived: number
  isEmergency: number
  fundedCents: number
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
                WHERE a.goal_id = g.id AND a.deleted_at IS NULL AND a.bucket = 'goal'
              ), 0) AS fundedCents
       FROM goals g
       WHERE g.user_id = ? AND g.deleted_at IS NULL
       ORDER BY g.is_archived, g.priority, g.name`
    )
    .all(userId) as GoalRow[]

  return rows.map((row) => ({
    ...row,
    isArchived: row.isArchived === 1,
    isEmergency: row.isEmergency === 1,
    fundedCents: row.fundedCents,
    remainingCents: Math.max(0, row.targetCents - row.fundedCents)
  }))
}

export function createGoal(db: Db, userId: string, input: GoalInput): string {
  const id = randomUUID()
  const ts = nowISO()
  const accountId = input.accountId ? optionalText(input.accountId, 'Account') : null
  if (accountId) requireAccount(db, userId, accountId)

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
  return id
}

export function updateGoal(
  db: Db,
  userId: string,
  id: string,
  patch: Partial<GoalInput>
): void {
  if (patch.accountId) requireAccount(db, userId, patch.accountId)

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
}

export function deleteGoal(db: Db, userId: string, id: string): void {
  softDelete(db, 'goals', id, userId)
}

// ---------------------------------------------------------------- transactions

export function listTransactions(db: Db, userId: string, limit = 500): TransactionRow[] {
  return db
    .prepare(
      `SELECT t.id, t.user_id AS userId, t.account_id AS accountId, t.kind,
              t.amount_cents AS amountCents, t.occurred_on AS occurredOn, t.memo, t.category,
              t.bill_id AS billId, t.goal_id AS goalId, t.paycheck_id AS paycheckId,
              t.counter_account_id AS counterAccountId, t.transfer_group_id AS transferGroupId,
              t.created_at AS createdAt,
              t.updated_at AS updatedAt, t.deleted_at AS deletedAt, t.revision,
              a.name AS accountName
       FROM transactions t
       JOIN accounts a ON a.id = t.account_id
       WHERE t.user_id = ? AND t.deleted_at IS NULL
       ORDER BY t.occurred_on DESC, t.created_at DESC
       LIMIT ?`
    )
    .all(userId, limit) as TransactionRow[]
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
}

export function insertTransactionRow(db: Db, userId: string, input: NewTransactionInput): string {
  const id = randomUUID()
  const ts = nowISO()
  db.prepare(
    `INSERT INTO transactions
       (id, user_id, account_id, kind, amount_cents, occurred_on, memo, category,
        bill_id, goal_id, paycheck_id, counter_account_id, transfer_group_id,
        created_at, updated_at, deleted_at, revision)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1)`
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
    ts,
    ts
  )
  return id
}

/**
 * Round-up is a real sweep, not a note: it posts a paired transfer so the
 * spending account and the destination both move by the rounded cents.
 */
function applyRoundUp(
  db: Db,
  userId: string,
  input: { accountId: string; accountKind: AccountKind; amountCents: number; occurredOn: string; memo: string }
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
  const memo = input.memo ? `Round-up · ${input.memo}` : 'Round-up sweep'
  insertTransactionRow(db, userId, {
    accountId: input.accountId,
    kind: 'transfer',
    amountCents: -sweepCents,
    occurredOn: input.occurredOn,
    memo,
    category: 'Round-up',
    counterAccountId: settings.roundUpAccountId,
    transferGroupId: groupId
  })
  insertTransactionRow(db, userId, {
    accountId: settings.roundUpAccountId,
    kind: 'transfer',
    amountCents: sweepCents,
    occurredOn: input.occurredOn,
    memo,
    category: 'Round-up',
    counterAccountId: input.accountId,
    transferGroupId: groupId
  })
}

export function createTransaction(db: Db, userId: string, input: TransactionInput): string {
  const kind = assertOneOf(input.kind, TRANSACTION_KINDS, 'transaction kind')
  const amountCents = assertCents(input.amountCents, 'Amount', {
    allowNegative: true,
    allowZero: false
  })
  const occurredOn = assertDate(input.occurredOn, 'Date')
  const memo = optionalText(input.memo, 'Memo', 240) ?? ''
  const category = optionalText(input.category, 'Category', 60) ?? 'Uncategorized'
  const account = requireAccount(db, userId, input.accountId)

  if (kind === 'transfer') {
    if (!input.counterAccountId) throw new Error('Transfers need a destination account')
    if (input.counterAccountId === input.accountId) {
      throw new Error('Choose two different accounts')
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
    const id = insertTransactionRow(db, userId, {
      accountId: input.accountId,
      kind,
      amountCents,
      occurredOn,
      memo,
      category,
      billId: input.billId ?? null,
      goalId: input.goalId ?? null,
      counterAccountId: input.counterAccountId ?? null
    })
    if (kind === 'expense' && amountCents < 0) {
      applyRoundUp(db, userId, {
        accountId: input.accountId,
        accountKind: account.kind,
        amountCents,
        occurredOn,
        memo
      })
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
      `SELECT transfer_group_id AS groupId, amount_cents AS amountCents FROM transactions
       WHERE id = ? AND user_id = ? AND deleted_at IS NULL`
    )
    .get(id, userId) as { groupId: string | null; amountCents: number } | undefined
  if (!existing) throw new Error('Entry not found')

  if (existing.groupId) {
    if (patch.accountId || patch.kind) {
      throw new Error('Paired transfers keep their accounts — delete and re-enter to change them')
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

  updateRow(db, 'transactions', id, userId, {
    account_id: patch.accountId,
    kind:
      patch.kind === undefined
        ? undefined
        : assertOneOf(patch.kind, TRANSACTION_KINDS, 'transaction kind'),
    amount_cents:
      patch.amountCents === undefined
        ? undefined
        : assertCents(patch.amountCents, 'Amount', { allowNegative: true, allowZero: true }),
    occurred_on:
      patch.occurredOn === undefined ? undefined : assertDate(patch.occurredOn, 'Date'),
    memo: patch.memo === undefined ? undefined : optionalText(patch.memo, 'Memo', 240) ?? '',
    category:
      patch.category === undefined
        ? undefined
        : optionalText(patch.category, 'Category', 60) ?? 'Uncategorized'
  })
}

export function deleteTransaction(db: Db, userId: string, id: string): void {
  const existing = db
    .prepare(
      `SELECT transfer_group_id AS groupId FROM transactions
       WHERE id = ? AND user_id = ? AND deleted_at IS NULL`
    )
    .get(id, userId) as { groupId: string | null } | undefined

  if (existing?.groupId) {
    db.transaction(() => {
      for (const leg of transferGroupRows(db, userId, existing.groupId!)) {
        softDelete(db, 'transactions', leg.id, userId)
      }
    })()
    return
  }

  softDelete(db, 'transactions', id, userId)
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
       WHERE paycheck_id IN (${placeholders}) AND deleted_at IS NULL
       ORDER BY created_at, id`
    )
    .all(...rows.map((row) => row.id)) as Allocation[]

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
  if (!depositAccountId) throw new Error('Choose the account this paycheck landed in')
  requireAccount(db, userId, depositAccountId)

  const bills = listBills(db, userId).filter((bill) => bill.isActive)
  const goals = listGoals(db, userId)

  const plan = buildAllocationPlan({
    incomeCents,
    payCadence,
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

  const run = db.transaction(() =>
    insertPaycheckRecord(db, userId, {
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
  )

  return { paycheckId: run(), plan }
}

// ---------------------------------------------------------------- snapshot

export function getSnapshot(db: Db, userId: string): Snapshot {
  return {
    user: getUser(db, userId),
    settings: readSettings(db, userId),
    accounts: listAccounts(db, userId),
    bills: listBills(db, userId),
    goals: listGoals(db, userId),
    transactions: listTransactions(db, userId),
    paychecks: listPaychecks(db, userId)
  }
}

import { randomUUID } from 'node:crypto'
import { RepositoryError } from '@shared/errors'
import { normalizeSignedCents, signedAmountError } from '@shared/kinds'
import { parseSettings } from '@shared/settings'
import { ledgerStatementCents } from '@shared/statements'
import { roundUpRemainderCents, transferLegs } from '@shared/transfers'
import type {
  AccountKind,
  BillPaymentEntry,
  BillPaymentTotal,
  LedgerQuery,
  LedgerSort,
  TransactionInput,
  TransactionKind,
  TransactionPage,
  TransactionPatch,
  TransactionRow
} from '@shared/types'
import {
  assertCents,
  assertDate,
  assertOneOf,
  nowISO,
  optionalText,
  requireAccount,
  softDelete,
  updateRow,
  type Db
} from './common'
import { ensureCategory } from './categories'
import { setBillReserveState } from './bills'
import { accountBalanceOn } from './accounts'
import { readSettings } from './settings'

const TRANSACTION_KINDS: readonly TransactionKind[] = [
  'income',
  'expense',
  'bill_payment',
  'transfer',
  'goal_funding',
  'investment',
  'adjustment'
]

function requirePaycheck(db: Db, userId: string, id: string): void {
  const row = db
    .prepare(`SELECT 1 FROM paychecks WHERE id = ? AND user_id = ? AND deleted_at IS NULL`)
    .get(id, userId)
  if (!row) throw new RepositoryError('VALIDATION', 'That paycheck no longer exists')
}

const TRANSACTION_SELECT = `
  SELECT t.id, t.user_id AS userId, t.account_id AS accountId, t.kind,
         t.amount_cents AS amountCents, t.occurred_on AS occurredOn, t.memo, t.category,
         t.category_id AS categoryId, t.external_id AS externalId,
         t.bill_id AS billId, t.goal_id AS goalId, t.paycheck_id AS paycheckId,
         t.counter_account_id AS counterAccountId, t.transfer_group_id AS transferGroupId,
         t.created_at AS createdAt,
         t.updated_at AS updatedAt, t.deleted_at AS deletedAt, t.revision,
         a.name AS accountName, a.institution AS accountInstitution
  FROM transactions t
  JOIN accounts a ON a.id = t.account_id`

const TRANSACTION_ORDER = 'ORDER BY t.occurred_on DESC, t.created_at DESC'

export function listTransactions(db: Db, userId: string, limit = 500): TransactionRow[] {
  return db
    .prepare(
      `${TRANSACTION_SELECT}
       WHERE t.user_id = ? AND t.deleted_at IS NULL
       ${TRANSACTION_ORDER}
       LIMIT ?`
    )
    .all(userId, limit) as TransactionRow[]
}

/** Every live entry, for exports. The grid keeps its own capped query. */
export function listAllTransactions(db: Db, userId: string): TransactionRow[] {
  return db
    .prepare(`${TRANSACTION_SELECT} WHERE t.user_id = ? AND t.deleted_at IS NULL ${TRANSACTION_ORDER}`)
    .all(userId) as TransactionRow[]
}

/**
 * The rows one edit produced: the entry, its other transfer leg, and the
 * round-up sweep derived from it. Lets the grid patch itself instead of
 * re-reading the newest 500 entries after every keystroke-sized save.
 */
export function transactionRowsFor(db: Db, userId: string, id: string): TransactionRow[] {
  const row = db
    .prepare(
      `SELECT transfer_group_id AS transferGroupId
       FROM transactions WHERE id = ? AND user_id = ? AND deleted_at IS NULL`
    )
    .get(id, userId) as { transferGroupId: string | null } | undefined
  if (!row) return []
  return db
    .prepare(
      `${TRANSACTION_SELECT}
       WHERE t.user_id = ? AND t.deleted_at IS NULL
         AND (t.id = ? OR t.round_up_source_id = ? OR t.transfer_group_id = ?)
       ${TRANSACTION_ORDER}`
    )
    .all(userId, id, id, row.transferGroupId ?? '') as TransactionRow[]
}

/**
 * This calendar month's payments linked to a bill, per bill. The wall is a
 * smoothed monthly figure; a payment releases the part of the month it covered,
 * so money is never withheld after it has left the account. Stored payments are
 * negative, so the sum is negated; a linked refund therefore reduces the total.
 *
 * A payment made from a credit account is reported in `creditCents` as well:
 * it settled the bill without taking anything out of the spendable pool, so the
 * caller that measures that pool must not treat it as released.
 */
export function listBillPaymentsThisMonth(
  db: Db,
  userId: string,
  monthISO: string
): BillPaymentTotal[] {
  return db
    .prepare(
      `SELECT t.bill_id AS billId,
              SUM(-t.amount_cents) AS paidCents,
              SUM(CASE WHEN a.kind = 'credit' THEN -t.amount_cents ELSE 0 END) AS creditCents
       FROM transactions t
       JOIN accounts a ON a.id = t.account_id
       WHERE t.user_id = ? AND t.deleted_at IS NULL
         AND t.bill_id IS NOT NULL
         AND substr(t.occurred_on, 1, 7) = ?
       GROUP BY t.bill_id`
    )
    .all(userId, monthISO) as BillPaymentTotal[]
}

/**
 * Bill-linked entries on or after `fromISO`. The prompt card matches a cycle by
 * bill and date, and the capped ledger window can be much newer than the last
 * annual occurrence — so those rows are read on their own, without a cap.
 */
export function listBillPaymentsSince(
  db: Db,
  userId: string,
  fromISO: string
): BillPaymentEntry[] {
  return db
    .prepare(
      `SELECT bill_id AS billId, occurred_on AS occurredOn, amount_cents AS amountCents
       FROM transactions
       WHERE user_id = ? AND deleted_at IS NULL AND bill_id IS NOT NULL
         AND occurred_on >= ?
       ORDER BY occurred_on DESC`
    )
    .all(userId, fromISO) as BillPaymentEntry[]
}

/** How many live entries exist, so a capped grid can say what it is not showing. */
export function transactionCount(db: Db, userId: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS total FROM transactions WHERE user_id = ? AND deleted_at IS NULL`
    )
    .get(userId) as { total: number }
  return row.total
}

const LEDGER_SORTS: Record<LedgerSort, string> = {
  date_desc: 't.occurred_on DESC, t.created_at DESC',
  date_asc: 't.occurred_on ASC, t.created_at ASC',
  amount_desc: 'ABS(t.amount_cents) DESC, t.occurred_on DESC',
  amount_asc: 'ABS(t.amount_cents) ASC, t.occurred_on DESC'
}

/**
 * One indexed query for the ledger's filter bar. The same WHERE feeds the count,
 * so "showing 40 of 1,240" is the filter's own number, not the table's.
 */
export function queryTransactions(db: Db, userId: string, query: LedgerQuery): TransactionPage {
  const where: string[] = ['t.user_id = ?', 't.deleted_at IS NULL']
  const args: unknown[] = [userId]

  const text = query.filter.text?.trim()
  if (text) {
    where.push('(instr(lower(t.memo), lower(?)) > 0 OR instr(lower(t.category), lower(?)) > 0)')
    args.push(text, text)
  }
  if (query.filter.from) {
    where.push('t.occurred_on >= ?')
    args.push(assertDate(query.filter.from, 'From date'))
  }
  if (query.filter.to) {
    where.push('t.occurred_on <= ?')
    args.push(assertDate(query.filter.to, 'To date'))
  }
  if (query.filter.accountId) {
    where.push('t.account_id = ?')
    args.push(query.filter.accountId)
  }
  if (query.filter.kind) {
    where.push('t.kind = ?')
    args.push(assertOneOf(query.filter.kind, TRANSACTION_KINDS, 'transaction kind'))
  }
  if (query.filter.categoryId) {
    where.push('t.category_id = ?')
    args.push(query.filter.categoryId)
  }

  const whereSql = where.join(' AND ')
  const sort = LEDGER_SORTS[query.sort] ?? LEDGER_SORTS.date_desc
  const limit = Math.min(500, Math.max(1, Math.round(query.limit)))
  const offset = Math.max(0, Math.round(query.offset))

  const rows = db
    .prepare(
      `SELECT t.id, t.user_id AS userId, t.account_id AS accountId, t.kind,
              t.amount_cents AS amountCents, t.occurred_on AS occurredOn, t.memo, t.category,
              t.category_id AS categoryId, t.external_id AS externalId,
              t.bill_id AS billId, t.goal_id AS goalId, t.paycheck_id AS paycheckId,
              t.counter_account_id AS counterAccountId,
              t.transfer_group_id AS transferGroupId,
              t.created_at AS createdAt, t.updated_at AS updatedAt,
              t.deleted_at AS deletedAt, t.revision,
              a.name AS accountName, a.institution AS accountInstitution
       FROM transactions t
       JOIN accounts a ON a.id = t.account_id
       WHERE ${whereSql}
       ORDER BY ${sort}
       LIMIT ? OFFSET ?`
    )
    .all(...args, limit, offset) as TransactionRow[]

  const total = (
    db
      .prepare(
        `SELECT COUNT(*) AS total FROM transactions t
         WHERE ${whereSql}`
      )
      .get(...args) as { total: number }
  ).total

  return { rows, total }
}



export interface NewTransactionInput {
  accountId: string
  kind: TransactionKind
  amountCents: number
  occurredOn: string
  memo: string
  category: string
  categoryId?: string | null
  externalId?: string | null
  billId?: string | null
  goalId?: string | null
  paycheckId?: string | null
  counterAccountId?: string | null
  transferGroupId?: string | null
  roundUpSourceId?: string | null
}

/**
 * Labels the app writes itself belong to a seeded category, so the list stays
 * short instead of gaining one row per internal payment type.
 */
const INTERNAL_CATEGORY_ALIASES: Record<string, string> = {
  'round-up': 'Transfer',
  'credit payment': 'Debt',
  paycheck: 'Income'
}

function resolveCategory(
  db: Db,
  userId: string,
  kind: TransactionKind,
  input: { category: string; categoryId?: string | null }
): { id: string | null; name: string } {
  if (input.categoryId) {
    const row = db
      .prepare(
        'SELECT id, name FROM categories WHERE id = ? AND user_id = ? AND deleted_at IS NULL'
      )
      .get(input.categoryId, userId) as { id: string; name: string } | undefined
    if (!row) throw new RepositoryError('NOT_FOUND', 'Category not found')
    return { id: row.id, name: row.name }
  }
  const raw = optionalText(input.category, 'Category', 60) ?? 'Uncategorized'
  const name = INTERNAL_CATEGORY_ALIASES[raw.toLocaleLowerCase()] ?? raw
  return { id: ensureCategory(db, userId, name, kind), name }
}

export function insertTransactionRow(db: Db, userId: string, input: NewTransactionInput): string {
  const id = randomUUID()
  const ts = nowISO()
  const category = resolveCategory(db, userId, input.kind, input)
  db.prepare(
    `INSERT INTO transactions
       (id, user_id, account_id, kind, amount_cents, occurred_on, memo, category,
        category_id, external_id, bill_id, goal_id, paycheck_id, counter_account_id,
        transfer_group_id, round_up_source_id, created_at, updated_at, deleted_at, revision)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1)`
  ).run(
    id,
    userId,
    input.accountId,
    input.kind,
    input.amountCents,
    input.occurredOn,
    input.memo,
    category.name,
    category.id,
    input.externalId ?? null,
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
  const category = input.category
  const categoryId = input.categoryId ?? null
  const account = requireAccount(db, userId, input.accountId)
  if (input.paycheckId) requirePaycheck(db, userId, input.paycheckId)

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
        categoryId,
        counterAccountId,
        transferGroupId: groupId,
        paycheckId: input.paycheckId ?? null
      })
      insertTransactionRow(db, userId, {
        accountId: counterAccountId,
        kind,
        amountCents: legs.inCents,
        occurredOn,
        memo,
        category,
        counterAccountId: input.accountId,
        transferGroupId: groupId,
        paycheckId: input.paycheckId ?? null
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
      categoryId,
      billId: input.billId ?? null,
      goalId: input.goalId ?? null,
      paycheckId: input.paycheckId ?? null
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
              occurred_on AS occurredOn, memo, category, category_id AS categoryId
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
        category: string
        categoryId: string | null
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
        : Math.abs(assertCents(patch.amountCents, 'Amount', { allowNegative: true }))
    const occurredOn =
      patch.occurredOn === undefined ? undefined : assertDate(patch.occurredOn, 'Date')
    const memo = patch.memo === undefined ? undefined : optionalText(patch.memo, 'Memo', 240) ?? ''
    const categoryChange =
      patch.category === undefined && patch.categoryId === undefined
        ? null
        : resolveCategory(db, userId, existing.kind, {
            category: patch.category ?? existing.category,
            categoryId: patch.categoryId
          })

    db.transaction(() => {
      for (const leg of transferGroupRows(db, userId, existing.groupId!)) {
        const sign = leg.amountCents < 0 ? -1 : 1
        updateRow(db, 'transactions', leg.id, userId, {
          amount_cents: magnitude === null ? undefined : sign * magnitude,
          occurred_on: occurredOn,
          memo,
          category: categoryChange?.name,
          category_id: categoryChange?.id
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
    nextAmount = assertCents(patch.amountCents, 'Amount', { allowNegative: true })
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
  const categoryChange =
    patch.category === undefined && patch.categoryId === undefined
      ? null
      : resolveCategory(db, userId, nextKind, {
          category: patch.category ?? existing.category,
          categoryId: patch.categoryId
        })

  db.transaction(() => {
    updateRow(db, 'transactions', id, userId, {
      account_id: patch.accountId,
      kind: patch.kind === undefined ? undefined : nextKind,
      amount_cents: patchTouchesAmount ? nextAmount : undefined,
      occurred_on: patch.occurredOn === undefined ? undefined : nextOccurredOn,
      memo: patch.memo === undefined ? undefined : nextMemo,
      category: categoryChange?.name,
      category_id: categoryChange?.id
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

  if (!existing) throw new RepositoryError('NOT_FOUND', 'Entry not found')
  const row = existing

  if (row.groupId) {
    db.transaction(() => {
      for (const leg of transferGroupRows(db, userId, row.groupId!)) {
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
    if (row.billId) {
      setBillReserveState(db, userId, row.billId, row.occurredOn, 'reserved')
    }
  })()
}

/**
 * Deletes every selected entry as one movement. Transfer legs are deleted in
 * pairs, so a selection that contains one leg also removes its twin; the twin
 * is then skipped instead of aborting the batch with "not found". The whole
 * batch is one transaction: either every row goes or none does.
 */
export function deleteTransactions(db: Db, userId: string, ids: readonly string[]): number {
  const unique = [...new Set(ids)]
  if (unique.length === 0) return 0

  return db.transaction(() => {
    const live = new Set<string>()
    const statement = db.prepare(
      'SELECT 1 AS present FROM transactions WHERE id = ? AND user_id = ? AND deleted_at IS NULL'
    )
    for (const id of unique) {
      if (statement.get(id, userId)) live.add(id)
    }
    let removed = 0
    for (const id of unique) {
      if (!live.has(id)) continue
      // A paired leg may already have been removed by its twin earlier in the loop.
      if (!statement.get(id, userId)) continue
      deleteTransaction(db, userId, id)
      removed += 1
    }
    return removed
  })()
}

/**
 * Brings an account's balance on `onDate` to a statement's closing figure with
 * one adjustment dated that day. Entries recorded after the statement closed
 * are untouched, so reconciling an older statement cannot undo newer spending.
 * Returns the amount posted; zero means the ledger already agreed.
 */
export function reconcileAccountOn(
  db: Db,
  userId: string,
  accountId: string,
  statementCents: number,
  onDate: string
): number {
  const held = accountBalanceOn(db, userId, accountId, onDate)
  if (!held) throw new RepositoryError('NOT_FOUND', 'That account no longer exists')
  // A card statement prints what is owed as a positive number while the ledger
  // stores debt as negative, so the target is expressed in the ledger's sign.
  const target = ledgerStatementCents(statementCents, held.kind)
  const difference = target - held.balanceCents
  if (difference === 0) return 0
  createTransaction(db, userId, {
    accountId,
    kind: 'adjustment',
    amountCents: difference,
    occurredOn: onDate,
    memo: 'Statement reconciliation',
    category: 'Adjustment'
  })
  return difference
}

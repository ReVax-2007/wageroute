import { randomUUID } from 'node:crypto'
import { RepositoryError } from '@shared/errors'
import { normalizeSignedCents, signedAmountError } from '@shared/kinds'
import { parseSettings } from '@shared/settings'
import { roundUpRemainderCents, transferLegs } from '@shared/transfers'
import type {
  AccountKind,
  TransactionInput,
  TransactionKind,
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
import { setBillReserveState } from './bills'
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

const TRANSACTION_SELECT = `
  SELECT t.id, t.user_id AS userId, t.account_id AS accountId, t.kind,
         t.amount_cents AS amountCents, t.occurred_on AS occurredOn, t.memo, t.category,
         t.bill_id AS billId, t.goal_id AS goalId, t.paycheck_id AS paycheckId,
         t.counter_account_id AS counterAccountId, t.transfer_group_id AS transferGroupId,
         t.created_at AS createdAt,
         t.updated_at AS updatedAt, t.deleted_at AS deletedAt, t.revision,
         a.name AS accountName, a.institution AS accountInstitution
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

/** How many live entries exist, so a capped grid can say what it is not showing. */
export function transactionCount(db: Db, userId: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS total FROM transactions WHERE user_id = ? AND deleted_at IS NULL`
    )
    .get(userId) as { total: number }
  return row.total
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
        : Math.abs(assertCents(patch.amountCents, 'Amount', { allowNegative: true }))
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

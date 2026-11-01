import { randomUUID } from 'node:crypto'
import { todayISO } from '@shared/dates'
import { RepositoryError } from '@shared/errors'
import type { AccountInput, AccountKind, AccountWithBalance } from '@shared/types'
import {
  assertCents,
  assertOneOf,
  assertSortOrder,
  assertText,
  flagColumn,
  nowISO,
  optionalText,
  requireGoal,
  softDelete,
  updateRow,
  type Db
} from './common'
import { readSettings, writeSettings } from './settings'

const ACCOUNT_KINDS: readonly AccountKind[] = ['checking', 'savings', 'cash', 'investment', 'credit']

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
              ), 0) AS balanceCents,
              a.starting_balance_cents + COALESCE((
                SELECT SUM(t.amount_cents) FROM transactions t
                WHERE t.account_id = a.id AND t.deleted_at IS NULL AND t.occurred_on <= ?
              ), 0) AS cashCents
       FROM accounts a
       WHERE a.user_id = ? AND a.deleted_at IS NULL
       ORDER BY a.is_archived, a.sort_order, a.name`
    )
    .all(todayISO(), userId) as AccountRow[]

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
    assertSortOrder(input.sortOrder),
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
    sort_order:
      patch.sortOrder === undefined ? undefined : assertSortOrder(patch.sortOrder)
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
  const exists = db
    .prepare('SELECT 1 AS present FROM accounts WHERE id = ? AND user_id = ? AND deleted_at IS NULL')
    .get(id, userId)
  if (!exists) throw new RepositoryError('NOT_FOUND', 'Account not found')
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
      'UPDATE bills SET account_id = NULL, updated_at = ?, revision = revision + 1 WHERE account_id = ? AND user_id = ? AND deleted_at IS NULL'
    ).run(ts, id, userId)
    db.prepare(
      'UPDATE goals SET account_id = NULL, updated_at = ?, revision = revision + 1 WHERE account_id = ? AND user_id = ? AND deleted_at IS NULL'
    ).run(ts, id, userId)
    db.prepare(
      'UPDATE paychecks SET deposit_account_id = NULL, updated_at = ?, revision = revision + 1 WHERE deposit_account_id = ? AND user_id = ? AND deleted_at IS NULL'
    ).run(ts, id, userId)
    disableRoundUpAt(db, userId, id)
    softDelete(db, 'accounts', id, userId)
  })()
}

export function setAccountArchived(
  db: Db,
  userId: string,
  id: string,
  archived: boolean
): void {
  db.transaction(() => {
    updateRow(db, 'accounts', id, userId, { is_archived: archived ? 1 : 0 })
    if (archived) disableRoundUpAt(db, userId, id)
  })()
}

// A sweep can only land in a live savings account. Leaving the flag on while
// the destination is gone means restoring or re-adding an account would quietly
// restart sweeps the user never re-enabled.
function disableRoundUpAt(db: Db, userId: string, accountId: string): void {
  const settings = readSettings(db, userId)
  if (settings.roundUpAccountId !== accountId) return
  if (settings.roundUpEnabled === 'false') return
  writeSettings(db, userId, { roundUpEnabled: 'false' })
}

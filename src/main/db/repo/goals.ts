import { randomUUID } from 'node:crypto'
import { RepositoryError } from '@shared/errors'
import type { GoalFundingSource, GoalInput, GoalWithProgress } from '@shared/types'
import {
  assertCents,
  assertDate,
  assertPriority,
  assertText,
  nowISO,
  optionalText,
  requireAccount,
  requireGoal,
  softDelete,
  updateRow,
  type Db
} from './common'

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

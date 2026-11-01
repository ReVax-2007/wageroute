import { randomUUID } from 'node:crypto'
import { buildAllocationPlan } from '@shared/allocator'
import type { CommittedPaycheck } from '@shared/api'
import { todayISO } from '@shared/dates'
import { RepositoryError } from '@shared/errors'
import { parseSettings } from '@shared/settings'
import type {
  Allocation,
  AppliedPlan,
  PayCadence,
  Paycheck,
  PaycheckDraftInput,
  PaycheckWithAllocations,
  PlanHealth,
  PlanMoveTarget
} from '@shared/types'
import {
  assertCents,
  assertDate,
  assertOneOf,
  nowISO,
  optionalText,
  requireAccount,
  type Db
} from './common'
import { listBills, recordBillReserves, reservedBillIdsFor } from './bills'
import { listGoals } from './goals'
import { readSettings } from './settings'
import {
  createTransaction,
  insertTransactionRow,
  listBillPaymentsThisMonth
} from './transactions'

const PAY_CADENCES: readonly PayCadence[] = ['weekly', 'biweekly', 'semimonthly', 'monthly']

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
  /** The draft's own id, so a retry cannot create a second paycheck. */
  id?: string
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function assertDraftId(value: string): string {
  if (!UUID_PATTERN.test(value)) {
    throw new RepositoryError('VALIDATION', 'The draft id is not a UUID')
  }
  return value
}

export function insertPaycheckRecord(
  db: Db,
  userId: string,
  input: PaycheckRecordInput
): string {
  const paycheckId = input.id ?? randomUUID()
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

  // A retried commit returns the paycheck the first attempt wrote. The draft id
  // doubles as the row id, so the unique key itself refuses a second insert.
  const draftId = input.draftId ? assertDraftId(input.draftId) : null
  if (draftId) {
    const existing = db
      .prepare(
        `SELECT id FROM paychecks WHERE id = ? AND user_id = ? AND deleted_at IS NULL`
      )
      .get(draftId, userId)
    if (existing) {
      return { paycheckId: draftId, plan: null, alreadyCommitted: true }
    }
  }

  // A double-click or a re-entry would reserve the wall twice and add phantom
  // income. A second deposit on the same payday is as suspicious as an exact
  // copy, and the same amount a day or two either side is usually a re-entry
  // typed from the wrong date. The renderer asks before passing the flag.
  if (!input.allowDuplicate) {
    const sameDay = db
      .prepare(
        `SELECT id FROM paychecks
         WHERE user_id = ? AND deleted_at IS NULL
           AND deposit_account_id = ? AND received_on = ?`
      )
      .get(userId, depositAccountId, receivedOn)
    if (sameDay) {
      throw new RepositoryError(
        'CONFLICT',
        'A paycheck is already recorded on this date in this account. Confirm the second deposit if both landed.'
      )
    }
    const near = db
      .prepare(
        `SELECT id FROM paychecks
         WHERE user_id = ? AND deleted_at IS NULL
           AND deposit_account_id = ? AND amount_cents = ?
           AND received_on BETWEEN date(?, '-3 days') AND date(?, '+3 days')`
      )
      .get(userId, depositAccountId, incomeCents, receivedOn, receivedOn)
    if (near) {
      throw new RepositoryError(
        'CONFLICT',
        'The same amount was recorded in this account within three days. Check the pay date, or confirm the second deposit if it really is separate.'
      )
    }
  }

  const settings = parseSettings(readSettings(db, userId))
  const cycle = receivedOn.slice(0, 7)
  const paidByBill = new Map(
    listBillPaymentsThisMonth(db, userId, cycle).map((total) => [total.billId, total.paidCents])
  )
  const bills = listBills(db, userId)
    .filter((bill) => bill.isActive)
    .map((bill) => ({ ...bill, paidThisMonthCents: paidByBill.get(bill.id) ?? 0 }))
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
      recordIncome: true,
      id: draftId ?? undefined
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

interface MoveCandidate {
  allocationId: string
  label: string
  amountCents: number
  accountId: string
}

const MOVE_KIND: Partial<Record<Allocation['bucket'], string>> = {
  debt: 'credit',
  savings: 'savings',
  investment: 'investment'
}

/**
 * Turns the allocator's plan into real paired transfers. Routing itself is a
 * plan (ADR 0013); this is the separate, explicit step that moves the money.
 * Every line is validated before anything is written, one transfer group per
 * line carries the paycheck id, and a line that already has one is skipped —
 * so pressing the button twice cannot pay a card twice.
 */
export function applyPaycheckPlan(
  db: Db,
  userId: string,
  paycheckId: string,
  targets: readonly PlanMoveTarget[]
): AppliedPlan {
  const paycheck = db
    .prepare(
      `SELECT deposit_account_id AS depositAccountId
       FROM paychecks WHERE id = ? AND user_id = ? AND deleted_at IS NULL`
    )
    .get(paycheckId, userId) as { depositAccountId: string | null } | undefined
  if (!paycheck) throw new RepositoryError('NOT_FOUND', 'That paycheck no longer exists')
  const depositAccountId = paycheck.depositAccountId
  if (!depositAccountId) {
    throw new RepositoryError('VALIDATION', 'This paycheck has no account to move money from')
  }
  requireAccount(db, userId, depositAccountId)

  const allocations = db
    .prepare(
      `SELECT id, bucket, goal_id AS goalId, label, amount_cents AS amountCents
       FROM allocations
       WHERE paycheck_id = ? AND user_id = ? AND deleted_at IS NULL`
    )
    .all(paycheckId, userId) as {
    id: string
    bucket: Allocation['bucket']
    goalId: string | null
    label: string
    amountCents: number
  }[]
  const byId = new Map(allocations.map((allocation) => [allocation.id, allocation]))

  const candidates: MoveCandidate[] = []
  const seen = new Set<string>()
  for (const target of targets) {
    if (seen.has(target.allocationId)) continue
    seen.add(target.allocationId)
    const allocation = byId.get(target.allocationId)
    if (!allocation) {
      throw new RepositoryError('VALIDATION', 'That plan line no longer exists')
    }
    if (allocation.amountCents <= 0) continue

    const account = db
      .prepare(
        `SELECT kind, is_archived AS isArchived, dedicated_goal_id AS dedicatedGoalId
         FROM accounts WHERE id = ? AND user_id = ? AND deleted_at IS NULL`
      )
      .get(target.accountId, userId) as
      | { kind: string; isArchived: number; dedicatedGoalId: string | null }
      | undefined
    if (!account) throw new RepositoryError('VALIDATION', 'That account no longer exists')
    if (account.isArchived) {
      throw new RepositoryError('VALIDATION', 'Choose an account that is not archived')
    }

    if (allocation.bucket === 'goal') {
      if (!allocation.goalId || account.dedicatedGoalId !== allocation.goalId) {
        throw new RepositoryError(
          'VALIDATION',
          'A goal share can only move into that goal’s own account'
        )
      }
    } else {
      const expected = MOVE_KIND[allocation.bucket]
      if (!expected) {
        throw new RepositoryError('VALIDATION', 'This line has no account to move into')
      }
      if (account.kind !== expected) {
        throw new RepositoryError(
          'VALIDATION',
          `The ${allocation.label} share needs a ${expected} account`
        )
      }
    }

    candidates.push({
      allocationId: allocation.id,
      label: allocation.label,
      amountCents: allocation.amountCents,
      accountId: target.accountId
    })
  }

  // An out-leg is negative and points at the destination, so the pair is
  // recognised by the paycheck it settles, not by a memo or a date.
  const alreadyApplied = db.prepare(
    `SELECT 1 FROM transactions
     WHERE user_id = ? AND deleted_at IS NULL AND paycheck_id = ?
       AND kind = 'transfer' AND account_id = ? AND counter_account_id = ? AND amount_cents = ?`
  )

  const alreadyMoved: string[] = []
  const toMove: MoveCandidate[] = []
  for (const candidate of candidates) {
    const exists = alreadyApplied.get(
      userId,
      paycheckId,
      depositAccountId,
      candidate.accountId,
      -candidate.amountCents
    )
    if (exists) alreadyMoved.push(candidate.label)
    else toMove.push(candidate)
  }

  const movedCents = db.transaction(() => {
    let total = 0
    for (const candidate of toMove) {
      createTransaction(db, userId, {
        accountId: depositAccountId,
        kind: 'transfer',
        amountCents: candidate.amountCents,
        occurredOn: todayISO(),
        memo: `Route: ${candidate.label}`,
        category: 'Transfer',
        counterAccountId: candidate.accountId,
        paycheckId
      })
      total += candidate.amountCents
    }
    return total
  })()

  return { movedCents, transfers: toMove.length, alreadyMoved }
}

/** How many routed checks exist, so the dashboard can admit a capped history. */
export function paycheckCount(db: Db, userId: string): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS total FROM paychecks WHERE user_id = ? AND deleted_at IS NULL`)
    .get(userId) as { total: number }
  return row.total
}

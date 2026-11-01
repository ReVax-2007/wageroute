import { randomUUID } from 'node:crypto'
import { buildAllocationPlan } from '@shared/allocator'
import type { CommittedPaycheck } from '@shared/api'
import { RepositoryError } from '@shared/errors'
import { parseSettings } from '@shared/settings'
import type {
  Allocation,
  PayCadence,
  Paycheck,
  PaycheckDraftInput,
  PaycheckWithAllocations,
  PlanHealth
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
import { insertTransactionRow } from './transactions'

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

/** How many routed checks exist, so the dashboard can admit a capped history. */
export function paycheckCount(db: Db, userId: string): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS total FROM paychecks WHERE user_id = ? AND deleted_at IS NULL`)
    .get(userId) as { total: number }
  return row.total
}

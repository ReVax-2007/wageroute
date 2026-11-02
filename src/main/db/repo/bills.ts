import { randomUUID } from 'node:crypto'
import { monthlyEquivalentCents } from '@shared/cadence'
import type {
  Bill,
  BillFundingStrategy,
  BillInput,
  BillReserve,
  Frequency
} from '@shared/types'
import {
  assertCents,
  assertDate,
  assertDueDay,
  assertOneOf,
  assertPaycheckIndex,
  assertText,
  nowISO,
  optionalText,
  requireAccount,
  softDelete,
  updateRow,
  type Db
} from './common'

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
    assertDueDay(input.dueDay),
    input.category ? assertText(input.category, 'Category', 60) : 'Bills',
    accountId,
    input.autopay ? 1 : 0,
    input.isActive === false ? 0 : 1,
    input.nextDueOn ? assertDate(input.nextDueOn, 'Next due date') : null,
    fundingStrategy,
    assertPaycheckIndex(input.fundingPaycheckIndex),
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
  if (patch.accountId) {
    // A bill whose account was archived after the fact still points at it, and
    // the edit form sends that same id back. Refusing it would trap every other
    // field: the user could not rename the bill without first restoring an
    // account they archived on purpose. Only a new destination is validated.
    const current = db
      .prepare(
        'SELECT account_id AS accountId FROM bills WHERE id = ? AND user_id = ? AND deleted_at IS NULL'
      )
      .get(id, userId) as { accountId: string | null } | undefined
    if (current?.accountId !== patch.accountId) requireAccount(db, userId, patch.accountId)
  }

  updateRow(db, 'bills', id, userId, {
    name: patch.name === undefined ? undefined : assertText(patch.name, 'Bill name'),
    amount_cents:
      patch.amountCents === undefined ? undefined : assertCents(patch.amountCents, 'Bill amount'),
    frequency:
      patch.frequency === undefined
        ? undefined
        : assertOneOf(patch.frequency, FREQUENCIES, 'frequency'),
    due_day:
      patch.dueDay === undefined ? undefined : assertDueDay(patch.dueDay),
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
      patch.fundingPaycheckIndex === undefined
        ? undefined
        : assertPaycheckIndex(patch.fundingPaycheckIndex)
  })
}

export function deleteBill(db: Db, userId: string, id: string): void {
  const ts = nowISO()
  db.transaction(() => {
    softDeleteBillReserves(db, userId, { billId: id })
    // The bill is gone, so a live payment must not keep pointing at its
    // tombstone: the entry stays as an ordinary expense, with its own memo.
    db.prepare(
      `UPDATE transactions
       SET bill_id = NULL, updated_at = ?, revision = revision + 1
       WHERE bill_id = ? AND user_id = ? AND deleted_at IS NULL`
    ).run(ts, id, userId)
    softDelete(db, 'bills', id, userId)
  })()
}

// ------------------------------------------------------------ bill reserves

export function softDeleteBillReserves(
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
              cycle, amount_cents AS amountCents, state, strategy,
              due_day AS dueDay, settled_by AS settledBy,
              created_at AS createdAt, updated_at AS updatedAt,
              deleted_at AS deletedAt, revision
       FROM bill_reserves
       WHERE user_id = ? AND deleted_at IS NULL
       ORDER BY cycle DESC, created_at DESC`
    )
    .all(userId) as BillReserve[]
}

/**
 * The month's open claims, as the plan sees them. A paid claim is already
 * represented by the ledger payment, so including it here would subtract the
 * same money twice.
 */
export function claimsThisMonthFor(
  db: Db,
  userId: string,
  cycle: string
): { billId: string; amountCents: number; strategy: BillFundingStrategy }[] {
  // A claim whose bill or funding cheque was deleted is not money the plan
  // still holds, even if a merge left the row live.
  return db
    .prepare(
      `SELECT r.bill_id AS billId, r.amount_cents AS amountCents, r.strategy
       FROM bill_reserves r
       JOIN bills b ON b.id = r.bill_id AND b.user_id = r.user_id
                   AND b.deleted_at IS NULL
       JOIN paychecks p ON p.id = r.paycheck_id AND p.user_id = r.user_id
                       AND p.deleted_at IS NULL
       WHERE r.user_id = ? AND r.cycle = ? AND r.state = 'reserved'
         AND r.deleted_at IS NULL`
    )
    .all(userId, cycle) as {
    billId: string
    amountCents: number
    strategy: BillFundingStrategy
  }[]
}

export function recordBillReserves(
  db: Db,
  userId: string,
  paycheckId: string,
  cycle: string,
  reserves: readonly { billId: string; reserveCents: number }[]
): void {
  const ts = nowISO()
  const billOf = db.prepare(
    `SELECT funding_strategy AS strategy, due_day AS dueDay,
            amount_cents AS amountCents, frequency
     FROM bills WHERE id = ? AND user_id = ? AND deleted_at IS NULL`
  )
  const claimedOf = db.prepare(
    `SELECT COALESCE(SUM(r.amount_cents), 0) AS total
     FROM bill_reserves r
     JOIN paychecks p ON p.id = r.paycheck_id AND p.user_id = r.user_id
                     AND p.deleted_at IS NULL
     WHERE r.user_id = ? AND r.bill_id = ? AND r.cycle = ? AND r.state = 'reserved'
       AND r.deleted_at IS NULL`
  )
  const insert = db.prepare(
    `INSERT INTO bill_reserves
       (id, user_id, bill_id, paycheck_id, cycle, amount_cents, state, strategy,
        due_day, settled_by, created_at, updated_at, deleted_at, revision)
     VALUES (?, ?, ?, ?, ?, ?, 'reserved', ?, ?, NULL, ?, ?, NULL, 1)`
  )
  for (const reserve of reserves) {
    if (reserve.reserveCents <= 0) continue
    const row = billOf.get(reserve.billId, userId) as
      | {
          strategy: BillFundingStrategy
          dueDay: number
          amountCents: number
          frequency: Frequency
        }
      | undefined
    if (!row) continue
    // A strategy switch can ask the same month to reserve again. The month's
    // open claims may never add up to more than the bill itself, so record only
    // the part no earlier cheque still holds. A claim the month's money already
    // closed no longer blocks cash the plan still owes — a card charge pays the
    // bill without shrinking the pool.
    const claimed = (claimedOf.get(userId, reserve.billId, cycle) as { total: number }).total
    const remaining = monthlyEquivalentCents(row.amountCents, row.frequency) - claimed
    const amountCents = Math.min(reserve.reserveCents, remaining)
    if (amountCents <= 0) continue
    insert.run(
      randomUUID(),
      userId,
      reserve.billId,
      paycheckId,
      cycle,
      amountCents,
      row.strategy,
      row.dueDay,
      ts,
      ts
    )
  }
}

interface ClaimRow {
  id: string
  cycle: string
  amountCents: number
  state: BillReserve['state']
  settledBy: string | null
  dueDay: number
  receivedOn: string
  frequency: Bill['frequency']
}

interface PaymentRow {
  id: string
  occurredOn: string
  amountCents: number
}

/**
 * Derive a bill's claim states from its payments instead of patching them one
 * entry at a time. Two half payments close one claim, a payment already spent
 * on one claim is never offered to another, and deleting or re-dating any
 * payment simply replays the rest.
 *
 * A payment is offered first to the claims of its own cycle whose cheque had
 * already arrived. Money left over falls back to earlier claims that cheque
 * carried: a cheque dated after the bill's due day funds the next occurrence,
 * so a 31 January cheque pays a bill due 1 February. A claim turns paid only
 * when the money offered to it covers it.
 *
 * A bill that is paid a few times a year (quarterly or annual) gathers one
 * claim per cheque, so its single payment has to clear every slice it covers.
 * That leftover skips the due-day gate and walks the earlier claims in order;
 * the cheque had already arrived before the payment, so it was still holding
 * them.
 */
export function reconcileBillReserve(db: Db, userId: string, billId: string): void {
  const claims = db
    .prepare(
      `SELECT r.id, r.cycle, r.amount_cents AS amountCents, r.state,
              r.settled_by AS settledBy, r.due_day AS dueDay,
              p.received_on AS receivedOn, b.frequency
       FROM bill_reserves r
       JOIN bills b ON b.id = r.bill_id AND b.user_id = r.user_id
                   AND b.deleted_at IS NULL
       -- A tombstoned cheque is still the cheque that wrote the claim: a merge
       -- can bring the claim and its payment without resurrecting the row, and
       -- the claim must not stay reserved because the money already left.
       JOIN paychecks p ON p.id = r.paycheck_id AND p.user_id = r.user_id
       WHERE r.user_id = ? AND r.bill_id = ? AND r.deleted_at IS NULL
         AND r.amount_cents > 0
       ORDER BY r.cycle ASC, r.created_at ASC, r.id ASC`
    )
    .all(userId, billId) as ClaimRow[]
  if (claims.length === 0) return

  // Signed, so a refund can take back the money a payment put down. A positive
  // row is never allowed to close a claim by itself.
  const payments = db
    .prepare(
      `SELECT id, occurred_on AS occurredOn, amount_cents AS amountCents
       FROM transactions
       WHERE user_id = ? AND bill_id = ? AND deleted_at IS NULL
         AND kind IN ('bill_payment','expense') AND amount_cents <> 0
       ORDER BY occurred_on ASC, created_at ASC, id ASC`
    )
    .all(userId, billId) as PaymentRow[]

  const offered = new Map<string, { cents: number; settledBy: string | null }>(
    claims.map((claim) => [claim.id, { cents: 0, settledBy: null }])
  )
  const contributions: { claimId: string; cents: number }[] = []
  const smoothed = claims[0].frequency === 'quarterly' || claims[0].frequency === 'annual'
  for (const payment of payments) {
    if (payment.amountCents > 0) {
      // The refund reverses the most recent coverage first: that is the
      // payment it most likely came from.
      let refund = payment.amountCents
      for (let index = contributions.length - 1; index >= 0 && refund > 0; index -= 1) {
        const contribution = contributions[index]
        const take = Math.min(contribution.cents, refund)
        if (take === 0) continue
        contribution.cents -= take
        refund -= take
        const slot = offered.get(contribution.claimId)!
        slot.cents -= take
        slot.settledBy = null
      }
      continue
    }

    const cycle = payment.occurredOn.slice(0, 7)
    const arrived = (claim: ClaimRow) => claim.receivedOn <= payment.occurredOn
    const order = [
      ...claims.filter((claim) => claim.cycle === cycle && arrived(claim)),
      ...claims.filter(
        (claim) =>
          claim.cycle < cycle &&
          arrived(claim) &&
          (smoothed ||
            Number.parseInt(claim.receivedOn.slice(8, 10), 10) > claim.dueDay)
      )
    ]
    let left = -payment.amountCents
    for (const claim of order) {
      if (left <= 0) break
      const slot = offered.get(claim.id)!
      const need = claim.amountCents - slot.cents
      if (need <= 0) continue
      const give = Math.min(need, left)
      slot.cents += give
      left -= give
      contributions.push({ claimId: claim.id, cents: give })
      if (slot.cents === claim.amountCents) slot.settledBy = payment.id
    }
  }

  const ts = nowISO()
  const update = db.prepare(
    `UPDATE bill_reserves
     SET state = ?, settled_by = ?, updated_at = ?, revision = revision + 1
     WHERE id = ? AND user_id = ? AND deleted_at IS NULL`
  )
  for (const claim of claims) {
    const slot = offered.get(claim.id)!
    const paid = slot.cents === claim.amountCents
    const state: BillReserve['state'] = paid ? 'paid' : 'reserved'
    const settledBy = paid ? slot.settledBy : null
    if (claim.state === state && claim.settledBy === settledBy) continue
    update.run(state, settledBy, ts, claim.id, userId)
  }
}

/**
 * The backstop for a ledger this build did not write: every live claim is
 * replayed against the payments that exist, so an imported bill or a restored
 * backup lands on the same state the entry path would have produced.
 */
export function reconcileAllBillReserves(db: Db, userId: string): void {
  const bills = db
    .prepare(
      `SELECT DISTINCT bill_id AS billId
       FROM bill_reserves
       WHERE user_id = ? AND deleted_at IS NULL`
    )
    .all(userId) as { billId: string }[]
  for (const bill of bills) reconcileBillReserve(db, userId, bill.billId)
}


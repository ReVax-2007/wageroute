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
  db.transaction(() => {
    softDeleteBillReserves(db, userId, { billId: id })
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
  return db
    .prepare(
      `SELECT bill_id AS billId, amount_cents AS amountCents, strategy
       FROM bill_reserves
       WHERE user_id = ? AND cycle = ? AND state = 'reserved' AND deleted_at IS NULL`
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
     FROM bills WHERE id = ? AND user_id = ?`
  )
  const claimedOf = db.prepare(
    `SELECT COALESCE(SUM(amount_cents), 0) AS total
     FROM bill_reserves
     WHERE user_id = ? AND bill_id = ? AND cycle = ? AND state = 'reserved'
       AND deleted_at IS NULL`
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
  amountCents: number
}

/**
 * Close the claims this money fully covers, oldest first, and return what is
 * left. A claim is never part-paid: a payment smaller than the next claim
 * leaves that claim open, so the wall keeps reserving money still owed.
 */
function closeCoveredClaims(
  db: Db,
  userId: string,
  transactionId: string,
  claims: readonly ClaimRow[],
  amountCents: number
): number {
  const close = db.prepare(
    `UPDATE bill_reserves
     SET state = 'paid', settled_by = ?, updated_at = ?, revision = revision + 1
     WHERE id = ? AND user_id = ? AND state = 'reserved' AND deleted_at IS NULL`
  )
  const ts = nowISO()
  let left = Math.max(0, Math.round(amountCents))
  for (const claim of claims) {
    if (claim.amountCents <= 0 || claim.amountCents > left) break
    close.run(transactionId, ts, claim.id, userId)
    left -= claim.amountCents
  }
  return left
}

/**
 * A claim is closed by the money that pays it. The payment's own month wins
 * when its cheque was already received; a payment dated before that cheque
 * cannot have spent it, so any money left falls back to earlier claims.
 *
 * An earlier claim is only eligible when its cheque came *after* the bill's
 * due day in its own cycle. That is the carry: a 31 January cheque funds a bill
 * due on 1 February, because the next occurrence after the cheque is February's.
 * A mid-month cheque funds its own month, so a later payment is paying that
 * month late, not carrying it — the month stays owed until a payment is dated
 * inside it.
 */
export function settleBillReserveForPayment(
  db: Db,
  userId: string,
  billId: string,
  transactionId: string,
  occurredOn: string,
  amountCents: number
): void {
  const cycle = occurredOn.slice(0, 7)
  const sameCycle = db
    .prepare(
      `SELECT r.id, r.amount_cents AS amountCents
       FROM bill_reserves r
       JOIN paychecks p ON p.id = r.paycheck_id AND p.user_id = r.user_id
                       AND p.deleted_at IS NULL
       WHERE r.user_id = ? AND r.bill_id = ? AND r.cycle = ?
         AND r.state = 'reserved' AND r.deleted_at IS NULL
         AND p.received_on <= ?
       ORDER BY r.created_at ASC, r.id ASC`
    )
    .all(userId, billId, cycle, occurredOn) as ClaimRow[]
  const left = closeCoveredClaims(db, userId, transactionId, sameCycle, amountCents)
  if (left > 0) settleEarlierBillReserve(db, userId, cycle, billId, transactionId, left)
}

function settleEarlierBillReserve(
  db: Db,
  userId: string,
  cycle: string,
  billId: string,
  transactionId: string,
  amountCents: number
): void {
  const claims = db
    .prepare(
      `SELECT r.id, r.amount_cents AS amountCents
       FROM bill_reserves r
       JOIN paychecks p ON p.id = r.paycheck_id AND p.user_id = r.user_id
                       AND p.deleted_at IS NULL
       WHERE r.user_id = ? AND r.bill_id = ? AND r.cycle < ?
         AND r.state = 'reserved' AND r.deleted_at IS NULL
         AND CAST(substr(p.received_on, 9, 2) AS INTEGER) > r.due_day
       ORDER BY r.cycle ASC, r.created_at ASC, r.id ASC`
    )
    .all(userId, billId, cycle) as ClaimRow[]
  closeCoveredClaims(db, userId, transactionId, claims, amountCents)
}

/** Undo exactly what a payment closed, so a delete or move re-opens it. */
export function reopenBillReservesSettledBy(
  db: Db,
  userId: string,
  transactionId: string
): void {
  const ts = nowISO()
  db.prepare(
    `UPDATE bill_reserves
     SET state = 'reserved', settled_by = NULL, updated_at = ?, revision = revision + 1
     WHERE user_id = ? AND settled_by = ? AND deleted_at IS NULL`
  ).run(ts, userId, transactionId)
}

/**
 * Re-open a month's claim without a link to the payment that closed it. Rows
 * paid before v9 have no `settled_by`, so moving or deleting their payment
 * still has to find the claim by the date it left: a same-cycle row first,
 * then the carried claim the old settlement rule picked.
 */
export function reopenCycleClaim(
  db: Db,
  userId: string,
  billId: string,
  occurredOn: string
): void {
  const ts = nowISO()
  const cycle = occurredOn.slice(0, 7)
  const reopened = db
    .prepare(
      `UPDATE bill_reserves
       SET state = 'reserved', settled_by = NULL, updated_at = ?, revision = revision + 1
       WHERE user_id = ? AND bill_id = ? AND cycle = ? AND deleted_at IS NULL
         AND state = 'paid' AND settled_by IS NULL`
    )
    .run(ts, userId, billId, cycle)
  if (reopened.changes > 0) return

  db.prepare(
    `UPDATE bill_reserves
     SET state = 'reserved', settled_by = NULL, updated_at = ?, revision = revision + 1
     WHERE id = (
       SELECT r.id FROM bill_reserves r
       JOIN paychecks p ON p.id = r.paycheck_id AND p.user_id = r.user_id
                       AND p.deleted_at IS NULL
       WHERE r.user_id = ? AND r.bill_id = ? AND r.cycle < ?
         AND r.state = 'paid' AND r.settled_by IS NULL AND r.deleted_at IS NULL
         AND CAST(substr(p.received_on, 9, 2) AS INTEGER) > r.due_day
       ORDER BY r.cycle ASC, r.created_at ASC, r.id ASC
       LIMIT 1
     )`
  ).run(ts, userId, billId, cycle)
}

/**
 * The backstop for a ledger this build did not write: an imported payment
 * never ran {@link settleBillReserveForPayment}, so the next cheque closes the
 * carry it left open and names the latest payment for the bill in this cycle.
 */
export function settleEarlierBillReserves(
  db: Db,
  userId: string,
  cycle: string,
  payments: readonly { billId: string; transactionId: string; amountCents: number }[]
): void {
  // A payment closes a claim, once. Re-using a payment that already settled
  // something would close a second month with money that only left once.
  const alreadySettled = db.prepare(
    `SELECT 1 AS found FROM bill_reserves
     WHERE user_id = ? AND settled_by = ? AND deleted_at IS NULL`
  )
  for (const payment of payments) {
    if (alreadySettled.get(userId, payment.transactionId)) continue
    settleEarlierBillReserve(
      db,
      userId,
      cycle,
      payment.billId,
      payment.transactionId,
      payment.amountCents
    )
  }
}


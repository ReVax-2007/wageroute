import { randomUUID } from 'node:crypto'
import { monthlyEquivalentCents } from '@shared/cadence'
import { deriveClaimStates, type ClaimFact, type PaymentFact } from '@shared/claims'
import type {
  Bill,
  BillFundingStrategy,
  BillInput,
  BillReserve,
  Frequency
} from '@shared/types'
import { BILL_FUNDING_STRATEGIES, FREQUENCIES } from '@shared/writeRules'
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

type BillRow = Omit<Bill, 'autopay' | 'isActive' | 'isVariable'> & {
  autopay: number
  isActive: number
  isVariable: number
}

function mapBill(row: BillRow): Bill {
  return {
    ...row,
    autopay: row.autopay === 1,
    isActive: row.isActive === 1,
    isVariable: row.isVariable === 1
  }
}

const BILL_SELECT = `
  SELECT id, user_id AS userId, name, amount_cents AS amountCents, frequency,
         due_day AS dueDay, category, account_id AS accountId, autopay,
         is_active AS isActive, next_due_on AS nextDueOn,
         funding_strategy AS fundingStrategy,
         funding_paycheck_index AS fundingPaycheckIndex,
         is_variable AS isVariable,
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
        is_variable, created_at, updated_at, deleted_at, revision)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1)`
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
    input.isVariable ? 1 : 0,
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
    is_variable: patch.isVariable === undefined ? undefined : patch.isVariable ? 1 : 0,
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
       SET bill_id = NULL,
           kind = CASE WHEN kind = 'bill_payment' THEN 'expense' ELSE kind END,
           updated_at = ?, revision = revision + 1
       WHERE bill_id = ? AND user_id = ? AND deleted_at IS NULL`
    ).run(ts, id, userId)
    softDelete(db, 'bills', id, userId)
  })()
}

/**
 * What a delete of this bill would do to the rows around it, read before the
 * write so the confirmation can name them: the set-asides that go with the bill,
 * and the ledger rows that stay but stop proving it. `deleteBill` releases every
 * live row linked to the bill, adjustments included, so the same filter counts
 * both numbers.
 */
export function billDeletionSummary(
  db: Db,
  userId: string,
  billId: string
): { reserves: number; linkedEntries: number } {
  const total = (sql: string): number =>
    (db.prepare(sql).get(billId, userId) as { total: number }).total
  return {
    reserves: total(
      'SELECT COUNT(*) AS total FROM bill_reserves WHERE bill_id = ? AND user_id = ? AND deleted_at IS NULL'
    ),
    linkedEntries: total(
      'SELECT COUNT(*) AS total FROM transactions WHERE bill_id = ? AND user_id = ? AND deleted_at IS NULL'
    )
  }
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

/**
 * Derive a bill's claim states from its payments instead of patching them one
 * entry at a time. The walk itself is in `@shared/claims`, where the phone reads
 * the same copy of the rule — see ADR 0028.
 */
export function reconcileBillReserve(db: Db, userId: string, billId: string): void {
  const claims = db
    .prepare(
      `SELECT r.id, r.cycle, r.amount_cents AS amountCents, r.state,
              r.settled_by AS settledBy, r.due_day AS dueDay,
              p.received_on AS receivedOn, r.created_at AS createdAt, b.frequency
       FROM bill_reserves r
       JOIN bills b ON b.id = r.bill_id AND b.user_id = r.user_id
                   AND b.deleted_at IS NULL
       -- A tombstoned cheque is still the cheque that wrote the claim: a merge
       -- can bring the claim and its payment without resurrecting the row, and
       -- the claim must not stay reserved because the money already left.
       JOIN paychecks p ON p.id = r.paycheck_id AND p.user_id = r.user_id
       WHERE r.user_id = ? AND r.bill_id = ? AND r.deleted_at IS NULL
         AND r.amount_cents > 0`
    )
    .all(userId, billId) as ClaimFact[]
  if (claims.length === 0) return

  // Signed, so a refund can take back the money a payment put down. A positive
  // row is never allowed to close a claim by itself.
  const payments = db
    .prepare(
      `SELECT id, occurred_on AS occurredOn, amount_cents AS amountCents,
              created_at AS createdAt
       FROM transactions
       WHERE user_id = ? AND bill_id = ? AND deleted_at IS NULL
         AND kind IN ('bill_payment','expense') AND amount_cents <> 0`
    )
    .all(userId, billId) as PaymentFact[]

  const bill = db
    .prepare(
      `SELECT amount_cents AS amountCents, is_variable AS isVariable
       FROM bills WHERE id = ? AND user_id = ?`
    )
    .get(billId, userId) as { amountCents: number; isVariable: number }
  const derived = deriveClaimStates(claims, payments, {
    amountCents: bill.amountCents,
    isVariable: bill.isVariable === 1
  })
  const ts = nowISO()
  const update = db.prepare(
    `UPDATE bill_reserves
     SET state = ?, settled_by = ?, updated_at = ?, revision = revision + 1
     WHERE id = ? AND user_id = ? AND deleted_at IS NULL`
  )
  for (const claim of derived) {
    if (!claim.changed) continue
    update.run(claim.state, claim.settledBy, ts, claim.id, userId)
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


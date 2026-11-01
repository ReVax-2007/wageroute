import { randomUUID } from 'node:crypto'
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
              cycle, amount_cents AS amountCents, state,
              created_at AS createdAt, updated_at AS updatedAt,
              deleted_at AS deletedAt, revision
       FROM bill_reserves
       WHERE user_id = ? AND deleted_at IS NULL
       ORDER BY cycle DESC, created_at DESC`
    )
    .all(userId) as BillReserve[]
}

/**
 * Single-check bills an earlier cheque in this cycle already carried. A second
 * cheque in the same month must route its surplus, not reserve the same bills
 * again. `all_checks` bills are spread deliberately and are not deduplicated.
 */
export function reservedBillIdsFor(db: Db, userId: string, cycle: string): string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT r.bill_id AS id
       FROM bill_reserves r
       JOIN bills b ON b.id = r.bill_id
       WHERE r.user_id = ? AND r.cycle = ? AND r.deleted_at IS NULL
         AND b.funding_strategy <> 'all_checks'`
    )
    .all(userId, cycle) as { id: string }[]
  return rows.map((row) => row.id)
}

export function recordBillReserves(
  db: Db,
  userId: string,
  paycheckId: string,
  cycle: string,
  reserves: readonly { billId: string; reserveCents: number }[]
): void {
  const ts = nowISO()
  const insert = db.prepare(
    `INSERT INTO bill_reserves
       (id, user_id, bill_id, paycheck_id, cycle, amount_cents, state,
        created_at, updated_at, deleted_at, revision)
     VALUES (?, ?, ?, ?, ?, ?, 'reserved', ?, ?, NULL, 1)`
  )
  for (const reserve of reserves) {
    if (reserve.reserveCents <= 0) continue
    insert.run(
      randomUUID(),
      userId,
      reserve.billId,
      paycheckId,
      cycle,
      reserve.reserveCents,
      ts,
      ts
    )
  }
}

export function setBillReserveState(
  db: Db,
  userId: string,
  billId: string,
  occurredOn: string,
  state: BillReserve['state']
): void {
  const ts = nowISO()
  db.prepare(
    `UPDATE bill_reserves
     SET state = ?, updated_at = ?, revision = revision + 1
     WHERE user_id = ? AND bill_id = ? AND cycle = ? AND deleted_at IS NULL AND state <> ?`
  ).run(state, ts, userId, billId, occurredOn.slice(0, 7), state)
}

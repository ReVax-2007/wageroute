import assert from 'node:assert/strict'
import Database from 'better-sqlite3-multiple-ciphers'
import test from 'node:test'
import { todayISO } from '@shared/dates'
import type { ImportTables } from '@shared/importRepair'
import { buildBackup, mergeBackup } from '../../main/db/backup'
import { migrate } from '../../main/db/migrations'
import { createTransaction, deleteTransaction } from '../../main/db/repo/transactions'
import { seedDemoIfEmpty } from '../../main/db/seed'
import { parseBackup } from './backup'
import { cents, nullableText, text } from './rows'
import { createEntry, deleteEntries } from './write'

/**
 * The same money fact, typed on each device.
 *
 * The computer's wall and the phone's bill list both read a claim's state from
 * the payments in front of them, through one shared walk (ADR 0028). These tests
 * drive the real repository on one side and the real writer on the other, over a
 * ledger exported from the first, and compare what each device wrote back.
 */

const BILL = 'bill-parity'
const CHEQUE = 'cheque-parity'
const CLAIM = 'claim-parity'

interface Pair {
  db: Database.Database
  userId: string
  checking: string
  tables: ImportTables
}

/** A seeded computer, one controlled monthly bill holding a $120 claim, and the phone's copy of it. */
function pair(): Pair {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  migrate(db)
  const userId = seedDemoIfEmpty(db)
  const today = todayISO()
  const cycle = today.slice(0, 7)
  const { id: checking } = db
    .prepare(
      `SELECT id FROM accounts
       WHERE user_id = ? AND kind = 'checking' AND deleted_at IS NULL
       ORDER BY id LIMIT 1`
    )
    .get(userId) as { id: string }
  const stamp = `${today}T09:00:00.000Z`

  db.prepare(
    `INSERT INTO bills
       (id, user_id, name, amount_cents, frequency, due_day, category, account_id,
        autopay, is_active, next_due_on, funding_strategy, funding_paycheck_index,
        created_at, updated_at, deleted_at, revision)
     VALUES (?, ?, 'Parity Rent', 120000, 'monthly', 1, 'Bills', ?, 0, 1, ?, 'all_checks', NULL, ?, ?, NULL, 1)`
  ).run(BILL, userId, checking, today, stamp, stamp)
  db.prepare(
    `INSERT INTO paychecks
       (id, user_id, amount_cents, received_on, source, deposit_account_id,
        priority_cents, surplus_cents, leisure_cents, health,
        created_at, updated_at, deleted_at, revision)
     VALUES (?, ?, 320000, ?, 'Paycheck', ?, 0, 0, 0, 'covered', ?, ?, NULL, 1)`
  ).run(CHEQUE, userId, `${cycle}-01`, checking, stamp, stamp)
  db.prepare(
    `INSERT INTO bill_reserves
       (id, user_id, bill_id, paycheck_id, cycle, amount_cents, state,
        strategy, due_day, settled_by, created_at, updated_at, deleted_at, revision)
     VALUES (?, ?, ?, ?, ?, 120000, 'reserved', 'all_checks', 1, NULL, ?, ?, NULL, 1)`
  ).run(CLAIM, userId, BILL, CHEQUE, cycle, stamp, stamp)

  return { db, userId, checking, tables: parseBackup(JSON.stringify(buildBackup(db, userId))).tables }
}

/** The desktop's own words for the same payment the phone is about to type. */
function paymentInput(checking: string, occurredOn: string, amountCents: number) {
  return {
    accountId: checking,
    kind: 'bill_payment' as const,
    amountCents,
    occurredOn,
    memo: 'Parity Rent',
    category: 'Bills',
    billId: BILL
  }
}

function desktopClaim(db: Database.Database): { state: string; settledBy: string | null; revision: number } {
  return db
    .prepare(
      `SELECT state, settled_by AS settledBy, revision FROM bill_reserves WHERE id = ?`
    )
    .get(CLAIM) as { state: string; settledBy: string | null; revision: number }
}

function phoneClaim(tables: ImportTables): { state: string; settledBy: string | null; revision: number } {
  const row = tables.bill_reserves.find((candidate) => text(candidate, 'id') === CLAIM)!
  return {
    state: text(row, 'state'),
    settledBy: nullableText(row, 'settled_by'),
    revision: cents(row, 'revision')
  }
}

test('a payment typed on the phone settles the same claim the computer settles', () => {
  const { db, userId, checking, tables } = pair()
  const today = todayISO()

  const onDesktop = createTransaction(db, userId, paymentInput(checking, today, -120_000))
  const onPhone = createEntry(tables, paymentInput(checking, today, -120_000))

  const desktop = desktopClaim(db)
  const pocket = phoneClaim(onPhone.tables)
  assert.equal(desktop.state, 'paid', 'the computer closes the claim it was holding')
  assert.deepEqual(pocket, { state: 'paid', settledBy: onPhone.id, revision: desktop.revision })
  assert.equal(desktop.settledBy, onDesktop, 'each device names its own payment as the one that settled it')
})

test('deleting that payment on the phone reopens the claim the computer reopens', () => {
  const { db, userId, checking, tables } = pair()
  const today = todayISO()

  const onDesktop = createTransaction(db, userId, paymentInput(checking, today, -120_000))
  const onPhone = createEntry(tables, paymentInput(checking, today, -120_000))
  deleteTransaction(db, userId, onDesktop)
  const removed = deleteEntries(onPhone.tables, [onPhone.id])

  const desktop = desktopClaim(db)
  assert.equal(desktop.state, 'reserved', 'a bill is not paid by a row that left the ledger')
  assert.equal(desktop.settledBy, null)
  assert.deepEqual(phoneClaim(removed.tables), desktop)
})

test('a part payment holds the claim open on both devices and rewrites it on neither', () => {
  const { db, userId, checking, tables } = pair()
  const today = todayISO()

  createTransaction(db, userId, paymentInput(checking, today, -40_000))
  const onPhone = createEntry(tables, paymentInput(checking, today, -40_000))

  const desktop = desktopClaim(db)
  assert.deepEqual(desktop, { state: 'reserved', settledBy: null, revision: 1 })
  assert.deepEqual(phoneClaim(onPhone.tables), desktop)
})

test('a phone payment reaches the computer as an ordinary row and settles there too', () => {
  const { db, userId, checking, tables } = pair()
  const written = createEntry(tables, paymentInput(checking, todayISO(), -120_000))

  // What the phone would export after this write, opened back on the computer
  // that made the claim: the file needs no special case, because the payment is
  // a row like any other and the import replays every claim anyway.
  mergeBackup(db, userId, { ...buildBackup(db, userId), tables: written.tables })

  const settled = db
    .prepare('SELECT state, settled_by AS settledBy FROM bill_reserves WHERE id = ?')
    .get(CLAIM) as { state: string; settledBy: string | null }
  assert.equal(settled.state, 'paid', 'the computer agrees the claim is closed')
  assert.equal(settled.settledBy, written.id, "and it is the phone's payment that closed it")
  const posted = db
    .prepare('SELECT COUNT(*) AS n FROM transactions WHERE bill_id = ? AND deleted_at IS NULL')
    .get(BILL) as { n: number }
  assert.equal(posted.n, 1, 'the payment arrived as one ordinary row')
})

/** The month before the one being typed into, so a claim in it is a carried one. */
function previousCycle(today: string): string {
  const [year, month] = today.split('-').map(Number)
  const first = new Date(Date.UTC(year, month - 2, 1))
  return `${first.getUTCFullYear()}-${String(first.getUTCMonth() + 1).padStart(2, '0')}`
}

/**
 * One bill holding a single claim from last month, written by a cheque that
 * landed on `chequeDay`, and the phone's copy of that ledger.
 *
 * Which claims a payment may reach is decided by the due-day gate in
 * `@shared/claims`: a carried claim is open to it only when the cheque that
 * wrote it arrived after the bill's due day. `keyless` is the released desktop's
 * shape — v1.2.0 stops at schema 8, where a claim row carries no `due_day` key
 * at all — and a backup file is the only ledger the phone ever holds, so the
 * gate has to be decided from what the file can say.
 */
function carried(dueDay: number, chequeDay: number, keyless = false): Pair {
  const { db, userId, checking } = pair()
  const today = todayISO()
  const cycle = previousCycle(today)
  const stamp = `${today}T09:00:00.000Z`
  const receivedOn = `${cycle}-${String(chequeDay).padStart(2, '0')}`
  db.prepare(`UPDATE bills SET due_day = ? WHERE id = ?`).run(dueDay, BILL)
  db.prepare(`UPDATE paychecks SET received_on = ? WHERE id = ?`).run(receivedOn, CHEQUE)
  db.prepare(`UPDATE bill_reserves SET cycle = ?, due_day = ? WHERE id = ?`).run(cycle, dueDay, CLAIM)

  const payload = JSON.parse(JSON.stringify(buildBackup(db, userId))) as {
    tables: { bill_reserves: Record<string, unknown>[] }
  }
  if (keyless) for (const row of payload.tables.bill_reserves) delete row.due_day
  return { db, userId, checking, tables: parseBackup(JSON.stringify(payload)).tables }
}

test('a carried claim a released desktop never stamped still waits for its cheque', () => {
  // Bill due on the 1st, cheque on the 1st: the money was put aside for this
  // month's rent, not last month's, so a payment today settles nothing anywhere.
  const { db, userId, checking, tables } = carried(1, 1, true)
  createTransaction(db, userId, paymentInput(checking, todayISO(), -120_000))
  const onPhone = createEntry(tables, paymentInput(checking, todayISO(), -120_000))

  const desktop = desktopClaim(db)
  assert.deepEqual(desktop, { state: 'reserved', settledBy: null, revision: 1 })
  assert.deepEqual(phoneClaim(onPhone.tables), desktop, 'the phone holds it open too')
})

test('a carried claim from a keyless file settles on the phone exactly when the computer settles it', () => {
  // Bill due on the 15th, cheque on the 20th: the cheque arrived after the bill
  // was due, so it was holding last month and this payment reaches it.
  const { db, userId, checking, tables } = carried(15, 20, true)
  createTransaction(db, userId, paymentInput(checking, todayISO(), -120_000))
  const onPhone = createEntry(tables, paymentInput(checking, todayISO(), -120_000))

  const desktop = desktopClaim(db)
  assert.equal(desktop.state, 'paid', 'the computer closes the claim its due day allows')
  assert.deepEqual(phoneClaim(onPhone.tables), {
    state: 'paid',
    settledBy: onPhone.id,
    revision: desktop.revision
  })
})

test('a file that repeats a claim row does not let one payment settle it twice', () => {
  const { db, userId, checking, tables } = carried(15, 20, true)
  const claim = tables.bill_reserves.find((row) => text(row, 'id') === CLAIM)!
  // Hand-edited: the same id carrying two amounts. On the computer the primary
  // key makes that one row, and the merge keeps the first unless a later row is
  // strictly newer, so $120 is still owed and half a payment cannot close it.
  tables.bill_reserves.push({ ...claim, amount_cents: 60_000 })

  createTransaction(db, userId, paymentInput(checking, todayISO(), -60_000))
  const onPhone = createEntry(tables, paymentInput(checking, todayISO(), -60_000))

  const desktop = desktopClaim(db)
  assert.deepEqual(desktop, { state: 'reserved', settledBy: null, revision: 1 })
  assert.deepEqual(phoneClaim(onPhone.tables), desktop, 'the phone reads one promise, not two')
})

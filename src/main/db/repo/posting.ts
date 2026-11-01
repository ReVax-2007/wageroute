import { dueBillPrompts } from '@shared/billPrompts'
import { todayISO } from '@shared/dates'
import { parseSettings } from '@shared/settings'
import type { Bill } from '@shared/types'
import { listBills, setBillReserveState } from './bills'
import type { Db } from './common'
import { readSettings } from './settings'
import { insertTransactionRow } from './transactions'

export interface AutopayResult {
  posted: number
  /** Autopay bills that are due but have no usable account or no account at all. */
  skipped: number
}

/**
 * Executes the bills the user marked autopay. This runs on launch, after the
 * database is open and before any screen reads it, so a bill that came due
 * while the app was closed is paid once — the payment itself is what tells the
 * chronology engine the bill is settled, which is why a second launch posts
 * nothing. A bill with no account (neither its own nor a default deposit) is
 * skipped rather than guessed at; the wall surfaces it for the user to fix.
 */
export function postDueAutopay(
  db: Db,
  userId: string,
  today: string = todayISO()
): AutopayResult {
  const bills = listBills(db, userId).filter((bill) => bill.isActive && bill.autopay)
  if (bills.length === 0) return { posted: 0, skipped: 0 }

  const payments = db
    .prepare(
      `SELECT bill_id AS billId, occurred_on AS occurredOn, amount_cents AS amountCents
       FROM transactions
       WHERE user_id = ? AND deleted_at IS NULL AND bill_id IS NOT NULL`
    )
    .all(userId) as { billId: string; occurredOn: string; amountCents: number }[]

  const prompts = dueBillPrompts({
    bills: bills.map((bill) => ({
      id: bill.id,
      name: bill.name,
      amountCents: bill.amountCents,
      frequency: bill.frequency,
      dueDay: bill.dueDay,
      nextDueOn: bill.nextDueOn,
      category: bill.category,
      accountId: bill.accountId,
      isActive: bill.isActive,
      autopay: bill.autopay
    })),
    payments,
    todayISO: today
  })
  if (prompts.length === 0) return { posted: 0, skipped: 0 }

  const settings = parseSettings(readSettings(db, userId))
  const billById = new Map(bills.map((bill) => [bill.id, bill]))
  const accountExists = db.prepare(
    'SELECT 1 AS present FROM accounts WHERE id = ? AND user_id = ? AND deleted_at IS NULL AND is_archived = 0'
  )

  let posted = 0
  let skipped = 0
  db.transaction(() => {
    for (const prompt of prompts) {
      const bill = billById.get(prompt.billId) as Bill | undefined
      if (!bill) continue
      const accountId = bill.accountId ?? settings.defaultDepositAccountId
      if (!accountId || !accountExists.get(accountId, userId)) {
        skipped += 1
        continue
      }
      // A part payment already in the ledger counts, exactly as the prompt card
      // counts it; posting the full bill again would double-charge the cycle.
      const remaining = prompt.amountCents - prompt.paidCents
      if (remaining <= 0) continue
      insertTransactionRow(db, userId, {
        accountId,
        kind: 'bill_payment',
        amountCents: -Math.abs(remaining),
        occurredOn: prompt.dueOn,
        memo: `${bill.name} · autopay`,
        category: bill.category,
        billId: bill.id
      })
      setBillReserveState(db, userId, bill.id, prompt.dueOn, 'paid')
      posted += 1
    }
  })()
  return { posted, skipped }
}

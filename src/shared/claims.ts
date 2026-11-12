import type { BillReserveState, Frequency } from './types'
import { creditedPaymentCents, type CreditableBill } from './variableBills'

/**
 * The rule that decides whether a bill's set-aside has been spent.
 *
 * A claim is a promise a paycheck made: *this month is holding this much for this
 * bill*. Whether the promise has been kept is not something either device can
 * remember — it follows from the payments the ledger holds, so it is derived from
 * them instead of carried along. Both the computer and the phone replay the same
 * walk through this module, so the screen you type into reads the bill paid the
 * moment the payment lands, and the other reads the same answer as soon as that
 * payment row travels to it in a backup.
 *
 * The walk itself is deliberately stateless: rows, not databases, in and out. A
 * claim row the app cannot see is a claim row it must not mark, so each caller
 * hands over only rows its own storage could have written — the computer through
 * `amount_cents > 0` in its read, the phone through the same test and through
 * leaving any claim whose facts are not there to read. A zero-amount claim would
 * read as covered by no money at all, and one with a coerced `0` due day would
 * open the gate below.
 */

/** One set-aside, with the facts the walk needs about it and the cheque that wrote it. */
export interface ClaimFact {
  id: string
  /** `YYYY-MM` — the month this claim holds money for. */
  cycle: string
  amountCents: number
  /** What the ledger last recorded, used only to tell a real change from a no-op. */
  state: BillReserveState
  settledBy: string | null
  dueDay: number
  /** The date the cheque that wrote this claim was received. */
  receivedOn: string
  createdAt: string
  frequency: Frequency
}

/** One entry recorded against a bill. Negative spends, positive gives the money back. */
export interface PaymentFact {
  id: string
  occurredOn: string
  amountCents: number
  createdAt: string
}

export interface ClaimOutcome {
  id: string
  state: BillReserveState
  settledBy: string | null
  /** False when the stored row already says exactly this, so a caller can leave it alone. */
  changed: boolean
}

/** SQLite's default BINARY collation: code units, never locale. */
function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * Derive every claim's state from the payments that exist.
 *
 * Two half payments close one claim, and money already offered to a claim is
 * never offered to another. A payment goes first to the claims of its own cycle
 * whose cheque had already arrived; what is left falls back to earlier claims
 * that cheque carried, because a cheque dated after the bill's due day funds the
 * next occurrence — a 31 January cheque pays a bill due 1 February. A claim
 * turns paid only when the money offered to it covers it, so deleting or
 * re-dating any payment replays the rest and reopens what no longer holds.
 *
 * A bill paid a few times a year (quarterly or annual) gathers one claim per
 * cheque, so its single payment has to clear every slice it covers. That leftover
 * skips the due-day gate and walks the earlier claims in order: the cheque had
 * already arrived before the payment, so it was still holding them.
 *
 * Callers must hand over the claims of one bill and the entries recorded against
 * it — a payment for one bill never settles another's promise.
 *
 * Pass the bill itself when it may be variable: each payment is then offered at
 * least the estimate (ADR 0036), so a $51 payment closes a $70 claim instead of
 * leaving $19 reserved for a bill that has already cleared.
 */
export function deriveClaimStates(
  claims: readonly ClaimFact[],
  payments: readonly PaymentFact[],
  bill?: CreditableBill
): ClaimOutcome[] {
  // Ordered here rather than by each caller's query so neither device can settle
  // a different claim first: cycle, then the row's own creation, then its id.
  const ordered = [...claims].sort(
    (a, b) =>
      byCodeUnit(a.cycle, b.cycle) ||
      byCodeUnit(a.createdAt, b.createdAt) ||
      byCodeUnit(a.id, b.id)
  )
  const received = payments
    .map((payment) =>
      bill ? { ...payment, amountCents: creditedPaymentCents(bill, payment.amountCents) } : payment
    )
    .sort(
    (a, b) =>
      byCodeUnit(a.occurredOn, b.occurredOn) ||
      byCodeUnit(a.createdAt, b.createdAt) ||
      byCodeUnit(a.id, b.id)
  )
  if (ordered.length === 0) return []

  const offered = new Map<string, { cents: number; settledBy: string | null }>(
    ordered.map((claim) => [claim.id, { cents: 0, settledBy: null }])
  )
  const contributions: { claimId: string; cents: number }[] = []
  const smoothed = ordered[0].frequency === 'quarterly' || ordered[0].frequency === 'annual'

  for (const payment of received) {
    if (payment.amountCents > 0) {
      // A refund reverses the most recent coverage first: that is the payment it
      // most likely came from.
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
    const arrived = (claim: ClaimFact) => claim.receivedOn <= payment.occurredOn
    const order = [
      ...ordered.filter((claim) => claim.cycle === cycle && arrived(claim)),
      ...ordered.filter(
        (claim) =>
          claim.cycle < cycle &&
          arrived(claim) &&
          (smoothed || Number.parseInt(claim.receivedOn.slice(8, 10), 10) > claim.dueDay)
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

  return ordered.map((claim) => {
    const slot = offered.get(claim.id)!
    const paid = slot.cents === claim.amountCents
    const state: BillReserveState = paid ? 'paid' : 'reserved'
    const settledBy = paid ? slot.settledBy : null
    return { id: claim.id, state, settledBy, changed: claim.state !== state || claim.settledBy !== settledBy }
  })
}

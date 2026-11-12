/**
 * Variable bills: a bill whose amount is an estimate (ADR 0036).
 *
 * Gas, groceries-as-a-bill, a utility that moves with the weather: the paycheck
 * still sets the estimate aside, but the payment that clears it is whatever the
 * bill turned out to be. One payment against a variable bill settles the
 * occurrence it was made for, so a $51 payment clears a $70 gas bill and the
 * $19 nobody spent stops being held. A payment above the estimate is simply
 * what it was: the ledger shows the extra leaving.
 *
 * The whole rule is one function, applied to each ledger row before anything
 * sums it, so every reader that turns payments into "paid" — the bill prompt,
 * the month's paid totals on both devices, the claim walk, autopay — gives the
 * same answer. A fixed bill passes every row through unchanged.
 */

export interface CreditableBill {
  amountCents: number
  isVariable: boolean
}

/**
 * The signed amount a ledger row counts for when the bill asks "how much of me
 * is paid?". Money out is negative. A spend on a variable bill counts as at
 * least the estimate; a refund (positive) and every row on a fixed bill count as
 * they are, so a refund takes back what it returned and no more.
 */
export function creditedPaymentCents(bill: CreditableBill, signedCents: number): number {
  if (!bill.isVariable || signedCents >= 0) return signedCents
  return -Math.max(-signedCents, bill.amountCents)
}

/** How a cleared variable bill compared with its estimate, for the screens. */
export interface BillVariance {
  /** Positive: the estimate was more than the bill, and this much is free again. */
  underCents: number
  /** Positive: the bill came in above the estimate by this much. */
  overCents: number
}

export function billVariance(estimateCents: number, actualCents: number): BillVariance {
  return {
    underCents: Math.max(0, estimateCents - actualCents),
    overCents: Math.max(0, actualCents - estimateCents)
  }
}

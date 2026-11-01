/**
 * Debt payoff projection. Everything is integer cents so the number shown on
 * screen matches the number the schedule would actually charge; interest is
 * rounded per month the way a card statement rounds it.
 */

export interface PayoffInput {
  balanceCents: number
  /** Annual percentage rate in basis points: 1999 is 19.99%. */
  aprBps: number
  /** What is paid every month, before any extra. */
  paymentCents: number
}

export interface PayoffPlan {
  months: number
  totalInterestCents: number
  totalPaidCents: number
  /** The last payment is usually smaller than the rest. */
  finalPaymentCents: number
}

/** A schedule longer than this is, for a household budget, never. */
const MAX_MONTHS = 1200

/**
 * Returns null when the payment cannot cover the monthly interest: the balance
 * would grow forever, and claiming a payoff date would be a lie.
 */
export function debtPayoff(input: PayoffInput): PayoffPlan | null {
  let balance = Math.max(0, Math.round(input.balanceCents))
  if (balance === 0) return { months: 0, totalInterestCents: 0, totalPaidCents: 0, finalPaymentCents: 0 }

  const payment = Math.round(input.paymentCents)
  if (payment <= 0) return null

  const monthlyRate = Math.max(0, input.aprBps) / 10_000 / 12
  // A payment that cannot clear the first month's interest never amortises.
  if (payment <= Math.round(balance * monthlyRate)) return null

  let interestTotal = 0
  let paidTotal = 0
  let months = 0
  let finalPayment = payment

  while (balance > 0 && months < MAX_MONTHS) {
    const interest = Math.round(balance * monthlyRate)
    balance += interest
    interestTotal += interest
    const due = Math.min(payment, balance)
    balance -= due
    paidTotal += due
    finalPayment = due
    months += 1
  }

  if (balance > 0) return null
  return { months, totalInterestCents: interestTotal, totalPaidCents: paidTotal, finalPaymentCents: finalPayment }
}

/**
 * How much more than the minimum is needed to be rid of the balance by a date.
 * Returns null when even a large extra payment cannot get there inside the
 * month cap, and 0 when the minimum already arrives in time.
 */
export function requiredPaymentCents(input: {
  balanceCents: number
  aprBps: number
  withinMonths: number
}): number | null {
  const months = Math.max(1, Math.round(input.withinMonths))
  const rate = Math.max(0, input.aprBps) / 10_000 / 12
  if (input.balanceCents <= 0) return 0

  // An amortising payment is the closed form; when the rate is zero it is just
  // the balance split over the months.
  if (rate === 0) return Math.ceil(input.balanceCents / months)
  const factor = Math.pow(1 + rate, months)
  const payment = (input.balanceCents * rate * factor) / (factor - 1)
  return Math.ceil(payment)
}

import type { Frequency, PayCadence } from './types'

export const PAY_PERIODS_PER_YEAR: Record<PayCadence, number> = {
  weekly: 52,
  biweekly: 26,
  semimonthly: 24,
  monthly: 12
}

export const BILL_PERIODS_PER_YEAR: Record<Frequency, number> = {
  weekly: 52,
  biweekly: 26,
  semimonthly: 24,
  monthly: 12,
  quarterly: 4,
  annual: 1
}

export const PAY_CADENCE_LABEL: Record<PayCadence, string> = {
  weekly: 'Weekly',
  biweekly: 'Biweekly',
  semimonthly: 'Semimonthly',
  monthly: 'Monthly'
}

export const FREQUENCY_LABEL: Record<Frequency, string> = {
  weekly: 'Weekly',
  biweekly: 'Every 2 weeks',
  semimonthly: 'Twice a month',
  monthly: 'Monthly',
  quarterly: 'Quarterly',
  annual: 'Yearly'
}

/**
 * Smooths an irregular bill into a monthly figure. This is what a sinking fund
 * needs: a $600 annual insurance bill is $50/month of obligation, not a shock.
 */
export function monthlyEquivalentCents(amountCents: number, frequency: Frequency): number {
  return Math.round((amountCents * BILL_PERIODS_PER_YEAR[frequency]) / 12)
}

/**
 * The amount that must be reserved out of a single paycheck so the bill is
 * covered when it lands, regardless of whether pay and bill cadences line up.
 */
export function reservePerPaycheckCents(
  amountCents: number,
  frequency: Frequency,
  cadence: PayCadence
): number {
  const perYear = amountCents * BILL_PERIODS_PER_YEAR[frequency]
  return Math.round(perYear / PAY_PERIODS_PER_YEAR[cadence])
}

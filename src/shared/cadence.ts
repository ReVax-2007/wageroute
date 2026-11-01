import type { BillFundingStrategy, Frequency, PayCadence } from './types'

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

export const BILL_FUNDING_STRATEGY_LABEL: Record<BillFundingStrategy, string> = {
  closest_due_date: 'Closest to the due date',
  specific_check: 'Choose specific paycheck to fund',
  all_checks: 'Reserve from all paychecks',
  first_check: 'First check of every month',
  last_check: 'Last check of every month'
}

/**
 * The day-of-month each paycheck slot represents. A bill funded by "the check
 * closest to its due date" is compared against these, so this table and
 * {@link paycheckIndexInMonth} must partition the month identically.
 */
const CHECK_SLOT_ANCHORS: Record<PayCadence, readonly number[]> = {
  monthly: [16],
  semimonthly: [8, 23],
  biweekly: [7, 21, 30],
  weekly: [4, 11, 18, 25, 30]
}

/**
 * How many paychecks a month is *certain* to contain. Biweekly and weekly pay
 * can produce a 3rd or 5th check in some months, but not every month, so a bill
 * told to fund on one of those optional checks would go unreserved whenever the
 * month came up short. Funding targets are clamped to the guaranteed slots.
 */
const GUARANTEED_CHECKS_PER_MONTH: Record<PayCadence, number> = {
  monthly: 1,
  semimonthly: 2,
  biweekly: 2,
  weekly: 4
}

/**
 * Which paycheck of the month a given date falls on, 1-based.
 *
 * This is a calendar approximation: WageRoute knows the date of the paycheck
 * being routed, not a payday calendar, so slots are day-of-month ranges that
 * match {@link CHECK_SLOT_ANCHORS}. A biweekly payday that drifts a few days
 * still lands in the same slot.
 */
export function paycheckIndexInMonth(dateISO: string, cadence: PayCadence): number {
  const day = dayOfMonth(dateISO)
  switch (cadence) {
    case 'monthly':
      return 1
    case 'semimonthly':
      return day <= 15 ? 1 : 2
    case 'biweekly':
      return day <= 14 ? 1 : day <= 28 ? 2 : 3
    case 'weekly':
      return Math.min(CHECK_SLOT_ANCHORS.weekly.length, Math.ceil(day / 7))
  }
}

const MS_PER_DAY = 86_400_000

function epochDay(dateISO: string): number {
  const year = Number.parseInt(dateISO.slice(0, 4), 10)
  const month = Number.parseInt(dateISO.slice(5, 7), 10)
  const day = Number.parseInt(dateISO.slice(8, 10), 10)
  return Math.floor(Date.UTC(year, month - 1, day) / MS_PER_DAY)
}

function isoFromEpochDay(day: number): string {
  return new Date(day * MS_PER_DAY).toISOString().slice(0, 10)
}

/**
 * Which paycheck of the month a date is, using a real payday series rather than
 * day-of-month ranges.
 *
 * With an anchor (any known payday) weekly and biweekly paydays are projected
 * exactly, so a 15th/30th biweekly earner's second check is the 30th — the
 * day-range approximation would call that the third check and the check would
 * reserve nothing for bills assigned to the second. A date that is not itself a
 * payday snaps back to the most recent one in the series.
 */
export function paydayIndexInMonth(
  dateISO: string,
  cadence: PayCadence,
  anchorDateISO?: string | null
): number {
  if (!anchorDateISO) return paycheckIndexInMonth(dateISO, cadence)
  if (cadence !== 'weekly' && cadence !== 'biweekly') {
    return paycheckIndexInMonth(dateISO, cadence)
  }

  const step = cadence === 'weekly' ? 7 : 14
  const anchor = epochDay(anchorDateISO)
  const day = epochDay(dateISO)
  const sinceAnchor = ((day - anchor) % step + step) % step
  const payday = day - sinceAnchor

  const dayOfMonthNumber = Number.parseInt(dateISO.slice(8, 10), 10)
  const monthStart = day - (dayOfMonthNumber - 1)
  const offsetAtStart = ((monthStart - anchor) % step + step) % step
  const firstPayday = monthStart + (offsetAtStart === 0 ? 0 : step - offsetAtStart)
  if (firstPayday > payday) return 1
  return Math.floor((payday - firstPayday) / step) + 1
}

/** The next payday on or after `fromISO`, or null without an anchor. */
export function nextPaydayISO(
  fromISO: string,
  cadence: PayCadence,
  anchorDateISO?: string | null
): string | null {
  if (!anchorDateISO) return null
  const step = cadence === 'weekly' ? 7 : cadence === 'biweekly' ? 14 : null
  if (step === null) return null
  const anchor = epochDay(anchorDateISO)
  const from = epochDay(fromISO)
  const offset = ((from - anchor) % step + step) % step
  const next = offset === 0 ? from : from + (step - offset)
  return isoFromEpochDay(next)
}

/** The slot whose representative day is nearest the bill's due day. Ties go earlier. */
export function closestCheckIndexToDue(dueDay: number, cadence: PayCadence): number {
  const anchors = CHECK_SLOT_ANCHORS[cadence]
  let bestIndex = 1
  let bestDistance = Number.POSITIVE_INFINITY
  for (let i = 0; i < anchors.length; i += 1) {
    const distance = Math.abs(anchors[i] - dueDay)
    if (distance < bestDistance) {
      bestDistance = distance
      bestIndex = i + 1
    }
  }
  return bestIndex
}

/**
 * The paycheck slots a bill can be assigned to for this cadence — the
 * guaranteed ones only, so the UI can never offer a slot that silently stops
 * reserving in a short month.
 */
export function reachableCheckIndexes(cadence: PayCadence): number[] {
  return Array.from({ length: GUARANTEED_CHECKS_PER_MONTH[cadence] }, (_, i) => i + 1)
}

/**
 * The one paycheck of the month that funds this bill, clamped to a slot that
 * exists every month. Returns null for `all_checks`, where no single check is
 * responsible.
 *
 * `last_check` is the last *guaranteed* slot, not the last calendar check: a
 * monthly payday has one check, a biweekly month can have three but only
 * two exist every month, and the second is the one that can always carry the
 * bill. Funding the third would leave the bill unreserved in short months.
 */
export function fundingCheckIndex(input: {
  cadence: PayCadence
  dueDay: number
  fundingStrategy: BillFundingStrategy
  fundingPaycheckIndex?: number | null
}): number | null {
  if (input.fundingStrategy === 'all_checks') return null
  if (input.fundingStrategy === 'first_check') return 1
  if (input.fundingStrategy === 'last_check') return GUARANTEED_CHECKS_PER_MONTH[input.cadence]

  const requested =
    input.fundingStrategy === 'closest_due_date'
      ? closestCheckIndexToDue(input.dueDay, input.cadence)
      : (input.fundingPaycheckIndex ?? 1)

  return Math.min(Math.max(1, Math.round(requested)), GUARANTEED_CHECKS_PER_MONTH[input.cadence])
}

/**
 * What one paycheck must set aside for a bill.
 *
 * `all_checks` spreads the year's cost over every paycheck. The four
 * single-check strategies move that same money onto one paycheck per month —
 * they never multiply it — so a month's total reserve is
 * {@link monthlyEquivalentCents} under every strategy and the Priority Wall
 * stays honest. A $50/week bill therefore asks $216.67 from the one funding
 * check, not $50.
 *
 * `paycheckDate` is required for the single-check strategies. Without it the
 * position in the month is unknowable, so the bill falls back to the spread.
 * `payAnchorDate` turns the slot into a real position in the payday series;
 * without it the day-of-month approximation is used, and a check outside the
 * guaranteed slots carries the spread instead of silently reserving nothing.
 */
export function billFundingReserveCents(input: {
  amountCents: number
  frequency: Frequency
  cadence: PayCadence
  dueDay: number
  fundingStrategy?: BillFundingStrategy
  fundingPaycheckIndex?: number | null
  paycheckDate?: string | null
  payAnchorDate?: string | null
}): number {
  const strategy = input.fundingStrategy ?? 'all_checks'
  const spread = reservePerPaycheckCents(input.amountCents, input.frequency, input.cadence)
  if (strategy === 'all_checks') return spread
  if (!input.paycheckDate) return spread

  const fundingIndex = fundingCheckIndex({
    cadence: input.cadence,
    dueDay: input.dueDay,
    fundingStrategy: strategy,
    fundingPaycheckIndex: input.fundingPaycheckIndex
  })
  if (fundingIndex === null) return spread

  const guaranteed = GUARANTEED_CHECKS_PER_MONTH[input.cadence]
  if (input.payAnchorDate) {
    return paydayIndexInMonth(input.paycheckDate, input.cadence, input.payAnchorDate) ===
      fundingIndex
      ? monthlyEquivalentCents(input.amountCents, input.frequency)
      : 0
  }

  const index = paycheckIndexInMonth(input.paycheckDate, input.cadence)
  if (index > guaranteed) return spread

  return index === fundingIndex
    ? monthlyEquivalentCents(input.amountCents, input.frequency)
    : 0
}

function dayOfMonth(dateISO: string): number {
  const day = Number.parseInt(dateISO.slice(8, 10), 10)
  return Number.isFinite(day) && day > 0 ? day : 1
}

/**
 * Smooths an irregular bill into a monthly figure. This is what a sinking fund
 * needs: a $600 annual insurance bill is $50/month of obligation, not a shock.
 */
export function monthlyEquivalentCents(amountCents: number, frequency: Frequency): number {
  return Math.round((amountCents * BILL_PERIODS_PER_YEAR[frequency]) / 12)
}

/**
 * The part of the smoothed wall a bill still needs this month. Once a payment
 * lands, its money has already left the pool, so withholding the same bill
 * again would subtract it twice. The clamp keeps an overpayment from turning
 * the wall negative, and the smoothing buffer survives: paying one weekly
 * instance leaves the rest of that bill's month claimed.
 */
export function unpaidMonthlyWallCents(
  bills: readonly { id: string; amountCents: number; frequency: Frequency }[],
  paidByBillCents: ReadonlyMap<string, number>
): number {
  return bills.reduce((total, bill) => {
    const monthly = monthlyEquivalentCents(bill.amountCents, bill.frequency)
    const paid = paidByBillCents.get(bill.id) ?? 0
    return total + Math.max(0, monthly - paid)
  }, 0)
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

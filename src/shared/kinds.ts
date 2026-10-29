import type { TransactionKind } from './types'

/**
 * The sign a transaction amount must carry. Adjustments are the one kind that
 * can go either way, because they exist to move a balance up or down.
 */
const SIGN_BY_KIND: Record<TransactionKind, 1 | -1 | 0> = {
  income: 1,
  expense: -1,
  bill_payment: -1,
  transfer: -1,
  goal_funding: -1,
  investment: -1,
  adjustment: 0
}

const KIND_NOUN: Record<TransactionKind, string> = {
  income: 'Income',
  expense: 'An expense',
  bill_payment: 'A bill payment',
  transfer: 'A transfer',
  goal_funding: 'Goal funding',
  investment: 'An investment',
  adjustment: 'An adjustment'
}

export function signForKind(kind: TransactionKind): 1 | -1 | 0 {
  return SIGN_BY_KIND[kind]
}

/**
 * Flips an amount to the sign its kind requires. Imported files disagree about
 * whether amounts carry a sign, so the kind wins and the sign is derived.
 */
export function normalizeSignedCents(kind: TransactionKind, cents: number): number {
  const amount = Math.round(cents)
  const sign = SIGN_BY_KIND[kind]
  if (sign === 0 || amount === 0) return amount
  return sign * Math.abs(amount)
}

/** A message when the amount contradicts the kind, or null when they agree. */
export function signedAmountError(kind: TransactionKind, cents: number): string | null {
  const sign = SIGN_BY_KIND[kind]
  if (sign === 0 || cents === 0) return null
  if (Math.sign(cents) === sign) return null
  return sign > 0
    ? `${KIND_NOUN[kind]} must be a positive amount`
    : `${KIND_NOUN[kind]} must be a negative amount`
}

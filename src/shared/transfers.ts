/**
 * Round-up sweeps and transfer legs stay in integer cents: no float ever
 * touches the ledger.
 */
export function roundUpRemainderCents(amountCents: number, incrementCents: number): number {
  const magnitude = Math.abs(Math.round(amountCents))
  const increment = Math.round(incrementCents)
  if (increment <= 0) return 0
  const remainder = magnitude % increment
  return remainder === 0 ? 0 : increment - remainder
}

export interface TransferLegs {
  outCents: number
  inCents: number
}

export function transferLegs(amountCents: number): TransferLegs {
  const magnitude = Math.abs(Math.round(amountCents))
  return { outCents: -magnitude, inCents: magnitude }
}

import { useState } from 'react'
import { floorBreach, floorBreachQuestion } from '@shared/accounts'
import type { AccountWithBalance } from '@shared/types'

interface Pending {
  key: string
  body: string
  confirmLabel: string
}

/**
 * The phone's version of the desktop's floor question (ADR 0035), without a
 * second sheet: the first tap on save shows the warning and turns the button
 * into "Save anyway"; a second tap with the same account and amount saves.
 * Changing either asks again, so a confirmation never carries over.
 */
export function useFloorGate(currency: string) {
  const [pending, setPending] = useState<Pending | null>(null)

  const allow = (account: AccountWithBalance | undefined, deltaCents: number): boolean => {
    const breach = account ? floorBreach(account, deltaCents) : null
    if (!account || !breach) {
      setPending(null)
      return true
    }
    const key = `${account.id}:${breach.afterCents}`
    if (pending?.key === key) {
      setPending(null)
      return true
    }
    const question = floorBreachQuestion(breach, currency)
    setPending({ key, body: question.body, confirmLabel: question.confirmLabel })
    return false
  }

  return { warning: pending?.body ?? null, confirmLabel: pending?.confirmLabel ?? null, allow }
}

export function FloorWarning({ text }: { text: string | null }) {
  return text ? (
    <p className="form-warning" role="alert">
      {text}
    </p>
  ) : null
}

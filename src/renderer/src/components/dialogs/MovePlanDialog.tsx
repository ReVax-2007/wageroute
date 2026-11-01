import { useMemo, useState } from 'react'
import { formatMoney } from '@shared/money'
import type {
  AccountKind,
  AccountWithBalance,
  Allocation,
  PaycheckWithAllocations,
  PlanMoveTarget
} from '@shared/types'
import { Button, Modal } from '../ui'
import { ACCOUNT_KIND_LABEL } from '../../lib/finance'
import { useFinanceStore } from '../../store/useFinanceStore'

/** The account kind each routed bucket may land in; goals are handled apart. */
const MOVE_KIND: Partial<Record<Allocation['bucket'], AccountKind>> = {
  debt: 'credit',
  savings: 'savings',
  investment: 'investment'
}

interface MoveLine {
  allocation: Allocation
  options: AccountWithBalance[]
  /** The account an earlier press already moved this line into. */
  settledAccountId: string | null
  /** What the user needs first when no account can receive the money. */
  needs: string | null
}

function buildLines(
  paycheck: PaycheckWithAllocations,
  accounts: readonly AccountWithBalance[],
  transactions: readonly {
    paycheckId: string | null
    kind: string
    amountCents: number
    counterAccountId: string | null
  }[]
): MoveLine[] {
  const live = accounts.filter((account) => !account.isArchived)
  const posted = transactions.filter(
    (entry) => entry.paycheckId === paycheck.id && entry.kind === 'transfer' && entry.counterAccountId
  )

  return paycheck.allocations
    .filter((allocation) => allocation.amountCents > 0)
    .filter((allocation) => allocation.bucket !== 'priority' && allocation.bucket !== 'leisure')
    .map((allocation) => {
      const settledAccountId = (options: AccountWithBalance[]): string | null => {
        const matches = posted.filter(
          (entry) => entry.amountCents === -allocation.amountCents
        )
        const known = matches.find((entry) =>
          options.some((account) => account.id === entry.counterAccountId)
        )
        return (known ?? (matches.length === 1 ? matches[0] : null))?.counterAccountId ?? null
      }

      if (allocation.bucket === 'goal') {
        const options = allocation.goalId
          ? live.filter((account) => account.dedicatedGoalId === allocation.goalId)
          : []
        return {
          allocation,
          options,
          settledAccountId: settledAccountId(options),
          needs:
            options.length > 0
              ? null
              : 'Give this goal its own account on the Goals screen.'
        }
      }
      const kind = MOVE_KIND[allocation.bucket]
      const options = kind
        ? live.filter((account) => account.kind === kind).sort((a, b) => a.balanceCents - b.balanceCents)
        : []
      return {
        allocation,
        options,
        settledAccountId: settledAccountId(options),
        needs:
          options.length > 0
            ? null
            : `Add a ${kind ? ACCOUNT_KIND_LABEL[kind].toLowerCase() : ''} account first.`
      }
    })
}

/**
 * Moves a routed paycheck's surplus to the accounts that hold it. Routing is a
 * plan (ADR 0013); this is the explicit second step that posts the transfers.
 */
export function MovePlanDialog({
  paycheck,
  onClose
}: {
  paycheck: PaycheckWithAllocations
  onClose: () => void
}) {
  const snapshot = useFinanceStore((state) => state.snapshot)
  const settings = useFinanceStore((state) => state.settings)
  const applyPaycheckPlan = useFinanceStore((state) => state.applyPaycheckPlan)
  const go = useFinanceStore((state) => state.go)

  const lines = useMemo(
    () => buildLines(paycheck, snapshot?.accounts ?? [], snapshot?.transactions ?? []),
    [paycheck, snapshot?.accounts, snapshot?.transactions]
  )

  const [chosen, setChosen] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      lines
        .filter((line) => line.needs === null)
        .map((line) => [line.allocation.id, line.settledAccountId ?? line.options[0].id])
    )
  )
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const pending = lines.filter(
    (line) => line.needs === null && line.settledAccountId === null && chosen[line.allocation.id]
  )
  const pendingCents = pending.reduce((total, line) => total + line.allocation.amountCents, 0)
  const settledCount = lines.filter((line) => line.settledAccountId !== null).length

  const submit = async () => {
    const targets: PlanMoveTarget[] = pending.map((line) => ({
      allocationId: line.allocation.id,
      accountId: chosen[line.allocation.id]
    }))
    if (targets.length === 0) {
      setError('There is nothing left to move')
      return
    }
    setSaving(true)
    setError(null)
    try {
      const result = await applyPaycheckPlan(paycheck.id, targets)
      if (result) onClose()
      else setError('The transfers could not be posted')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      title="Move this plan"
      subtitle={`From ${paycheck.source} · ${formatMoney(paycheck.amountCents, settings.currency)} routed`}
      onClose={onClose}
      footer={
        <>
          <Button variant="quiet" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={submit}
            disabled={saving || pending.length === 0}
          >
            {pending.length === 0
              ? 'Nothing to move'
              : `Move ${formatMoney(pendingCents, settings.currency)}`}
          </Button>
        </>
      }
    >
      <p className="field-hint">
        Each line becomes one transfer from the paycheck&apos;s deposit account. Pressing this
        again later only moves what has not been moved yet. The Priority Wall and guilt-free
        money stay where they are.
      </p>

      {settledCount > 0 && (
        <p className="field-hint">
          {settledCount === 1 ? 'One line is' : `${settledCount} lines are`} already moved.
        </p>
      )}

      <ul className="move-plan">
        {lines.map((line) => (
          <li key={line.allocation.id} className="move-row">
            <span className="move-label">
              <span className="cell-strong">{line.allocation.label}</span>
              <span className="alloc-note">
                {formatMoney(line.allocation.amountCents, settings.currency)}
              </span>
            </span>
            {line.needs ? (
              <span className="move-needs">
                {line.needs}{' '}
                <Button
                  size="sm"
                  variant="quiet"
                  onClick={() => go(line.allocation.bucket === 'goal' ? 'goals' : 'accounts')}
                >
                  {line.allocation.bucket === 'goal' ? 'Open goals' : 'Open accounts'}
                </Button>
              </span>
            ) : line.settledAccountId ? (
              <span className="move-settled">
                Moved to{' '}
                {line.options.find((account) => account.id === line.settledAccountId)?.name ??
                  'a closed account'}
              </span>
            ) : (
              <select
                className="select"
                aria-label={`Account for ${line.allocation.label}`}
                value={chosen[line.allocation.id] ?? line.options[0]?.id ?? ''}
                onChange={(event) =>
                  setChosen((current) => ({
                    ...current,
                    [line.allocation.id]: event.target.value
                  }))
                }
              >
                {line.options.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.name}
                  </option>
                ))}
              </select>
            )}
          </li>
        ))}
      </ul>

      {lines.length === 0 && (
        <p className="field-hint">
          This paycheck routed no money to debt, savings, investments or goals.
        </p>
      )}

      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </Modal>
  )
}

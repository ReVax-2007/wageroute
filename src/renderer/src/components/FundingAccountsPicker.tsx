import { useState } from 'react'
import { formatMoney } from '@shared/money'
import type { AccountWithBalance, GoalWithProgress } from '@shared/types'
import { Field } from './ui'

/**
 * One-or-several account picker. An account that already funds a different goal
 * is labelled with that goal, because moving it here is a deliberate swap.
 */
export function FundingAccountsPicker({
  accounts,
  goals,
  currency,
  value,
  onChange,
  label,
  hint
}: {
  accounts: readonly AccountWithBalance[]
  goals: readonly GoalWithProgress[]
  currency: string
  value: string[]
  onChange: (ids: string[]) => void
  label: string
  hint: string
}) {
  const [many, setMany] = useState(value.length > 1)

  const goalNameFundedBy = (accountId: string): string | null => {
    const dedicated = accounts.find((account) => account.id === accountId)?.dedicatedGoalId
    return goals.find((goal) => goal.id === dedicated)?.name ?? null
  }

  const chosen = accounts.filter((account) => value.includes(account.id))
  const combinedCents = chosen.reduce(
    (total, account) => total + Math.max(0, account.balanceCents),
    0
  )

  return (
    <>
      <Field label={label} hint={hint} wide>
        {many ? (
          accounts.length === 0 ? (
            <p className="field-hint">No savings, checking or cash account yet.</p>
          ) : (
            <div className="funding-account-list">
              {accounts.map((account) => (
                <label key={account.id} className="check funding-account-check">
                  <input
                    type="checkbox"
                    checked={value.includes(account.id)}
                    onChange={() =>
                      onChange(
                        value.includes(account.id)
                          ? value.filter((id) => id !== account.id)
                          : [...value, account.id]
                      )
                    }
                  />
                  <span className="funding-account-name">{account.name}</span>
                  <span className="funding-account-balance num muted">
                    {formatMoney(Math.max(0, account.balanceCents), currency)}
                  </span>
                </label>
              ))}
            </div>
          )
        ) : (
          <select
            className="select"
            value={value[0] ?? ''}
            onChange={(event) => onChange(event.target.value ? [event.target.value] : [])}
          >
            <option value="">No account — count allocations instead</option>
            {accounts.map((account) => {
              const funded = goalNameFundedBy(account.id)
              return (
                <option key={account.id} value={account.id}>
                  {account.name} · {formatMoney(Math.max(0, account.balanceCents), currency)}
                  {funded ? ` (funds ${funded})` : ''}
                </option>
              )
            })}
          </select>
        )}
      </Field>

      <label className="check funding-many">
        <input
          type="checkbox"
          checked={many}
          onChange={(event) => {
            const next = event.target.checked
            setMany(next)
            if (!next && value.length > 1) onChange(value.slice(0, 1))
          }}
        />
        Let several accounts add up together
      </label>

      <p className="field-hint">
        {chosen.length === 0
          ? 'No account chosen — progress is counted from the allocations a paycheck routes.'
          : `${formatMoney(combinedCents, currency)} across ${chosen.length} account${
              chosen.length === 1 ? '' : 's'
            } counts as funded.`}
      </p>
    </>
  )
}

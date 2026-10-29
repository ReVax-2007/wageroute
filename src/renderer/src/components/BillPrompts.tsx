import { useState } from 'react'
import { Check, Clock } from 'lucide-react'
import { dueBillPrompts, type BillPrompt } from '@shared/billPrompts'
import { formatDateLabel, todayISO } from '@shared/dates'
import { formatMoney } from '@shared/money'
import { Button } from './ui'
import { useFinanceStore } from '../store/useFinanceStore'

export function BillPrompts() {
  const snapshot = useFinanceStore((state) => state.snapshot)
  const settings = useFinanceStore((state) => state.settings)
  const snoozed = useFinanceStore((state) => state.snoozedBillIds)
  const snoozeBill = useFinanceStore((state) => state.snoozeBill)
  const createTransaction = useFinanceStore((state) => state.createTransaction)
  const [pendingKey, setPendingKey] = useState<string | null>(null)

  if (!snapshot) return null

  const prompts = dueBillPrompts({
    bills: snapshot.bills,
    payments: snapshot.transactions,
    todayISO: todayISO()
  }).filter((prompt) => !snoozed.includes(prompt.billId))

  if (prompts.length === 0) return null

  const openAccounts = snapshot.accounts.filter((account) => !account.isArchived)
  const fallbackAccount =
    openAccounts.find((account) => account.kind === 'checking') ?? openAccounts[0] ?? null

  const markPaid = async (prompt: BillPrompt) => {
    const accountId = prompt.accountId ?? fallbackAccount?.id
    if (!accountId) return
    const remainingCents = Math.max(0, prompt.amountCents - prompt.paidCents)
    if (remainingCents === 0) return
    const key = `${prompt.billId}:${prompt.dueOn}`
    setPendingKey(key)
    await createTransaction({
      accountId,
      kind: 'bill_payment',
      amountCents: -remainingCents,
      occurredOn: prompt.dueOn,
      memo: prompt.name,
      category: prompt.category,
      billId: prompt.billId
    })
    setPendingKey(null)
  }

  return (
    <section className="card prompt-card">
      <header className="prompt-head">
        <div>
          <p className="eyebrow">Chronology check</p>
          <h2 className="card-title">Did these clear?</h2>
          <p className="card-sub">
            Past the due date with no matching payment on the wall.
          </p>
        </div>
        <span className="prompt-count">{prompts.length}</span>
      </header>

      <ul className="prompt-list">
        {prompts.map((prompt) => {
          const accountId = prompt.accountId ?? fallbackAccount?.id
          const key = `${prompt.billId}:${prompt.dueOn}`
          const pending = pendingKey === key
          return (
            <li key={key} className="prompt-row">
              <span className="prompt-icon">
                <Clock size={16} />
              </span>
              <div className="prompt-bill">
                <span className="cell-strong">Did your {prompt.name} clear?</span>
                <span className="prompt-due">
                  Due {formatDateLabel(prompt.dueOn)} ·{' '}
                  {prompt.daysLate === 1 ? '1 day past due' : `${prompt.daysLate} days past due`}
                  {prompt.autopay ? ' · autopay' : ''}
                </span>
                {prompt.paidCents > 0 && (
                  <span className="prompt-due">
                    {formatMoney(prompt.paidCents, settings.currency)} of{' '}
                    {formatMoney(prompt.amountCents, settings.currency)} already matched
                  </span>
                )}
              </div>
              <span className="prompt-amount num">
                {formatMoney(prompt.amountCents - prompt.paidCents, settings.currency)}
              </span>
              <div className="prompt-actions">
                <Button
                  variant="primary"
                  size="sm"
                  icon={<Check size={14} />}
                  disabled={pending || !accountId}
                  title={accountId ? 'Log this bill as paid' : 'No account available'}
                  onClick={() => void markPaid(prompt)}
                >
                  {pending
                    ? 'Logging…'
                    : prompt.paidCents > 0
                      ? 'Yes, log the rest'
                      : 'Yes, it cleared'}
                </Button>
                <Button
                  variant="quiet"
                  size="sm"
                  disabled={pending}
                  onClick={() => snoozeBill(prompt.billId)}
                >
                  Not yet
                </Button>
              </div>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

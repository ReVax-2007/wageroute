import { useState } from 'react'
import { isUsableAccount } from '@shared/accounts'
import { Check, Clock } from 'lucide-react'
import { dueBillPrompts, type BillPrompt } from '@shared/billPrompts'
import { formatDateLabel, formatMonthLong, isISODate, todayISO } from '@shared/dates'
import { formatMoney } from '@shared/money'
import { Button } from './ui'
import { confirmFloor } from '../lib/finance'
import { useFinanceStore } from '../store/useFinanceStore'

const promptKey = (prompt: BillPrompt) => `${prompt.billId}:${prompt.dueOn}`

export function BillPrompts() {
  const snapshot = useFinanceStore((state) => state.snapshot)
  const settings = useFinanceStore((state) => state.settings)
  const snoozed = useFinanceStore((state) => state.snoozedPrompts)
  const snoozePrompt = useFinanceStore((state) => state.snoozePrompt)
  const unsnoozePrompt = useFinanceStore((state) => state.unsnoozePrompt)
  const createTransaction = useFinanceStore((state) => state.createTransaction)
  const askConfirm = useFinanceStore((state) => state.askConfirm)
  const [pendingKey, setPendingKey] = useState<string | null>(null)
  // A bill that came due last month cannot be logged at its due date without
  // reaching back a month, so those rows let the user say when it really left.
  const [paidOn, setPaidOn] = useState<Record<string, string>>({})

  if (!snapshot) return null

  const today = todayISO()

  // The ledger window is capped; the bill history is not, so an annual bill's
  // payment is still matchable when hundreds of newer rows have pushed it out.
  const prompts = dueBillPrompts({
    bills: snapshot.bills,
    payments: snapshot.billPayments,
    todayISO: today
  })
  const open = prompts.filter((prompt) => !snoozed.includes(promptKey(prompt)))
  const waiting = prompts.filter((prompt) => snoozed.includes(promptKey(prompt)))

  if (prompts.length === 0) return null

  const openAccounts = snapshot.accounts.filter(isUsableAccount)
  const activeIds = new Set(openAccounts.map((account) => account.id))
  const fallbackAccount =
    openAccounts.find((account) => account.kind === 'checking') ?? openAccounts[0] ?? null
  // A bill can outlive the account it pays from. Posting into an archived account
  // would move money out of a balance no total counts, so that bill waits for an
  // edit instead of logging a payment nobody sees.
  const accountFor = (prompt: BillPrompt): string | null => {
    if (prompt.accountId) return activeIds.has(prompt.accountId) ? prompt.accountId : null
    return fallbackAccount?.id ?? null
  }
  const archivedPointer = (prompt: BillPrompt): boolean =>
    prompt.accountId !== null && !activeIds.has(prompt.accountId)

  // A prompt only appears after its due date, so a different month means the
  // payment would land in a month the user may not be looking at.
  const lateMonth = (prompt: BillPrompt): boolean => prompt.dueOn.slice(0, 7) !== today.slice(0, 7)
  const dateFor = (prompt: BillPrompt): string => paidOn[promptKey(prompt)] ?? prompt.dueOn

  const markPaid = async (prompt: BillPrompt) => {
    const accountId = accountFor(prompt)
    if (!accountId) return
    const remainingCents = Math.max(0, prompt.amountCents - prompt.paidCents)
    if (remainingCents === 0) return
    const key = promptKey(prompt)
    const occurredOn = dateFor(prompt)
    if (!isISODate(occurredOn) || occurredOn > today) return
    const account = openAccounts.find((item) => item.id === accountId)
    if (!(await confirmFloor(askConfirm, account, -remainingCents, settings.currency))) return
    setPendingKey(key)
    await createTransaction({
      accountId,
      kind: 'bill_payment',
      amountCents: -remainingCents,
      occurredOn,
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
          <p className="eyebrow">Bill check</p>
          <h2 className="card-title">Did these clear?</h2>
          <p className="card-sub">Past the due date with no matching payment in your ledger.</p>
        </div>
        <span className="prompt-count">{open.length}</span>
      </header>

      {open.length > 0 && (
        <ul className="prompt-list">
          {open.map((prompt) => {
            const accountId = accountFor(prompt)
            const key = promptKey(prompt)
            const pending = pendingKey === key
            const needsDate = lateMonth(prompt)
            const paidDate = dateFor(prompt)
            const dateOk = !needsDate || (isISODate(paidDate) && paidDate <= today)
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
                  {/* A disabled button cannot explain itself, so the reason is
                      text in the row rather than a tooltip. */}
                  {!accountId && (
                    <span className="prompt-due prompt-blocked">
                      {archivedPointer(prompt)
                        ? 'The account this bill pays from is archived. Edit the bill to choose another one.'
                        : 'Add an account before logging this payment.'}
                    </span>
                  )}
                  {needsDate && (
                    <label className="prompt-date-row">
                      <span className="prompt-due">When did it leave your account?</span>
                      <input
                        className="input prompt-date"
                        type="date"
                        aria-label={`Date ${prompt.name} was paid`}
                        value={paidDate}
                        max={today}
                        disabled={pending}
                        onChange={(event) => {
                          const value = event.target.value
                          setPaidOn((state) => ({ ...state, [key]: value }))
                        }}
                      />
                      <span className="prompt-due">
                        {isISODate(paidDate) && paidDate <= today
                          ? `Counts in ${formatMonthLong(paidDate)}.`
                          : 'Choose a date up to today.'}
                      </span>
                    </label>
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
                    disabled={pending || !accountId || !dateOk}
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
                    onClick={() => snoozePrompt(key)}
                  >
                    Not yet
                  </Button>
                </div>
              </li>
            )
          })}
        </ul>
      )}

      {waiting.length > 0 && (
        <ul className="prompt-list prompt-snoozed">
          {waiting.map((prompt) => (
            <li key={promptKey(prompt)} className="prompt-row">
              <span className="prompt-icon">
                <Clock size={16} />
              </span>
              <div className="prompt-bill">
                <span className="cell-strong">
                  {prompt.name} <span className="chip chip-quiet">Snoozed</span>
                </span>
                <span className="prompt-due">Due {formatDateLabel(prompt.dueOn)}</span>
              </div>
              <span className="prompt-amount num">
                {formatMoney(prompt.amountCents - prompt.paidCents, settings.currency)}
              </span>
              <div className="prompt-actions">
                <Button variant="quiet" size="sm" onClick={() => unsnoozePrompt(promptKey(prompt))}>
                  Bring back
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

import { useState } from 'react'
import { CreditCard } from 'lucide-react'
import { cardOwedCents } from '@shared/accounts'
import { todayISO } from '@shared/dates'
import { centsToEditable, formatMoney, parseMoneyToCents } from '@shared/money'
import type { AccountWithBalance } from '@shared/types'
import { Button, Field, Modal } from '../ui'
import { accountDisplayBalanceCents } from '../../lib/finance'
import { useFinanceStore } from '../../store/useFinanceStore'
import { useDialogSave } from '../useDialogSave'

export function PayCardDialog({
  card,
  onClose
}: {
  card: AccountWithBalance
  onClose: () => void
}) {
  const snapshot = useFinanceStore((state) => state.snapshot)
  const settings = useFinanceStore((state) => state.settings)
  const createTransaction = useFinanceStore((state) => state.createTransaction)
  const sources = (snapshot?.accounts ?? []).filter(
    (account) =>
      account.kind !== 'credit' && account.kind !== 'investment' && !account.isArchived
  )
  const owed = accountDisplayBalanceCents(card)
  const creditCents = Math.max(0, -cardOwedCents(card))

  const [fromId, setFromId] = useState(sources[0]?.id ?? '')
  const [amount, setAmount] = useState(centsToEditable(owed))
  const [occurredOn, setOccurredOn] = useState(todayISO())
  const { saving, error, setError, run } = useDialogSave(onClose)

  const submit = async () => {
    if (!fromId) {
      setError('Choose the account the money leaves from')
      return
    }
    const typed = parseMoneyToCents(amount)
    if (typed === null || typed <= 0) {
      setError('Enter a payment amount')
      return
    }
    await run(() =>
      createTransaction({
        accountId: fromId,
        counterAccountId: card.id,
        kind: 'transfer',
        amountCents: typed,
        occurredOn,
        memo: `Payment · ${card.name}`,
        category: 'Credit payment'
      })
    )
  }

  return (
    <Modal
      title={`Pay ${card.name}`}
      subtitle="Recorded as a transfer: cash leaves one account and the card balance falls."
      onClose={onClose}
      footer={
        <>
          <Button variant="quiet" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={saving || sources.length === 0}>
            Record payment
          </Button>
        </>
      }
    >
      <div className="form-grid">
        <Field label="Pay from">
          <select
            className="select"
            value={fromId}
            onChange={(event) => setFromId(event.target.value)}
          >
            {sources.map((account) => (
              <option key={account.id} value={account.id}>
                {account.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Amount">
          <input
            className="input"
            autoFocus
            inputMode="decimal"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
          />
        </Field>
        <Field label="Date">
          <input
            className="input"
            type="date"
            value={occurredOn}
            onChange={(event) => setOccurredOn(event.target.value)}
          />
        </Field>
      </div>
      <p className="field-hint">
        <CreditCard size={13} />{' '}
        {creditCents > 0
          ? `The card is overpaid by ${formatMoney(creditCents, settings.currency)}.`
          : `Owed today: ${formatMoney(owed, settings.currency)}`}
      </p>
      {sources.length === 0 && (
        <p className="form-error" role="alert">
          No spendable account is available. Add or restore a checking, savings or cash account
          before paying this card.
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

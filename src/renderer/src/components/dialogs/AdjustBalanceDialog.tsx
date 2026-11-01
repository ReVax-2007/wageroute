import { useState } from 'react'
import { todayISO } from '@shared/dates'
import { centsToEditable, formatMoney, parseMoneyToCents } from '@shared/money'
import type { AccountWithBalance } from '@shared/types'
import { Button, Field, Modal } from '../ui'
import { accountDisplayBalanceCents } from '../../lib/finance'
import { useFinanceStore } from '../../store/useFinanceStore'
import { useDialogSave } from '../useDialogSave'

export function AdjustBalanceDialog({
  account,
  onClose
}: {
  account: AccountWithBalance
  onClose: () => void
}) {
  const settings = useFinanceStore((state) => state.settings)
  const adjustAccountBalance = useFinanceStore((state) => state.adjustAccountBalance)
  const isCredit = account.kind === 'credit'
  const [value, setValue] = useState(centsToEditable(accountDisplayBalanceCents(account)))
  const [occurredOn, setOccurredOn] = useState(todayISO())
  const { saving, error, setError, run } = useDialogSave(onClose)

  const submit = async () => {
    const typed = parseMoneyToCents(value)
    if (typed === null) {
      setError('Enter a balance')
      return
    }
    // A card normally holds a negative balance, so a positive "owed" entry
    // becomes money out. Typing a negative amount says the card is overpaid,
    // which is the only way to record a credit balance in its favour.
    const target = isCredit ? -typed : typed
    await run(() => adjustAccountBalance(account, target, occurredOn))
  }

  return (
    <Modal
      title={`Adjust ${account.name}`}
      subtitle="This posts one adjustment entry, so the change stays visible in the ledger."
      onClose={onClose}
      footer={
        <>
          <Button variant="quiet" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={saving}>
            Post adjustment
          </Button>
        </>
      }
    >
      <div className="form-grid">
        <Field
          label={isCredit ? 'Amount owed now' : 'Balance now'}
          hint={isCredit ? 'Enter a negative amount if the card is overpaid' : undefined}
        >
          <input
            className="input"
            autoFocus
            inputMode="decimal"
            value={value}
            onChange={(event) => setValue(event.target.value)}
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
        Current {isCredit ? 'owed' : 'balance'}:{' '}
        {formatMoney(accountDisplayBalanceCents(account), settings.currency)}
      </p>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </Modal>
  )
}

import { useState } from 'react'
import { isUsableAccount, usableLabel } from '@shared/accounts'
import { todayISO } from '@shared/dates'
import { centsToEditable, formatMoney, parseMoneyToCents } from '@shared/money'
import type { Bill } from '@shared/types'
import { billVariance } from '@shared/variableBills'
import { Button, Field, Modal, MoneyInput } from '../ui'
import { confirmFloor } from '../../lib/finance'
import { useFinanceStore } from '../../store/useFinanceStore'
import { useDialogSave } from '../useDialogSave'

/**
 * "It cleared, and it came to…" for a variable bill, from the Bills screen. The
 * amount starts at the estimate, so an unchanged bill is one click; the line
 * under it says where the difference goes (ADR 0036).
 */
export function BillClearedDialog({ bill, onClose }: { bill: Bill; onClose: () => void }) {
  const snapshot = useFinanceStore((state) => state.snapshot)
  const createTransaction = useFinanceStore((state) => state.createTransaction)
  const askConfirm = useFinanceStore((state) => state.askConfirm)
  const currency = useFinanceStore((state) => state.settings.currency)

  const accounts = (snapshot?.accounts ?? []).filter(isUsableAccount)
  // The bill's own account when it is still open, else the checking account
  // the prompt card would fall back to.
  const defaultAccount =
    accounts.find((account) => account.id === bill.accountId) ??
    (bill.accountId ? undefined : (accounts.find((a) => a.kind === 'checking') ?? accounts[0]))
  const [amount, setAmount] = useState(centsToEditable(bill.amountCents))
  const [accountId, setAccountId] = useState(defaultAccount?.id ?? '')
  const [occurredOn, setOccurredOn] = useState(todayISO())
  const { saving, error, setError, run } = useDialogSave(onClose)

  const typed = parseMoneyToCents(amount)
  const variance = typed !== null && typed > 0 ? billVariance(bill.amountCents, typed) : null
  const account = accounts.find((item) => item.id === accountId)

  const submit = async () => {
    if (typed === null || typed <= 0) {
      setError('Enter what the bill came to')
      return
    }
    if (!account) {
      setError('Pick an account')
      return
    }
    if (occurredOn > todayISO()) {
      setError('Choose a date up to today')
      return
    }
    if (!(await confirmFloor(askConfirm, account, -typed, currency))) return
    await run(() =>
      createTransaction({
        accountId: account.id,
        kind: 'bill_payment',
        amountCents: -typed,
        occurredOn,
        memo: bill.name,
        category: bill.category,
        billId: bill.id
      })
    )
  }

  return (
    <Modal
      title={`Did your ${bill.name} clear?`}
      subtitle={`Estimate ${formatMoney(bill.amountCents, currency)} · change it if the bill was different.`}
      onClose={onClose}
      footer={
        <>
          <Button variant="quiet" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={saving || !account}>
            Yes, it cleared
          </Button>
        </>
      }
    >
      <form
        className="form-grid"
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
      >
        <Field
          label="It came to"
          hint={
            variance === null
              ? undefined
              : variance.underCents > 0
                ? `${formatMoney(variance.underCents, currency)} under the estimate · back to Left to spend`
                : variance.overCents > 0
                  ? `${formatMoney(variance.overCents, currency)} over the estimate`
                  : 'Exactly the estimate'
          }
        >
          <MoneyInput value={amount} onValueChange={setAmount} autoFocus />
        </Field>
        <Field label="Paid from" hint={(account ? usableLabel(account, currency) : null) ?? undefined}>
          <select
            className="select"
            value={accountId}
            onChange={(event) => setAccountId(event.target.value)}
          >
            {!account && <option value="">Choose an account…</option>}
            {accounts.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Date">
          <input
            className="input"
            type="date"
            value={occurredOn}
            max={todayISO()}
            onChange={(event) => setOccurredOn(event.target.value)}
          />
        </Field>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" style={{ display: 'none' }} tabIndex={-1} aria-hidden="true" />
      </form>
    </Modal>
  )
}

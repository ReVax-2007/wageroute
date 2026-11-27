import { useState } from 'react'
import { isUsableAccount, usableLabel } from '@shared/accounts'
import { todayISO } from '@shared/dates'
import { centsToEditable, formatMoney, parseMoneyToCents } from '@shared/money'
import type { Bill } from '@shared/types'
import { oneTimeCloseAtCents } from '@shared/oneTimeBills'
import { billVariance } from '@shared/variableBills'
import { Button, Field, Modal, MoneyInput } from '../ui'
import { confirmFloor } from '../../lib/finance'
import { useFinanceStore } from '../../store/useFinanceStore'
import { useDialogSave } from '../useDialogSave'

/**
 * "It cleared, and it came to…" for a variable bill, from the Bills screen. The
 * amount starts at the estimate, so an unchanged bill is one click; the line
 * under it says where the difference goes (ADR 0036).
 *
 * A fixed one-time bill uses the same dialog to be paid (ADR 0037): the amount
 * starts at what is still open, and a payment that covers it makes the bill done.
 * It can be paid in parts, and "that was the last one" closes it at what was
 * actually paid when the parts came in under the amount.
 */
export function BillClearedDialog({ bill, onClose }: { bill: Bill; onClose: () => void }) {
  const snapshot = useFinanceStore((state) => state.snapshot)
  const createTransaction = useFinanceStore((state) => state.createTransaction)
  const updateBill = useFinanceStore((state) => state.updateBill)
  const askConfirm = useFinanceStore((state) => state.askConfirm)
  const currency = useFinanceStore((state) => state.settings.currency)

  const accounts = (snapshot?.accounts ?? []).filter(isUsableAccount)
  // The bill's own account when it is still open, else the checking account
  // the prompt card would fall back to.
  const defaultAccount =
    accounts.find((account) => account.id === bill.accountId) ??
    (bill.accountId ? undefined : (accounts.find((a) => a.kind === 'checking') ?? accounts[0]))
  const fixedOneTime = bill.frequency === 'once' && !bill.isVariable
  const paidSoFar = fixedOneTime
    ? Math.max(
        0,
        snapshot?.billPaymentsThisMonth.find((row) => row.billId === bill.id)?.paidCents ?? 0
      )
    : 0
  const openCents = Math.max(0, bill.amountCents - paidSoFar)
  const [amount, setAmount] = useState(
    centsToEditable(fixedOneTime ? openCents || bill.amountCents : bill.amountCents)
  )
  const [accountId, setAccountId] = useState(defaultAccount?.id ?? '')
  const [occurredOn, setOccurredOn] = useState(todayISO())
  const [last, setLast] = useState(false)
  const { saving, error, setError, run } = useDialogSave(onClose)

  const typed = parseMoneyToCents(amount)
  const variance =
    typed !== null && typed > 0 ? billVariance(fixedOneTime ? openCents : bill.amountCents, typed) : null
  const account = accounts.find((item) => item.id === accountId)
  const typedPositive = typed !== null && typed > 0 ? typed : null
  const closeAtCents = fixedOneTime ? oneTimeCloseAtCents(bill, paidSoFar + (typedPositive ?? 0)) : null
  const closing = last && closeAtCents !== null
  // Nothing more bought: closing at what was already paid needs no payment.
  const closeOnly = closing && typedPositive === null

  const submit = async () => {
    if (closeOnly && closeAtCents !== null) {
      await run(() => updateBill(bill.id, { amountCents: closeAtCents }))
      return
    }
    if (typed === null || typed <= 0) {
      setError(fixedOneTime ? 'Enter what you paid' : 'Enter what the bill came to')
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
    await run(async () => {
      const paid = await createTransaction({
        accountId: account.id,
        kind: 'bill_payment',
        amountCents: -typed,
        occurredOn,
        memo: bill.name,
        category: bill.category,
        billId: bill.id
      })
      // The payment is saved first; if the close then fails, the dialog stays
      // open with the bill still asking for the rest, and closing again works.
      if (!paid || !closing || closeAtCents === null) return paid
      return updateBill(bill.id, { amountCents: closeAtCents })
    })
  }

  return (
    <Modal
      title={fixedOneTime ? `Pay ${bill.name}` : `Did your ${bill.name} clear?`}
      subtitle={
        fixedOneTime
          ? paidSoFar > 0
            ? `One time · ${formatMoney(paidSoFar, currency)} paid, ${formatMoney(openCents, currency)} still open. Pay in parts; once it is covered the bill is done.`
            : `One time · ${formatMoney(openCents, currency)} still to pay. Pay in parts if you like; once it is covered the bill is done.`
          : `Estimate ${formatMoney(bill.amountCents, currency)} · change it if the bill was different.`
      }
      onClose={onClose}
      footer={
        <>
          <Button variant="quiet" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={saving || (!account && !closeOnly)}>
            {closeOnly ? 'Close the bill' : fixedOneTime ? 'Record payment' : 'Yes, it cleared'}
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
          label={fixedOneTime ? 'Paid now' : 'It came to'}
          hint={
            variance === null
              ? fixedOneTime && paidSoFar > 0
                ? 'Leave it blank and tick below to just close the bill'
                : undefined
              : fixedOneTime
                ? variance.underCents > 0
                  ? `${formatMoney(variance.underCents, currency)} still open after this`
                  : 'This pays it off'
              : variance.underCents > 0
                ? `${formatMoney(variance.underCents, currency)} under the estimate · back to Left to spend`
                : variance.overCents > 0
                  ? `${formatMoney(variance.overCents, currency)} over the estimate`
                  : 'Exactly the estimate'
          }
        >
          <MoneyInput value={amount} onValueChange={setAmount} autoFocus />
        </Field>
        {fixedOneTime && (closeAtCents !== null || last) && (
          <label className="check span-2">
            <input
              type="checkbox"
              checked={last}
              onChange={(event) => setLast(event.target.checked)}
            />
            {closeAtCents !== null
              ? `That was the last one: close the bill at ${formatMoney(closeAtCents, currency)} (${formatMoney(bill.amountCents - closeAtCents, currency)} back to Left to spend)`
              : 'That was the last one'}
          </label>
        )}
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

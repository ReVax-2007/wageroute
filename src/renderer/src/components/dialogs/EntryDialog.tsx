import { useState } from 'react'
import { todayISO } from '@shared/dates'
import { parseMoneyToCents } from '@shared/money'
import type { TransactionInput, TransactionKind } from '@shared/types'
import { CategoryInput } from '../CategoryInput'
import { Button, Field, Modal, MoneyInput } from '../ui'
import { TRANSACTION_KIND_LABEL } from '../../lib/finance'
import { useFinanceStore } from '../../store/useFinanceStore'
import { useDialogSave } from '../useDialogSave'

// A bill payment or goal funding is only meaningful when it names the record it
// settled, so those kinds carry a picker. Everything else is a plain movement.
const KINDS = Object.keys(TRANSACTION_KIND_LABEL) as TransactionKind[]

export function EntryDialog({ onClose }: { onClose: () => void }) {
  const snapshot = useFinanceStore((state) => state.snapshot)
  const createTransaction = useFinanceStore((state) => state.createTransaction)

  const accounts = (snapshot?.accounts ?? []).filter((account) => !account.isArchived)
  const bills = snapshot?.bills ?? []
  const goals = (snapshot?.goals ?? []).filter((goal) => !goal.isArchived)
  const [form, setForm] = useState({
    occurredOn: todayISO(),
    accountId: accounts[0]?.id ?? '',
    counterAccountId: '',
    kind: 'expense' as TransactionKind,
    amount: '',
    category: 'Misc',
    categoryId: null as string | null,
    billId: '',
    goalId: '',
    memo: ''
  })
  const { saving, error, setError, run } = useDialogSave(onClose)

  // Switching away from a bill or goal drops the link: the kind is what gives
  // the reference its meaning, and a hidden stale id would be posted silently.
  const setKind = (kind: TransactionKind) => {
    setForm((current) => ({ ...current, kind, billId: '', goalId: '' }))
  }

  const submit = async () => {
    const typed = parseMoneyToCents(form.amount)
    if (!form.accountId) {
      setError('Pick an account')
      return
    }
    if (typed === null || typed === 0) {
      setError('Enter an amount')
      return
    }
    if (form.kind === 'bill_payment' && !form.billId) {
      setError('Choose the bill this payment covers')
      return
    }
    if (form.kind === 'goal_funding' && !form.goalId) {
      setError('Choose the goal this funds')
      return
    }
    if (form.kind === 'transfer') {
      if (!form.counterAccountId) {
        setError('Choose the destination account')
        return
      }
      if (form.counterAccountId === form.accountId) {
        setError('Choose two different accounts')
        return
      }
    }

    // Amounts are stored as signed cents; the kind decides the default direction.
    const magnitude = Math.abs(typed)
    const amountCents =
      form.kind === 'income'
        ? magnitude
        : form.kind === 'adjustment'
          ? typed
          : -magnitude

    const input: TransactionInput = {
      accountId: form.accountId,
      kind: form.kind,
      amountCents,
      occurredOn: form.occurredOn,
      category: form.category.trim() || 'Misc',
      categoryId: form.category.trim() ? form.categoryId : null,
      memo: form.memo.trim(),
      counterAccountId: form.kind === 'transfer' ? form.counterAccountId : null,
      billId: form.kind === 'bill_payment' ? form.billId : null,
      goalId: form.kind === 'goal_funding' ? form.goalId : null
    }

    await run(() => createTransaction(input))
  }

  const signHint =
    form.kind === 'income'
      ? 'Recorded as money in, even if you type a minus sign.'
      : form.kind === 'adjustment'
        ? 'Keeps the sign you type: negative lowers the balance.'
        : form.kind === 'transfer'
          ? 'Moves the amount from this account to the one below.'
          : 'Recorded as money out, even if you type a minus sign.'

  return (
    <Modal
      title="Add a ledger entry"
      subtitle="Manual entry only — nothing is imported from a bank."
      onClose={onClose}
      footer={
        <>
          <Button variant="quiet" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={saving}>
            Add entry
          </Button>
        </>
      }
    >
      <div className="form-grid">
        <Field label="Date">
          <input
            className="input"
            type="date"
            value={form.occurredOn}
            onChange={(event) => setForm({ ...form, occurredOn: event.target.value })}
          />
        </Field>
        <Field label="Account">
          <select
            className="select"
            value={form.accountId}
            onChange={(event) => setForm({ ...form, accountId: event.target.value })}
          >
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Kind">
          <select
            className="select"
            value={form.kind}
            onChange={(event) => setKind(event.target.value as TransactionKind)}
          >
            {KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {TRANSACTION_KIND_LABEL[kind]}
              </option>
            ))}
          </select>
        </Field>
        {form.kind === 'bill_payment' && (
          <Field
            label="Bill"
            hint="Closes this bill's reservation and stops its reminder"
          >
            <select
              className="select"
              value={form.billId}
              onChange={(event) => setForm({ ...form, billId: event.target.value })}
            >
              <option value="">Choose a bill…</option>
              {bills.map((bill) => (
                <option key={bill.id} value={bill.id}>
                  {bill.name}
                  {bill.isActive ? '' : ' (inactive)'}
                </option>
              ))}
            </select>
          </Field>
        )}
        {form.kind === 'goal_funding' && (
          <Field
            label="Goal"
            hint="A label on the entry; progress still follows the goal's own accounts"
          >
            <select
              className="select"
              value={form.goalId}
              onChange={(event) => setForm({ ...form, goalId: event.target.value })}
            >
              <option value="">Choose a goal…</option>
              {goals.map((goal) => (
                <option key={goal.id} value={goal.id}>
                  {goal.name}
                </option>
              ))}
            </select>
          </Field>
        )}
        {form.kind === 'transfer' && (
          <Field label="To account" hint="The other side of the transfer">
            <select
              className="select"
              value={form.counterAccountId}
              onChange={(event) => setForm({ ...form, counterAccountId: event.target.value })}
            >
              <option value="">Choose an account…</option>
              {accounts
                .filter((account) => account.id !== form.accountId)
                .map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.name}
                  </option>
                ))}
            </select>
          </Field>
        )}
        <Field label="Amount" hint={signHint}>
          <MoneyInput
            autoFocus
            allowNegative={form.kind === 'adjustment'}
            value={form.amount}
            placeholder="42.50"
            onValueChange={(amount) => setForm({ ...form, amount })}
          />
        </Field>
        <Field
          label="Category"
          hint="Pick one you already use, or name a new one"
        >
          <CategoryInput
            listId="entry-category-options"
            value={form.category}
            onChange={(category, categoryId) => setForm({ ...form, category, categoryId })}
          />
        </Field>
        <Field label="Description" hint="Shown in the ledger and the dashboard feed">
          <input
            className="input"
            value={form.memo}
            placeholder="Groceries"
            onChange={(event) => setForm({ ...form, memo: event.target.value })}
          />
        </Field>
      </div>

      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </Modal>
  )
}

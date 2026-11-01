import { useState } from 'react'
import { categoryKey } from '@shared/categories'
import { todayISO } from '@shared/dates'
import { parseMoneyToCents } from '@shared/money'
import type { TransactionInput, TransactionKind } from '@shared/types'
import { Button, Field, Modal } from '../ui'
import { TRANSACTION_KIND_LABEL } from '../../lib/finance'
import { useFinanceStore } from '../../store/useFinanceStore'
import { useDialogSave } from '../useDialogSave'

// A manual entry carries no bill or goal, so the two kinds whose meaning is
// "close that reservation" or "fund that goal" stay with the flows that know
// which record is being paid — the Priority Wall prompt and the goal card.
const KINDS = (Object.keys(TRANSACTION_KIND_LABEL) as TransactionKind[]).filter(
  (kind) => kind !== 'bill_payment' && kind !== 'goal_funding'
)

export function EntryDialog({ onClose }: { onClose: () => void }) {
  const snapshot = useFinanceStore((state) => state.snapshot)
  const createTransaction = useFinanceStore((state) => state.createTransaction)

  const accounts = (snapshot?.accounts ?? []).filter((account) => !account.isArchived)
  const categories = snapshot?.categories ?? []
  const [form, setForm] = useState({
    occurredOn: todayISO(),
    accountId: accounts[0]?.id ?? '',
    counterAccountId: '',
    kind: 'expense' as TransactionKind,
    amount: '',
    category: 'Misc',
    categoryId: null as string | null,
    memo: ''
  })
  const { saving, error, setError, run } = useDialogSave(onClose)

  const setCategory = (value: string) => {
    const match = categories.find((category) => categoryKey(category.name) === categoryKey(value))
    setForm((current) => ({ ...current, category: value, categoryId: match?.id ?? null }))
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
      counterAccountId: form.kind === 'transfer' ? form.counterAccountId : null
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
            onChange={(event) =>
              setForm({ ...form, kind: event.target.value as TransactionKind })
            }
          >
            {KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {TRANSACTION_KIND_LABEL[kind]}
              </option>
            ))}
          </select>
        </Field>
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
          <input
            className="input"
            autoFocus
            inputMode="decimal"
            value={form.amount}
            placeholder="42.50"
            onChange={(event) => setForm({ ...form, amount: event.target.value })}
          />
        </Field>
        <Field
          label="Category"
          hint="Pick one you already use, or name a new one"
        >
          <input
            className="input"
            list="entry-category-options"
            value={form.category}
            onChange={(event) => setCategory(event.target.value)}
          />
          <datalist id="entry-category-options">
            {categories.map((category) => (
              <option key={category.id} value={category.name} />
            ))}
          </datalist>
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

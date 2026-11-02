import { useState } from 'react'
import { categoryKey } from '@shared/categories'
import { todayISO } from '@shared/dates'
import { parseMoneyToCents } from '@shared/money'
import { Button, Field, Modal, MoneyInput } from '../ui'
import { useFinanceStore } from '../../store/useFinanceStore'
import { useDialogSave } from '../useDialogSave'

/**
 * One-time income lands in an account but never enters the allocator: it is
 * money you did not plan for, so it should not rewrite the wall or the splits.
 * Paycheck income stays on the routing path.
 */
export function IncomeDialog({ onClose }: { onClose: () => void }) {
  const snapshot = useFinanceStore((state) => state.snapshot)
  const createTransaction = useFinanceStore((state) => state.createTransaction)

  const accounts = (snapshot?.accounts ?? []).filter(
    (account) =>
      !account.isArchived && (account.kind === 'checking' || account.kind === 'savings' || account.kind === 'cash')
  )
  const incomeCategory =
    snapshot?.categories.find((category) => categoryKey(category.name) === categoryKey('Income')) ??
    null

  const [form, setForm] = useState({
    occurredOn: todayISO(),
    accountId: accounts[0]?.id ?? '',
    amount: '',
    memo: ''
  })
  const { saving, error, setError, run } = useDialogSave(onClose)

  const submit = async () => {
    const typed = parseMoneyToCents(form.amount)
    if (!form.accountId) {
      setError('Pick the account the money landed in')
      return
    }
    if (typed === null || typed <= 0) {
      setError('Enter an amount above zero')
      return
    }
    await run(() =>
      createTransaction({
        accountId: form.accountId,
        kind: 'income',
        amountCents: typed,
        occurredOn: form.occurredOn,
        category: incomeCategory?.name ?? 'Income',
        categoryId: incomeCategory?.id ?? null,
        memo: form.memo.trim() || 'One-time income',
        counterAccountId: null
      })
    )
  }

  return (
    <Modal
      title="Add one-time income"
      subtitle="Record money that is not a paycheck. It changes the account balance and stays out of routing."
      onClose={onClose}
      footer={
        <>
          <Button variant="quiet" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={saving || accounts.length === 0}>
            Add income
          </Button>
        </>
      }
    >
      <div className="form-grid">
        <Field label="Amount">
          <MoneyInput
            autoFocus
            value={form.amount}
            placeholder="250.00"
            onValueChange={(amount) => setForm({ ...form, amount })}
          />
        </Field>
        <Field label="Date">
          <input
            className="input"
            type="date"
            value={form.occurredOn}
            onChange={(event) => setForm({ ...form, occurredOn: event.target.value })}
          />
        </Field>
        <Field label="Landed in" wide>
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
        <Field
          label="What was it?"
          wide
          hint="A gift, a tax refund, something you sold — this is the description in the ledger"
        >
          <input
            className="input"
            maxLength={80}
            value={form.memo}
            placeholder="Tax refund"
            onChange={(event) => setForm({ ...form, memo: event.target.value })}
          />
        </Field>
      </div>

      {accounts.length === 0 && (
        <p className="form-error" role="alert">
          No checking, savings or cash account is available to receive the money.
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

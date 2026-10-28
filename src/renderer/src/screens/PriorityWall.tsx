import { useState } from 'react'
import { Pencil, Plus, ShieldCheck, Trash2 } from 'lucide-react'
import {
  FREQUENCY_LABEL,
  PAY_CADENCE_LABEL,
  monthlyEquivalentCents,
  reservePerPaycheckCents
} from '@shared/cadence'
import { centsToEditable, parseMoneyToCents } from '@shared/money'
import type { Bill, BillInput, Frequency } from '@shared/types'
import { Button, Card, EmptyState, Field, IconButton, Modal, Money } from '../components/ui'
import { activeBills, monthlyWall, perPaycheckWall } from '../lib/finance'
import { useFinanceStore } from '../store/useFinanceStore'

const FREQUENCIES = Object.keys(FREQUENCY_LABEL) as Frequency[]

function ordinal(day: number): string {
  const mod100 = day % 100
  if (mod100 >= 11 && mod100 <= 13) return `${day}th`
  switch (day % 10) {
    case 1:
      return `${day}st`
    case 2:
      return `${day}nd`
    case 3:
      return `${day}rd`
    default:
      return `${day}th`
  }
}

export function PriorityWall() {
  const snapshot = useFinanceStore((state) => state.snapshot)
  const settings = useFinanceStore((state) => state.settings)
  const updateBill = useFinanceStore((state) => state.updateBill)
  const deleteBill = useFinanceStore((state) => state.deleteBill)
  const [editing, setEditing] = useState<Bill | null | 'new'>(null)

  if (!snapshot) return null

  const currency = settings.currency
  const bills = snapshot.bills
  const active = activeBills(bills)
  const monthly = monthlyWall(active)
  const perCheck = perPaycheckWall(active, settings.payCadence)
  const lastIncome = snapshot.paychecks[0]?.amountCents ?? 0
  const shareOfPaycheck = lastIncome > 0 ? Math.round((perCheck / lastIncome) * 100) : null

  const remove = (bill: Bill) => {
    if (window.confirm(`Remove "${bill.name}" from the Priority Wall?`)) {
      void deleteBill(bill.id)
    }
  }

  return (
    <>
      <header className="page-head">
        <div>
          <p className="eyebrow">Priority Wall</p>
          <h1 className="page-title">Bills you cannot touch</h1>
          <p className="page-sub">
            These amounts are locked out of the surplus before a single dollar is routed.
          </p>
        </div>
        <Button variant="primary" icon={<Plus size={16} />} onClick={() => setEditing('new')}>
          Add a bill
        </Button>
      </header>

      <div className="summary-strip">
        <div className="summary-item">
          <span className="stat-label">Locked every month</span>
          <p className="summary-value">
            <Money cents={monthly} currency={currency} />
          </p>
          <span className="stat-hint">Smoothed across cadences</span>
        </div>
        <div className="summary-item">
          <span className="stat-label">Reserved per paycheck</span>
          <p className="summary-value">
            <Money cents={perCheck} currency={currency} />
          </p>
          <span className="stat-hint">{PAY_CADENCE_LABEL[settings.payCadence]} pay cycle</span>
        </div>
        <div className="summary-item">
          <span className="stat-label">Active bills</span>
          <p className="summary-value">{active.length}</p>
          <span className="stat-hint">
            {bills.length - active.length} paused
            {shareOfPaycheck !== null ? ` · ${shareOfPaycheck}% of last paycheck` : ''}
          </span>
        </div>
      </div>

      <Card
        title="The wall"
        subtitle="Paused bills stay in your history but stop reserving money"
      >
        {bills.length === 0 ? (
          <EmptyState
            icon={<ShieldCheck size={20} />}
            title="The wall is empty"
            body="Add rent, utilities and subscriptions so the allocator protects them first."
            action={
              <Button variant="primary" onClick={() => setEditing('new')}>
                Add your first bill
              </Button>
            }
          />
        ) : (
          <table className="table wall-table">
            <thead>
              <tr>
                <th>Bill</th>
                <th>Amount</th>
                <th>Cadence</th>
                <th>Due</th>
                <th className="right">Per paycheck</th>
                <th className="right">Monthly</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {bills.map((bill) => (
                <tr key={bill.id} className={bill.isActive ? undefined : 'inactive'}>
                  <td>
                    <div className="cell-strong">{bill.name}</div>
                    <div className="cell-sub">
                      {bill.category}
                      {bill.autopay ? ' · autopay' : ''}
                    </div>
                  </td>
                  <td>
                    <Money cents={bill.amountCents} currency={currency} />
                  </td>
                  <td className="muted">{FREQUENCY_LABEL[bill.frequency]}</td>
                  <td className="muted">{ordinal(bill.dueDay)}</td>
                  <td className="right">
                    <Money
                      cents={reservePerPaycheckCents(
                        bill.amountCents,
                        bill.frequency,
                        settings.payCadence
                      )}
                      currency={currency}
                    />
                  </td>
                  <td className="right muted">
                    <Money
                      cents={monthlyEquivalentCents(bill.amountCents, bill.frequency)}
                      currency={currency}
                    />
                  </td>
                  <td>
                    <div className="row-actions">
                      <button
                        type="button"
                        className={bill.isActive ? 'switch on' : 'switch'}
                        aria-pressed={bill.isActive}
                        aria-label={bill.isActive ? 'Pause bill' : 'Resume bill'}
                        title={bill.isActive ? 'Pause bill' : 'Resume bill'}
                        onClick={() => void updateBill(bill.id, { isActive: !bill.isActive })}
                      >
                        <span className="switch-knob" />
                      </button>
                      <IconButton label="Edit bill" onClick={() => setEditing(bill)}>
                        <Pencil size={15} />
                      </IconButton>
                      <IconButton label="Remove bill" danger onClick={() => remove(bill)}>
                        <Trash2 size={15} />
                      </IconButton>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <p className="footnote">
        Monthly figures are annualised and divided by twelve, so a $600 yearly insurance premium
        counts as $50 of obligation every month.
      </p>

      {editing !== null && (
        <BillDialog bill={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />
      )}
    </>
  )
}

function BillDialog({ bill, onClose }: { bill: Bill | null; onClose: () => void }) {
  const snapshot = useFinanceStore((state) => state.snapshot)
  const createBill = useFinanceStore((state) => state.createBill)
  const updateBill = useFinanceStore((state) => state.updateBill)

  const accounts = snapshot?.accounts ?? []
  const [form, setForm] = useState({
    name: bill?.name ?? '',
    amount: bill ? centsToEditable(bill.amountCents) : '',
    frequency: bill?.frequency ?? ('monthly' as Frequency),
    dueDay: bill ? String(bill.dueDay) : '1',
    category: bill?.category ?? 'Bills',
    accountId: bill?.accountId ?? accounts[0]?.id ?? '',
    autopay: bill?.autopay ?? true,
    isActive: bill?.isActive ?? true
  })
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const submit = async () => {
    const amountCents = parseMoneyToCents(form.amount)
    if (!form.name.trim()) {
      setError('Give the bill a name')
      return
    }
    if (amountCents === null || amountCents <= 0) {
      setError('Enter an amount greater than zero')
      return
    }

    const input: BillInput = {
      name: form.name.trim(),
      amountCents,
      frequency: form.frequency,
      dueDay: Number(form.dueDay) || 1,
      category: form.category.trim() || 'Bills',
      accountId: form.accountId || null,
      autopay: form.autopay,
      isActive: form.isActive,
      nextDueOn: bill?.nextDueOn ?? null
    }

    setSaving(true)
    if (bill) {
      await updateBill(bill.id, input)
    } else {
      await createBill(input)
    }
    setSaving(false)
    onClose()
  }

  return (
    <Modal
      title={bill ? 'Edit bill' : 'Lock in a bill'}
      subtitle="This money leaves the surplus before anything else is routed."
      onClose={onClose}
      footer={
        <>
          <Button variant="quiet" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={saving}>
            {bill ? 'Save bill' : 'Add to the wall'}
          </Button>
        </>
      }
    >
      <div className="form-grid">
        <Field label="Bill name" wide>
          <input
            className="input"
            autoFocus
            value={form.name}
            placeholder="Rent"
            onChange={(event) => setForm({ ...form, name: event.target.value })}
          />
        </Field>
        <Field label="Amount">
          <input
            className="input"
            inputMode="decimal"
            value={form.amount}
            placeholder="1,850.00"
            onChange={(event) => setForm({ ...form, amount: event.target.value })}
          />
        </Field>
        <Field label="Cadence">
          <select
            className="select"
            value={form.frequency}
            onChange={(event) =>
              setForm({ ...form, frequency: event.target.value as Frequency })
            }
          >
            {FREQUENCIES.map((frequency) => (
              <option key={frequency} value={frequency}>
                {FREQUENCY_LABEL[frequency]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Due day" hint="Day of the month the bill lands">
          <input
            className="input"
            type="number"
            min={1}
            max={31}
            value={form.dueDay}
            onChange={(event) => setForm({ ...form, dueDay: event.target.value })}
          />
        </Field>
        <Field label="Category">
          <input
            className="input"
            value={form.category}
            onChange={(event) => setForm({ ...form, category: event.target.value })}
          />
        </Field>
        <Field label="Paid from" wide>
          <select
            className="select"
            value={form.accountId}
            onChange={(event) => setForm({ ...form, accountId: event.target.value })}
          >
            <option value="">No account selected</option>
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.name}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <div className="check-row">
        <label className="check">
          <input
            type="checkbox"
            checked={form.autopay}
            onChange={(event) => setForm({ ...form, autopay: event.target.checked })}
          />
          Autopay
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={form.isActive}
            onChange={(event) => setForm({ ...form, isActive: event.target.checked })}
          />
          Reserve money from every paycheck
        </label>
      </div>

      {error && <p className="form-error">{error}</p>}
    </Modal>
  )
}

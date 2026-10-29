import { useState } from 'react'
import { Pencil, Plus, ShieldCheck, Trash2 } from 'lucide-react'
import {
  BILL_FUNDING_STRATEGY_LABEL,
  FREQUENCY_LABEL,
  PAY_CADENCE_LABEL,
  billFundingReserveCents,
  fundingCheckIndex,
  monthlyEquivalentCents,
  nextPaydayISO,
  reachableCheckIndexes,
  reservePerPaycheckCents
} from '@shared/cadence'
import { formatDateLabel, todayISO } from '@shared/dates'
import { centsToEditable, formatMoney, parseMoneyToCents } from '@shared/money'
import type { Bill, BillFundingStrategy, BillInput, Frequency, PayCadence } from '@shared/types'
import { Button, Card, EmptyState, Field, IconButton, Modal, Money } from '../components/ui'
import { activeBills, monthlyWall, perPaycheckWall } from '../lib/finance'
import { useFinanceStore } from '../store/useFinanceStore'

const FREQUENCIES = Object.keys(FREQUENCY_LABEL) as Frequency[]
const FUNDING_STRATEGIES = Object.keys(BILL_FUNDING_STRATEGY_LABEL) as BillFundingStrategy[]

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

/** Which paycheck of the month actually reserves for this bill; null for 'all_checks'. */
function fundingCheckFor(bill: Bill, cadence: PayCadence): number | null {
  return fundingCheckIndex({
    cadence,
    dueDay: bill.dueDay,
    fundingStrategy: bill.fundingStrategy,
    fundingPaycheckIndex: bill.fundingPaycheckIndex
  })
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
  const payday = settings.paydayLabel.trim()
  const anchor = settings.payAnchorDate
  const nextCheck = anchor
    ? nextPaydayISO(todayISO(), settings.payCadence, anchor)
    : null
  const monthlyKey = todayISO().slice(0, 7)
  const reservesThisMonth = snapshot.billReserves.filter(
    (reserve) => reserve.cycle === monthlyKey
  )
  const reserveStateOf = (billId: string): 'paid' | 'reserved' | null => {
    const rows = reservesThisMonth.filter((reserve) => reserve.billId === billId)
    if (rows.some((reserve) => reserve.state === 'paid')) return 'paid'
    return rows.length > 0 ? 'reserved' : null
  }
  const nextCheckReserve = (bill: Bill): number =>
    billFundingReserveCents({
      amountCents: bill.amountCents,
      frequency: bill.frequency,
      cadence: settings.payCadence,
      dueDay: bill.dueDay,
      fundingStrategy: bill.fundingStrategy,
      fundingPaycheckIndex: bill.fundingPaycheckIndex,
      paycheckDate: nextCheck,
      payAnchorDate: anchor
    })
  const nextCheckTotal = nextCheck
    ? active.reduce((total, bill) => total + nextCheckReserve(bill), 0)
    : null
  const lastIncome = snapshot.paychecks[0]?.amountCents ?? 0
  const shareOfPaycheck =
    lastIncome > 0 && nextCheckTotal !== null
      ? Math.round((nextCheckTotal / lastIncome) * 100)
      : null

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
          <span className="stat-hint">
            {reservesThisMonth.length > 0
              ? `${formatMoney(
                  reservesThisMonth.reduce((total, reserve) => total + reserve.amountCents, 0),
                  currency
                )} reserved this month · ${reservesThisMonth.filter((reserve) => reserve.state === 'paid').length} paid`
              : 'Smoothed across cadences'}
          </span>
        </div>
        <div className="summary-item">
          <span className="stat-label">
            {nextCheck ? 'Reserved on the next check' : 'Reserved per paycheck'}
          </span>
          <p className="summary-value">
            <Money cents={nextCheckTotal ?? perCheck} currency={currency} />
          </p>
          <span className="stat-hint">
            {nextCheck
              ? `${formatDateLabel(nextCheck)} · ${PAY_CADENCE_LABEL[settings.payCadence]}`
              : `${PAY_CADENCE_LABEL[settings.payCadence]} pay cycle${payday ? ` · ${payday}` : ''}`}
            {' · '}
            averages <Money cents={perCheck} currency={currency} /> per check
          </span>
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
          <div className="table-scroll">
            <table className="table wall-table">
              <thead>
                <tr>
                  <th>Bill</th>
                  <th>Amount</th>
                  <th>Cadence</th>
                  <th>Due</th>
                  <th className="right">{nextCheck ? 'Next check' : 'Per paycheck'}</th>
                  <th className="right">Monthly</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {bills.map((bill) => (
                  <tr key={bill.id} className={bill.isActive ? undefined : 'inactive'}>
                    <td>
                      <div className="cell-strong" title={bill.name}>
                        {bill.name}
                      </div>
                    <div className="cell-sub">
                      {bill.category}
                      {bill.autopay ? ' · autopay' : ''}
                      {reserveStateOf(bill.id) === 'paid' && (
                        <span className="chip chip-quiet">Paid this month</span>
                      )}
                      {reserveStateOf(bill.id) === 'reserved' && (
                        <span className="chip chip-quiet">Reserved this month</span>
                      )}
                      {!bill.isActive && <span className="chip chip-quiet chip-inactive">Bill inactive</span>}
                    </div>
                  </td>
                  <td>
                    <Money cents={bill.amountCents} currency={currency} />
                  </td>
                  <td className="muted">{FREQUENCY_LABEL[bill.frequency]}</td>
                  <td className="muted">{ordinal(bill.dueDay)}</td>
                  <td className="right">
                    <Money
                      cents={
                        nextCheck
                          ? nextCheckReserve(bill)
                          : bill.fundingStrategy === 'all_checks'
                            ? reservePerPaycheckCents(
                                bill.amountCents,
                                bill.frequency,
                                settings.payCadence
                              )
                            : monthlyEquivalentCents(bill.amountCents, bill.frequency)
                      }
                      currency={currency}
                    />
                    {bill.fundingStrategy !== 'all_checks' && (
                      <div className="cell-sub chip-funding">
                        {ordinal(fundingCheckFor(bill, settings.payCadence) ?? 1)} check
                        {nextCheck ? ' of the month' : ' only'}
                      </div>
                    )}
                  </td>
                  <td className="right muted">
                    <Money
                      cents={monthlyEquivalentCents(bill.amountCents, bill.frequency)}
                      currency={currency}
                    />
                  </td>
                  <td>
                    <div className="row-actions">
                      {!bill.isActive && (
                        <Button
                          size="sm"
                          variant="quiet"
                          onClick={() => void updateBill(bill.id, { isActive: true })}
                        >
                          Resume bill
                        </Button>
                      )}
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
          </div>
        )}
      </Card>

      <p className="footnote">
        Monthly figures are annualised and divided by twelve, so a $600 yearly insurance premium
        counts as $50 of obligation every month. A bill funded on one check reserves that whole
        month on its check. Set a known payday in Settings and the wall shows the exact reserve
        for the next real check instead of an average.
      </p>

      {editing !== null && (
        <BillDialog bill={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />
      )}
    </>
  )
}

function BillDialog({ bill, onClose }: { bill: Bill | null; onClose: () => void }) {
  const snapshot = useFinanceStore((state) => state.snapshot)
  const cadence = useFinanceStore((state) => state.settings.payCadence)
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
    isActive: bill?.isActive ?? true,
    fundingStrategy: bill?.fundingStrategy ?? ('all_checks' as BillFundingStrategy),
    fundingPaycheckIndex: bill?.fundingPaycheckIndex ? String(bill.fundingPaycheckIndex) : '1'
  })
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const checkSlots = reachableCheckIndexes(cadence)
  const fundingCheckForForm = fundingCheckIndex({
    cadence,
    dueDay: Number(form.dueDay) || 1,
    fundingStrategy: form.fundingStrategy,
    fundingPaycheckIndex: Number(form.fundingPaycheckIndex) || 1
  })

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
      nextDueOn: bill?.nextDueOn ?? null,
      fundingStrategy: form.fundingStrategy,
      fundingPaycheckIndex:
        form.fundingStrategy === 'specific_check' ? Number(form.fundingPaycheckIndex) || 1 : null
    }

    setSaving(true)
    const ok = bill ? await updateBill(bill.id, input) : await createBill(input)
    setSaving(false)
    if (ok) onClose()
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
            maxLength={60}
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
        <Field
          label="Funding schedule"
          hint="Which paycheck sets this bill's money aside. One check a month carries the whole month's obligation; it never pays it twice."
          wide
        >
          <select
            className="select"
            value={form.fundingStrategy}
            onChange={(event) =>
              setForm({ ...form, fundingStrategy: event.target.value as BillFundingStrategy })
            }
          >
            {FUNDING_STRATEGIES.map((strategy, index) => (
              <option key={strategy} value={strategy}>
                {index + 1}. {BILL_FUNDING_STRATEGY_LABEL[strategy]}
              </option>
            ))}
          </select>
        </Field>

        {form.fundingStrategy === 'specific_check' && checkSlots.length > 1 && (
          <Field
            label="Which paycheck?"
            hint={`${PAY_CADENCE_LABEL[cadence]} pay gives ${checkSlots.length} paychecks every month`}
            wide
          >
            <select
              className="select"
              value={form.fundingPaycheckIndex}
              onChange={(event) => setForm({ ...form, fundingPaycheckIndex: event.target.value })}
            >
              {checkSlots.map((slot) => (
                <option key={slot} value={String(slot)}>
                  {ordinal(slot)} paycheck of the month
                </option>
              ))}
            </select>
          </Field>
        )}

        {form.fundingStrategy !== 'all_checks' && form.fundingStrategy !== 'specific_check' && (
          <p className="field-hint">
            Reserves the whole month&apos;s obligation on the{' '}
            {ordinal(fundingCheckForForm ?? 1)} paycheck
            {form.fundingStrategy === 'closest_due_date'
              ? ', closest to the due day'
              : form.fundingStrategy === 'last_check'
                ? ', the last check your pay cycle is guaranteed to have every month'
                : ''}
            . Every other paycheck reserves nothing for this bill.
          </p>
        )}
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
          Active bill
        </label>
      </div>
      {!form.isActive && (
        <p className="field-hint hint-below">
          Bill inactive · excluded from the wall and from every paycheck until you resume it.
        </p>
      )}

      {error && <p className="form-error">{error}</p>}
    </Modal>
  )
}

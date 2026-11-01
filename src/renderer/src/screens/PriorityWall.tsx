import { useState } from 'react'
import { Pencil, Plus, ShieldCheck, Trash2 } from 'lucide-react'
import {
  FREQUENCY_LABEL,
  PAY_CADENCE_LABEL,
  billFundingReserveCents,
  fundingCheckIndex,
  monthlyEquivalentCents,
  nextPaydayISO,
  reservePerPaycheckCents
} from '@shared/cadence'
import { formatDateLabel, todayISO } from '@shared/dates'
import { formatMoney, formatMoneyCompact } from '@shared/money'
import type { Bill, PayCadence } from '@shared/types'
import { Button, Card, EmptyState, IconButton, Money } from '../components/ui'
import { BillDialog } from '../components/dialogs/BillDialog'
import { DataTable } from '../components/DataTable'
import { activeBills, monthlyWall, ordinal, perPaycheckWall } from '../lib/finance'
import { useFinanceStore } from '../store/useFinanceStore'

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
  const askConfirm = useFinanceStore((state) => state.askConfirm)
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
    // The record is soft-deleted, not un-pinned: its payment checks and this
    // month's reservation go with it, so say that rather than implying a hide.
    void askConfirm({
      title: `Delete “${bill.name}”?`,
      body: 'Its payment check history and this month’s reservation go with it. Paused bills stay on the wall; this removes the bill itself.',
      confirmLabel: 'Delete bill',
      danger: true
    }).then((ok) => {
      if (ok) void deleteBill(bill.id)
    })
  }

  return (
    <>
      <header className="page-head">
        <div>
          <p className="eyebrow">Priority Wall</p>
          <h1 className="page-title" tabIndex={-1}>Bills you cannot touch</h1>
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
            {nextCheck ? 'Reserved on the next check' : 'Average per check'}
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
          <DataTable
            caption="Bills on the Priority Wall"
            className="wall-table"
            columns={[
              { key: 'bill', label: 'Bill' },
              { key: 'amount', label: 'Amount' },
              { key: 'cadence', label: 'Cadence' },
              { key: 'due', label: 'Due' },
              {
                key: 'check',
                label: nextCheck ? 'Next check' : 'Per check',
                className: 'right',
                // Without a payday the column holds each bill's own funding
                // check, not an average; say so instead of implying a flat figure.
                title: nextCheck
                  ? undefined
                  : 'What this bill reserves on its funding check; single-check bills carry the month there'
              },
              { key: 'monthly', label: 'Monthly', className: 'right' },
              { key: 'actions', label: '', ariaLabel: 'Actions' }
            ]}
          >
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
                    Reserved on the {ordinal(fundingCheckFor(bill, settings.payCadence) ?? 1)}{' '}
                    check{nextCheck ? ' of the month' : ' each month'}
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
                  <IconButton label="Delete bill" danger onClick={() => remove(bill)}>
                    <Trash2 size={15} />
                  </IconButton>
                </div>
              </td>
            </tr>
          ))}
          </tbody>
          </DataTable>
        )}
      </Card>

      <p className="footnote">
        Monthly figures are annualised and divided by twelve, so a{' '}
        {formatMoneyCompact(60_000, currency)} yearly insurance premium counts as{' '}
        {formatMoneyCompact(5_000, currency)} of obligation every month. A bill funded on one
        check reserves that whole month on its check. Set a known payday in Settings and the wall
        shows the exact reserve for the next real check instead of an average.
      </p>

      {editing !== null && (
        <BillDialog bill={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />
      )}
    </>
  )
}

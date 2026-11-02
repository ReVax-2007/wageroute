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
function fundingCheckFor(
  bill: Bill,
  cadence: PayCadence,
  paycheckDate: string | null,
  anchorDate: string | null
): number | null {
  return fundingCheckIndex({
    cadence,
    dueDay: bill.dueDay,
    fundingStrategy: bill.fundingStrategy,
    fundingPaycheckIndex: bill.fundingPaycheckIndex,
    paycheckDate,
    payAnchorDate: anchorDate
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
  // A claim whose bill was deleted stays in the ledger for history but is no
  // longer money the wall holds.
  const liveBillIds = new Set(bills.map((bill) => bill.id))
  const reservesThisMonth = snapshot.billReserves.filter(
    (reserve) => reserve.cycle === monthlyKey && liveBillIds.has(reserve.billId)
  )
  const reserveStateOf = (billId: string): 'paid' | 'reserved' | null => {
    const rows = reservesThisMonth.filter((reserve) => reserve.billId === billId)
    // A payment can close one instalment while another stays open, so "paid"
    // is only true when nothing is still reserved for the month.
    if (rows.some((reserve) => reserve.state === 'reserved')) return 'reserved'
    return rows.length > 0 ? 'paid' : null
  }
  const nextCheckMonth = nextCheck?.slice(0, 7) ?? null
  const nextCheckClaims = snapshot.billReserves.filter(
    (reserve) =>
      reserve.cycle === nextCheckMonth &&
      reserve.state === 'reserved' &&
      liveBillIds.has(reserve.billId)
  )
  const nextCheckPayments =
    nextCheckMonth === monthlyKey
      ? new Map(
          snapshot.billPaymentsThisMonth.map((total) => [
            total.billId,
            Math.max(0, total.paidCents - total.creditCents)
          ])
        )
      : new Map<string, number>()
  const nextCheckReserve = (bill: Bill): number => {
    // Every claim this month already covers that much of the bill, whatever
    // strategy wrote it, so the next cheque funds only the remainder.
    const claimedCents = nextCheckClaims
      .filter((reserve) => reserve.billId === bill.id)
      .reduce((total, reserve) => total + reserve.amountCents, 0)
    return billFundingReserveCents({
      amountCents: bill.amountCents,
      frequency: bill.frequency,
      cadence: settings.payCadence,
      dueDay: bill.dueDay,
      fundingStrategy: bill.fundingStrategy,
      fundingPaycheckIndex: bill.fundingPaycheckIndex,
      paycheckDate: nextCheck,
      payAnchorDate: anchor,
      paidThisMonthCents: nextCheckPayments.get(bill.id) ?? 0,
      claimedThisMonthCents: claimedCents
    })
  }
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
                  reservesThisMonth
                    .filter((reserve) => reserve.state === 'reserved')
                    .reduce((total, reserve) => total + reserve.amountCents, 0),
                  currency
                )} reserved this month · ${formatMoney(
                  reservesThisMonth
                    .filter((reserve) => reserve.state === 'paid')
                    .reduce((total, reserve) => total + reserve.amountCents, 0),
                  currency
                )} paid`
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
            {bills.map((bill) => {
              const state = reserveStateOf(bill.id)
              const checkCents = !bill.isActive
                ? 0
                : nextCheck
                  ? nextCheckReserve(bill)
                  : bill.fundingStrategy === 'all_checks'
                    ? reservePerPaycheckCents(
                        bill.amountCents,
                        bill.frequency,
                        settings.payCadence
                      )
                    : monthlyEquivalentCents(bill.amountCents, bill.frequency)
              // A zero on the next check means the month is already covered:
              // say that instead of naming a check that has nothing left to do.
              const covered = nextCheck !== null && bill.isActive && checkCents === 0
              return (
                <tr key={bill.id} className={bill.isActive ? undefined : 'inactive'}>
                  <td>
                    <div className="cell-strong" title={bill.name}>
                      {bill.name}
                    </div>
                    <div className="cell-sub">
                      <Money cents={bill.amountCents} currency={currency} />
                      {' · '}
                      {FREQUENCY_LABEL[bill.frequency]}
                      {' · due the '}
                      {ordinal(bill.dueDay)}
                      {bill.autopay ? ' · autopay' : ''}
                      {state === 'paid' && (
                        <span className="chip chip-quiet">Paid this month</span>
                      )}
                      {state === 'reserved' && (
                        <span className="chip chip-quiet">Reserved this month</span>
                      )}
                      {!bill.isActive && (
                        <span className="chip chip-quiet chip-inactive">Bill inactive</span>
                      )}
                    </div>
                  </td>
                  <td className="right">
                    <Money cents={checkCents} currency={currency} />
                    {!bill.isActive ? (
                      <div className="cell-sub">Paused</div>
                    ) : covered ? (
                      <div className="cell-sub">Nothing more due</div>
                    ) : bill.fundingStrategy !== 'all_checks' ? (
                      <div className="cell-sub chip-funding">
                        On the{' '}
                        {ordinal(
                          fundingCheckFor(bill, settings.payCadence, nextCheck, anchor) ?? 1
                        )}{' '}
                        check{nextCheck ? ' of the month' : ' each month'}
                      </div>
                    ) : null}
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
              )
            })}
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

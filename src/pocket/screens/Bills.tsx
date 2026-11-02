import { formatDateLabel } from '@shared/dates'
import { formatMoney } from '@shared/money'
import type { BillState } from '../lib/compute'
import { billLines, pocketView } from '../lib/compute'
import { useSnapshot } from '../lib/store'

const STATE_LABEL: Record<BillState, string> = {
  paid: 'Paid',
  reserved: 'Set aside',
  open: 'Due'
}

export function Bills() {
  const snapshot = useSnapshot()
  if (!snapshot) return null
  const view = pocketView(snapshot)
  const currency = view.settings.currency
  const lines = billLines(snapshot)
  const unpaid = lines.filter((line) => line.state !== 'paid')
  const paid = lines.filter((line) => line.state === 'paid')

  return (
    <div className="screen">
      <section className="hero quiet">
        <span className="eyebrow">Bills each month</span>
        <p className="hero-number">{formatMoney(view.monthlyBillsCents, currency)}</p>
        <p className="hero-note">
          About {formatMoney(view.perCheckBillsCents, currency)} comes out of every paycheck to keep
          them covered.
        </p>
      </section>

      {lines.length === 0 ? (
        <p className="empty-line">No bills are set up yet. Add them in WageRoute on your computer.</p>
      ) : null}

      {unpaid.length > 0 ? (
        <section className="section">
          <header className="section-head">
            <h2>Still to pay</h2>
            <span className="muted small">{unpaid.length}</span>
          </header>
          <ul className="list">
            {unpaid.map((line) => (
              <li key={line.bill.id} className="row-card">
                <div className="row-main">
                  <span className="row-title">{line.bill.name}</span>
                  <span className="muted small">
                    {formatDateLabel(line.dueOn)}
                    {line.accountName ? ` · ${line.accountName}` : ''}
                  </span>
                </div>
                <div className="row-end">
                  <span className="amount">{formatMoney(line.bill.amountCents, currency)}</span>
                  <span className={`pill ${line.state}`}>{STATE_LABEL[line.state]}</span>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {paid.length > 0 ? (
        <section className="section">
          <header className="section-head">
            <h2>Paid this month</h2>
            <span className="muted small">{paid.length}</span>
          </header>
          <ul className="list">
            {paid.map((line) => (
              <li key={line.bill.id} className="row-card settled">
                <div className="row-main">
                  <span className="row-title">{line.bill.name}</span>
                  <span className="muted small">
                    {line.accountName ? line.accountName : 'Paid'}
                  </span>
                </div>
                <div className="row-end">
                  <span className="amount muted">{formatMoney(line.bill.amountCents, currency)}</span>
                  <span className="pill paid">{STATE_LABEL.paid}</span>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <p className="fine">
        Bills are edited in WageRoute on your computer. This screen reads the copy on this phone.
      </p>
    </div>
  )
}

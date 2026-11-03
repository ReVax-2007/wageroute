import { CalendarDays, ChevronRight, Wallet } from 'lucide-react'
import { accountDisplayBalanceCents, ACCOUNT_KIND_LABEL } from '../../renderer/src/lib/finance'
import { formatDateLabel, formatDateLong, localDateISO } from '@shared/dates'
import { formatMoney } from '@shared/money'
import { usePocket, useSnapshot } from '../lib/store'
import { billLines, dueSoon, pocketView } from '../lib/compute'
import type { Tab } from '../components/Nav'

function Metric({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className={muted ? 'metric muted' : 'metric'}>
      <span className="metric-label">{label}</span>
      <strong className="metric-value">{value}</strong>
    </div>
  )
}

function deduction(cents: number, currency: string): string {
  return cents > 0 ? `−${formatMoney(cents, currency)}` : formatMoney(0, currency)
}

export function Home({ go }: { go: (tab: Tab) => void }) {
  const snapshot = useSnapshot()
  const exportedAt = usePocket((state) => state.exportedAt)
  if (!snapshot) return null
  const view = pocketView(snapshot)
  const currency = view.settings.currency
  const lines = billLines(snapshot)
  const soon = dueSoon(lines, 14).slice(0, 4)
  const goals = snapshot.goals.filter((goal) => !goal.isArchived).slice(0, 3)
  const accounts = snapshot.accounts.filter((account) => !account.isArchived)

  return (
    <div className="screen">
      <section className={view.safeToSpendCents < 0 ? 'hero over' : 'hero'}>
        <span className="eyebrow">Safe to spend</span>
        <p className="hero-number">{formatMoney(view.safeToSpendCents, currency)}</p>
        <p className="hero-note">
          What is left after this month's bills, the money set aside for goals, and anything already
          routed to debt or investing.
        </p>
        <ul className="hero-breakdown">
          <li>
            <span>Spendable accounts</span>
            <b>{formatMoney(view.poolCents, currency)}</b>
          </li>
          <li>
            <span>Bills still due</span>
            <b>{deduction(view.unpaidWallCents, currency)}</b>
          </li>
          <li>
            <span>Set aside for goals</span>
            <b>{deduction(view.goalMoneyCents, currency)}</b>
          </li>
          <li>
            <span>Routed but not moved</span>
            <b>{deduction(view.unsettledCents, currency)}</b>
          </li>
        </ul>
      </section>

      <div className="metrics">
        <Metric label="Cash on hand" value={formatMoney(view.cashCents, currency)} />
        <Metric label="Total wealth" value={formatMoney(view.wealthCents, currency)} />
      </div>

      {view.nextPayday ? (
        <section className="card row-card">
          <span className="row-icon">
            <CalendarDays size={19} aria-hidden="true" />
          </span>
          <div className="row-main">
            <span className="row-title">{view.settings.paydayLabel.trim() || 'Next payday'}</span>
            <span className="muted small">{formatDateLong(view.nextPayday)}</span>
          </div>
        </section>
      ) : null}

      <section className="section">
        <header className="section-head">
          <h2>Due soon</h2>
          <button type="button" className="link" onClick={() => go('bills')}>
            All bills <ChevronRight size={15} aria-hidden="true" />
          </button>
        </header>
        {soon.length === 0 ? (
          <p className="empty-line">Nothing is due in the next two weeks.</p>
        ) : (
          <ul className="list">
            {soon.map((line) => (
              <li key={line.bill.id} className="row-card">
                <div className="row-main">
                  <span className="row-title">{line.bill.name}</span>
                  <span className="muted small">
                    {formatDateLabel(line.dueOn)}
                    {line.state === 'reserved' ? ' · already set aside' : ''}
                  </span>
                </div>
                <span className="amount">{formatMoney(line.bill.amountCents, currency)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {goals.length > 0 ? (
        <section className="section">
          <header className="section-head">
            <h2>Goals</h2>
            <button type="button" className="link" onClick={() => go('goals')}>
              All goals <ChevronRight size={15} aria-hidden="true" />
            </button>
          </header>
          <ul className="list">
            {goals.map((goal) => {
              const progress =
                goal.targetCents > 0 ? Math.min(1, goal.fundedCents / goal.targetCents) : 0
              return (
                <li key={goal.id} className="goal-card">
                  <div className="goal-head">
                    <span className="goal-dot" style={{ background: goal.color }} aria-hidden="true" />
                    <span className="row-title">{goal.name}</span>
                    <span className="muted small">
                      {Math.round(progress * 100)}%
                    </span>
                  </div>
                  <div className="bar" aria-hidden="true">
                    <span style={{ width: `${progress * 100}%`, background: goal.color }} />
                  </div>
                  <span className="muted small">
                    {formatMoney(goal.fundedCents, currency)} of{' '}
                    {formatMoney(goal.targetCents, currency)}
                  </span>
                </li>
              )
            })}
          </ul>
        </section>
      ) : null}

      <section className="section">
        <header className="section-head">
          <h2>Accounts</h2>
        </header>
        {accounts.length === 0 ? (
          <p className="empty-line">No accounts yet.</p>
        ) : (
          <ul className="list">
            {accounts.map((account) => (
              <li key={account.id} className="row-card">
                <span className="row-icon">
                  <Wallet size={18} aria-hidden="true" />
                </span>
                <div className="row-main">
                  <span className="row-title">{account.name}</span>
                  <span className="muted small">
                    {ACCOUNT_KIND_LABEL[account.kind]}
                    {account.institution ? ` · ${account.institution}` : ''}
                  </span>
                </div>
                <span className={account.kind === 'credit' ? 'amount owed' : 'amount'}>
                  {formatMoney(accountDisplayBalanceCents(account), currency)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <p className="fine">
        {snapshot.transactionTotal.toLocaleString()} entries
        {exportedAt ? ` · backup from ${formatDateLabel(localDateISO(exportedAt))}` : ''}
      </p>
    </div>
  )
}

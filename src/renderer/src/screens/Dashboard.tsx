import { CreditCard, Plus, ShieldCheck, Sparkles, Target, Wallet } from 'lucide-react'
import { formatDateLong, formatMonthLong, todayISO } from '@shared/dates'
import { formatMoney } from '@shared/money'
import type { AllocationBucket } from '@shared/types'
import { BillPrompts } from '../components/BillPrompts'
import { Donut, type DonutSlice } from '../components/Donut'
import { Button, Card, EmptyState, Money, Progress } from '../components/ui'
import {
  ACCOUNT_KIND_LABEL,
  activeBills,
  cashOnHand,
  creditAvailableCents,
  creditOwedCents,
  goalsSummary,
  latestPaycheck,
  monthRoutingBreakdown,
  monthlyWall,
  perPaycheckWall
} from '../lib/finance'
import {
  selectCashOnHandCents,
  selectFundedGoalsCents,
  selectMonthlyWallCents,
  selectSafeToSpendCents,
  useFinanceStore
} from '../store/useFinanceStore'

function greeting(): string {
  const hour = new Date().getHours()
  if (hour < 12) return 'Good morning'
  if (hour < 18) return 'Good afternoon'
  return 'Good evening'
}

const BUCKET_COLOR: Record<AllocationBucket, string> = {
  priority: '#5a6a83',
  savings: 'var(--savings)',
  investment: 'var(--investment)',
  goal: 'var(--goal)',
  debt: 'var(--debt)',
  leisure: 'var(--leisure)'
}

export function Dashboard() {
  const snapshot = useFinanceStore((state) => state.snapshot)
  const settings = useFinanceStore((state) => state.settings)
  const openAllocator = useFinanceStore((state) => state.openAllocator)
  const importData = useFinanceStore((state) => state.importData)
  const go = useFinanceStore((state) => state.go)
  const safeToSpend = useFinanceStore(selectSafeToSpendCents)
  const cash = useFinanceStore(selectCashOnHandCents)
  const fundedGoals = useFinanceStore(selectFundedGoalsCents)
  const monthlyPriority = useFinanceStore(selectMonthlyWallCents)

  if (!snapshot) return null

  const currency = settings.currency
  const bills = activeBills(snapshot.bills)
  const wall = monthlyWall(bills)
  const perCheck = perPaycheckWall(bills, settings.payCadence)
  const goals = goalsSummary(snapshot.goals)
  const last = latestPaycheck(snapshot.paychecks)
  const cashBalances = cashOnHand(snapshot.accounts)
  const recent = snapshot.transactions.slice(0, 6)

  const committed = monthlyPriority + fundedGoals
  const committedShare = cashBalances > 0 ? Math.min(1, committed / cashBalances) : 0

  const monthKey = todayISO().slice(0, 7)
  const routing = monthRoutingBreakdown(snapshot.paychecks, monthKey)
  const firstRun = snapshot.accounts.length === 0 && snapshot.paychecks.length === 0
  const slices: DonutSlice[] = [
    {
      key: 'priority',
      label: 'Priority Wall',
      cents: routing.priorityCents,
      color: BUCKET_COLOR.priority
    },
    {
      key: 'growth',
      label: 'Growth & sinking funds',
      cents: routing.growthCents,
      color: BUCKET_COLOR.investment
    },    { key: 'debt', label: 'Debt payoff', cents: routing.debtCents, color: BUCKET_COLOR.debt },
    {
      key: 'leisure',
      label: 'Guilt-free',
      cents: routing.leisureCents,
      color: BUCKET_COLOR.leisure
    }
  ]

  const bucketAmount = (bucket: AllocationBucket): number =>
    last?.allocations
      .filter((allocation) => allocation.bucket === bucket)
      .reduce((total, allocation) => total + allocation.amountCents, 0) ?? 0

  const segments = last
    ? [
        { label: 'Priority Wall', cents: bucketAmount('priority'), color: BUCKET_COLOR.priority },
        { label: 'Savings', cents: bucketAmount('savings'), color: BUCKET_COLOR.savings },
        { label: 'Investments', cents: bucketAmount('investment'), color: BUCKET_COLOR.investment },
        { label: 'Debt', cents: bucketAmount('debt'), color: BUCKET_COLOR.debt },
        { label: 'Goals', cents: bucketAmount('goal'), color: BUCKET_COLOR.goal },
        { label: 'Guilt-free', cents: bucketAmount('leisure'), color: BUCKET_COLOR.leisure }
      ].filter((segment) => segment.cents > 0)
    : []

  return (
    <>
      <header className="page-head">
        <div>
          <p className="eyebrow">Overview · {formatDateLong(todayISO())}</p>
          <h1 className="page-title">
            {greeting()}
            {snapshot.user.displayName ? `, ${snapshot.user.displayName}` : ''}
          </h1>
          <p className="page-sub">Every dollar gets a job before you spend it.</p>
        </div>
        <Button variant="primary" icon={<Plus size={16} />} onClick={openAllocator}>
          Route a paycheck
        </Button>
      </header>

      {firstRun && (
        <Card title="Welcome to WageRoute" subtitle="Everything stays in a local database on this device">
          <EmptyState
            icon={<Sparkles size={20} />}
            title="Start from scratch or import a backup"
            body="Set up your own accounts, bills and goals, or bring everything back from a WageRoute JSON backup."
            action={
              <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', justifyContent: 'center' }}>
                <Button variant="primary" onClick={() => go('accounts')}>
                  Start from scratch
                </Button>
                <Button onClick={() => void importData()}>Import a backup</Button>
              </div>
            }
          />
        </Card>
      )}

      <section className="safe-hero">
        <div className="safe-main">
          <p className="eyebrow">Safe to spend</p>
          <p className={safeToSpend < 0 ? 'safe-value negative' : 'safe-value'}>
            <Money cents={safeToSpend} currency={currency} />
          </p>
          <p className="safe-note">
            Cash you can spend without touching a bill or a funded goal.
          </p>
          <div className="safe-meter" aria-hidden="true">
            <span style={{ width: `${Math.round(committedShare * 100)}%` }} />
          </div>
          <p className="safe-meter-note">
            {Math.round(committedShare * 100)}% of cash is already spoken for
          </p>
        </div>

        <dl className="safe-breakdown">
          <div>
            <dt>Cash across accounts</dt>
            <dd>
              <Money cents={cash} currency={currency} />
            </dd>
          </div>
          <div>
            <dt>Priority Wall / month</dt>
            <dd className="deduct">
              − <Money cents={monthlyPriority} currency={currency} />
            </dd>
          </div>
          <div>
            <dt>Funded sinking goals</dt>
            <dd className="deduct">
              − <Money cents={fundedGoals} currency={currency} />
            </dd>
          </div>
          <div className="safe-total">
            <dt>Safe to spend</dt>
            <dd>
              <Money cents={safeToSpend} currency={currency} />
            </dd>
          </div>
        </dl>
      </section>

      <BillPrompts />

      <div className="stat-grid">
        <article className="stat-card">
          <div className="stat-top">
            <span className="stat-label">Cash on hand</span>
            <Wallet size={16} className="stat-icon" />
          </div>
          <p className="stat-value">
            <Money cents={cash} currency={currency} compact />
          </p>
          <p className="stat-hint">Across {snapshot.accounts.length} tracked accounts</p>
        </article>

        <article className="stat-card">
          <div className="stat-top">
            <span className="stat-label">Priority Wall / month</span>
            <ShieldCheck size={16} className="stat-icon" />
          </div>
          <p className="stat-value">
            <Money cents={wall} currency={currency} compact />
          </p>
          <p className="stat-hint">
            {formatMoney(perCheck, currency)} reserved each paycheck
          </p>
        </article>

        <article className="stat-card">
          <div className="stat-top">
            <span className="stat-label">Sinking funds</span>
            <Target size={16} className="stat-icon" />
          </div>
          <p className="stat-value">{Math.round(goals.progress * 100)}%</p>
          <p className="stat-hint">
            {formatMoney(goals.fundedCents, currency)} of{' '}
            {formatMoney(goals.targetCents, currency)}
          </p>
        </article>

        <article className="stat-card">
          <div className="stat-top">
            <span className="stat-label">Guilt-free last check</span>
            <Sparkles size={16} className="stat-icon" />
          </div>
          <p className="stat-value">
            <Money cents={last?.leisureCents ?? 0} currency={currency} compact />
          </p>
          <p className="stat-hint">
            {last ? `Routed ${formatDateLong(last.receivedOn)}` : 'No paycheck routed yet'}
          </p>
        </article>
      </div>

      <div className="dashboard-grid">
        <Card
          title="Accounts"
          subtitle="Balances are derived from every entry, never typed over"
          className="accounts-card"
          actions={
            <Button size="sm" onClick={() => go('accounts')}>
              Manage
            </Button>
          }
        >
          <ul className="account-list">
            {snapshot.accounts.map((account) => {
              const isCredit = account.kind === 'credit'
              const displayCents = isCredit
                ? Math.max(0, -account.balanceCents)
                : account.balanceCents
              return (
                <li key={account.id} className="account-row">
                  <span className={`account-dot kind-${account.kind}`} />
                  <div className="account-name">
                    <span className="cell-strong">{account.name}</span>
                    <span className="account-meta">
                      {account.institution
                        ? `${account.institution} · ${ACCOUNT_KIND_LABEL[account.kind]}`
                        : ACCOUNT_KIND_LABEL[account.kind]}
                      {isCredit ? ' · owed' : ''}
                    </span>
                  </div>
                  <Money
                    cents={displayCents}
                    currency={currency}
                    className={
                      !isCredit && displayCents < 0 ? 'account-balance negative' : 'account-balance'
                    }
                  />
                </li>
              )
            })}
          </ul>
          {creditOwedCents(snapshot.accounts) > 0 && (
            <div className="credit-line">
              <CreditCard size={14} />
              <span>{formatMoney(creditOwedCents(snapshot.accounts), currency)} owed</span>
              <span className="credit-line-sub">
                {formatMoney(creditAvailableCents(snapshot.accounts), currency)} available
              </span>
            </div>
          )}
        </Card>

        <Card
          title="This month's routing"
          subtitle={`${formatMonthLong(monthKey)} · every routed cent`}
        >
          {routing.totalCents === 0 ? (
            <EmptyState
              icon={<Sparkles size={20} />}
              title="Nothing routed this month yet"
              body="Once a paycheck is routed, this ring shows where the money went."
              action={
                <Button variant="primary" onClick={openAllocator}>
                  Route a paycheck
                </Button>
              }
            />
          ) : (
            <div className="donut-wrap">
              <Donut
                slices={slices}
                centerLabel="ROUTED"
                centerValue={formatMoney(routing.totalCents, currency)}
              />
              <ul className="donut-legend">
                {slices.map((slice) => (
                  <li key={slice.key}>
                    <span className="dot" style={{ background: slice.color }} />
                    <span className="donut-slice">{slice.label}</span>
                    <span className="num">{formatMoney(slice.cents, currency)}</span>
                    <span className="donut-share">
                      {routing.totalCents > 0
                        ? `${Math.round((slice.cents / routing.totalCents) * 100)}%`
                        : '—'}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Card>
      </div>

      <div className="dashboard-grid">
        <Card
          title="Last routing"
          subtitle={last ? formatDateLong(last.receivedOn) : 'Nothing routed yet'}
        >
          {last ? (
            <div className="routing">
              <div className="routing-total">
                <span className="alloc-label">Paycheck</span>
                <Money cents={last.amountCents} currency={currency} className="routing-value" />
              </div>

              <div className="stack-bar">
                {segments.map((segment) => (
                  <span
                    key={segment.label}
                    title={`${segment.label}: ${formatMoney(segment.cents, currency)}`}
                    style={{
                      width: `${(segment.cents / last.amountCents) * 100}%`,
                      background: segment.color
                    }}
                  />
                ))}
              </div>

              <ul className="legend">
                {segments.map((segment) => (
                  <li key={segment.label}>
                    <span className="dot" style={{ background: segment.color }} />
                    <span>{segment.label}</span>
                    <Money cents={segment.cents} currency={currency} />
                  </li>
                ))}
              </ul>

              <div className="routing-health">
                <span className={`health health-${last.health}`}>{last.health}</span>
                <span className="alloc-note">
                  {last.priorityCents > 0
                    ? `${formatMoney(last.priorityCents, currency)} locked before spending`
                    : 'No bills locked in this cycle'}
                </span>
              </div>
            </div>
          ) : (
            <EmptyState
              icon={<Sparkles size={20} />}
              title="No paycheck routed yet"
              body="Enter an income amount and the allocator will protect bills first, then split the surplus."
              action={
                <Button variant="primary" onClick={openAllocator}>
                  Route your first paycheck
                </Button>
              }
            />
          )}
        </Card>

        <Card title="Goals at a glance" subtitle="Money already routed to future expenses">
          <div className="goal-strip-body">
            {snapshot.goals.length === 0 ? (
              <p className="alloc-note">No sinking funds yet. Create one in the Sinking funds tab.</p>
            ) : (
              snapshot.goals.map((goal) => (
                <div key={goal.id} className="goal-strip-row">
                  <div className="goal-strip-head">
                    <span className="cell-strong">{goal.name}</span>
                    <span className="num muted">
                      {formatMoney(goal.fundedCents, currency)} /{' '}
                      {formatMoney(goal.targetCents, currency)}
                    </span>
                  </div>
                  <Progress value={goal.fundedCents} max={goal.targetCents} color={goal.color} />
                </div>
              ))
            )}
          </div>
        </Card>
      </div>

      <Card
        title="Recent activity"
        subtitle={`${snapshot.transactions.length} entries in the local ledger`}
        actions={
          <Button variant="quiet" size="sm" onClick={() => go('ledger')}>
            Open spreadsheet
          </Button>
        }
      >
        {recent.length === 0 ? (
          <EmptyState
            icon={<Wallet size={20} />}
            title="No entries yet"
            body="Add rows in the spreadsheet tab. Balances update from these entries."
          />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Description</th>
                <th>Account</th>
                <th>Category</th>
                <th className="right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((transaction) => (
                <tr key={transaction.id}>
                  <td className="num muted">{formatDateLong(transaction.occurredOn)}</td>
                  <td className="cell-strong">{transaction.memo || 'Untitled entry'}</td>
                  <td>{transaction.accountName}</td>
                  <td>
                    <span className="chip">{transaction.category}</span>
                  </td>
                  <td className="right">
                    <Money
                      cents={transaction.amountCents}
                      currency={currency}
                      className={transaction.amountCents < 0 ? 'negative' : 'positive'}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </>
  )
}

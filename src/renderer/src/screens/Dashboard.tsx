import { CalendarClock, CreditCard, HandCoins, Plus, ShieldCheck, Sparkles, Target, Wallet } from 'lucide-react'
import { useState } from 'react'
import { formatDateLabel, formatDateLong, formatMonthLong, todayISO } from '@shared/dates'
import { wealthBuckets } from '@shared/accounts'
import { spendingByCategory } from '@shared/categories'
import { netWorthSeries } from '@shared/history'
import { formatMoney } from '@shared/money'
import type { AllocationBucket } from '@shared/types'
import { BillPrompts } from '../components/BillPrompts'
import { DataTable } from '../components/DataTable'
import { IncomeDialog } from '../components/dialogs/IncomeDialog'
import { MovePlanDialog } from '../components/dialogs/MovePlanDialog'
import { Donut, type DonutSlice } from '../components/Donut'
import { Sparkline } from '../components/Sparkline'
import { Button, Card, EmptyState, Money, Progress } from '../components/ui'
import {
  ACCOUNT_KIND_LABEL,
  activeBills,
  creditAvailableCents,
  creditOwedCents,
  goalsSummary,
  latestPaycheck,
  monthRoutingBreakdown,
  monthlyWall,
  perPaycheckWall,
  upcomingPayments
} from '../lib/finance'
import {
  selectCashOnHandCents,
  selectMonthlyWallCents,
  selectPoolEarmarkedGoalsCents,
  selectSafeToSpendCents,
  selectSafeToSpendPoolCents,
  selectTotalWealthCents,
  selectUnpaidWallCents,
  selectUnsettledRoutingCents,
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
  const openImport = useFinanceStore((state) => state.openImport)
  const go = useFinanceStore((state) => state.go)
  const safeToSpend = useFinanceStore(selectSafeToSpendCents)
  const wealth = useFinanceStore(selectTotalWealthCents)
  const cash = useFinanceStore(selectCashOnHandCents)
  const pool = useFinanceStore(selectSafeToSpendPoolCents)
  const earmarked = useFinanceStore(selectPoolEarmarkedGoalsCents)
  const monthlyPriority = useFinanceStore(selectMonthlyWallCents)
  const unpaidPriority = useFinanceStore(selectUnpaidWallCents)
  const unsettled = useFinanceStore(selectUnsettledRoutingCents)
  const [moving, setMoving] = useState(false)
  const [addingIncome, setAddingIncome] = useState(false)

  if (!snapshot) return null

  const currency = settings.currency
  const bills = activeBills(snapshot.bills)
  const wall = monthlyWall(bills)
  const perCheck = perPaycheckWall(bills, settings.payCadence)
  const goals = goalsSummary(snapshot.goals)
  const activeGoals = snapshot.goals.filter((goal) => !goal.isArchived)
  const activeAccountCount = snapshot.accounts.filter((account) => !account.isArchived).length
  const last = latestPaycheck(snapshot.paychecks)
  const wealthSplit = wealthBuckets(snapshot.accounts)
  const recent = snapshot.transactions.slice(0, 6)

  const committed = Math.max(0, pool - safeToSpend)
  const committedShare = pool > 0 ? committed / pool : 0
  const committedPercent = Math.round(committedShare * 100)
  // With no spendable cash the percentage has no meaning: saying "0%" while
  // bills are waiting reads as reassurance the ledger cannot give.
  const committedLabel =
    pool <= 0
      ? committed > 0
        ? `There is no spending cash tracked, and ${formatMoney(committed, currency)} of bills and goals is already claimed.`
        : 'There is no spending cash tracked yet.'
      : committedShare > 1
        ? `${committedPercent}% of your spending cash is spoken for — more than you have`
        : `${committedPercent}% of your spending cash is already spoken for`

  const monthKey = todayISO().slice(0, 7)
  const today = todayISO()
  const oneTimeIncome = snapshot.transactions.filter(
    (transaction) => transaction.kind === 'income' && transaction.paycheckId === null
  )
  const oneTimeThisMonth = oneTimeIncome.filter(
    (transaction) => transaction.occurredOn.slice(0, 7) === monthKey
  )
  const oneTimeTotal = oneTimeThisMonth.reduce(
    (total, transaction) => total + transaction.amountCents,
    0
  )
  const liveAccounts = snapshot.accounts.filter((account) => !account.isArchived)
  const history = netWorthSeries({
    snapshots: snapshot.balanceSnapshots,
    accounts: liveAccounts,
    untilISO: today,
    maxPoints: 90
  })
  const spending = spendingByCategory({
    transactions: snapshot.transactions,
    categories: snapshot.categories,
    month: monthKey
  })
  const spendingTotal = spending.reduce((total, row) => total + row.totalCents, 0)
  const upcoming = upcomingPayments({
    bills,
    accounts: liveAccounts,
    transactions: snapshot.transactions,
    todayISO: today
  })
  const routing = monthRoutingBreakdown(snapshot.paychecks, monthKey)
  const firstRun = snapshot.accounts.length === 0 && snapshot.paychecks.length === 0
  const slices: DonutSlice[] = [
    {
      key: 'priority',
      label: 'Bills',
      cents: routing.priorityCents,
      color: BUCKET_COLOR.priority
    },
    {
      key: 'growth',
      label: 'Savings and goals',
      cents: routing.growthCents,
      color: BUCKET_COLOR.investment
    },
    { key: 'debt', label: 'Debt payoff', cents: routing.debtCents, color: BUCKET_COLOR.debt },
    {
      key: 'leisure',
      label: 'Fun money',
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
        { label: 'Bills', cents: bucketAmount('priority'), color: BUCKET_COLOR.priority },
        { label: 'Savings', cents: bucketAmount('savings'), color: BUCKET_COLOR.savings },
        { label: 'Investments', cents: bucketAmount('investment'), color: BUCKET_COLOR.investment },
        { label: 'Debt', cents: bucketAmount('debt'), color: BUCKET_COLOR.debt },
        { label: 'Goals', cents: bucketAmount('goal'), color: BUCKET_COLOR.goal },
        { label: 'Fun money', cents: bucketAmount('leisure'), color: BUCKET_COLOR.leisure }
      ].filter((segment) => segment.cents > 0)
    : []

  return (
    <>
      <header className="page-head">
        <div>
          <p className="eyebrow">Home · {formatDateLong(todayISO())}</p>
          <h1 className="page-title" tabIndex={-1}>
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
                <Button onClick={() => void openImport()}>Import a backup</Button>
              </div>
            }
          />
        </Card>
      )}

      <section className="safe-hero">
        <div className="safe-main">
          <p className="eyebrow">Left to spend</p>
          <p className={safeToSpend < 0 ? 'safe-value negative' : 'safe-value'}>
            <Money cents={safeToSpend} currency={currency} />
          </p>
          <p className="safe-note">
            Cash no bill, goal or plan has claimed yet. Routing records a plan; it does not move
            the money.
          </p>
          <div className="safe-meter" aria-hidden="true">
            <span style={{ width: `${Math.min(100, committedPercent)}%` }} />
          </div>
          <p className="safe-meter-note">{committedLabel}</p>
        </div>

        <dl className="safe-breakdown">
          <div>
            <dt>Cash you can spend</dt>
            <dd>
              <Money cents={pool} currency={currency} />
            </dd>
          </div>
          <div>
            <dt>
              Bills still to pay
              {monthlyPriority > unpaidPriority && (
                <span className="alloc-note">
                  {' '}
                  ({formatMoney(monthlyPriority - unpaidPriority, currency)} already paid)
                </span>
              )}
            </dt>
            <dd className="deduct">
              − <Money cents={unpaidPriority} currency={currency} />
            </dd>
          </div>
          <div>
            <dt>Set aside for goals</dt>
            <dd className="deduct">
              − <Money cents={earmarked} currency={currency} />
            </dd>
          </div>
          {unsettled > 0 && (
            <div>
              <dt>Planned for debt and investing, not moved yet</dt>
              <dd className="deduct">
                − <Money cents={unsettled} currency={currency} />
              </dd>
            </div>
          )}
          <div className="safe-total">
            <dt>Left to spend</dt>
            <dd>
              <Money cents={safeToSpend} currency={currency} />
            </dd>
          </div>
        </dl>
      </section>

      <section className="wealth-strip">
        <div className="wealth-head">
          <p className="eyebrow">Total wealth</p>
          <p className="wealth-value">
            <Money cents={wealth} currency={currency} />
          </p>
          <p className="wealth-note">
            Money you cannot spend today is still yours. This is everything you own, minus what
            you owe.
          </p>
          {history.length > 1 && (
            <div className="wealth-trend">
              <Sparkline
                points={history.map((point) => ({
                  onDate: point.onDate,
                  valueCents: point.netWorthCents
                }))}
                label={`Net worth from ${formatMoney(history[0].netWorthCents, currency)} on ${formatDateLabel(history[0].onDate)} to ${formatMoney(history[history.length - 1].netWorthCents, currency)} today`}
              />
              <span className="wealth-trend-note">
                Since {formatDateLabel(history[0].onDate)}
              </span>
            </div>
          )}
        </div>
        <dl className="wealth-breakdown">
          {wealthSplit.map((bucket) => (
            <div key={bucket.label}>
              <dt>{bucket.label}</dt>
              <dd>
                <Money cents={bucket.cents} currency={currency} />
              </dd>
            </div>
          ))}
        </dl>
      </section>

      <BillPrompts />

      <Card
        title="Extra income"
        subtitle={`${formatMonthLong(monthKey)} · ${formatMoney(oneTimeTotal, currency)} logged, outside your paycheck plan`}
        actions={
          <Button size="sm" icon={<HandCoins size={14} />} onClick={() => setAddingIncome(true)}>
            Add income
          </Button>
        }
      >
        {oneTimeThisMonth.length === 0 ? (
          <EmptyState
            icon={<HandCoins size={20} />}
            title="No extra income this month"
            body="A gift, a tax refund, something you sold — log it here. The balance updates without changing your paycheck plan."
          />
        ) : (
          <ul className="due-list">
            {oneTimeThisMonth.slice(0, 5).map((transaction) => (
              <li key={transaction.id} className="due-row">
                <span className="account-dot kind-income" />
                <span className="due-name">{transaction.memo || 'One-time income'}</span>
                <span className="due-when">
                  {formatDateLabel(transaction.occurredOn)} · {transaction.accountName}
                </span>
                <Money cents={transaction.amountCents} currency={currency} className="positive" />
              </li>
            ))}
          </ul>
        )}
      </Card>

      <div className="dashboard-grid">
        <Card
          title="Due soon"
          subtitle="Bills and card payments in the next two weeks"
        >
          {upcoming.length === 0 ? (
            <EmptyState
              icon={<CalendarClock size={20} />}
              title="Nothing due"
              body="Nothing lands in the next 14 days."
            />
          ) : (
            <ul className="due-list">
              {upcoming.map((item) => (
                <li
                  key={item.key}
                  className={item.daysUntil <= 2 ? 'due-row due-row-soon' : 'due-row'}
                >
                  <span className={`account-dot ${item.kind === 'card' ? 'kind-credit' : 'kind-bill'}`} />
                  <span className="due-name">{item.name}</span>
                  <span className="due-when">
                    {item.daysUntil === 0 ? 'Today' : `in ${item.daysUntil}d`} ·{' '}
                    {formatDateLabel(item.dueOn)}
                  </span>
                  <Money cents={item.amountCents} currency={currency} />
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card
          title="Spending this month"
          subtitle={`${formatMonthLong(monthKey)} · expenses and bill payments by category`}
        >
          {spending.length === 0 ? (
            <EmptyState
              icon={<Wallet size={20} />}
              title="No spending recorded"
              body="Expenses and bill payments dated this month will show up here, grouped by category."
            />
          ) : (
            <>
              <ul className="spend-list">
                {spending.slice(0, 6).map((row) => (
                  <li key={row.key}>
                    <span
                      className="dot"
                      style={{ background: row.color ?? 'var(--text-muted)' }}
                    />
                    <span className="spend-name">{row.name}</span>
                    <span className="spend-bar" aria-hidden="true">
                      <span
                        style={{
                          width: `${spendingTotal > 0 ? (row.totalCents / spendingTotal) * 100 : 0}%`,
                          background: row.color ?? 'var(--text-muted)'
                        }}
                      />
                    </span>
                    <Money cents={row.totalCents} currency={currency} />
                  </li>
                ))}
              </ul>
              <p className="footnote">
                {formatMoney(spendingTotal, currency)} across{' '}
                {spending.length === 1 ? '1 category' : `${spending.length} categories`}
                {spending.length > 6 ? ', top six shown' : ''}
                {snapshot.transactions.length < snapshot.transactionTotal
                  ? `, from the newest ${snapshot.transactions.length} entries`
                  : ''}
              </p>
            </>
          )}
        </Card>
      </div>

      <div className="stat-grid">
        <article className="stat-card">
          <div className="stat-top">
            <span className="stat-label">Cash on hand</span>
            <Wallet size={16} className="stat-icon" />
          </div>
          <p className="stat-value">
            <Money cents={cash} currency={currency} compact />
          </p>
          <p className="stat-hint">
            Across {activeAccountCount}{' '}
            {activeAccountCount === 1 ? 'tracked account' : 'tracked accounts'}
          </p>
        </article>

        <article className="stat-card">
          <div className="stat-top">
            <span className="stat-label">Bills each month</span>
            <ShieldCheck size={16} className="stat-icon" />
          </div>
          <p className="stat-value">
            <Money cents={wall} currency={currency} compact />
          </p>
          <p className="stat-hint">
            {formatMoney(perCheck, currency)} set aside from each paycheck
          </p>
        </article>

        <article className="stat-card">
          <div className="stat-top">
            <span className="stat-label">Goals saved</span>
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
            <span className="stat-label">Fun money last paycheck</span>
            <Sparkles size={16} className="stat-icon" />
          </div>
          <p className="stat-value">
            <Money cents={last?.leisureCents ?? 0} currency={currency} compact />
          </p>
          <p className="stat-hint">
            {last ? `From your ${formatDateLong(last.receivedOn)} paycheck` : 'No paycheck planned yet'}
          </p>
        </article>
      </div>

      <div className="dashboard-grid">
        <Card
          title="Accounts"
          subtitle="Balances build from your entries, never typed over"
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
          title="Where this month's pay went"
          subtitle={
            snapshot.paycheckTotal > snapshot.paychecks.length
              ? `${formatMonthLong(monthKey)} · newest ${snapshot.paychecks.length} of ${snapshot.paycheckTotal} paychecks loaded`
              : `${formatMonthLong(monthKey)} · every dollar you planned`
          }
        >
          {routing.totalCents === 0 ? (
            <EmptyState
              icon={<Sparkles size={20} />}
              title="No paycheck planned this month"
              body="Once you route a paycheck, this ring shows where the money went."
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
          title="Last paycheck plan"
          subtitle={last ? formatDateLong(last.receivedOn) : 'No paycheck planned yet'}
          actions={
            last ? (
              <Button size="sm" onClick={() => setMoving(true)}>
                Change this plan
              </Button>
            ) : undefined
          }
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
                    ? `${formatMoney(last.priorityCents, currency)} set aside for bills first`
                    : 'No bills set aside in this cycle'}
                </span>
              </div>
            </div>
          ) : (
            <EmptyState
              icon={<Sparkles size={20} />}
              title="No paycheck planned yet"
              body="Enter what you were paid and WageRoute sets bills aside first, then splits what is left."
              action={
                <Button variant="primary" onClick={openAllocator}>
                  Plan your first paycheck
                </Button>
              }
            />
          )}
        </Card>

        <Card title="Goals at a glance" subtitle="What you have set aside so far">
          <div className="goal-strip-body">
            {activeGoals.length === 0 ? (
              <EmptyState
                icon={<Target size={20} />}
                title="No goals yet"
                body="Create a goal and each paycheck puts a little money toward it."
                action={<Button onClick={() => go('goals')}>Create a goal</Button>}
              />
            ) : (
              activeGoals.map((goal) => (
                <div key={goal.id} className="goal-strip-row">
                  <div className="goal-strip-head">
                    <span className="cell-strong">{goal.name}</span>
                    <span className="num muted">
                      {formatMoney(goal.fundedCents, currency)} /{' '}
                      {formatMoney(goal.targetCents, currency)}
                    </span>
                  </div>
                  <Progress
                    value={goal.fundedCents}
                    max={goal.targetCents}
                    color={goal.color}
                    label={`${goal.name} funded`}
                  />
                </div>
              ))
            )}
          </div>
        </Card>
      </div>

      <Card
        title="Recent entries"
        subtitle={`${snapshot.transactionTotal} ${snapshot.transactionTotal === 1 ? 'entry' : 'entries'} saved on this device`}
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
          <DataTable
            caption="The newest entries in the ledger"
            columns={[
              { key: 'date', label: 'Date' },
              { key: 'description', label: 'Description' },
              { key: 'account', label: 'Account' },
              { key: 'category', label: 'Category' },
              { key: 'amount', label: 'Amount', className: 'right' }
            ]}
          >
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
          </DataTable>
        )}
      </Card>

      {moving && last && (
        <MovePlanDialog paycheck={last} onClose={() => setMoving(false)} />
      )}

      {addingIncome && <IncomeDialog onClose={() => setAddingIncome(false)} />}
    </>
  )
}

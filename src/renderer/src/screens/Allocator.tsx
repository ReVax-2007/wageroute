import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { AlertTriangle, ArrowLeft, ArrowRight, Sparkles, X } from 'lucide-react'
import { buildAllocationPlan, type PlanWarning } from '@shared/allocator'
import { PAY_CADENCE_LABEL } from '@shared/cadence'
import { todayISO } from '@shared/dates'
import { formatMoney, parseMoneyToCents } from '@shared/money'
import type { PayCadence } from '@shared/types'
import { Button, Money } from '../components/ui'
import { activeBills } from '../lib/finance'
import { useFinanceStore } from '../store/useFinanceStore'

const CADENCES = Object.keys(PAY_CADENCE_LABEL) as PayCadence[]

const STEPS = [
  { id: 1, label: 'Income' },
  { id: 2, label: 'Priority Wall' },
  { id: 3, label: 'Distribute' }
] as const

type Step = (typeof STEPS)[number]['id']

function warningText(warning: PlanWarning, currency: string): string {
  switch (warning.code) {
    case 'shortfall':
      return `This paycheck is ${formatMoney(warning.shortfallCents, currency)} short of your Priority Wall. Fund the bills before routing anything else.`
    case 'splits_scaled':
      return `Your splits asked for ${formatMoney(warning.requestedCents, currency)}, but only ${formatMoney(warning.availableCents, currency)} of surplus exists. They were scaled down proportionally.`
    case 'goal_overflow':
      return `${formatMoney(warning.overflowCents, currency)} was budgeted for goals that are already fully funded, so it swept into savings.`
    case 'no_bills':
      return 'Your Priority Wall is empty. Add recurring bills so they are protected before leisure.'
    case 'no_goals':
      return 'No sinking funds exist yet, so the goal share flowed into savings.'
    case 'tight_margin':
      return `Only ${formatMoney(warning.leisureCents, currency)} is left guilt-free after this plan.`
    default:
      return ''
  }
}

export function Allocator() {
  const open = useFinanceStore((state) => state.allocatorOpen)
  const close = useFinanceStore((state) => state.closeAllocator)
  const snapshot = useFinanceStore((state) => state.snapshot)
  const settings = useFinanceStore((state) => state.settings)
  const commitPaycheck = useFinanceStore((state) => state.commitPaycheck)
  const saveSettings = useFinanceStore((state) => state.saveSettings)
  const busy = useFinanceStore((state) => state.busy)

  const [step, setStep] = useState<Step>(1)
  const [income, setIncome] = useState('')
  const [receivedOn, setReceivedOn] = useState(todayISO())
  const [source, setSource] = useState('Payroll')
  const [accountId, setAccountId] = useState('')
  const [cadence, setCadence] = useState<PayCadence>('biweekly')
  const [savings, setSavings] = useState(20)
  const [investment, setInvestment] = useState(15)
  const [goalsSplit, setGoalsSplit] = useState(15)
  const [debtSplit, setDebtSplit] = useState(0)
  const [wholeDollars, setWholeDollars] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    const accounts = snapshot?.accounts ?? []
    const preferred = accounts.find((account) => account.kind === 'checking') ?? accounts[0]
    setStep(1)
    setIncome('')
    setReceivedOn(todayISO())
    setSource('Payroll')
    setAccountId(preferred?.id ?? '')
    setCadence(settings.payCadence)
    setSavings(settings.savingsPercent)
    setInvestment(settings.investmentPercent)
    setGoalsSplit(settings.goalsPercent)
    setDebtSplit(settings.debtPercent)
    setWholeDollars(settings.wholeDollarBuckets)
    setError(null)
  }, [open])

  const incomeCents = parseMoneyToCents(income) ?? 0
  const bills = useMemo(() => activeBills(snapshot?.bills ?? []), [snapshot?.bills])
  const activeGoals = useMemo(
    () =>
      (snapshot?.goals ?? []).filter(
        (goal) => !(goal.isEmergency && !settings.emergencyActive)
      ),
    [snapshot?.goals, settings.emergencyActive]
  )

  const plan = useMemo(
    () =>
      buildAllocationPlan({
        incomeCents,
        payCadence: cadence,
        bills,
        goals: activeGoals,
        splits: {
          savingsPercent: savings,
          investmentPercent: investment,
          goalsPercent: goalsSplit,
          debtPercent: debtSplit
        },
        wholeDollarBuckets: wholeDollars
      }),
    [
      incomeCents,
      cadence,
      bills,
      activeGoals,
      savings,
      investment,
      goalsSplit,
      debtSplit,
      wholeDollars
    ]
  )

  if (!open || !snapshot) return null

  const currency = settings.currency
  const splitTotal = savings + investment + goalsSplit + debtSplit
  const overAllocated = splitTotal > 100
  const warnings = incomeCents > 0 ? plan.warnings : []
  const visibleWarnings = overAllocated
    ? warnings.filter((warning) => warning.code !== 'splits_scaled')
    : warnings

  const goNext = () => {
    setError(null)
    setStep((current) => (current < 3 ? ((current + 1) as Step) : current))
  }

  const goBack = () => {
    setError(null)
    setStep((current) => (current > 1 ? ((current - 1) as Step) : current))
  }

  const submit = async () => {
    if (incomeCents <= 0) {
      setError('Enter the paycheck amount first')
      setStep(1)
      return
    }
    if (!accountId) {
      setError('Choose the account this money landed in')
      setStep(1)
      return
    }
    if (overAllocated) {
      setError(`Splits add up to ${splitTotal}% of the surplus. Bring them to 100% or less.`)
      return
    }

    setError(null)
    const splits = {
      savingsPercent: savings,
      investmentPercent: investment,
      goalsPercent: goalsSplit,
      debtPercent: debtSplit
    }

    await saveSettings({
      ...settings,
      payCadence: cadence,
      ...splits,
      wholeDollarBuckets: wholeDollars
    })

    const ok = await commitPaycheck({
      incomeCents,
      receivedOn,
      source: source.trim() || 'Paycheck',
      depositAccountId: accountId,
      payCadence: cadence,
      splits,
      wholeDollarBuckets: wholeDollars
    })

    if (!ok) setError('The paycheck was not routed. See the message at the bottom of the window.')
  }

  return (
    <div
      className="allocator-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) close()
      }}
    >
      <div
        className="allocator-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Route a paycheck"
      >
        <header className="allocator-head">
          <div>
            <p className="eyebrow">Paycheck allocator</p>
            <h2>Route this paycheck</h2>
            <p className="page-sub">Bills first. Surplus second. Guilt-free last.</p>
          </div>
          <button type="button" className="icon-btn" onClick={close} aria-label="Close">
            <X size={18} />
          </button>
        </header>

        <nav className="wizard-rail" aria-label="Allocator steps">
          {STEPS.map((entry) => {
            const state = entry.id < step ? 'done' : entry.id === step ? 'active' : 'todo'
            return (
              <button
                key={entry.id}
                type="button"
                className={`wizard-step-chip ${state}`}
                aria-current={entry.id === step ? 'step' : undefined}
                disabled={entry.id > step}
                onClick={() => {
                  if (entry.id < step) {
                    setError(null)
                    setStep(entry.id)
                  }
                }}
              >
                <span className="wizard-step-number">{entry.id}</span>
                <span>{entry.label}</span>
              </button>
            )
          })}
        </nav>

        <div className="allocator-body">
          <div className="wizard-step" key={step}>
            {step === 1 && (
              <section className="alloc-section">
                <div className="alloc-section-head">
                  <div>
                    <h3>What landed?</h3>
                    <p>Enter the deposit, then tell us where it arrived.</p>
                  </div>
                </div>

                <div className="alloc-income">
                  <span className="income-prefix">$</span>
                  <input
                    className="income-input"
                    autoFocus
                    inputMode="decimal"
                    placeholder="0.00"
                    aria-label="Paycheck amount"
                    value={income}
                    onChange={(event) => setIncome(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && incomeCents > 0) goNext()
                    }}
                  />
                </div>

                <div className="form-grid compact">
                  <label className="field">
                    <span className="field-label">Pay date</span>
                    <input
                      className="input"
                      type="date"
                      value={receivedOn}
                      onChange={(event) => setReceivedOn(event.target.value)}
                    />
                  </label>
                  <label className="field">
                    <span className="field-label">Source</span>
                    <input
                      className="input"
                      value={source}
                      onChange={(event) => setSource(event.target.value)}
                    />
                  </label>
                  <label className="field">
                    <span className="field-label">Deposited into</span>
                    <select
                      className="select"
                      value={accountId}
                      onChange={(event) => setAccountId(event.target.value)}
                    >
                      {snapshot.accounts.map((account) => (
                        <option key={account.id} value={account.id}>
                          {account.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    <span className="field-label">Pay cadence</span>
                    <select
                      className="select"
                      value={cadence}
                      onChange={(event) => setCadence(event.target.value as PayCadence)}
                    >
                      {CADENCES.map((option) => (
                        <option key={option} value={option}>
                          {PAY_CADENCE_LABEL[option]}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>

                <p className="wizard-hint">
                  Next we hold back{' '}
                  <strong>{formatMoney(plan.priorityRequiredCents, currency)}</strong> for the
                  Priority Wall, leaving the true surplus to route.
                </p>

                {error && <p className="form-error">{error}</p>}
              </section>
            )}

            {step === 2 && (
              <section className="alloc-section">
                <div className="alloc-section-head">
                  <div>
                    <h3>Subtract the Priority Wall</h3>
                    <p>Bills are locked before a single surplus dollar is split.</p>
                  </div>
                </div>

                <div className="alloc-line">
                  <div>
                    <span className="alloc-label">
                      {bills.length} active {bills.length === 1 ? 'bill' : 'bills'}
                    </span>
                    <p className="alloc-note">
                      {PAY_CADENCE_LABEL[cadence]} reserve for the wall
                    </p>
                  </div>
                  <Money
                    cents={plan.priorityRequiredCents}
                    currency={currency}
                    className="alloc-amount"
                  />
                </div>

                {plan.priorityReserves.length > 0 && (
                  <details className="priority-breakdown">
                    <summary>See the breakdown</summary>
                    <ul>
                      {plan.priorityReserves.map((reserve) => (
                        <li key={reserve.billId}>
                          <span>{reserve.name}</span>
                          <span className="num">
                            {formatMoney(reserve.reserveCents, currency)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </details>
                )}

                <div className="surplus-hero true-surplus">
                  <div>
                    <p className="eyebrow">True surplus</p>
                    <p className="surplus-value">
                      <Money cents={plan.surplusCents} currency={currency} />
                    </p>
                    <p className="alloc-note">
                      {formatMoney(plan.incomeCents, currency)} income −{' '}
                      {formatMoney(plan.priorityFundedCents, currency)} wall
                    </p>
                  </div>
                  <Sparkles size={26} className="surplus-icon" />
                </div>

                {plan.shortfallCents > 0 ? (
                  <Warning tone="danger">
                    This paycheck cannot cover the wall. You are{' '}
                    {formatMoney(plan.shortfallCents, currency)} short, so there is no surplus to
                    distribute.
                  </Warning>
                ) : (
                  <p className="wizard-hint">
                    Everything above the wall is yours to route. Continue to split it across
                    savings, investments, sinking funds and debt.
                  </p>
                )}
              </section>
            )}

            {step === 3 && (
              <section className="alloc-section">
                <div className="alloc-section-head">
                  <div>
                    <h3>Distribute the true surplus</h3>
                    <p>Percentages apply to what is left after bills.</p>
                  </div>
                </div>

                <div className="surplus-hero">
                  <div>
                    <p className="eyebrow">True surplus</p>
                    <p className="surplus-value">
                      <Money cents={plan.surplusCents} currency={currency} />
                    </p>
                    <p className="alloc-note">
                      {formatMoney(plan.incomeCents, currency)} income −{' '}
                      {formatMoney(plan.priorityFundedCents, currency)} wall
                    </p>
                  </div>
                  <Sparkles size={26} className="surplus-icon" />
                </div>

                <div className="split-list">
                  <SplitRow
                    label="Savings"
                    color="var(--savings)"
                    percent={savings}
                    amountCents={plan.savingsCents}
                    currency={currency}
                    onChange={setSavings}
                  />
                  <SplitRow
                    label="Investments"
                    color="var(--investment)"
                    percent={investment}
                    amountCents={plan.investmentCents}
                    currency={currency}
                    onChange={setInvestment}
                  />
                  <SplitRow
                    label="Sinking funds"
                    color="var(--goal)"
                    percent={goalsSplit}
                    amountCents={plan.goalsCents}
                    currency={currency}
                    onChange={setGoalsSplit}
                  />
                  <SplitRow
                    label="Debt payoff"
                    color="var(--debt)"
                    percent={debtSplit}
                    amountCents={plan.debtCents}
                    currency={currency}
                    onChange={setDebtSplit}
                  />
                </div>

                <div className={overAllocated ? 'split-check over' : 'split-check'}>
                  <span>Routed {splitTotal}% of the True Surplus</span>
                  <span>
                    {overAllocated
                      ? `${splitTotal - 100}% over — lower a split`
                      : `${100 - splitTotal}% stays guilt-free`}
                  </span>
                </div>

                <label className="check">
                  <input
                    type="checkbox"
                    checked={wholeDollars}
                    onChange={(event) => setWholeDollars(event.target.checked)}
                  />
                  Round every bucket to whole dollars
                </label>

                <div className="leisure-box">
                  <div>
                    <p className="eyebrow">Guilt-free</p>
                    <p className="alloc-note">Whatever the plan leaves unassigned</p>
                  </div>
                  <Money
                    cents={plan.leisureCents}
                    currency={currency}
                    className="leisure-value"
                  />
                </div>

                {plan.goalFundings.length > 0 && (
                  <div className="funded-this-check">
                    <p className="eyebrow">Funded from this paycheck</p>
                    <ul className="funding-list">
                      {plan.goalFundings.map((funding) => (
                        <li key={funding.goalId}>
                          <div>
                            <span className="cell-strong">{funding.name}</span>
                            <p className="alloc-note">
                              Needs {formatMoney(funding.needCents, currency)} to finish
                            </p>
                          </div>
                          <Money cents={funding.amountCents} currency={currency} />
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {visibleWarnings.length > 0 && (
                  <div className="warnings">
                    {visibleWarnings.map((warning) => (
                      <Warning
                        key={warning.code}
                        tone={
                          warning.code === 'shortfall' || warning.code === 'splits_scaled'
                            ? 'danger'
                            : 'warn'
                        }
                      >
                        {warningText(warning, currency)}
                      </Warning>
                    ))}
                  </div>
                )}

                {error && <p className="form-error">{error}</p>}
              </section>
            )}
          </div>
        </div>

        <footer className="allocator-foot">
          {step === 3 && (
            <div className="route-check">
              <span>Locked {formatMoney(plan.priorityFundedCents, currency)}</span>
              <span className="route-sep">+</span>
              <span>Save {formatMoney(plan.savingsCents, currency)}</span>
              <span className="route-sep">+</span>
              <span>Invest {formatMoney(plan.investmentCents, currency)}</span>
              <span className="route-sep">+</span>
              <span>Debt {formatMoney(plan.debtCents, currency)}</span>
              <span className="route-sep">+</span>
              <span>Goals {formatMoney(plan.goalsCents, currency)}</span>
              <span className="route-sep">+</span>
              <span>Leisure {formatMoney(plan.leisureCents, currency)}</span>
              <span className="route-total">= {formatMoney(plan.incomeCents, currency)}</span>
            </div>
          )}

          <div className="allocator-actions">
            {step === 1 ? (
              <Button variant="quiet" onClick={close} disabled={busy}>
                Cancel
              </Button>
            ) : (
              <Button
                variant="quiet"
                icon={<ArrowLeft size={15} />}
                onClick={goBack}
                disabled={busy}
              >
                Back
              </Button>
            )}

            {step < 3 ? (
              <Button
                variant="primary"
                icon={<ArrowRight size={16} />}
                onClick={goNext}
                disabled={busy || incomeCents <= 0}
              >
                {step === 1 ? 'Subtract the wall' : 'Distribute the surplus'}
              </Button>
            ) : (
              <Button
                variant="primary"
                icon={<ArrowRight size={16} />}
                onClick={submit}
                disabled={busy || incomeCents <= 0 || overAllocated}
              >
                {overAllocated
                  ? 'Splits exceed 100%'
                  : incomeCents > 0
                    ? `Route ${formatMoney(incomeCents, currency)}`
                    : 'Route paycheck'}
              </Button>
            )}
          </div>
        </footer>
      </div>
    </div>
  )
}

function Warning({ tone, children }: { tone: 'warn' | 'danger'; children: ReactNode }) {
  return (
    <div className={`warning ${tone}`}>
      <AlertTriangle size={16} />
      <span>{children}</span>
    </div>
  )
}

function SplitRow({
  label,
  color,
  percent,
  amountCents,
  currency,
  onChange
}: {
  label: string
  color: string
  percent: number
  amountCents: number
  currency: string
  onChange: (value: number) => void
}) {
  return (
    <div className="split-row">
      <span className="split-dot" style={{ background: color }} />
      <div className="split-name">
        <span>{label}</span>
        <span className="split-amount num">{formatMoney(amountCents, currency)}</span>
      </div>
      <input
        type="range"
        min={0}
        max={100}
        step={1}
        value={percent}
        aria-label={`${label} percent`}
        className="split-range"
        style={{ accentColor: color }}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <input
        type="number"
        min={0}
        max={100}
        className="percent-input"
        aria-label={`${label} percent`}
        value={percent}
        onChange={(event) =>
          onChange(Math.min(100, Math.max(0, Math.round(Number(event.target.value) || 0))))
        }
      />
      <span className="percent-sign">%</span>
    </div>
  )
}

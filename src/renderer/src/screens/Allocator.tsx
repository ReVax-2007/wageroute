import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { AlertTriangle, ArrowLeft, ArrowRight, Sparkles, X } from 'lucide-react'
import { buildAllocationPlan, type PlanWarning } from '@shared/allocator'
import { PAY_CADENCE_LABEL } from '@shared/cadence'
import { daysBetweenISO, formatMonthLong, isISODate, todayISO } from '@shared/dates'
import { currencySymbol, formatMoney, parseMoneyToCents, sanitizeMoneyInput } from '@shared/money'
import type { BillPaymentTotal, PayCadence } from '@shared/types'
import { backdropHandlers, Button, Money, useDialog } from '../components/ui'
import { activeBills, fundableAccounts } from '../lib/finance'
import { useFinanceStore } from '../store/useFinanceStore'

const CADENCES = Object.keys(PAY_CADENCE_LABEL) as PayCadence[]

const STEPS = [
  { id: 1, label: 'Income' },
  { id: 2, label: 'Bills' },
  { id: 3, label: 'Split it up' }
] as const

type Step = (typeof STEPS)[number]['id']

/** One id per open draft, so a retried commit cannot write the paycheck twice. */
function newDraftId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function warningText(warning: PlanWarning, currency: string): string {
  switch (warning.code) {
    case 'shortfall':
      return `This paycheck is ${formatMoney(warning.shortfallCents, currency)} short of your bills. Cover the bills before planning anything else.`
    case 'splits_scaled':
      return `Your splits asked for ${formatMoney(warning.requestedCents, currency)}, but only ${formatMoney(warning.availableCents, currency)} is left. They were scaled down to fit.`
    case 'goal_overflow':
      return `${formatMoney(warning.overflowCents, currency)} was meant for goals that are already fully funded, so it went to savings.`
    case 'no_bills':
      return 'You have no bills yet. Add recurring bills so they are covered before fun money.'
    case 'no_goals':
      return 'You have no goals yet, so the goal share went to savings.'
    case 'goals_account_funded':
      return `Your goals are paid from their own accounts, so the ${formatMoney(warning.overflowCents, currency)} goal share went to savings. Add a goal that draws from this money to keep it here.`
    case 'tight_margin':
      return `Only ${formatMoney(warning.leisureCents, currency)} is left for fun after this plan.`
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
  const go = useFinanceStore((state) => state.go)

  // A routing write must finish before Escape or a backdrop click hides it.
  const closeIfIdle = () => {
    if (!busy) close()
  }
  const panelRef = useDialog(closeIfIdle, open)
  const backdrop = backdropHandlers(closeIfIdle)
  const titleId = useId()
  const subtitleId = useId()
  const draftId = useRef(newDraftId())

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
  const [confirmedDuplicate, setConfirmedDuplicate] = useState(false)

  // A paycheck lands in a deposit account, never on a credit card.
  const depositAccounts = useMemo(
    () => fundableAccounts(snapshot?.accounts ?? []),
    [snapshot?.accounts]
  )

  useEffect(() => {
    if (!open) return
    draftId.current = newDraftId()
    const preferred =
      depositAccounts.find((account) => account.id === settings.defaultDepositAccountId) ??
      depositAccounts.find((account) => account.kind === 'checking') ??
      depositAccounts[0]
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
  // The snapshot's payment totals are keyed to today, while a cheque is reserved
  // against the month it is dated into. Ask for that month instead; today's
  // month is already in the snapshot, so it needs no read. A cleared date falls
  // back to today so the preview still renders while the user picks one.
  const currentMonth = todayISO().slice(0, 7)
  const payMonth = isISODate(receivedOn) ? receivedOn.slice(0, 7) : currentMonth
  const [paymentsFor, setPaymentsFor] = useState<{
    month: string
    totals: BillPaymentTotal[]
  } | null>(null)
  const [failedMonth, setFailedMonth] = useState<string | null>(null)

  useEffect(() => {
    if (!open || payMonth === currentMonth) return
    let cancelled = false
    window.api.billPayments(payMonth).then(
      (totals) => {
        if (cancelled) return
        setPaymentsFor({ month: payMonth, totals })
        setFailedMonth(null)
      },
      () => {
        if (!cancelled) setFailedMonth(payMonth)
      }
    )
    return () => {
      cancelled = true
    }
  }, [open, payMonth, currentMonth])

  // An unanswered or failed read holds the whole month: over-reserving costs a
  // smaller surplus, while under-reserving hides money the wall still needs.
  const monthPayments =
    payMonth === currentMonth
      ? (snapshot?.billPaymentsThisMonth ?? [])
      : paymentsFor?.month === payMonth
        ? paymentsFor.totals
        : []
  const paymentsFailed = payMonth !== currentMonth && failedMonth === payMonth

  // A bill already paid this month must not be withheld from this cheque; the
  // plan asks only for what the month still owes.
  const bills = useMemo(() => {
    const paid = new Map(
      monthPayments.map((total) => [
        total.billId,
        // A card charge settles the bill without taking cash out, so the preview
        // must release the same amount the repository will withhold.
        Math.max(0, total.paidCents - total.creditCents)
      ])
    )
    return activeBills(snapshot?.bills ?? []).map((bill) => ({
      ...bill,
      paidThisMonthCents: paid.get(bill.id) ?? 0
    }))
  }, [snapshot?.bills, monthPayments])
  const activeGoals = useMemo(
    () =>
      (snapshot?.goals ?? []).filter(
        (goal) => !goal.isArchived && !(goal.isEmergency && !settings.emergencyActive)
      ),
    [snapshot?.goals, settings.emergencyActive]
  )
  // The month's live claims tell the plan what an earlier cheque already
  // carried. Paid claims are left out: their payment is in `monthPayments`.
  const monthClaims = useMemo(
    () =>
      (snapshot?.billReserves ?? [])
        .filter((reserve) => reserve.cycle === payMonth && reserve.state === 'reserved')
        .map((reserve) => ({
          billId: reserve.billId,
          amountCents: reserve.amountCents,
          strategy: reserve.strategy
        })),
    [snapshot?.billReserves, payMonth]
  )

  // The repository refuses both cases. Say which one the screen found, so the
  // confirmation the user gives is about the deposit they actually made.
  const duplicate = useMemo(() => {
    const checks = snapshot?.paychecks ?? []
    const sameDay = checks.find(
      (paycheck) => paycheck.depositAccountId === accountId && paycheck.receivedOn === receivedOn
    )
    if (sameDay) return { kind: 'same-day' as const, paycheck: sameDay }
    const near = checks.find(
      (paycheck) =>
        paycheck.depositAccountId === accountId &&
        paycheck.amountCents === incomeCents &&
        Math.abs(daysBetweenISO(paycheck.receivedOn, receivedOn)) <= 3
    )
    return near ? { kind: 'near-amount' as const, paycheck: near } : null
  }, [snapshot?.paychecks, receivedOn, incomeCents, accountId])

  useEffect(() => {
    setConfirmedDuplicate(false)
  }, [receivedOn, incomeCents, accountId])

  const plan = useMemo(
    () =>
      buildAllocationPlan({
        incomeCents,
        payCadence: cadence,
        paycheckDate: receivedOn,
        payAnchorDate: settings.payAnchorDate,
        monthClaims,
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
      receivedOn,
      settings.payAnchorDate,
      monthClaims,
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
  // Lines at zero are bills this month already covers; listing them would make
  // a settled wall look like it is still asking for money.
  const listedReserves = plan.priorityReserves.filter((reserve) => reserve.reserveCents > 0)
  const coveredBills = plan.priorityReserves.length - listedReserves.length
  const splitTotal = savings + investment + goalsSplit + debtSplit
  const overAllocated = splitTotal > 100
  const capFor = (percent: number) => Math.max(0, 100 - (splitTotal - percent))
  const payday = settings.paydayLabel.trim()
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
    if (duplicate && !confirmedDuplicate) {
      setConfirmedDuplicate(true)
      setError(null)
      return
    }

    setError(null)
    const splits = {
      savingsPercent: savings,
      investmentPercent: investment,
      goalsPercent: goalsSplit,
      debtPercent: debtSplit
    }

    const settingsSaved = await saveSettings({
      ...settings,
      payCadence: cadence,
      ...splits,
      wholeDollarBuckets: wholeDollars
    })
    // The store rolled the split back when the write failed. Routing anyway
    // would record a paycheck the screen no longer agrees with.
    if (!settingsSaved) {
      setError(
        'The paycheck was not routed — this split could not be saved, so nothing was written.'
      )
      return
    }

    const ok = await commitPaycheck({
      incomeCents,
      receivedOn,
      source: source.trim() || 'Paycheck',
      depositAccountId: accountId,
      payCadence: cadence,
      splits,
      wholeDollarBuckets: wholeDollars,
      draftId: draftId.current,
      allowDuplicate: confirmedDuplicate
    })

    if (!ok) {
      setError(
        'The paycheck was not routed — nothing was saved. The message at the bottom explains why.'
      )
    }
  }

  return (
    <div className="allocator-backdrop" {...backdrop}>
      <div
        ref={panelRef}
        className="allocator-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={subtitleId}
        tabIndex={-1}
      >
        <header className="allocator-head">
          <div>
            <p className="eyebrow">New paycheck</p>
            <h2 id={titleId}>Plan this paycheck</h2>
            <p id={subtitleId} className="page-sub">
              Bills first, then the rest gets a job.
            </p>
          </div>
          <button
            type="button"
            className="icon-btn"
            onClick={closeIfIdle}
            disabled={busy}
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </header>

        <nav className="wizard-rail" aria-label="Paycheck steps">
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
                    <h3>How much landed?</h3>
                    <p>Enter the deposit and where it arrived.</p>
                  </div>
                </div>

                <div className="alloc-income">
                  <span className="income-prefix">{currencySymbol(currency)}</span>
                  <input
                    className="income-input"
                    autoFocus
                    inputMode="decimal"
                    placeholder="0.00"
                    aria-label="Paycheck amount"
                    value={income}
                    onChange={(event) => setIncome(sanitizeMoneyInput(event.target.value))}
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
                    <span className="field-label">Where it came from</span>
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
                      {depositAccounts.length === 0 && <option value="">No account yet</option>}
                      {depositAccounts.map((account) => (
                        <option key={account.id} value={account.id}>
                          {account.name}
                        </option>
                      ))}
                    </select>
                    {depositAccounts.length === 0 && (
                      <span className="field-hint">
                        Add a checking or savings account, then open this screen again.
                      </span>
                    )}
                  </label>
                  <label className="field">
                    <span className="field-label">How often you are paid</span>
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

                {depositAccounts.length === 0 && (
                  <div className="setting-empty">
                    <p className="field-hint">
                      A paycheck has to land in a checking or savings account, and none exists yet.
                    </p>
                    <Button
                      size="sm"
                      onClick={() => {
                        close()
                        go('accounts')
                      }}
                    >
                      Add an account
                    </Button>
                  </div>
                )}

                <p className="wizard-hint">
                  Next we set aside{' '}
                  <strong>{formatMoney(plan.priorityRequiredCents, currency)}</strong> for bills.
                  The rest is yours to split.
                </p>

                <p className="field-hint">
                  {payday ? `Paydays: ${payday} — change this in Settings. ` : ''}
                  How often you are paid decides which paycheck a once-a-month bill comes out of.
                </p>

                {error && (
                  <p className="form-error" role="alert">
                    {error}
                  </p>
                )}
              </section>
            )}

            {step === 2 && (
              <section className="alloc-section">
                <div className="alloc-section-head">
                  <div>
                    <h3>Set aside bill money</h3>
                    <p>Bills come out first. Everything left is yours to split.</p>
                  </div>
                </div>

                <div className="alloc-line">
                  <div>
                    <span className="alloc-label">
                      {bills.length} {bills.length === 1 ? 'bill' : 'bills'}
                    </span>
                    <p className="alloc-note">
                      {PAY_CADENCE_LABEL[cadence]} amount for bills
                    </p>
                  </div>
                  <Money
                    cents={plan.priorityRequiredCents}
                    currency={currency}
                    className="alloc-amount"
                  />
                </div>

                {paymentsFailed && (
                  <Warning tone="warn">
                    The payments already made in {formatMonthLong(payMonth)} could not be read, so
                    this preview holds the whole month. Routing the cheque may reserve less.
                  </Warning>
                )}

                {listedReserves.length > 0 && (
                  <details className="priority-breakdown">
                    <summary>See the breakdown</summary>
                    <ul>
                      {listedReserves.map((reserve) => (
                        <li key={reserve.billId}>
                          <span>{reserve.name}</span>
                          <span className="num">
                            {formatMoney(reserve.reserveCents, currency)}
                          </span>
                        </li>
                      ))}
                    </ul>
                    {coveredBills > 0 && (
                      <p className="alloc-note">
                        {coveredBills} {coveredBills === 1 ? 'bill is' : 'bills are'} already
                        covered this month, so {coveredBills === 1 ? 'it asks' : 'they ask'} for
                        nothing here.
                      </p>
                    )}
                  </details>
                )}

                <div className="surplus-hero true-surplus">
                  <div>
                    <p className="eyebrow">Left to split</p>
                    <p className="surplus-value">
                      <Money cents={plan.surplusCents} currency={currency} />
                    </p>
                    <p className="alloc-note">
                      {formatMoney(plan.incomeCents, currency)} paycheck −{' '}
                      {formatMoney(plan.priorityFundedCents, currency)} bills
                    </p>
                  </div>
                  <Sparkles size={26} className="surplus-icon" />
                </div>

                {plan.shortfallCents > 0 ? (
                  <Warning tone="danger">
                    This paycheck does not cover your bills. You are{' '}
                    {formatMoney(plan.shortfallCents, currency)} short, so there is nothing left
                    to split.
                  </Warning>
                ) : (
                  <p className="wizard-hint">
                    What is left is yours to split between savings, investments, goals and debt.
                  </p>
                )}
              </section>
            )}

            {step === 3 && (
              <section className="alloc-section">
                <div className="alloc-section-head">
                  <div>
                    <h3>Split what is left</h3>
                    <p>Percentages apply to the money left after bills.</p>
                  </div>
                </div>

                <div className="surplus-hero">
                  <div>
                    <p className="eyebrow">Left to split</p>
                    <p className="surplus-value">
                      <Money cents={plan.surplusCents} currency={currency} />
                    </p>
                    <p className="alloc-note">
                      {formatMoney(plan.incomeCents, currency)} paycheck −{' '}
                      {formatMoney(plan.priorityFundedCents, currency)} bills
                    </p>
                  </div>
                  <Sparkles size={26} className="surplus-icon" />
                </div>

                <p className="wizard-hint">
                  This saves your plan against the deposit. WageRoute does not move money or pay
                  bills for you — the money stays where it landed until you move it yourself.
                </p>

                <div className="split-list">
                  <SplitRow
                    label="Savings"
                    color="var(--savings)"
                    percent={savings}
                    maxPercent={capFor(savings)}
                    amountCents={plan.savingsCents}
                    currency={currency}
                    onChange={setSavings}
                  />
                  <SplitRow
                    label="Investments"
                    color="var(--investment)"
                    percent={investment}
                    maxPercent={capFor(investment)}
                    amountCents={plan.investmentCents}
                    currency={currency}
                    onChange={setInvestment}
                  />
                  <SplitRow
                    label="Goals"
                    color="var(--goal)"
                    percent={goalsSplit}
                    maxPercent={capFor(goalsSplit)}
                    amountCents={plan.goalsCents}
                    currency={currency}
                    onChange={setGoalsSplit}
                  />
                  <SplitRow
                    label="Debt payoff"
                    color="var(--debt)"
                    percent={debtSplit}
                    maxPercent={capFor(debtSplit)}
                    amountCents={plan.debtCents}
                    currency={currency}
                    onChange={setDebtSplit}
                  />
                </div>

                <div
                  className={overAllocated ? 'split-check over' : 'split-check'}
                  aria-live={overAllocated ? 'polite' : undefined}
                >
                  <span>{splitTotal}% of what is left is split</span>
                  <span>
                    {overAllocated
                      ? `${splitTotal - 100}% over — lower a split`
                      : `${100 - splitTotal}% stays for fun`}
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
                    <p className="eyebrow">Fun money</p>
                    <p className="alloc-note">What the plan leaves for you</p>
                  </div>
                  <Money
                    cents={plan.leisureCents}
                    currency={currency}
                    className="leisure-value"
                  />
                </div>

                {plan.goalFundings.length > 0 && (
                  <div className="funded-this-check">
                    <p className="eyebrow">Goals getting money now</p>
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
                  <div className="warnings" role="status" aria-live="polite">
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

                {duplicate && (
                  <Warning tone="danger" alert>
                    {duplicate.kind === 'same-day'
                      ? `A paycheck of ${formatMoney(duplicate.paycheck.amountCents, currency)} is already routed into this account on ${receivedOn}. Confirm only if a second deposit really landed that day.`
                      : `${formatMoney(incomeCents, currency)} was already routed into this account on ${duplicate.paycheck.receivedOn}. Confirm only if this is a separate deposit.`}{' '}
                    Routing it twice adds the income a second time and sets bill money aside twice.
                  </Warning>
                )}

                {error && (
                  <p className="form-error" role="alert">
                    {error}
                  </p>
                )}
              </section>
            )}
          </div>
        </div>

        <footer className="allocator-foot">
          {step === 3 && (
            <div className="route-check">
              <span>Bills {formatMoney(plan.priorityFundedCents, currency)}</span>
              <span className="route-sep">+</span>
              <span>Save {formatMoney(plan.savingsCents, currency)}</span>
              <span className="route-sep">+</span>
              <span>Invest {formatMoney(plan.investmentCents, currency)}</span>
              <span className="route-sep">+</span>
              <span>Debt {formatMoney(plan.debtCents, currency)}</span>
              <span className="route-sep">+</span>
              <span>Goals {formatMoney(plan.goalsCents, currency)}</span>
              <span className="route-sep">+</span>
              <span>Fun {formatMoney(plan.leisureCents, currency)}</span>
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
                {step === 1 ? 'Set aside bills' : 'Split what is left'}
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
                  : duplicate
                    ? confirmedDuplicate
                      ? 'Confirm duplicate'
                      : 'Route it anyway'
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

function Warning({
  tone,
  alert = false,
  children
}: {
  tone: 'warn' | 'danger'
  alert?: boolean
  children: ReactNode
}) {
  return (
    <div className={`warning ${tone}`} role={alert ? 'alert' : undefined}>
      <AlertTriangle size={16} />
      <span>{children}</span>
    </div>
  )
}

function SplitRow({
  label,
  color,
  percent,
  maxPercent,
  amountCents,
  currency,
  onChange
}: {
  label: string
  color: string
  percent: number
  maxPercent: number
  amountCents: number
  currency: string
  onChange: (value: number) => void
}) {
  const clamp = (value: number) => Math.min(maxPercent, Math.max(0, Math.round(value || 0)))

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
        max={maxPercent}
        step={1}
        value={percent}
        aria-label={`${label} percent slider`}
        className="split-range"
        style={{ accentColor: color }}
        onChange={(event) => onChange(clamp(Number(event.target.value)))}
      />
      <input
        type="number"
        min={0}
        max={maxPercent}
        className="percent-input"
        aria-label={`${label} percent`}
        value={percent}
        onChange={(event) => onChange(clamp(Number(event.target.value)))}
      />
      <span className="percent-sign">%</span>
    </div>
  )
}

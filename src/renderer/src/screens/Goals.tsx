import { useState } from 'react'
import {
  Archive,
  CalendarDays,
  Landmark,
  LifeBuoy,
  Pause,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  Target,
  Trash2
} from 'lucide-react'
import { formatDateLong, monthsUntil, todayISO } from '@shared/dates'
import {
  EMERGENCY_MONTH_OPTIONS,
  averageMonthlyVariableCents,
  emergencyCoverageMonths,
  emergencyMonthlyEssentialsCents,
  recommendedEmergencyTargetCents
} from '@shared/emergency'
import { centsToEditable, formatMoney, parseMoneyToCents } from '@shared/money'
import type { EmergencyMode, GoalInput, GoalWithProgress } from '@shared/types'
import {
  Button,
  Card,
  EmptyState,
  Field,
  IconButton,
  Money,
  Progress,
  Segmented,
  Switch
} from '../components/ui'
import { GoalDialog } from '../components/dialogs/GoalDialog'
import { FundingAccountsPicker } from '../components/FundingAccountsPicker'
import { activeBills, fundableAccounts, monthlyWall } from '../lib/finance'
import { useFinanceStore } from '../store/useFinanceStore'

export function Goals() {
  const snapshot = useFinanceStore((state) => state.snapshot)
  const settings = useFinanceStore((state) => state.settings)
  const archiveGoal = useFinanceStore((state) => state.archiveGoal)
  const deleteGoal = useFinanceStore((state) => state.deleteGoal)
  const askConfirm = useFinanceStore((state) => state.askConfirm)
  const [editing, setEditing] = useState<GoalWithProgress | null | 'new'>(null)

  if (!snapshot) return null
  const currency = settings.currency
  const activeGoals = snapshot.goals.filter((goal) => !goal.isArchived)
  const archivedGoals = snapshot.goals.filter((goal) => goal.isArchived)

  return (
    <>
      <header className="page-head">
        <div>
          <p className="eyebrow">Sinking funds</p>
          <h1 className="page-title" tabIndex={-1}>Future expenses, funded on purpose</h1>
          <p className="page-sub">
            A tattoo, a trip, a new laptop — the allocator fills these before leisure.
          </p>
        </div>
        <Button variant="primary" icon={<Plus size={16} />} onClick={() => setEditing('new')}>
          New goal
        </Button>
      </header>

      <EmergencyCard />

      {activeGoals.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Target size={20} />}
            title="No sinking funds yet"
            body="Create a target and the allocator will route a slice of every surplus into it."
            action={
              <Button variant="primary" onClick={() => setEditing('new')}>
                Create your first goal
              </Button>
            }
          />
        </Card>
      ) : (
        <div className="goal-grid">
          {activeGoals.map((goal) => {
            // The repository already derives this; recomputing it here let the
            // card drift from the allocator that spends it.
            const remaining = Math.max(0, goal.remainingCents)
            const months = goal.targetDate ? monthsUntil(goal.targetDate, todayISO()) : null
            const monthlyNeed = months ? Math.ceil(remaining / months) : null
            const overdue = goal.targetDate !== null && goal.targetDate < todayISO()
            const notStarted = goal.fundedCents === 0
            const percent =
              goal.targetCents > 0
                ? Math.min(100, Math.round((goal.fundedCents / goal.targetCents) * 100))
                : 0

            return (
              <article key={goal.id} className="goal-card">
                <div className="goal-top">
                  <span className="goal-dot" style={{ background: goal.color }} />
                  <div className="goal-title">
                    <h3 title={goal.name}>{goal.name}</h3>
                    <p>
                      {goal.targetDate
                        ? `Target ${formatDateLong(goal.targetDate)}`
                        : 'No deadline set'}
                    </p>
                  </div>
                  <IconButton label="Edit goal" onClick={() => setEditing(goal)}>
                    <Pencil size={15} />
                  </IconButton>
                  <IconButton
                    label="Archive goal"
                    danger
                    onClick={() => void archiveGoal(goal.id, true)}
                  >
                    <Archive size={15} />
                  </IconButton>
                </div>

                <p className="goal-amount">
                  <Money cents={goal.fundedCents} currency={currency} />
                  <span className="goal-of">of {formatMoney(goal.targetCents, currency)}</span>
                </p>

                <Progress
                  value={goal.fundedCents}
                  max={goal.targetCents}
                  color={goal.color}
                  label={`${goal.name} funded`}
                />

                <div className="goal-meta">
                  <span>{notStarted ? 'Not started yet' : `${percent}% funded`}</span>
                  <span>{formatMoney(remaining, currency)} to go</span>
                </div>

                {goal.dedicatedAccounts.length > 0 && (
                  <ul className="goal-accounts">
                    {goal.dedicatedAccounts.map((account) => (
                      <li key={account.id}>
                        <span className="goal-account-name">{account.name}</span>
                        <span className="goal-account-balance num muted">
                          {formatMoney(account.balanceCents, currency)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}

                <div className="goal-foot">
                  {goal.dedicatedAccounts.length > 0 && (
                    <span className="chip chip-funded">
                      <Landmark size={12} />
                      {goal.dedicatedAccounts.length === 1
                        ? 'Dedicated account'
                        : `${goal.dedicatedAccounts.length} dedicated accounts`}
                    </span>
                  )}
                  <span className="chip">Priority {goal.priority}</span>
                  {overdue && <span className="chip chip-overdue">Overdue</span>}
                  {goal.isEmergency && (
                    <span className="chip chip-emergency">
                      <LifeBuoy size={12} /> Emergency
                    </span>
                  )}
                  {monthlyNeed !== null ? (
                    <span className="chip chip-quiet">
                      <CalendarDays size={12} /> {formatMoney(monthlyNeed, currency)}/mo
                    </span>
                  ) : (
                    <span className="chip chip-quiet">No pace set</span>
                  )}
                </div>
              </article>
            )
          })}
        </div>
      )}

      {archivedGoals.length > 0 && (
        <Card
          title="Archived goals"
          subtitle="Out of the allocator and every earmark. Restore one to start funding it again."
        >
          <ul className="account-list">
            {archivedGoals.map((goal) => (
              <li key={goal.id} className="account-row">
                <Archive size={15} className="muted" />
                <div className="account-name">
                  <span className="cell-strong">{goal.name}</span>
                  <span className="account-meta">
                    Priority {goal.priority} · archived
                  </span>
                </div>
                <div className="account-figures">
                  <Money cents={goal.fundedCents} currency={currency} />
                  <span className="account-meta">funded</span>
                </div>
                <IconButton
                  label={`Restore ${goal.name}`}
                  onClick={() => void archiveGoal(goal.id, false)}
                >
                  <RotateCcw size={14} />
                </IconButton>
                <IconButton
                  label={`Delete ${goal.name}`}
                  danger
                  onClick={() => {
                    void askConfirm({
                      title: `Delete “${goal.name}”?`,
                      body: 'The fund disappears for good. Money already moved into the ledger stays in its accounts and history.',
                      confirmLabel: 'Delete goal',
                      danger: true
                    }).then((ok) => {
                      if (ok) void deleteGoal(goal.id)
                    })
                  }}
                >
                  <Trash2 size={14} />
                </IconButton>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <p className="footnote">
        A goal reads its progress from the accounts you point at it — one account, or several whose
        balances add together. Every other goal counts the allocations recorded when a paycheck is
        routed, so moving that money is still your job.
      </p>

      {editing !== null && (
        <GoalDialog goal={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />
      )}
    </>
  )
}

function EmergencyCard() {
  const snapshot = useFinanceStore((state) => state.snapshot)
  const settings = useFinanceStore((state) => state.settings)
  const saveSettings = useFinanceStore((state) => state.saveSettings)
  const createGoal = useFinanceStore((state) => state.createGoal)
  const updateGoal = useFinanceStore((state) => state.updateGoal)
  const notify = useFinanceStore((state) => state.notify)

  const goal = snapshot?.goals.find((item) => item.isEmergency) ?? null
  const [mode, setMode] = useState<EmergencyMode>(settings.emergencyMode)
  const [months, setMonths] = useState(settings.emergencyMonths)
  const [includeVariable, setIncludeVariable] = useState(settings.emergencyIncludeVariable)
  const [manual, setManual] = useState(
    settings.emergencyManualTargetCents > 0
      ? centsToEditable(settings.emergencyManualTargetCents)
      : ''
  )
  const [selectedIds, setSelectedIds] = useState<string[]>(
    goal ? goal.dedicatedAccounts.map((account) => account.id) : []
  )
  const [saving, setSaving] = useState(false)

  if (!snapshot) return null

  const currency = settings.currency
  const isActive = settings.emergencyActive
  const eligible = fundableAccounts(snapshot.accounts)

  const wall = monthlyWall(activeBills(snapshot.bills))
  const variable = averageMonthlyVariableCents(snapshot.transactions, todayISO())
  const essentials = emergencyMonthlyEssentialsCents({
    wallMonthlyCents: wall,
    variableMonthlyCents: variable,
    includeVariable
  })
  const autoTarget = recommendedEmergencyTargetCents(essentials, months)
  const manualCents = mode === 'manual' ? parseMoneyToCents(manual) : null
  const targetCents = mode === 'manual' ? Math.max(0, manualCents ?? 0) : autoTarget
  const funded = goal?.fundedCents ?? 0
  const coverage = emergencyCoverageMonths(funded, essentials)

  const changeMode = (next: EmergencyMode) => {
    setMode(next)
    if (next === 'manual' && !manual.trim()) {
      setManual(
        centsToEditable(
          settings.emergencyManualTargetCents > 0
            ? settings.emergencyManualTargetCents
            : autoTarget
        )
      )
    }
  }

  const toggleActive = async () => {
    const next = !isActive
    if (await saveSettings({ ...settings, emergencyActive: next })) {
      notify(next ? 'Emergency saving resumed' : 'Emergency saving paused', 'success')
    }
  }

  const apply = async () => {
    if (targetCents <= 0) {
      notify('Set an emergency target above zero', 'error')
      return
    }
    setSaving(true)
    const settingsSaved = await saveSettings({
      ...settings,
      emergencyMode: mode,
      emergencyMonths: months,
      emergencyIncludeVariable: includeVariable,
      // The manual target is a saved preference: switching to automatic keeps
      // the number so switching back does not lose it.
      emergencyManualTargetCents:
        mode === 'manual' ? targetCents : settings.emergencyManualTargetCents
    })
    if (!settingsSaved) {
      setSaving(false)
      return
    }
    if (goal) {
      await updateGoal(goal.id, { targetCents, fundingAccountIds: selectedIds })
    } else {
      const input: GoalInput = {
        name: 'Emergency Fund',
        targetCents,
        targetDate: null,
        priority: 1,
        color: 'var(--savings)',
        accountId: selectedIds[0] ?? null,
        isEmergency: true,
        fundingAccountIds: selectedIds
      }
      await createGoal(input)
    }
    setSaving(false)
  }

  return (
    <Card
      title="Emergency fund"
      subtitle="Three to six months of essentials, calculated from your own numbers"
      className={isActive ? 'emergency-card' : 'emergency-card paused'}
      actions={<LifeBuoy size={17} className="stat-icon" />}
    >
      <div className="setting-row emergency-pause">
        <div>
          <strong>Save towards it every paycheck</strong>
          <p className="field-hint">
            {isActive
              ? 'Active · the allocator routes a slice of every surplus here before leisure.'
              : 'Paused · no paycheck sets money aside for it until you resume.'}
          </p>
        </div>
        <div className="emergency-pause-actions">
          {!isActive && <span className="chip chip-paused">Saving paused</span>}
          <Button
            variant={isActive ? 'quiet' : 'primary'}
            size="sm"
            icon={isActive ? <Pause size={13} /> : <Play size={13} />}
            onClick={() => void toggleActive()}
          >
            {isActive ? 'Pause' : 'Resume saving'}
          </Button>
        </div>
      </div>

      <div className="emergency-grid">
        <div className="emergency-controls">
          <Segmented<EmergencyMode>
            label="Emergency target mode"
            value={mode}
            onChange={changeMode}
            options={[
              { value: 'auto', label: 'Auto calculate' },
              { value: 'manual', label: 'Manual' }
            ]}
          />

          {mode === 'auto' ? (
            <>
              <Field label="Months of essentials" hint="Six months is the cautious end">
                <Segmented<string>
                  label="Months of essentials"
                  value={String(months)}
                  onChange={(value) => setMonths(Number(value))}
                  options={EMERGENCY_MONTH_OPTIONS.map((option) => ({
                    value: String(option),
                    label: `${option} mo`
                  }))}
                />
              </Field>
              <div className="setting-row">
                <div>
                  <strong>Include variable spending</strong>
                  <p className="field-hint">
                    Adds the average of recent non-bill expenses to the Priority Wall.
                  </p>
                </div>
                <Switch
                  checked={includeVariable}
                  onChange={setIncludeVariable}
                  label="Include variable spending"
                />
              </div>
            </>
          ) : (
            <Field label="Target amount" hint="A number you choose yourself">
              <input
                className="input"
                inputMode="decimal"
                value={manual}
                placeholder="20,000.00"
                onChange={(event) => setManual(event.target.value)}
              />
            </Field>
          )}

          <p className="field-hint">
            {mode === 'auto'
              ? `Target = ${months} × monthly essentials`
              : 'Manual target replaces the calculation until you switch back.'}
          </p>

          <FundingAccountsPicker
            accounts={eligible}
            goals={snapshot.goals}
            currency={currency}
            value={selectedIds}
            onChange={setSelectedIds}
            label="Funded by"
            hint="Tick the account that holds the emergency money. Several accounts add together; tick none and progress is counted from allocations."
          />
        </div>

        <div className="emergency-figures">
          <div className="emergency-line">
            <span>Priority Wall / month</span>
            <Money cents={wall} currency={currency} />
          </div>
          <div className="emergency-line">
            <span>Variable average / month</span>
            <Money cents={variable} currency={currency} />
          </div>
          <div className="emergency-line emergency-essentials">
            <span>Monthly essentials</span>
            <Money cents={essentials} currency={currency} />
          </div>
          <div className="emergency-target">
            <span>{mode === 'auto' ? `${months}-month target` : 'Manual target'}</span>
            <Money cents={targetCents} currency={currency} />
          </div>

          <Progress value={funded} max={targetCents} color="var(--savings)" label="Emergency fund" />
          <p className="emergency-coverage">
            <strong>{coverage.toFixed(1)} months</strong> covered
            {goal ? '' : ' · no emergency goal yet'}
            {isActive ? '' : ' · saving paused'}
          </p>

          <Button variant="primary" onClick={() => void apply()} disabled={saving}>
            {goal ? 'Apply target' : 'Create emergency fund'}
          </Button>
        </div>
      </div>
    </Card>
  )
}

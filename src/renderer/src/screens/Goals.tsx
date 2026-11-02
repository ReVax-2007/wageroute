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
  MoneyInput,
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
  const updateGoal = useFinanceStore((state) => state.updateGoal)
  const notify = useFinanceStore((state) => state.notify)
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
          <p className="eyebrow">Goals</p>
          <h1 className="page-title" tabIndex={-1}>Save for what is coming</h1>
          <p className="page-sub">
            A tattoo, a trip, a new laptop — each paycheck puts a little money aside before fun
            money.
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
            title="No goals yet"
            body="Create a goal and each paycheck will put a slice of the extra toward it."
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
                  <IconButton
                    label={goal.fundingPace === 'paused' ? 'Resume funding' : 'Pause funding'}
                    onClick={() => {
                      const next = goal.fundingPace === 'paused' ? 'asap' : 'paused'
                      void updateGoal(goal.id, { fundingPace: next }).then((ok) => {
                        if (ok) {
                          notify(
                            next === 'paused'
                              ? `${goal.name} will not take paycheck money until you resume it`
                              : `${goal.name} is funded again from paychecks`,
                            'success'
                          )
                        }
                      })
                    }}
                  >
                    {goal.fundingPace === 'paused' ? <Play size={15} /> : <Pause size={15} />}
                  </IconButton>
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
                        ? 'Its own account'
                        : `${goal.dedicatedAccounts.length} linked accounts`}
                    </span>
                  )}
                  <span className="chip">Priority {goal.priority}</span>
                  {goal.fundingPace === 'paused' && (
                    <span className="chip chip-paused">Paused</span>
                  )}
                  {goal.fundingPace === 'by_date' && goal.targetDate !== null && (
                    <span className="chip chip-quiet">On pace for {formatDateLong(goal.targetDate)}</span>
                  )}
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
                    <span className="chip chip-quiet">No deadline</span>
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
          subtitle="Out of your plan and every goal total. Restore one to start saving for it again."
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
        A goal reads its progress from the accounts you link to it — one account, or several whose
        balances add together. Every other goal counts what paychecks have assigned, so moving that
        money is still up to you.
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
  const [buffer, setBuffer] = useState(
    settings.emergencyBufferCents > 0 ? centsToEditable(settings.emergencyBufferCents) : ''
  )
  // Null means "follow the saved goal"; a list means the user has touched the
  // picker since the last apply. Copying the goal into state once would keep
  // old ids after an edit made elsewhere on this screen and write them back.
  const [draftIds, setDraftIds] = useState<string[] | null>(null)
  const selectedIds = draftIds ?? goal?.dedicatedAccounts.map((account) => account.id) ?? []
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
  const bufferCents = parseMoneyToCents(buffer) ?? 0
  const autoTarget = recommendedEmergencyTargetCents(essentials, months, bufferCents)
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
        mode === 'manual' ? targetCents : settings.emergencyManualTargetCents,
      emergencyBufferCents: mode === 'auto' ? Math.max(0, bufferCents) : settings.emergencyBufferCents
    })
    if (!settingsSaved) {
      setSaving(false)
      return
    }
    if (goal) {
      // A rejected save is already in the notification; clearing the draft
      // here would silently throw away the ids the user just picked.
      if (!(await updateGoal(goal.id, { targetCents, fundingAccountIds: selectedIds }))) {
        setSaving(false)
        return
      }
      setDraftIds(null)
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
      subtitle="Three to six months of essentials, worked out from your own numbers"
      className={isActive ? 'emergency-card' : 'emergency-card paused'}
      actions={<LifeBuoy size={17} className="stat-icon" />}
    >
      <div className="setting-row emergency-pause">
        <div>
          <strong>Save towards it every paycheck</strong>
          <p className="field-hint">
            {isActive
              ? 'On · each paycheck puts a slice of the extra here before fun money.'
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
              { value: 'auto', label: 'Work it out for me' },
              { value: 'manual', label: 'I will pick' }
            ]}
          />

          {mode === 'auto' ? (
            <>
              <Field label="Months of essentials" hint="Six months is the careful choice">
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
                  <strong>Include day-to-day spending</strong>
                  <p className="field-hint">
                    Adds your average non-bill spending to the bills you already track.
                  </p>
                </div>
                <Switch
                  checked={includeVariable}
                  onChange={setIncludeVariable}
                  label="Include day-to-day spending"
                />
              </div>
              <Field
                label="Extra buffer"
                hint="Optional. Covers one-offs the monthly average misses, like a repair or a deductible."
              >
                <MoneyInput value={buffer} placeholder="500.00" onValueChange={setBuffer} />
              </Field>
            </>
          ) : (
            <Field label="Target amount" hint="A number you choose yourself">
              <MoneyInput
                value={manual}
                placeholder="20,000.00"
                onValueChange={setManual}
              />
            </Field>
          )}

          <p className="field-hint">
            {mode === 'auto'
              ? `Target = ${months} × monthly essentials${bufferCents > 0 ? ` + ${formatMoney(bufferCents, currency)} buffer` : ''}`
              : 'Manual target replaces the calculation until you switch back.'}
          </p>

          <FundingAccountsPicker
            accounts={eligible}
            goals={snapshot.goals}
            currency={currency}
            value={selectedIds}
            onChange={setDraftIds}
            label="Where the money sits"
            hint="Tick the account that holds the emergency money. Several accounts add together; tick none and progress comes from paycheck allocations."
          />
        </div>

        <div className="emergency-figures">
          <div className="emergency-line">
            <span>Bills each month</span>
            <Money cents={wall} currency={currency} />
          </div>
          <div className="emergency-line">
            <span>Everyday spending / month</span>
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

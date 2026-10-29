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
import type { AccountWithBalance, EmergencyMode, GoalInput, GoalWithProgress } from '@shared/types'
import {
  Button,
  Card,
  EmptyState,
  Field,
  IconButton,
  Modal,
  Money,
  Progress,
  Segmented,
  Switch
} from '../components/ui'
import { activeBills, monthlyWall } from '../lib/finance'
import { useFinanceStore } from '../store/useFinanceStore'

const COLORS = ['#38BDF8', '#FBBF24', '#A78BFA', '#34D399', '#F472B6', '#FB923C']

/** Only money you can actually reach can back a fund. */
function fundableAccounts(accounts: readonly AccountWithBalance[]): AccountWithBalance[] {
  return accounts.filter(
    (account) =>
      !account.isArchived &&
      (account.kind === 'savings' || account.kind === 'checking' || account.kind === 'cash')
  )
}

export function Goals() {
  const snapshot = useFinanceStore((state) => state.snapshot)
  const settings = useFinanceStore((state) => state.settings)
  const archiveGoal = useFinanceStore((state) => state.archiveGoal)
  const deleteGoal = useFinanceStore((state) => state.deleteGoal)
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
          <h1 className="page-title">Future expenses, funded on purpose</h1>
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
            const remaining = Math.max(0, goal.targetCents - goal.fundedCents)
            const months = goal.targetDate ? monthsUntil(goal.targetDate, todayISO()) : null
            const monthlyNeed = months ? Math.ceil(remaining / months) : null
            const percent =
              goal.targetCents > 0
                ? Math.min(100, Math.round((goal.fundedCents / goal.targetCents) * 100))
                : 0

            return (
              <article key={goal.id} className="goal-card">
                <div className="goal-top">
                  <span className="goal-dot" style={{ background: goal.color }} />
                  <div className="goal-title">
                    <h3>{goal.name}</h3>
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

                <Progress value={goal.fundedCents} max={goal.targetCents} color={goal.color} />

                <div className="goal-meta">
                  <span>{percent}% funded</span>
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
                    if (
                      window.confirm(
                        `Delete "${goal.name}" for good? Its funded amount stays in the ledger history.`
                      )
                    ) {
                      void deleteGoal(goal.id)
                    }
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

/**
 * One-or-several account picker. An account that already funds a different goal
 * is labelled with that goal, because moving it here is a deliberate swap.
 */
function FundingAccountsPicker({
  accounts,
  goals,
  currency,
  value,
  onChange,
  label,
  hint
}: {
  accounts: readonly AccountWithBalance[]
  goals: readonly GoalWithProgress[]
  currency: string
  value: string[]
  onChange: (ids: string[]) => void
  label: string
  hint: string
}) {
  const [many, setMany] = useState(value.length > 1)

  const goalNameFundedBy = (accountId: string): string | null => {
    const dedicated = accounts.find((account) => account.id === accountId)?.dedicatedGoalId
    return goals.find((goal) => goal.id === dedicated)?.name ?? null
  }

  const chosen = accounts.filter((account) => value.includes(account.id))
  const combinedCents = chosen.reduce(
    (total, account) => total + Math.max(0, account.balanceCents),
    0
  )

  return (
    <>
      <Field label={label} hint={hint} wide>
        {many ? (
          accounts.length === 0 ? (
            <p className="field-hint">No savings, checking or cash account yet.</p>
          ) : (
            <div className="funding-account-list">
              {accounts.map((account) => (
                <label key={account.id} className="check funding-account-check">
                  <input
                    type="checkbox"
                    checked={value.includes(account.id)}
                    onChange={() =>
                      onChange(
                        value.includes(account.id)
                          ? value.filter((id) => id !== account.id)
                          : [...value, account.id]
                      )
                    }
                  />
                  <span className="funding-account-name">{account.name}</span>
                  <span className="funding-account-balance num muted">
                    {formatMoney(Math.max(0, account.balanceCents), currency)}
                  </span>
                </label>
              ))}
            </div>
          )
        ) : (
          <select
            className="select"
            value={value[0] ?? ''}
            onChange={(event) => onChange(event.target.value ? [event.target.value] : [])}
          >
            <option value="">No account — count allocations instead</option>
            {accounts.map((account) => {
              const funded = goalNameFundedBy(account.id)
              return (
                <option key={account.id} value={account.id}>
                  {account.name} · {formatMoney(Math.max(0, account.balanceCents), currency)}
                  {funded ? ` (funds ${funded})` : ''}
                </option>
              )
            })}
          </select>
        )}
      </Field>

      <label className="check funding-many">
        <input
          type="checkbox"
          checked={many}
          onChange={(event) => {
            const next = event.target.checked
            setMany(next)
            if (!next && value.length > 1) onChange(value.slice(0, 1))
          }}
        />
        Let several accounts add up together
      </label>

      <p className="field-hint">
        {chosen.length === 0
          ? 'No account chosen — progress is counted from the allocations a paycheck routes.'
          : `${formatMoney(combinedCents, currency)} across ${chosen.length} account${
              chosen.length === 1 ? '' : 's'
            } counts as funded.`}
      </p>
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
    if (next === 'manual' && !manual.trim()) setManual(centsToEditable(autoTarget))
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
      emergencyManualTargetCents: mode === 'manual' ? targetCents : 0
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
        color: '#38BDF8',
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

          <Progress value={funded} max={targetCents} color="var(--savings)" />
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

function GoalDialog({ goal, onClose }: { goal: GoalWithProgress | null; onClose: () => void }) {
  const snapshot = useFinanceStore((state) => state.snapshot)
  const settings = useFinanceStore((state) => state.settings)
  const createGoal = useFinanceStore((state) => state.createGoal)
  const updateGoal = useFinanceStore((state) => state.updateGoal)

  const accounts = snapshot?.accounts ?? []
  const [form, setForm] = useState({
    name: goal?.name ?? '',
    target: goal ? centsToEditable(goal.targetCents) : '',
    targetDate: goal?.targetDate ?? '',
    priority: goal ? String(goal.priority) : '100',
    color: goal?.color ?? COLORS[0],
    accountId: goal?.accountId ?? ''
  })
  const [fundingIds, setFundingIds] = useState<string[]>(
    goal ? goal.dedicatedAccounts.map((account) => account.id) : []
  )
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const submit = async () => {
    const targetCents = parseMoneyToCents(form.target)
    if (!form.name.trim()) {
      setError('Give the goal a name')
      return
    }
    if (targetCents === null || targetCents <= 0) {
      setError('Enter a target greater than zero')
      return
    }

    const input: GoalInput = {
      name: form.name.trim(),
      targetCents,
      targetDate: form.targetDate || null,
      priority: Number(form.priority) || 100,
      color: form.color,
      accountId: form.accountId || null,
      fundingAccountIds: fundingIds
    }

    setSaving(true)
    const ok = goal ? await updateGoal(goal.id, input) : await createGoal(input)
    setSaving(false)
    if (ok) onClose()
  }

  return (
    <Modal
      title={goal ? 'Edit sinking fund' : 'New sinking fund'}
      subtitle="Goals are filled in priority order, lowest number first."
      onClose={onClose}
      footer={
        <>
          <Button variant="quiet" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={saving}>
            {goal ? 'Save goal' : 'Create goal'}
          </Button>
        </>
      }
    >
      <div className="form-grid">
        <Field label="Goal name" wide>
          <input
            className="input"
            autoFocus
            value={form.name}
            placeholder="Tattoo Fund"
            onChange={(event) => setForm({ ...form, name: event.target.value })}
          />
        </Field>
        <Field label="Target amount">
          <input
            className="input"
            inputMode="decimal"
            value={form.target}
            placeholder="1,200.00"
            onChange={(event) => setForm({ ...form, target: event.target.value })}
          />
        </Field>
        <Field label="Target date" hint="Optional, but it sets a monthly pace">
          <input
            className="input"
            type="date"
            value={form.targetDate}
            onChange={(event) => setForm({ ...form, targetDate: event.target.value })}
          />
        </Field>
        <Field label="Priority" hint="Lower numbers are funded first">
          <input
            className="input"
            type="number"
            min={1}
            value={form.priority}
            onChange={(event) => setForm({ ...form, priority: event.target.value })}
          />
        </Field>
      </div>

      <FundingAccountsPicker
        accounts={fundableAccounts(accounts)}
        goals={snapshot?.goals ?? []}
        currency={settings.currency}
        value={fundingIds}
        onChange={setFundingIds}
        label="Funded by"
        hint="Point an account at this goal and its balance becomes the progress."
      />

      <Field
        label="Deposit account"
        hint="Where the lump lands when the goal is done. It does not measure progress."
        wide
      >
        <select
          className="select"
          value={form.accountId}
          onChange={(event) => setForm({ ...form, accountId: event.target.value })}
        >
          <option value="">Not assigned</option>
          {accounts.map((account) => (
            <option key={account.id} value={account.id}>
              {account.name}
            </option>
          ))}
        </select>
      </Field>

      <div className="field">
        <span className="field-label">Colour</span>
        <div className="swatches">
          {COLORS.map((color) => (
            <button
              key={color}
              type="button"
              aria-label={`Use colour ${color}`}
              aria-pressed={form.color === color}
              className={form.color === color ? 'swatch active' : 'swatch'}
              style={{ background: color }}
              onClick={() => setForm({ ...form, color })}
            />
          ))}
        </div>
      </div>

      {error && <p className="form-error">{error}</p>}
    </Modal>
  )
}

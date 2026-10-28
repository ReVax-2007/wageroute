import { useState } from 'react'
import { CalendarDays, Landmark, LifeBuoy, Pause, Pencil, Play, Plus, Target, Trash2 } from 'lucide-react'
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
  Modal,
  Money,
  Progress,
  Segmented,
  Switch
} from '../components/ui'
import { activeBills, monthlyWall } from '../lib/finance'
import { useFinanceStore } from '../store/useFinanceStore'

const COLORS = ['#38BDF8', '#FBBF24', '#A78BFA', '#34D399', '#F472B6', '#FB923C']

export function Goals() {
  const snapshot = useFinanceStore((state) => state.snapshot)
  const settings = useFinanceStore((state) => state.settings)
  const deleteGoal = useFinanceStore((state) => state.deleteGoal)
  const [editing, setEditing] = useState<GoalWithProgress | null | 'new'>(null)

  if (!snapshot) return null
  const currency = settings.currency

  const remove = (goal: GoalWithProgress) => {
    if (window.confirm(`Archive "${goal.name}"? Its funded amount stays in the ledger history.`)) {
      void deleteGoal(goal.id)
    }
  }

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

      {snapshot.goals.length === 0 ? (
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
          {snapshot.goals.map((goal) => {
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
                  </div>                  <IconButton label="Edit goal" onClick={() => setEditing(goal)}>
                    <Pencil size={15} />
                  </IconButton>
                  <IconButton label="Archive goal" danger onClick={() => remove(goal)}>
                    <Trash2 size={15} />
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

                <div className="goal-foot">
                  {goal.fundedFrom === 'account' && (
                    <span className="chip chip-funded">
                      <Landmark size={12} />
                      {goal.dedicatedAccountNames.join(', ') || 'Dedicated account'}
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

      <p className="footnote">
        A goal with a dedicated account reads its progress straight from that account&apos;s
        balance. Every other goal counts the allocations recorded when a paycheck is routed, so
        moving that money is still your job.
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
  const updateAccount = useFinanceStore((state) => state.updateAccount)
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
  const [saving, setSaving] = useState(false)

  // Account selection state: 1 account by default, or an option to manually select many
  const [selectedIds, setSelectedIds] = useState<string[]>(settings.emergencyAccountIds)
  const [allowMultiple, setAllowMultiple] = useState<boolean>(settings.emergencyAccountIds.length > 1)

  if (!snapshot) return null

  const currency = settings.currency
  const isActive = settings.emergencyActive

  // Accounts eligible to back the emergency fund (savings, checking, cash — not archived)
  const eligibleAccounts = snapshot.accounts.filter(
    (a) => !a.isArchived && (a.kind === 'savings' || a.kind === 'checking' || a.kind === 'cash')
  )

  // Compute funded total: sum of selected account balances (if any are chosen),
  // otherwise fall back to the goal's own fundedCents
  const fundedFromAccounts =
    selectedIds.length > 0
      ? snapshot.accounts
          .filter((a) => selectedIds.includes(a.id))
          .reduce((sum, a) => sum + Math.max(0, a.balanceCents), 0)
      : null

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
  const funded = fundedFromAccounts ?? goal?.fundedCents ?? 0
  const coverage = emergencyCoverageMonths(funded, essentials)
  const targetMonths = months

  const changeMode = (next: EmergencyMode) => {
    setMode(next)
    if (next === 'manual' && !manual.trim()) setManual(centsToEditable(autoTarget))
  }

  const toggleAccount = (id: string) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    )
  }

  const toggleActive = async () => {
    const next = !isActive
    await saveSettings({ ...settings, emergencyActive: next })
    notify(next ? 'Emergency saving resumed' : 'Emergency saving paused (Bill inactive)', 'success')
  }

  const apply = async () => {
    if (targetCents <= 0) {
      notify('Set an emergency target above zero', 'error')
      return
    }
    setSaving(true)
    await saveSettings({
      ...settings,
      emergencyMode: mode,
      emergencyMonths: months,
      emergencyIncludeVariable: includeVariable,
      emergencyManualTargetCents:
        mode === 'manual' ? targetCents : Math.max(0, manualCents ?? 0),
      emergencyAccountIds: selectedIds
    })
    if (goal) {
      await updateGoal(goal.id, { targetCents, accountId: selectedIds[0] ?? null })
      for (const account of snapshot.accounts) {
        const shouldBeDedicated = selectedIds.includes(account.id)
        const isCurrentlyDedicated = account.dedicatedGoalId === goal.id
        if (shouldBeDedicated && !isCurrentlyDedicated) {
          await updateAccount(account.id, { dedicatedGoalId: goal.id })
        } else if (!shouldBeDedicated && isCurrentlyDedicated) {
          await updateAccount(account.id, { dedicatedGoalId: null })
        }
      }
    } else {
      await createGoal({
        name: 'Emergency Fund',
        targetCents,
        targetDate: null,
        priority: 1,
        color: '#38BDF8',
        accountId: selectedIds[0] ?? null,
        isEmergency: true
      })
    }
    setSaving(false)
  }

  return (
    <Card
      title="Emergency fund"
      subtitle="Three to six months of essentials, calculated from your own numbers"
      className="emergency-card"
      actions={<LifeBuoy size={17} className="stat-icon" />}
    >
      {/* Pause / Resume banner */}
      <div className="setting-row" style={{ marginBottom: '1.25rem' }}>
        <div>
          <strong>Save money from every paycheck</strong>
          <p className="field-hint">
            {isActive
              ? 'Active · The allocator reserves money towards your emergency cadence each paycheck.'
              : 'Bill inactive · Money will not be saved from paychecks until you resume.'}
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          {!isActive && (
            <span
              className="chip chip-quiet"
              style={{
                color: 'var(--warn, #f59e0b)',
                borderColor: 'rgba(245, 189, 74, 0.3)',
                fontWeight: 600
              }}
            >
              Bill inactive
            </span>
          )}
          <Button
            variant={isActive ? 'quiet' : 'primary'}
            size="sm"
            icon={isActive ? <Pause size={13} /> : <Play size={13} />}
            onClick={() => void toggleActive()}
          >
            {isActive ? 'Pause' : 'Resume bill'}
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
              ? `Target = ${targetMonths} × monthly essentials`
              : 'Manual target replaces the calculation until you switch back.'}
          </p>

          {/* Account selector: 1 cumulative account by default, or option to manually select many */}
          {!allowMultiple ? (
            <Field
              label="Cumulative emergency account"
              hint="Only this account cumulates the emergency total (other sinking funds are independent)"
            >
              <select
                className="select"
                value={selectedIds[0] ?? ''}
                onChange={(e) => {
                  const val = e.target.value
                  setSelectedIds(val ? [val] : [])
                }}
              >
                <option value="">No account (track via allocations)</option>
                {eligibleAccounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.name} ({formatMoney(Math.max(0, account.balanceCents), currency)})
                  </option>
                ))}
              </select>
            </Field>
          ) : (
            <Field
              label="Cumulative emergency accounts"
              hint="Select multiple accounts whose combined balance cumulates your emergency total"
            >
              {eligibleAccounts.length === 0 ? (
                <p className="field-hint">No eligible accounts yet.</p>
              ) : (
                <div className="emergency-account-list">
                  {eligibleAccounts.map((account) => {
                    const checked = selectedIds.includes(account.id)
                    return (
                      <label key={account.id} className="check emergency-account-check">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleAccount(account.id)}
                        />
                        <span className="emergency-account-name">{account.name}</span>
                        <span className="emergency-account-balance num muted">
                          {formatMoney(Math.max(0, account.balanceCents), currency)}
                        </span>
                      </label>
                    )
                  })}
                </div>
              )}
            </Field>
          )}

          <div style={{ marginTop: '-4px', marginBottom: '4px' }}>
            <label className="check" style={{ fontSize: '12.5px', color: 'var(--text-dim)' }}>
              <input
                type="checkbox"
                checked={allowMultiple}
                onChange={(e) => {
                  const checked = e.target.checked
                  setAllowMultiple(checked)
                  if (!checked && selectedIds.length > 1) {
                    setSelectedIds(selectedIds.slice(0, 1))
                  }
                }}
              />
              Option to manually select many accounts
            </label>
          </div>

          <p className="field-hint">
            {selectedIds.length === 0
              ? 'No account selected — progress is measured from allocation records instead.'
              : selectedIds.length === 1
                ? 'Only this single account cumulates towards the emergency fund total.'
                : `${selectedIds.length} accounts cumulate towards the emergency fund total.`}{' '}
            Not every sinking fund/goal is towards the emergency cadence.
          </p>
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
            <span>{mode === 'auto' ? `${targetMonths}-month target` : 'Manual target'}</span>
            <Money cents={targetCents} currency={currency} />
          </div>

          <Progress value={funded} max={targetCents} color={isActive ? 'var(--savings)' : 'var(--color-text-dim, #666)'} />
          <p className="emergency-coverage">
            <strong>{coverage.toFixed(1)} months</strong> covered
            {!goal ? ' · no emergency goal yet' : ''}
            {!isActive ? ' · saving paused (Bill inactive)' : ''}
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
      accountId: form.accountId || null
    }

    setSaving(true)
    if (goal) {
      await updateGoal(goal.id, input)
    } else {
      await createGoal(input)
    }
    setSaving(false)
    onClose()
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
        <Field label="Held in">
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
      </div>

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

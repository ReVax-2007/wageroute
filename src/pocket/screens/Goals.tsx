import { useState } from 'react'
import { Pencil, Plus } from 'lucide-react'
import { formatDateLong } from '@shared/dates'
import { goalDeletionWords } from '@shared/deletion'
import { centsToEditable, formatMoney, parseMoneyToCents } from '@shared/money'
import type { GoalFundingPace, GoalInput, GoalWithProgress } from '@shared/types'
import { fundableAccounts, goalsSummary } from '../../renderer/src/lib/finance'
import { Checkbox, Field } from '../components/Field'
import { DeleteConfirm } from '../components/DeleteConfirm'
import { MoneyInput } from '../components/MoneyInput'
import { Sheet } from '../components/Sheet'
import { useSheetSave } from '../components/useSheetSave'
import { pocketView } from '../lib/compute'
import { usePocket, useSnapshot } from '../lib/store'
import { createGoal, deleteGoal, patchGoal, setGoalArchived } from '../lib/write'

const PACES: { value: GoalFundingPace; label: string }[] = [
  { value: 'asap', label: 'As fast as possible' },
  { value: 'by_date', label: 'Spread until the target date' },
  { value: 'paused', label: 'Paused — leave it alone' }
]

function paceHint(pace: GoalFundingPace, hasFundingAccount: boolean): string {
  if (hasFundingAccount) return 'A linked account already holds this goal, so the paycheck pace does not apply'
  if (pace === 'by_date') return 'Only its even share each paycheck — it never races ahead'
  if (pace === 'paused') return 'No paycheck money goes to this goal until you resume it'
  return 'Takes what it needs while the goal share lasts'
}

interface GoalForm {
  name: string
  target: string
  targetDate: string
  priority: string
  fundingPace: GoalFundingPace
  accountId: string
  fundingIds: string[]
}

function formFor(goal: GoalWithProgress | null): GoalForm {
  return {
    name: goal?.name ?? '',
    target: goal ? centsToEditable(goal.targetCents) : '',
    targetDate: goal?.targetDate ?? '',
    priority: goal ? String(goal.priority) : '100',
    fundingPace: goal?.fundingPace ?? 'asap',
    accountId: goal?.accountId ?? '',
    fundingIds: goal ? goal.dedicatedAccounts.map((account) => account.id) : []
  }
}

function GoalFormSheet({ goal, onClose }: { goal: GoalWithProgress | null; onClose: () => void }) {
  const snapshot = useSnapshot()
  const edit = usePocket((state) => state.edit)
  const add = usePocket((state) => state.add)
  const fundable = snapshot ? fundableAccounts(snapshot.accounts) : []
  const deposits = snapshot ? snapshot.accounts.filter((account) => !account.isArchived) : []
  const [form, setForm] = useState<GoalForm>(() => formFor(goal))
  const { saving, error, setError, run } = useSheetSave(onClose)

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
      // The phone has no palette to pick from, so a goal keeps the colour the
      // desktop gave it and a new one takes the app default.
      color: goal?.color ?? '#34D399',
      accountId: form.accountId || null,
      fundingPace: form.fundingPace,
      fundingAccountIds: form.fundingIds
    }
    await run(() =>
      goal
        ? edit((current) => patchGoal(current, goal.id, input), 'Goal saved on this phone.')
        : // A goal made here keeps the app's default colour; styling it is the
          // desktop's job, where the palette lives.
          add((current) => createGoal(current, input), 'Goal saved on this phone.')
    )
  }

  return (
    <Sheet
      title={goal ? 'Edit this goal' : 'New goal'}
      hint="Lower numbers get money first."
      onClose={onClose}
    >
      <Field label="Goal name">
        <input
          className="input"
          autoFocus
          maxLength={60}
          value={form.name}
          placeholder="Tattoo Fund"
          onChange={(event) => setForm({ ...form, name: event.target.value })}
        />
      </Field>
      <Field label="Target amount">
        <MoneyInput
          value={form.target}
          placeholder="1,200.00"
          onValueChange={(target) => setForm({ ...form, target })}
        />
      </Field>
      <div className="field-grid">
        <Field label="Target date" hint="Optional, but it sets a monthly pace">
          <input
            className="input"
            type="date"
            value={form.targetDate}
            onChange={(event) => setForm({ ...form, targetDate: event.target.value })}
          />
        </Field>
        <Field label="Priority" hint="Lower numbers get money first">
          <input
            className="input"
            type="number"
            min={1}
            value={form.priority}
            onChange={(event) => setForm({ ...form, priority: event.target.value })}
          />
        </Field>
      </div>

      <Field label="Funding pace" hint={paceHint(form.fundingPace, form.fundingIds.length > 0)}>
        <select
          className="input"
          value={form.fundingPace}
          onChange={(event) => setForm({ ...form, fundingPace: event.target.value as GoalFundingPace })}
        >
          {PACES.map((pace) => (
            <option key={pace.value} value={pace.value}>
              {pace.label}
            </option>
          ))}
        </select>
      </Field>

      {fundable.length > 0 ? (
        <div className="field">
          <span>Where the money sits</span>
          <span className="muted small">
            Link an account and its balance becomes this goal’s progress.
          </span>
          <div className="checks">
            {fundable.map((account) => (
              <Checkbox
                key={account.id}
                label={`${account.name} · ${formatMoney(account.balanceCents, snapshot?.user.currency ?? 'USD')}`}
                checked={form.fundingIds.includes(account.id)}
                onChange={(checked) =>
                  setForm({
                    ...form,
                    fundingIds: checked
                      ? [...form.fundingIds, account.id]
                      : form.fundingIds.filter((id) => id !== account.id)
                  })
                }
              />
            ))}
          </div>
        </div>
      ) : null}

      <Field
        label="Deposit account"
        hint="Where the money lands when the goal is done. It does not measure progress."
      >
        <select
          className="input"
          value={form.accountId}
          onChange={(event) => setForm({ ...form, accountId: event.target.value })}
        >
          <option value="">Not assigned</option>
          {deposits.map((account) => (
            <option key={account.id} value={account.id}>
              {account.name}
            </option>
          ))}
        </select>
      </Field>

      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="sheet-actions">
        <button type="button" className="button" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="button primary" disabled={saving} onClick={submit}>
          {saving ? 'Saving…' : goal ? 'Save goal' : 'Create goal'}
        </button>
      </div>
    </Sheet>
  )
}

function GoalSheet({
  goal,
  onEdit,
  onRequestDelete,
  onClose
}: {
  goal: GoalWithProgress
  onEdit: () => void
  onRequestDelete: () => void
  onClose: () => void
}) {
  const snapshot = useSnapshot()
  const edit = usePocket((state) => state.edit)
  const currency = snapshot?.user.currency ?? 'USD'
  const depositName = snapshot?.accounts.find((account) => account.id === goal.accountId)?.name
  const { saving, error, run } = useSheetSave(onClose)
  const progress = goal.targetCents > 0 ? Math.min(1, goal.fundedCents / goal.targetCents) : 0

  return (
    <Sheet
      title={goal.name}
      hint={`${formatMoney(goal.fundedCents, currency)} of ${formatMoney(goal.targetCents, currency)} · ${Math.round(progress * 100)}% there`}
      onClose={onClose}
    >
      <ul className="facts">
        <li>{formatMoney(goal.remainingCents, currency)} to go</li>
        <li>Priority {goal.priority}</li>
        <li>
          {goal.fundedFrom === 'account'
            ? `Measured by ${goal.dedicatedAccounts.map((account) => account.name).join(', ')}`
            : 'Filled by what your paychecks set aside'}
        </li>
        <li>
          {goal.fundingPace === 'asap'
            ? 'Pace: as fast as possible'
            : goal.fundingPace === 'by_date'
              ? 'Pace: spread until the target date'
              : 'Pace: paused'}
        </li>
        {goal.targetDate ? <li>Wanted by {formatDateLong(goal.targetDate)}</li> : null}
        {goal.accountId ? <li>Deposits into {depositName ?? 'an account'}</li> : null}
        <li>{goal.isArchived ? 'Archived' : 'Active'}</li>
      </ul>

      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="card-actions">
        <button type="button" className="button compact" disabled={saving} onClick={onEdit}>
          <Pencil size={15} aria-hidden="true" /> Edit
        </button>
        <button
          type="button"
          className="button compact"
          disabled={saving}
          onClick={() =>
            void run(() =>
              edit(
                (current) => setGoalArchived(current, goal.id, !goal.isArchived),
                goal.isArchived ? 'Goal is back in the plan.' : 'Goal archived.'
              )
            )
          }
        >
          {goal.isArchived ? 'Bring back' : 'Archive'}
        </button>
        <button type="button" className="button danger compact" disabled={saving} onClick={onRequestDelete}>
          Delete
        </button>
      </div>
      <p className="fine">
        Deleting a goal releases any account that was dedicated to it; the money and the entries
        that funded it stay in the ledger.
      </p>
    </Sheet>
  )
}

export function Goals() {
  const snapshot = useSnapshot()
  const edit = usePocket((state) => state.edit)
  const [opened, setOpened] = useState<GoalWithProgress | null>(null)
  const [form, setForm] = useState<GoalWithProgress | 'new' | null>(null)
  const [pendingDelete, setPendingDelete] = useState<GoalWithProgress | null>(null)
  if (!snapshot) return null
  const view = pocketView(snapshot)
  const currency = view.settings.currency
  const goalWords = goalDeletionWords(pendingDelete?.name ?? '')
  const goals = snapshot.goals.filter((goal) => !goal.isArchived)
  const archived = snapshot.goals.filter((goal) => goal.isArchived)
  const summary = goalsSummary(goals)
  // Re-read the goal after every commit, so the sheet shows the money the
  // change moved rather than the figures it was opened with.
  const openedGoal = opened ? (snapshot.goals.find((goal) => goal.id === opened.id) ?? opened) : null

  return (
    <div className="screen">
      <header className="screen-head">
        <div>
          <span className="eyebrow">Set aside for goals</span>
          <p className="hero-number">{formatMoney(summary.fundedCents, currency)}</p>
        </div>
        <button type="button" className="button primary compact" onClick={() => setForm('new')}>
          <Plus size={17} aria-hidden="true" /> Add
        </button>
      </header>
      <p className="muted small">
        {summary.targetCents > 0
          ? `Of ${formatMoney(summary.targetCents, currency)} across ${goals.length} goal${
              goals.length === 1 ? '' : 's'
            }.`
          : 'No goals are set up yet.'}
      </p>
      {summary.targetCents > 0 ? (
        <div className="bar wide" aria-hidden="true">
          <span style={{ width: `${Math.min(100, summary.progress * 100)}%` }} />
        </div>
      ) : null}

      {goals.length === 0 ? (
        <p className="empty-line">Add a goal and every paycheck starts filling it.</p>
      ) : (
        <ul className="list">
          {goals.map((goal) => {
            const progress =
              goal.targetCents > 0 ? Math.min(1, goal.fundedCents / goal.targetCents) : 0
            return (
              <li key={goal.id} className="goal-card">
                <button
                  type="button"
                  className="goal-head tap"
                  onClick={() => setOpened(goal)}
                  aria-label={`${goal.name}, ${Math.round(progress * 100)} percent funded`}
                >
                  <span className="goal-dot" style={{ background: goal.color }} aria-hidden="true" />
                  <div className="row-main">
                    <span className="row-title">{goal.name}</span>
                    <span className="muted small">
                      {goal.isEmergency ? 'Emergency fund' : `${Math.round(progress * 100)}% there`}
                      {goal.targetDate ? ` · by ${formatDateLong(goal.targetDate)}` : ''}
                    </span>
                  </div>
                  <span className="amount">{formatMoney(goal.fundedCents, currency)}</span>
                </button>
                <div className="bar" aria-hidden="true">
                  <span style={{ width: `${progress * 100}%`, background: goal.color }} />
                </div>
                <div className="goal-foot">
                  <span className="muted small">
                    {formatMoney(goal.fundedCents, currency)} of{' '}
                    {formatMoney(goal.targetCents, currency)}
                  </span>
                  <span className="muted small">
                    {formatMoney(goal.remainingCents, currency)} to go
                  </span>
                </div>
              </li>
            )
          })}
        </ul>
      )}

      {archived.length > 0 ? (
        <section className="section">
          <header className="section-head">
            <h2>Archived</h2>
            <span className="muted small">{archived.length}</span>
          </header>
          <ul className="list">
            {archived.map((goal) => (
              <li key={goal.id} className="row-card settled">
                <button
                  type="button"
                  className="row-main tap"
                  onClick={() => setOpened(goal)}
                  aria-label={`${goal.name}, archived`}
                >
                  <span className="row-title">{goal.name}</span>
                  <span className="muted small">
                    {formatMoney(goal.fundedCents, currency)} of{' '}
                    {formatMoney(goal.targetCents, currency)}
                  </span>
                </button>
                <div className="row-end">
                  <span className="pill">Archived</span>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <p className="fine">
        Progress follows the money your paychecks set aside, or your dedicated account when you gave
        a goal one.
      </p>

      {openedGoal ? (
        <GoalSheet
          goal={openedGoal}
          onEdit={() => {
            setForm(openedGoal)
            setOpened(null)
          }}
          onRequestDelete={() => setPendingDelete(openedGoal)}
          onClose={() => setOpened(null)}
        />
      ) : null}

      {pendingDelete ? (
        <DeleteConfirm
          title={goalWords.title}
          hint={goalWords.body}
          detail={`${formatMoney(pendingDelete.fundedCents, currency)} of ${formatMoney(
            pendingDelete.targetCents,
            currency
          )}`}
          confirmLabel={goalWords.confirmLabel}
          onCancel={() => setPendingDelete(null)}
          onDone={() => {
            setPendingDelete(null)
            setOpened(null)
          }}
          remove={() => edit((current) => deleteGoal(current, pendingDelete.id), 'Goal removed.')}
        />
      ) : null}

      {form ? (
        <GoalFormSheet goal={form === 'new' ? null : form} onClose={() => setForm(null)} />
      ) : null}
    </div>
  )
}

import { useState } from 'react'
import { centsToEditable, parseMoneyToCents } from '@shared/money'
import type { GoalFundingPace, GoalInput, GoalWithProgress } from '@shared/types'
import { Button, Field, Modal, MoneyInput } from '../ui'
import { FundingAccountsPicker } from '../FundingAccountsPicker'
import { fundableAccounts } from '../../lib/finance'
import { useFinanceStore } from '../../store/useFinanceStore'
import { useDialogSave } from '../useDialogSave'

/**
 * Swatches are theme tokens, not fixed hex values, so a fund's colour stays
 * legible when the palette switches between dark and light.
 */
const COLORS: { name: string; value: string }[] = [
  { name: 'Sky', value: 'var(--savings)' },
  { name: 'Amber', value: 'var(--goal)' },
  { name: 'Violet', value: 'var(--investment)' },
  { name: 'Green', value: 'var(--accent)' },
  { name: 'Pink', value: 'var(--leisure)' },
  { name: 'Orange', value: 'var(--debt)' }
]

export function GoalDialog({
  goal,
  onClose
}: {
  goal: GoalWithProgress | null
  onClose: () => void
}) {
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
    color: goal?.color ?? COLORS[0].value,
    accountId: goal?.accountId ?? '',
    fundingPace: (goal?.fundingPace ?? 'asap') as GoalFundingPace
  })
  const [fundingIds, setFundingIds] = useState<string[]>(
    goal ? goal.dedicatedAccounts.map((account) => account.id) : []
  )
  const [fieldErrors, setFieldErrors] = useState<{ name?: string; target?: string }>({})
  const { saving, error, run } = useDialogSave(onClose)

  const clearField = (field: keyof typeof fieldErrors) =>
    setFieldErrors((current) => ({ ...current, [field]: undefined }))

  const submit = async () => {
    const targetCents = parseMoneyToCents(form.target)
    const problems: typeof fieldErrors = {}
    if (!form.name.trim()) problems.name = 'Give the goal a name'
    if (targetCents === null || targetCents <= 0) {
      problems.target = 'Enter a target greater than zero'
    }
    setFieldErrors(problems)
    if (Object.keys(problems).length > 0 || targetCents === null) return

    const input: GoalInput = {
      name: form.name.trim(),
      targetCents,
      targetDate: form.targetDate || null,
      priority: Number(form.priority) || 100,
      color: form.color,
      accountId: form.accountId || null,
      fundingPace: form.fundingPace,
      fundingAccountIds: fundingIds
    }

    await run(() => (goal ? updateGoal(goal.id, input) : createGoal(input)))
  }

  return (
    <Modal
      title={goal ? 'Edit goal' : 'New goal'}
      subtitle="Lower numbers get money first."
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
        <Field label="Goal name" wide error={fieldErrors.name}>
          <input
            className="input"
            autoFocus
            maxLength={60}
            value={form.name}
            placeholder="Tattoo Fund"
            onChange={(event) => {
              clearField('name')
              setForm({ ...form, name: event.target.value })
            }}
          />
        </Field>
        <Field label="Target amount" error={fieldErrors.target}>
          <MoneyInput
            value={form.target}
            placeholder="1,200.00"
            onValueChange={(target) => {
              clearField('target')
              setForm({ ...form, target })
            }}
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
        <Field label="Priority" hint="Lower numbers get money first">
          <input
            className="input"
            type="number"
            min={1}
            value={form.priority}
            onChange={(event) => setForm({ ...form, priority: event.target.value })}
          />
        </Field>
        <Field
          label="Funding pace"
          hint={
            fundingIds.length > 0
              ? 'A linked account already holds this goal, so the paycheck pace does not apply'
              : form.fundingPace === 'by_date'
                ? 'Only its even share each paycheck — it never races ahead'
                : form.fundingPace === 'paused'
                  ? 'No paycheck money goes to this goal until you resume it'
                  : 'Takes what it needs while the goal share lasts'
          }
        >
          <select
            className="select"
            value={form.fundingPace}
            onChange={(event) =>
              setForm({ ...form, fundingPace: event.target.value as GoalFundingPace })
            }
          >
            <option value="asap">As fast as possible</option>
            <option value="by_date">Spread until the target date</option>
            <option value="paused">Paused — leave it alone</option>
          </select>
        </Field>
      </div>

      <FundingAccountsPicker
        accounts={fundableAccounts(accounts)}
        goals={snapshot?.goals ?? []}
        currency={settings.currency}
        value={fundingIds}
        onChange={setFundingIds}
        label="Where the money sits"
        hint="Link an account and its balance becomes this goal's progress."
      />

      <Field
        label="Deposit account"
        hint="Where the money lands when the goal is done. It does not measure progress."
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
          {COLORS.map((colour) => (
            <button
              key={colour.value}
              type="button"
              aria-label={`Use the ${colour.name} colour`}
              aria-pressed={form.color === colour.value}
              className={form.color === colour.value ? 'swatch active' : 'swatch'}
              style={{ background: colour.value }}
              onClick={() => setForm({ ...form, color: colour.value })}
            />
          ))}
        </div>
      </div>

      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </Modal>
  )
}

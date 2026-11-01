import { useMemo, useState } from 'react'
import { centsToEditable, parseMoneyToCents } from '@shared/money'
import type { AccountKind, AccountInput, AccountWithBalance } from '@shared/types'
import { Button, Field, Modal } from '../ui'
import { ACCOUNT_KIND_LABEL } from '../../lib/finance'
import { useFinanceStore } from '../../store/useFinanceStore'
import { useDialogSave } from '../useDialogSave'

const KINDS: AccountKind[] = ['checking', 'savings', 'cash', 'credit', 'investment']

const ACCOUNT_COLORS = [
  { name: 'Blue', value: 'var(--savings)' },
  { name: 'Green', value: 'var(--accent)' },
  { name: 'Amber', value: 'var(--goal)' },
  { name: 'Pink', value: 'var(--leisure)' },
  { name: 'Violet', value: 'var(--investment)' },
  { name: 'Orange', value: 'var(--debt)' },
  { name: 'Sand', value: 'var(--dot-cash)' },
  { name: 'Slate', value: '#94A3B8' }
]

type SafeToSpendChoice = 'auto' | 'in' | 'out'

function safeToSpendChoice(account: AccountWithBalance | null): SafeToSpendChoice {
  if (!account || account.inSafeToSpend === null) return 'auto'
  return account.inSafeToSpend ? 'in' : 'out'
}

export function AccountDialog({
  account,
  onClose
}: {
  account: AccountWithBalance | null
  onClose: () => void
}) {
  const accounts = useFinanceStore((state) => state.snapshot?.accounts ?? [])
  const goals = useFinanceStore((state) => state.snapshot?.goals ?? [])
  const createAccount = useFinanceStore((state) => state.createAccount)
  const updateAccount = useFinanceStore((state) => state.updateAccount)

  const institutions = useMemo(
    () =>
      [
        ...new Set(accounts.map((item) => item.institution).filter((name): name is string => !!name))
      ].sort(),
    [accounts]
  )

  const [form, setForm] = useState({
    name: account?.name ?? '',
    kind: (account?.kind ?? 'checking') as AccountKind,
    institution: account?.institution ?? '',
    startingBalance: account ? centsToEditable(Math.abs(account.startingBalanceCents)) : '',
    creditLimit:
      account && account.creditLimitCents !== null ? centsToEditable(account.creditLimitCents) : '',
    dedicatedGoalId: account?.dedicatedGoalId ?? '',
    safeToSpend: safeToSpendChoice(account),
    color: account?.color ?? ''
  })
  const [fieldErrors, setFieldErrors] = useState<{
    name?: string
    creditLimit?: string
    startingBalance?: string
  }>({})
  const { saving, error, run } = useDialogSave(onClose)

  const clearField = (field: keyof typeof fieldErrors) =>
    setFieldErrors((current) => ({ ...current, [field]: undefined }))

  const isCredit = form.kind === 'credit'
  const dedicatedGoals = useMemo(() => goals.filter((goal) => !goal.isArchived), [goals])

  const submit = async () => {
    const limitTyped = form.creditLimit.trim() ? parseMoneyToCents(form.creditLimit) : null
    const startingTyped = form.startingBalance.trim()
      ? parseMoneyToCents(form.startingBalance)
      : 0
    const problems: typeof fieldErrors = {}
    if (!form.name.trim()) problems.name = 'Give the account a name'
    if (form.creditLimit.trim() && limitTyped === null) {
      problems.creditLimit = 'Credit limit must be a number'
    }
    if (!account && startingTyped === null) {
      problems.startingBalance = 'Starting balance must be a number'
    }
    setFieldErrors(problems)
    if (Object.keys(problems).length > 0 || startingTyped === null) return

    const dedicatedGoalId = form.dedicatedGoalId || null
    const inSafeToSpend = form.safeToSpend === 'auto' ? null : form.safeToSpend === 'in'
    const purposeFields = { dedicatedGoalId, inSafeToSpend, color: form.color || null }

    await run(() => {
      if (account) {
        return updateAccount(account.id, {
          name: form.name.trim(),
          kind: form.kind,
          institution: form.institution.trim(),
          creditLimitCents: isCredit ? limitTyped : null,
          ...purposeFields
        })
      }
      const input: AccountInput = {
        name: form.name.trim(),
        kind: form.kind,
        institution: form.institution.trim(),
        // A credit card's opening balance is money owed, stored as a negative balance.
        startingBalanceCents: isCredit ? -Math.abs(startingTyped) : startingTyped,
        creditLimitCents: isCredit ? limitTyped : null,
        ...purposeFields
      }
      return createAccount(input)
    })
  }

  return (
    <Modal
      title={account ? 'Edit account' : 'Add an account'}
      subtitle={
        account
          ? 'Current balances are corrected with an adjustment entry, so the opening balance stays put.'
          : 'Use the name on your statement, then tag the bank it belongs to.'
      }
      onClose={onClose}
      footer={
        <>
          <Button variant="quiet" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={saving}>
            {account ? 'Save account' : 'Add account'}
          </Button>
        </>
      }
    >
      <div className="form-grid">
        <Field label="Account name" wide error={fieldErrors.name}>
          <input
            className="input"
            autoFocus
            maxLength={60}
            value={form.name}
            placeholder="Tangerine Chequing"
            onChange={(event) => {
              clearField('name')
              setForm({ ...form, name: event.target.value })
            }}
          />
        </Field>
        <Field label="Bank or institution" hint="Group accounts by where they live">
          <input
            className="input"
            list="institution-options"
            value={form.institution}
            placeholder="Tangerine"
            onChange={(event) => setForm({ ...form, institution: event.target.value })}
          />
          <datalist id="institution-options">
            {institutions.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
        </Field>
        <Field
          label="Type"
          hint={
            account
              ? 'Fixed once an account exists — its history was recorded in this type'
              : undefined
          }
        >
          <select
            className="select"
            value={form.kind}
            disabled={Boolean(account)}
            onChange={(event) => setForm({ ...form, kind: event.target.value as AccountKind })}
          >
            {KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {ACCOUNT_KIND_LABEL[kind]}
              </option>
            ))}
          </select>
        </Field>

        {!account && (
          <Field
            label={isCredit ? 'Balance owed today' : 'Starting balance'}
            hint={
              isCredit
                ? 'Enter the amount you owe, not a negative number'
                : 'The balance before any entries in this app'
            }
            error={fieldErrors.startingBalance}
          >
            <input
              className="input"
              inputMode="decimal"
              value={form.startingBalance}
              placeholder={isCredit ? '420.00' : '2,450.00'}
              onChange={(event) => {
                clearField('startingBalance')
                setForm({ ...form, startingBalance: event.target.value })
              }}
            />
          </Field>
        )}

        {isCredit && (
          <Field
            label="Credit limit"
            hint="Used for the utilization meter"
            error={fieldErrors.creditLimit}
          >
            <input
              className="input"
              inputMode="decimal"
              value={form.creditLimit}
              placeholder="5,000.00"
              onChange={(event) => {
                clearField('creditLimit')
                setForm({ ...form, creditLimit: event.target.value })
              }}
            />
          </Field>
        )}

        <Field
          label="Mine only for"
          wide
          hint="Leave as Nothing in particular to keep it a general account"
        >
          <select
            className="select"
            value={form.dedicatedGoalId}
            onChange={(event) => setForm({ ...form, dedicatedGoalId: event.target.value })}
          >
            <option value="">Nothing in particular</option>
            {dedicatedGoals.map((goal) => (
              <option key={goal.id} value={goal.id}>
                {goal.name}
              </option>
            ))}
          </select>
        </Field>

        {form.dedicatedGoalId !== '' && (
          <p className="field-hint">
            This account&apos;s balance <em>is</em> the goal&apos;s progress — money parked here is
            spent when the goal is funded, so it no longer counts as savings.
          </p>
        )}

        <Field
          label="Safe to spend"
          hint={
            form.dedicatedGoalId !== ''
              ? 'Dedicated accounts are excluded by default'
              : 'Default follows the account type; investments are never included by default'
          }
        >
          <select
            className="select"
            value={form.safeToSpend}
            onChange={(event) =>
              setForm({ ...form, safeToSpend: event.target.value as SafeToSpendChoice })
            }
          >
            <option value="auto">Automatic</option>
            <option value="in">Always count it</option>
            <option value="out">Never count it</option>
          </select>
        </Field>
      </div>

      <div className="field">
        <span className="field-label">Colour</span>
        <div className="swatches">
          <button
            type="button"
            aria-label="Automatic colour"
            aria-pressed={form.color === ''}
            className={form.color === '' ? 'swatch swatch-auto active' : 'swatch swatch-auto'}
            onClick={() => setForm({ ...form, color: '' })}
          />
          {ACCOUNT_COLORS.map((colour) => (
            <button
              key={colour.name}
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

import { useState } from 'react'
import {
  BILL_FUNDING_STRATEGY_LABEL,
  FREQUENCY_LABEL,
  PAY_CADENCE_LABEL,
  fundingCheckIndex,
  reachableCheckIndexes
} from '@shared/cadence'
import { centsToEditable, parseMoneyToCents } from '@shared/money'
import type { Bill, BillFundingStrategy, BillInput, Frequency } from '@shared/types'
import { Button, Field, Modal } from '../ui'
import { ordinal } from '../../lib/finance'
import { useFinanceStore } from '../../store/useFinanceStore'
import { useDialogSave } from '../useDialogSave'

const FREQUENCIES = Object.keys(FREQUENCY_LABEL) as Frequency[]
const FUNDING_STRATEGIES = Object.keys(BILL_FUNDING_STRATEGY_LABEL) as BillFundingStrategy[]

export function BillDialog({ bill, onClose }: { bill: Bill | null; onClose: () => void }) {
  const snapshot = useFinanceStore((state) => state.snapshot)
  const cadence = useFinanceStore((state) => state.settings.payCadence)
  const createBill = useFinanceStore((state) => state.createBill)
  const updateBill = useFinanceStore((state) => state.updateBill)

  // An archived account can still hold old bills, but it cannot take new money.
  const accounts = (snapshot?.accounts ?? []).filter((account) => !account.isArchived)
  // A bill saved before its account was archived keeps that pointer. Showing it
  // as a disabled option keeps the select honest instead of displaying some
  // other account while the bill still points at the archived one.
  const archivedAccount = bill
    ? (snapshot?.accounts ?? []).find(
        (account) => account.id === bill.accountId && account.isArchived
      )
    : undefined
  const [form, setForm] = useState({
    name: bill?.name ?? '',
    amount: bill ? centsToEditable(bill.amountCents) : '',
    frequency: bill?.frequency ?? ('monthly' as Frequency),
    dueDay: bill ? String(bill.dueDay) : '1',
    category: bill?.category ?? 'Bills',
    accountId: bill?.accountId ?? accounts[0]?.id ?? '',
    autopay: bill?.autopay ?? true,
    isActive: bill?.isActive ?? true,
    fundingStrategy: bill?.fundingStrategy ?? ('all_checks' as BillFundingStrategy),
    fundingPaycheckIndex: bill?.fundingPaycheckIndex ? String(bill.fundingPaycheckIndex) : '1'
  })
  const [fieldErrors, setFieldErrors] = useState<{
    name?: string
    amount?: string
    dueDay?: string
  }>({})
  const { saving, error, run } = useDialogSave(onClose)

  const clearField = (field: keyof typeof fieldErrors) =>
    setFieldErrors((current) => ({ ...current, [field]: undefined }))

  const checkSlots = reachableCheckIndexes(cadence)
  const fundingCheckForForm = fundingCheckIndex({
    cadence,
    dueDay: Number(form.dueDay) || 1,
    fundingStrategy: form.fundingStrategy,
    fundingPaycheckIndex: Number(form.fundingPaycheckIndex) || 1
  })

  const submit = async () => {
    const amountCents = parseMoneyToCents(form.amount)
    const dueDay = Number(form.dueDay)
    const problems: typeof fieldErrors = {}
    if (!form.name.trim()) problems.name = 'Give the bill a name'
    if (amountCents === null || amountCents <= 0) {
      problems.amount = 'Enter an amount greater than zero'
    }
    if (!Number.isInteger(dueDay) || dueDay < 1 || dueDay > 31) {
      problems.dueDay = 'Due day must be a whole number from 1 to 31'
    }
    setFieldErrors(problems)
    if (Object.keys(problems).length > 0 || amountCents === null) return

    const input: BillInput = {
      name: form.name.trim(),
      amountCents,
      frequency: form.frequency,
      dueDay,
      category: form.category.trim() || 'Bills',
      accountId: form.accountId || null,
      autopay: form.autopay,
      isActive: form.isActive,
      nextDueOn: bill?.nextDueOn ?? null,
      fundingStrategy: form.fundingStrategy,
      fundingPaycheckIndex:
        form.fundingStrategy === 'specific_check' ? Number(form.fundingPaycheckIndex) || 1 : null
    }

    await run(() => (bill ? updateBill(bill.id, input) : createBill(input)))
  }

  return (
    <Modal
      title={bill ? 'Edit bill' : 'Lock in a bill'}
      subtitle="This money leaves the surplus before anything else is routed."
      onClose={onClose}
      footer={
        <>
          <Button variant="quiet" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={saving}>
            {bill ? 'Save bill' : 'Add to the wall'}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
      >
        <div className="form-grid">
          <Field label="Bill name" wide error={fieldErrors.name}>
            <input
              className="input"
              autoFocus
              maxLength={60}
              value={form.name}
              placeholder="Rent"
              onChange={(event) => {
                clearField('name')
                setForm({ ...form, name: event.target.value })
              }}
            />
          </Field>
          <Field label="Amount" error={fieldErrors.amount}>
            <input
              className="input"
              inputMode="decimal"
              value={form.amount}
              placeholder="1,850.00"
              onChange={(event) => {
                clearField('amount')
                setForm({ ...form, amount: event.target.value })
              }}
            />
          </Field>
          <Field label="Cadence">
            <select
              className="select"
              value={form.frequency}
              onChange={(event) =>
                setForm({ ...form, frequency: event.target.value as Frequency })
              }
            >
              {FREQUENCIES.map((frequency) => (
                <option key={frequency} value={frequency}>
                  {FREQUENCY_LABEL[frequency]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Due day" hint="Day of the month the bill lands" error={fieldErrors.dueDay}>
            <input
              className="input"
              type="number"
              min={1}
              max={31}
              value={form.dueDay}
              onChange={(event) => {
                clearField('dueDay')
                setForm({ ...form, dueDay: event.target.value })
              }}
            />
          </Field>
          <Field label="Category">
            <input
              className="input"
              value={form.category}
              onChange={(event) => setForm({ ...form, category: event.target.value })}
            />
          </Field>
          <Field label="Paid from" wide>
            <select
              className="select"
              value={form.accountId}
              onChange={(event) => setForm({ ...form, accountId: event.target.value })}
            >
              <option value="">No account selected</option>
              {archivedAccount && (
                <option value={archivedAccount.id} disabled>
                  {archivedAccount.name} (archived)
                </option>
              )}
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.name}
                </option>
              ))}
            </select>
          </Field>
          <Field
            label="Funding schedule"
            hint="Which paycheck sets this bill's money aside. One check a month carries the whole month's obligation; it never pays it twice."
            wide
          >
            <select
              className="select"
              value={form.fundingStrategy}
              onChange={(event) =>
                setForm({ ...form, fundingStrategy: event.target.value as BillFundingStrategy })
              }
            >
              {FUNDING_STRATEGIES.map((strategy, index) => (
                <option key={strategy} value={strategy}>
                  {index + 1}. {BILL_FUNDING_STRATEGY_LABEL[strategy]}
                </option>
              ))}
            </select>
          </Field>

          {form.fundingStrategy === 'specific_check' && checkSlots.length > 1 && (
            <Field
              label="Which paycheck?"
              hint={`${PAY_CADENCE_LABEL[cadence]} pay gives ${checkSlots.length} paychecks every month`}
              wide
            >
              <select
                className="select"
                value={form.fundingPaycheckIndex}
                onChange={(event) => setForm({ ...form, fundingPaycheckIndex: event.target.value })}
              >
                {checkSlots.map((slot) => (
                  <option key={slot} value={String(slot)}>
                    {ordinal(slot)} paycheck of the month
                  </option>
                ))}
              </select>
            </Field>
          )}

          {form.fundingStrategy !== 'all_checks' && form.fundingStrategy !== 'specific_check' && (
            <p className="field-hint">
              Reserves the whole month&apos;s obligation on the{' '}
              {ordinal(fundingCheckForForm ?? 1)} paycheck
              {form.fundingStrategy === 'closest_due_date'
                ? ', closest to the due day'
                : form.fundingStrategy === 'last_check'
                  ? ', the last check your pay cycle is guaranteed to have every month'
                  : ''}
              . Every other paycheck reserves nothing for this bill.
            </p>
          )}
        </div>

        <div className="check-row">
          <label className="check">
            <input
              type="checkbox"
              checked={form.autopay}
              onChange={(event) => setForm({ ...form, autopay: event.target.checked })}
            />
            Autopay
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={form.isActive}
              onChange={(event) => setForm({ ...form, isActive: event.target.checked })}
            />
            Active bill
          </label>
        </div>
        <p className="field-hint hint-below">
          A note for you: WageRoute never posts a payment, so marking a bill autopay only changes
          how it is labelled. What you still owe stays on the wall until you log the payment.
        </p>
        {!form.isActive && (
          <p className="field-hint hint-below">
            Bill inactive · excluded from the wall and from every paycheck until you resume it.
          </p>
        )}

        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        {/* The footer's Save button lives outside this form; without a submitting
            control inside it, Enter in a field would do nothing. */}
        <button type="submit" style={{ display: 'none' }} tabIndex={-1} aria-hidden="true" />
      </form>
    </Modal>
  )
}

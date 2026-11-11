import { useState } from 'react'
import { Pencil, Plus } from 'lucide-react'
import {
  BILL_FUNDING_STRATEGY_LABEL,
  FREQUENCY_LABEL,
  PAY_CADENCE_LABEL,
  reachableCheckIndexes
} from '@shared/cadence'
import { formatDateLabel } from '@shared/dates'
import { billDeletionWords } from '@shared/deletion'
import { centsToEditable, formatMoney, parseMoneyToCents } from '@shared/money'
import type { AppSettings, Bill, BillFundingStrategy, BillInput, Frequency } from '@shared/types'
import { ordinal } from '../../renderer/src/lib/finance'
import { Checkbox, Field } from '../components/Field'
import { DeleteConfirm } from '../components/DeleteConfirm'
import { MoneyInput } from '../components/MoneyInput'
import { Sheet } from '../components/Sheet'
import { useSheetSave } from '../components/useSheetSave'
import { type BillLine, billLines, pocketView } from '../lib/compute'
import { entryAccounts } from '../lib/entry'
import { flag, text } from '../lib/rows'
import { usePocket, useSnapshot } from '../lib/store'
import { billDeletionSummary, createBill, deleteBill, patchBill, payBill } from '../lib/write'

const STATE_LABEL: Record<BillLine['state'], string> = {
  paid: 'Paid',
  reserved: 'Set aside',
  open: 'Due'
}

const FREQUENCIES = Object.keys(FREQUENCY_LABEL) as Frequency[]
const STRATEGIES = Object.keys(BILL_FUNDING_STRATEGY_LABEL) as BillFundingStrategy[]

interface BillForm {
  name: string
  amount: string
  frequency: Frequency
  dueDay: string
  category: string
  accountId: string
  autopay: boolean
  isActive: boolean
  fundingStrategy: BillFundingStrategy
  fundingPaycheckIndex: string
}

function formFor(bill: Bill | null, fallbackAccount: string): BillForm {
  return {
    name: bill?.name ?? '',
    amount: bill ? centsToEditable(bill.amountCents) : '',
    frequency: bill?.frequency ?? 'monthly',
    dueDay: bill ? String(bill.dueDay) : '1',
    category: bill?.category ?? 'Bills',
    accountId: bill?.accountId ?? fallbackAccount,
    autopay: bill?.autopay ?? true,
    isActive: bill?.isActive ?? true,
    fundingStrategy: bill?.fundingStrategy ?? 'all_checks',
    fundingPaycheckIndex: bill?.fundingPaycheckIndex ? String(bill.fundingPaycheckIndex) : '1'
  }
}

function BillFormSheet({
  bill,
  settings,
  onClose
}: {
  bill: Bill | null
  settings: AppSettings
  onClose: () => void
}) {
  const tables = usePocket((state) => state.tables)
  const add = usePocket((state) => state.add)
  const edit = usePocket((state) => state.edit)
  const accounts = tables ? entryAccounts(tables) : []
  // A bill saved before its account was archived keeps that pointer, so the
  // picker shows it as a disabled option instead of claiming another account.
  const archivedAccount =
    bill && tables
      ? tables.accounts.find(
          (row) =>
            text(row, 'id') === bill.accountId &&
            (flag(row, 'is_archived') || flag(row, 'is_locked'))
        )
      : undefined
  const [form, setForm] = useState<BillForm>(() =>
    formFor(bill, accounts[0] ? text(accounts[0], 'id') : '')
  )
  const { saving, error, setError, run } = useSheetSave(onClose)

  const cadence = settings.payCadence
  const checkSlots = reachableCheckIndexes(cadence)

  const submit = async () => {
    const amountCents = parseMoneyToCents(form.amount)
    const dueDay = Number(form.dueDay)
    if (!form.name.trim()) {
      setError('Give the bill a name')
      return
    }
    if (amountCents === null || amountCents <= 0) {
      setError('Enter an amount greater than zero')
      return
    }
    if (!Number.isInteger(dueDay) || dueDay < 1 || dueDay > 31) {
      setError('Due day must be a whole number from 1 to 31')
      return
    }

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
    await run(() =>
      bill
        ? edit((current) => patchBill(current, bill.id, input), 'Bill saved on this phone.')
        : add((current) => createBill(current, input), 'Bill saved on this phone.')
    )
  }

  return (
    <Sheet
      title={bill ? 'Edit this bill' : 'Add a bill'}
      hint="This comes out of every paycheck before anything else."
      onClose={onClose}
    >
      <Field label="Bill name">
        <input
          className="input"
          autoFocus
          maxLength={60}
          value={form.name}
          placeholder="Rent"
          onChange={(event) => setForm({ ...form, name: event.target.value })}
        />
      </Field>
      <Field label="Amount">
        <MoneyInput
          value={form.amount}
          placeholder="1,850.00"
          onValueChange={(amount) => setForm({ ...form, amount })}
        />
      </Field>
      <div className="field-grid">
        <Field label="How often">
          <select
            className="input"
            value={form.frequency}
            onChange={(event) => setForm({ ...form, frequency: event.target.value as Frequency })}
          >
            {FREQUENCIES.map((frequency) => (
              <option key={frequency} value={frequency}>
                {FREQUENCY_LABEL[frequency]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Due day" hint="Day of the month the bill lands">
          <input
            className="input"
            type="number"
            min={1}
            max={31}
            value={form.dueDay}
            onChange={(event) => setForm({ ...form, dueDay: event.target.value })}
          />
        </Field>
      </div>
      <Field label="Category">
        <input
          className="input"
          value={form.category}
          onChange={(event) => setForm({ ...form, category: event.target.value })}
        />
      </Field>
      <Field label="Paid from">
        <select
          className="input"
          value={form.accountId}
          onChange={(event) => setForm({ ...form, accountId: event.target.value })}
        >
          <option value="">No account selected</option>
          {archivedAccount && (
            <option value={text(archivedAccount, 'id')} disabled>
              {text(archivedAccount, 'name')} (archived)
            </option>
          )}
          {accounts.map((account) => (
            <option key={text(account, 'id')} value={text(account, 'id')}>
              {text(account, 'name')}
            </option>
          ))}
        </select>
      </Field>
      <Field
        label="When to set the money aside"
        hint="Which paycheck covers this bill. One paycheck can hold the whole month without paying it twice."
      >
        <select
          className="input"
          value={form.fundingStrategy}
          onChange={(event) =>
            setForm({ ...form, fundingStrategy: event.target.value as BillFundingStrategy })
          }
        >
          {STRATEGIES.map((strategy, index) => (
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
        >
          <select
            className="input"
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

      <div className="checks">
        <Checkbox
          label="Autopay"
          checked={form.autopay}
          onChange={(autopay) => setForm({ ...form, autopay })}
        />
        <Checkbox
          label="Use this bill"
          checked={form.isActive}
          onChange={(isActive) => setForm({ ...form, isActive })}
        />
      </div>
      {!form.isActive ? (
        <p className="fine">Paused · left off the Bills page and every paycheck until you turn it back on.</p>
      ) : null}

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
          {saving ? 'Saving…' : bill ? 'Save bill' : 'Add bill'}
        </button>
      </div>
    </Sheet>
  )
}

function BillSheet({
  line,
  onEdit,
  onRequestDelete,
  onClose
}: {
  line: BillLine
  onEdit: () => void
  onRequestDelete: () => void
  onClose: () => void
}) {
  const add = usePocket((state) => state.add)
  const edit = usePocket((state) => state.edit)
  const snapshot = useSnapshot()
  const currency = snapshot ? pocketView(snapshot).settings.currency : 'USD'
  const { saving, error, run } = useSheetSave(onClose)
  const paid = line.state === 'paid'

  return (
    <Sheet
      title={line.bill.name}
      hint={`${formatMoney(line.bill.amountCents, currency)} ${FREQUENCY_LABEL[line.bill.frequency]} · ${STATE_LABEL[line.state]}`}
      onClose={onClose}
    >
      <ul className="facts">
        <li>Due {formatDateLabel(line.dueOn)} ({line.daysUntil < 0 ? `${-line.daysUntil} days ago` : line.daysUntil === 0 ? 'today' : `in ${line.daysUntil} days`})</li>
        <li>About {formatMoney(line.perCheckCents, currency)} out of every paycheck</li>
        {line.bill.category ? <li>Category {line.bill.category}</li> : null}
        <li>{line.accountName ? `Paid from ${line.accountName}` : 'No account picked yet'}</li>
        {line.paidCents > 0 ? <li>{formatMoney(line.paidCents, currency)} paid this month</li> : null}
        <li>{line.bill.autopay ? 'Autopay is on' : 'Autopay is off'}</li>
        <li>{line.bill.isActive ? 'In the plan' : 'Paused'}</li>
      </ul>

      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="card-actions">
        {!paid ? (
          <button
            type="button"
            className="button primary compact"
            disabled={saving}
            onClick={() =>
              void run(() =>
                add((current) => payBill(current, line.bill.id), 'Payment saved on this phone.')
              )
            }
          >
            Mark paid
          </button>
        ) : null}
        <button
          type="button"
          className="button compact"
          disabled={saving}
          onClick={() =>
            void run(() =>
              edit(
                (current) => patchBill(current, line.bill.id, { isActive: !line.bill.isActive }),
                line.bill.isActive ? 'Bill paused.' : 'Bill turned back on.'
              )
            )
          }
        >
          {line.bill.isActive ? 'Pause' : 'Turn back on'}
        </button>
        <button type="button" className="button compact" disabled={saving} onClick={onEdit}>
          <Pencil size={15} aria-hidden="true" /> Edit
        </button>
        <button type="button" className="button danger compact" disabled={saving} onClick={onRequestDelete}>
          Delete
        </button>
      </div>
      <p className="fine">
        Deleting a bill keeps the entries you paid with it: they stay in the ledger as ordinary
        expenses, and this phone’s copy of the claim goes with the bill.
      </p>
    </Sheet>
  )
}

export function Bills() {
  const snapshot = useSnapshot()
  const tables = usePocket((state) => state.tables)
  const edit = usePocket((state) => state.edit)
  const [opened, setOpened] = useState<BillLine | null>(null)
  const [form, setForm] = useState<Bill | 'new' | null>(null)
  const [pendingDelete, setPendingDelete] = useState<BillLine | null>(null)
  if (!snapshot) return null
  const view = pocketView(snapshot)
  const currency = view.settings.currency
  const lines = billLines(snapshot)
  const unpaid = lines.filter((line) => line.state !== 'paid')
  const paidLines = lines.filter((line) => line.state === 'paid')
  const openedLine = opened ? (lines.find((line) => line.bill.id === opened.bill.id) ?? opened) : null
  // The phone holds the whole ledger, so it can count the rows a bill delete
  // moves without asking the computer — the same numbers the desktop reads.
  const deleteWords = pendingDelete
    ? billDeletionWords(
        pendingDelete.bill.name,
        tables ? billDeletionSummary(tables, pendingDelete.bill.id) : null
      )
    : null

  return (
    <div className="screen">
      <header className="screen-head">
        <div>
          <span className="eyebrow">Bills each month</span>
          <p className="hero-number">{formatMoney(view.monthlyBillsCents, currency)}</p>
        </div>
        <button type="button" className="button primary compact" onClick={() => setForm('new')}>
          <Plus size={17} aria-hidden="true" /> Add
        </button>
      </header>
      <p className="muted small">
        About {formatMoney(view.perCheckBillsCents, currency)} comes out of every paycheck to keep
        them covered.
      </p>

      {lines.length === 0 ? (
        <p className="empty-line">No bills yet. Add one and it comes off every paycheck.</p>
      ) : null}

      {unpaid.length > 0 ? (
        <section className="section">
          <header className="section-head">
            <h2>Still to pay</h2>
            <span className="muted small">{unpaid.length}</span>
          </header>
          <ul className="list">
            {unpaid.map((line) => (
              <li key={line.bill.id} className="row-card">
                <button
                  type="button"
                  className="row-main tap"
                  onClick={() => setOpened(line)}
                  aria-label={`${line.bill.name}, ${STATE_LABEL[line.state]}`}
                >
                  <span className="row-title">{line.bill.name}</span>
                  <span className="muted small">
                    {formatDateLabel(line.dueOn)}
                    {line.accountName ? ` · ${line.accountName}` : ''}
                    {line.paidCents > 0 ? ` · ${formatMoney(line.paidCents, currency)} paid` : ''}
                    {!line.bill.isActive ? ' · paused' : ''}
                  </span>
                </button>
                <div className="row-end">
                  <span className="amount">{formatMoney(line.bill.amountCents, currency)}</span>
                  <span className={`pill ${line.state}`}>
                    {line.state === 'open' && line.paidCents > 0 ? 'Part paid' : STATE_LABEL[line.state]}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {paidLines.length > 0 ? (
        <section className="section">
          <header className="section-head">
            <h2>Paid this month</h2>
            <span className="muted small">{paidLines.length}</span>
          </header>
          <ul className="list">
            {paidLines.map((line) => (
              <li key={line.bill.id} className="row-card settled">
                <button
                  type="button"
                  className="row-main tap"
                  onClick={() => setOpened(line)}
                  aria-label={`${line.bill.name}, paid`}
                >
                  <span className="row-title">{line.bill.name}</span>
                  <span className="muted small">{line.accountName ?? 'Paid'}</span>
                </button>
                <div className="row-end">
                  <span className="amount muted">{formatMoney(line.bill.amountCents, currency)}</span>
                  <span className="pill paid">{STATE_LABEL.paid}</span>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <p className="fine">
        Marking a bill paid here writes the same entry the computer would and settles its
        reservation on this phone, the way the desktop does.
      </p>

      {openedLine ? (
        <BillSheet
          line={openedLine}
          onEdit={() => {
            setForm(openedLine.bill)
            setOpened(null)
          }}
          onRequestDelete={() => setPendingDelete(openedLine)}
          onClose={() => setOpened(null)}
        />
      ) : null}

      {pendingDelete && deleteWords ? (
        <DeleteConfirm
          title={deleteWords.title}
          hint={deleteWords.body}
          detail={`${formatMoney(pendingDelete.bill.amountCents, currency)} ${
            FREQUENCY_LABEL[pendingDelete.bill.frequency]
          } · due ${formatDateLabel(pendingDelete.dueOn)}`}
          confirmLabel={deleteWords.confirmLabel}
          onCancel={() => setPendingDelete(null)}
          onDone={() => {
            setPendingDelete(null)
            setOpened(null)
          }}
          remove={() => edit((current) => deleteBill(current, pendingDelete.bill.id), 'Bill removed.')}
        />
      ) : null}

      {form ? (
        <BillFormSheet
          bill={form === 'new' ? null : form}
          settings={view.settings}
          onClose={() => setForm(null)}
        />
      ) : null}
    </div>
  )
}

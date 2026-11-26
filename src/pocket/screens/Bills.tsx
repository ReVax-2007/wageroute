import { useState } from 'react'
import { Pencil, Plus } from 'lucide-react'
import {
  BILL_FUNDING_STRATEGY_LABEL,
  BILL_PERIODS_PER_YEAR,
  FREQUENCY_LABEL,
  PAY_CADENCE_LABEL,
  reachableCheckIndexes
} from '@shared/cadence'
import { addDaysISO, formatDateLabel, isISODate, todayISO } from '@shared/dates'
import { billDeletionWords } from '@shared/deletion'
import { centsToEditable, formatMoney, parseMoneyToCents } from '@shared/money'
import type { AppSettings, Bill, BillFundingStrategy, BillInput, Frequency } from '@shared/types'
import { oneTimeCloseAtCents } from '@shared/oneTimeBills'
import { billVariance } from '@shared/variableBills'
import { ordinal } from '../../renderer/src/lib/finance'
import { Checkbox, Field } from '../components/Field'
import { DeleteConfirm } from '../components/DeleteConfirm'
import { MoneyInput } from '../components/MoneyInput'
import { Sheet } from '../components/Sheet'
import { useSheetSave } from '../components/useSheetSave'
import { type BillLine, billLines, doneLines, pocketView } from '../lib/compute'
import { entryAccounts } from '../lib/entry'
import { flag, text } from '../lib/rows'
import { usePocket, useSnapshot } from '../lib/store'
import {
  billDeletionSummary,
  billPaymentPlan,
  createBill,
  deleteBill,
  finishOneTimeBill,
  patchBill,
  payBill
} from '../lib/write'
import { FloorWarning, useFloorGate } from '../components/FloorWarning'

const STATE_LABEL: Record<BillLine['state'], string> = {
  paid: 'Paid',
  reserved: 'Set aside',
  open: 'Due',
  overdue: 'Overdue'
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
  isVariable: boolean
  fromPaychecks: boolean
  fundingStrategy: BillFundingStrategy
  fundingPaycheckIndex: string
  /** A one-time bill's date (ADR 0037). */
  dueOn: string
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
    isVariable: bill?.isVariable ?? false,
    fromPaychecks: bill?.fromPaychecks ?? true,
    fundingStrategy: bill?.fundingStrategy ?? 'all_checks',
    fundingPaycheckIndex: bill?.fundingPaycheckIndex ? String(bill.fundingPaycheckIndex) : '1',
    dueOn: bill?.nextDueOn ?? addDaysISO(todayISO(), 30)
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
  const oneTime = form.frequency === 'once'

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
    if (oneTime) {
      if (!isISODate(form.dueOn)) {
        setError('Pick the date it is due')
        return
      }
    } else if (!Number.isInteger(dueDay) || dueDay < 1 || dueDay > 31) {
      setError('Due day must be a whole number from 1 to 31')
      return
    }

    const input: BillInput = {
      name: form.name.trim(),
      amountCents,
      frequency: form.frequency,
      dueDay: oneTime ? Number(form.dueOn.slice(8, 10)) : dueDay,
      category: form.category.trim() || 'Bills',
      accountId: form.accountId || null,
      autopay: form.autopay,
      isActive: form.isActive,
      isVariable: form.isVariable,
      fromPaychecks: oneTime ? form.fromPaychecks : true,
      nextDueOn: oneTime ? form.dueOn : (bill?.nextDueOn ?? null),
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
      hint={
        oneTime
          ? form.fromPaychecks
            ? 'Due once. The paychecks before its date save it up, then it is done.'
            : 'Due once and left to you. Record each purchase; it is done once covered or closed.'
          : 'This comes out of every paycheck before anything else.'
      }
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
      <Field label={form.isVariable ? 'Estimate' : 'Amount'}>
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
            onChange={(event) => {
              const frequency = event.target.value as Frequency
              // A new one-time purchase starts with autopay off, as on the computer.
              setForm({ ...form, frequency, autopay: !bill && frequency === 'once' ? false : form.autopay })
            }}
          >
            {FREQUENCIES.map((frequency) => (
              <option key={frequency} value={frequency}>
                {FREQUENCY_LABEL[frequency]}
              </option>
            ))}
          </select>
        </Field>
        {oneTime ? (
          <Field label="Due on" hint="The day you will pay it">
            <input
              className="input"
              type="date"
              value={form.dueOn}
              onChange={(event) => setForm({ ...form, dueOn: event.target.value })}
            />
          </Field>
        ) : (
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
        )}
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
      {oneTime ? (
        <>
          <div className="checks">
            <Checkbox
              label="Save up for it from my paychecks"
              checked={form.fromPaychecks}
              onChange={(fromPaychecks) => setForm({ ...form, fromPaychecks })}
            />
          </div>
          <p className="fine">
            {form.fromPaychecks
              ? 'Every paycheck before the due date sets an equal share aside. A payment that covers it makes the bill done: it never comes due again.'
              : 'Left to you: no paycheck sets money aside and Safe to spend holds nothing back. Record each purchase as you make it.'}
          </p>
        </>
      ) : (
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
      )}

      {!oneTime && form.fundingStrategy === 'specific_check' && checkSlots.length > 1 && (
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
          label="Amount varies"
          checked={form.isVariable}
          onChange={(isVariable) => setForm({ ...form, isVariable })}
        />
        <Checkbox
          label="Use this bill"
          checked={form.isActive}
          onChange={(isActive) => setForm({ ...form, isActive })}
        />
      </div>
      {form.isVariable ? (
        <p className="fine">
          Amount varies · paychecks set the amount aside as an estimate. When it clears you say what
          it really was, and anything under goes back to Safe to spend. Autopay asks instead of
          posting a guess.
        </p>
      ) : null}
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
  const { saving, error, setError, run } = useSheetSave(onClose)
  const paid = line.state === 'paid'
  const oneTime = line.bill.frequency === 'once'
  const tables = usePocket((state) => state.tables)
  const floorGate = useFloorGate(currency)
  const variable = line.bill.isVariable
  // A variable bill asks what it came to, starting at the estimate so an
  // unchanged bill is still one tap (ADR 0036).
  const [actual, setActual] = useState(() =>
    centsToEditable(Math.max(0, line.bill.amountCents - line.paidCents))
  )
  // A fixed one-time bill is paid in parts: gifts bought one at a time against
  // one budget (ADR 0037). It asks what was paid now, starting at what is open.
  const inParts = oneTime && !variable
  const [last, setLast] = useState(false)
  const typedCents = variable || inParts ? parseMoneyToCents(actual) : null
  const typedPositive = typedCents !== null && typedCents > 0 ? typedCents : null
  const closeAtCents = inParts
    ? oneTimeCloseAtCents(line.bill, line.paidCents + (typedPositive ?? 0))
    : null
  const options =
    variable && typedPositive !== null
      ? { actualCents: typedPositive }
      : inParts && typedPositive !== null
        ? { partCents: typedPositive, last: last && closeAtCents !== null }
        : {}
  const variance =
    variable && typedCents !== null && typedCents > 0
      ? billVariance(line.bill.amountCents, typedCents)
      : null
  // What this month really cost, once a variable bill has cleared.
  const cleared =
    variable && line.actualCents > 0 && BILL_PERIODS_PER_YEAR[line.bill.frequency] <= 12
      ? billVariance(line.bill.amountCents, line.actualCents)
      : null

  const markPaid = () => {
    if (!tables) return
    if (variable && typedPositive === null) {
      setError('Enter what the bill came to')
      return
    }
    if (inParts && typedPositive === null) {
      // Nothing more bought: closing at what was already paid is its own write.
      if (last && closeAtCents !== null) {
        setError(null)
        void run(() =>
          edit((current) => finishOneTimeBill(current, line.bill.id), 'Bill closed at what you spent.')
        )
        return
      }
      setError('Enter what you paid')
      return
    }
    // Ask before a payment takes its account under a floor (ADR 0035). A plan
    // that cannot be made is left to payBill, which refuses with its reason.
    try {
      const plan = billPaymentPlan(tables, line.bill.id, options)
      const account = snapshot?.accounts.find((item) => item.id === plan.accountId)
      if (!floorGate.allow(account, plan.amountCents)) return
    } catch {
      // payBill below names the problem.
    }
    setError(null)
    void run(() => add((current) => payBill(current, line.bill.id, options), 'Payment saved on this phone.'))
  }

  return (
    <Sheet
      title={line.bill.name}
      hint={`${variable ? 'About ' : ''}${formatMoney(line.bill.amountCents, currency)} ${FREQUENCY_LABEL[line.bill.frequency]} · ${STATE_LABEL[line.state]}`}
      onClose={onClose}
    >
      <ul className="facts">
        <li>Due {formatDateLabel(line.dueOn)} ({line.daysUntil < 0 ? `${-line.daysUntil} days ago` : line.daysUntil === 0 ? 'today' : `in ${line.daysUntil} days`})</li>
        {oneTime ? (
          paid ? (
            <li>One time · paid, it will not come due again</li>
          ) : (
            <li>
              {line.bill.fromPaychecks === false
                ? 'One time · left to you, nothing set aside from paychecks'
                : `One time · about ${formatMoney(line.perCheckCents, currency)} from each paycheck until then`}
            </li>
          )
        ) : (
          <li>About {formatMoney(line.perCheckCents, currency)} out of every paycheck</li>
        )}
        {line.bill.category ? <li>Category {line.bill.category}</li> : null}
        <li>{line.accountName ? `Paid from ${line.accountName}` : 'No account picked yet'}</li>
        {variable ? <li>Amount varies · {formatMoney(line.bill.amountCents, currency)} is the estimate</li> : null}
        {cleared ? (
          <li>
            Came to {formatMoney(line.actualCents, currency)}
            {cleared.underCents > 0
              ? ` · ${formatMoney(cleared.underCents, currency)} under, back to Safe to spend`
              : cleared.overCents > 0
                ? ` · ${formatMoney(cleared.overCents, currency)} over the estimate`
                : ' · right on the estimate'}
          </li>
        ) : line.paidCents > 0 ? (
          <li>
            {formatMoney(variable ? line.actualCents : line.paidCents, currency)} paid
            {oneTime ? '' : ' this month'}
          </li>
        ) : null}
        <li>{line.bill.autopay ? 'Autopay is on' : 'Autopay is off'}</li>
        <li>{line.bill.isActive ? 'In the plan' : 'Paused'}</li>
      </ul>

      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      {variable && !paid ? (
        <Field
          label="It came to"
          hint={
            variance === null
              ? 'Enter what the bill came to'
              : variance.underCents > 0
                ? `${formatMoney(variance.underCents, currency)} under the estimate · back to Safe to spend`
                : variance.overCents > 0
                  ? `${formatMoney(variance.overCents, currency)} over the estimate`
                  : 'Exactly the estimate'
          }
        >
          <MoneyInput value={actual} onValueChange={setActual} />
        </Field>
      ) : null}
      {inParts && !paid ? (
        <>
          <Field
            label="Paid now"
            hint={
              typedPositive === null
                ? line.paidCents > 0
                  ? `${formatMoney(line.paidCents, currency)} paid so far · leave blank to just close it`
                  : 'Enter what you paid'
                : typedPositive >= line.bill.amountCents - line.paidCents
                  ? 'This pays it off'
                  : `${formatMoney(line.bill.amountCents - line.paidCents - typedPositive, currency)} still open after this`
            }
          >
            <MoneyInput value={actual} onValueChange={setActual} />
          </Field>
          {closeAtCents !== null || last ? (
            <div className="checks">
              <Checkbox
                label={
                  closeAtCents !== null
                    ? `That was the last one: close it at ${formatMoney(closeAtCents, currency)}`
                    : 'That was the last one'
                }
                checked={last}
                onChange={setLast}
              />
            </div>
          ) : null}
        </>
      ) : null}
      <FloorWarning text={floorGate.warning} />

      <div className="card-actions">
        {!paid ? (
          <button
            type="button"
            className="button primary compact"
            disabled={saving}
            onClick={markPaid}
          >
            {floorGate.confirmLabel ??
              (variable
                ? 'It cleared'
                : inParts
                  ? last && typedPositive === null
                    ? 'Close the bill'
                    : 'Record payment'
                  : 'Mark paid')}
          </button>
        ) : null}
        {oneTime && paid ? null : (
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
        )}
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
  // Paid one-time bills are done for good; they keep a list of their own (ADR 0037).
  const done = doneLines(snapshot)
  const openedLine = opened
    ? ([...lines, ...done].find((line) => line.bill.id === opened.bill.id) ?? opened)
    : null
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
                  <span className="muted small">
                    {line.bill.isVariable && line.actualCents > 0
                      ? `Came to ${formatMoney(line.actualCents, currency)}`
                      : (line.accountName ?? 'Paid')}
                  </span>
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

      {done.length > 0 ? (
        <section className="section">
          <header className="section-head">
            <h2>Done</h2>
            <span className="muted small">{done.length}</span>
          </header>
          <ul className="list">
            {done.map((line) => (
              <li key={line.bill.id} className="row-card settled">
                <button
                  type="button"
                  className="row-main tap"
                  onClick={() => setOpened(line)}
                  aria-label={`${line.bill.name}, one time, paid`}
                >
                  <span className="row-title">{line.bill.name}</span>
                  <span className="muted small">One time · was due {formatDateLabel(line.dueOn)}</span>
                </button>
                <div className="row-end">
                  <span className="amount muted">
                    {formatMoney(line.actualCents || line.bill.amountCents, currency)}
                  </span>
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

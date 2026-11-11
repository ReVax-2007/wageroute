import { useState } from 'react'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import { SNAPSHOT_TRANSACTION_LIMIT } from '@shared/api'
import { formatDateLabel, todayISO } from '@shared/dates'
import { entryDeletionWords } from '@shared/deletion'
import { centsToEditable, formatMoney, parseMoneyToCents } from '@shared/money'
import type { TransactionInput, TransactionKind, TransactionRow } from '@shared/types'
import { CREDIT_CARD_SOURCE_REFUSAL } from '@shared/writeRules'
import { TRANSACTION_KIND_LABEL } from '../../renderer/src/lib/finance'
import { Field } from '../components/Field'
import { DeleteConfirm } from '../components/DeleteConfirm'
import { MoneyInput } from '../components/MoneyInput'
import { Sheet } from '../components/Sheet'
import { useSheetSave } from '../components/useSheetSave'
import { categoryMatch, entryAccounts, entryBills, entryCategories, entryGoals } from '../lib/entry'
import { flag, text } from '../lib/rows'
import { usePocket, useSnapshot } from '../lib/store'
import type { EntryPatch } from '../lib/write'
import { createEntry, expandDeletion, patchEntry } from '../lib/write'

const KINDS = Object.keys(TRANSACTION_KIND_LABEL) as TransactionKind[]

function groupByDate(rows: readonly TransactionRow[]): [string, TransactionRow[]][] {
  const groups = new Map<string, TransactionRow[]>()
  for (const row of rows) {
    const list = groups.get(row.occurredOn) ?? []
    list.push(row)
    groups.set(row.occurredOn, list)
  }
  return [...groups.entries()].sort((a, b) => b[0].localeCompare(a[0]))
}

interface EntryForm {
  occurredOn: string
  accountId: string
  kind: TransactionKind
  amount: string
  category: string
  categoryId: string | null
  billId: string
  goalId: string
  counterAccountId: string
  memo: string
}

function formFor(row: TransactionRow | null, fallbackAccount: string): EntryForm {
  if (!row) {
    return {
      occurredOn: todayISO(),
      accountId: fallbackAccount,
      kind: 'expense',
      amount: '',
      category: 'Misc',
      categoryId: null,
      billId: '',
      goalId: '',
      counterAccountId: '',
      memo: ''
    }
  }
  return {
    occurredOn: row.occurredOn,
    accountId: row.accountId,
    kind: row.kind,
    // Only an adjustment may read back with its own sign; every other kind is
    // typed as a positive figure and gets its direction from the kind.
    amount: centsToEditable(row.kind === 'adjustment' ? row.amountCents : Math.abs(row.amountCents)),
    category: row.category,
    categoryId: row.categoryId,
    billId: row.billId ?? '',
    goalId: row.goalId ?? '',
    counterAccountId: row.counterAccountId ?? '',
    memo: row.memo
  }
}

/**
 * Add or edit an entry with the desktop's own fields, defaults and refusals.
 * A row the computer wrote is edited here exactly as one typed on the phone is,
 * because both are the same row in the same ledger.
 */
function EntrySheet({ row, onClose }: { row: TransactionRow | null; onClose: () => void }) {
  const tables = usePocket((state) => state.tables)
  const add = usePocket((state) => state.add)
  const editEntry = usePocket((state) => state.edit)
  const accounts = tables ? entryAccounts(tables) : []
  const categories = tables ? entryCategories(tables) : []
  const bills = tables ? entryBills(tables) : []
  const goals = tables ? entryGoals(tables) : []
  const [form, setForm] = useState<EntryForm>(() =>
    formFor(row, accounts[0] ? text(accounts[0], 'id') : '')
  )
  const { saving, error, setError, run } = useSheetSave(onClose)

  // A transfer only exists as a pair and a sweep only exists as a rounding of
  // its purchase, so those rows keep the columns their twin or source owns.
  const isTransferLeg = Boolean(row?.transferGroupId)
  const isSweep = Boolean(
    row && tables?.transactions.some((candidate) => text(candidate, 'id') === row.id && text(candidate, 'round_up_source_id'))
  )
  const lockedFields = isTransferLeg || isSweep

  const setKind = (kind: TransactionKind) => {
    // The link is what the kind means, so switching kinds drops a reference the
    // new kind could not have been created with.
    setForm((current) => ({ ...current, kind, billId: '', goalId: '' }))
  }

  const setCategory = (value: string) => {
    const match = categoryMatch(tables, value)
    setForm((current) => ({ ...current, category: value, categoryId: match ? text(match, 'id') : null }))
  }

  const submit = async () => {
    const typed = parseMoneyToCents(form.amount)
    if (!form.accountId) {
      setError('Pick an account')
      return
    }
    if (typed === null || typed === 0) {
      setError('Enter an amount')
      return
    }
    if (form.kind === 'bill_payment' && !form.billId) {
      setError('Choose the bill this payment covers')
      return
    }
    if (form.kind === 'goal_funding' && !form.goalId) {
      setError('Choose the goal this funds')
      return
    }
    if (form.kind === 'transfer') {
      if (!form.counterAccountId) {
        setError('Choose the destination account')
        return
      }
      if (form.counterAccountId === form.accountId) {
        setError('Choose two different accounts')
        return
      }
      // Only a new transfer is checked: an existing pair's receiving leg may
      // stand on a card, and its accounts are locked anyway.
      if (!row && accounts.some((account) => text(account, 'id') === form.accountId && text(account, 'kind') === 'credit')) {
        setError(CREDIT_CARD_SOURCE_REFUSAL)
        return
      }
    }

    // The kind decides the direction, exactly as the desktop's dialog sends it.
    const magnitude = Math.abs(typed)
    const amountCents =
      form.kind === 'income'
        ? magnitude
        : form.kind === 'adjustment'
          ? typed
          : form.kind === 'transfer'
            ? magnitude
            : -magnitude

    if (row) {
      const patch: EntryPatch = {
        amountCents: isSweep ? undefined : amountCents,
        occurredOn: isSweep ? undefined : form.occurredOn,
        accountId: lockedFields ? undefined : form.accountId,
        kind: lockedFields ? undefined : form.kind,
        memo: form.memo.trim(),
        category: form.category.trim() || 'Misc',
        categoryId: form.category.trim() ? form.categoryId : null
      }
      await run(() =>
        editEntry((current) => patchEntry(current, row.id, patch), 'Entry saved on this phone.')
      )
      return
    }

    const input: TransactionInput = {
      accountId: form.accountId,
      kind: form.kind,
      amountCents,
      occurredOn: form.occurredOn,
      category: form.category.trim() || 'Misc',
      categoryId: form.category.trim() ? form.categoryId : null,
      memo: form.memo.trim(),
      counterAccountId: form.kind === 'transfer' ? form.counterAccountId : null,
      billId: form.kind === 'bill_payment' ? form.billId : null,
      goalId: form.kind === 'goal_funding' ? form.goalId : null
    }
    await run(() => add((current) => createEntry(current, input), 'Entry saved on this phone.'))
  }

  const signHint =
    form.kind === 'income'
      ? 'Recorded as money in, even if you type a minus sign.'
      : form.kind === 'adjustment'
        ? 'Keeps the sign you type: negative lowers the balance.'
        : form.kind === 'transfer'
          ? 'Moves the amount from this account to the one below.'
          : 'Recorded as money out, even if you type a minus sign.'

  return (
    <Sheet
      title={row ? 'Edit this entry' : 'Add a ledger entry'}
      hint={
        row
          ? 'Manual edit only — it updates this row and travels back to your computer on your next export.'
          : 'Manual entry only — nothing is imported from a bank.'
      }
      onClose={onClose}
    >
      {isTransferLeg ? (
        <p className="fine">
          A transfer is two rows. Changing the amount, date, note or category updates both sides; the
          accounts and the kind stay paired.
        </p>
      ) : null}
      {isSweep ? (
        <p className="fine">
          This is a round-up sweep. Its amount and date follow the purchase it came from; only the
          note and category can change here.
        </p>
      ) : null}

      <Field label="Date">
        <input
          className="input"
          type="date"
          value={form.occurredOn}
          disabled={isSweep}
          onChange={(event) => setForm({ ...form, occurredOn: event.target.value })}
        />
      </Field>

      <Field label="Account">
        <select
          className="input"
          value={form.accountId}
          disabled={lockedFields}
          onChange={(event) => setForm({ ...form, accountId: event.target.value })}
        >
          {accounts.map((account) => (
            <option key={text(account, 'id')} value={text(account, 'id')}>
              {text(account, 'name')}
            </option>
          ))}
        </select>
      </Field>

      <Field
        label="Kind"
        hint={lockedFields ? 'Paired and rounded rows keep the kind they were written with' : undefined}
      >
        <select
          className="input"
          value={form.kind}
          disabled={lockedFields}
          onChange={(event) => setKind(event.target.value as TransactionKind)}
        >
          {KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {TRANSACTION_KIND_LABEL[kind]}
            </option>
          ))}
        </select>
      </Field>

      {form.kind === 'bill_payment' && (
        <Field label="Bill" hint="Closes this bill’s reservation and stops its reminder">
          <select
            className="input"
            value={form.billId}
            onChange={(event) => setForm({ ...form, billId: event.target.value })}
          >
            <option value="">Choose a bill…</option>
            {bills.map((bill) => (
              <option key={text(bill, 'id')} value={text(bill, 'id')}>
                {text(bill, 'name')}
                {flag(bill, 'is_active') ? '' : ' (paused)'}
              </option>
            ))}
          </select>
        </Field>
      )}

      {form.kind === 'goal_funding' && (
        <Field label="Goal" hint="A label on the entry; progress still follows the goal’s own accounts">
          <select
            className="input"
            value={form.goalId}
            onChange={(event) => setForm({ ...form, goalId: event.target.value })}
          >
            <option value="">Choose a goal…</option>
            {goals.map((goal) => (
              <option key={text(goal, 'id')} value={text(goal, 'id')}>
                {text(goal, 'name')}
              </option>
            ))}
          </select>
        </Field>
      )}

      {form.kind === 'transfer' && (
        <Field label="To account" hint="The other side of the transfer">
          <select
            className="input"
            value={form.counterAccountId}
            onChange={(event) => setForm({ ...form, counterAccountId: event.target.value })}
          >
            <option value="">Choose an account…</option>
            {accounts
              .filter((account) => text(account, 'id') !== form.accountId)
              .map((account) => (
                <option key={text(account, 'id')} value={text(account, 'id')}>
                  {text(account, 'name')}
                </option>
              ))}
          </select>
        </Field>
      )}

      <Field label="Amount" hint={signHint}>
        <MoneyInput
          autoFocus
          allowNegative={form.kind === 'adjustment'}
          value={form.amount}
          disabled={isSweep}
          placeholder="42.50"
          onValueChange={(amount) => setForm({ ...form, amount })}
        />
      </Field>

      <Field label="Category" hint="Pick one you already use, or name a new one">
        <input
          className="input"
          list="entry-category-options"
          value={form.category}
          onChange={(event) => setCategory(event.target.value)}
        />
        <datalist id="entry-category-options">
          {categories.map((category) => (
            <option key={text(category, 'id')} value={text(category, 'name')} />
          ))}
        </datalist>
      </Field>

      <Field label="Description" hint="Shown in the ledger and the dashboard feed">
        <input
          className="input"
          value={form.memo}
          maxLength={240}
          placeholder="Groceries"
          onChange={(event) => setForm({ ...form, memo: event.target.value })}
        />
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
          {saving ? 'Saving…' : row ? 'Save entry' : 'Add entry'}
        </button>
      </div>
    </Sheet>
  )
}

export function Ledger() {
  const snapshot = useSnapshot()
  const tables = usePocket((state) => state.tables)
  const localIds = usePocket((state) => state.localIds)
  const deleteEntry = usePocket((state) => state.deleteEntry)
  const [editing, setEditing] = useState<TransactionRow | 'new' | null>(null)
  const [pendingDelete, setPendingDelete] = useState<TransactionRow | null>(null)
  const currency = snapshot?.user.currency ?? 'USD'
  const local = new Set(localIds)

  if (!snapshot) return null
  const groups = groupByDate(snapshot.transactions)

  // Removing one row can retire more than it: the matching leg of a transfer,
  // and the two sweep rows a rounded-up purchase caused. The question has to
  // name every row that goes, the way the desktop's delete counts them.
  const doomed = pendingDelete && tables ? expandDeletion(tables, [pendingDelete.id]).size : 1
  const words = entryDeletionWords(doomed, {
    isTransferLeg: Boolean(pendingDelete?.transferGroupId),
    memo: pendingDelete?.memo ?? ''
  })

  return (
    <div className="screen">
      <header className="screen-head">
        <div>
          <h1>Entries</h1>
          <p className="muted small">
            {snapshot.transactionTotal.toLocaleString()} in the ledger
          </p>
        </div>
        <button type="button" className="button primary compact" onClick={() => setEditing('new')}>
          <Plus size={17} aria-hidden="true" /> Add
        </button>
      </header>

      {groups.length === 0 ? (
        <p className="empty-line">No entries yet.</p>
      ) : (
        groups.map(([date, rows]) => (
          <section key={date} className="section">
            <header className="section-head">
              <h2>{formatDateLabel(date)}</h2>
              <span className="muted small">
                {formatMoney(
                  rows.reduce((total, row) => total + row.amountCents, 0),
                  currency
                )}
              </span>
            </header>
            <ul className="list">
              {rows.map((row) => (
                <li key={row.id} className="row-card">
                  <div className="row-main">
                    <span className="row-title">{row.memo || row.category}</span>
                    <span className="muted small">
                      {TRANSACTION_KIND_LABEL[row.kind]} · {row.category} · {row.accountName}
                      {row.splitGroupId ? ' · split transfer' : ''}
                      {local.has(row.id) ? ' · on this phone' : ''}
                    </span>
                  </div>
                  <div className="row-end">
                    <span className={row.amountCents > 0 ? 'amount positive' : 'amount'}>
                      {row.amountCents > 0 ? '+' : ''}
                      {formatMoney(row.amountCents, currency)}
                    </span>
                    <button
                      type="button"
                      className="icon-button tiny"
                      aria-label={`Edit ${row.memo || row.category}`}
                      onClick={() => setEditing(row)}
                    >
                      <Pencil size={15} />
                    </button>
                    <button
                      type="button"
                      className="icon-button tiny"
                      aria-label={`Delete ${row.memo || 'entry'}`}
                      onClick={() => setPendingDelete(row)}
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ))
      )}

      {snapshot.transactionTotal > SNAPSHOT_TRANSACTION_LIMIT ? (
        <p className="fine">
          Showing the newest {SNAPSHOT_TRANSACTION_LIMIT} entries, the same window the desktop app
          shows.
        </p>
      ) : null}

      {editing ? (
        <EntrySheet
          row={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      ) : null}

      {pendingDelete ? (
        <DeleteConfirm
          title={words.title}
          hint={words.body}
          detail={`${formatMoney(pendingDelete.amountCents, currency)} on ${formatDateLabel(
            pendingDelete.occurredOn
          )}. It leaves this phone now, and the removal travels with your next export.`}
          confirmLabel={words.confirmLabel}
          onCancel={() => setPendingDelete(null)}
          onDone={() => setPendingDelete(null)}
          remove={() => deleteEntry(pendingDelete.id)}
        />
      ) : null}
    </div>
  )
}

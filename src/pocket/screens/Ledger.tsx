import { useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { formatDateLabel, todayISO } from '@shared/dates'
import { formatMoney, parseMoneyToCents } from '@shared/money'
import type { TransactionRow } from '@shared/types'
import { MoneyInput } from '../components/MoneyInput'
import { Sheet } from '../components/Sheet'
import { entryAccounts, entryCategories, EntryError, type EntryKind } from '../lib/entry'
import { SNAPSHOT_TRANSACTION_LIMIT } from '@shared/api'
import { text } from '../lib/rows'
import { usePocket, useSnapshot } from '../lib/store'

function groupByDate(rows: readonly TransactionRow[]): [string, TransactionRow[]][] {
  const groups = new Map<string, TransactionRow[]>()
  for (const row of rows) {
    const list = groups.get(row.occurredOn) ?? []
    list.push(row)
    groups.set(row.occurredOn, list)
  }
  return [...groups.entries()].sort((a, b) => b[0].localeCompare(a[0]))
}

function AddEntrySheet({ onClose }: { onClose: () => void }) {
  const tables = usePocket((state) => state.tables)
  const addEntry = usePocket((state) => state.addEntry)
  const accounts = tables ? entryAccounts(tables) : []
  const [kind, setKind] = useState<EntryKind>('expense')
  const [amount, setAmount] = useState('')
  const [accountId, setAccountId] = useState(accounts[0] ? text(accounts[0], 'id') : '')
  const [categoryId, setCategoryId] = useState('')
  const [occurredOn, setOccurredOn] = useState(todayISO())
  const [memo, setMemo] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const categories = tables ? entryCategories(tables, kind) : []

  const save = async () => {
    const cents = parseMoneyToCents(amount)
    if (cents === null || cents <= 0) {
      setError('Enter an amount greater than zero.')
      return
    }
    if (!accountId) {
      setError('Pick the account this came from.')
      return
    }
    setSaving(true)
    setError(null)
    try {
      await addEntry({
        accountId,
        kind,
        amountCents: cents,
        occurredOn,
        memo,
        categoryId: categoryId || null,
        categoryName: categoryId ? (categories.find((row) => text(row, 'id') === categoryId)?.name as string ?? '') : ''
      })
      onClose()
    } catch (caught) {
      setError(caught instanceof EntryError ? caught.message : 'The entry could not be saved.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Sheet
      title="Add an entry"
      hint="It stays on this phone until you export and import it on your computer."
      onClose={onClose}
    >
      <div className="segmented" role="group" aria-label="Kind of entry">
        <button
          type="button"
          className={kind === 'expense' ? 'segment active' : 'segment'}
          aria-pressed={kind === 'expense'}
          onClick={() => {
            setKind('expense')
            setCategoryId('')
          }}
        >
          Expense
        </button>
        <button
          type="button"
          className={kind === 'income' ? 'segment active' : 'segment'}
          aria-pressed={kind === 'income'}
          onClick={() => {
            setKind('income')
            setCategoryId('')
          }}
        >
          Income
        </button>
      </div>

      <label className="field">
        <span>Amount</span>
        <MoneyInput
          value={amount}
          onValueChange={setAmount}
          className="input money large"
          placeholder="0.00"
          autoFocus
        />
      </label>

      <label className="field">
        <span>{kind === 'expense' ? 'Paid from' : 'Paid into'}</span>
        <select className="input" value={accountId} onChange={(event) => setAccountId(event.target.value)}>
          {accounts.map((account) => (
            <option key={text(account, 'id')} value={text(account, 'id')}>
              {text(account, 'name')}
            </option>
          ))}
        </select>
      </label>

      <label className="field">
        <span>Category</span>
        <select className="input" value={categoryId} onChange={(event) => setCategoryId(event.target.value)}>
          <option value="">Uncategorized</option>
          {categories.map((category) => (
            <option key={text(category, 'id')} value={text(category, 'id')}>
              {text(category, 'name')}
            </option>
          ))}
        </select>
      </label>

      <label className="field">
        <span>Date</span>
        <input
          className="input"
          type="date"
          value={occurredOn}
          max={todayISO()}
          onChange={(event) => setOccurredOn(event.target.value)}
        />
      </label>

      <label className="field">
        <span>Note</span>
        <input
          className="input"
          type="text"
          value={memo}
          maxLength={120}
          placeholder="What was it for?"
          onChange={(event) => setMemo(event.target.value)}
        />
      </label>

      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="sheet-actions">
        <button type="button" className="button" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="button primary" disabled={saving} onClick={save}>
          {saving ? 'Saving…' : 'Save entry'}
        </button>
      </div>
    </Sheet>
  )
}

export function Ledger() {
  const snapshot = useSnapshot()
  const localIds = usePocket((state) => state.localIds)
  const deleteEntry = usePocket((state) => state.deleteEntry)
  const [adding, setAdding] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<TransactionRow | null>(null)
  const currency = snapshot?.user.currency ?? 'USD'
  const local = new Set(localIds)

  if (!snapshot) return null
  const groups = groupByDate(snapshot.transactions)

  return (
    <div className="screen">
      <header className="screen-head">
        <div>
          <h1>Entries</h1>
          <p className="muted small">
            {snapshot.transactionTotal.toLocaleString()} in the ledger
          </p>
        </div>
        <button type="button" className="button primary compact" onClick={() => setAdding(true)}>
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
                      {row.category} · {row.accountName}
                      {local.has(row.id) ? ' · on this phone' : ''}
                    </span>
                  </div>
                  <div className="row-end">
                    <span className={row.amountCents > 0 ? 'amount positive' : 'amount'}>
                      {row.amountCents > 0 ? '+' : ''}
                      {formatMoney(row.amountCents, currency)}
                    </span>
                    {local.has(row.id) ? (
                      <button
                        type="button"
                        className="icon-button tiny"
                        aria-label={`Remove ${row.memo || row.category}`}
                        onClick={() => setPendingDelete(row)}
                      >
                        <Trash2 size={15} />
                      </button>
                    ) : null}
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

      {adding ? <AddEntrySheet onClose={() => setAdding(false)} /> : null}

      {pendingDelete ? (
        <Sheet
          title="Remove this entry?"
          hint="It disappears from this phone only. Your computer's ledger is untouched."
          onClose={() => setPendingDelete(null)}
        >
          <p className="confirm-text">
            {pendingDelete.memo || pendingDelete.category} ·{' '}
            {formatMoney(pendingDelete.amountCents, currency)} on{' '}
            {formatDateLabel(pendingDelete.occurredOn)}
          </p>
          <div className="sheet-actions">
            <button type="button" className="button" onClick={() => setPendingDelete(null)}>
              Keep it
            </button>
            <button
              type="button"
              className="button danger"
              onClick={() => {
                void deleteEntry(pendingDelete.id)
                setPendingDelete(null)
              }}
            >
              Remove
            </button>
          </div>
        </Sheet>
      ) : null}
    </div>
  )
}

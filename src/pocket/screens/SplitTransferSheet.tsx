import { useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { todayISO } from '@shared/dates'
import { formatMoney, parseMoneyToCents } from '@shared/money'
import {
  SPLIT_TRANSFER_MAX_LINES,
  splitTransferProblem,
  splitTransferTotalCents
} from '@shared/splitTransfer'
import type { AccountWithBalance, SplitTransferInput } from '@shared/types'
import { Field } from '../components/Field'
import { MoneyInput } from '../components/MoneyInput'
import { Sheet } from '../components/Sheet'
import { useSheetSave } from '../components/useSheetSave'
import { categoryMatch, entryCategories } from '../lib/entry'
import { text } from '../lib/rows'
import { usePocket } from '../lib/store'
import { createSplitTransfer } from '../lib/write'

interface DraftLine {
  key: number
  accountId: string
  amount: string
  memo: string
}

let nextKey = 1
const blankLine = (): DraftLine => ({ key: nextKey++, accountId: '', amount: '', memo: '' })

/**
 * The desktop's split transfer on the phone (ADR 0033): one source to several
 * accounts, the total added up while typing, every line saved as an ordinary
 * transfer in one commit or none at all. One category covers the whole split
 * here; the desktop also lets each line carry its own.
 */
export function SplitTransferSheet({
  accounts,
  currency,
  onClose
}: {
  accounts: AccountWithBalance[]
  currency: string
  onClose: () => void
}) {
  const tables = usePocket((state) => state.tables)
  const add = usePocket((state) => state.add)
  const { saving, error, setError, run } = useSheetSave(onClose)
  const sources = accounts.filter((account) => account.kind !== 'credit')
  const byId = new Map(accounts.map((account) => [account.id, account]))
  const categories = tables ? entryCategories(tables) : []

  const [sourceId, setSourceId] = useState(sources[0]?.id ?? '')
  const [viaId, setViaId] = useState('')
  const [occurredOn, setOccurredOn] = useState(todayISO())
  const [category, setCategory] = useState('')
  const [lines, setLines] = useState<DraftLine[]>(() => [blankLine(), blankLine()])

  const matched = categoryMatch(tables, category)
  const input: SplitTransferInput = {
    sourceAccountId: sourceId,
    viaAccountId: viaId && viaId !== sourceId ? viaId : null,
    occurredOn,
    lines: lines.map((line) => ({
      accountId: line.accountId,
      amountCents: parseMoneyToCents(line.amount) ?? 0,
      category,
      categoryId: matched ? text(matched, 'id') : null,
      memo: line.memo
    }))
  }
  const totalCents = splitTransferTotalCents(input.lines)
  const source = byId.get(sourceId)

  const update = (key: number, change: Partial<DraftLine>) => {
    setError(null)
    setLines((current) => current.map((line) => (line.key === key ? { ...line, ...change } : line)))
  }

  const submit = () => {
    const problem = splitTransferProblem(input, (id) => byId.get(id))
    if (problem) {
      setError(problem)
      return
    }
    void run(() =>
      add((current) => createSplitTransfer(current, input), 'Split transfer recorded.')
    )
  }

  return (
    <Sheet
      title="Split transfer"
      hint="One account sends money to several. Each line is saved as its own transfer."
      onClose={onClose}
    >
      <Field label="From">
        <select
          className="input"
          value={sourceId}
          onChange={(event) => {
            setSourceId(event.target.value)
            setError(null)
          }}
        >
          {sources.map((account) => (
            <option key={account.id} value={account.id}>
              {account.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Through" hint="Optional: where the total lands first, before it is split">
        <select className="input" value={viaId} onChange={(event) => setViaId(event.target.value)}>
          <option value="">Straight from the source</option>
          {sources
            .filter((account) => account.id !== sourceId)
            .map((account) => (
              <option key={account.id} value={account.id}>
                {account.name}
              </option>
            ))}
        </select>
      </Field>

      {lines.map((line, index) => (
        <fieldset className="split-line" key={line.key}>
          <legend className="small muted">Line {index + 1}</legend>
          <Field label="To">
            <select
              className="input"
              value={line.accountId}
              onChange={(event) => update(line.key, { accountId: event.target.value })}
            >
              <option value="">Choose…</option>
              {accounts
                .filter((account) => account.id !== sourceId)
                .map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.id === input.viaAccountId ? `${account.name} (stays here)` : account.name}
                  </option>
                ))}
            </select>
          </Field>
          <Field label="Amount">
            <MoneyInput value={line.amount} onValueChange={(amount) => update(line.key, { amount })} />
          </Field>
          <Field label="Note">
            <input
              className="input"
              value={line.memo}
              maxLength={240}
              placeholder="Optional"
              onChange={(event) => update(line.key, { memo: event.target.value })}
            />
          </Field>
          {lines.length > 1 ? (
            <button
              type="button"
              className="button compact"
              onClick={() => setLines((current) => current.filter((item) => item.key !== line.key))}
            >
              <Trash2 size={15} aria-hidden="true" /> Remove line {index + 1}
            </button>
          ) : null}
        </fieldset>
      ))}
      {lines.length < SPLIT_TRANSFER_MAX_LINES ? (
        <button
          type="button"
          className="button compact"
          onClick={() => setLines((current) => [...current, blankLine()])}
        >
          <Plus size={15} aria-hidden="true" /> Add account
        </button>
      ) : null}

      <Field label="Category" hint="Blank files every line under Transfer">
        <input
          className="input"
          list="split-category-options"
          value={category}
          placeholder="Transfer"
          onChange={(event) => setCategory(event.target.value)}
        />
        <datalist id="split-category-options">
          {categories.map((row) => (
            <option key={text(row, 'id')} value={text(row, 'name')} />
          ))}
        </datalist>
      </Field>
      <Field label="Date">
        <input
          className="input"
          type="date"
          value={occurredOn}
          onChange={(event) => setOccurredOn(event.target.value)}
        />
      </Field>

      <p className="fine" aria-live="polite">
        Total to move: <strong>{formatMoney(totalCents, currency)}</strong>
        {source ? ` · ${source.name} after: ${formatMoney(source.balanceCents - totalCents, currency)}` : ''}
      </p>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="sheet-actions">
        <button type="button" className="button" disabled={saving} onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="button primary"
          disabled={saving || totalCents <= 0}
          onClick={submit}
        >
          {saving ? 'Recording…' : `Split ${formatMoney(totalCents, currency)}`}
        </button>
      </div>
    </Sheet>
  )
}

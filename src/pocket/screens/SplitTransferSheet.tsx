import { useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { todayISO } from '@shared/dates'
import { formatMoney } from '@shared/money'
import {
  SPLIT_TRANSFER_MAX_LINES,
  splitTransferProblem,
  splitTransferTotalCents
} from '@shared/splitTransfer'
import { FULL_BPS, centsToBps, formatBps } from '@shared/splitTotal'
import type { AccountWithBalance, SplitTransferInput } from '@shared/types'
import { Field } from '../components/Field'
import { MoneyInput, PercentInput } from '../components/MoneyInput'
import { Sheet } from '../components/Sheet'
import { FloorWarning, useFloorGate } from '../components/FloorWarning'
import { usableLabel } from '@shared/accounts'
import { accountAvailLabel } from '../../renderer/src/lib/finance'
import {
  NO_SHARE,
  useSplitTotal,
  type ShareLine,
  type SplitEntry,
  type ShareUnit
} from '../../renderer/src/lib/useSplitTotal'
import { useSheetSave } from '../components/useSheetSave'
import { categoryMatch, entryCategories } from '../lib/entry'
import { text } from '../lib/rows'
import { usePocket } from '../lib/store'
import { createSplitTransfer } from '../lib/write'

interface DraftLine extends ShareLine {
  accountId: string
  memo: string
}

let nextKey = 1
const blankLine = (): DraftLine => ({ key: nextKey++, accountId: '', amount: '', memo: '', share: NO_SHARE })

/** Two-way choice in the phone's segmented style. */
function Choice<T extends string>({
  label,
  value,
  options,
  onChange
}: {
  label: string
  value: T
  options: readonly { value: T; label: string }[]
  onChange: (value: T) => void
}) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={option.value === value ? 'segment active' : 'segment'}
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

/**
 * The desktop's split transfer on the phone (ADR 0033): one source to several
 * accounts, the total added up while typing (or named first and shared out by
 * amount or percent), every line saved as an ordinary transfer in one commit or
 * none at all. One category covers the whole split here; the desktop also lets
 * each line carry its own.
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
  const floorGate = useFloorGate(currency)
  const sources = accounts.filter((account) => account.kind !== 'credit')
  const byId = new Map(accounts.map((account) => [account.id, account]))
  const categories = tables ? entryCategories(tables) : []

  const [sourceId, setSourceId] = useState(sources[0]?.id ?? '')
  const [viaId, setViaId] = useState('')
  const [occurredOn, setOccurredOn] = useState(todayISO())
  const [category, setCategory] = useState('')
  const [lines, setLines] = useState<DraftLine[]>(() => [blankLine(), blankLine()])
  const split = useSplitTotal(lines, setLines, currency)
  const { splitting, unit, goalCents, balance, resolved } = split

  const matched = categoryMatch(tables, category)
  const input: SplitTransferInput = {
    sourceAccountId: sourceId,
    viaAccountId: viaId && viaId !== sourceId ? viaId : null,
    occurredOn,
    lines: lines.map((line, index) => ({
      accountId: line.accountId,
      amountCents: split.lineCents(line, index),
      category,
      categoryId: matched ? text(matched, 'id') : null,
      memo: line.memo
    }))
  }
  const totalCents = splitTransferTotalCents(input.lines)
  const source = byId.get(sourceId)
  const lineName = (index: number) => byId.get(lines[index]?.accountId ?? '')?.name ?? `Line ${index + 1}`
  const note = split.note(lineName)

  const update = (key: number, change: Partial<DraftLine>) => {
    setError(null)
    setLines((current) => current.map((line) => (line.key === key ? { ...line, ...change } : line)))
  }

  const submit = () => {
    const problem = split.goalProblem ?? splitTransferProblem(input, (id) => byId.get(id))
    if (problem) {
      setError(problem)
      return
    }
    // Only the source can end lower: a "through" account receives the total first.
    if (!floorGate.allow(source, -totalCents)) return
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
      <Choice<SplitEntry>
        label="How to enter the split"
        value={split.entry}
        onChange={(next) => {
          setError(null)
          split.switchEntry(next)
        }}
        options={[
          { value: 'lines', label: 'Add up the lines' },
          { value: 'total', label: 'Split a total' }
        ]}
      />
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
              {account.name} ({accountAvailLabel(account, currency)})
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

      {splitting ? (
        <>
          <Field label="Total to move">
            <MoneyInput
              value={split.goalText}
              placeholder="0.00"
              onValueChange={(text) => {
                setError(null)
                split.setGoal(text)
              }}
            />
          </Field>
          <Choice<ShareUnit>
            label="Share by"
            value={unit}
            onChange={split.setUnit}
            options={[
              { value: 'amount', label: 'Amount' },
              { value: 'percent', label: 'Percent' }
            ]}
          />
          <button
            type="button"
            className="button compact"
            disabled={goalCents <= 0}
            onClick={() => {
              setError(null)
              split.splitEven()
            }}
          >
            Split evenly
          </button>
        </>
      ) : null}

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
          {splitting ? (
            <>
              <Field label={unit === 'percent' ? 'Percent' : 'Amount'}>
                {unit === 'percent' ? (
                  <PercentInput
                    value={split.shareText(line, index)}
                    placeholder="0"
                    onFocus={() => split.focusShare(line, index)}
                    onBlur={split.blurShare}
                    onValueChange={(text) => {
                      setError(null)
                      split.typeShare(line.key, text)
                    }}
                  />
                ) : (
                  <MoneyInput
                    value={split.shareText(line, index)}
                    placeholder="0.00"
                    onFocus={() => split.focusShare(line, index)}
                    onBlur={split.blurShare}
                    onValueChange={(text) => {
                      setError(null)
                      split.typeShare(line.key, text)
                    }}
                  />
                )}
              </Field>
              <div className="share-slider">
                <input
                  type="range"
                  className="share-range"
                  min={0}
                  max={unit === 'percent' ? FULL_BPS : Math.max(goalCents, 1)}
                  step={100}
                  value={
                    unit === 'percent'
                      ? centsToBps(goalCents, resolved.cents[index])
                      : Math.min(resolved.cents[index], goalCents)
                  }
                  disabled={goalCents <= 0}
                  aria-label={`Share for ${lineName(index)}`}
                  aria-valuetext={`${formatMoney(resolved.cents[index], currency)}, ${
                    formatBps(centsToBps(goalCents, resolved.cents[index])) || '0'
                  }% of ${formatMoney(goalCents, currency)}`}
                  onChange={(event) => {
                    setError(null)
                    split.slide(line.key, Number(event.target.value))
                  }}
                />
                <span className="small muted num" aria-hidden="true">
                  {formatMoney(resolved.cents[index], currency)} ·{' '}
                  {formatBps(centsToBps(goalCents, resolved.cents[index])) || '0'}%
                </span>
              </div>
              <button
                type="button"
                className="button compact"
                disabled={goalCents <= 0 || balance.leftCents === 0}
                aria-label={
                  balance.leftCents >= 0
                    ? `Put the ${formatMoney(balance.leftCents, currency)} left on ${lineName(index)}`
                    : `Take the ${formatMoney(-balance.leftCents, currency)} over off ${lineName(index)}`
                }
                onClick={() => {
                  setError(null)
                  split.takeRest(line.key, index)
                }}
              >
                Take the rest
              </button>
            </>
          ) : (
            <Field label="Amount">
              <MoneyInput value={line.amount} onValueChange={(amount) => update(line.key, { amount })} />
            </Field>
          )}
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
              onClick={() => {
                split.linesChanged()
                setLines((current) => current.filter((item) => item.key !== line.key))
              }}
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
          onClick={() => {
            split.linesChanged()
            setLines((current) => [...current, blankLine()])
          }}
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

      {splitting ? (
        <p className="fine" aria-live="polite">
          Shared out: <strong>{formatMoney(balance.allocatedCents, currency)}</strong> of{' '}
          {formatMoney(goalCents, currency)} ·{' '}
          <strong className={balance.leftCents === 0 ? undefined : balance.leftCents > 0 ? 'warn-text' : 'danger-text'}>
            {goalCents === 0
              ? 'enter the total to move'
              : balance.leftCents === 0
                ? 'adds up exactly'
                : balance.leftCents > 0
                  ? `${formatMoney(balance.leftCents, currency)} left to place`
                  : `${formatMoney(-balance.leftCents, currency)} over the total`}
          </strong>
        </p>
      ) : null}
      {note ? <p className="fine">{note}</p> : null}
      <p className="fine" aria-live="polite">
        Total to move: <strong>{formatMoney(totalCents, currency)}</strong>
        {source ? ` · ${source.name} after: ${formatMoney(source.balanceCents - totalCents, currency)}` : ''}
        {source && usableLabel(source, currency, source.balanceCents - totalCents) !== null
          ? ` · ${usableLabel(source, currency, source.balanceCents - totalCents)}`
          : ''}
      </p>
      <FloorWarning text={floorGate.warning} />
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
          disabled={saving || totalCents <= 0 || split.goalProblem !== null}
          onClick={submit}
        >
          {saving ? 'Recording…' : (floorGate.confirmLabel ?? `Split ${formatMoney(totalCents, currency)}`)}
        </button>
      </div>
    </Sheet>
  )
}

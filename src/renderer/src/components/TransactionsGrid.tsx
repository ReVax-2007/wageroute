import { useMemo, useRef, useState } from 'react'
import 'react-data-grid/lib/styles.css'
// The grid's own theme and editor rules travel with the grid, so the rest of
// the app never loads them.
import '../styles/grid.css'
import { Trash2 } from 'lucide-react'
import {
  DataGrid,
  SelectColumn,
  renderTextEditor,
  type Column,
  type RenderEditCellContentProps
} from 'react-data-grid'
import { categoryKey } from '@shared/categories'
import { entryDeletionWords } from '@shared/deletion'
import { formatDateLabel } from '@shared/dates'
import { formatMoney, centsToEditable, canonicalMoneyInput, parseMoneyToCents, sanitizeMoneyInput } from '@shared/money'
import type {
  AccountWithBalance,
  Category,
  TransactionKind,
  TransactionPatch,
  TransactionRow
} from '@shared/types'
import { retypeChoices, TRANSACTION_KIND_LABEL } from '../lib/finance'
import { useFinanceStore } from '../store/useFinanceStore'

export function TransactionsGrid({
  rows,
  accounts,
  categories,
  currency,
  selected,
  onSelectedChange
}: {
  rows: TransactionRow[]
  accounts: AccountWithBalance[]
  categories: readonly Category[]
  currency: string
  selected?: ReadonlySet<string>
  onSelectedChange?: (ids: string[]) => void
}) {
  const updateTransaction = useFinanceStore((state) => state.updateTransaction)
  const deleteTransaction = useFinanceStore((state) => state.deleteTransaction)
  const countEntryDeletion = useFinanceStore((state) => state.countEntryDeletion)
  const askConfirm = useFinanceStore((state) => state.askConfirm)
  const pending = useFinanceStore((state) => state.pending)
  const refresh = useFinanceStore((state) => state.refresh)

  const handleRowsChange = (nextRows: TransactionRow[], indexes: number[]) => {
    for (const index of indexes) {
      const next = nextRows[index]
      const previous = rows[index]
      if (!next || !previous) continue

      const patch: TransactionPatch = {}
      if (next.occurredOn !== previous.occurredOn) patch.occurredOn = next.occurredOn
      if (next.category !== previous.category) patch.category = next.category
      if (next.categoryId !== previous.categoryId) patch.categoryId = next.categoryId
      if (next.memo !== previous.memo) patch.memo = next.memo
      if (next.amountCents !== previous.amountCents) patch.amountCents = next.amountCents

      // Both legs of a transfer are one movement of money: the repository mirrors the
      // date, amount and text onto the other leg, but the accounts are fixed.
      if (!previous.transferGroupId && next.accountId !== previous.accountId) {
        patch.accountId = next.accountId
      }
      if (!previous.transferGroupId && next.kind !== previous.kind) patch.kind = next.kind

      if (Object.keys(patch).length === 0) continue
      // A refused save leaves the grid holding the value it never wrote, so a
      // failure re-reads the snapshot and the cell snaps back with the reason
      // already on screen.
      const save = (id: string, next: TransactionPatch): void => {
        void updateTransaction(id, next).then((ok) => {
          if (!ok) void refresh().catch(() => undefined)
        })
      }
      if (patch.kind === undefined && patch.accountId === undefined) {
        save(next.id, patch)
        continue
      }

      // Moving money between accounts or flipping income and expense changes
      // balances the user is looking at, so a stray click asks first.
      const changesKind = patch.kind !== undefined
      void askConfirm({
        title: changesKind ? 'Change this entry’s kind?' : 'Move this entry?',
        body: changesKind
          ? `“${TRANSACTION_KIND_LABEL[previous.kind]}” becomes “${TRANSACTION_KIND_LABEL[next.kind]}”. The sign, account balances, reports and any round-up are recomputed.`
          : `The entry leaves “${previous.accountName}” and joins “${next.accountName}”. Both balances, reports and any round-up are recomputed.`,
        confirmLabel: changesKind ? 'Change kind' : 'Move entry'
      }).then((ok) => {
        if (ok) save(next.id, patch)
        // The grid already holds the new cell value; re-read the snapshot so a
        // cancelled change snaps back instead of sitting there unsaved.
        else void refresh().catch(() => undefined)
      })
    }
  }

  const columns = useMemo<Column<TransactionRow>[]>(
    () => [
      ...(onSelectedChange ? [SelectColumn as Column<TransactionRow>] : []),
      {
        key: 'occurredOn',
        name: 'Date',
        width: 108,
        renderCell: ({ row }) => formatDateLabel(row.occurredOn),
        renderEditCell: (props) => <DateEditor {...props} />
      },
      {
        key: 'accountId',
        name: 'Account',
        width: 150,
        editable: (row: TransactionRow) => !row.transferGroupId,
        renderCell: ({ row }) => (
          <span className="grid-account" title={row.accountName}>
            {row.accountName}
          </span>
        ),
        renderEditCell: ({ row, onRowChange }) => (
          <select
            className="grid-editor"
            autoFocus
            value={row.accountId}
            onChange={(event) => onRowChange({ ...row, accountId: event.target.value }, true)}
          >
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.name}
              </option>
            ))}
          </select>
        )
      },
      {
        key: 'kind',
        name: 'Kind',
        width: 118,
        editable: (row: TransactionRow) => !row.transferGroupId,
        renderCell: ({ row }) => (
          <span className={`chip chip-${row.kind}`}>{TRANSACTION_KIND_LABEL[row.kind]}</span>
        ),
        renderEditCell: ({ row, onRowChange }) => (
          <select
            className="grid-editor"
            autoFocus
            value={row.kind}
            onChange={(event) =>
              onRowChange({ ...row, kind: event.target.value as TransactionKind }, true)
            }
          >
            {retypeChoices(row.kind).map((kind) => (
              <option key={kind} value={kind}>
                {TRANSACTION_KIND_LABEL[kind]}
              </option>
            ))}
          </select>
        )
      },
      {
        key: 'category',
        name: 'Category',
        width: 126,
        renderCell: ({ row }) =>
          row.categoryId !== null ? (
            <span className="grid-account">{row.category}</span>
          ) : (
            <span className="grid-account muted">{row.category}</span>
          ),
        renderEditCell: (props) => <CategoryEditor {...props} categories={categories} />
      },
      {
        key: 'memo',
        name: 'Description',
        minWidth: 180,
        renderCell: ({ row }) => (
          <span className="grid-memo">
            {row.memo}
            {row.billName && (
              <span className="grid-link" title={`Paid ${row.billName}`}>
                {row.billName}
              </span>
            )}
            {row.goalName && (
              <span className="grid-link" title={`Funded ${row.goalName}`}>
                {row.goalName}
              </span>
            )}
          </span>
        ),
        renderEditCell: renderTextEditor
      },
      {
        key: 'amountCents',
        name: 'Amount',
        width: 118,
        renderCell: ({ row }) => (
          <span
            className={
              row.amountCents < 0 ? 'num grid-amount negative' : 'num grid-amount positive'
            }
          >
            {formatMoney(row.amountCents, currency)}
          </span>
        ),
        renderEditCell: (props) => <MoneyEditor {...props} />
      },
      {
        key: 'actions',
        name: 'Actions',
        width: 64,
        renderCell: ({ row }) => {
          const busy = pending[row.id] === true
          return (
            <button
              type="button"
              className="icon-btn icon-btn-danger"
              aria-label={`Delete ${row.memo || 'entry'}`}
              title={busy ? 'Removing…' : row.transferGroupId ? 'Delete transfer' : 'Delete entry'}
              disabled={busy}
              onClick={() => {
                // The database is the only place that can see a transfer's twin and
                // the sweep legs a purchase owns, so the question waits for the count.
                void countEntryDeletion([row.id]).then((doomed) =>
                  askConfirm({
                    ...entryDeletionWords(doomed, {
                      isTransferLeg: Boolean(row.transferGroupId),
                      memo: row.memo
                    }),
                    danger: true
                  })
                )
                  .then((ok) => {
                    if (ok) void deleteTransaction(row.id)
                  })
              }}
            >
              <Trash2 size={14} />
            </button>
          )
        }
      }
    ],
    [accounts, askConfirm, categories, countEntryDeletion, currency, deleteTransaction, onSelectedChange, pending, refresh, updateTransaction]
  )

  return (
    <DataGrid
      className="rdg-themed"
      aria-label="Ledger entries"
      aria-busy={Object.keys(pending).length > 0}
      columns={columns}
      rows={rows}
      rowKeyGetter={(row) => row.id}
      onRowsChange={(nextRows, data) => handleRowsChange(nextRows, data.indexes)}
      selectedRows={selected}
      onSelectedRowsChange={
        onSelectedChange
          ? (next) => onSelectedChange([...next].filter((key): key is string => typeof key === 'string'))
          : undefined
      }
      rowHeight={38}
      headerRowHeight={38}
      defaultColumnOptions={{ resizable: true }}
    />
  )
}

/**
 * A typeahead over the categories the ledger already knows. Typing a new name
 * is allowed — the repository creates it on save — but matching an existing one
 * writes its id, which is what keeps the category reports grouped.
 */
function CategoryEditor({
  row,
  onRowChange,
  onClose,
  categories
}: RenderEditCellContentProps<TransactionRow> & { categories: readonly Category[] }) {
  const [value, setValue] = useState(row.category)
  const settled = useRef(false)

  const commit = (close: boolean) => {
    if (settled.current) return
    settled.current = true
    const name = value.trim() || row.category
    const match = categories.find((category) => categoryKey(category.name) === categoryKey(name))
    onRowChange({ ...row, category: name, categoryId: match?.id ?? null }, close)
  }

  return (
    <>
      <input
        className="grid-editor"
        autoFocus
        value={value}
        list="grid-category-options"
        aria-label="Category"
        onChange={(event) => setValue(event.target.value)}
        onBlur={() => commit(true)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') commit(true)
          if (event.key === 'Escape') {
            settled.current = true
            onClose(false)
          }
        }}
      />
      <datalist id="grid-category-options">
        {categories.map((category) => (
          <option key={category.id} value={category.name} />
        ))}
      </datalist>
    </>
  )
}

function MoneyEditor({ row, onRowChange, onClose }: RenderEditCellContentProps<TransactionRow>) {
  const [value, setValue] = useState(centsToEditable(row.amountCents))
  const settled = useRef(false)

  const commit = (close: boolean) => {
    if (settled.current) return
    settled.current = true
    // The field keeps separators while it is typed, so the last keystroke may
    // still be `12,`; settle it the way the dialogs do before reading it.
    const cents = parseMoneyToCents(canonicalMoneyInput(value, { allowNegative: true }))
    if (cents === null) {
      onClose(false)
      return
    }
    onRowChange({ ...row, amountCents: cents }, close)
  }

  return (
    <input
      className="grid-editor num"
      autoFocus
      inputMode="decimal"
      value={value}
      aria-label="Amount"
      onChange={(event) => setValue(sanitizeMoneyInput(event.target.value, { allowNegative: true }))}
      onBlur={() => commit(true)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') commit(true)
        if (event.key === 'Escape') {
          settled.current = true
          onClose(false)
        }
      }}
    />
  )
}

function DateEditor({ row, onRowChange, onClose }: RenderEditCellContentProps<TransactionRow>) {
  const [value, setValue] = useState(row.occurredOn)
  const settled = useRef(false)

  const commit = (close: boolean) => {
    if (settled.current) return
    settled.current = true
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      onClose(false)
      return
    }
    onRowChange({ ...row, occurredOn: value }, close)
  }

  return (
    <input
      className="grid-editor"
      autoFocus
      type="date"
      value={value}
      aria-label="Date"
      onChange={(event) => setValue(event.target.value)}
      onBlur={() => commit(true)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') commit(true)
        if (event.key === 'Escape') {
          settled.current = true
          onClose(false)
        }
      }}
    />
  )
}

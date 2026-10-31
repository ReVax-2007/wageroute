import { useMemo, useRef, useState } from 'react'
import 'react-data-grid/lib/styles.css'
import { Trash2 } from 'lucide-react'
import {
  DataGrid,
  renderTextEditor,
  type Column,
  type RenderEditCellContentProps,
  type SortColumn
} from 'react-data-grid'
import { formatDateLabel } from '@shared/dates'
import { formatMoney, centsToEditable, parseMoneyToCents } from '@shared/money'
import type {
  AccountWithBalance,
  TransactionKind,
  TransactionPatch,
  TransactionRow
} from '@shared/types'
import { TRANSACTION_KIND_LABEL } from '../lib/finance'
import { useFinanceStore } from '../store/useFinanceStore'

const KINDS = Object.keys(TRANSACTION_KIND_LABEL) as TransactionKind[]

export function TransactionsGrid({
  rows,
  accounts,
  currency
}: {
  rows: TransactionRow[]
  accounts: AccountWithBalance[]
  currency: string
}) {
  const updateTransaction = useFinanceStore((state) => state.updateTransaction)
  const deleteTransaction = useFinanceStore((state) => state.deleteTransaction)
  const askConfirm = useFinanceStore((state) => state.askConfirm)
  const pending = useFinanceStore((state) => state.pending)
  const refresh = useFinanceStore((state) => state.refresh)

  const [sortColumns, setSortColumns] = useState<readonly SortColumn[]>([])

  const orderedRows = useMemo(() => {
    if (sortColumns.length === 0) return rows
    return [...rows].sort((a, b) => {
      for (const sort of sortColumns) {
        const result = compareRows(a, b, sort.columnKey)
        if (result !== 0) return sort.direction === 'ASC' ? result : -result
      }
      return 0
    })
  }, [rows, sortColumns])

  const handleRowsChange = (nextRows: TransactionRow[], indexes: number[]) => {
    for (const index of indexes) {
      const next = nextRows[index]
      const previous = orderedRows[index]
      if (!next || !previous) continue

      const patch: TransactionPatch = {}
      if (next.occurredOn !== previous.occurredOn) patch.occurredOn = next.occurredOn
      if (next.category !== previous.category) patch.category = next.category
      if (next.memo !== previous.memo) patch.memo = next.memo
      if (next.amountCents !== previous.amountCents) patch.amountCents = next.amountCents

      // Both legs of a transfer are one movement of money: the repository mirrors the
      // date, amount and text onto the other leg, but the accounts are fixed.
      if (!previous.transferGroupId && next.accountId !== previous.accountId) {
        patch.accountId = next.accountId
      }
      if (!previous.transferGroupId && next.kind !== previous.kind) patch.kind = next.kind

      if (Object.keys(patch).length === 0) continue
      if (patch.kind === undefined && patch.accountId === undefined) {
        void updateTransaction(next.id, patch)
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
        if (ok) void updateTransaction(next.id, patch)
        // The grid already holds the new cell value; re-read the snapshot so a
        // cancelled change snaps back instead of sitting there unsaved.
        else void refresh().catch(() => undefined)
      })
    }
  }

  const columns = useMemo<Column<TransactionRow>[]>(
    () => [
      {
        key: 'occurredOn',
        name: 'Date',
        width: 108,
        sortable: true,
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
            {KINDS.map((kind) => (
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
        sortable: true,
        renderEditCell: renderTextEditor
      },
      {
        key: 'memo',
        name: 'Description',
        minWidth: 180,
        renderEditCell: renderTextEditor
      },
      {
        key: 'amountCents',
        name: 'Amount',
        width: 118,
        sortable: true,
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
                void askConfirm({
                  title: row.transferGroupId ? 'Delete both legs of this transfer?' : 'Delete this entry?',
                  body: row.transferGroupId
                    ? `“${row.memo || 'This transfer'}” is one movement of money; removing it also removes the matching leg.`
                    : `“${row.memo || 'This entry'}” disappears from the ledger and every balance it touches.`,
                  confirmLabel: 'Delete',
                  danger: true
                }).then((ok) => {
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
    [accounts, askConfirm, currency, deleteTransaction, pending, refresh, updateTransaction]
  )

  return (
    <DataGrid
      className="rdg-themed"
      aria-label="Ledger entries"
      aria-busy={Object.keys(pending).length > 0}
      columns={columns}
      rows={orderedRows}
      rowKeyGetter={(row) => row.id}
      onRowsChange={(nextRows, data) => handleRowsChange(nextRows, data.indexes)}
      sortColumns={sortColumns}
      onSortColumnsChange={setSortColumns}
      rowHeight={38}
      headerRowHeight={38}
      defaultColumnOptions={{ resizable: true }}
    />
  )
}

function compareRows(a: TransactionRow, b: TransactionRow, columnKey: string): number {
  switch (columnKey) {
    case 'occurredOn':
      return a.occurredOn.localeCompare(b.occurredOn)
    case 'amountCents':
      return a.amountCents - b.amountCents
    case 'category':
      return a.category.localeCompare(b.category)
    default:
      return 0
  }
}

function MoneyEditor({ row, onRowChange, onClose }: RenderEditCellContentProps<TransactionRow>) {
  const [value, setValue] = useState(centsToEditable(row.amountCents))
  const settled = useRef(false)

  const commit = (close: boolean) => {
    if (settled.current) return
    settled.current = true
    const cents = parseMoneyToCents(value)
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
      value={value}
      aria-label="Amount"
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

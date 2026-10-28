import { useMemo, useRef, useState } from 'react'
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
      if (next.accountId !== previous.accountId) patch.accountId = next.accountId
      if (next.category !== previous.category) patch.category = next.category
      if (next.memo !== previous.memo) patch.memo = next.memo
      if (next.kind !== previous.kind) patch.kind = next.kind
      if (next.amountCents !== previous.amountCents) patch.amountCents = next.amountCents

      if (Object.keys(patch).length > 0) void updateTransaction(next.id, patch)
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
        renderCell: ({ row }) => row.accountName,
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
        name: '',
        width: 64,
        renderCell: ({ row }) => (
          <button
            type="button"
            className="icon-btn icon-btn-danger"
            aria-label={`Delete ${row.memo || 'entry'}`}
            title={row.transferGroupId ? 'Delete transfer' : 'Delete entry'}
            onClick={() => {
              const question = row.transferGroupId
                ? `Delete both legs of "${row.memo || 'this transfer'}"?`
                : `Delete "${row.memo || 'this entry'}"?`
              if (window.confirm(question)) {
                void deleteTransaction(row.id)
              }
            }}
          >
            <Trash2 size={14} />
          </button>
        )
      }
    ],
    [accounts, currency, deleteTransaction, updateTransaction]
  )

  return (
    <DataGrid
      className="rdg-dark"
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

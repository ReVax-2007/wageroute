import { useMemo, useState } from 'react'
import 'react-data-grid/lib/styles.css'
import { CalendarClock } from 'lucide-react'
import { DataGrid, type Column, type SortColumn } from 'react-data-grid'
import { formatDateLabel } from '@shared/dates'
import { formatMoney } from '@shared/money'
import type { ProjectionRow } from '@shared/projections'
import { EmptyState } from './ui'

export function ProjectionsGrid({
  rows,
  currency
}: {
  rows: ProjectionRow[]
  currency: string
}) {
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

  const columns = useMemo<Column<ProjectionRow>[]>(
    () => [
      {
        key: 'date',
        name: 'Date',
        width: 108,
        sortable: true,
        renderCell: ({ row }) => formatDateLabel(row.date)
      },
      {
        key: 'type',
        name: 'Type',
        width: 104,
        sortable: true,
        renderCell: ({ row }) => (
          <span className={`chip chip-${row.type === 'goal' ? 'goal_funding' : 'bill_payment'}`}>
            {row.type === 'goal' ? 'Goal' : 'Bill'}
          </span>
        )
      },
      { key: 'name', name: 'Name', minWidth: 160, sortable: true },
      { key: 'category', name: 'Category', width: 150, sortable: true },
      {
        key: 'amountCents',
        name: 'Amount',
        width: 120,
        sortable: true,
        // Every projection is money leaving the account, so it is shown signed
        // the same way the ledger shows an outflow.
        renderCell: ({ row }) => (
          <span className="num grid-amount negative">
            {formatMoney(-row.amountCents, currency)}
          </span>
        )
      }
    ],
    [currency]
  )

  if (rows.length === 0) {
    return (
      <EmptyState
        icon={<CalendarClock size={20} />}
        title="Nothing scheduled yet"
        body="Add a bill to the Priority Wall or a sinking fund with a target date, and its next 90 days appear here."
      />
    )
  }

  return (
    <DataGrid
      className="rdg-themed"
      columns={columns}
      rows={orderedRows}
      rowKeyGetter={(row) => row.id}
      sortColumns={sortColumns}
      onSortColumnsChange={setSortColumns}
      rowHeight={38}
      headerRowHeight={38}
      defaultColumnOptions={{ resizable: true }}
    />
  )
}

function compareRows(a: ProjectionRow, b: ProjectionRow, columnKey: string): number {
  switch (columnKey) {
    case 'date':
      return a.date.localeCompare(b.date)
    case 'type':
      return a.type.localeCompare(b.type)
    case 'name':
      return a.name.localeCompare(b.name)
    case 'category':
      return a.category.localeCompare(b.category)
    case 'amountCents':
      return a.amountCents - b.amountCents
    default:
      return 0
  }
}

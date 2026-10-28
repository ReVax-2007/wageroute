import { useMemo } from 'react'
import { DataGrid, type Column } from 'react-data-grid'
import { formatDateLabel } from '@shared/dates'
import { formatMoney } from '@shared/money'
import type { ProjectionRow } from '@shared/projections'

export function ProjectionsGrid({
  rows,
  currency
}: {
  rows: ProjectionRow[]
  currency: string
}) {
  const columns = useMemo<Column<ProjectionRow>[]>(
    () => [
      {
        key: 'date',
        name: 'Date',
        width: 108,
        renderCell: ({ row }) => formatDateLabel(row.date)
      },
      {
        key: 'type',
        name: 'Type',
        width: 104,
        renderCell: ({ row }) => (
          <span className={`chip chip-${row.type === 'goal' ? 'goal_funding' : 'bill_payment'}`}>
            {row.type === 'goal' ? 'Goal' : 'Bill'}
          </span>
        )
      },
      { key: 'name', name: 'Name', minWidth: 160 },
      { key: 'category', name: 'Category', width: 150 },
      {
        key: 'amountCents',
        name: 'Amount',
        width: 120,
        renderCell: ({ row }) => (
          <span className="num grid-amount">{formatMoney(row.amountCents, currency)}</span>
        )
      }
    ],
    [currency]
  )

  return (
    <DataGrid
      className="rdg-dark"
      columns={columns}
      rows={rows}
      rowKeyGetter={(row) => row.id}
      rowHeight={38}
      headerRowHeight={38}
      defaultColumnOptions={{ resizable: true }}
    />
  )
}

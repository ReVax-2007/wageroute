import type { ReactNode } from 'react'

export interface DataTableColumn {
  key: string
  label: string
  className?: string
  /** When set, names the column for a screen reader instead of showing text. */
  ariaLabel?: string
  /** A hover explanation for a heading whose figure needs context. */
  title?: string
}

/**
 * The shared shell for the app's plain tables: a caption that names the table
 * out loud, scoped header cells, and one scroll container. Complex grids
 * (the editable ledger, the forecast) keep their own components.
 */
export function DataTable({
  caption,
  columns,
  className,
  children
}: {
  caption: string
  columns: readonly DataTableColumn[]
  className?: string
  children: ReactNode
}) {
  return (
    <div className="table-scroll">
      <table className={className ? `table ${className}` : 'table'}>
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                className={column.className}
                aria-label={column.ariaLabel}
                title={column.title}
              >
                {column.ariaLabel ? null : column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  )
}

import { useEffect, useMemo, useState } from 'react'
import { Landmark, Plus, Sheet, Trash2 } from 'lucide-react'
import { todayISO } from '@shared/dates'
import { projectUpcoming } from '@shared/projections'
import type { LedgerFilter, LedgerQuery, LedgerSort, TransactionPage } from '@shared/types'
import { Button, EmptyState, Segmented } from '../components/ui'
import { EntryDialog } from '../components/dialogs/EntryDialog'
import { ProjectionsGrid } from '../components/ProjectionsGrid'
import { TransactionsGrid } from '../components/TransactionsGrid'
import { TRANSACTION_KIND_LABEL, activeBills } from '../lib/finance'
import { useFinanceStore } from '../store/useFinanceStore'

type SheetTab = 'ledger' | 'projections'

const HORIZON_DAYS = 90
const PAGE_SIZE = 100

interface FilterForm {
  text: string
  from: string
  to: string
  accountId: string
  kind: string
  categoryId: string
}

const NO_FILTERS: FilterForm = {
  text: '',
  from: '',
  to: '',
  accountId: '',
  kind: '',
  categoryId: ''
}

const SORT_OPTIONS: { value: LedgerSort; label: string }[] = [
  { value: 'date_desc', label: 'Newest first' },
  { value: 'date_asc', label: 'Oldest first' },
  { value: 'amount_desc', label: 'Largest amount' },
  { value: 'amount_asc', label: 'Smallest amount' }
]

function isFiltering(form: FilterForm): boolean {
  return Object.values(form).some((value) => value !== '')
}

export function Spreadsheet() {
  const snapshot = useFinanceStore((state) => state.snapshot)
  const settings = useFinanceStore((state) => state.settings)
  const go = useFinanceStore((state) => state.go)
  const queryTransactions = useFinanceStore((state) => state.queryTransactions)
  const deleteTransactions = useFinanceStore((state) => state.deleteTransactions)
  const askConfirm = useFinanceStore((state) => state.askConfirm)
  const notify = useFinanceStore((state) => state.notify)
  const [tab, setTab] = useState<SheetTab>('ledger')
  const [adding, setAdding] = useState(false)

  const [filters, setFilters] = useState<FilterForm>(NO_FILTERS)
  const [debouncedText, setDebouncedText] = useState('')
  const [sort, setSort] = useState<LedgerSort>('date_desc')
  const [page, setPage] = useState(0)
  const [pageData, setPageData] = useState<TransactionPage | null>(null)
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState<string[]>([])

  const projections = useMemo(() => {
    if (!snapshot) return []
    return projectUpcoming({
      bills: activeBills(snapshot.bills),
      goals: snapshot.goals,
      fromISO: todayISO(),
      horizonDays: HORIZON_DAYS
    })
  }, [snapshot])

  // Typing must not fire a query per keystroke; the rest of the fields are
  // discrete choices and can load immediately.
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedText(filters.text), 250)
    return () => clearTimeout(timer)
  }, [filters.text])

  // Every write replaces the snapshot's transaction array, which is the signal
  // that the page in hand may no longer match the database.
  const ledgerVersion = snapshot?.transactions

  // The text is debounced separately, so only its settled value reaches SQL.
  const queryFilter = useMemo<LedgerFilter>(
    () => ({
      text: debouncedText.trim() || undefined,
      from: filters.from || null,
      to: filters.to || null,
      accountId: filters.accountId || null,
      kind: filters.kind ? (filters.kind as LedgerFilter['kind']) : null,
      categoryId: filters.categoryId || null
    }),
    [debouncedText, filters.from, filters.to, filters.accountId, filters.kind, filters.categoryId]
  )

  useEffect(() => {
    if (tab !== 'ledger' || !snapshot) return
    let cancelled = false
    setLoading(true)
    const timer = setTimeout(() => {
      const query: LedgerQuery = {
        filter: queryFilter,
        sort,
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE
      }
      queryTransactions(query)
        .then((data) => {
          if (!cancelled) setPageData(data)
        })
        .catch((error: unknown) => {
          if (cancelled) return
          setPageData({ rows: [], total: 0 })
          notify(error instanceof Error ? error.message : 'The ledger could not be read', 'error')
        })
        .finally(() => {
          if (!cancelled) setLoading(false)
        })
    }, 120)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
    // `snapshot` is read only to know the ledger is loaded; the transaction
    // array is what actually changes after a write.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, Boolean(snapshot), ledgerVersion, queryFilter, sort, page, queryTransactions, notify])

  // Deleting the last rows of the last page would otherwise strand the view on
  // an empty window while the entries above it still exist.
  useEffect(() => {
    if (!pageData || page === 0) return
    const lastPage = Math.max(0, Math.ceil(pageData.total / PAGE_SIZE) - 1)
    if (page > lastPage) setPage(lastPage)
  }, [pageData, page])

  if (!snapshot) return null
  const currency = settings.currency
  const liveAccounts = snapshot.accounts.filter((account) => !account.isArchived)
  const filtering = isFiltering(filters)
  const rows = pageData?.rows ?? []
  const total = pageData?.total ?? snapshot.transactionTotal
  const start = total === 0 ? 0 : page * PAGE_SIZE + 1
  const end = Math.min(total, page * PAGE_SIZE + rows.length)
  const lastPage = Math.max(0, Math.ceil(total / PAGE_SIZE) - 1)

  const updateFilters = (patch: Partial<FilterForm>) => {
    setFilters((current) => ({ ...current, ...patch }))
    setPage(0)
    setSelected([])
  }

  const clearFilters = () => {
    setFilters(NO_FILTERS)
    setDebouncedText('')
    setPage(0)
    setSelected([])
  }

  const deleteSelected = async () => {
    const count = selected.length
    if (count === 0) return
    const ok = await askConfirm({
      title: count === 1 ? 'Delete this entry?' : `Delete ${count} entries?`,
      body:
        count === 1
          ? 'The entry disappears from the ledger and every balance it touches.'
          : `${count} entries disappear from the ledger and every balance they touch. Deleting a transfer removes its matching leg too.`,
      confirmLabel: count === 1 ? 'Delete' : `Delete ${count}`,
      danger: true
    })
    if (!ok) return
    const removed = await deleteTransactions(selected)
    if (removed !== null) setSelected([])
  }

  return (
    <>
      <header className="page-head">
        <div>
          <p className="eyebrow">Spreadsheet</p>
          <h1 className="page-title" tabIndex={-1}>Every number, one grid</h1>
          <p className="page-sub">
            {tab === 'ledger'
              ? 'Double-click a cell to edit it in place. Dates, accounts, categories and amounts write straight to the local ledger.'
              : `A read-only forecast of the next ${HORIZON_DAYS} days of bills and goal deadlines, built from your own numbers.`}
          </p>
        </div>
        <Button
          variant="primary"
          icon={<Plus size={16} />}
          onClick={() => setAdding(true)}
          disabled={liveAccounts.length === 0}
          title={liveAccounts.length === 0 ? 'Add an account before recording an entry' : undefined}
        >
          Add entry
        </Button>
      </header>

      <section className="card sheet-card">
        <header className="sheet-toolbar">
          <Segmented<SheetTab>
            label="Spreadsheet view"
            value={tab}
            onChange={setTab}
            options={[
              { value: 'ledger', label: `Transactions (${total})` },
              {
                value: 'projections',
                label: `Next ${HORIZON_DAYS} days (${projections.length})`
              }
            ]}
          />
          <span className="sheet-hint">
            {tab === 'ledger'
              ? 'Double-click a cell to edit · Tick rows to delete several at once'
              : 'Read-only forecast of bills and goal deadlines'}
          </span>
        </header>

        {tab === 'ledger' && (
          <div className="ledger-filter" role="search" aria-label="Filter the ledger">
            <input
              className="input ledger-search"
              type="search"
              placeholder="Search description or category"
              aria-label="Search description or category"
              value={filters.text}
              onChange={(event) => updateFilters({ text: event.target.value })}
            />
            <input
              className="input"
              type="date"
              aria-label="From date"
              value={filters.from}
              onChange={(event) => updateFilters({ from: event.target.value })}
            />
            <input
              className="input"
              type="date"
              aria-label="To date"
              value={filters.to}
              onChange={(event) => updateFilters({ to: event.target.value })}
            />
            <select
              className="select"
              aria-label="Account"
              value={filters.accountId}
              onChange={(event) => updateFilters({ accountId: event.target.value })}
            >
              <option value="">All accounts</option>
              {snapshot.accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.name}
                </option>
              ))}
            </select>
            <select
              className="select"
              aria-label="Kind"
              value={filters.kind}
              onChange={(event) => updateFilters({ kind: event.target.value })}
            >
              <option value="">All kinds</option>
              {Object.entries(TRANSACTION_KIND_LABEL).map(([kind, label]) => (
                <option key={kind} value={kind}>
                  {label}
                </option>
              ))}
            </select>
            <select
              className="select"
              aria-label="Category"
              value={filters.categoryId}
              onChange={(event) => updateFilters({ categoryId: event.target.value })}
            >
              <option value="">All categories</option>
              {snapshot.categories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </select>
            <select
              className="select"
              aria-label="Sort order"
              value={sort}
              onChange={(event) => {
                setSort(event.target.value as LedgerSort)
                setPage(0)
              }}
            >
              {SORT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            {filtering && (
              <Button size="sm" variant="quiet" onClick={clearFilters}>
                Clear
              </Button>
            )}
          </div>
        )}

        {tab === 'ledger' && selected.length > 0 && (
          <div className="ledger-bulk" role="status">
            <span>
              {selected.length} {selected.length === 1 ? 'entry' : 'entries'} selected
            </span>
            <Button size="sm" variant="quiet" onClick={() => setSelected([])}>
              Clear selection
            </Button>
            <Button
              size="sm"
              variant="danger"
              icon={<Trash2 size={14} />}
              onClick={() => void deleteSelected()}
            >
              Delete selected
            </Button>
          </div>
        )}

        <div className="grid-host" aria-busy={loading && tab === 'ledger'}>
          {tab === 'ledger' ? (
            liveAccounts.length === 0 ? (
              <EmptyState
                icon={<Landmark size={20} />}
                title="Add an account first"
                body="Every ledger entry belongs to an account, so the grid stays empty until there is one to record against."
                action={
                  <Button variant="primary" onClick={() => go('accounts')}>
                    Add your first account
                  </Button>
                }
              />
            ) : rows.length === 0 ? (
              filtering ? (
                <EmptyState
                  icon={<Sheet size={20} />}
                  title="No entries match"
                  body="Nothing in the ledger matches this filter. Widen it, or clear it to see everything again."
                  action={<Button onClick={clearFilters}>Clear the filter</Button>}
                />
              ) : (
                <EmptyState
                  icon={<Sheet size={20} />}
                  title="No entries yet"
                  body="Add an expense, a transfer or an adjustment to start the ledger."
                  action={
                    <Button variant="primary" onClick={() => setAdding(true)}>
                      Add your first entry
                    </Button>
                  }
                />
              )
            ) : (
              <TransactionsGrid
                rows={rows}
                accounts={snapshot.accounts}
                categories={snapshot.categories}
                currency={currency}
                selected={new Set(selected)}
                onSelectedChange={setSelected}
              />
            )
          ) : (
            <ProjectionsGrid rows={projections} currency={currency} />
          )}
        </div>

        {tab === 'ledger' && total > 0 && (
          <footer className="ledger-foot">
            <span className="ledger-range">
              {filtering ? 'Matching' : 'Showing'} {start}–{end} of {total}
            </span>
            <div className="ledger-pages">
              <Button
                size="sm"
                variant="quiet"
                disabled={page === 0}
                onClick={() => {
                  setPage((current) => Math.max(0, current - 1))
                  setSelected([])
                }}
              >
                Previous
              </Button>
              <span className="ledger-range">
                Page {page + 1} of {lastPage + 1}
              </span>
              <Button
                size="sm"
                variant="quiet"
                disabled={page >= lastPage}
                onClick={() => {
                  setPage((current) => Math.min(lastPage, current + 1))
                  setSelected([])
                }}
              >
                Next
              </Button>
            </div>
          </footer>
        )}
      </section>

      {adding && <EntryDialog onClose={() => setAdding(false)} />}
    </>
  )
}

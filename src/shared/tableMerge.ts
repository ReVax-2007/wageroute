import type { ImportCounts } from './api'
import { CATEGORY_NAME_MAX, categoryKey, normalizeCategoryName } from './categories'
import { IMPORT_TABLES, type ImportTable, type ImportTables } from './importRepair'
import { DEFAULT_SETTINGS, isCurrencyCode } from './settings'

/**
 * How the two copies of one ledger differ. `kept` counts rows the incoming
 * file did not change, including tombstones for rows this copy never held.
 */
export interface MergeCounts {
  added: ImportCounts
  updated: ImportCounts
  removed: ImportCounts
  kept: ImportCounts
}

export interface TablesMergeResult {
  tables: ImportTables
  counts: MergeCounts
  /** Human-readable reasons a row could not be taken as sent. */
  warnings: string[]
}

type Row = Record<string, unknown>

export function emptyMergeCounts(): MergeCounts {
  const counts = (): ImportCounts => ({
    accounts: 0,
    balance_snapshots: 0,
    categories: 0,
    bills: 0,
    goals: 0,
    paychecks: 0,
    allocations: 0,
    bill_reserves: 0,
    transactions: 0,
    settings: 0
  })
  return { added: counts(), updated: counts(), removed: counts(), kept: counts() }
}

function isDeleted(row: Row): boolean {
  return row.deleted_at !== undefined && row.deleted_at !== null && row.deleted_at !== ''
}

function revisionOf(row: Row): number {
  const value = row.revision
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/**
 * A stamp later than the ceiling is read as the ceiling, matching the desktop
 * merge: a wrong clock must not make a row outrank every later edit forever.
 */
function timeOf(row: Row, ceiling: number): number {
  for (const key of ['updated_at', 'created_at']) {
    const value = row[key]
    if (typeof value !== 'string') continue
    const time = Date.parse(value)
    if (Number.isFinite(time)) return Math.min(time, ceiling)
  }
  return Number.NEGATIVE_INFINITY
}

/**
 * Whether the file's row is the later version of the same record. Time decides
 * first, because people think in "which edit is newest"; the revision breaks a
 * tie between two edits made in the same millisecond. A row with no usable
 * stamp never replaces one that has a stamp. The file's rows are capped at the
 * file's own export time, which every device reads the same way, so two
 * devices importing the same written-in-2099 row do not disagree about it.
 */
export function incomingWins(local: Row, incoming: Row, now: number, incomingLimit = now): boolean {
  const localTime = timeOf(local, now)
  const incomingTime = timeOf(incoming, Math.min(now, incomingLimit))
  if (incomingTime !== localTime) return incomingTime > localTime
  return revisionOf(incoming) > revisionOf(local)
}

function idOf(row: Row): string | null {
  const value = row.id
  return typeof value === 'string' && value.length > 0 ? value : null
}

function nameOf(row: Row): string {
  return typeof row.name === 'string' ? row.name : ''
}

/** Writes a future stamp as the file's export time. */
function clampStamps(row: Row, ceiling: number, ceilingISO: string): Row {
  const out = { ...row }
  for (const key of ['created_at', 'updated_at', 'deleted_at']) {
    const value = out[key]
    if (typeof value !== 'string') continue
    const time = Date.parse(value)
    if (Number.isFinite(time) && Number.isFinite(ceiling) && time > ceiling) {
      out[key] = ceilingISO
    }
  }
  return out
}

/**
 * Writes a future stamp as the file's export time, matching what the desktop
 * merge stores. A row with no edit stamp is as old as its creation rather than
 * as new as this merge: stamping the import time would let an untouched row
 * outrank an edit the other device made before the file was written.
 */
function settleRow(row: Row, ceiling: number, ceilingISO: string): Row {
  const out = clampStamps(row, ceiling, ceilingISO)
  const created = typeof out.created_at === 'string' ? Date.parse(out.created_at) : Number.NaN
  if (out.created_at === undefined || out.created_at === null || out.created_at === '') {
    out.created_at = ceilingISO
  }
  const updated = typeof out.updated_at === 'string' ? Date.parse(out.updated_at) : Number.NaN
  if (out.updated_at === undefined || out.updated_at === null || !Number.isFinite(updated)) {
    out.updated_at = Number.isFinite(created) ? out.created_at : ceilingISO
  }
  if (out.revision === undefined || out.revision === null) out.revision = 1
  return out
}

function categoryNameKey(row: Row): string | null {
  const stated = normalizeCategoryName(nameOf(row))
  return stated ? categoryKey(stated) : null
}

/**
 * Categories are identified by name on screen, so the same name under two ids
 * would split every report. A new file row whose name this device already has
 * is linked to the local row instead of being added as a twin.
 */
function mergeCategories(
  localRows: readonly Row[],
  incomingRows: readonly Row[],
  nowTime: number,
  ceiling: number,
  ceilingISO: string,
  counts: MergeCounts,
  warnings: string[],
  relink: Map<string, { id: string; name: string }>
): Row[] {
  const out = localRows.map((row) => ({ ...row }))
  const indexById = new Map<string, number>()
  const liveByName = new Map<string, { id: string; name: string }>()
  out.forEach((row, index) => {
    const id = idOf(row)
    if (!id) return
    indexById.set(id, index)
    if (isDeleted(row)) return
    const key = categoryNameKey(row)
    if (key) liveByName.set(key, { id, name: normalizeCategoryName(nameOf(row)) })
  })

  let idless = 0
  for (const incoming of incomingRows) {
    const id = idOf(incoming)
    if (!id) {
      idless += 1
      counts.kept.categories += 1
      continue
    }
    // A nameless or overlength category cannot be saved again on the desktop,
    // so taking it here would only make the next export carry a broken row.
    const stated = normalizeCategoryName(nameOf(incoming))
    if (!isDeleted(incoming) && (stated.length === 0 || stated.length > CATEGORY_NAME_MAX)) {
      counts.kept.categories += 1
      warnings.push(
        stated.length === 0
          ? 'A category row had no name, so it was left out.'
          : `A category name is longer than ${CATEGORY_NAME_MAX} characters, so it was left out.`
      )
      continue
    }
    const at = indexById.get(id)
    if (at === undefined) {
      // A tombstone for a row this copy never held is stored too, so the id is
      // taken and a later file cannot bring that row back under the same id.
      const key = stated ? categoryKey(stated) : null
      const match = key ? liveByName.get(key) : undefined
      if (match) {
        relink.set(id, match)
        counts.kept.categories += 1
        warnings.push(
          `Category “${stated}” already exists on this device; the incoming rows were linked to it.`
        )
        continue
      }
      out.push(settleRow(incoming, ceiling, ceilingISO))
      indexById.set(id, out.length - 1)
      if (key) liveByName.set(key, { id, name: stated })
      counts.added.categories += 1
      continue
    }
    const existing = out[at]
    if (!incomingWins(existing, incoming, nowTime, ceiling)) {
      counts.kept.categories += 1
      continue
    }
    // A rename onto another live name would create the duplicate this merge
    // exists to prevent, so the local spelling stays and the file is told why.
    const key = stated ? categoryKey(stated) : null
    const other = key ? liveByName.get(key) : undefined
    if (other && other.id !== id) {
      counts.kept.categories += 1
      warnings.push(
        `Category “${stated}” is already used by another category on this device; the rename was not applied.`
      )
      continue
    }
    // Keep the day the row was made on this device, and keep the name index
    // honest: a renamed or deleted category must stop answering to its old
    // name, or a later row in the same file is relinked to a dead record.
    const kept = typeof existing.created_at === 'string' ? existing.created_at : incoming.created_at
    out[at] = settleRow({ ...incoming, created_at: kept }, ceiling, ceilingISO)
    const previousKey = categoryNameKey(existing)
    if (previousKey && liveByName.get(previousKey)?.id === id) liveByName.delete(previousKey)
    if (!isDeleted(incoming) && key) liveByName.set(key, { id, name: stated })
    if (isDeleted(incoming) && !isDeleted(existing)) counts.removed.categories += 1
    else counts.updated.categories += 1
  }
  if (idless > 0) {
    warnings.push(
      `${idless === 1 ? 'A category row arrived' : `${idless} category rows arrived`} without an id, so ${idless === 1 ? 'it was' : 'they were'} left out.`
    )
  }
  return out
}

/**
 * Merges a backup's tables into the copy already on this device. Both apps
 * write the same tables, so one rule serves both: a row this copy does not
 * have is added, a row whose incoming version is newer is replaced (including
 * a newer tombstone), and an older incoming copy leaves the local row alone.
 * Nothing is ever dropped merely because the file omits it — an export from a
 * computer that has been offline must not erase what the phone recorded.
 *
 * `exportedAt` is when the computer wrote the file. A row stamped later than
 * that is read as the file's own stamp rather than as this device's clock, so
 * two devices opening the same file agree on when that row changed.
 */
export function mergeTables(
  local: ImportTables,
  incoming: ImportTables,
  now: string = new Date().toISOString(),
  exportedAt?: string
): TablesMergeResult {
  const parsedNow = Date.parse(now)
  const nowTime = Number.isFinite(parsedNow) ? parsedNow : Date.now()
  const parsedExport = typeof exportedAt === 'string' ? Date.parse(exportedAt) : Number.NaN
  const ceiling = Number.isFinite(parsedExport) ? Math.min(nowTime, parsedExport) : nowTime
  const ceilingISO = new Date(ceiling).toISOString()
  const counts = emptyMergeCounts()
  const warnings: string[] = []
  const merged = {} as ImportTables
  const relinkCategory = new Map<string, { id: string; name: string }>()

  merged.categories = mergeCategories(
    local.categories,
    incoming.categories,
    nowTime,
    ceiling,
    ceilingISO,
    counts,
    warnings,
    relinkCategory
  )

  const liveCategoryByName = new Map<string, { id: string; name: string }>()
  for (const row of merged.categories) {
    if (isDeleted(row)) continue
    const stated = normalizeCategoryName(nameOf(row))
    const id = idOf(row)
    if (stated && id) liveCategoryByName.set(categoryKey(stated), { id, name: stated })
  }

  const namedCategory = (row: Row): Row => {
    const linkedId = typeof row.category_id === 'string' ? row.category_id : ''
    const linked = linkedId ? relinkCategory.get(linkedId) : undefined
    const stated =
      typeof row.category === 'string' ? normalizeCategoryName(row.category) : ''
    const match = stated ? liveCategoryByName.get(categoryKey(stated)) : undefined
    const target = linked ?? match
    if (!target) return row
    return { ...row, category_id: target.id, category: target.name }
  }

  const namedBillCategory = (row: Row): Row => {
    const stated =
      typeof row.category === 'string' ? normalizeCategoryName(row.category) : ''
    const match = stated ? liveCategoryByName.get(categoryKey(stated)) : undefined
    return match ? { ...row, category: match.name } : row
  }

  for (const table of IMPORT_TABLES) {
    if (table === 'categories') continue
    if (table === 'settings') {
      merged.settings = mergeSettings(
        local.settings,
        incoming.settings,
        nowTime,
        ceiling,
        ceilingISO,
        counts,
        warnings
      )
      continue
    }
    const mapRow =
      table === 'transactions' ? namedCategory : table === 'bills' ? namedBillCategory : undefined
    merged[table] = mergeTable(
      table,
      local[table],
      incoming[table],
      nowTime,
      ceiling,
      ceilingISO,
      counts,
      warnings,
      mapRow
    )
  }

  return { tables: merged, counts, warnings }
}

/** Returns rows merged by id, recording how each incoming row landed. */
function mergeTable(
  table: ImportTable,
  localRows: readonly Row[],
  incomingRows: readonly Row[],
  nowTime: number,
  ceiling: number,
  ceilingISO: string,
  counts: MergeCounts,
  warnings: string[],
  mapRow?: (row: Row) => Row
): Row[] {
  const out = localRows.map((row) => ({ ...row }))
  const indexById = new Map<string, number>()
  out.forEach((row, index) => {
    const id = idOf(row)
    if (id) indexById.set(id, index)
  })

  let idless = 0
  for (const original of incomingRows) {
    const incoming = mapRow ? mapRow(original) : original
    const id = idOf(incoming)
    if (!id) {
      idless += 1
      counts.kept[table] += 1
      continue
    }
    const at = indexById.get(id)
    if (at === undefined) {
      // A tombstone for a row this copy never held is stored too, so the id is
      // taken and a later file cannot bring that row back under the same id.
      out.push(settleRow(incoming, ceiling, ceilingISO))
      indexById.set(id, out.length - 1)
      counts.added[table] += 1
      continue
    }
    const existing = out[at]
    if (!incomingWins(existing, incoming, nowTime, ceiling)) {
      counts.kept[table] += 1
      continue
    }
    // An update keeps the day the row was made on this device; only a new row
    // takes the file's. Otherwise the phone would rewrite history on export.
    const created =
      typeof existing.created_at === 'string' ? existing.created_at : incoming.created_at
    out[at] = settleRow({ ...incoming, created_at: created }, ceiling, ceilingISO)
    if (isDeleted(incoming) && !isDeleted(existing)) counts.removed[table] += 1
    else counts.updated[table] += 1
  }
  if (idless > 0) {
    warnings.push(
      `${idless === 1 ? 'A row' : `${idless} rows`} in the ${table} list had no id, so ${idless === 1 ? 'it was' : 'they were'} left out.`
    )
  }
  return out
}

function settleSetting(row: Row, ceiling: number, ceilingISO: string): Row {
  const out = clampStamps(row, ceiling, ceilingISO)
  if (typeof out.updated_at !== 'string' || out.updated_at === '') out.updated_at = ceilingISO
  return out
}

function mergeSettings(
  localRows: readonly Row[],
  incomingRows: readonly Row[],
  nowTime: number,
  ceiling: number,
  ceilingISO: string,
  counts: MergeCounts,
  warnings: string[]
): Row[] {
  const out = localRows.map((row) => ({ ...row }))
  const indexByKey = new Map<string, number>()
  out.forEach((row, index) => {
    if (typeof row.key === 'string') indexByKey.set(row.key, index)
  })
  for (const incoming of incomingRows) {
    const key = typeof incoming.key === 'string' ? incoming.key : ''
    if (!key) {
      counts.kept.settings += 1
      warnings.push('A setting row had no key, so it was left out.')
      continue
    }
    // The desktop refuses a key this build no longer has; the phone must too,
    // or its export would carry a setting the computer reports on every import.
    if (!Object.hasOwn(DEFAULT_SETTINGS, key)) {
      counts.kept.settings += 1
      warnings.push(`“${key}” is not a setting this build knows, so it was left out.`)
      continue
    }
    if (key === 'currency' && !isCurrencyCode(String(incoming.value ?? ''))) {
      counts.kept.settings += 1
      warnings.push(`“${String(incoming.value ?? '')}” is not a currency code this build knows.`)
      continue
    }
    const at = indexByKey.get(key)
    if (at === undefined) {
      out.push(settleSetting(incoming, ceiling, ceilingISO))
      indexByKey.set(key, out.length - 1)
      counts.added.settings += 1
      continue
    }
    if (!incomingWins(out[at], incoming, nowTime, ceiling)) {
      counts.kept.settings += 1
      continue
    }
    out[at] = settleSetting(incoming, ceiling, ceilingISO)
    counts.updated.settings += 1
  }
  return out
}

/** Total rows changed in one direction, for a one-line summary. */
export function totalMerged(counts: MergeCounts): number {
  let total = 0
  for (const table of IMPORT_TABLES) {
    total += counts.added[table] + counts.updated[table] + counts.removed[table]
  }
  return total
}

/** A sentence a screen can show without knowing the table names. */
export function describeMerge(counts: MergeCounts): string {
  const parts: string[] = []
  const added = IMPORT_TABLES.reduce((sum, table) => sum + counts.added[table], 0)
  const updated = IMPORT_TABLES.reduce((sum, table) => sum + counts.updated[table], 0)
  const removed = IMPORT_TABLES.reduce((sum, table) => sum + counts.removed[table], 0)
  if (added > 0) parts.push(`${added} new`)
  if (updated > 0) parts.push(`${updated} changed`)
  if (removed > 0) parts.push(`${removed} removed`)
  return parts.length > 0 ? parts.join(' · ') : 'Nothing changed'
}

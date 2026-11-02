/**
 * Backup rows are JSON written by SQLite: numbers arrive as numbers, booleans
 * as 0/1, and a hand-edited file may spell either as a string. These readers
 * make one narrow promise each, so the snapshot builders never guess.
 */

export type Row = Record<string, unknown>

export function isLive(row: Row): boolean {
  return row.deleted_at === null || row.deleted_at === undefined
}

export function text(row: Row, key: string, fallback = ''): string {
  const value = row[key]
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : fallback
}

export function nullableText(row: Row, key: string): string | null {
  const value = row[key]
  if (value === null || value === undefined || value === '') return null
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : null
}

export function cents(row: Row, key: string, fallback = 0): number {
  const value = row[key]
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? Math.round(parsed) : fallback
}

export function integer(row: Row, key: string, fallback = 0): number {
  const value = row[key]
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback
}

export function nullableInteger(row: Row, key: string): number | null {
  const value = row[key]
  if (value === null || value === undefined || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null
}

export function flag(row: Row, key: string, fallback = false): boolean {
  const value = row[key]
  if (value === true || value === 1 || value === '1' || value === 'true') return true
  if (value === false || value === 0 || value === '0' || value === 'false') return false
  return fallback
}

/** Settings are stored as strings; a JSON number is still that setting. */
export function settingRecord(rows: readonly Row[]): Record<string, string> {
  const record: Record<string, string> = {}
  for (const row of rows) {
    if (!isLive(row)) continue
    const key = text(row, 'key').trim()
    if (key.length === 0) continue
    const value = row.value
    if (value === null || value === undefined) continue
    record[key] = typeof value === 'string' ? value : String(value)
  }
  return record
}

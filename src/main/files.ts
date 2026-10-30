import { closeSync, fsyncSync, openSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

/**
 * Writes beside the target, flushes it, then renames over the target. An export
 * that fails halfway leaves the previous file intact instead of a truncated one
 * that still looks like a backup. The temporary name keeps the real extension
 * so an interrupted write is recognisable if the rename never happens.
 */
export function writeFileAtomic(path: string, data: string, mode: number): void {
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`)
  let handle: number | null = null
  try {
    handle = openSync(temporary, 'w', mode)
    writeFileSync(handle, data, { encoding: 'utf8' })
    fsyncSync(handle)
    closeSync(handle)
    handle = null
    renameSync(temporary, path)
  } catch (error) {
    if (handle !== null) {
      try {
        closeSync(handle)
      } catch {
        // The descriptor is already gone; nothing left to close.
      }
    }
    try {
      unlinkSync(temporary)
    } catch {
      // The write may have failed before the temporary file existed.
    }
    throw error
  }
}

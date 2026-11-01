import { createHash } from 'node:crypto'
import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, join } from 'node:path'

function digest(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * Writes beside the target, flushes it, then renames over the target. An export
 * that fails halfway leaves the previous file intact instead of a truncated one
 * that still looks like a backup. After the rename the file is read back and
 * hashed, because "the write returned" is not the same as "the bytes are on
 * disk" — a full or failing disk can shorten a file without an error.
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
    if (digest(readFileSync(path, 'utf8')) !== digest(data)) {
      throw new Error(`The file at ${path} did not read back as it was written`)
    }
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

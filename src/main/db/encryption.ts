import Database from 'better-sqlite3-multiple-ciphers'
import { existsSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { LEDGER_CIPHER, type KeyFilePending } from './ledger-key'

/**
 * Turning a ledger from plaintext into ciphertext and back.
 *
 * The recipe here is the one measured in Phase 0, not the one the library's
 * README suggests, and each deviation is load-bearing:
 *
 * - `PRAGMA cipher` is pinned before the key is applied. The fork's default
 *   cipher can change with a release, and a ledger read with the wrong cipher
 *   looks like a corrupt file, not a wrong password.
 * - `rekey`, not `key`, does the encrypting. `PRAGMA key` on a plaintext file
 *   only registers a key: the pages stay plaintext and the call reports success.
 * - The key goes to `db.key()`/`db.rekey()` as a Buffer. Those reach the native
 *   layer directly, so a passphrase never becomes part of a SQL string.
 * - The transition runs in rollback journal mode. While the file is in WAL the
 *   rekeyed pages land in `-wal` and page 1 of the main file keeps its old
 *   bytes, which is exactly how a no-op survives an "is it encrypted?" check.
 * - Success is asserted on a *fresh* connection: header, row count, schema
 *   version and `integrity_check`. `rekey`'s own return value has lied twice.
 * - `locking_mode = EXCLUSIVE` holds the file for the whole sequence, so a
 *   second connection gets `SQLITE_BUSY` instead of racing the rewrite.
 *
 * A pre-copy is taken before any of it and the failure path restores it.
 */

const PLAIN_HEADER = 'SQLite format 3\0'

export class LedgerStateError extends Error {
  readonly code = 'LEDGER_STATE'
  constructor(detail: string) {
    super(detail)
    this.name = 'LedgerStateError'
  }
}

export class TransitionFailedError extends Error {
  readonly code = 'TRANSITION_FAILED'
  constructor(
    readonly direction: 'encrypt' | 'decrypt',
    detail: string,
    /** Where the ledger lives after the rollback — the copy is renamed onto it. */
    readonly restoredTo: string
  ) {
    super(
      `Turning encryption ${direction === 'encrypt' ? 'on' : 'off'} did not complete: ${detail}. ` +
        `The ledger was rolled back from the safety copy taken before the change and reads ` +
        `again from ${restoredTo}.`
    )
    this.name = 'TransitionFailedError'
  }
}

/**
 * Reading the first 16 bytes is the only way to learn a ledger's state before
 * opening it: a keyed connection refuses a plaintext file and an unkeyed one
 * refuses a keyed file, both with `SQLITE_NOTADB`.
 */
export function ledgerLooksEncrypted(file: string): boolean {
  if (!existsSync(file)) return false
  let head: Buffer
  try {
    head = readFileSync(file).subarray(0, 16)
  } catch {
    return false
  }
  return head.length === 16 && head.toString('latin1') !== PLAIN_HEADER
}

/**
 * The cipher and key, applied before anything else reads the file. Every second
 * connection in the app — the health probe, a storage-move inspection, a
 * temporary copy — has to do the same or it sees a corrupt database.
 */
export function applyKey(db: Database.Database, dataKey: Buffer): void {
  db.pragma(`cipher('${LEDGER_CIPHER}')`)
  db.key(dataKey)
}

export function openLedger(file: string, dataKey: Buffer | null): Database.Database {
  const db = new Database(file)
  if (dataKey) applyKey(db, dataKey)
  return db
}

export interface TransitionOutcome {
  rows: number
  safetyCopy: string
  journalMode: string
}

export interface TransitionOptions {
  dataDirectory: string
  ledgerFile: string
  dataKey: Buffer
  /** Records the in-flight direction in the key file before pages move. */
  onPending?: (pending: KeyFilePending) => void
  onSettled?: () => void
}

export function encryptLedger(options: TransitionOptions): TransitionOutcome {
  return transition(options, 'encrypt')
}

export function decryptLedger(options: TransitionOptions): TransitionOutcome {
  return transition(options, 'decrypt')
}

function transition(options: TransitionOptions, direction: 'encrypt' | 'decrypt'): TransitionOutcome {
  const { ledgerFile, dataKey, dataDirectory } = options
  const encryptedAtStart = ledgerLooksEncrypted(ledgerFile)
  if (direction === 'encrypt' && encryptedAtStart) {
    throw new LedgerStateError('This ledger is already encrypted.')
  }
  if (direction === 'decrypt' && !encryptedAtStart) {
    throw new LedgerStateError('This ledger is not encrypted.')
  }

  // Opened keyed or unkeyed to match the state that exists *now*. A failure
  // here means no page has moved yet, so it is a state problem, not a botched
  // transition — and the caller must be able to tell the two apart.
  const { journalMode, expected } = readLedgerState(ledgerFile, dataKey, encryptedAtStart)

  const safetyCopy = takeSafetyCopy(ledgerFile, dataDirectory, direction, dataKey, expected)
  try {
    options.onPending?.({ direction, copy: safetyCopy })
  } catch (error) {
    // The marker is what turns encryption on. If it cannot be written the
    // change must not start, so the ledger keeps its original bytes and the
    // copy is discarded rather than left as a stray duplicate of the ledger.
    rmSync(safetyCopy, { force: true })
    throw new LedgerStateError(
      `nothing was recorded, so nothing was changed: ${error instanceof Error ? error.message : String(error)}`
    )
  }

  let db: Database.Database | null = null
  try {
    db = openLedger(ledgerFile, encryptedAtStart ? dataKey : null)
    // The pages being overwritten hold a whole financial history in the state
    // the user is leaving; a freed page must not keep them.
    db.pragma('secure_delete = ON')
    db.pragma('locking_mode = EXCLUSIVE')
    db.pragma('journal_mode = delete')
    db.pragma(`cipher('${LEDGER_CIPHER}')`)
    db.rekey(direction === 'encrypt' ? dataKey : Buffer.alloc(0))
    db.close()
    db = null

    assertTransition(ledgerFile, direction, dataKey, expected)
    restoreJournalMode(ledgerFile, direction === 'encrypt' ? dataKey : null, journalMode)
    options.onSettled?.()
    return { rows: expected.rows, safetyCopy, journalMode }
  } catch (error) {
    try {
      db?.close()
    } catch {
      // The handle may already be gone; the restore is what matters.
    }
    restore(ledgerFile, safetyCopy)
    throw new TransitionFailedError(
      direction,
      error instanceof Error ? error.message : String(error),
      ledgerFile
    )
  }
}

/**
 * The pre-copy is taken on a connection in the ledger's current state, so the
 * way out is real: a plaintext ledger yields a plaintext copy, an encrypted one
 * a copy only the key can open. The copy is then opened and counted before
 * anything trusts it.
 */
function takeSafetyCopy(
  ledgerFile: string,
  dataDirectory: string,
  direction: 'encrypt' | 'decrypt',
  dataKey: Buffer,
  expected: { rows: number; schemaVersion: number }
): string {
  const encrypted = ledgerLooksEncrypted(ledgerFile)
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
  const file = join(dataDirectory, `pre-${direction}-${stamp}.db`)
  const db = openLedger(ledgerFile, encrypted ? dataKey : null)
  try {
    // VACUUM INTO works through the codec, unlike SQLite's backup API, which
    // refuses a source and target that disagree about encryption.
    db.prepare('VACUUM INTO ?').run(file)
  } catch (error) {
    rmSync(file, { force: true })
    throw new LedgerStateError(
      `could not take a safety copy before the change: ${error instanceof Error ? error.message : String(error)}`
    )
  } finally {
    db.close()
  }
  const probe = openLedger(file, encrypted ? dataKey : null)
  try {
    if (rowCount(probe) !== expected.rows) {
      throw new LedgerStateError('the safety copy holds a different number of transactions')
    }
    if (integrity(probe) !== 'ok') throw new LedgerStateError('the safety copy failed its integrity check')
  } finally {
    probe.close()
  }
  return file
}

function restore(ledgerFile: string, safetyCopy: string): void {
  for (const sidecar of ['-wal', '-shm']) rmSync(`${ledgerFile}${sidecar}`, { force: true })
  renameSync(safetyCopy, ledgerFile)
}

function rowCount(db: Database.Database): number {
  const row = db.prepare('SELECT count(*) AS c FROM transactions').get() as { c: number }
  return row.c
}

function readLedgerState(
  ledgerFile: string,
  dataKey: Buffer,
  keyed: boolean
): { journalMode: string; expected: { rows: number; schemaVersion: number } } {
  try {
    const db = openLedger(ledgerFile, keyed ? dataKey : null)
    try {
      return {
        journalMode: db.pragma('journal_mode', { simple: true }) as string,
        expected: {
          rows: rowCount(db),
          schemaVersion: db.pragma('user_version', { simple: true }) as number
        }
      }
    } finally {
      db.close()
    }
  } catch (error) {
    throw new LedgerStateError(
      `the ledger did not open ${keyed ? 'with the key supplied' : 'as plaintext'}: ` +
        (error instanceof Error ? error.message : String(error))
    )
  }
}

function integrity(db: Database.Database): string {
  return db.pragma('integrity_check', { simple: true }) as string
}

/** The assertion that makes a silent no-op impossible. */
function assertTransition(
  ledgerFile: string,
  direction: 'encrypt' | 'decrypt',
  dataKey: Buffer,
  expected: { rows: number; schemaVersion: number }
): void {
  const encryptedNow = ledgerLooksEncrypted(ledgerFile)
  if (direction === 'encrypt' && !encryptedNow) {
    throw new LedgerStateError('the file header is still plaintext after rekey')
  }
  if (direction === 'decrypt' && encryptedNow) {
    throw new LedgerStateError('the file header is still ciphertext after rekey')
  }
  const probe = openLedger(ledgerFile, direction === 'encrypt' ? dataKey : null)
  try {
    const rows = rowCount(probe)
    const version = probe.pragma('user_version', { simple: true }) as number
    const check = integrity(probe)
    if (rows !== expected.rows) {
      throw new LedgerStateError(`the ledger reads ${rows} transactions, expected ${expected.rows}`)
    }
    if (version !== expected.schemaVersion) {
      throw new LedgerStateError(`the schema version moved from ${expected.schemaVersion} to ${version}`)
    }
    if (check !== 'ok') throw new LedgerStateError(`integrity_check reported ${check}`)
  } finally {
    probe.close()
  }
}

/** Back to the mode the folder is configured to run in, once the pages are settled. */
function restoreJournalMode(ledgerFile: string, dataKey: Buffer | null, journalMode: string): void {
  const db = openLedger(ledgerFile, dataKey)
  try {
    db.pragma('locking_mode = NORMAL')
    const now = db.pragma(`journal_mode = ${journalMode}`, { simple: true }) as string
    if (now !== journalMode) {
      throw new LedgerStateError(`the ledger is in ${now} mode, expected ${journalMode}`)
    }
  } finally {
    db.close()
  }
}

/**
 * What a launch finds when the previous transition never reported back.
 *
 * The key file records which direction was intended; the header records what
 * actually happened to the pages. Those two can disagree, and the header wins —
 * the marker is a promise, the file is a fact.
 */
export type PendingTransition = KeyFilePending

export function isTransitionSettled(
  pending: PendingTransition | undefined,
  ledgerFile: string,
  dataKey: Buffer
): 'none' | 'completed' | 'unfinished' {
  if (!pending) return 'none'
  const encryptedNow = ledgerLooksEncrypted(ledgerFile)
  const landed = pending.direction === 'encrypt' ? encryptedNow : !encryptedNow
  if (!landed) return 'unfinished'
  // The rewrite finished and only the flag failed to clear. Prove it opens
  // before trusting that, because "looks encrypted" is a 16-byte answer.
  if (!readable(ledgerFile, encryptedNow ? dataKey : null)) return 'unfinished'
  if (existsSync(pending.copy)) rmSync(pending.copy, { force: true })
  return 'completed'
}

/**
 * A ledger that opens, counts and passes `integrity_check` on a fresh
 * connection. This is the test the launch uses to decide whether a half-finished
 * transition left the file usable or wrecked.
 */
function readable(file: string, dataKey: Buffer | null): boolean {
  let db: Database.Database | null = null
  try {
    db = openLedger(file, dataKey)
    rowCount(db)
    return integrity(db) === 'ok'
  } catch {
    return false
  } finally {
    try {
      db?.close()
    } catch {
      // Already gone; the answer was decided by the read.
    }
  }
}

export type Reconciled =
  | { outcome: 'none' }
  /**
   * The transition finished cleanly, never started, or was put back from its own
   * safety copy. `wrecked` names the bytes that were replaced, kept aside because
   * a destroyed file cannot be argued about later.
   */
  | {
      outcome: 'settled'
      direction: 'encrypt' | 'decrypt'
      restored: boolean
      wrecked?: string
    }
  | { outcome: 'unrecoverable'; direction: 'encrypt' | 'decrypt'; copy: string }

/**
 * Deciding what a crashed transition left behind, before anything opens the
 * ledger. Three facts are available: the promised direction, the file header and
 * the safety copy. The copy is only trusted once it reads, and the ledger is only
 * replaced once the copy is better than it.
 */
export function reconcilePending(
  pending: PendingTransition | undefined,
  options: { ledgerFile: string; dataKey: Buffer }
): Reconciled {
  const { ledgerFile, dataKey } = options
  if (!pending) return { outcome: 'none' }
  const { direction, copy } = pending
  // The state the ledger was in *before* the change was promised.
  const beforeKey = direction === 'encrypt' ? null : dataKey

  if (isTransitionSettled(pending, ledgerFile, dataKey) === 'completed') {
    return { outcome: 'settled', direction, restored: false }
  }
  if (readable(ledgerFile, beforeKey)) {
    // Nothing moved. The copy is a duplicate of the ledger as it stands, so it
    // goes rather than sitting beside it as a second readable ledger.
    if (existsSync(copy)) rmSync(copy, { force: true })
    return { outcome: 'settled', direction, restored: false }
  }
  // Either the rewrite stopped mid-file or the copy is itself damaged. Only a
  // copy that reads can be used; a wrecked ledger must not be replaced by a
  // wrecked copy, because that destroys the evidence of what happened.
  const copyWasEncrypted = direction === 'decrypt'
  if (existsSync(copy) && readable(copy, copyWasEncrypted ? dataKey : null)) {
    const wrecked = `${ledgerFile}.wrecked`
    rmSync(wrecked, { force: true })
    for (const sidecar of ['-wal', '-shm']) rmSync(`${ledgerFile}${sidecar}`, { force: true })
    try {
      renameSync(ledgerFile, wrecked)
    } catch {
      // The half-written file may already be gone. The copy is what has to land,
      // and the read below is the proof that it did.
    }
    renameSync(copy, ledgerFile)
    if (!readable(ledgerFile, beforeKey)) {
      throw new LedgerStateError(`putting the safety copy back over ${wrecked} did not make the ledger readable`)
    }
    return { outcome: 'settled', direction, restored: true, wrecked }
  }
  return { outcome: 'unrecoverable', direction, copy }
}

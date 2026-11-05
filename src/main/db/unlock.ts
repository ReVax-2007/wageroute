/**
 * Deciding how an encrypted ledger gets its key back at launch.
 *
 * Nothing here keeps the ledger open and nothing here touches Electron: the
 * keychain opener and the passphrase prompt are handed in, so the decision is
 * testable on its own and the window code stays out of it. The order is
 * deliberate.
 *
 * - A device wrap is tried silently first. On a Mac whose login keychain is
 *   unlocked that is the whole interaction: the user opens the app and it opens.
 * - Only when the device cannot (or did not) release the key does the app ask for
 *   a passphrase. Asking first would throw away the one custody that needs
 *   nothing typed.
 * - A wrong passphrase is retried by whoever is prompting, not by a counter here.
 *   A limit in this layer would be theatre: the wraps are offline, so anyone with
 *   the folder and the key file can guess at their own pace. The app must not
 *   imply otherwise — that is why the settings screen names the passphrase as the
 *   thing standing between a copied folder and a readable ledger.
 */
import {
  NoCustodyError,
  WrongPassphraseError,
  keyFilePath,
  openWithPassphrase,
  readKeyFile,
  writeKeyFile,
  type DeviceWrap,
  type LedgerKeyFile
} from './ledger-key'
import { ledgerLooksEncrypted, reconcilePending } from './encryption'

export class LedgerLockedError extends Error {
  readonly code = 'LEDGER_LOCKED'
  constructor(detail: string) {
    super(detail)
    this.name = 'LedgerLockedError'
  }
}

/**
 * A ledger whose first bytes are not a plain SQLite header, with no key file to
 * ask for the key. From outside the file these two readings cannot be told
 * apart — an encrypted ledger and a plaintext one whose header was wrecked both
 * fail the same way — so the message names both and touches neither.
 */
export class MissingKeyFileError extends Error {
  readonly code = 'LEDGER_KEY_FILE_MISSING'
  constructor(
    readonly ledgerFile: string,
    readonly keyFile: string
  ) {
    super(
      `The database at ${ledgerFile} does not read as a plain SQLite file, and the key file that ` +
        `would say how to open it is missing: ${keyFile}.`
    )
    this.name = 'MissingKeyFileError'
  }
}

export interface CustodyAttempts {
  /** The OS keychain. Missing or unavailable means this machine holds no device custody. */
  device?: { available: () => boolean; open: (wrap: DeviceWrap) => Buffer }
  /**
   * Collect one passphrase. `wrong` says this is a retry; resolving null means
   * the user closed the prompt instead of typing.
   */
  askForPassphrase?: (state: { wrong: boolean }) => Promise<string | null>
}

export interface Unlocked {
  dataKey: Buffer
  via: 'device' | 'passphrase'
  /** How many passphrases it took, for the log. The passphrase and key never reach it. */
  attempts: number
}

/** Null means there is no key file: the ledger is plaintext and opens as it is. */
export async function unlockLedger(
  dataDirectory: string,
  attempts: CustodyAttempts
): Promise<Unlocked | null> {
  const keyFile = readKeyFile(dataDirectory)
  if (!keyFile) return null
  return unlockFrom(keyFile, attempts)
}

async function unlockFrom(keyFile: LedgerKeyFile, attempts: CustodyAttempts): Promise<Unlocked> {
  const device = attemptDevice(keyFile, attempts)
  if (device.dataKey) return { dataKey: device.dataKey, via: 'device', attempts: 0 }

  if (!keyFile.passphrase) throw new NoCustodyError(device.failure)

  if (!attempts.askForPassphrase) {
    throw new LedgerLockedError(
      'This ledger is opened by a passphrase and there is no window here to ask for one.'
    )
  }

  let wrong = false
  for (let tries = 1; ; tries += 1) {
    const typed = await attempts.askForPassphrase({ wrong })
    if (typed === null) {
      throw new LedgerLockedError('WageRoute stayed closed because the ledger stayed locked.')
    }
    try {
      return { dataKey: openWithPassphrase(keyFile.passphrase, typed), via: 'passphrase', attempts: tries }
    } catch (error) {
      if (!(error instanceof WrongPassphraseError)) throw error
      wrong = true
    }
  }
}

/**
 * What the launch does with the key it just got back.
 *
 * `plaintext` covers two cases that must be handled the same way: no key file
 * over a file that reads as plain SQLite, and a key file sitting over a ledger
 * whose pages turned out to be plaintext — which is what a crashed decrypt
 * leaves, and the only readable ledger there is. The second case is why the
 * header, not the key file, decides how the file gets opened. No key file over a
 * ledger that does *not* read as plain SQLite is the one combination with no
 * honest opening, and it is refused rather than handed to the driver.
 *
 * `unrecoverable` is a value rather than an exception because the launch has a
 * real choice to make with it: show the user the copy, and do not touch either
 * file. Nothing here decides that.
 */
export type LedgerOpening =
  | { state: 'plaintext' }
  | {
      state: 'keyed'
      dataKey: Buffer
      via: 'device' | 'passphrase'
      /** Passphrases it took, for the log. Never the passphrase or the key. */
      attempts: number
      /** The ledger came back from the transition's safety copy. */
      restored: boolean
      /** Where the wrecked file was moved to make that happen. */
      wrecked?: string
    }
  | { state: 'unrecoverable'; direction: 'encrypt' | 'decrypt'; copy: string }

export async function openLedgerKey(
  dataDirectory: string,
  ledgerFile: string,
  attempts: CustodyAttempts
): Promise<LedgerOpening> {
  const keyFile = readKeyFile(dataDirectory)
  if (!keyFile) {
    // Handing this to the driver instead would produce 'file is not a database' —
    // the same words a damaged plaintext file gets, for the one failure a user
    // causes by moving or restoring the ledger without the small file next to it.
    if (ledgerLooksEncrypted(ledgerFile)) {
      throw new MissingKeyFileError(ledgerFile, keyFilePath(dataDirectory))
    }
    return { state: 'plaintext' }
  }

  const unlocked = await unlockFrom(keyFile, attempts)
  const reconciled = reconcilePending(keyFile.pending, { ledgerFile, dataKey: unlocked.dataKey })
  if (reconciled.outcome === 'unrecoverable') {
    // The promise stays on record: it is the only thing that explains the copy.
    return { state: 'unrecoverable', direction: reconciled.direction, copy: reconciled.copy }
  }
  if (keyFile.pending) clearPending(dataDirectory)
  if (!ledgerLooksEncrypted(ledgerFile)) return { state: 'plaintext' }
  // 'none' means there was never a transition to close out, so nothing was restored.
  const settled = reconciled.outcome === 'settled' ? reconciled : null
  return {
    state: 'keyed',
    dataKey: unlocked.dataKey,
    via: unlocked.via,
    attempts: unlocked.attempts,
    restored: settled?.restored ?? false,
    wrecked: settled?.wrecked
  }
}

/**
 * Closing out a transition that finished. The file is re-read rather than
 * rewritten from the copy in hand: between the two, the user may have added a
 * custody method, and that must not be undone by a launch cleanup.
 */
function clearPending(dataDirectory: string): void {
  const fresh = readKeyFile(dataDirectory)
  if (!fresh?.pending) return
  const { pending, ...settled } = fresh
  writeKeyFile(dataDirectory, settled)
}

/**
 * One keychain attempt, and the reason it did not work. Keeping the failure
 * alongside the key means a device that cannot help still lets the passphrase be
 * tried, and still explains the ledger when there is no passphrase wrap either.
 */
type DeviceAttempt = { dataKey: Buffer } | { dataKey: null; failure: string }

function attemptDevice(keyFile: LedgerKeyFile, attempts: CustodyAttempts): DeviceAttempt {
  if (!keyFile.device) {
    return {
      dataKey: null,
      failure: attempts.device?.available()
        ? 'This ledger was never given a copy of its key that this computer can reach.'
        : 'This ledger is opened by a passphrase alone.'
    }
  }
  if (!attempts.device?.available()) {
    return {
      dataKey: null,
      failure: 'This system offers WageRoute no keychain, and this ledger keeps its key in one.'
    }
  }
  try {
    return { dataKey: attempts.device.open(keyFile.device) }
  } catch (error) {
    return {
      dataKey: null,
      failure:
        `The keychain on this computer would not release the ledger's key: ` +
        (error instanceof Error ? error.message : String(error))
    }
  }
}

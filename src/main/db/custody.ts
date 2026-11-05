import { rmSync } from 'node:fs'
import { passphraseProblem, type CustodyMethod, type EncryptionStatus, type KeyCustodyChange } from '@shared/encryption'
import {
  KEY_FILE,
  LEDGER_CIPHER,
  WrongPassphraseError,
  generateDataKey,
  openWithPassphrase,
  readKeyFile,
  removeKeyFile,
  sealWithPassphrase,
  sameKey,
  writeKeyFile,
  type DeviceWrap,
  type KeyFilePending,
  type LedgerKeyFile,
  type PassphraseWrap
} from './ledger-key'
import { decryptLedger, encryptLedger, ledgerLooksEncrypted, type TransitionOutcome } from './encryption'

/**
 * The encryption operations the Settings screen calls.
 *
 * `encryption.ts` turns pages over and `ledger-key.ts` wraps a key; this module
 * is the only place that does both, and it is the only place that decides what a
 * user asking to "encrypt my ledger" actually gets. It stays free of Electron by
 * having the keychain handed in, so the whole decision — including the order the
 * files are written in — is testable without a display.
 *
 * Three rules hold the design up:
 *
 * - **Nothing becomes ciphertext until the custody is proved to open it back.**
 *   A wrap that cannot release its key is not an inconvenience, it is a destroyed
 *   ledger, so every new wrap is opened against the key before a page moves.
 * - **A failed encrypt leaves no key file.** The transition rolls the pages back,
 *   and a passphrase wrap over a plaintext ledger would make the next launch ask
 *   for a phrase that protects nothing.
 * - **A failed decrypt leaves the key file alone.** The rolled-back ledger is
 *   still ciphertext; that marker is the only way into it.
 */

export class CustodyError extends Error {
  readonly code = 'CUSTODY'
  /** A refusal that changed nothing, in the user's terms. */
  constructor(detail: string) {
    super(detail)
    this.name = 'CustodyError'
  }
}

/** `safeStorage`, injected so nothing here imports Electron. */
export interface DeviceKeychain {
  available: () => boolean
  seal: (dataKey: Buffer) => DeviceWrap
  open: (wrap: DeviceWrap) => Buffer
}

interface Folder {
  dataDirectory: string
  ledgerFile: string
}

const NO_KEYCHAIN = 'This system offers WageRoute no keychain to hold a key. Choose a passphrase instead.'

/**
 * What the folder reports, from the two sources that disagree by design: the
 * header says what the pages are, the marker says who can open them. `cipher`
 * comes from the marker because that is the only place it is recorded, and
 * reading it wrong is what turns a healthy ledger into an unreadable one.
 */
export function readEncryptionStatus(
  options: Folder & { deviceAvailable: boolean }
): EncryptionStatus {
  const encrypted = ledgerLooksEncrypted(options.ledgerFile)
  const marker = readKeyFile(options.dataDirectory)
  return {
    encrypted,
    cipher: marker?.cipher ?? null,
    device: Boolean(marker?.device),
    passphrase: Boolean(marker?.passphrase),
    pending: marker?.pending?.direction ?? null,
    staleKeyFile: encrypted === false && marker !== null,
    deviceAvailable: options.deviceAvailable
  }
}

/** Turn a plaintext ledger into ciphertext under a key the user has just chosen. */
export function enableEncryption(
  options: Folder & {
    custody: CustodyMethod
    passphrase?: string
    keychain?: DeviceKeychain
  }
): TransitionOutcome {
  const existing = readKeyFile(options.dataDirectory)
  // An in-flight change blocks everything, including the "it is already
  // encrypted" answer — a marker that still promises a transition describes the
  // file better than the header does, and the launch has to reconcile it first.
  if (existing?.pending) throw new CustodyError(interrupted(existing.pending))
  if (ledgerLooksEncrypted(options.ledgerFile)) {
    throw new CustodyError('This ledger is already encrypted.')
  }

  const dataKey = generateDataKey()
  const wraps = sealCustody(dataKey, options.custody, options.passphrase ?? '', options.keychain)
  proveReleasable(wraps, dataKey, options.passphrase ?? '', options.keychain)

  const file: LedgerKeyFile = { version: 1, cipher: LEDGER_CIPHER, ...wraps, createdAt: new Date().toISOString() }
  writeKeyFile(options.dataDirectory, file)

  try {
    const outcome = encryptLedger({
      dataDirectory: options.dataDirectory,
      ledgerFile: options.ledgerFile,
      dataKey,
      onPending: (pending) => recordPending(options.dataDirectory, pending),
      onSettled: () => clearPending(options.dataDirectory)
    })
    // The copy was taken before the change, so for an encrypt it is the whole
    // ledger in readable plaintext sitting beside the file that just became
    // ciphertext. It has done its job the moment the change verified.
    rmSync(outcome.safetyCopy, { force: true })
    return outcome
  } catch (error) {
    removeKeyFile(options.dataDirectory)
    throw error
  }
}

/** Hand the ledger back to the filesystem, plaintext, with no custody left to lose. */
export function disableEncryption(options: Folder & { dataKey: Buffer | null }): TransitionOutcome {
  if (!ledgerLooksEncrypted(options.ledgerFile)) {
    throw new CustodyError('This ledger is not encrypted, so there is nothing to turn off.')
  }
  if (!options.dataKey) {
    throw new CustodyError(
      'This ledger is encrypted, but WageRoute did not open it with a key, so it cannot take the key back out.'
    )
  }
  const marker = readKeyFile(options.dataDirectory)
  if (!marker) {
    // Unreachable through a normal launch — an encrypted ledger with no marker
    // is refused at boot. It is refused here too rather than rewritten, because
    // a crash after this point would leave pages no record explains.
    throw new CustodyError(
      `This ledger's pages are ciphertext but ${KEY_FILE} is gone, so WageRoute will not rewrite a ledger it cannot hand a key back to.`
    )
  }
  if (marker.pending) throw new CustodyError(interrupted(marker.pending))

  const outcome = decryptLedger({
    dataDirectory: options.dataDirectory,
    ledgerFile: options.ledgerFile,
    dataKey: options.dataKey,
    onPending: (pending) => recordPending(options.dataDirectory, pending),
    // The marker goes as the last step of a verified decrypt: the file it opens
    // is now readable without it, and a wrap of a key nothing uses is a thing to
    // forget rather than a thing to keep.
    onSettled: () => removeKeyFile(options.dataDirectory)
  })
  // An encrypted copy whose marker has just been deleted is unreadable by
  // construction, including by the person who asked for encryption off.
  rmSync(outcome.safetyCopy, { force: true })
  return outcome
}

/**
 * Change who holds the key. No page is rewritten: the data key is the same
 * 32 bytes throughout, which is the whole reason custody can be added, removed
 * or replaced as often as the user likes.
 */
export function changeKeyCustody(
  options: Folder & {
    dataKey: Buffer | null
    change: KeyCustodyChange
    keychain?: DeviceKeychain
  }
): void {
  if (!ledgerLooksEncrypted(options.ledgerFile)) {
    throw new CustodyError('This ledger is not encrypted, so there is no key to re-wrap.')
  }
  const dataKey = options.dataKey
  if (!dataKey) {
    throw new CustodyError('WageRoute did not open this ledger with a key, so it cannot change who holds one.')
  }
  const file = requireKeyFile(options.dataDirectory)
  if (file.pending) throw new CustodyError(interrupted(file.pending))

  const next = applyChange(file, dataKey, options.change, options.keychain)
  // What `applyChange` newly sealed is proved against the key before the file is
  // replaced; a change that would leave the ledger shut is no change at all.
  proveReleasable(newWraps(file, next), dataKey, passphraseHandedTo(options.change), options.keychain)
  writeKeyFile(options.dataDirectory, next)

  const reread = requireKeyFile(options.dataDirectory)
  if (
    Boolean(reread.device) !== Boolean(next.device) ||
    Boolean(reread.passphrase) !== Boolean(next.passphrase)
  ) {
    throw new CustodyError('The key file did not keep the change — it is still the way it was.')
  }
}

/** Only the wraps that did not exist a moment ago can be proved with what is in hand. */
function newWraps(before: LedgerKeyFile, after: LedgerKeyFile) {
  return {
    device: after.device && before.device !== after.device ? after.device : undefined,
    passphrase: after.passphrase && before.passphrase !== after.passphrase ? after.passphrase : undefined
  }
}

function passphraseHandedTo(change: KeyCustodyChange): string {
  if (change.action === 'add-passphrase') return change.passphrase
  if (change.action === 'change-passphrase') return change.next
  return ''
}

function applyChange(
  file: LedgerKeyFile,
  dataKey: Buffer,
  change: KeyCustodyChange,
  keychain?: DeviceKeychain
): LedgerKeyFile {
  switch (change.action) {
    case 'add-device': {
      if (file.device) throw new CustodyError('This computer already holds a copy of the key.')
      if (!keychain?.available()) throw new CustodyError(NO_KEYCHAIN)
      return { ...file, device: keychain.seal(dataKey) }
    }
    case 'remove-device': {
      if (!file.device) throw new CustodyError('This computer holds no copy of the key to remove.')
      if (!file.passphrase) {
        throw new CustodyError(
          'This computer is the only way this ledger opens. Add a passphrase before taking it away.'
        )
      }
      const { device, ...rest } = file
      return rest
    }
    case 'add-passphrase': {
      if (file.passphrase) {
        throw new CustodyError('This ledger already has a passphrase. Change it instead of adding a second.')
      }
      return { ...file, passphrase: sealPassphrase(dataKey, change.passphrase) }
    }
    case 'remove-passphrase': {
      if (!file.passphrase) throw new CustodyError('This ledger has no passphrase to remove.')
      if (!file.device) {
        throw new CustodyError(
          'The passphrase is the only way this ledger opens. Add this computer first, or turn encryption off.'
        )
      }
      const { passphrase, ...rest } = file
      return rest
    }
    case 'change-passphrase': {
      if (!file.passphrase) {
        throw new CustodyError('This ledger has no passphrase to change. Add one instead.')
      }
      // The old phrase is checked, not trusted: this is the screen that can
      // overwrite the only way in.
      try {
        if (!sameKey(openWithPassphrase(file.passphrase, change.current), dataKey)) {
          throw new WrongPassphraseError()
        }
      } catch (error) {
        if (error instanceof WrongPassphraseError) {
          throw new CustodyError('That passphrase does not open this ledger, so nothing was changed.')
        }
        throw error
      }
      return { ...file, passphrase: sealPassphrase(dataKey, change.next) }
    }
  }
  return assertNoChange(change)
}

function assertNoChange(change: never): never {
  throw new CustodyError(`Nothing knows how to hold a key called "${String(change)}".`)
}

function sealPassphrase(dataKey: Buffer, passphrase: string): PassphraseWrap {
  const problem = passphraseProblem(passphrase)
  if (problem) throw new CustodyError(problem)
  return sealWithPassphrase(dataKey, passphrase)
}

function sealCustody(
  dataKey: Buffer,
  custody: CustodyMethod,
  passphrase: string,
  keychain?: DeviceKeychain
): { device?: DeviceWrap; passphrase?: PassphraseWrap } {
  const wraps: { device?: DeviceWrap; passphrase?: PassphraseWrap } = {}
  if (custody === 'device' || custody === 'both') {
    if (!keychain?.available()) throw new CustodyError(NO_KEYCHAIN)
    wraps.device = keychain.seal(dataKey)
  }
  if (custody === 'passphrase' || custody === 'both') {
    wraps.passphrase = sealPassphrase(dataKey, passphrase)
  }
  // A custody string from the wire that is none of the three would otherwise
  // write a marker with no way in, and the ledger would become unreadable.
  if (!wraps.device && !wraps.passphrase) {
    throw new CustodyError(`"${String(custody)}" is not a way to hold a key.`)
  }
  return wraps
}

/**
 * Open what was just sealed and compare the answer to the key. This is the step
 * that makes "we wrote a wrap" mean "this ledger can be read again".
 */
function proveReleasable(
  wraps: { device?: DeviceWrap; passphrase?: PassphraseWrap },
  dataKey: Buffer,
  passphrase: string,
  keychain?: DeviceKeychain
): void {
  if (wraps.device) {
    let opened: Buffer | null = null
    try {
      opened = keychain ? keychain.open(wraps.device) : null
    } catch {
      opened = null
    }
    if (!opened || !sameKey(opened, dataKey)) {
      throw new CustodyError(
        'This computer’s keychain would not hand back the key it was just given, so nothing was changed.'
      )
    }
  }
  if (wraps.passphrase) {
    try {
      if (!sameKey(openWithPassphrase(wraps.passphrase, passphrase), dataKey)) {
        throw new WrongPassphraseError()
      }
    } catch (error) {
      if (error instanceof WrongPassphraseError) {
        throw new CustodyError('That passphrase does not open the key it just wrapped, so nothing was changed.')
      }
      throw error
    }
  }
}

function interrupted(pending: KeyFilePending): string {
  return (
    `A change to encryption (${pending.direction === 'encrypt' ? 'turning it on' : 'turning it off'}) ` +
    'started and never reported back. Restart WageRoute — it checks the ledger against that record ' +
    'before anything else is changed, and puts the safety copy back if it has to.'
  )
}

function requireKeyFile(dataDirectory: string): LedgerKeyFile {
  const file = readKeyFile(dataDirectory)
  if (!file) {
    throw new CustodyError(`There is no ${KEY_FILE} beside the ledger to change.`)
  }
  return file
}

/**
 * Merging the promise into the marker rather than writing a fresh one: between
 * the two writes the user may have added a custody method, and a transition must
 * not be able to undo that.
 */
function recordPending(dataDirectory: string, pending: KeyFilePending): void {
  const fresh = requireKeyFile(dataDirectory)
  writeKeyFile(dataDirectory, { ...fresh, pending })
}

function clearPending(dataDirectory: string): void {
  const fresh = readKeyFile(dataDirectory)
  if (!fresh?.pending) return
  const { pending, ...settled } = fresh
  writeKeyFile(dataDirectory, settled)
}

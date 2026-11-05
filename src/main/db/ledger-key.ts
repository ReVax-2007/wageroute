import { randomBytes, scryptSync, createCipheriv, createDecipheriv, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomic } from '../files'

/**
 * Key custody for an encrypted ledger.
 *
 * The ledger is encrypted with a random 32-byte data key handed to SQLite. That
 * key is never stored in the clear: it is *wrapped*, once per custody method the
 * user chooses, and the wraps sit in a marker file beside the ledger. Splitting
 * it this way is what makes the options cheap to change — rotating a passphrase
 * or adding or removing the device wrap re-wraps 32 bytes, it does not rewrite
 * the ledger.
 *
 * Two wraps exist: `device`, sealed by the OS keychain through Electron's
 * `safeStorage`, and `passphrase`, sealed by a key derived from the user's
 * passphrase with scrypt. Either one unlocks. A user can have one, the other,
 * or both, and can move between them at any time.
 */

export const KEY_FILE = 'ledger.key.json'
/** The cipher is recorded, never assumed: opening a file with the wrong cipher reads as corruption. */
export const LEDGER_CIPHER = 'chacha20'
/**
 * The data key is the exact 32 bytes this module derives and hands to the driver,
 * which is the length chacha20 takes as a raw key. Whatever the codec does with
 * them after that is its own business: the work factor this product promises is
 * the scrypt pass below, and nothing here relies on a second one inside the file.
 */
export const DATA_KEY_BYTES = 32

const SCRYPT_N = 32768
const SCRYPT_R = 8
const SCRYPT_P = 1

export interface KeyFileParams {
  n: number
  r: number
  p: number
}

export interface DeviceWrap {
  /** Base64 of whatever `safeStorage` produced. Opaque here; only the OS can open it. */
  sealed: string
}

export interface PassphraseWrap {
  salt: string
  iv: string
  tag: string
  ciphertext: string
  params: KeyFileParams
}

/**
 * Written before a transition rewrites any page, cleared after it verifies. A
 * ledger found with this still set is mid-change and must be reconciled against
 * what the file header actually says before the app trusts either.
 */
export interface KeyFilePending {
  direction: 'encrypt' | 'decrypt'
  copy: string
}

export interface LedgerKeyFile {
  version: 1
  cipher: typeof LEDGER_CIPHER
  device?: DeviceWrap
  passphrase?: PassphraseWrap
  createdAt: string
  pending?: KeyFilePending
}

export class KeyFileError extends Error {
  readonly code = 'KEY_FILE'
  constructor(detail: string) {
    super(`The key file beside the ledger could not be used: ${detail}`)
    this.name = 'KeyFileError'
  }
}

export class WrongPassphraseError extends Error {
  readonly code = 'WRONG_PASSPHRASE'
  constructor() {
    super('That passphrase does not open this ledger.')
    this.name = 'WrongPassphraseError'
  }
}

export class NoCustodyError extends Error {
  readonly code = 'NO_CUSTODY'
  /** `why` is the reason the machine at hand cannot open it, in the user's terms. */
  constructor(why = '') {
    super(
      ['The ledger is encrypted but this machine holds no way to open it.', why].filter(Boolean).join(' ')
    )
    this.name = 'NoCustodyError'
  }
}

export function keyFilePath(dataDirectory: string): string {
  return join(dataDirectory, KEY_FILE)
}

export function hasKeyFile(dataDirectory: string): boolean {
  return existsSync(keyFilePath(dataDirectory))
}

/**
 * Reading the marker is the app's only way to know a ledger is encrypted before
 * it opens it. A keyed connection cannot open a plaintext file and an unkeyed
 * connection cannot open an encrypted one, so guessing is not available.
 */
export function readKeyFile(dataDirectory: string): LedgerKeyFile | null {
  const path = keyFilePath(dataDirectory)
  if (!existsSync(path)) return null
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new KeyFileError(`${path} is not readable JSON (${String(error)})`)
  }
  return parseKeyFile(raw, path)
}

function parseKeyFile(raw: unknown, path: string): LedgerKeyFile {
  if (typeof raw !== 'object' || raw === null) throw new KeyFileError(`${path} is not an object`)
  const file = raw as Partial<LedgerKeyFile>
  if (file.version !== 1) {
    throw new KeyFileError(
      `${path} is version ${String(file.version)}; this build understands version 1 only`
    )
  }
  if (file.cipher !== LEDGER_CIPHER) {
    throw new KeyFileError(
      `${path} asks for cipher ${String(file.cipher)}, which this build does not ship`
    )
  }
  if (!file.device && !file.passphrase) {
    throw new KeyFileError(`${path} holds no way to open the ledger`)
  }
  for (const [name, value] of [
    ['device', file.device],
    ['passphrase', file.passphrase]
  ] as const) {
    if (value === undefined) continue
    if (typeof value !== 'object' || value === null) throw new KeyFileError(`${path} ${name} is not an object`)
  }
  if (file.device !== undefined && typeof file.device.sealed !== 'string') {
    throw new KeyFileError(`${path} device wrap has no sealed key`)
  }
  if (file.passphrase !== undefined) {
    const wrap = file.passphrase
    for (const field of ['salt', 'iv', 'tag', 'ciphertext'] as const) {
      if (typeof wrap[field] !== 'string') throw new KeyFileError(`${path} passphrase wrap is missing ${field}`)
    }
    const params = wrap.params
    if (
      typeof params?.n !== 'number' ||
      typeof params?.r !== 'number' ||
      typeof params?.p !== 'number'
    ) {
      throw new KeyFileError(`${path} passphrase wrap has no key-derivation parameters`)
    }
  }
  if (file.pending !== undefined) {
    const pending = file.pending
    if (pending.direction !== 'encrypt' && pending.direction !== 'decrypt') {
      throw new KeyFileError(`${path} records a pending transition with no direction`)
    }
    if (typeof pending.copy !== 'string' || !pending.copy.trim()) {
      throw new KeyFileError(`${path} records a pending transition with no safety copy`)
    }
  }
  return file as LedgerKeyFile
}

export function writeKeyFile(dataDirectory: string, file: LedgerKeyFile): void {
  writeFileAtomic(keyFilePath(dataDirectory), `${JSON.stringify(file, null, 2)}\n`, 0o600)
}

export function removeKeyFile(dataDirectory: string): void {
  rmSync(keyFilePath(dataDirectory), { force: true })
}

export function generateDataKey(): Buffer {
  return randomBytes(DATA_KEY_BYTES)
}

/**
 * scrypt is the attacker's cost per guess and it is ours to choose: 32768 costs
 * a real user ~50 ms and a brute-force script a full memory-hard pass. The
 * parameters are stored in the wrap so they can be raised later without locking
 * out a ledger written under the old ones.
 */
export function deriveKek(passphrase: string, salt: Buffer, params: KeyFileParams): Buffer {
  return scryptSync(Buffer.from(passphrase, 'utf8'), salt, DATA_KEY_BYTES, {
    N: params.n,
    r: params.r,
    p: params.p,
    // Node's 32 MiB default is exactly the footprint of N=32768, r=8, so it has
    // to be raised or the derivation throws instead of running slow.
    maxmem: params.n * params.r * 128 * 2
  })
}

export function sealWithPassphrase(dataKey: Buffer, passphrase: string): PassphraseWrap {
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const params: KeyFileParams = { n: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P }
  const cipher = createCipheriv('aes-256-gcm', deriveKek(passphrase, salt, params), iv)
  const ciphertext = Buffer.concat([cipher.update(dataKey), cipher.final()])
  return {
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    params
  }
}

/** The GCM tag is the check: a wrong passphrase fails authentication and yields no key. */
export function openWithPassphrase(wrap: PassphraseWrap, passphrase: string): Buffer {
  const salt = Buffer.from(wrap.salt, 'base64')
  const iv = Buffer.from(wrap.iv, 'base64')
  const decipher = createDecipheriv('aes-256-gcm', deriveKek(passphrase, salt, wrap.params), iv)
  decipher.setAuthTag(Buffer.from(wrap.tag, 'base64'))
  try {
    const dataKey = Buffer.concat([
      decipher.update(Buffer.from(wrap.ciphertext, 'base64')),
      decipher.final()
    ])
    if (dataKey.length !== DATA_KEY_BYTES) throw new WrongPassphraseError()
    return dataKey
  } catch (error) {
    if (error instanceof WrongPassphraseError) throw error
    throw new WrongPassphraseError()
  }
}

/** True when both wraps release the same key — used to prove a custody change worked. */
export function sameKey(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b)
}

export const DEFAULT_KEY_FILE_PARAMS: KeyFileParams = { n: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P }

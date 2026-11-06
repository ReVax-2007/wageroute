import { randomBytes, scryptSync, createCipheriv, createDecipheriv, hkdfSync, timingSafeEqual } from 'node:crypto'
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
 * Four wraps exist: `device`, sealed by the OS keychain through Electron's
 * `safeStorage`; `passphrase` and `pin`, sealed by a key derived with scrypt from
 * what the user types (the PIN at four times the memory, because its search
 * space is a million values); and `passkey`, sealed by a key derived with HKDF
 * from a WebAuthn PRF output that only the platform authenticator can produce
 * (ADR 0031). Any one unlocks. A passkey is never allowed to be the only one.
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
/**
 * A PIN's scrypt cost: 2^17 is 128 MiB and measured 160 ms on an Apple M5 against
 * the passphrase's 41 ms. It does not make a six-digit PIN safe against a copied
 * file — a million guesses at that cost is days on one machine, not years — and the
 * honesty row says so; it only makes the offline search cost what an unlock can afford.
 */
const PIN_SCRYPT_N = 131072

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

/** The same shape as a passphrase wrap, under a dearer scrypt and a digits-only secret. */
export type PinWrap = PassphraseWrap

/**
 * A wrap under a WebAuthn PRF output. Only the credential id, the PRF input and
 * the HKDF salt are stored: none of them is secret, and none of them opens
 * anything without the authenticator and a verified user.
 */
export interface PasskeyWrap {
  credentialId: string
  rpId: string
  /** The PRF `eval.first` input, base64. */
  prfSalt: string
  hkdfSalt: string
  iv: string
  tag: string
  ciphertext: string
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
  pin?: PinWrap
  passkey?: PasskeyWrap
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
  // A passkey alone is not a way in this file may record (ADR 0031), so it does not count here.
  if (!file.device && !file.passphrase && !file.pin) {
    throw new KeyFileError(`${path} holds no way to open the ledger`)
  }
  for (const [name, value] of [
    ['device', file.device],
    ['passphrase', file.passphrase],
    ['pin', file.pin],
    ['passkey', file.passkey]
  ] as const) {
    if (value === undefined) continue
    if (typeof value !== 'object' || value === null) throw new KeyFileError(`${path} ${name} is not an object`)
  }
  if (file.device !== undefined && typeof file.device.sealed !== 'string') {
    throw new KeyFileError(`${path} device wrap has no sealed key`)
  }
  for (const [name, wrap] of [
    ['passphrase', file.passphrase],
    ['pin', file.pin]
  ] as const) {
    if (wrap === undefined) continue
    for (const field of ['salt', 'iv', 'tag', 'ciphertext'] as const) {
      if (typeof wrap[field] !== 'string') throw new KeyFileError(`${path} ${name} wrap is missing ${field}`)
    }
    const params = wrap.params
    if (
      typeof params?.n !== 'number' ||
      typeof params?.r !== 'number' ||
      typeof params?.p !== 'number'
    ) {
      throw new KeyFileError(`${path} ${name} wrap has no key-derivation parameters`)
    }
  }
  if (file.passkey !== undefined) {
    for (const field of ['credentialId', 'rpId', 'prfSalt', 'hkdfSalt', 'iv', 'tag', 'ciphertext'] as const) {
      if (typeof file.passkey[field] !== 'string') throw new KeyFileError(`${path} passkey wrap is missing ${field}`)
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

export function sealWithPassphrase(
  dataKey: Buffer,
  passphrase: string,
  params: KeyFileParams = DEFAULT_KEY_FILE_PARAMS
): PassphraseWrap {
  const salt = randomBytes(16)
  return { salt: salt.toString('base64'), ...sealUnder(deriveKek(passphrase, salt, params), dataKey), params }
}

/** A PIN is sealed exactly as a passphrase is, at the dearer cost. Opening reads the cost from the wrap. */
export function sealWithPin(dataKey: Buffer, pin: string): PinWrap {
  return sealWithPassphrase(dataKey, pin, PIN_KEY_FILE_PARAMS)
}

function sealUnder(kek: Buffer, dataKey: Buffer): { iv: string; tag: string; ciphertext: string } {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', kek, iv)
  const ciphertext = Buffer.concat([cipher.update(dataKey), cipher.final()])
  return {
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64')
  }
}

/** Null when the tag does not check out: the wrong secret and a damaged wrap look the same. */
function openUnder(kek: Buffer, wrap: { iv: string; tag: string; ciphertext: string }): Buffer | null {
  try {
    const decipher = createDecipheriv('aes-256-gcm', kek, Buffer.from(wrap.iv, 'base64'))
    decipher.setAuthTag(Buffer.from(wrap.tag, 'base64'))
    const dataKey = Buffer.concat([decipher.update(Buffer.from(wrap.ciphertext, 'base64')), decipher.final()])
    return dataKey.length === DATA_KEY_BYTES ? dataKey : null
  } catch {
    return null
  }
}

/** The PRF output is a secret the authenticator computed; HKDF turns it into a key that only wraps. */
const PASSKEY_INFO = 'wageroute data-key wrap'
export const PRF_OUTPUT_BYTES = 32

function passkeyKek(prfOutput: Buffer, hkdfSalt: Buffer): Buffer {
  if (prfOutput.length !== PRF_OUTPUT_BYTES) {
    throw new KeyFileError(`a passkey answered with ${prfOutput.length} bytes instead of ${PRF_OUTPUT_BYTES}`)
  }
  return Buffer.from(hkdfSync('sha256', prfOutput, hkdfSalt, PASSKEY_INFO, DATA_KEY_BYTES))
}

export function sealWithPasskey(
  dataKey: Buffer,
  enrolment: { credentialId: string; rpId: string; prfSalt: Buffer; prfOutput: Buffer }
): PasskeyWrap {
  const hkdfSalt = randomBytes(32)
  return {
    credentialId: enrolment.credentialId,
    rpId: enrolment.rpId,
    prfSalt: enrolment.prfSalt.toString('base64'),
    hkdfSalt: hkdfSalt.toString('base64'),
    ...sealUnder(passkeyKek(enrolment.prfOutput, hkdfSalt), dataKey)
  }
}

/** Null means this PRF output does not open this wrap: another passkey, or a damaged file. */
export function openWithPasskey(wrap: PasskeyWrap, prfOutput: Buffer): Buffer | null {
  return openUnder(passkeyKek(prfOutput, Buffer.from(wrap.hkdfSalt, 'base64')), wrap)
}

/** The GCM tag is the check: a wrong passphrase fails authentication and yields no key. */
export function openWithPassphrase(wrap: PassphraseWrap, passphrase: string): Buffer {
  const dataKey = openUnder(deriveKek(passphrase, Buffer.from(wrap.salt, 'base64'), wrap.params), wrap)
  if (!dataKey) throw new WrongPassphraseError()
  return dataKey
}

/** True when both wraps release the same key — used to prove a custody change worked. */
export function sameKey(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b)
}

export const DEFAULT_KEY_FILE_PARAMS: KeyFileParams = { n: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P }
export const PIN_KEY_FILE_PARAMS: KeyFileParams = { n: PIN_SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P }

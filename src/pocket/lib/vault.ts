/**
 * The vault: this phone's own copy, sealed under a passphrase.
 *
 * An envelope (`envelope.ts`) is a file that leaves the phone. A vault is the
 * opposite — the copy that stays in IndexedDB — and it needs different mechanics:
 *
 * - The data is written **many times** from **one key**. A backup is sealed once
 *   and read once, so stretching it each time costs a third of a second nobody
 *   notices. The vault is re-sealed on every save, so stretching per save would
 *   put half a second behind each keystroke that commits. Instead the passphrase
 *   is stretched **once per unlock** and the resulting key is kept in this module
 *   while the app is open. Every seal still takes a fresh initial vector, which is
 *   what makes one key over many writes safe.
 * - **The phrase is never stored, and neither is the key.** The key is
 *   non-extractable, so nothing in this module can hand it out; and reloading the
 *   page loses it, which is the point: the copy on a phone that has been closed
 *   and reopened says "locked" until the phrase is typed again.
 * - **Something has to prove the phrase was right.** GCM would authenticate the
 *   ledger itself, but the marker must be verifiable before the (larger, possibly
 *   absent) record is trusted, so creation seals a token the reader expects back.
 *
 * Turning it off is the same one operation in reverse: read with the key, write
 * without it. Nothing is decrypted in bulk and no migration can strand the file,
 * because there is only ever one record.
 */
import {
  DEFAULT_ITERATIONS,
  MAX_ITERATIONS,
  MIN_ITERATIONS,
  SALT_BYTES,
  EnvelopeError,
  fromBase64,
  toBase64
} from '@shared/envelope'
import type { StoredLedger } from './idb'
import {
  deriveKey,
  openPart,
  randomBytes,
  sealPart,
  type KeyUsage,
  type SealedPart,
  type SessionKey
} from './webcrypto'

export const VAULT_FORMAT = 'wageroute-vault'
export const VAULT_VERSION = 1

/**
 * What the marker seals to prove a phrase. Public knowledge — the value of a
 * verifier is not its secrecy but that the cipher authenticates it under the only
 * key that comes from the right phrase.
 */
const VERIFIER = 'wageroute-vault-check'

/** The parameters a reader needs in the clear before it can attempt to open anything. */
export interface VaultMarker {
  format: typeof VAULT_FORMAT
  version: number
  kdf: 'PBKDF2-SHA256'
  cipher: 'AES-256-GCM'
  iterations: number
  salt: string
  /** A verifier token, sealed under the derived key, so the phrase can be checked on its own. */
  check: SealedPart
  createdAt: string
}

/** The whole record when a vault is on: the parameters in the clear, the ledger under the cipher. */
export interface SealedCopy {
  vault: VaultMarker
  record: SealedPart
}

/** Why a vault could not be used, in the three ways a screen has to answer differently. */
export type VaultFailure = 'passphrase' | 'shape' | 'closed'

export class VaultError extends Error {
  readonly failure: VaultFailure

  constructor(failure: VaultFailure, message: string) {
    super(message)
    this.name = 'VaultError'
    this.failure = failure
  }
}

/**
 * The key made when the phrase was typed, held here and nowhere else: not in
 * component state, not in the store, not on disk. It lives exactly as long as this
 * page does.
 *
 * A second, concurrent vault (another tab, another passphrase) would need this to
 * be a small map keyed by salt. The phone has one ledger, so it has one key.
 */
let session: { marker: VaultMarker; key: SessionKey } | null = null

/**
 * Derive the key a phrase makes for this salt and cost, after checking both. The
 * guard rails are the envelope's: a marker written with one round would hand back a
 * key in microseconds, and one with a billion would hang the person waiting for
 * their ledger.
 */
async function derive(
  passphrase: string,
  saltB64: string,
  iterations: number,
  usages: KeyUsage[]
): Promise<SessionKey> {
  if (!Number.isInteger(iterations) || iterations < MIN_ITERATIONS || iterations > MAX_ITERATIONS) {
    throw new VaultError(
      'shape',
      `This vault asks for ${String(iterations)} rounds of key stretching, which is outside what WageRoute will do.`
    )
  }
  let salt: Uint8Array<ArrayBuffer>
  try {
    salt = fromBase64(saltB64, 'salt')
  } catch (error) {
    throw new VaultError('shape', describeShape(error))
  }
  if (salt.length !== SALT_BYTES) {
    throw new VaultError('shape', `This vault's salt is ${String(salt.length)} bytes and it should be ${String(SALT_BYTES)}.`)
  }
  try {
    return await deriveKey(passphrase, salt, iterations, usages)
  } catch (error) {
    if (error instanceof EnvelopeError) throw new VaultError(error.failure, error.message)
    throw new VaultError('shape', describeShape(error))
  }
}

function describeShape(error: unknown): string {
  return error instanceof Error && error.message !== ''
    ? `This vault is damaged: ${error.message}`
    : 'This vault is damaged.'
}

/**
 * Parameters for a new vault. Nothing about the ledger happens here: the caller
 * writes the first sealed copy only once these exist, so a failed seal cannot leave
 * a marker that claims a vault with no data behind it.
 */
export async function createVault(
  passphrase: string,
  options: { iterations?: number } = {}
): Promise<VaultMarker> {
  const iterations = options.iterations ?? DEFAULT_ITERATIONS
  const salt = toBase64(randomBytes(SALT_BYTES))
  // Through `derive`, not straight to the cipher, so a vault cannot be created
  // with a cost outside the rails the reader will later refuse, and so a page with
  // no cipher at all is answered with the vault's own error rather than the
  // store's fallback about a storage write that never happened.
  const key = await derive(passphrase, salt, iterations, ['encrypt'])
  const part = await sealPart(key, VERIFIER)
  return {
    format: VAULT_FORMAT,
    version: VAULT_VERSION,
    kdf: 'PBKDF2-SHA256',
    cipher: 'AES-256-GCM',
    iterations,
    salt,
    check: part,
    createdAt: new Date().toISOString()
  }
}

/** Derive the key this phrase makes for this marker and prove it against the check. */
async function proveKey(
  marker: VaultMarker,
  passphrase: string,
  usages: KeyUsage[]
): Promise<SessionKey> {
  assertMarker(marker)
  const key = await derive(passphrase, marker.salt, marker.iterations, usages)
  if ((await openPart(key, marker.check)) !== VERIFIER) {
    throw new VaultError(
      'passphrase',
      'That passphrase does not open this phone’s copy of your ledger.'
    )
  }
  return key
}

/**
 * Prove a phrase against a marker *without* touching the open session.
 *
 * A change of passphrase asks for the old one first, and the screen asking is a
 * working screen: the phone is already open. Replacing its key with one derived
 * from a phrase that then turns out to be wrong would lock a phone over a typo.
 */
export async function verifyPassphrase(marker: VaultMarker, passphrase: string): Promise<void> {
  await proveKey(marker, passphrase, ['decrypt'])
}

/** Prove a phrase opens this marker, and keep the key for the seals that follow. */
export async function unlockVault(marker: VaultMarker, passphrase: string): Promise<void> {
  session = {
    marker,
    key: await proveKey(marker, passphrase, ['encrypt', 'decrypt'])
  }
}

export function lockVault(): void {
  session = null
}

export function vaultIsOpen(): boolean {
  return session !== null
}

/**
 * The open session's key, or the reason this page cannot use it. Returns it rather
 * than leaving callers to read `session` after the check: a module-level variable
 * that another tab can replace is not something to dereference on faith.
 */
function sessionKeyFor(marker: VaultMarker): SessionKey {
  if (!session) {
    throw new VaultError('closed', 'This vault is closed. Type its passphrase first.')
  }
  if (session.marker.salt !== marker.salt || session.marker.iterations !== marker.iterations) {
    // Two tabs, or a vault turned off and back on while this page stayed open:
    // sealing with the wrong key would produce a record nobody can open.
    throw new VaultError('closed', 'This vault changed since this screen last opened. Unlock it again.')
  }
  return session.key
}

/** The ledger, sealed under the vault's key with a fresh initial vector. */
export async function sealRecord(marker: VaultMarker, ledger: StoredLedger): Promise<SealedCopy> {
  return {
    vault: marker,
    record: await sealPart(sessionKeyFor(marker), JSON.stringify(ledger))
  }
}

/**
 * The ledger inside a sealed record. The phrase was already proved by
 * `unlockVault`; this only reads, and refuses if the vault has since closed.
 */
export async function openRecord(copy: SealedCopy): Promise<StoredLedger> {
  assertMarker(copy.vault)
  const json = await openPart(sessionKeyFor(copy.vault), copy.record)
  if (json === null) {
    throw new VaultError(
      'shape',
      'This phone’s sealed copy has been changed since WageRoute wrote it, so it will not open.'
    )
  }
  return parsesLedger(json)
}

function parsesLedger(json: string): StoredLedger {
  let value: unknown
  try {
    value = JSON.parse(json) as unknown
  } catch {
    throw new VaultError('shape', 'This phone’s sealed copy does not hold readable ledger data.')
  }
  if (typeof value !== 'object' || value === null || !(value as { tables?: unknown }).tables) {
    throw new VaultError('shape', 'This phone’s sealed copy does not hold a ledger.')
  }
  return value as StoredLedger
}

/**
 * Read a marker without trusting it. A record comes out of IndexedDB, and the
 * fields below are what a key is made from: a damaged length or an iteration count
 * outside the guard rails must be refused before anything is derived.
 */
export function assertMarker(value: unknown): asserts value is VaultMarker {
  if (typeof value !== 'object' || value === null) {
    throw new VaultError('shape', 'This phone’s copy says it is sealed, but no vault parameters came with it.')
  }
  const marker = value as Record<string, unknown>
  if (marker.format !== VAULT_FORMAT) {
    throw new VaultError('shape', 'This phone’s copy is sealed in a format WageRoute does not recognise.')
  }
  if (typeof marker.version !== 'number' || marker.version > VAULT_VERSION) {
    throw new VaultError(
      'shape',
      `This copy was sealed by a newer WageRoute (vault version ${String(marker.version)}), and this one cannot open it.`
    )
  }
  if (marker.kdf !== 'PBKDF2-SHA256' || marker.cipher !== 'AES-256-GCM') {
    throw new VaultError(
      'shape',
      `This copy was sealed with ${String(marker.kdf)} and ${String(marker.cipher)}, which this WageRoute cannot open.`
    )
  }
  if (typeof marker.salt !== 'string' || typeof marker.createdAt !== 'string') {
    throw new VaultError('shape', 'This phone’s sealed copy is missing its salt or its date.')
  }
  const check = marker.check as Record<string, unknown> | undefined | null
  if (typeof check !== 'object' || check === null) {
    throw new VaultError('shape', 'This phone’s sealed copy cannot prove a passphrase, so it will not be opened.')
  }
  for (const field of ['iv', 'tag', 'ciphertext'] as const) {
    if (typeof check[field] !== 'string') {
      throw new VaultError('shape', `This phone’s sealed copy is missing the ${field} of its check.`)
    }
  }
}

/** Does this stored record carry a vault? Checked before anything is derived. */
export function looksSealed(value: unknown): value is SealedCopy {
  if (typeof value !== 'object' || value === null) return false
  const copy = value as Record<string, unknown>
  return (
    typeof copy.vault === 'object' &&
    copy.vault !== null &&
    typeof copy.record === 'object' &&
    copy.record !== null &&
    (copy.vault as Record<string, unknown>).format === VAULT_FORMAT
  )
}

/**
 * Make a new vault from a new passphrase and hand over the key for it.
 *
 * A change of phrase is a new salt and a new derivation rather than a re-wrap of an
 * existing key, because the key never exists anywhere but in this module — which is
 * what makes changing it cheap enough to offer as often as the owner wants. The old
 * phrase is proved first, without disturbing the session, so a typo in that box
 * cannot lock a phone that was working.
 */
export async function changeVaultPassphrase(
  marker: VaultMarker,
  current: string,
  next: string,
  options: { iterations?: number } = {}
): Promise<VaultMarker> {
  await verifyPassphrase(marker, current)
  const created = await createVault(next, { iterations: options.iterations ?? marker.iterations })
  // This page keeps working under the new phrase: the caller seals the next copy
  // with the marker returned here, and a session pointing at the old key would
  // write a record the new marker cannot open.
  await unlockVault(created, next)
  return created
}

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
 *
 * **Two versions live here (ADR 0031).** A v1 vault has no data key: its AES key is
 * the passphrase, stretched. It stays readable for good, and a vault made today is
 * still v1. A v2 vault seals the record under a random 32-byte data key and keeps
 * that key wrapped — by the passphrase, by a PIN, by a passkey's PRF output — so
 * a way in can be added or removed without touching the record. A v1 vault becomes
 * v2 only when its owner adds a PIN or a passkey, in the same single write that
 * sealing already is. Two rules the owner set hold for every v2 change: a passkey
 * is never the only way in, and while one exists the passphrase stays.
 */
import {
  DEFAULT_ITERATIONS,
  KEY_BYTES,
  MAX_ITERATIONS,
  MIN_ITERATIONS,
  SALT_BYTES,
  EnvelopeError,
  fromBase64,
  toBase64
} from '@shared/envelope'
import { passphraseProblem, pinProblem } from '@shared/encryption'
import { runPasskeyCeremony, type PasskeyAnswer, type PasskeyRequest } from '@shared/passkey-ceremony'
import type { StoredLedger } from './idb'
import {
  deriveKey,
  deriveKeyFromPrf,
  importDataKey,
  openPart,
  randomBytes,
  sealPart,
  type KeyUsage,
  type SealedPart,
  type SessionKey
} from './webcrypto'

export const VAULT_FORMAT = 'wageroute-vault'
/** The newest version this build writes and reads. v1 is still read, and still what a new vault is. */
export const VAULT_VERSION = 2
/**
 * A PIN's PBKDF2 cost: the guard rail's ceiling, 2 000 000 rounds — 142 ms on an
 * Apple M5 in Node, untimed on any phone. It does not make a six-digit PIN safe
 * against a copied storage folder; the card says so before one is saved.
 */
export const PIN_ITERATIONS = MAX_ITERATIONS

/**
 * What the marker seals to prove a phrase. Public knowledge — the value of a
 * verifier is not its secrecy but that the cipher authenticates it under the only
 * key that comes from the right phrase.
 */
const VERIFIER = 'wageroute-vault-check'

/** The parameters a reader needs in the clear before it can attempt to open anything. */
export interface VaultMarkerV1 {
  format: typeof VAULT_FORMAT
  version: 1
  kdf: 'PBKDF2-SHA256'
  cipher: 'AES-256-GCM'
  iterations: number
  salt: string
  /** A verifier token, sealed under the derived key, so the phrase can be checked on its own. */
  check: SealedPart
  createdAt: string
}

/** One typed secret — a passphrase or a PIN — wrapping the data key. */
export interface TypedWrap {
  kdf: 'PBKDF2-SHA256'
  iterations: number
  salt: string
  /** The 32-byte data key, base64, sealed under the stretched secret. */
  key: SealedPart
}

/** A passkey's PRF output wrapping the data key. Nothing here opens anything without the authenticator. */
export interface PasskeyVaultWrap {
  credentialId: string
  rpId: string
  prfSalt: string
  hkdfSalt: string
  key: SealedPart
}

export interface VaultWraps {
  passphrase?: TypedWrap
  pin?: TypedWrap
  passkey?: PasskeyVaultWrap
}

export interface VaultMarkerV2 {
  format: typeof VAULT_FORMAT
  version: 2
  cipher: 'AES-256-GCM'
  /** Names the data key, so a screen holding an old marker cannot seal under a new key. */
  keyId: string
  wraps: VaultWraps
  createdAt: string
}

export type VaultMarker = VaultMarkerV1 | VaultMarkerV2

export function isV2(marker: VaultMarker): marker is VaultMarkerV2 {
  return marker.version === 2
}

/** What a typed answer can be on this vault, so the gate can say "passphrase", "PIN" or both. */
export function typedKinds(marker: VaultMarker): { passphrase: boolean; pin: boolean } {
  return isV2(marker)
    ? { passphrase: Boolean(marker.wraps.passphrase), pin: Boolean(marker.wraps.pin) }
    : { passphrase: true, pin: false }
}

/** The whole record when a vault is on: the parameters in the clear, the ledger under the cipher. */
export interface SealedCopy {
  vault: VaultMarker
  record: SealedPart
}

/** Why a vault could not be used, in the three ways a screen has to answer differently. */
export type VaultFailure = 'passphrase' | 'shape' | 'closed' | 'passkey'

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
let session: { id: string; key: SessionKey } | null = null

/** Which key a marker's records are sealed under. A rewrap keeps it; a new vault or a v1→v2 move changes it. */
function keyIdOf(marker: VaultMarker): string {
  return isV2(marker) ? `v2:${marker.keyId}` : `v1:${marker.salt}:${String(marker.iterations)}`
}

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
): Promise<VaultMarkerV1> {
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
    // A new vault is still v1: it moves to v2 only when a PIN or a passkey is added.
    version: 1,
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
  marker: VaultMarkerV1,
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
  assertMarker(marker)
  if (isV2(marker)) {
    const raw = await openTyped(marker, passphrase)
    raw.fill(0)
    return
  }
  await proveKey(marker, passphrase, ['decrypt'])
}

/** Prove a phrase (or, on v2, a PIN) opens this marker, and keep the key for the seals that follow. */
export async function unlockVault(marker: VaultMarker, passphrase: string): Promise<void> {
  assertMarker(marker)
  if (isV2(marker)) {
    session = { id: keyIdOf(marker), key: await keyFromRaw(await openTyped(marker, passphrase)) }
    return
  }
  session = {
    id: keyIdOf(marker),
    key: await proveKey(marker, passphrase, ['encrypt', 'decrypt'])
  }
}

/** Import raw data-key bytes as the session key, then zero the bytes this module held. */
async function keyFromRaw(raw: Uint8Array<ArrayBuffer>): Promise<SessionKey> {
  try {
    return await importDataKey(raw, ['encrypt', 'decrypt'])
  } finally {
    raw.fill(0)
  }
}

const WRONG_TYPED = 'That does not open this phone’s copy of your ledger.'

async function sealTypedWrap(
  raw: Uint8Array<ArrayBuffer>,
  secret: string,
  iterations: number
): Promise<TypedWrap> {
  const salt = toBase64(randomBytes(SALT_BYTES))
  const key = await derive(secret, salt, iterations, ['encrypt'])
  return { kdf: 'PBKDF2-SHA256', iterations, salt, key: await sealPart(key, toBase64(raw)) }
}

/** Null when the secret does not open this wrap; the GCM tag is the whole check. */
async function openTypedWrap(wrap: TypedWrap, secret: string): Promise<Uint8Array<ArrayBuffer> | null> {
  const key = await derive(secret, wrap.salt, wrap.iterations, ['decrypt'])
  return rawKeyOf(await openPart(key, wrap.key))
}

function rawKeyOf(sealed: string | null): Uint8Array<ArrayBuffer> | null {
  if (sealed === null) return null
  let raw: Uint8Array<ArrayBuffer>
  try {
    raw = fromBase64(sealed, 'data key')
  } catch {
    return null
  }
  return raw.length === KEY_BYTES ? raw : null
}

/**
 * One typed answer against whichever of the passphrase and the PIN this vault has.
 * Digits are tried as the PIN first; both are tried, since a passphrase may be digits.
 */
async function openTyped(marker: VaultMarkerV2, typed: string): Promise<Uint8Array<ArrayBuffer>> {
  if (typed === '') throw new VaultError('passphrase', 'Type the passphrase or PIN this was sealed with.')
  const order: ('passphrase' | 'pin')[] = /^[0-9]+$/.test(typed) ? ['pin', 'passphrase'] : ['passphrase', 'pin']
  for (const kind of order) {
    const wrap = marker.wraps[kind]
    if (!wrap) continue
    const raw = await openTypedWrap(wrap, typed)
    if (raw) return raw
  }
  throw new VaultError('passphrase', WRONG_TYPED)
}

/** Seam for tests: the ceremony a passkey runs, which in a page is the shared one. */
export type Ceremony = (request: PasskeyRequest) => Promise<PasskeyAnswer>

function passkeyRefusal(answer: Extract<PasskeyAnswer, { ok: false }>, doing: string): VaultError {
  return new VaultError(
    'passkey',
    answer.reason === 'cancelled'
      ? `The fingerprint or face check was cancelled, so ${doing}.`
      : `This phone cannot use a fingerprint or face for this: ${answer.detail} So ${doing}.`
  )
}

/** Open a v2 vault with its passkey: one fingerprint or face, nothing typed. */
export async function unlockVaultWithPasskey(
  marker: VaultMarker,
  ceremony: Ceremony = runPasskeyCeremony
): Promise<void> {
  assertMarker(marker)
  const wrap = isV2(marker) ? marker.wraps.passkey : undefined
  if (!isV2(marker) || !wrap) {
    throw new VaultError('passkey', 'This phone’s copy has no fingerprint or face to open it with.')
  }
  const answer = await ceremony({
    mode: 'assert',
    rpId: wrap.rpId,
    prfSalt: wrap.prfSalt,
    credentialId: wrap.credentialId
  })
  if (!answer.ok) throw passkeyRefusal(answer, 'it is still closed — type the passphrase instead')
  if (answer.mode !== 'assert') throw new VaultError('passkey', 'The passkey answered the wrong question.')
  const raw = await openPasskeyWrap(wrap, answer.output)
  if (!raw) {
    throw new VaultError('passkey', 'That passkey does not open this phone’s copy. Type the passphrase instead.')
  }
  session = { id: keyIdOf(marker), key: await keyFromRaw(raw) }
}

async function openPasskeyWrap(wrap: PasskeyVaultWrap, prfOutput: string): Promise<Uint8Array<ArrayBuffer> | null> {
  try {
    const kek = await deriveKeyFromPrf(fromBase64(prfOutput, 'passkey secret'), fromBase64(wrap.hkdfSalt, 'salt'), [
      'decrypt'
    ])
    return rawKeyOf(await openPart(kek, wrap.key))
  } catch (error) {
    if (error instanceof EnvelopeError && error.failure === 'shape') throw new VaultError('shape', error.message)
    return null
  }
}

/** What can be added to a vault. A passkey's secret comes from the ceremony, not from a box. */
export type VaultAddition =
  | { kind: 'pin'; pin: string }
  | { kind: 'passphrase'; passphrase: string }
  | { kind: 'passkey'; rpId: string }

export interface VaultWrapOptions {
  ceremony?: Ceremony
  /** For tests: the PBKDF2 cost of a new passphrase or PIN wrap. */
  iterations?: number
  pinIterations?: number
}

/**
 * Add a way in, proving `current` first. On a v1 vault this is the move to v2: a
 * fresh data key, the passphrase re-wrapped over it at the cost it already had,
 * and the new wrap beside it — the session switches to the new key, and the caller
 * re-seals the record with the marker returned, in one write. On a v2 vault it is a
 * rewrap and the record's key does not change.
 *
 * Every new wrap is opened again before this returns: a PIN or phrase by typing it
 * back through its own derivation, a passkey by a second, independent assertion.
 */
export async function addVaultWrap(
  marker: VaultMarker,
  current: string,
  addition: VaultAddition,
  options: VaultWrapOptions = {}
): Promise<VaultMarkerV2> {
  assertMarker(marker)
  let raw: Uint8Array<ArrayBuffer>
  let wraps: VaultWraps
  let keyId: string
  let createdAt: string
  if (isV2(marker)) {
    raw = await openTyped(marker, current)
    wraps = { ...marker.wraps }
    keyId = marker.keyId
    createdAt = marker.createdAt
  } else {
    await proveKey(marker, current, ['decrypt'])
    raw = randomBytes(KEY_BYTES)
    wraps = { passphrase: await sealTypedWrap(raw, current, marker.iterations) }
    keyId = toBase64(randomBytes(12))
    createdAt = new Date().toISOString()
  }
  try {
    switch (addition.kind) {
      case 'pin': {
        if (wraps.pin) throw new VaultError('passphrase', 'This phone’s copy already has a PIN. Change it instead.')
        const problem = pinProblem(addition.pin)
        if (problem) throw new VaultError('passphrase', problem)
        wraps.pin = await sealTypedWrap(raw, addition.pin, options.pinIterations ?? PIN_ITERATIONS)
        await proveTyped(wraps.pin, addition.pin, raw)
        break
      }
      case 'passphrase': {
        if (wraps.passphrase) {
          throw new VaultError('passphrase', 'This phone’s copy already has a passphrase. Change it instead.')
        }
        const problem = passphraseProblem(addition.passphrase, 'this phone’s copy of your ledger')
        if (problem) throw new VaultError('passphrase', problem)
        wraps.passphrase = await sealTypedWrap(raw, addition.passphrase, options.iterations ?? DEFAULT_ITERATIONS)
        await proveTyped(wraps.passphrase, addition.passphrase, raw)
        break
      }
      case 'passkey': {
        if (wraps.passkey) {
          throw new VaultError('passkey', 'This phone’s copy already opens with a fingerprint or face.')
        }
        if (!wraps.passphrase) {
          throw new VaultError(
            'passkey',
            'Add a passphrase first. A fingerprint or face is never the only way into this phone’s copy, and the passphrase is what stays.'
          )
        }
        wraps.passkey = await enrolPasskey(raw, addition.rpId, options.ceremony ?? runPasskeyCeremony)
        break
      }
    }
    const next: VaultMarkerV2 = {
      format: VAULT_FORMAT,
      version: 2,
      cipher: 'AES-256-GCM',
      keyId,
      wraps,
      createdAt
    }
    // Only a v1 move changes the key; a rewrap leaves the open session as it is.
    if (!isV2(marker)) session = { id: keyIdOf(next), key: await importDataKey(raw, ['encrypt', 'decrypt']) }
    return next
  } finally {
    raw.fill(0)
  }
}

async function proveTyped(wrap: TypedWrap, secret: string, raw: Uint8Array<ArrayBuffer>): Promise<void> {
  const opened = await openTypedWrap(wrap, secret)
  if (!opened || !sameBytes(opened, raw)) {
    throw new VaultError('shape', 'The new way in did not open the key it just wrapped, so nothing was changed.')
  }
  opened.fill(0)
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let index = 0; index < a.length; index += 1) diff |= (a[index] ?? 0) ^ (b[index] ?? 0)
  return diff === 0
}

/** Register, seal under the first answer, and prove with the second. Nothing is kept if they disagree. */
async function enrolPasskey(raw: Uint8Array<ArrayBuffer>, rpId: string, ceremony: Ceremony): Promise<PasskeyVaultWrap> {
  const prfSalt = toBase64(randomBytes(32))
  const answer = await ceremony({
    mode: 'register',
    rpId,
    prfSalt,
    userName: 'WageRoute on this phone',
    platformOnly: false
  })
  if (!answer.ok) throw passkeyRefusal(answer, 'nothing was changed')
  if (answer.mode !== 'register') throw new VaultError('passkey', 'The passkey answered the wrong question.')
  const hkdfSalt = toBase64(randomBytes(32))
  const kek = await deriveKeyFromPrf(fromBase64(answer.first, 'passkey secret'), fromBase64(hkdfSalt, 'salt'), [
    'encrypt'
  ])
  const wrap: PasskeyVaultWrap = {
    credentialId: answer.credentialId,
    rpId,
    prfSalt,
    hkdfSalt,
    key: await sealPart(kek, toBase64(raw))
  }
  const opened = await openPasskeyWrap(wrap, answer.test)
  if (!opened || !sameBytes(opened, raw)) {
    throw new VaultError(
      'passkey',
      'This passkey did not give the same secret back twice, so it cannot hold the key. Nothing was changed.'
    )
  }
  opened.fill(0)
  return wrap
}

/**
 * Take a way in away. No key is needed — the record does not move — but the vault
 * must be open on this page, and the owner's rules hold: something typed always
 * remains, and while a passkey exists the passphrase stays.
 */
export function removeVaultWrap(marker: VaultMarker, kind: 'passphrase' | 'pin' | 'passkey'): VaultMarkerV2 {
  assertMarker(marker)
  sessionKeyFor(marker)
  if (!isV2(marker) || !marker.wraps[kind]) {
    throw new VaultError('shape', 'This phone’s copy has no such way in to remove.')
  }
  const wraps = { ...marker.wraps }
  delete wraps[kind]
  if (wraps.passkey && !wraps.passphrase) {
    throw new VaultError(
      'passphrase',
      'The passphrase stays while a fingerprint or face opens this phone’s copy. Remove the fingerprint first.'
    )
  }
  if (!wraps.passphrase && !wraps.pin) {
    throw new VaultError(
      'passphrase',
      'That is the last thing you can type to open this phone’s copy. Add another first, or turn the seal off.'
    )
  }
  return { ...marker, wraps }
}

/**
 * Change a v2 vault's passphrase or PIN: the current one is proved against that
 * same wrap, then the same data key is re-wrapped. The record does not move.
 */
async function changeTypedWrap(
  marker: VaultMarkerV2,
  kind: 'passphrase' | 'pin',
  current: string,
  next: string,
  iterations: number
): Promise<VaultMarkerV2> {
  const wrap = marker.wraps[kind]
  const noun = kind === 'pin' ? 'PIN' : 'passphrase'
  if (!wrap) throw new VaultError('passphrase', `This phone’s copy has no ${noun} to change.`)
  const problem = kind === 'pin' ? pinProblem(next) : passphraseProblem(next, 'this phone’s copy of your ledger')
  if (problem) throw new VaultError('passphrase', problem)
  const raw = await openTypedWrap(wrap, current)
  if (!raw) throw new VaultError('passphrase', `That ${noun} does not open this phone’s copy of your ledger.`)
  try {
    const rewrapped = await sealTypedWrap(raw, next, iterations)
    await proveTyped(rewrapped, next, raw)
    return { ...marker, wraps: { ...marker.wraps, [kind]: rewrapped } }
  } finally {
    raw.fill(0)
  }
}

export async function changeVaultPin(
  marker: VaultMarker,
  current: string,
  next: string,
  options: { iterations?: number } = {}
): Promise<VaultMarkerV2> {
  assertMarker(marker)
  if (!isV2(marker)) throw new VaultError('passphrase', 'This phone’s copy has no PIN to change.')
  return changeTypedWrap(marker, 'pin', current, next, options.iterations ?? PIN_ITERATIONS)
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
  if (session.id !== keyIdOf(marker)) {
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
  if (marker.version === 2) {
    assertWraps(marker)
    return
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

function isSealedPart(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const part = value as Record<string, unknown>
  return ['iv', 'tag', 'ciphertext'].every((field) => typeof part[field] === 'string')
}

/** A v2 marker's wraps, checked before any of them is used to derive a key. */
function assertWraps(marker: Record<string, unknown>): void {
  if (marker.cipher !== 'AES-256-GCM' || typeof marker.keyId !== 'string' || typeof marker.createdAt !== 'string') {
    throw new VaultError('shape', 'This phone’s sealed copy is missing its cipher, its key name or its date.')
  }
  const wraps = marker.wraps as Record<string, unknown> | null | undefined
  if (typeof wraps !== 'object' || wraps === null) {
    throw new VaultError('shape', 'This phone’s sealed copy lists no way to open it.')
  }
  for (const kind of ['passphrase', 'pin'] as const) {
    const wrap = wraps[kind] as Record<string, unknown> | undefined
    if (wrap === undefined) continue
    if (
      wrap.kdf !== 'PBKDF2-SHA256' ||
      typeof wrap.iterations !== 'number' ||
      typeof wrap.salt !== 'string' ||
      !isSealedPart(wrap.key)
    ) {
      throw new VaultError('shape', `This phone’s sealed copy has a damaged ${kind === 'pin' ? 'PIN' : 'passphrase'} wrap.`)
    }
  }
  const passkey = wraps.passkey as Record<string, unknown> | undefined
  if (passkey !== undefined) {
    const fields = ['credentialId', 'rpId', 'prfSalt', 'hkdfSalt'] as const
    if (fields.some((field) => typeof passkey[field] !== 'string') || !isSealedPart(passkey.key)) {
      throw new VaultError('shape', 'This phone’s sealed copy has a damaged fingerprint wrap.')
    }
  }
  // The rule this format exists to keep: something typed is always there.
  if (wraps.passphrase === undefined && wraps.pin === undefined) {
    throw new VaultError('shape', 'This phone’s sealed copy has nothing typed that opens it, so it will not be trusted.')
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
  assertMarker(marker)
  // On v2 the phrase is one wrap of a data key, so changing it is a rewrap (ADR 0031).
  if (isV2(marker)) {
    return changeTypedWrap(marker, 'passphrase', current, next, options.iterations ?? DEFAULT_ITERATIONS)
  }
  await verifyPassphrase(marker, current)
  const created = await createVault(next, { iterations: options.iterations ?? marker.iterations })
  // This page keeps working under the new phrase: the caller seals the next copy
  // with the marker returned here, and a session pointing at the old key would
  // write a record the new marker cannot open.
  await unlockVault(created, next)
  return created
}

/**
 * The encrypted export envelope: one JSON file, carrying a whole ledger, that
 * nobody can read without the passphrase it was sealed with.
 *
 * This is the format that leaves the computer. The ledger on disk is encrypted
 * by SQLite's codec with a key this app wraps in its own custody (see
 * `db/ledger-key.ts`); none of that travels, because a `.db` file a user emails
 * themselves is neither portable nor readable by the phone. An envelope is a
 * plain JSON backup — the same bytes the plaintext export writes — put through
 * one authenticated cipher with a key made from a phrase a human can type.
 *
 * Two rules shape the design:
 *
 * - **PBKDF2, not scrypt.** The desktop's own key file uses scrypt because Node
 *   has it and the desktop is the only reader. An envelope has to open in a
 *   browser's WebCrypto too, and WebCrypto implements PBKDF2 and nothing else
 *   memory-hard. So the KDF is chosen by the *weakest* platform that must read
 *   the file, and the iteration count is set high enough to pay for it: 600 000
 *   rounds of PBKDF2-HMAC-SHA-256, which is roughly what OWASP recommends for
 *   that construction and measures around half a second on the machines this app
 *   runs on.
 * - **Everything the reader needs is in the clear.** The salt, the IV, the
 *   iteration count and the tag are not secrets, and hardcoding them would make
 *   a file unreadable the day this app changes its mind. A file says which
 *   parameters it was written with; the reader honours those, within the guard
 *   rails below.
 *
 * What is *not* here, and cannot be: crypto. Sealing and opening need the platform's own
 * primitives — `node:crypto` on the desktop, `crypto.subtle` on the phone — and
 * a shared module that called either could not run in both. This file owns the
 * shape, the validation and the base64, which are the parts that must agree
 * exactly for a desktop file to open on a phone.
 */

/** Marks the file as an envelope rather than a plain backup. */
export const ENVELOPE_FORMAT = 'wageroute-envelope' as const
export const ENVELOPE_VERSION = 1 as const

/** The only thing an envelope carries today. Widening this is a format change. */
export type EnvelopeContent = 'backup'

export type EnvelopeKdf = 'PBKDF2-SHA256'
export type EnvelopeCipher = 'AES-256-GCM'

/**
 * The default cost of a guess. Stored in every file, so a file written before a
 * change keeps opening after it.
 */
export const DEFAULT_ITERATIONS = 600_000

/**
 * Guard rails on a number that comes out of a file. Without a floor, a hostile
 * export could say 1 and hand back a key in microseconds. Without a ceiling, it
 * could say a billion and make the reader hang on a laptop. The ceiling is far
 * above anything this app writes and far below a timeout.
 */
export const MIN_ITERATIONS = 100_000
export const MAX_ITERATIONS = 2_000_000

export const SALT_BYTES = 16
export const IV_BYTES = 12
export const TAG_BYTES = 16
export const KEY_BYTES = 32

/** A sealed backup, with every binary field already base64. */
export interface EncryptedEnvelope {
  format: typeof ENVELOPE_FORMAT
  version: typeof ENVELOPE_VERSION
  /** What is inside once opened. The contents themselves stay under the cipher. */
  contains: EnvelopeContent
  /** When it was written, in the clear: a user sorts these files by name and date. */
  exportedAt: string
  kdf: EnvelopeKdf
  /** PBKDF2 rounds for this file. */
  iterations: number
  cipher: EnvelopeCipher
  salt: string
  iv: string
  /** GCM's authentication tag. It is what turns a wrong phrase into a refusal. */
  tag: string
  ciphertext: string
}

/**
 * Why an envelope could not be used, said in two different ways on purpose.
 *
 * `shape` means the file is not a WageRoute envelope at all, or claims to be one
 * and cannot be parsed. `passphrase` means the file is fine and what was typed
 * is not — the second is retryable and the first is not, and a screen that
 * conflates them tells the user to go looking for a different file when the file
 * in hand is good.
 */
export type EnvelopeFailure = 'shape' | 'passphrase'

export class EnvelopeError extends Error {
  readonly failure: EnvelopeFailure

  constructor(failure: EnvelopeFailure, message: string) {
    super(message)
    this.name = 'EnvelopeError'
    this.failure = failure
  }
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
/** Indexed by character code, so decoding a large file stays linear. */
const DECODE: number[] = (() => {
  const table = new Array<number>(128).fill(-1)
  for (let i = 0; i < ALPHABET.length; i += 1) table[ALPHABET.charCodeAt(i)] = i
  return table
})()

/**
 * Standard base64 with padding, written here rather than delegated to `Buffer`
 * or `btoa` because the same file has to survive a desktop that has one and a
 * phone that has the other. The round trip against Node's own encoder is pinned
 * in `envelope.test.ts`, which is what keeps the two from drifting.
 */
export function toBase64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const rest = bytes.length - i
    const b0 = bytes[i]
    const b1 = rest > 1 ? bytes[i + 1] : 0
    const b2 = rest > 2 ? bytes[i + 2] : 0
    const bits = ((b0 << 16) | (b1 << 8) | b2) >>> 0
    out += ALPHABET.charAt(bits >> 18) + ALPHABET.charAt((bits >> 12) & 63)
    out += rest > 1 ? ALPHABET.charAt((bits >> 6) & 63) : '='
    out += rest > 2 ? ALPHABET.charAt(bits & 63) : '='
  }
  return out
}

export function fromBase64(text: string, field: string): Uint8Array<ArrayBuffer> {
  if (text.length === 0 || text.length % 4 !== 0) {
    throw new EnvelopeError('shape', `The ${field} in this file is not base64.`)
  }
  const groups = text.length / 4
  const trailing = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0
  const bytes = new Uint8Array(groups * 3 - trailing)
  let written = 0
  for (let i = 0; i < groups; i += 1) {
    const group = text.slice(i * 4, i * 4 + 4)
    if (group.includes('=') && i !== groups - 1) {
      throw new EnvelopeError('shape', `The ${field} in this file is padded in the middle.`)
    }
    let bits = 0
    for (let j = 0; j < 4; j += 1) {
      const char = group.charCodeAt(j)
      const value = char === 61 /* '=' */ ? 0 : DECODE[char]
      if (value === undefined || value < 0) {
        throw new EnvelopeError('shape', `The ${field} in this file is not base64.`)
      }
      bits = ((bits << 6) | value) >>> 0
    }
    const keep = group.includes('=') ? 3 - trailing : 3
    for (let j = 0; j < keep; j += 1) bytes[written++] = (bits >> (16 - 8 * j)) & 0xff
  }
  return bytes
}

/** Read it without trusting it: true only for an object shaped like a sealed envelope. */
export function looksLikeEnvelope(value: unknown): value is EncryptedEnvelope {
  if (typeof value !== 'object' || value === null) return false
  const file = value as Record<string, unknown>
  return (
    file.format === ENVELOPE_FORMAT &&
    typeof file.ciphertext === 'string' &&
    typeof file.salt === 'string' &&
    typeof file.iv === 'string'
  )
}

/**
 * Does this file's text say it is sealed? Asked before anything is parsed, so a
 * reader can ask for a passphrase instead of reporting a JSON backup as broken.
 * Bad JSON is simply not an envelope; `parseEnvelope` is what says why.
 */
export function textIsEnvelope(text: string): boolean {
  try {
    return looksLikeEnvelope(JSON.parse(text) as unknown)
  } catch {
    return false
  }
}

/** How each header field is named to a person, so two error paths cannot say "iv" and "initial vector" about the same bytes. */
const ENVELOPE_FIELD_LABEL = {
  salt: 'salt',
  iv: 'initial vector',
  tag: 'authentication tag',
  ciphertext: 'encrypted contents'
} as const

/** Parse a file's text into an envelope, or say which part of it is not one. */
export function parseEnvelope(text: string): EncryptedEnvelope {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new EnvelopeError('shape', 'This file is not JSON, so it is not a WageRoute export.')
  }
  if (!looksLikeEnvelope(raw)) {
    throw new EnvelopeError('shape', 'This is not a WageRoute encrypted export.')
  }
  const file = raw as EncryptedEnvelope
  if (file.version !== ENVELOPE_VERSION) {
    throw new EnvelopeError(
      'shape',
      `This export was made by a newer WageRoute (envelope version ${String(file.version)}), and this one does not know how to open it.`
    )
  }
  if (file.kdf !== 'PBKDF2-SHA256' || file.cipher !== 'AES-256-GCM') {
    throw new EnvelopeError(
      'shape',
      `This export was sealed with ${String(file.kdf)} and ${String(file.cipher)}, which this WageRoute cannot open.`
    )
  }
  if (file.contains !== 'backup') {
    throw new EnvelopeError(
      'shape',
      `This export holds ${String(file.contains)}, and this screen knows how to import a backup.`
    )
  }
  if (
    typeof file.iterations !== 'number' ||
    !Number.isInteger(file.iterations) ||
    file.iterations < MIN_ITERATIONS ||
    file.iterations > MAX_ITERATIONS
  ) {
    // Refusing is the safe answer either way: a low count is an attack on the
    // key, and an absurd one is an attack on the person waiting for their data.
    throw new EnvelopeError(
      'shape',
      `This export asks for ${String(file.iterations)} rounds of key stretching, which is outside what WageRoute will do.`
    )
  }
  if (typeof file.exportedAt !== 'string' || Number.isNaN(Date.parse(file.exportedAt))) {
    throw new EnvelopeError('shape', 'This export does not say when it was written.')
  }
  for (const field of ['salt', 'iv', 'tag', 'ciphertext'] as const) {
    if (typeof file[field] !== 'string') {
      throw new EnvelopeError('shape', `This export is missing its ${field}.`)
    }
  }
  // Checked as decoded bytes, because a base64 string can look right and decode
  // short, and a truncated salt is exactly the kind of damage that quietly
  // changes a key.
  expectLength(fromBase64(file.salt, ENVELOPE_FIELD_LABEL.salt), SALT_BYTES, ENVELOPE_FIELD_LABEL.salt)
  expectLength(
    fromBase64(file.iv, ENVELOPE_FIELD_LABEL.iv),
    IV_BYTES,
    ENVELOPE_FIELD_LABEL.iv
  )
  expectLength(
    fromBase64(file.tag, ENVELOPE_FIELD_LABEL.tag),
    TAG_BYTES,
    ENVELOPE_FIELD_LABEL.tag
  )
  // Said before decoding it: base64 of nothing is the empty string, so an export
  // with no contents would otherwise be reported as a broken encoding.
  if (file.ciphertext === '') {
    throw new EnvelopeError('shape', 'This export holds no data.')
  }
  return file
}

function expectLength(bytes: Uint8Array, expected: number, field: string): void {
  if (bytes.length !== expected) {
    throw new EnvelopeError(
      'shape',
      `This export's ${field} is ${String(bytes.length)} bytes and it should be ${String(expected)}.`
    )
  }
}

export function envelopeToJson(envelope: EncryptedEnvelope): string {
  return `${JSON.stringify(envelope, null, 2)}\n`
}

/**
 * A name for a sealed export that says what it is, because a folder of JSON
 * files is the only place a user can tell them apart.
 */
export function envelopeFileName(prefix: string, exportedAt: string): string {
  const stamp = exportedAt.replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
  return `${prefix}-${stamp}-encrypted.json`
}

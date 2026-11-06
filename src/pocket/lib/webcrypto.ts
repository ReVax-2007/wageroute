/**
 * The phone's crypto, in the shapes both of its ciphers need.
 *
 * The export envelope (`envelope.ts`) and the vault on this device (`vault.ts`)
 * are different things with one requirement in common: the key must come out the
 * same way every time a particular passphrase is typed. So the pieces that decide
 * that — how the phrase is encoded, which hash PBKDF2 runs over, where the GCM tag
 * lives — live here instead of inside either caller, where they could drift.
 *
 * PBKDF2 rather than scrypt because this side has no choice: WebCrypto implements
 * PBKDF2 and nothing else memory-hard. An export that a desktop can write but a
 * phone cannot read is not an export, and a vault the phone cannot open is not a
 * vault, so the KDF is set by the platform and the iteration count pays for it.
 */
import {
  IV_BYTES,
  KEY_BYTES,
  TAG_BYTES,
  EnvelopeError,
  fromBase64,
  toBase64
} from '@shared/envelope'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** What a derived key is allowed to do. */
export type KeyUsage = 'encrypt' | 'decrypt'

export function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(length))
}

/**
 * The one sentence for a page that has no cipher.
 *
 * `crypto.subtle` is exposed only in a secure context, so `http://192.168.x.x` —
 * the address [POCKET.md](../../../docs/POCKET.md) already names as the shape that
 * installs nothing — gives an app that can read its own storage and cannot seal or
 * open a thing. `getRandomValues` survives there; the cipher does not. This is the
 * difference between telling the person what to do and letting them meet
 * `undefined is not an object`.
 */
export const NO_CIPHER_HERE =
  'This page has no cipher: a browser lends WageRoute its crypto only over HTTPS, or on the machine the app is running on. Open it that way, or carry the plain export.'

/** Whether this page can seal or open anything at all. Screens ask this before they offer either. */
export function hasCipher(): boolean {
  return typeof crypto?.subtle === 'object'
}

/**
 * Every call here goes through this, so no caller can meet the raw `undefined`.
 *
 * The return type is left to inference for the same reason `SessionKey` below is:
 * browsers declare `SubtleCrypto` as a type and Node only as a value, and this file
 * is compiled under both.
 */
function subtle() {
  const c = crypto?.subtle
  if (!c) throw new EnvelopeError('shape', NO_CIPHER_HERE)
  return c
}

/**
 * Stretch a passphrase into an AES-256 key.
 *
 * The return type is left to inference; `SessionKey` explains why it cannot be
 * written out.
 */
export async function deriveKey(
  passphrase: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
  usages: KeyUsage[]
) {
  if (passphrase === '') {
    throw new EnvelopeError('passphrase', 'Type the passphrase this was sealed with.')
  }
  const base = await subtle().importKey('raw', encoder.encode(passphrase), 'PBKDF2', false, [
    'deriveKey'
  ])
  // Non-extractable: the derived key is useful while this data is being read and
  // cannot be written out afterwards, which is the difference between a
  // passphrase that guards the data and one that merely sits next to it.
  return subtle().deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: KEY_BYTES * 8 },
    false,
    usages
  )
}

/**
 * The key one of these calls hands back, read off the call that makes it.
 *
 * Written this way rather than as `CryptoKey` because browsers declare that name
 * as a type and Node only as a value, and these files compile in both: a test in
 * the main process that seals a phone's envelope is checked under Node's types,
 * where the annotation would not resolve.
 */
export type SessionKey = Awaited<ReturnType<typeof deriveKey>>

/** The widened `Uint8Array` is not a `BufferSource`; WebCrypto wants a view over a plain `ArrayBuffer`. */
function concat(first: Uint8Array, second: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(first.length + second.length)
  out.set(first)
  out.set(second, first.length)
  return out
}

/** Text sealed with AES-256-GCM: the three fields a reader needs, each already base64. */
export interface SealedPart {
  iv: string
  tag: string
  ciphertext: string
}

/**
 * Seal text with an already-derived key.
 *
 * A fresh initial vector on every call, because one key sealing two saves with
 * the same IV would leak. WebCrypto hands back ciphertext with the GCM tag
 * appended and takes the same shape in, while the stored form keeps them apart so
 * a reader never has to guess where one ends.
 */
export async function sealPart(key: SessionKey, plaintext: string): Promise<SealedPart> {
  const cipher = subtle()
  const iv = randomBytes(IV_BYTES)
  const sealed = new Uint8Array(
    await cipher.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(plaintext))
  )
  return {
    iv: toBase64(iv),
    tag: toBase64(sealed.subarray(sealed.length - TAG_BYTES)),
    ciphertext: toBase64(sealed.subarray(0, sealed.length - TAG_BYTES))
  }
}

/**
 * Open a sealed part, or return null.
 *
 * Null means the authentication tag did not check out, which is all the cipher can
 * tell: a wrong passphrase and a damaged file look identical from inside, so each
 * caller decides what its user hears and whether typing again can help. That is
 * why the missing cipher is refused *before* the try: it is a third thing, and a
 * page with no crypto would otherwise be reported as a wrong passphrase someone
 * should type again.
 */
export async function openPart(key: SessionKey, part: SealedPart): Promise<string | null> {
  const cipher = subtle()
  try {
    const plain = await cipher.decrypt(
      { name: 'AES-GCM', iv: fromBase64(part.iv, 'initial vector') },
      key,
      concat(fromBase64(part.ciphertext, 'encrypted contents'), fromBase64(part.tag, 'authentication tag'))
    )
    return decoder.decode(plain)
  } catch {
    return null
  }
}

/**
 * A raw 32-byte data key, made usable and then sealed off: non-extractable, so
 * once imported the bytes cannot be read back out of the key object. The caller
 * zeroes its copy of the raw bytes as soon as this returns.
 */
export async function importDataKey(raw: Uint8Array<ArrayBuffer>, usages: KeyUsage[]): Promise<SessionKey> {
  return subtle().importKey('raw', raw, { name: 'AES-GCM', length: KEY_BYTES * 8 }, false, usages)
}

/** The same domain-separation label the desktop's key file uses for a passkey wrap. */
const PRF_INFO = encoder.encode('wageroute data-key wrap')

/**
 * Turn a passkey's PRF output into a key that only wraps. HKDF rather than using
 * the output directly, so the stored salt — not the authenticator — decides which
 * key a given wrap is under.
 */
export async function deriveKeyFromPrf(
  prfOutput: Uint8Array<ArrayBuffer>,
  hkdfSalt: Uint8Array<ArrayBuffer>,
  usages: KeyUsage[]
): Promise<SessionKey> {
  const base = await subtle().importKey('raw', prfOutput, 'HKDF', false, ['deriveKey'])
  return subtle().deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: hkdfSalt, info: PRF_INFO },
    base,
    { name: 'AES-GCM', length: KEY_BYTES * 8 },
    false,
    usages
  )
}

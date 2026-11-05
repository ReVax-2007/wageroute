/**
 * Opening a sealed export on the phone, with the browser's own crypto.
 *
 * This is the other half of `src/main/envelope.ts`. The desktop seals a backup
 * with Node, the phone opens it with `crypto.subtle`, and the only thing that
 * makes that work is both sides agreeing on more than the format: the encoding
 * of the passphrase, the byte order of the cipher, and — the one that bites —
 * where the GCM tag lives. WebCrypto hands back ciphertext with the tag appended
 * and takes the same shape in, while Node keeps the tag in its own field.
 * `TAG_BYTES` is the seam between the two, and the interop test is what proves
 * the seam is cut in the right place.
 *
 * The key stretching and the cipher themselves live in `webcrypto.ts`, shared
 * with the vault on this device (`vault.ts`): two implementations of PBKDF2 on
 * one phone is one too many. What stays here is the envelope header — the fields
 * a desktop-written file carries in the clear, and the guard rails around them.
 */
import {
  DEFAULT_ITERATIONS,
  ENVELOPE_FORMAT,
  ENVELOPE_VERSION,
  SALT_BYTES,
  EnvelopeError,
  fromBase64,
  parseEnvelope,
  toBase64,
  type EncryptedEnvelope,
  type EnvelopeContent
} from '@shared/envelope'
import { deriveKey, openPart, randomBytes, sealPart } from './webcrypto'

export async function sealEnvelope(
  plaintext: string,
  passphrase: string,
  options: { contains?: EnvelopeContent; exportedAt?: string; iterations?: number } = {}
): Promise<EncryptedEnvelope> {
  const iterations = options.iterations ?? DEFAULT_ITERATIONS
  const salt = randomBytes(SALT_BYTES)
  const key = await deriveKey(passphrase, salt, iterations, ['encrypt'])
  const part = await sealPart(key, plaintext)
  return {
    format: ENVELOPE_FORMAT,
    version: ENVELOPE_VERSION,
    contains: options.contains ?? 'backup',
    exportedAt: options.exportedAt ?? new Date().toISOString(),
    kdf: 'PBKDF2-SHA256',
    iterations,
    cipher: 'AES-256-GCM',
    salt: toBase64(salt),
    iv: part.iv,
    tag: part.tag,
    ciphertext: part.ciphertext
  }
}

export async function openEnvelopeText(
  envelope: EncryptedEnvelope,
  passphrase: string
): Promise<string> {
  const key = await deriveKey(
    passphrase,
    fromBase64(envelope.salt, 'salt'),
    envelope.iterations,
    ['decrypt']
  )
  const opened = await openPart(key, {
    iv: envelope.iv,
    tag: envelope.tag,
    ciphertext: envelope.ciphertext
  })
  if (opened === null) {
    throw new EnvelopeError(
      'passphrase',
      'That passphrase does not open this file, or the file has been changed since it was written.'
    )
  }
  return opened
}

/** Read a file's text: parse the envelope, then open it. */
export async function openEnvelopeFileText(text: string, passphrase: string): Promise<string> {
  return openEnvelopeText(parseEnvelope(text), passphrase)
}

/**
 * Sealing and opening an export envelope with Node's crypto, on the desktop.
 *
 * The shape of the file lives in `@shared/envelope`, which both devices read and
 * neither can put crypto in — so this is the desktop half of the pair, and
 * `src/pocket/lib/envelope.ts` is the other. Both are thin on purpose: PBKDF2 and
 * AES-256-GCM are the primitives, and the only judgement here is which bytes to
 * randomise, what to refuse, and how a wrong passphrase comes back.
 *
 * There is no key file, no keychain and no custody here, and that is deliberate.
 * An envelope is meant to be readable somewhere this app has never been — a
 * phone, another computer, a filing cabinet — so it can only ever be opened by
 * something a person can carry in their head. That is also the warning the
 * screen has to give: a lost phrase loses this file, with no second way in the
 * way the ledger's custody has.
 *
 * The header is not authenticated as additional data, and does not need to be:
 * the salt and the iteration count feed the key derivation, so tampering with
 * either produces a different key and the GCM tag fails. The tag therefore
 * covers the whole promise of the file without a second contract both platforms
 * would have to byte-match.
 */
import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { todayISO } from '@shared/dates'
import {
  DEFAULT_ITERATIONS,
  ENVELOPE_FORMAT,
  ENVELOPE_VERSION,
  IV_BYTES,
  KEY_BYTES,
  SALT_BYTES,
  EnvelopeError,
  envelopeFileName,
  envelopeToJson,
  fromBase64,
  parseEnvelope,
  toBase64,
  type EncryptedEnvelope,
  type EnvelopeContent
} from '@shared/envelope'

/**
 * Wrap a backup's JSON in a passphrase. `iterations` exists so a test can seal
 * cheaply; production always takes the default, and the number written into the
 * file is the number the opener is obliged to honour.
 */
export function sealEnvelope(
  plaintext: string,
  passphrase: string,
  options: { contains?: EnvelopeContent; exportedAt?: string; iterations?: number } = {}
): EncryptedEnvelope {
  const exportedAt = options.exportedAt ?? new Date().toISOString()
  const iterations = options.iterations ?? DEFAULT_ITERATIONS
  const salt = randomBytes(SALT_BYTES)
  const iv = randomBytes(IV_BYTES)
  const key = deriveKey(passphrase, salt, iterations)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return {
    format: ENVELOPE_FORMAT,
    version: ENVELOPE_VERSION,
    contains: options.contains ?? 'backup',
    exportedAt,
    kdf: 'PBKDF2-SHA256',
    iterations,
    cipher: 'AES-256-GCM',
    salt: toBase64(new Uint8Array(salt)),
    iv: toBase64(new Uint8Array(iv)),
    tag: toBase64(new Uint8Array(cipher.getAuthTag())),
    ciphertext: toBase64(new Uint8Array(ciphertext))
  }
}

/**
 * What an export of this backup should look like on disk: the bytes, the name
 * they belong under, and the label of the file filter. Kept as one decision so
 * the sealed file's name, its header and the JSON inside it cannot disagree about
 * when the ledger was read, and so the choice is testable without a save dialog.
 */
export interface ExportFile {
  text: string
  defaultPath: string
  filterName: string
}

export function exportFileOf(
  backupJson: string,
  exportedAt: string,
  passphrase: string | null,
  documentsDir: string
): ExportFile {
  if (passphrase === null) {
    // The plain name keeps the owner's local day, not the UTC one, because an
    // evening export used to be stamped with tomorrow's date.
    return {
      text: backupJson,
      defaultPath: join(documentsDir, `wageroute-backup-${todayISO()}.json`),
      filterName: 'JSON backup'
    }
  }
  return {
    text: envelopeToJson(sealEnvelope(backupJson, passphrase, { exportedAt })),
    defaultPath: join(documentsDir, envelopeFileName('wageroute-backup', exportedAt)),
    filterName: 'Encrypted JSON backup'
  }
}

/** The JSON text inside a sealed envelope, or the reason it stayed shut. */
export function openEnvelopeText(envelope: EncryptedEnvelope, passphrase: string): string {
  const key = deriveKey(
    passphrase,
    Buffer.from(fromBase64(envelope.salt, 'salt')),
    envelope.iterations
  )
  const decipher = createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(fromBase64(envelope.iv, 'initial vector'))
  )
  decipher.setAuthTag(Buffer.from(fromBase64(envelope.tag, 'tag')))
  const input = Buffer.from(fromBase64(envelope.ciphertext, 'ciphertext'))
  try {
    return Buffer.concat([decipher.update(input), decipher.final()]).toString('utf8')
  } catch {
    // GCM's tag check is the only answer this can give, and it is a complete one:
    // either the phrase is wrong or the file has been altered. Nothing here can
    // tell which, and pretending otherwise would be a guess at the user's expense.
    throw new EnvelopeError(
      'passphrase',
      'That passphrase does not open this file, or the file has been changed since it was written.'
    )
  }
}

/** Read a file's text: parse the envelope, then open it. */
export function openEnvelopeFileText(text: string, passphrase: string): string {
  return openEnvelopeText(parseEnvelope(text), passphrase)
}

/**
 * PBKDF2-HMAC-SHA-256, the one construction WebCrypto also implements, so a file
 * sealed here opens on a phone. The passphrase is used exactly as typed and read
 * as UTF-8, because the desktop ledger key file makes the same promise and a
 * person copying a phrase between the two must get the same key both times.
 */
function deriveKey(passphrase: string, salt: Buffer, iterations: number): Buffer {
  if (passphrase === '') {
    throw new EnvelopeError('passphrase', 'Type the passphrase this file was sealed with.')
  }
  return pbkdf2Sync(Buffer.from(passphrase, 'utf8'), salt, iterations, KEY_BYTES, 'sha256')
}

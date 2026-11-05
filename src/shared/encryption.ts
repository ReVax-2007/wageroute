/**
 * Encryption at rest, in the terms the user is offered it.
 *
 * Two things live here. The wire types, because the renderer and the main
 * process must not disagree about what an encrypted ledger reports. And the
 * honesty table: every custody option states what it protects against, what it
 * does *not*, and how it can lock the owner out. ADR 0020's rule is that the app
 * must not imply protection it does not provide, and a toggle that only says
 * "Encrypt" implies plenty. So the three columns are part of the type, an option
 * without all three is a build error, and the Settings screen renders them.
 *
 * Nothing here is secret and nothing here is a key. The wraps themselves — the
 * sealed bytes, the salts, the scrypt parameters — belong to the main process
 * (`db/ledger-key.ts`), and this module is shared with the phone build, which
 * must never see them.
 */

/** How the ledger's key is held. `both` means either one unlocks; it is not a second factor. */
export type CustodyMethod = 'device' | 'passphrase' | 'both'

/**
 * What the folder reports right now. `encrypted` is read from the file header —
 * the only evidence that is actually about the pages — while `device`,
 * `passphrase` and `pending` come from the marker beside it. When the two
 * disagree, `staleKeyFile` says so.
 */
export interface EncryptionStatus {
  encrypted: boolean
  cipher: string | null
  device: boolean
  passphrase: boolean
  /** A change that started and never reported back. The next launch finishes deciding. */
  pending: 'encrypt' | 'decrypt' | null
  /** A key file sits over a ledger whose pages are plaintext: a crashed decrypt. */
  staleKeyFile: boolean
  /** Whether *this* machine can offer the keychain at all, so the option can be refused honestly. */
  deviceAvailable: boolean
}

export interface EnableEncryptionRequest {
  custody: CustodyMethod
  /** Required for `passphrase` and `both`. Used once, to wrap the key — never stored. */
  passphrase?: string
}

/**
 * The answer to a change of encryption state. Both directions end the session:
 * the transition must run with the app's own handle closed, and the handle is
 * bound to the state it opened in, so the only honest continuation is a restart.
 */
export interface EncryptionChange {
  /** Whether the pages changed, or the ledger is as it was before the attempt. */
  applied: boolean
  rows: number
  restartRequired: true
}

/**
 * Re-wrapping the same 32 bytes. None of these rewrite a page or touch the
 * ledger, which is why custody can change as often as the user wants: adding a
 * passphrase to a device-held key costs one AES-GCM seal.
 */
export type KeyCustodyChange =
  | { action: 'add-device' }
  | { action: 'remove-device' }
  | { action: 'add-passphrase'; passphrase: string }
  | { action: 'remove-passphrase' }
  | { action: 'change-passphrase'; current: string; next: string }

export const MIN_PASSPHRASE_CHARACTERS = 10
/** A bound on the input, not a security claim — scrypt costs the same whatever the length. */
export const MAX_PASSPHRASE_CHARACTERS = 1024

/**
 * The one place the passphrase rule lives, so the field and the main process
 * cannot disagree. Deliberately not a strength meter: length is the only part
 * the app can check, and the copy says why — a wrong phrase is refused by the
 * wrap, but a *short* one is only found later by someone holding the file.
 *
 * `opens` names what the phrase guards, because the same rule now covers an
 * exported file as well as the ledger, and a screen that talks about "the
 * ledger" while the user seals a backup is describing the wrong object.
 */
export function passphraseProblem(passphrase: string, opens = 'the ledger'): string | null {
  if (passphrase.length === 0) return `Choose a passphrase — it is the only thing that opens ${opens}.`
  if (passphrase.length < MIN_PASSPHRASE_CHARACTERS) {
    return `A passphrase needs at least ${MIN_PASSPHRASE_CHARACTERS} characters. Whoever has a copy of the file can test guesses offline, at their own speed, and a short one runs out fast.`
  }
  if (passphrase.length > MAX_PASSPHRASE_CHARACTERS) {
    return `A passphrase longer than ${MAX_PASSPHRASE_CHARACTERS} characters is not one you will type again correctly.`
  }
  // "aaaaaaaaaa" meets the length and protects nothing.
  if (/^(.)\1+$/.test(passphrase)) return 'One character repeated is not a passphrase.'
  return null
}

export interface CustodyCopy {
  value: CustodyMethod
  /** The option as it appears in the picker. */
  label: string
  headline: string
  /** What it is actually good against. */
  protects: string
  /** What it does not stop, in the same sentence-level plain language. */
  fails: string
  /** How the owner can be locked out, including "they cannot". */
  lockout: string
}

export const CUSTODY_COPY: readonly CustodyCopy[] = [
  {
    value: 'device',
    label: 'This computer',
    headline: 'The key is kept in this computer’s own keychain and never written to your ledger folder.',
    protects:
      'A copy of the folder going anywhere it should not — a stolen backup, a synced drive, a USB stick. ' +
      'The sealed key it holds opens only on this computer and only for your login.',
    fails:
      'Anyone using this computer while you are signed in. The keychain cannot tell WageRoute from another ' +
      'program you ran, so an unlocked session is an open ledger — and OS disk encryption, if you have it, ' +
      'already covers this ground.',
    lockout: 'None. Signing in to this computer stays the door. If the machine dies, the ledger dies with it.'
  },
  {
    value: 'passphrase',
    label: 'A passphrase',
    headline: 'Nothing on this computer can open the ledger until you type the phrase.',
    protects:
      'Anyone who has the file but not the phrase — including this very computer, until you type it. It is the ' +
      'only option that survives the machine being seized, lost or read by someone else who logs in as you.',
    fails:
      'A short or common phrase. Whoever holds the file can test guesses against it offline, with no attempt ' +
      'limit and no lockout — WageRoute cannot slow them down once the folder is copied. This app puts no ' +
      'limit on guesses of its own; the phrase is the whole defence.',
    lockout:
      'Total. A forgotten passphrase means the ledger is gone for good: there is no reset, no recovery ' +
      'service and nobody holding a copy of it but you.'
  },
  {
    value: 'both',
    label: 'Both',
    headline: 'Either one opens it: the keychain on this computer, or the phrase you type.',
    protects:
      'Everything the other two protect against, together. It is the option that survives a broken computer — ' +
      'the phrase opens the ledger elsewhere — and a forgotten phrase — this computer still opens.',
    fails:
      'Both weaknesses stay. This computer still opens the ledger without asking, and a weak phrase is still ' +
      'crackable offline from any copy of the file.',
    lockout: 'Only if both are lost: this machine breaks or is wiped, and the phrase is forgotten.'
  }
]

export function custodyCopy(method: CustodyMethod): CustodyCopy {
  const copy = CUSTODY_COPY.find((entry) => entry.value === method)
  if (!copy) throw new Error(`No custody copy for ${String(method)}`)
  return copy
}

/** Which custody a status report describes, for the screen that shows the current state. */
export function custodyInUse(status: Pick<EncryptionStatus, 'device' | 'passphrase'>): CustodyMethod | null {
  if (status.device && status.passphrase) return 'both'
  if (status.device) return 'device'
  if (status.passphrase) return 'passphrase'
  return null
}

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

/**
 * How the ledger's key is held when encryption is first turned on. `both` means
 * either one unlocks; it is not a second factor. A PIN and a passkey are added
 * afterwards, from the same card, as further wraps of the same key (ADR 0031).
 */
export type CustodyMethod = 'device' | 'passphrase' | 'both'

/**
 * Every way into the same 32-byte data key. Any one of them opens it; none of
 * them is a second factor. `passkey` is a fingerprint or face held by the
 * platform authenticator, read through WebAuthn PRF (ADR 0031).
 */
export type WrapKind = 'device' | 'passphrase' | 'pin' | 'passkey'

/**
 * The wraps that may hold a ledger on their own. A passkey is never one of them:
 * a lost authenticator, a reset TPM or a deleted credential must never be the
 * end of the ledger, so the owner decided a passkey is always one more way in
 * and never the only door (ADR 0031).
 */
export const STANDING_WRAPS: readonly WrapKind[] = ['device', 'passphrase', 'pin']

/** True when these wraps include at least one that may stand alone. */
export function hasStandingWrap(wraps: Partial<Record<WrapKind, boolean>>): boolean {
  return STANDING_WRAPS.some((kind) => wraps[kind] === true)
}

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
  pin: boolean
  passkey: boolean
  /** A change that started and never reported back. The next launch finishes deciding. */
  pending: 'encrypt' | 'decrypt' | null
  /** A key file sits over a ledger whose pages are plaintext: a crashed decrypt. */
  staleKeyFile: boolean
  /** Whether *this* machine can offer the keychain at all, so the option can be refused honestly. */
  deviceAvailable: boolean
  /**
   * Whether this platform is one where a fingerprint or face wrap can be tried at
   * all. Only a pre-filter: the offer is real only once a registration returns PRF
   * output and a second assertion opens the wrap it made.
   */
  passkeyOffered: boolean
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
  | { action: 'add-pin'; pin: string }
  | { action: 'remove-pin' }
  | { action: 'change-pin'; current: string; next: string }
  /** The main process runs the WebAuthn ceremony itself; nothing secret crosses from the renderer. */
  | { action: 'add-passkey' }
  | { action: 'remove-passkey' }

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

/**
 * A PIN is digits only, at least six of them. That is the whole rule, because
 * the honest thing about a PIN is not its strength: a million six-digit values is
 * a search a copied file finishes offline. The owner chose to offer it anyway,
 * off by default and with that sentence shown before it is saved (ADR 0031).
 */
export const MIN_PIN_DIGITS = 6
export const MAX_PIN_DIGITS = 32

export function pinProblem(pin: string): string | null {
  if (pin.length === 0) return 'Choose a PIN of at least 6 digits.'
  if (!/^[0-9]+$/.test(pin)) return 'A PIN is digits only. For letters or spaces, use a passphrase instead.'
  if (pin.length < MIN_PIN_DIGITS) return `A PIN needs at least ${MIN_PIN_DIGITS} digits.`
  if (pin.length > MAX_PIN_DIGITS) return `A PIN longer than ${MAX_PIN_DIGITS} digits is a passphrase; use one instead.`
  if (/^(.)\1+$/.test(pin)) return 'One digit repeated is not a PIN.'
  return null
}

/**
 * The warning a PIN carries wherever it is offered, in one place so the desktop
 * card and the phone sheet cannot soften it differently.
 */
export const PIN_WARNING =
  'Anyone with a copy of the file can try every PIN offline, at their own speed, with no attempt limit — ' +
  'a six-digit PIN is a million guesses, and WageRoute cannot slow a copied file down. A PIN only keeps ' +
  'out someone who does not have the file.'

export interface CustodyCopy {
  value: CustodyMethod | 'pin' | 'passkey'
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
  },
  {
    value: 'pin',
    label: 'A PIN',
    headline: 'A number you type instead of a phrase. Quicker to enter, and much weaker against a copied file.',
    protects:
      'Someone who has neither the file nor the PIN — a glance at an unlocked screen does not reveal it, and ' +
      'a ledger that is only ever on this computer is still keyed.',
    fails: PIN_WARNING,
    lockout:
      'Total, if it is the only way in. A forgotten PIN means the ledger is gone for good: there is no reset ' +
      'and no recovery service. Keep a passphrase or this computer alongside it.'
  },
  {
    value: 'passkey',
    label: 'Fingerprint or face',
    headline: 'Windows Hello opens the ledger with your fingerprint, face or device PIN. It is never the only way in.',
    protects:
      'A copy of the folder anywhere else, and another program running as you on this computer: the key is ' +
      'released by a passkey only WageRoute asked for, and only after Windows checks your finger, face or PIN.',
    fails:
      'Anyone who knows this computer’s Windows Hello PIN — Windows accepts it in place of a fingerprint — and ' +
      'anyone at your open, unlocked WageRoute window. It is no stronger than the device PIN behind it.',
    lockout:
      'None on its own: WageRoute never lets it be the only way in, so the keychain, passphrase or PIN beside ' +
      'it still opens the ledger if the passkey is deleted, the TPM is reset or the computer is replaced.'
  }
]

export function custodyCopy(method: CustodyCopy['value']): CustodyCopy {
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

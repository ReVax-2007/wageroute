/**
 * The WebAuthn ceremony that turns a fingerprint or face into a 32-byte secret.
 *
 * One function, used twice. The phone calls it directly in its own page. The
 * desktop has no WebAuthn origin in its ledger window (`file://` is refused), so
 * it opens a small window of its own on `http://localhost`, answered from memory
 * by `protocol.handle`, and runs this same function there through
 * `executeJavaScript`. That is why it is **self-contained**: no import, no helper
 * outside its own body, nothing but browser globals — its source text is what
 * travels to the desktop's ceremony page.
 *
 * What comes back is the PRF output (the authenticator's HMAC over `prfSalt`),
 * base64. It is a secret: it opens the wrap it sealed. It never leaves the device
 * that produced it; the desktop hands it straight to the main process, which
 * derives a key from it and forgets it (ADR 0031).
 *
 * Registration asks for two independent answers — one from the create (or a first
 * assertion, if the platform does not answer at create time) and one from a second
 * assertion — so the caller can seal with the first and prove with the second.
 * A platform that claims PRF and does not hand the same secret back twice is
 * refused before anything is written.
 */

export interface PasskeyRegisterRequest {
  mode: 'register'
  rpId: string
  /** PRF `eval.first`, base64. */
  prfSalt: string
  userName: string
  /** Require the computer's own authenticator (Windows Hello) rather than a phone or a key. */
  platformOnly: boolean
}

export interface PasskeyAssertRequest {
  mode: 'assert'
  rpId: string
  prfSalt: string
  /** base64url, as WebAuthn reports it. */
  credentialId: string
}

export type PasskeyRequest = PasskeyRegisterRequest | PasskeyAssertRequest

/** `unsupported` and `cancelled` are answers a screen can act on; `failed` carries the platform's words. */
export type PasskeyFailure = 'unsupported' | 'cancelled' | 'failed'

export type PasskeyAnswer =
  | { ok: true; mode: 'register'; credentialId: string; first: string; test: string }
  | { ok: true; mode: 'assert'; output: string }
  | { ok: false; reason: PasskeyFailure; detail: string }

/*
 * The few browser shapes this needs, declared here rather than taken from the DOM
 * library: `src/shared` is also compiled for the main process, which has no DOM
 * types. These are module-scoped, so in a browser build they shadow nothing at run
 * time — `declare` emits no code, and the names resolve to the page's own globals.
 */
interface PrfOutput {
  enabled?: boolean
  results?: { first?: ArrayBuffer | ArrayBufferView }
}
interface WebAuthnCredential {
  id: string
  getClientExtensionResults(): { prf?: PrfOutput }
}
declare const navigator: {
  credentials?: { create(options: unknown): Promise<unknown>; get(options: unknown): Promise<unknown> }
}
declare const PublicKeyCredential:
  | {
      isUserVerifyingPlatformAuthenticatorAvailable(): Promise<boolean>
      getClientCapabilities?: () => Promise<Record<string, boolean>>
    }
  | undefined

export async function runPasskeyCeremony(request: PasskeyRequest): Promise<PasskeyAnswer> {
  const toBytes = (b64: string): Uint8Array => {
    const normal = b64.replace(/-/g, '+').replace(/_/g, '/')
    const padded = normal + '='.repeat((4 - (normal.length % 4)) % 4)
    return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0))
  }
  const toBase64 = (buffer: ArrayBuffer): string => {
    let text = ''
    for (const byte of new Uint8Array(buffer)) text += String.fromCharCode(byte)
    return btoa(text)
  }
  const fail = (reason: PasskeyFailure, detail: string): PasskeyAnswer => ({ ok: false, reason, detail })
  const explain = (error: unknown): PasskeyAnswer => {
    const name = error instanceof Error ? error.name : ''
    const message = error instanceof Error ? error.message : String(error)
    // NotAllowedError covers "the person said no" and "it timed out": both mean
    // the same thing to the caller — fall back to what can be typed.
    if (name === 'NotAllowedError' || name === 'AbortError') return fail('cancelled', message)
    if (name === 'NotSupportedError' || name === 'SecurityError') return fail('unsupported', message)
    return fail('failed', message)
  }
  const prfOf = (credential: unknown): string | null => {
    const first = (credential as WebAuthnCredential | null)?.getClientExtensionResults().prf?.results?.first
    if (!first) return null
    const bytes =
      first instanceof ArrayBuffer
        ? first
        : (first.buffer.slice(first.byteOffset, first.byteOffset + first.byteLength) as ArrayBuffer)
    return bytes.byteLength === 32 ? toBase64(bytes) : null
  }
  const credentials = navigator.credentials
  const assert = async (credentialId: string): Promise<string | null> =>
    prfOf(
      await credentials?.get({
        publicKey: {
          rpId: request.rpId,
          challenge: crypto.getRandomValues(new Uint8Array(32)),
          allowCredentials: [{ type: 'public-key', id: toBytes(credentialId) }],
          userVerification: 'required',
          timeout: 120_000,
          extensions: { prf: { eval: { first: toBytes(request.prfSalt) } } }
        }
      })
    )

  if (typeof PublicKeyCredential === 'undefined' || !credentials) {
    return fail('unsupported', 'This browser has no passkeys.')
  }
  const platform = PublicKeyCredential

  if (request.mode === 'assert') {
    try {
      const output = await assert(request.credentialId)
      return output ? { ok: true, mode: 'assert', output } : fail('unsupported', 'The passkey gave back no secret.')
    } catch (error) {
      return explain(error)
    }
  }

  if (request.platformOnly && !(await platform.isUserVerifyingPlatformAuthenticatorAvailable())) {
    return fail('unsupported', 'This computer offers no fingerprint or face check to this app.')
  }
  if (typeof platform.getClientCapabilities === 'function') {
    const known = await platform.getClientCapabilities().catch(() => ({}) as Record<string, boolean>)
    if (known['extension:prf'] === false) return fail('unsupported', 'This browser cannot derive a key from a passkey.')
  }

  try {
    const created = (await credentials.create({
      publicKey: {
        rp: { id: request.rpId, name: 'WageRoute' },
        user: {
          id: crypto.getRandomValues(new Uint8Array(16)),
          name: request.userName,
          displayName: request.userName
        },
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        pubKeyCredParams: [
          { type: 'public-key', alg: -7 },
          { type: 'public-key', alg: -257 }
        ],
        authenticatorSelection: {
          ...(request.platformOnly ? { authenticatorAttachment: 'platform' } : {}),
          residentKey: 'preferred',
          userVerification: 'required'
        },
        timeout: 120_000,
        extensions: { prf: { eval: { first: toBytes(request.prfSalt) } } }
      }
    })) as WebAuthnCredential | null
    if (!created) return fail('cancelled', 'No passkey was made.')
    if (created.getClientExtensionResults().prf?.enabled !== true) {
      return fail('unsupported', 'This passkey cannot derive a key, so it cannot hold one.')
    }
    const first = prfOf(created) ?? (await assert(created.id))
    if (!first) return fail('unsupported', 'The passkey was made but gave back no secret.')
    const test = await assert(created.id)
    if (!test) return fail('unsupported', 'The passkey gave a secret once and not a second time.')
    return { ok: true, mode: 'register', credentialId: created.id, first, test }
  } catch (error) {
    return explain(error)
  }
}

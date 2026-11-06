import { randomBytes } from 'node:crypto'
import { BrowserWindow, session, type Session } from 'electron'
import { runPasskeyCeremony, type PasskeyAnswer, type PasskeyRequest } from '@shared/passkey-ceremony'
import { PRF_OUTPUT_BYTES, type PasskeyWrap } from './db/ledger-key'
import type { PasskeyEnrolment } from './db/custody'
import { logNote } from './log'

/**
 * The small window where a fingerprint or face check happens on the desktop.
 *
 * WebAuthn needs an origin it accepts, and the ledger window has none: the
 * packaged renderer is `file://`, which Chromium refuses outright (measured in
 * the ADR 0031 spike). So this window lives in a session of its own, in memory
 * only, whose `http` scheme is answered by `protocol.handle` — `http://localhost`
 * without a socket, so no other process on this machine can reach the page. The
 * page has no preload, no Node, no IPC: the main process runs the ceremony in it
 * with `executeJavaScript` and gets back a PRF output, which it turns into a key
 * and forgets.
 *
 * `app.configureWebAuthn` is deliberately not called. On macOS that is the only
 * way Electron offers Touch ID, and it needs a signed build with an Apple Team ID
 * the owner chose not to get; without it the ceremony reports "unsupported" and
 * nothing is offered. On Windows, Chromium reaches Windows Hello on its own.
 */

const PARTITION = 'wageroute-passkey'
export const PASSKEY_RP_ID = 'localhost'
const PAGE_URL = `http://${PASSKEY_RP_ID}/passkey`

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>WageRoute</title>
<style>
  body { margin: 0; font: 14px/1.5 system-ui, sans-serif; background: #0b0e14; color: #e6e9ef; display: grid; place-items: center; min-height: 100vh; }
  main { max-width: 340px; padding: 24px; text-align: center; }
  h1 { font-size: 16px; margin: 0 0 8px; }
  p { margin: 0; color: #a3abba; }
</style></head>
<body><main><h1>Confirm it is you</h1>
<p>Windows will ask for your fingerprint, face or PIN. Cancel, or close this window, to type a passphrase or PIN instead.</p>
</main></body></html>`

function ceremonySession(): Session {
  const ses = session.fromPartition(PARTITION)
  if (!ses.protocol.isProtocolHandled('http')) {
    ses.protocol.handle('http', (request) =>
      new URL(request.url).hostname === PASSKEY_RP_ID
        ? new Response(PAGE, {
            headers: {
              'content-type': 'text/html; charset=utf-8',
              // The page runs no script of its own; the ceremony arrives from the main process.
              'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'"
            }
          })
        : new Response(null, { status: 404 })
    )
    ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  }
  return ses
}

/**
 * Run one ceremony in a window of its own. Closing the window is an answer —
 * `cancelled` — never a hang: the launch is waiting on this.
 */
export async function runPasskeyWindow(request: PasskeyRequest, parent?: BrowserWindow | null): Promise<PasskeyAnswer> {
  const window = new BrowserWindow({
    width: 420,
    height: 240,
    resizable: false,
    minimizable: false,
    maximizable: false,
    show: false,
    title: 'WageRoute — confirm it is you',
    backgroundColor: '#0b0e14',
    ...(parent ? { parent, modal: true } : {}),
    webPreferences: {
      session: ceremonySession(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: false
    }
  })
  window.removeMenu()
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())

  const closed = new Promise<PasskeyAnswer>((resolve) =>
    window.once('closed', () => resolve({ ok: false, reason: 'cancelled', detail: 'The window was closed.' }))
  )
  try {
    await window.loadURL(PAGE_URL)
    window.show()
    window.focus()
    const ran = window.webContents.executeJavaScript(
      `(${runPasskeyCeremony.toString()})(${JSON.stringify(request)})`,
      true
    ) as Promise<PasskeyAnswer>
    return await Promise.race([ran, closed])
  } catch (error) {
    // A window closed mid-call rejects here too; either way nothing was released.
    return { ok: false, reason: 'cancelled', detail: error instanceof Error ? error.message : String(error) }
  } finally {
    if (!window.isDestroyed()) window.close()
  }
}

/** Why a registration did not produce a wrap, in the words the Settings card shows. */
export class PasskeyUnavailableError extends Error {
  readonly code = 'PASSKEY_UNAVAILABLE'
  constructor(answer: Extract<PasskeyAnswer, { ok: false }>) {
    super(
      answer.reason === 'cancelled'
        ? 'The fingerprint or face check was cancelled, so nothing was changed.'
        : `This computer cannot hold the ledger’s key with a fingerprint or face: ${answer.detail} Nothing was changed.`
    )
    this.name = 'PasskeyUnavailableError'
  }
}

/** Register a passkey and collect the two independent answers custody needs to seal and prove a wrap. */
export async function enrolPasskey(parent?: BrowserWindow | null): Promise<PasskeyEnrolment> {
  const prfSalt = randomBytes(32)
  const answer = await runPasskeyWindow(
    {
      mode: 'register',
      rpId: PASSKEY_RP_ID,
      prfSalt: prfSalt.toString('base64'),
      userName: 'WageRoute ledger',
      platformOnly: true
    },
    parent
  )
  if (!answer.ok) throw new PasskeyUnavailableError(answer)
  if (answer.mode !== 'register') throw new PasskeyUnavailableError({ ok: false, reason: 'failed', detail: 'The check answered the wrong question.' })
  const prfOutput = Buffer.from(answer.first, 'base64')
  const testOutput = Buffer.from(answer.test, 'base64')
  if (prfOutput.length !== PRF_OUTPUT_BYTES || testOutput.length !== PRF_OUTPUT_BYTES) {
    throw new PasskeyUnavailableError({ ok: false, reason: 'unsupported', detail: 'The secret it gave back is the wrong size.' })
  }
  return { credentialId: answer.credentialId, rpId: PASSKEY_RP_ID, prfSalt, prfOutput, testOutput }
}

/** The launch's passkey attempt: the PRF output, or null for "type something instead". */
export async function assertPasskey(wrap: PasskeyWrap): Promise<Buffer | null> {
  const answer = await runPasskeyWindow({
    mode: 'assert',
    rpId: wrap.rpId,
    prfSalt: wrap.prfSalt,
    credentialId: wrap.credentialId
  })
  if (answer.ok && answer.mode === 'assert') return Buffer.from(answer.output, 'base64')
  if (!answer.ok) logNote('passkey-unlock', `${answer.reason}: ${answer.detail}`)
  return null
}

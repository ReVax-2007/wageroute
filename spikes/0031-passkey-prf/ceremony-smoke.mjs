#!/usr/bin/env node
// Throwaway smoke test for ADR 0031 — not part of any build or test list.
//
//   node spikes/0031-passkey-prf/ceremony-smoke.mjs
//
// Bundles the app's own src/main/passkey-window.ts and src/main/db/ledger-key.ts
// with esbuild, then runs them inside this repo's Electron: the real ceremony
// window, the real `protocol.handle` origin, the real `executeJavaScript` of the
// shared ceremony. A CDP virtual authenticator (attached through
// webContents.debugger as each window is created) stands in for Windows Hello,
// so no biometric is touched. The app's HOME is a temp folder; no ledger is read.

import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
const scratch = mkdtempSync(join(tmpdir(), 'wageroute-ceremony-'))
const require = createRequire(import.meta.url)

const entry = join(scratch, 'entry.ts')
writeFileSync(
  entry,
  `export { enrolPasskey, assertPasskey, runPasskeyWindow } from ${JSON.stringify(join(root, 'src/main/passkey-window.ts'))}
   export { generateDataKey, sealWithPasskey, openWithPasskey } from ${JSON.stringify(join(root, 'src/main/db/ledger-key.ts'))}`
)
const esbuild = require('esbuild')
esbuild.buildSync({
  entryPoints: [entry],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
  alias: { '@shared': join(root, 'src/shared') },
  outfile: join(scratch, 'bundle.cjs'),
  logLevel: 'silent'
})

writeFileSync(
  join(scratch, 'main.cjs'),
  `const { app } = require('electron')
const lib = require('./bundle.cjs')
const VIRTUAL = { protocol: 'ctap2', ctap2Version: 'ctap2_1', transport: 'internal', hasResidentKey: true,
  hasUserVerification: true, isUserVerified: true, hasPrf: true }
let carried = null
const notes = []
app.on('browser-window-created', (_event, win) => {
  const d = win.webContents.debugger
  d.attach('1.3')
  // Smoke-only: on this Mac the real answer to "is there a platform authenticator" is
  // false (measured and recorded below), which is exactly why the app offers nothing
  // here. To drive the rest of the path, the page is told "true" before it loads.
  const ready = d.sendCommand('WebAuthn.enable', { enableUI: false })
    .then(() => d.sendCommand('WebAuthn.addVirtualAuthenticator', { options: VIRTUAL }))
    .then(async ({ authenticatorId }) => {
      if (carried) await d.sendCommand('WebAuthn.addCredential', { authenticatorId, credential: carried })
      return authenticatorId
    })
  let kept = false
  win.on('close', (event) => {
    if (kept) return
    event.preventDefault()
    ready.then((authenticatorId) => d.sendCommand('WebAuthn.getCredentials', { authenticatorId }))
      .then(({ credentials }) => { if (credentials.length) carried = credentials[0] })
      .catch((e) => notes.push(String(e)))
      .finally(() => { kept = true; win.destroy() })
  })
  win.webContents.once('did-finish-load', () => {
    notes.push('loaded ' + win.webContents.getURL())
    // Queued on the same debugger before the app's own executeJavaScript call.
    d.sendCommand('Runtime.evaluate', {
      expression: 'PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()',
      awaitPromise: true
    }).then((r) => notes.push('uvpaa with virtual authenticator: ' + r.result.value))
    if (process.env.SMOKE_STUB_PLATFORM === '1') {
      d.sendCommand('Runtime.evaluate', {
        expression: 'PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable = async () => true'
      })
    }
  })
})
app.whenReady().then(async () => {
  const out = { notes }
  try {
    const t0 = Date.now()
    const enrolment = await lib.enrolPasskey(null)
    out.enrol = { ms: Date.now() - t0, credentialId: enrolment.credentialId.slice(0, 8) + '…', rpId: enrolment.rpId,
      firstBytes: enrolment.prfOutput.length, sameTwice: enrolment.prfOutput.equals(enrolment.testOutput) }
    const dataKey = lib.generateDataKey()
    const wrap = lib.sealWithPasskey(dataKey, enrolment)
    out.provedWithTest = Boolean(lib.openWithPasskey(wrap, enrolment.testOutput)?.equals(dataKey))
    const t1 = Date.now()
    const answer = await lib.runPasskeyWindow({ mode: 'assert', rpId: wrap.rpId, prfSalt: wrap.prfSalt, credentialId: wrap.credentialId })
    out.unlockAnswer = answer.ok ? { ok: true, bytes: Buffer.from(answer.output, 'base64').length } : answer
    const output = answer.ok ? Buffer.from(answer.output, 'base64') : null
    // Measured: a credential copied into the unlock window's own virtual authenticator
    // with WebAuthn.addCredential carries no hmac-secret seed, so the assertion is
    // answered with no PRF output and the app returns null — "type instead". That is
    // the harness's limit, not the app's; the same-window register path above is the
    // end-to-end proof that a second assertion returns the same 32 bytes.
    out.unlock = {
      ms: Date.now() - t1,
      returnedBytes: output ? output.length : 0,
      opensAcrossVirtualAuthenticators: Boolean(output && lib.openWithPasskey(wrap, output)?.equals(dataKey))
    }
    carried = null
    out.unlockWithNoCredential = (await lib.assertPasskey(wrap)) === null ? 'null (falls through to typing)' : 'unexpected key'
  } catch (error) {
    out.error = String(error && error.stack || error)
  }
  process.stdout.write(JSON.stringify(out, null, 2) + '\\n')
  app.exit(0)
})`
)

const electron = require('electron')
const results = {}
for (const [name, stubbed] of [['realPlatform', '0'], ['platformCheckStubbed', '1']]) {
  const run = spawnSync(electron, [join(scratch, 'main.cjs')], {
    encoding: 'utf8',
    timeout: 180_000,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '', CFFIXED_USER_HOME: scratch, HOME: scratch, SMOKE_STUB_PLATFORM: stubbed }
  })
  try {
    results[name] = JSON.parse(run.stdout)
  } catch {
    results[name] = { exit: run.status, stdout: run.stdout, stderr: (run.stderr || '').slice(-1500) }
  }
}
const json = JSON.stringify({ ranAt: new Date().toISOString(), electron: require('electron/package.json').version, ...results }, null, 2)
process.stdout.write(json + '\n')
writeFileSync(join(here, 'ceremony-smoke.json'), json + '\n')
rmSync(scratch, { recursive: true, force: true })

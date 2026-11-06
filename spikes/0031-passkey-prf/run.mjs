#!/usr/bin/env node
// Throwaway spike for ADR 0031 — not part of any build, test list or lint run.
//
//   node spikes/0031-passkey-prf/run.mjs
//
// Serves prf.html on http://localhost and on https://wageroute.lan (a self-signed
// certificate, the same position Caddy's `tls internal` leaves a device in until
// its root is trusted), then drives it over the Chrome DevTools Protocol in:
//   - Google Chrome (headless), and
//   - this repo's Electron (the Chromium the desktop app actually ships).
// A CDP virtual authenticator with PRF stands in for Touch ID: no real biometric
// is touched and nothing is written to the login keychain. Results go to stdout
// as JSON and to results.json beside this file.

import { spawn, execFileSync } from 'node:child_process'
import { createHash, X509Certificate } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createServer as createTlsServer } from 'node:https'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const page = readFileSync(join(here, 'prf.html'))
const scratch = mkdtempSync(join(tmpdir(), 'wageroute-prf-'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const out = (s) => process.stdout.write(`${s}\n`)

// --- certificate for the .lan case -------------------------------------------------
execFileSync('openssl', [
  'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
  '-keyout', join(scratch, 'key.pem'), '-out', join(scratch, 'cert.pem'), '-days', '2',
  '-subj', '/CN=wageroute.lan', '-addext', 'subjectAltName=DNS:wageroute.lan'
], { stdio: 'ignore' })
const certPem = readFileSync(join(scratch, 'cert.pem'))
const spkiHash = createHash('sha256')
  .update(new X509Certificate(certPem).publicKey.export({ type: 'spki', format: 'der' }))
  .digest('base64')

const serve = (_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(page)
}
const http = createServer(serve).listen(0, '127.0.0.1')
const https = createTlsServer({ key: readFileSync(join(scratch, 'key.pem')), cert: certPem }, serve).listen(0, '127.0.0.1')
await sleep(100)
const HTTP = http.address().port
const HTTPS = https.address().port

// --- a minimal CDP client -----------------------------------------------------------
async function connect(port) {
  for (let i = 0; i < 100; i += 1) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const target = targets.find((t) => t.type === 'page')
      if (target) return client(target.webSocketDebuggerUrl)
    } catch {}
    await sleep(150)
  }
  throw new Error(`no page target on ${port}`)
}

function client(url) {
  const ws = new WebSocket(url)
  let id = 0
  const pending = new Map()
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data)
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)
    }
  }
  const ready = new Promise((r) => (ws.onopen = r))
  const send = async (method, params = {}) => {
    await ready
    id += 1
    ws.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
  }
  return {
    send,
    async go(url) {
      await send('Page.enable')
      await send('Page.navigate', { url })
      await sleep(800)
    },
    async run(expr) {
      const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
      if (r.exceptionDetails) return { thrown: r.exceptionDetails.exception?.description ?? r.exceptionDetails.text }
      return r.result.value
    },
    close: () => ws.close()
  }
}

const VIRTUAL = {
  protocol: 'ctap2',
  ctap2Version: 'ctap2_1',
  transport: 'internal',
  hasResidentKey: true,
  hasUserVerification: true,
  isUserVerified: true,
  hasPrf: true
}

async function addAuthenticator(cdp) {
  await cdp.send('WebAuthn.enable', { enableUI: false })
  return (await cdp.send('WebAuthn.addVirtualAuthenticator', { options: VIRTUAL })).authenticatorId
}

// --- one browser, every scenario ----------------------------------------------------
async function exercise(label, cdp, { extraOrigins = [] } = {}) {
  const r = { label }
  const local = `http://localhost:${HTTP}/`

  // Real platform first, before any virtual authenticator exists.
  await cdp.go(local)
  r.realPlatform = await cdp.run('spike.capabilities()')

  const authenticatorId = await addAuthenticator(cdp)
  r.localhost = await cdp.run(`spike.custody('localhost')`)
  await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId })
  r.localhostAfterLoss = await cdp.run(`spike.afterLoss('localhost')`)

  // rpId rules: what a self-hosted origin may and may not claim.
  const probe = await addAuthenticator(cdp)
  r.rpIdFromLocalhost = {
    'wageroute.lan': await cdp.run(`spike.tryRpId('wageroute.lan')`)
  }
  await cdp.go(`http://127.0.0.1:${HTTP}/`)
  r.rpIdFromLoopbackIp = {
    capabilities: await cdp.run('spike.capabilities()'),
    '127.0.0.1': await cdp.run(`spike.tryRpId('127.0.0.1')`)
  }
  await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId: probe })

  for (const origin of extraOrigins) {
    await cdp.go(origin.url)
    const id = await addAuthenticator(cdp)
    r[origin.key] = {
      capabilities: await cdp.run('spike.capabilities()'),
      custody: await cdp.run(`spike.custody('wageroute.lan')`)
    }
    await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId: id })
  }
  return r
}

const results = { ranAt: new Date().toISOString(), node: process.version, runs: [] }

// Chrome: once with the .lan certificate untrusted, once with it trusted by SPKI pin.
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
async function chrome(trustLan, port) {
  const profile = mkdtempSync(join(scratch, 'chrome-'))
  const args = [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check',
    '--host-resolver-rules=MAP wageroute.lan 127.0.0.1',
    ...(trustLan ? [`--ignore-certificate-errors-spki-list=${spkiHash}`] : []),
    'about:blank'
  ]
  const proc = spawn(CHROME, args, { stdio: 'ignore' })
  try {
    const cdp = await connect(port)
    const version = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).Browser
    const run = await exercise(`Chrome ${trustLan ? '(.lan cert trusted)' : '(.lan cert untrusted)'}`, cdp, {
      extraOrigins: [{ key: 'lanHttps', url: `https://wageroute.lan:${HTTPS}/` }]
    })
    cdp.close()
    return { version, ...run }
  } finally {
    proc.kill()
    await sleep(500)
  }
}

// Electron: the repo's own binary, a hidden window, and also the file:// origin the
// packaged renderer loads from.
async function electron(port, intercept = false) {
  const main = join(scratch, 'electron-main.cjs')
  writeFileSync(join(scratch, 'prf.html'), page)
  writeFileSync(
    main,
    `const { app, BrowserWindow, session } = require('electron')
     const page = require('fs').readFileSync(${JSON.stringify(join(scratch, 'prf.html'))})
     app.whenReady().then(() => {
       // Answer http://localhost from memory: an origin WebAuthn accepts, with no socket open.
       if (process.env.SPIKE_INTERCEPT) {
         session.defaultSession.protocol.handle('http', () =>
           new Response(page, { headers: { 'content-type': 'text/html; charset=utf-8' } }))
       }
       const w = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, sandbox: true } })
       w.loadURL('about:blank')
     })`
  )
  const bin = createRequire(import.meta.url)('electron')
  const proc = spawn(bin, [main, `--remote-debugging-port=${port}`, '--host-resolver-rules=MAP wageroute.lan 127.0.0.1',
    `--ignore-certificate-errors-spki-list=${spkiHash}`], {
    stdio: 'ignore',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '', ...(intercept ? { SPIKE_INTERCEPT: '1' } : {}) }
  })
  try {
    const cdp = await connect(port)
    const version = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).Browser
    if (intercept) {
      // Port 1 has no listener: anything that loads here came from protocol.handle.
      await cdp.go('http://localhost:1/unlock')
      const id = await addAuthenticator(cdp)
      const run = {
        label: 'Electron, http://localhost answered by protocol.handle (no socket)',
        capabilities: await cdp.run('spike.capabilities()'),
        custody: await cdp.run(`spike.custody('localhost')`)
      }
      await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId: id })
      cdp.close()
      return { version, ...run }
    }
    const run = await exercise('Electron (no configureWebAuthn)', cdp, {
      extraOrigins: [{ key: 'lanHttps', url: `https://wageroute.lan:${HTTPS}/` }]
    })
    await cdp.go(pathToFileURL(join(scratch, 'prf.html')).href)
    const id = await addAuthenticator(cdp)
    run.fileOrigin = {
      capabilities: await cdp.run('spike.capabilities()'),
      emptyRpId: await cdp.run(`spike.tryRpId('')`),
      localhostRpId: await cdp.run(`spike.tryRpId('localhost')`)
    }
    await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId: id })
    cdp.close()
    return { version, ...run }
  } finally {
    proc.kill()
    await sleep(500)
  }
}

try {
  results.runs.push(await chrome(false, 9441))
  results.runs.push(await chrome(true, 9442))
  results.runs.push(await electron(9443))
  results.runs.push(await electron(9444, true))
} catch (error) {
  results.error = String(error?.stack ?? error)
} finally {
  http.close()
  https.close()
  rmSync(scratch, { recursive: true, force: true })
}

const json = JSON.stringify(results, null, 2)
writeFileSync(join(here, 'results.json'), `${json}\n`)
out(json)

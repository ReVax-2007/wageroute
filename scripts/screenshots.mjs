#!/usr/bin/env node
// Regenerates the landing page screenshots in assets/screenshots/.
//
//   npm run build && node scripts/screenshots.mjs
//
// It launches the built app (out/) unpackaged, which seeds the "Alex" demo
// profile, inside a throwaway home folder, so it never opens a real ledger.
// The window is driven over the Chrome DevTools Protocol with Node's own
// WebSocket (Node 22+), so no test framework is needed.

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'assets', 'screenshots')
const port = 9333
const width = 1280
const height = 800

// [file name, sidebar label or null for the paycheck wizard]
const SHOTS = [
  ['home', 'Home'],
  ['route-paycheck', null],
  ['bills', 'Bills'],
  ['goals', 'Goals'],
  ['accounts', 'Accounts'],
  ['spreadsheet', 'Spreadsheet']
]
const THEMES = ['Dark', 'Light']

if (!existsSync(join(root, 'out', 'main', 'index.js'))) {
  console.error('screenshots: out/ is missing; run `npm run build` first.')
  process.exit(1)
}
if (typeof WebSocket !== 'function') {
  console.error('screenshots: needs Node 22 or newer (global WebSocket).')
  process.exit(1)
}

const home = mkdtempSync(join(tmpdir(), 'wageroute-shots-'))
const electron = createRequire(import.meta.url)('electron')
const app = spawn(electron, ['.', `--remote-debugging-port=${port}`], {
  cwd: root,
  stdio: 'ignore',
  env: {
    ...process.env,
    // macOS relocates the app's data home; Linux reads the XDG folder.
    CFFIXED_USER_HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    ELECTRON_RUN_AS_NODE: ''
  }
})

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function cleanUp() {
  if (app.exitCode === null) {
    const exited = new Promise((resolve) => app.once('exit', resolve))
    app.kill()
    await Promise.race([exited, sleep(5000)])
  }
  rmSync(home, { recursive: true, force: true })
}

async function findPage() {
  for (let tries = 0; tries < 60; tries++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const page = list.find((t) => t.type === 'page' && !t.url.includes('mode=unlock'))
      if (page) return page.webSocketDebuggerUrl
    } catch {
      // not listening yet
    }
    await sleep(500)
  }
  throw new Error('the app window never appeared on the debugging port')
}

function connect(url) {
  const socket = new WebSocket(url)
  let nextId = 1
  const waiting = new Map()
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    const pending = waiting.get(message.id)
    if (!pending) return
    waiting.delete(message.id)
    if (message.error) pending.reject(new Error(message.error.message))
    else pending.resolve(message.result)
  })
  const ready = new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++
      waiting.set(id, { resolve, reject })
      socket.send(JSON.stringify({ id, method, params }))
    })
  return { ready, send, close: () => socket.close() }
}

async function run() {
  const cdp = connect(await findPage())
  await cdp.ready
  const evaluate = async (expression) =>
    (await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }))
      .result.value

  for (let tries = 0; !(await evaluate("!!document.querySelector('.nav')")); tries++) {
    if (tries > 60) throw new Error('the app never finished loading the demo ledger')
    await sleep(500)
  }

  const metrics = (h) =>
    cdp.send('Emulation.setDeviceMetricsOverride', { width, height: h, deviceScaleFactor: 2, mobile: false })
  await metrics(height)
  await sleep(300)
  // Hide the text caret and freeze transitions so every capture is stable.
  await evaluate(`(() => {
    const style = document.createElement('style')
    style.textContent = '*,*::before,*::after{transition:none!important;animation:none!important;caret-color:transparent!important}'
    document.head.append(style)
  })()`)

  const clickByText = (selector, text) =>
    evaluate(`(() => {
      const el = [...document.querySelectorAll(${JSON.stringify(selector)})]
        .find((node) => node.textContent.trim() === ${JSON.stringify(text)})
      if (!el) return false
      el.click()
      return true
    })()`)

  mkdirSync(outDir, { recursive: true })
  for (const theme of THEMES) {
    // The theme picker lives in Settings, as a segmented control.
    await clickByText('.nav-label', 'Settings')
    await sleep(400)
    if (!(await clickByText('.segmented button', theme))) throw new Error(`no ${theme} theme button`)
    for (const [name, label] of SHOTS) {
      await evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))")
      if (label) {
        if (!(await clickByText('.nav-label', label))) throw new Error(`no ${label} screen`)
      } else {
        await clickByText('.nav-label', 'Home')
        await sleep(300)
        if (!(await clickByText('button', 'Route a paycheck'))) throw new Error('no paycheck wizard')
        await sleep(500)
        // The deposit field takes focus when the wizard opens; type the page's example.
        await cdp.send('Input.insertText', { text: '3200' })
      }
      await sleep(900)
      // No focus ring in a marketing picture.
      await evaluate('document.activeElement && document.activeElement.blur()')
      await sleep(150)
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'webp', quality: 86 })
      const file = join(outDir, `${name}-${theme.toLowerCase()}.webp`)
      writeFileSync(file, Buffer.from(data, 'base64'))
      process.stdout.write(`wrote ${file.slice(root.length + 1)}\n`)
    }
  }
  cdp.close()
}

try {
  await run()
} catch (error) {
  console.error(`screenshots: ${error.message}`)
  process.exitCode = 1
} finally {
  await cleanUp()
}

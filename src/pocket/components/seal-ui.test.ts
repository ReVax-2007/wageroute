import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import * as React from 'react'
import { createElement, act, type ReactElement } from 'react'
import { JSDOM } from 'jsdom'
import { installFakePhoneStorage } from '../lib/fake-phone-storage'
import { NO_CIPHER_HERE } from '../lib/webcrypto'
import { withoutCipher } from '../lib/without-cipher'
import {
  MIN_ITERATIONS,
  envelopeFileName,
  envelopeToJson,
  parseEnvelope,
  textIsEnvelope
} from '@shared/envelope'
import { todayISO } from '@shared/dates'

// These two panels are the phone's whole encryption story for a person holding
// the device: what a sealed file says before it asks for anything, where a wrong
// phrase lands, and when a phrase is allowed to reach the cipher. That is DOM
// behaviour, so it runs against a real one.
const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true })
const { window } = dom

function exposeGlobal(name: string, value: unknown): void {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
}

exposeGlobal('window', window)
exposeGlobal('document', window.document)
exposeGlobal('navigator', window.navigator)
exposeGlobal('HTMLElement', window.HTMLElement)
exposeGlobal('HTMLInputElement', window.HTMLInputElement)
exposeGlobal('Element', window.Element)
exposeGlobal('Node', window.Node)
exposeGlobal('Event', window.Event)
exposeGlobal('KeyboardEvent', window.KeyboardEvent)
exposeGlobal('MouseEvent', window.MouseEvent)
exposeGlobal('getComputedStyle', window.getComputedStyle.bind(window))
exposeGlobal('requestAnimationFrame', window.requestAnimationFrame.bind(window))
exposeGlobal('cancelAnimationFrame', window.cancelAnimationFrame.bind(window))
exposeGlobal('IS_REACT_ACT_ENVIRONMENT', true)
// tsx compiles a file that sits outside the root tsconfig's include with React's
// classic runtime, which reaches for a global `React`. The phone's own build goes
// through Vite and never needs it, so the test gives it the same module the
// screens would have imported.
exposeGlobal('React', React)

// The phone only claims a ledger after storage took it, so the unlock test needs
// storage that behaves like a browser's rather than a missing global.
const records = installFakePhoneStorage()

// jsdom saves no files: the blob is handed to the test instead, with the name
// the anchor was given, which is what proves the phone wrote what the store named.
let saved: { name: string; text: () => Promise<string> } | null = null
Object.defineProperty(URL, 'createObjectURL', {
  configurable: true,
  writable: true,
  value: (blob: Blob) => {
    saved = { name: '', text: () => blob.text() }
    return 'blob:phone'
  }
})
Object.defineProperty(URL, 'revokeObjectURL', {
  configurable: true,
  writable: true,
  value: () => undefined
})
window.document.addEventListener(
  'click',
  (event) => {
    const link = event.target as { download?: string }
    if (link.download === undefined) return
    if (saved) saved.name = link.download
    event.preventDefault()
  },
  true
)

const here = dirname(fileURLToPath(import.meta.url))
const example = readFileSync(join(here, '../../../examples/backup.example.json'), 'utf8')
const PASSPHRASE = 'correct horse battery staple'
const WRITTEN_AT = '2026-02-03T10:00:00.000Z'
const SEALED_NAME = 'wageroute-backup-20260203-100000-encrypted.json'

/**
 * The store and the screens are imported only once the DOM above exists, which
 * is why they arrive through a function rather than at the top of the file.
 */
async function load(): Promise<Depends> {
  if (deps) return deps
  const store = await import('../lib/store')
  deps = {
    usePocket: store.usePocket,
    parseBackup: (await import('../lib/backup')).parseBackup,
    sealEnvelope: (await import('../lib/envelope')).sealEnvelope,
    UnlockSeal: (await import('./UnlockSeal')).UnlockSeal,
    ExportSheet: (await import('./ExportSheet')).ExportSheet,
    createRoot: (await import('react-dom/client')).createRoot
  }
  return deps
}

interface Depends {
  usePocket: typeof import('../lib/store').usePocket
  parseBackup: typeof import('../lib/backup').parseBackup
  sealEnvelope: typeof import('../lib/envelope').sealEnvelope
  UnlockSeal: typeof import('./UnlockSeal').UnlockSeal
  ExportSheet: typeof import('./ExportSheet').ExportSheet
  createRoot: typeof import('react-dom/client').createRoot
}

let deps: Depends | null = null

/** A sealed file, cheaply stretched: this test is about the screen, not the cipher. */
async function sealedText(contents: string, d: Depends): Promise<string> {
  const envelope = await d.sealEnvelope(contents, PASSPHRASE, {
    exportedAt: WRITTEN_AT,
    iterations: MIN_ITERATIONS
  })
  return envelopeToJson(envelope)
}

function startClean(d: Depends): void {
  saved = null
  records.clear()
  d.usePocket.setState({
    status: 'empty',
    tables: null,
    version: 10,
    importedAt: null,
    exportedAt: null,
    sourceName: null,
    localIds: [],
    notice: null,
    error: null,
    warnings: [],
    newerSchema: false,
    pendingSeal: null
  })
}

function phraseBoxes(): HTMLInputElement[] {
  return [...window.document.querySelectorAll('.sheet input.input')] as HTMLInputElement[]
}

function typeInto(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
  assert.ok(setter, 'jsdom exposes the native value setter')
  setter.call(input, value)
  input.dispatchEvent(new window.Event('input', { bubbles: true }))
}

function buttonWith(label: string): HTMLButtonElement {
  const button = [...window.document.querySelectorAll('.sheet button')].find((candidate) =>
    (candidate.textContent ?? '').trim().startsWith(label)
  ) as HTMLButtonElement
  assert.ok(button, `the sheet offers ${label}`)
  return button
}

/**
 * Key stretching takes longer than a click, so a press is only over when the
 * screen has actually changed: waiting on the outcome rather than on a fixed
 * delay keeps a slow machine honest instead of merely passing. Each wait is its
 * own act scope, because React holds an update that arrives from a promise until
 * the scope that started it ends — polling inside one scope would read a screen
 * frozen at the moment of the click.
 */
async function press(label: string, settled: () => boolean): Promise<void> {
  await act(async () => {
    buttonWith(label).click()
  })
  for (let attempt = 0; attempt < 400 && !settled(); attempt += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5))
    })
  }
  assert.ok(settled(), `pressing ${label} never reached its result`)
}

async function mount(d: Depends, element: ReactElement): Promise<() => void> {
  const container = window.document.createElement('div')
  window.document.body.append(container)
  const root = d.createRoot(container)
  await act(async () => {
    root.render(element)
  })
  return () => {
    act(() => root.unmount())
    container.remove()
  }
}

const sheet = (): Element | null => window.document.querySelector('.sheet')
const failureText = (): string => window.document.querySelector('.form-error')?.textContent ?? ''

test('a sealed file names itself and waits, and a wrong phrase stays on the same box', async () => {
  const d = await load()
  startClean(d)
  await d.usePocket.getState().importFile(await sealedText(example, d), SEALED_NAME)
  const unmount = await mount(d, createElement(d.UnlockSeal))
  try {
    const text = window.document.body.textContent ?? ''
    assert.match(text, /Open an encrypted backup/)
    assert.ok(text.includes(SEALED_NAME), 'the file is named, not described')
    assert.match(text, /written/, 'and the header says when it was made')
    assert.equal(buttonWith('Open it').disabled, true, 'nothing opens until a phrase is typed')

    await act(async () => typeInto(phraseBoxes()[0], 'wrong horse battery staple'))
    await press('Open it', () => failureText() !== '')
    assert.ok(sheet(), 'the sheet stays for the next try')
    assert.match(failureText(), /does not open this file/, 'the refusal is the real one, from the cipher')
    assert.equal(buttonWith('Open it').disabled, false, 'and the button is pressable again')

    await act(async () => typeInto(phraseBoxes()[0], PASSPHRASE))
    // The screen goes only once the ledger is the phone's own, so the wait is
    // on the store's promise rather than on the sheet vanishing half-way.
    await press('Open it', () => d.usePocket.getState().notice !== null)
    assert.equal(sheet(), null, 'the question is finished')
    assert.equal(d.usePocket.getState().pendingSeal, null)
    assert.equal(d.usePocket.getState().sourceName, SEALED_NAME, 'the file went on to the import')
    assert.deepEqual(
      d.usePocket.getState().tables,
      d.parseBackup(example).tables,
      'and the rows underneath it are the ledger'
    )
    assert.ok(
      records.get('current'),
      'and the phone kept it, which is the only reason it says so'
    )
  } finally {
    unmount()
  }
})

test('a second sealed file is asked about again with an empty box', async () => {
  const d = await load()
  startClean(d)
  const first = await sealedText(example, d)
  const second = await sealedText('{"hello":"other"}', d)
  await d.usePocket.getState().importFile(first, SEALED_NAME)
  const unmount = await mount(d, createElement(d.UnlockSeal))
  try {
    await act(async () => typeInto(phraseBoxes()[0], 'a phrase left over'))
    await act(async () => {
      d.usePocket.setState({
        pendingSeal: { text: second, name: 'another-encrypted.json', exportedAt: WRITTEN_AT }
      })
    })
    assert.equal(phraseBoxes()[0].value, '', 'the last file’s phrase is not this one’s answer')
    assert.ok((window.document.body.textContent ?? '').includes('another-encrypted.json'))
  } finally {
    unmount()
  }
})

test('the export writes plain by default and asks for nothing', async () => {
  const d = await load()
  startClean(d)
  d.usePocket.setState({ tables: d.parseBackup(example).tables })
  let closes = 0
  const unmount = await mount(d, createElement(d.ExportSheet, { onClose: () => (closes += 1) }))
  try {
    const text = window.document.body.textContent ?? ''
    assert.match(text, /Plain JSON/)
    assert.match(text, /Sealed with a passphrase/)
    assert.equal(phraseBoxes().length, 0, 'plain has no passphrase box')

    await press('Save to phone', () => saved !== null)
    assert.ok(saved)
    assert.equal(saved.name, `wageroute-pocket-${todayISO()}.json`)
    assert.equal(textIsEnvelope(await saved.text()), false)
    assert.equal(closes, 1, 'and the sheet is done once the browser has the file')
  } finally {
    unmount()
  }
})

test('a sealed export is refused until a real phrase is typed twice, then names itself', async () => {
  const d = await load()
  startClean(d)
  d.usePocket.setState({ tables: d.parseBackup(example).tables })
  let closes = 0
  const unmount = await mount(d, createElement(d.ExportSheet, { onClose: () => (closes += 1) }))
  try {
    await press('Sealed with a passphrase', () => phraseBoxes().length === 2)
    const text = window.document.body.textContent ?? ''
    assert.match(text, /AES-256-GCM/, 'the sealed choice says what it does')
    assert.match(text, /offline/, 'and what it does not stop')
    assert.equal(
      phraseBoxes().every((box) => box.type === 'password'),
      true,
      'both boxes are hidden until asked'
    )

    await press('Save to phone', () => failureText() !== '')
    assert.equal(saved, null, 'nothing is written on an empty phrase')
    assert.match(failureText(), /only thing that opens this export/)

    await act(async () => typeInto(phraseBoxes()[0], PASSPHRASE))
    await act(async () => typeInto(phraseBoxes()[1], 'a different phrase entirely'))
    await press('Save to phone', () => /do not match/.test(failureText()))
    assert.equal(saved, null, 'two different phrases typed twice seal nothing readable')

    await act(async () => typeInto(phraseBoxes()[1], PASSPHRASE))
    await press('Save to phone', () => saved !== null)
    assert.ok(saved)
    assert.match(saved.name, /^wageroute-pocket-.*-encrypted\.json$/)
    const envelope = parseEnvelope(await saved.text())
    assert.equal(
      saved.name,
      envelopeFileName('wageroute-pocket', envelope.exportedAt),
      'the name and the header are the same moment'
    )
    assert.equal(envelope.cipher, 'AES-256-GCM')
    assert.equal(closes, 1)
  } finally {
    unmount()
  }
})

test('a page with no cipher offers the plain export and says why the sealed one is not there', async () => {
  const d = await load()
  startClean(d)
  d.usePocket.setState({ tables: d.parseBackup(example).tables })
  // Mounted while the cipher is gone, because the screen decides what to offer when
  // it renders — the same way a phone opened over a LAN address finds it.
  await withoutCipher(async () => {
    let closes = 0
    const unmount = await mount(d, createElement(d.ExportSheet, { onClose: () => (closes += 1) }))
    try {
      const text = window.document.body.textContent ?? ''
      assert.match(text, /no cipher/)
      assert.doesNotMatch(text, /AES-256-GCM/, 'the sealed copy’s promise is not made from a page that cannot keep it')
      assert.equal(
        buttonWith('Sealed with a passphrase').disabled,
        true,
        'the option is named and refused, not quietly missing'
      )
      assert.equal(
        window.document.querySelector('.notice.warn')?.textContent ?? '',
        NO_CIPHER_HERE,
        'in the sentence the crypto seam itself uses'
      )

      await press('Save to phone', () => saved !== null)
      assert.ok(saved)
      assert.equal(textIsEnvelope(await saved.text()), false, 'plain export needs no cipher')
      assert.equal(closes, 1)
    } finally {
      unmount()
    }
  })
})

test('a sealed file on a page with no cipher is not called damage, and the delete is not the answer', async () => {
  const d = await load()
  startClean(d)
  const sealed = await sealedText(example, d)
  await d.usePocket.getState().importFile(sealed, SEALED_NAME)
  await withoutCipher(async () => {
    const unmount = await mount(d, createElement(d.UnlockSeal))
    try {
      const text = window.document.body.textContent ?? ''
      assert.match(text, /no cipher/)
      assert.match(text, /The file is not the problem/, 'so the file is not blamed for it')
      assert.doesNotMatch(text, /not one WageRoute can open/)
      assert.doesNotMatch(text, /stays shut for good/, 'and nothing threatens a file that is fine')
      assert.equal(buttonWith('Open it').disabled, true, 'no phrase can reach a cipher that is not there')
      assert.equal(buttonWith('Choose a different file').disabled, false, 'the plain way in stays open')
    } finally {
      unmount()
    }
  })
  // Back on a page with a cipher, the same file and the same phrase still work, which
  // is the whole point: nothing about the copy was wrong.
  const unmount = await mount(d, createElement(d.UnlockSeal))
  try {
    await act(async () => typeInto(phraseBoxes()[0], PASSPHRASE))
    await press('Open it', () => d.usePocket.getState().notice !== null)
    assert.equal(sheet(), null, 'the question is finished')
    assert.deepEqual(d.usePocket.getState().tables, d.parseBackup(example).tables)
  } finally {
    unmount()
  }
})

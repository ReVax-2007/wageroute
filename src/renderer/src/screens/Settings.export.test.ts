import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement, act } from 'react'
import { JSDOM } from 'jsdom'

// The export choice is a form with a conditional second half, so it runs against
// a real DOM: which boxes appear, what the button is called, and when the phrase
// is allowed to reach the main process are all behaviour a type check cannot see.
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

const GOOD = 'correct horse battery staple'

function typeInto(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
  assert.ok(setter, 'jsdom exposes the native value setter')
  setter.call(input, value)
  input.dispatchEvent(new window.Event('input', { bubbles: true }))
}

function buttonWith(label: string): HTMLButtonElement {
  const button = [...window.document.querySelectorAll('button')].find(
    (candidate) => candidate.textContent?.trim() === label
  ) as HTMLButtonElement
  assert.ok(button, `the dialog offers ${label}`)
  return button
}

/** Both passphrase boxes, in the order the dialog paints them. */
function phraseInputs(): HTMLInputElement[] {
  const boxes = [...window.document.querySelectorAll('.modal input.input')] as HTMLInputElement[]
  assert.equal(boxes.length, 2, 'the sealed export has exactly the two phrase boxes')
  return boxes
}

async function press(label: string): Promise<void> {
  await act(async () => {
    buttonWith(label).click()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

async function mount(
  exported: (passphrase: string | null) => Promise<string | null>
): Promise<{ unmount: () => void; closed: () => number }> {
  const { createRoot } = await import('react-dom/client')
  const { useFinanceStore } = await import('../store/useFinanceStore')
  const { ExportBackupDialog } = await import('./Settings')
  Object.defineProperty(window, 'api', {
    value: {
      exportBackup: async (passphrase: string | null) => {
        const path = await exported(passphrase)
        if (path) useFinanceStore.getState().notify(`Backup saved: ${path}`)
        return path
      }
    },
    configurable: true,
    writable: true
  })
  useFinanceStore.setState({ busy: false })

  let closes = 0
  const container = window.document.createElement('div')
  window.document.body.append(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(createElement(ExportBackupDialog, { onClose: () => (closes += 1) }))
  })
  return {
    unmount: () => {
      act(() => root.unmount())
      container.remove()
    },
    closed: () => closes
  }
}

test('the export offers both readings every time and writes plain by default', async () => {
  const calls: (string | null)[] = []
  const mounted = await mount(async (passphrase) => {
    calls.push(passphrase)
    return '/tmp/wageroute-backup.json'
  })
  try {
    const text = window.document.body.textContent ?? ''
    assert.ok(text.includes('Plain JSON'), 'the plain choice is offered by name')
    assert.ok(text.includes('Sealed with a passphrase'), 'and so is the sealed one')
    assert.match(text, /Anyone who can read this file can read the whole ledger/)
    assert.equal(window.document.querySelector('.unlock-row'), null, 'plain asks for nothing')

    await press('Choose where to save')
    assert.deepEqual(calls, [null], 'plain means no passphrase reaches the cipher')
    assert.equal(mounted.closed(), 1, 'and the dialog closes once the file is chosen')
  } finally {
    mounted.unmount()
  }
})

test('a sealed export is refused until a real phrase is typed twice', async () => {
  const calls: (string | null)[] = []
  const mounted = await mount(async (passphrase) => {
    calls.push(passphrase)
    return '/tmp/wageroute-backup-encrypted.json'
  })
  try {
    await press('Sealed with a passphrase')
    const text = window.document.body.textContent ?? ''
    assert.ok(text.includes('AES-256-GCM'), 'the sealed choice says what it does')
    assert.ok(text.includes('offline'), 'and what it does not protect against')
    assert.equal(phraseInputs().length, 2, 'a phrase is confirmed by typing it twice')

    await press('Choose where to save')
    assert.equal(calls.length, 0, 'nothing is written on an empty phrase')
    assert.match(
      window.document.querySelector('.field-error')?.textContent ?? '',
      /only thing that opens this export/,
      'and the refusal is the shared rule, named for this export'
    )

    const [first, second] = phraseInputs()
    await act(async () => typeInto(first, 'aaaaaaaaaa'))
    await press('Choose where to save')
    assert.equal(calls.length, 0)
    assert.match(
      window.document.querySelector('.field-error')?.textContent ?? '',
      /One character repeated/,
      'a phrase that meets the length but protects nothing is still refused'
    )

    await act(async () => typeInto(first, GOOD))
    await act(async () => typeInto(second, 'a different phrase entirely'))
    await press('Choose where to save')
    assert.equal(calls.length, 0)
    assert.match(
      window.document.querySelector('.field-error')?.textContent ?? '',
      /The two do not match/,
      'two different phrases typed twice would seal a file nobody can open'
    )

    await act(async () => typeInto(second, GOOD))
    await press('Choose where to save')
    assert.deepEqual(calls, [GOOD], 'the phrase that was typed twice is the one that seals')
    assert.equal(mounted.closed(), 1)
  } finally {
    mounted.unmount()
  }
})

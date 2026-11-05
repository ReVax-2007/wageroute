import assert from 'node:assert/strict'
import test from 'node:test'
import * as React from 'react'
import { createElement, act, type ReactElement } from 'react'
import { JSDOM } from 'jsdom'
import { DEFAULT_ITERATIONS } from '@shared/envelope'
import { IMPORT_TABLES, type ImportTables } from '@shared/importRepair'
import { KNOWN_BACKUP_VERSION } from '../lib/backup'
import { installFakePhoneStorage } from '../lib/fake-phone-storage'
import { writeLedger, type StoredLedger } from '../lib/idb'
import { lockVault, vaultIsOpen, type SealedCopy } from '../lib/vault'
import { NO_CIPHER_HERE } from '../lib/webcrypto'
import { withoutCipher } from '../lib/without-cipher'

// The vault is only worth having if the screens around it are honest: a locked
// phone that asks for the phrase before it shows a number, a card that says what
// sealing stops and what it does not, a refusal that lands under the box that was
// typed into, and one door left open for a phrase that is gone for good. All of
// that is DOM behaviour, so it runs against a real one.
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

const records = installFakePhoneStorage()

const PASSPHRASE = 'correct horse battery staple'
const OTHER = 'a different phrase entirely'
const NOTE = 'a note only this phone has ever seen'

/**
 * The store and the screens are imported only once the DOM above exists, which
 * is why they arrive through a function rather than at the top of the file.
 */
async function load(): Promise<Depends> {
  if (deps) return deps
  const store = await import('../lib/store')
  deps = {
    usePocket: store.usePocket,
    UnlockVault: (await import('./UnlockVault')).UnlockVault,
    VaultCard: (await import('./VaultCard')).VaultCard,
    createRoot: (await import('react-dom/client')).createRoot
  }
  return deps
}

interface Depends {
  usePocket: typeof import('../lib/store').usePocket
  UnlockVault: typeof import('./UnlockVault').UnlockVault
  VaultCard: typeof import('./VaultCard').VaultCard
  createRoot: typeof import('react-dom/client').createRoot
}

let deps: Depends | null = null

function tablesWith(transactions: Record<string, unknown>[]): ImportTables {
  const tables = {} as ImportTables
  for (const name of IMPORT_TABLES) tables[name] = []
  tables.transactions = transactions
  return tables
}

/** The ledger every test starts from: one row, plainly stored, on screen. */
function plainLedger(): StoredLedger {
  return {
    tables: tablesWith([{ id: 't-1', note: NOTE, amount_cents: 90_000 }]),
    version: KNOWN_BACKUP_VERSION,
    importedAt: '2026-03-01T09:00:00.000Z',
    exportedAt: '2026-02-28T09:00:00.000Z',
    sourceName: 'wageroute-backup.json',
    localIds: ['t-1']
  }
}

async function startPlain(d: Depends): Promise<void> {
  records.clear()
  lockVault()
  const ledger = plainLedger()
  await writeLedger(ledger)
  d.usePocket.setState({
    status: 'ready',
    ...ledger,
    notice: null,
    error: null,
    warnings: [],
    newerSchema: false,
    pendingSeal: null,
    vault: null
  })
}

/**
 * A phone that was sealed and then closed — which is how the gate is reached in
 * real use: the key lived in a page that is gone, and `load` found a copy it
 * cannot read.
 */
async function startLocked(d: Depends, passphrase = PASSPHRASE): Promise<void> {
  await startPlain(d)
  assert.equal(await d.usePocket.getState().enableVault(passphrase, passphrase), null)
  lockVault()
  d.usePocket.setState({ tables: null, importedAt: null, exportedAt: null, sourceName: null })
  await d.usePocket.getState().load()
  assert.equal(d.usePocket.getState().status, 'locked', 'the copy on disk is the sealed one')
}

/** What this phone's storage holds right now, as the bytes it was written with. */
function stored(): Record<string, unknown> {
  const value = records.get('current')
  assert.ok(value, 'the phone wrote a copy')
  return value as Record<string, unknown>
}

function sheet(): Element | null {
  return window.document.querySelector('.sheet')
}

const failureText = (): string => window.document.querySelector('.form-error')?.textContent ?? ''

function boxes(selector: string): HTMLInputElement[] {
  return [...window.document.querySelectorAll(`${selector} input.input`)] as HTMLInputElement[]
}

function typeInto(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
  assert.ok(setter, 'jsdom exposes the native value setter')
  setter.call(input, value)
  input.dispatchEvent(new window.Event('input', { bubbles: true }))
}

function buttonWith(label: string, scope: string): HTMLButtonElement {
  const root = window.document.querySelector(scope)
  assert.ok(root, `the screen renders ${scope}`)
  const button = [...root.querySelectorAll('button')].find((candidate) =>
    (candidate.textContent ?? '').trim().startsWith(label)
  ) as HTMLButtonElement
  assert.ok(button, `${scope} offers ${label}`)
  return button
}

/**
 * Key stretching takes longer than a click, so a press is only over when the store
 * has actually changed. Each wait is its own act scope, because React holds an
 * update that arrives from a promise until the scope that started it ends —
 * polling inside one scope would read a screen frozen at the moment of the click.
 * The budget is wider than the file tests' because a vault derivation runs at the
 * cost a real phone would pay, not at the test floor. A submit button is pressed
 * the same way: jsdom sends the form's submit event from the click, which is what
 * the gate relies on so a phone's keyboard can return a phrase.
 */
async function press(label: string, settled: () => boolean, scope = '.sheet'): Promise<void> {
  await act(async () => {
    buttonWith(label, scope).click()
  })
  for (let attempt = 0; attempt < 1_200 && !settled(); attempt += 1) {
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

test('the card says what sealing stops before it asks for anything, and refuses a phrase that could not hold', async () => {
  const d = await load()
  await startPlain(d)
  const unmount = await mount(d, createElement(d.VaultCard))
  try {
    const text = window.document.body.textContent ?? ''
    assert.match(text, /Seal this phone/)
    assert.match(text, /Stops:/, 'the honest table is on the card, not behind a link')
    assert.match(text, /Does not stop:/)
    assert.match(text, /If you lose the phrase:/)
    assert.equal(/Cost of a guess/.test(text), false, 'nothing is claimed about a vault that is off')
    assert.equal(window.document.querySelectorAll('input.input').length, 0, 'no passphrase box yet')

    await press('Seal it', () => sheet() !== null, 'section.card')
    assert.match(sheet()?.textContent ?? '', /Seal this phone/, 'the question names itself')
    assert.equal(boxes('.sheet').length, 2, 'a phrase with no reset is typed twice')
    assert.equal(
      boxes('.sheet').every((box) => box.type === 'password'),
      true,
      'both boxes are hidden until asked'
    )
    assert.equal(buttonWith('Seal it', '.sheet').disabled, true, 'an empty pair seals nothing')

    await act(async () => typeInto(boxes('.sheet')[0], 'cat'))
    await act(async () => typeInto(boxes('.sheet')[1], 'cat'))
    await press('Seal it', () => failureText() !== '')
    assert.ok(sheet(), 'the sheet stays for the next try')
    assert.match(failureText(), /at least 10 characters/)
    assert.equal(d.usePocket.getState().vault, null, 'and the phone is still plain')
    assert.ok('tables' in stored(), 'with its plaintext copy exactly where it was')

    await act(async () => typeInto(boxes('.sheet')[0], PASSPHRASE))
    await act(async () => typeInto(boxes('.sheet')[1], OTHER))
    await press('Seal it', () => /same passphrase/.test(failureText()))
    assert.equal(d.usePocket.getState().vault, null, 'two different phrases typed twice seal nothing')

    await act(async () => typeInto(boxes('.sheet')[1], PASSPHRASE))
    await press('Seal it', () => sheet() === null)
    assert.equal(sheet(), null, 'the sheet is gone once the store took the vault')
    const sealedText = window.document.body.textContent ?? ''
    assert.match(sealedText, /copy is sealed/)
    assert.match(sealedText, /Sealed since/)
    assert.match(sealedText, /Cost of a guess/)
    assert.ok(
      sealedText.includes(`${DEFAULT_ITERATIONS.toLocaleString()} rounds`),
      'the card says what a guess costs, in the number the marker holds'
    )
    assert.equal(d.usePocket.getState().status, 'ready', 'the session keeps working')
    assert.deepEqual(Object.keys(stored()).sort(), ['record', 'vault'])
    assert.doesNotMatch(JSON.stringify(stored()), new RegExp(NOTE), 'and only the cipher is on disk')
  } finally {
    unmount()
  }
})

test('closing the seal from the card takes the key and asks for the phrase again', async () => {
  const d = await load()
  await startPlain(d)
  assert.equal(await d.usePocket.getState().enableVault(PASSPHRASE, PASSPHRASE), null)
  const unmount = await mount(d, createElement(d.VaultCard))
  try {
    assert.match(window.document.body.textContent ?? '', /Close it now/)
    const bytes = JSON.stringify(stored())
    await press('Close it now', () => d.usePocket.getState().status === 'locked', 'section.card')
    assert.equal(JSON.stringify(stored()), bytes, 'closing wrote nothing')
    assert.equal(vaultIsOpen(), false, 'the key is out of this page')
    assert.equal(d.usePocket.getState().tables, null, 'and no row is shown over a copy it cannot read')
    assert.equal(window.document.querySelector('.card'), null, 'the card is done with until it reopens')
  } finally {
    unmount()
  }

  const gate = await mount(d, createElement(d.UnlockVault))
  try {
    assert.match(window.document.body.textContent ?? '', /Sealed on/)
    assert.match(window.document.body.textContent ?? '', /under a passphrase/)
    assert.equal(boxes('form.card')[0].type, 'password')
    assert.equal(buttonWith('Open my ledger', 'form.card').disabled, true, 'nothing opens on an empty box')

    await act(async () => typeInto(boxes('form.card')[0], OTHER))
    await press('Open my ledger', () => failureText() !== '', 'form.card')
    assert.match(failureText(), /does not open this phone/)
    assert.equal(d.usePocket.getState().status, 'locked', 'a wrong phrase stays at the gate')
    assert.equal(d.usePocket.getState().tables, null)
    assert.equal(boxes('form.card')[0].value, OTHER, 'the refusal does not throw away what was typed')

    await act(async () => typeInto(boxes('form.card')[0], PASSPHRASE))
    await press('Open my ledger', () => d.usePocket.getState().status === 'ready', 'form.card')
    assert.deepEqual(d.usePocket.getState().tables, plainLedger().tables, 'the rows are the phone’s own')
    assert.deepEqual(d.usePocket.getState().localIds, ['t-1'], 'including the ones only it made')
    assert.equal(window.document.querySelector('form.card'), null, 'the gate is finished')
  } finally {
    gate()
  }
})

test('a damaged copy is told as one, not as a phrase to try again', async () => {
  const d = await load()
  await startLocked(d)
  const copy = stored() as unknown as SealedCopy
  const ciphertext = copy.record.ciphertext
  copy.record.ciphertext = `${ciphertext[0] === 'A' ? 'B' : 'A'}${ciphertext.slice(1)}`

  const unmount = await mount(d, createElement(d.UnlockVault))
  try {
    await act(async () => typeInto(boxes('form.card')[0], PASSPHRASE))
    await press('Open my ledger', () => failureText() !== '', 'form.card')
    assert.match(
      failureText(),
      /changed since WageRoute wrote it/,
      'the right phrase failing is the file, not the typing'
    )
    assert.match(
      window.document.querySelector('.notice.warn')?.textContent ?? '',
      /Typing again will not change this/,
      'and the screen says so instead of inviting another guess'
    )
    assert.equal(d.usePocket.getState().status, 'locked')
    assert.equal(vaultIsOpen(), false, 'a copy that would not open is not left half-held')
  } finally {
    unmount()
  }
})

test('a forgotten phrase has a door: erase this phone’s copy, and nothing else', async () => {
  const d = await load()
  await startLocked(d)
  const unmount = await mount(d, createElement(d.UnlockVault))
  try {
    assert.match(window.document.body.textContent ?? '', /no reset/i, 'the screen says so first')
    await press('Forget this phone', () => sheet() !== null, 'form.card')
    assert.match(sheet()?.textContent ?? '', /Erase the copy on this phone/)
    await press('Keep it', () => sheet() === null)
    assert.ok(stored(), 'a second thought leaves the copy where it is')

    await press('Forget this phone', () => sheet() !== null, 'form.card')
    await press('Erase this phone', () => d.usePocket.getState().status === 'empty')
    assert.equal(records.size, 0, 'the sealed copy is gone, not left behind unreadable')
    assert.equal(d.usePocket.getState().vault, null)
    assert.equal(vaultIsOpen(), false)
    assert.equal(window.document.querySelector('form.card'), null, 'and the gate has nothing left to guard')
  } finally {
    unmount()
  }
})

test('turning the seal off asks for the phrase and gives the phone back plain', async () => {
  const d = await load()
  await startPlain(d)
  assert.equal(await d.usePocket.getState().enableVault(PASSPHRASE, PASSPHRASE), null)
  const unmount = await mount(d, createElement(d.VaultCard))
  try {
    await press('Turn it off', () => sheet() !== null, 'section.card')
    assert.equal(boxes('.sheet').length, 1, 'one box: the phrase it uses now')
    assert.match(sheet()?.textContent ?? '', /Turn the seal off/)
    assert.equal(buttonWith('Turn it off', '.sheet').disabled, true)

    await act(async () => typeInto(boxes('.sheet')[0], OTHER))
    await press('Turn it off', () => failureText() !== '')
    assert.match(failureText(), /does not open this phone/)
    assert.equal(d.usePocket.getState().status, 'ready', 'a typo does not lock a working phone')
    assert.ok(d.usePocket.getState().vault, 'the phone is still sealed under the old phrase')
    assert.ok('vault' in stored(), 'and the copy is still the sealed one')

    await act(async () => typeInto(boxes('.sheet')[0], PASSPHRASE))
    await press('Turn it off', () => sheet() === null)
    assert.equal(d.usePocket.getState().vault, null)
    assert.ok('tables' in stored(), 'storage is readable again')
    assert.deepEqual(stored().tables, plainLedger().tables)
    assert.match(window.document.body.textContent ?? '', /Seal this phone/, 'the card offers the choice back')
  } finally {
    unmount()
  }
})

test('changing the passphrase proves the old one first and retires it', async () => {
  const d = await load()
  await startPlain(d)
  assert.equal(await d.usePocket.getState().enableVault(PASSPHRASE, PASSPHRASE), null)
  const salt = (stored() as { vault: { salt: string } }).vault.salt
  const unmount = await mount(d, createElement(d.VaultCard))
  try {
    await press('Change the passphrase', () => sheet() !== null, 'section.card')
    assert.equal(boxes('.sheet').length, 3, 'the one it uses now, and the new one twice')
    assert.match(sheet()?.textContent ?? '', /Passphrase it uses now/)

    await act(async () => typeInto(boxes('.sheet')[0], OTHER))
    await act(async () => typeInto(boxes('.sheet')[1], PASSPHRASE))
    await act(async () => typeInto(boxes('.sheet')[2], PASSPHRASE))
    await press('Change it', () => failureText() !== '')
    assert.match(failureText(), /does not open this phone/)
    assert.equal(
      (stored() as { vault: { salt: string } }).vault.salt,
      salt,
      'a refusal does not re-seal anything'
    )
    assert.equal(d.usePocket.getState().status, 'ready')

    await act(async () => typeInto(boxes('.sheet')[0], PASSPHRASE))
    await act(async () => typeInto(boxes('.sheet')[1], OTHER))
    await act(async () => typeInto(boxes('.sheet')[2], OTHER))
    await press('Change it', () => sheet() === null)
    assert.equal(d.usePocket.getState().status, 'ready')
    const copy = stored() as { vault: { salt: string } }
    assert.notEqual(copy.vault.salt, salt, 'a new vault means a new salt, not a re-wrapped key')
    assert.doesNotMatch(JSON.stringify(copy), new RegExp(NOTE))
    assert.match(d.usePocket.getState().notice ?? '', /old one no longer opens it/)
  } finally {
    unmount()
  }

  // The part that matters is what the phrase does after this page lets the key go:
  // the retired one is refused and the new one is what the gate is opened with.
  d.usePocket.getState().lockNow()
  const stale = await d.usePocket.getState().unlockVaultWith(PASSPHRASE)
  assert.ok(stale)
  assert.match(stale.message, /does not open this phone/, 'the retired phrase is really retired')
  assert.equal(d.usePocket.getState().status, 'locked', 'and the gate stays up for it')
  assert.equal(await d.usePocket.getState().unlockVaultWith(OTHER), null)
  assert.deepEqual(d.usePocket.getState().tables, plainLedger().tables)
})

test('the gate and the card each show only when they are the truth', async () => {
  const d = await load()
  await startPlain(d)
  const both = await mount(
    d,
    createElement(React.Fragment, null, createElement(d.UnlockVault), createElement(d.VaultCard))
  )
  try {
    assert.equal(window.document.querySelector('form.card'), null, 'an open phone is not asked for a phrase')
    assert.match(window.document.body.textContent ?? '', /Seal this phone/)
  } finally {
    both()
  }

  await startLocked(d)
  const gate = await mount(
    d,
    createElement(React.Fragment, null, createElement(d.UnlockVault), createElement(d.VaultCard))
  )
  try {
    assert.ok(window.document.querySelector('form.card'), 'a locked phone is a screen, not a spinner')
    assert.equal(
      window.document.querySelector('.checks'),
      null,
      'the card that offers to seal a copy it cannot read is not rendered'
    )
  } finally {
    gate()
  }
})

test('a card on a page with no cipher says so instead of offering a seal it cannot make', async () => {
  const d = await load()
  await startPlain(d)
  await withoutCipher(async () => {
    const unmount = await mount(d, createElement(d.VaultCard))
    try {
      const text = window.document.body.textContent ?? ''
      assert.match(text, /no cipher/)
      assert.equal(
        window.document.querySelector('.notice.warn')?.textContent ?? '',
        NO_CIPHER_HERE,
        'the card says the sentence the crypto seam itself uses'
      )
      assert.match(text, /Stops:/, 'and still explains what sealing would have done')
      assert.equal(/Seal it/.test(text), false, 'no button is offered that could only ever fail')
      assert.equal(window.document.querySelectorAll('input.input').length, 0, 'and no passphrase box')
      assert.equal(d.usePocket.getState().vault, null)
      assert.ok('tables' in stored(), 'the plain copy is untouched by a page that cannot seal')
    } finally {
      unmount()
    }
  })
  const unmount = await mount(d, createElement(d.VaultCard))
  try {
    assert.equal(window.document.querySelector('.notice.warn'), null, 'the notice was not a stuck state')
    assert.equal(
      buttonWith('Seal it', 'section.card').disabled,
      false,
      'on a page with a cipher the offer comes back on its own'
    )
  } finally {
    unmount()
  }
})

test('a locked phone on a page with no cipher is not called damaged, and its delete waits', async () => {
  const d = await load()
  await startLocked(d)
  await withoutCipher(async () => {
    const unmount = await mount(d, createElement(d.UnlockVault))
    try {
      const text = window.document.body.textContent ?? ''
      assert.match(text, /no cipher/)
      assert.match(text, /not damaged/, 'the copy is told as what it is: fine, and unread here')
      assert.doesNotMatch(
        text,
        /Typing again will not change this/,
        'the damage sentence belongs to a changed file, not to a browser that withheld its crypto'
      )
      assert.equal(buttonWith('Open my ledger', 'form.card').disabled, true, 'no phrase can reach a missing cipher')
      assert.equal(
        buttonWith('Forget this phone', 'form.card').disabled,
        true,
        'and the destructive door is not the answer to an address bar'
      )
    } finally {
      unmount()
    }
  })
  const unmount = await mount(d, createElement(d.UnlockVault))
  try {
    assert.equal(
      buttonWith('Forget this phone', 'form.card').disabled,
      false,
      'both doors are back on a page that has a cipher'
    )
    await act(async () => typeInto(boxes('form.card')[0], PASSPHRASE))
    await press('Open my ledger', () => d.usePocket.getState().status === 'ready', 'form.card')
    assert.deepEqual(d.usePocket.getState().tables, plainLedger().tables, 'and the phrase still opens it')
  } finally {
    unmount()
  }
})

test.afterEach(() => {
  lockVault()
})

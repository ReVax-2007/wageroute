import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement, act, useState } from 'react'
import { JSDOM } from 'jsdom'

// The dialog's focus model is DOM behaviour, so it is tested against a real
// DOM rather than a stand-in for one. jsdom has no layout engine, so the
// visibility filter that reads getClientRects is given a non-empty box below.
const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true })
const { window } = dom

function exposeGlobal(name: string, value: unknown): void {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
}

exposeGlobal('window', window)
exposeGlobal('document', window.document)
exposeGlobal('navigator', window.navigator)
exposeGlobal('HTMLElement', window.HTMLElement)
exposeGlobal('Element', window.Element)
exposeGlobal('Node', window.Node)
exposeGlobal('Event', window.Event)
exposeGlobal('KeyboardEvent', window.KeyboardEvent)
exposeGlobal('MouseEvent', window.MouseEvent)
exposeGlobal('getComputedStyle', window.getComputedStyle.bind(window))
exposeGlobal('requestAnimationFrame', window.requestAnimationFrame.bind(window))
exposeGlobal('cancelAnimationFrame', window.cancelAnimationFrame.bind(window))
// React 19 asks for this flag before it will flush effects synchronously.
exposeGlobal('IS_REACT_ACT_ENVIRONMENT', true)

function visibleRects(): DOMRectList {
  return [{ width: 1, height: 1, top: 0, left: 0, bottom: 1, right: 1, x: 0, y: 0 }] as unknown as DOMRectList
}

test('a dialog traps Tab, closes on Escape and gives focus back to its trigger', async () => {
  const originalRects = window.HTMLElement.prototype.getClientRects
  window.HTMLElement.prototype.getClientRects = visibleRects

  const { createRoot } = await import('react-dom/client')
  const { useDialog } = await import('./ui')

  function Harness() {
    const [open, setOpen] = useState(false)
    const panelRef = useDialog(() => setOpen(false), open)

    return createElement(
      'div',
      null,
      createElement('button', { id: 'trigger', onClick: () => setOpen(true) }, 'Open'),
      open
        ? createElement(
            'div',
            { ref: panelRef, role: 'dialog', tabIndex: -1 },
            createElement(
              'div',
              { className: 'modal-body' },
              createElement('input', { id: 'first' }),
              createElement('input', { id: 'middle' }),
              createElement('button', { id: 'last' }, 'Done')
            )
          )
        : null
    )
  }

  const container = window.document.createElement('div')
  window.document.body.append(container)
  const root = createRoot(container)
  const key = (keyName: string, shiftKey = false): void => {
    window.document.dispatchEvent(
      new window.KeyboardEvent('keydown', { key: keyName, shiftKey, bubbles: true, cancelable: true })
    )
  }

  try {
    await act(async () => {
      root.render(createElement(Harness))
    })

    const trigger = window.document.getElementById('trigger') as HTMLButtonElement
    trigger.focus()
    assert.equal(window.document.activeElement, trigger)

    await act(async () => {
      trigger.click()
    })

    const first = window.document.getElementById('first') as HTMLInputElement
    const last = window.document.getElementById('last') as HTMLButtonElement
    assert.equal(window.document.activeElement, first, 'focus moves to the first field')
    assert.equal(window.document.body.style.overflow, 'hidden', 'the page behind cannot scroll')

    last.focus()
    key('Tab')
    assert.equal(window.document.activeElement, first, 'Tab wraps from the last stop to the first')

    first.focus()
    key('Tab', true)
    assert.equal(window.document.activeElement, last, 'Shift-Tab wraps the other way')

    await act(async () => {
      key('Escape')
    })
    assert.equal(window.document.querySelector('[role="dialog"]'), null, 'Escape closes the dialog')
    assert.equal(window.document.activeElement, trigger, 'focus returns to whatever opened it')
    assert.equal(window.document.body.style.overflow, '', 'scrolling is restored')
  } finally {
    await act(async () => {
      root.unmount()
    })
    container.remove()
    window.HTMLElement.prototype.getClientRects = originalRects
  }
})

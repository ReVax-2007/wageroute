import { useEffect, useState } from 'react'

function isStandalone(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    window.navigator.standalone === true
  )
}

/** True on an iPhone or iPad, where install lives in Share → Add to Home Screen. */
export function isAppleTouch(): boolean {
  return /iphone|ipad|ipod/i.test(navigator.userAgent)
}

interface InstallState {
  deferred: BeforeInstallPromptEvent | null
  installed: boolean
}

/* The browser offers its prompt once, often before the Data tab is opened, so
   the event is caught when this module loads instead of when a screen mounts. */
let state: InstallState = { deferred: null, installed: isStandalone() }
const listeners = new Set<() => void>()

function update(next: Partial<InstallState>): void {
  state = { ...state, ...next }
  for (const listener of listeners) listener()
}

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault()
  update({ deferred: event as BeforeInstallPromptEvent })
})
window.addEventListener('appinstalled', () => {
  update({ deferred: null, installed: true })
})

/**
 * Chrome and Edge hand the page a prompt it can call later; Safari never does,
 * so the same card has to explain the Share menu instead.
 */
export function useInstallPrompt(): {
  canInstall: boolean
  installed: boolean
  install: () => Promise<void>
} {
  const [current, setCurrent] = useState(state)

  useEffect(() => {
    const listener = () => setCurrent(state)
    listeners.add(listener)
    listener()
    return () => {
      listeners.delete(listener)
    }
  }, [])

  return {
    canInstall: current.deferred !== null,
    installed: current.installed,
    install: async () => {
      const prompt = state.deferred
      if (!prompt) return
      update({ deferred: null })
      await prompt.prompt()
      await prompt.userChoice
    }
  }
}

import type { FinanceApi } from '@shared/api'

/**
 * The bridge the unlock window uses. It is a separate global because a locked
 * ledger has no ledger API: `window.api` exists there too, but every channel
 * behind it is unregistered until the database handle is created.
 */
export interface UnlockBridge {
  /** Hand one passphrase to the main process. False means nothing is listening. */
  submit: (passphrase: string) => Promise<boolean>
  /** Hear that the last answer did not open the ledger. Returns an unsubscribe. */
  onRetry: (listener: () => void) => () => void
}

declare global {
  interface Window {
    api: FinanceApi
    unlock: UnlockBridge
  }
}

export {}

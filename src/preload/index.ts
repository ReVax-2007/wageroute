import { contextBridge, ipcRenderer } from 'electron'
import { UNLOCK_RETRY, UNLOCK_SUBMIT, type IpcCaller } from '@shared/channels'
import { createFinanceApi } from './api'

// Errors travel as messages: contextBridge does not carry custom properties on
// a rejected promise, so a RepositoryError's code is encoded into the message by
// the main process and decoded by `decodeError` where it is displayed.
const call: IpcCaller = (channel, ...args) => ipcRenderer.invoke(channel, ...args)

contextBridge.exposeInMainWorld('api', createFinanceApi(call))

/**
 * The unlock bridge, exposed in every window but useful only in the one the app
 * opens before a locked ledger is readable. It is separate from `api` because a
 * locked ledger has no ledger API: those channels are not registered at all until
 * the database handle exists, so a prompt could not reach the money even if it
 * tried.
 */
contextBridge.exposeInMainWorld('unlock', {
  /** Hand one passphrase to the main process to try. */
  submit: (passphrase: string): Promise<boolean> => ipcRenderer.invoke(UNLOCK_SUBMIT, passphrase),
  /** Hear that the last answer did not open the ledger. Returns an unsubscribe. */
  onRetry: (listener: () => void): (() => void) => {
    const wrapped = (): void => listener()
    ipcRenderer.on(UNLOCK_RETRY, wrapped)
    return () => ipcRenderer.removeListener(UNLOCK_RETRY, wrapped)
  }
})

import { contextBridge, ipcRenderer } from 'electron'
import type { IpcCaller } from '@shared/channels'
import { createFinanceApi } from './api'

// Errors travel as messages: contextBridge does not carry custom properties on
// a rejected promise, so a RepositoryError's code is encoded into the message
// by the main process and decoded by `decodeError` where it is displayed.
const call: IpcCaller = (channel, ...args) => ipcRenderer.invoke(channel, ...args)

contextBridge.exposeInMainWorld('api', createFinanceApi(call))

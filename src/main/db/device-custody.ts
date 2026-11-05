import { safeStorage } from 'electron'
import type { DeviceWrap } from './ledger-key'
import { DATA_KEY_BYTES } from './ledger-key'

/**
 * The device wrap is the OS keychain holding the ledger's data key. On macOS
 * that is the login keychain, on Windows DPAPI, on Linux libsecret when a
 * keyring daemon is running. WageRoute asks the keychain for an item bound to
 * this login; any gate the OS itself puts on reaching it belongs to the OS, and
 * this app configures none — `safeStorage` is device-bound, not biometric.
 *
 * It protects against a file copy, not against the owner of the OS account:
 * anyone logged in as you can ask the keychain for the key. The settings screen
 * says so, and a passphrase wrap can be added on top of it.
 */

export class DeviceCustodyUnavailableError extends Error {
  readonly code = 'DEVICE_CUSTODY_UNAVAILABLE'
  constructor() {
    super(
      'This system offers WageRoute no keychain to hold a key. Use a passphrase instead.'
    )
    this.name = 'DeviceCustodyUnavailableError'
  }
}

export class DeviceCustodyFailedError extends Error {
  readonly code = 'DEVICE_CUSTODY_FAILED'
  constructor(detail: string) {
    super(`The keychain could not release this ledger's key: ${detail}`)
    this.name = 'DeviceCustodyFailedError'
  }
}

export function deviceCustodyAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    // A headless session or a container with no keyring daemon throws here
    // rather than reporting false; either way the answer is "no keychain".
    return false
  }
}

export function sealForDevice(dataKey: Buffer): DeviceWrap {
  if (!deviceCustodyAvailable()) throw new DeviceCustodyUnavailableError()
  // safeStorage takes a string, so the key travels as its own hex text.
  return { sealed: safeStorage.encryptString(dataKey.toString('hex')).toString('base64') }
}

export function openWithDevice(wrap: DeviceWrap): Buffer {
  if (!deviceCustodyAvailable()) throw new DeviceCustodyUnavailableError()
  let hex: string
  try {
    hex = safeStorage.decryptString(Buffer.from(wrap.sealed, 'base64'))
  } catch (error) {
    throw new DeviceCustodyFailedError(error instanceof Error ? error.message : String(error))
  }
  const dataKey = Buffer.from(hex, 'hex')
  if (dataKey.length !== DATA_KEY_BYTES) {
    throw new DeviceCustodyFailedError('the sealed key is not 32 bytes')
  }
  return dataKey
}

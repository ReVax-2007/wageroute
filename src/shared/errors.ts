/**
 * A repository refusal that the renderer is allowed to react to. The message is
 * still the sentence a user reads; the code is what code branches on, so a
 * caller never has to match prose to know *why* a write was refused.
 */
export type ErrorCode = 'VALIDATION' | 'NOT_FOUND' | 'CONFLICT' | 'STATE'

export class RepositoryError extends Error {
  readonly code: ErrorCode
  readonly field?: string

  constructor(code: ErrorCode, message: string, field?: string) {
    super(message)
    this.name = 'RepositoryError'
    this.code = code
    this.field = field
  }
}

/**
 * Electron only carries `message` across IPC, so the code rides in a marker at
 * the front of it and `decodeError` takes it back out.
 */
const MARKER = '[[wageroute:'

export function encodeError(error: Error): string {
  if (error instanceof RepositoryError) return `${MARKER}${error.code}]] ${error.message}`
  return error.message
}

export interface DecodedError {
  code: ErrorCode | null
  message: string
}

export function decodeError(message: string): DecodedError {
  const index = message.indexOf(MARKER)
  if (index === -1) return { code: null, message }
  const end = message.indexOf(']] ', index)
  if (end === -1) return { code: null, message }
  const code = message.slice(index + MARKER.length, end) as ErrorCode
  return { code, message: message.slice(end + 3) }
}

function messageOfUnknown(error: unknown): DecodedError {
  const raw = error instanceof Error ? error.message : String(error)
  return decodeError(raw.replace(/^Error invoking remote method '[^']+': /, '').replace(/^Error: /, ''))
}

/** The sentence to show a user, without the IPC prefix or the code marker. */
export function apiErrorMessage(error: unknown): string {
  return messageOfUnknown(error).message
}

/** Why a write was refused, for code that branches on the reason. */
export function apiErrorCode(error: unknown): ErrorCode | null {
  return messageOfUnknown(error).code
}

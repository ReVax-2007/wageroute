import { app } from 'electron'
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

const MAX_BYTES = 512 * 1024

function logFile(): string {
  return join(app.getPath('userData'), 'logs', 'main.log')
}

/**
 * A local app has no telemetry, so the file is the only record of why it died.
 * One previous generation is kept; logging never throws into the caller.
 */
export function logCrash(scope: string, error: unknown): void {
  const detail =
    error instanceof Error
      ? `${error.name}: ${error.message}\n${error.stack ?? ''}`
      : String(error)
  const line = `${new Date().toISOString()} [${scope}] ${detail.replace(/\n/g, '\n    ')}\n`
  try {
    const file = logFile()
    mkdirSync(dirname(file), { recursive: true })
    try {
      if (statSync(file).size > MAX_BYTES) renameSync(file, `${file}.1`)
    } catch {
      // No file yet: nothing to rotate.
    }
    appendFileSync(file, line, { mode: 0o600 })
  } catch {
    // A full disk is not a reason to lose the error dialog.
  }
}

export function installCrashLogging(): void {
  process.on('uncaughtException', (error) => {
    logCrash('uncaught', error)
    app.exit(1)
  })
  process.on('unhandledRejection', (reason) => logCrash('unhandled-rejection', reason))
  app.on('render-process-gone', (_event, _contents, details) => {
    logCrash('render-process-gone', `${details.reason} (exit code ${details.exitCode})`)
  })
  app.on('child-process-gone', (_event, details) => {
    logCrash('child-process-gone', `${details.type}: ${details.reason}`)
  })
}

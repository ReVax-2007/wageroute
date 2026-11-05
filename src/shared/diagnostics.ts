import type { AppDiagnostics } from './api'
import type { EncryptionStatus } from './encryption'

/**
 * The text behind Settings → Diagnostics → **Copy diagnostics**. It is a shared
 * pure function for the same reason the destructive questions are: the report is
 * the sentence a stranger reads when a ledger will not open, so it is built in
 * one place, tested without a window, and cannot drift from what the card shows.
 *
 * Nothing here is a secret. The encryption line says *whether* the file is
 * ciphertext and *which* wraps can open it — booleans and a cipher name, never a
 * key, a wrapped key, or a passphrase.
 */
export function describeDiagnostics(info: AppDiagnostics): string {
  const counts = Object.entries(info.counts)
    .map(([table, rows]) => `  ${table}: ${rows}`)
    .join('\n')
  return [
    `WageRoute ${info.version}`,
    `Generated: ${info.generatedAt}`,
    `Schema: v${info.schemaVersion}`,
    `Electron ${info.electron} · Chrome ${info.chrome} · Node ${info.node}`,
    `Platform: ${info.platform} ${info.arch} (${info.packaged ? 'packaged' : 'development'})`,
    `Database: ${info.databasePath} (${(info.databaseBytes / 1024).toFixed(1)} kB)`,
    `Ledger: ${describeEncryption(info.encryption)}`,
    `Backups: ${info.backupsPath}`,
    `Log: ${info.logPath}`,
    info.logTail ? `Last log lines:\n${info.logTail}` : 'Log: no entries',
    'Row counts:',
    counts
  ].join('\n')
}

/**
 * A keyed file and a damaged one both read as "WageRoute refused to open this",
 * so the report separates them: an older build meeting an encrypted ledger is a
 * version problem with a known way out, not a lost ledger.
 */
export function describeEncryption(status: EncryptionStatus): string {
  const parts: string[] = []
  if (!status.encrypted) {
    parts.push(status.staleKeyFile ? 'plaintext, with a leftover key file beside it' : 'plaintext on disk')
  } else {
    const held = [status.device && 'this computer', status.passphrase && 'a passphrase'].filter(Boolean).join(' and ')
    parts.push(`encrypted (${status.cipher ?? 'unknown cipher'}), key held by ${held || 'no wrap this build could read'}`)
  }
  // A half-finished decrypt leaves the ledger plaintext with a key file and this
  // marker still on it, so the note belongs to both branches, not only the one
  // that currently looks encrypted.
  if (status.pending) {
    parts.push(`a ${status.pending === 'encrypt' ? 'encryption' : 'decryption'} change never reported back`)
  }
  return parts.join('; ')
}

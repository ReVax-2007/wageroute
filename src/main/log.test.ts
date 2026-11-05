import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { logCrash, logNote, recentLogTail } from './log'

const ISO_LINE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[/

function scratchFile(): { directory: string; file: string } {
  const directory = mkdtempSync(join(tmpdir(), 'wageroute-log-'))
  return { directory, file: join(directory, 'logs', 'main.log') }
}

test('a note says what happened without pretending something went wrong', () => {
  const { directory, file } = scratchFile()
  logNote('ledger-unlocked', 'The ledger opened with a passphrase on try 1.', file)

  const line = readFileSync(file, 'utf8').trimEnd()
  assert.match(line, ISO_LINE)
  assert.equal(line.includes('Error:'), false, 'a successful boot must not read as a crash')
  assert.equal(
    line.replace(/^\S+ /, ''),
    '[ledger-unlocked] The ledger opened with a passphrase on try 1.'
  )
  rmSync(directory, { recursive: true, force: true })
})

test('a crash keeps its name, its message and an indented stack', () => {
  const { directory, file } = scratchFile()
  const error = new Error('the ledger is not a database')
  error.stack = 'Error: the ledger is not a database\n    at getDatabase\n    at boot'
  logCrash('database-open', error, file)

  const line = readFileSync(file, 'utf8').trimEnd()
  assert.match(line, ISO_LINE)
  assert.equal(line.includes('[database-open] Error: the ledger is not a database'), true)
  // Every line after the first is pushed four spaces right, so one crash is
  // one entry in the tail and the stack never reads as a fresh log line.
  assert.equal(line.includes('\n        at getDatabase\n        at boot'), true)
  rmSync(directory, { recursive: true, force: true })
})

test('a note beside a crash keeps both readable', () => {
  const { directory, file } = scratchFile()
  logCrash('database-open', 'render process gone (exit code 5)', file)
  logNote('ledger-unlocked', 'The ledger opened with a passphrase on try 2.', file)

  const tail = recentLogTail(2, file).split('\n')
  assert.equal(tail.length, 2)
  assert.equal(tail[0].includes('[database-open] render process gone (exit code 5)'), true)
  assert.equal(
    tail[1].includes('[ledger-unlocked] The ledger opened with a passphrase on try 2.'),
    true
  )
  assert.equal(recentLogTail(1, file).includes('try 2'), true)
  assert.equal(recentLogTail(1, file).includes('database-open'), false)
  rmSync(directory, { recursive: true, force: true })
})

test('the log is created private, and one previous generation is kept', () => {
  const { directory, file } = scratchFile()
  logNote('boot', 'first', file)
  if (process.platform !== 'win32') {
    // Windows has no POSIX mode bits; there the user profile's ACL is the control.
    assert.equal(statSync(file).mode & 0o777, 0o600)
  }

  appendFileSync(file, 'x'.repeat(512 * 1024))
  logNote('boot', 'after rotation', file)

  const current = readFileSync(file, 'utf8')
  assert.equal(current.includes('after rotation'), true)
  assert.equal(current.includes('first'), false)
  assert.equal(statSync(`${file}.1`).size > 512 * 1024, true)
  rmSync(directory, { recursive: true, force: true })
})

test('logging never throws into the caller that is already failing', () => {
  const { directory } = scratchFile()
  // A path whose parent is a regular file cannot hold a log, and a full disk
  // must not turn an error dialog into a second error.
  writeFileSync(join(directory, 'blocked'), '')
  const unreachable = join(directory, 'blocked', 'main.log')
  assert.doesNotThrow(() => logCrash('database-open', new Error('disk full'), unreachable))
  assert.doesNotThrow(() => logNote('ledger-unlocked', 'nothing is written', unreachable))
  assert.equal(recentLogTail(12, join(directory, 'missing', 'main.log')), '')
  rmSync(directory, { recursive: true, force: true })
})

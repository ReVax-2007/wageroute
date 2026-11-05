import assert from 'node:assert/strict'
import test from 'node:test'
import { emptyImportCounts, type AppDiagnostics } from './api'
import type { EncryptionStatus } from './encryption'
import { describeDiagnostics, describeEncryption } from './diagnostics'

const PLAIN: EncryptionStatus = {
  encrypted: false,
  cipher: null,
  device: false,
  passphrase: false,
  pending: null,
  staleKeyFile: false,
  deviceAvailable: true
}

function status(overrides: Partial<EncryptionStatus>): EncryptionStatus {
  return { ...PLAIN, ...overrides }
}

function diagnostics(overrides: Partial<AppDiagnostics> = {}): AppDiagnostics {
  return {
    generatedAt: '2026-11-04T09:00:00.000Z',
    version: '1.2.0',
    schemaVersion: 10,
    electron: '45.1.0',
    chrome: '140.0.0.0',
    node: '24.18.0',
    platform: 'darwin',
    arch: 'arm64',
    packaged: true,
    databasePath: '/Users/alex/Library/Application Support/WageRoute/wageroute.db',
    databaseBytes: 2048,
    encryption: PLAIN,
    backupsPath: '/Users/alex/Library/Application Support/WageRoute/backups',
    logPath: '/Users/alex/Library/Application Support/WageRoute/logs/main.log',
    logTail: '',
    counts: emptyImportCounts(),
    ...overrides
  }
}

test('the report says whether the file on disk is ciphertext', () => {
  assert.equal(describeEncryption(PLAIN), 'plaintext on disk')
  // A crashed decrypt leaves a key file over a plaintext ledger. A reader that
  // only checked the file header would report a healthy plaintext ledger and
  // send the owner away with a report that hides the one odd thing about it.
  assert.equal(
    describeEncryption(status({ staleKeyFile: true })),
    'plaintext, with a leftover key file beside it'
  )
})

test('an encrypted ledger names its cipher and every wrap that opens it', () => {
  assert.equal(
    describeEncryption(status({ encrypted: true, cipher: 'chacha20', device: true })),
    'encrypted (chacha20), key held by this computer'
  )
  assert.equal(
    describeEncryption(status({ encrypted: true, cipher: 'chacha20', passphrase: true })),
    'encrypted (chacha20), key held by a passphrase'
  )
  assert.equal(
    describeEncryption(status({ encrypted: true, cipher: 'chacha20', device: true, passphrase: true })),
    'encrypted (chacha20), key held by this computer and a passphrase'
  )
})

test('a keyed file whose wraps cannot be read is not reported as a healthy one', () => {
  // The sentence an owner needs when neither wrap answered: the file is
  // ciphertext, and this build can open it with nothing it found.
  assert.match(
    describeEncryption(status({ encrypted: true })),
    /encrypted \(unknown cipher\), key held by no wrap this build could read/
  )
})

test('an interrupted change is in the report, in the direction it stopped in', () => {
  assert.match(
    describeEncryption(status({ encrypted: true, cipher: 'chacha20', device: true, pending: 'encrypt' })),
    /encryption change never reported back/
  )
  // The state this catches is the useful one: a decrypt that stopped halfway
  // leaves plaintext pages, a key file and the marker, and a report that read
  // only the header would call that a clean plaintext ledger.
  assert.equal(
    describeEncryption(status({ cipher: 'chacha20', passphrase: true, pending: 'decrypt' })),
    'plaintext on disk; a decryption change never reported back'
  )
})

test('the whole report carries the build, the ledger line and the counts', () => {
  const report = describeDiagnostics(
    diagnostics({
      logTail: 'WARN exited: something',
      counts: { ...emptyImportCounts(), transactions: 47 },
      encryption: status({ encrypted: true, cipher: 'chacha20', device: true, passphrase: true })
    })
  )
  const lines = report.split('\n')
  assert.equal(lines[0], 'WageRoute 1.2.0')
  assert.equal(lines[2], 'Schema: v10')
  assert.ok(report.includes('darwin arm64 (packaged)'))
  assert.ok(report.includes('(2.0 kB)'))
  assert.ok(
    report.includes('Ledger: encrypted (chacha20), key held by this computer and a passphrase'),
    'the ledger line is the one a support reply turns on'
  )
  assert.ok(report.includes('WARN exited: something'))
  assert.ok(report.includes('\n  transactions: 47'), 'counts stay indented under their heading')
})

test('an empty log is reported as empty rather than as a blank line', () => {
  assert.ok(describeDiagnostics(diagnostics()).includes('Log: no entries'))
})

test('a report prints facts about the ledger, never key material', () => {
  // The tripwire is on the words, not on the input type: a key, salt, wrap or
  // phrase reaching a clipboard looks like a long run of base64 or hex once the
  // paths, which are deliberately in the report, are taken out.
  const report = describeDiagnostics(diagnostics({ encryption: status({ encrypted: true, cipher: 'aes256cbc' }) }))
  assert.ok(report.includes('encrypted (aes256cbc)'))
  const withoutPaths = report.replace(/\/[^\s)]+/g, '')
  assert.equal(
    /[A-Za-z0-9+/=]{24,}/.test(withoutPaths),
    false,
    `something in this report looks like encoded key material:\n${withoutPaths}`
  )
})

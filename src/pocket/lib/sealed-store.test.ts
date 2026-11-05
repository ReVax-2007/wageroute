import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { todayISO } from '@shared/dates'
import {
  DEFAULT_ITERATIONS,
  MIN_ITERATIONS,
  envelopeFileName,
  envelopeToJson,
  parseEnvelope,
  textIsEnvelope
} from '@shared/envelope'
import { openEnvelopeFileText as openOnDesktop } from '../../main/envelope'
import { KNOWN_BACKUP_VERSION, parseBackup } from './backup'
import { sealEnvelope } from './envelope'
import { installFakePhoneStorage } from './fake-phone-storage'
import { usePocket } from './store'

const here = dirname(fileURLToPath(import.meta.url))
const example = readFileSync(join(here, '../../../examples/backup.example.json'), 'utf8')
const PASSPHRASE = 'correct horse battery staple'
const WRITTEN_AT = '2026-02-03T10:00:00.000Z'

const records = installFakePhoneStorage()

function tablesOfExample() {
  return parseBackup(example).tables
}

function startClean(): void {
  records.clear()
  usePocket.setState({
    status: 'empty',
    tables: null,
    version: KNOWN_BACKUP_VERSION,
    importedAt: null,
    exportedAt: null,
    sourceName: null,
    localIds: [],
    notice: null,
    error: null,
    warnings: [],
    newerSchema: false,
    pendingSeal: null
  })
}

/** A sealed file written the way the desktop writes one, cheaply on purpose. */
async function sealedFile(passphrase = PASSPHRASE): Promise<string> {
  const envelope = await sealEnvelope(example, passphrase, {
    exportedAt: WRITTEN_AT,
    iterations: MIN_ITERATIONS
  })
  return envelopeToJson(envelope)
}

test('a sealed file is recognised before anything is asked of the person holding it', async () => {
  startClean()
  await usePocket.getState().importFile(await sealedFile(), 'wageroute-backup-sealed.json')
  const state = usePocket.getState()
  assert.equal(state.tables, null, 'nothing was counted under the cipher')
  assert.equal(state.error, null)
  assert.ok(state.pendingSeal)
  assert.equal(state.pendingSeal.name, 'wageroute-backup-sealed.json')
  assert.equal(
    state.pendingSeal.exportedAt,
    WRITTEN_AT,
    'the header is in the clear, so the phone can say when the file was written'
  )
})

test('a wrong phrase keeps the file waiting and says so where it was typed', async () => {
  startClean()
  await usePocket.getState().importFile(await sealedFile(), 'sealed.json')
  const failure = await usePocket.getState().unlockSeal('wrong horse battery staple')
  assert.ok(failure)
  assert.equal(failure.retry, true, 'another try at the phrase is the right advice')
  assert.match(failure.message, /does not open this file/)
  assert.ok(usePocket.getState().pendingSeal, 'the file is still held, not thrown away')
  assert.equal(usePocket.getState().tables, null)
})

test('an empty box is refused before any key stretching runs', async () => {
  startClean()
  await usePocket.getState().importFile(await sealedFile(), 'sealed.json')
  const failure = await usePocket.getState().unlockSeal('')
  assert.ok(failure)
  assert.match(failure.message, /Type the passphrase/)
  assert.ok(usePocket.getState().pendingSeal)
})

test('the right phrase opens the file and the ledger lands on the phone', async () => {
  startClean()
  await usePocket.getState().importFile(await sealedFile(), 'sealed.json')
  const failure = await usePocket.getState().unlockSeal(PASSPHRASE)
  assert.equal(failure, null)
  const state = usePocket.getState()
  assert.equal(state.pendingSeal, null)
  assert.equal(state.status, 'ready')
  assert.equal(state.sourceName, 'sealed.json')
  assert.deepEqual(state.tables, tablesOfExample(), 'the phrase changed the reading, not the rows')
  assert.equal(
    state.notice,
    'Your ledger is on this phone now. It stays here.',
    'and it is only claimed once storage took it'
  )
  const stored = records.get('current') as { tables: unknown; sourceName: string } | undefined
  assert.ok(stored, 'the record was really written')
  assert.deepEqual(stored.tables, tablesOfExample())
  assert.equal(stored.sourceName, 'sealed.json')
})

test('a file that only looks sealed is reported as the file problem it is', async () => {
  startClean()
  // Passes the in-the-clear look, then fails as an envelope: the answer is a
  // different file, not a different passphrase.
  const impostor = JSON.stringify({
    format: 'wageroute-envelope',
    version: 1,
    contains: 'backup',
    exportedAt: WRITTEN_AT,
    kdf: 'PBKDF2-SHA256',
    iterations: 10,
    cipher: 'AES-256-GCM',
    salt: 'c2FsdA==',
    iv: 'aXY=',
    tag: 'dGFn',
    ciphertext: 'eA=='
  })
  assert.equal(textIsEnvelope(impostor), true)
  await usePocket.getState().importFile(impostor, 'impostor.json')
  const state = usePocket.getState()
  assert.equal(state.pendingSeal, null, 'nothing waits for a phrase that could never help')
  assert.match(state.error ?? '', /outside what WageRoute will do/)
})

test('the phone exports the ledger it holds as plain JSON', async () => {
  startClean()
  usePocket.setState({ tables: tablesOfExample(), version: KNOWN_BACKUP_VERSION })
  const file = await usePocket.getState().exportJson(null)
  assert.ok(file)
  assert.equal(file.fileName, `wageroute-pocket-${todayISO()}.json`)
  assert.equal(textIsEnvelope(file.text), false)
  assert.deepEqual(parseBackup(file.text).tables, tablesOfExample())
})

test('a sealed export from the phone is one the desktop opens', async () => {
  startClean()
  usePocket.setState({ tables: tablesOfExample(), version: KNOWN_BACKUP_VERSION })
  const file = await usePocket.getState().exportJson(PASSPHRASE)
  assert.ok(file)
  assert.equal(textIsEnvelope(file.text), true, 'the name and the header both say sealed')
  const envelope = parseEnvelope(file.text)
  assert.equal(envelope.cipher, 'AES-256-GCM')
  assert.equal(envelope.iterations, DEFAULT_ITERATIONS)
  assert.equal(file.fileName, envelopeFileName('wageroute-pocket', envelope.exportedAt))
  const opened = openOnDesktop(file.text, PASSPHRASE)
  assert.equal(
    parseBackup(opened).exportedAt,
    envelope.exportedAt,
    'one moment: the name, the header and the file inside it all say the same time'
  )
  assert.deepEqual(parseBackup(opened).tables, tablesOfExample())
  assert.throws(() => openOnDesktop(file.text, 'not the phrase'), /does not open this file/)
})

test('a sealed file the phone wrote is one the phone can read back', async () => {
  startClean()
  usePocket.setState({ tables: tablesOfExample(), version: KNOWN_BACKUP_VERSION })
  const file = await usePocket.getState().exportJson(PASSPHRASE)
  assert.ok(file)
  startClean()
  await usePocket.getState().importFile(file.text, file.fileName)
  assert.ok(usePocket.getState().pendingSeal)
  assert.equal(usePocket.getState().pendingSeal.exportedAt, parseEnvelope(file.text).exportedAt)
  assert.equal(await usePocket.getState().unlockSeal(PASSPHRASE), null)
  assert.deepEqual(usePocket.getState().tables, tablesOfExample())
})

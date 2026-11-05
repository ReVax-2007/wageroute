import assert from 'node:assert/strict'
import test from 'node:test'
import { IMPORT_TABLES, type ImportTables } from '@shared/importRepair'
import { KNOWN_BACKUP_VERSION } from './backup'
import { installFakePhoneStorage } from './fake-phone-storage'
import { writeLedger, type StoredLedger } from './idb'
import { lockVault } from './vault'
import { NO_CIPHER_HERE } from './webcrypto'
import { withoutCipher } from './without-cipher'
import { usePocket } from './store'

const PASSPHRASE = 'correct horse battery staple'
const NOTE = 'a note only this phone has ever seen'

const records = installFakePhoneStorage()

function tablesWith(transactions: Record<string, unknown>[]): ImportTables {
  const tables = {} as ImportTables
  for (const name of IMPORT_TABLES) tables[name] = []
  tables.transactions = transactions
  return tables
}

/**
 * A phone that already holds a plain copy, in both places it lives: the store's
 * state and the storage behind it. The vault tests all start from here because
 * sealing is something that happens to a copy that exists.
 */
async function startClean(): Promise<void> {
  const ledger: StoredLedger = {
    tables: tablesWith([{ id: 't-1', note: NOTE, amount_cents: 90_000 }]),
    version: KNOWN_BACKUP_VERSION,
    importedAt: '2026-03-01T09:00:00.000Z',
    exportedAt: '2026-02-28T09:00:00.000Z',
    sourceName: 'wageroute-backup.json',
    localIds: ['t-1']
  }
  records.clear()
  lockVault()
  await writeLedger(ledger)
  usePocket.setState({
    status: 'ready',
    ...ledger,
    notice: null,
    error: null,
    warnings: [],
    newerSchema: false,
    pendingSeal: null,
    vault: null
  })
}

/** What this phone's storage holds right now, as the bytes it was written with. */
function stored(): Record<string, unknown> {
  const value = records.get('current')
  assert.ok(value, 'the phone wrote a copy')
  return value as Record<string, unknown>
}

test('sealing writes a copy nothing on this phone can read without the phrase', async () => {
  await startClean()
  assert.equal(await usePocket.getState().enableVault(PASSPHRASE, PASSPHRASE), null)
  const state = usePocket.getState()
  assert.ok(state.vault, 'the marker is kept: it is what the next load asks a phrase for')
  assert.equal(state.status, 'ready', 'and the ledger did not go anywhere while this session lasts')
  assert.equal(state.error, null)
  const copy = stored()
  assert.equal('tables' in copy, false, 'no plaintext ledger is left beside the sealed one')
  assert.deepEqual(Object.keys(copy).sort(), ['record', 'vault'])
  assert.doesNotMatch(JSON.stringify(copy), new RegExp(NOTE), 'the rows are inside the cipher')
  assert.doesNotMatch(JSON.stringify(copy), /wageroute-backup\.json/)
  // The marker is in the clear, and it is the only part that has to be.
  assert.equal((copy.vault as { format: string }).format, 'wageroute-vault')
  assert.ok(usePocket.getState().notice)
})

test('a passphrase too short to survive an offline guess is refused before any crypto runs', async () => {
  await startClean()
  const problem = await usePocket.getState().enableVault('cat', 'cat')
  assert.ok(problem)
  assert.match(problem.message, /at least 10 characters/)
  assert.equal(usePocket.getState().vault, null)
  assert.deepEqual(stored().tables, tablesWith([{ id: 't-1', note: NOTE, amount_cents: 90_000 }]))
  assert.equal(records.size, 1, 'and nothing else was written on the way to the refusal')
})

test('two boxes that disagree do not make a vault', async () => {
  await startClean()
  const problem = await usePocket.getState().enableVault(PASSPHRASE, `${PASSPHRASE}?`)
  assert.ok(problem)
  assert.match(problem.message, /same passphrase/)
  assert.equal(problem.retry, true)
  assert.equal(usePocket.getState().vault, null)
  assert.ok('tables' in stored(), 'the copy is still the plain one this phone has always had')
})

test('a phone reloaded with a vault on it comes back locked, not empty', async () => {
  await startClean()
  assert.equal(await usePocket.getState().enableVault(PASSPHRASE, PASSPHRASE), null)
  // The reload is the whole point of the vault: the key lived in a page that is gone.
  lockVault()
  usePocket.setState({
    status: 'loading',
    tables: null,
    importedAt: null,
    exportedAt: null,
    sourceName: null,
    localIds: [],
    notice: null,
    error: null
  })
  await usePocket.getState().load()
  const state = usePocket.getState()
  assert.equal(state.status, 'locked', 'a copy that exists but cannot be read is not a missing one')
  assert.equal(state.tables, null, 'nothing is shown that was not opened')
  assert.ok(state.vault)
  assert.equal(state.error, null)
})

test('the locked phone opens with the phrase and no other', async () => {
  await startClean()
  assert.equal(await usePocket.getState().enableVault(PASSPHRASE, PASSPHRASE), null)
  lockVault()
  usePocket.setState({ status: 'locked', tables: null })
  const wrong = await usePocket.getState().unlockVaultWith('correct horse battery stapel')
  assert.ok(wrong)
  assert.equal(wrong.retry, true, 'a wrong phrase is the usual reason and is worth typing again')
  assert.match(wrong.message, /does not open this phone/)
  assert.equal(usePocket.getState().status, 'locked')
  assert.equal(usePocket.getState().tables, null)
  assert.equal(await usePocket.getState().unlockVaultWith(PASSPHRASE), null)
  const state = usePocket.getState()
  assert.equal(state.status, 'ready')
  assert.deepEqual(state.tables, tablesWith([{ id: 't-1', note: NOTE, amount_cents: 90_000 }]))
  assert.equal(state.sourceName, 'wageroute-backup.json')
  assert.deepEqual(state.localIds, ['t-1'], 'and this phone still knows which rows are its own')
})

test('a save after the vault closed keeps the rows and writes them once it reopens', async () => {
  await startClean()
  assert.equal(await usePocket.getState().enableVault(PASSPHRASE, PASSPHRASE), null)
  // Another tab locked it while this one was open: the key is gone from this
  // process's view only through the module, which is exactly how the page notices.
  lockVault()
  await usePocket
    .getState()
    .edit((tables) => ({
      ...tables,
      transactions: [...tables.transactions, { id: 't-2', note: 'the bus', amount_cents: 300 }]
    }))
  const state = usePocket.getState()
  assert.equal(state.status, 'locked', 'the phone asks rather than pretending the save happened')
  assert.ok(state.tables, 'and the rows stay on screen instead of being thrown away')
  assert.doesNotMatch(JSON.stringify(stored()), /the bus/, 'nothing half-written reached storage')
  assert.equal(await usePocket.getState().unlockVaultWith(PASSPHRASE), null)
  const reopened = await usePocket.getState().exportJson(null)
  assert.ok(reopened)
  assert.match(reopened.text, /the bus/, 'the edit that could not be sealed is stored once it could')
})

test('closing it now takes the key out and leaves the copy alone', async () => {
  await startClean()
  assert.equal(await usePocket.getState().enableVault(PASSPHRASE, PASSPHRASE), null)
  const sealed = JSON.stringify(stored())
  usePocket.getState().lockNow()
  const state = usePocket.getState()
  assert.equal(state.status, 'locked')
  assert.equal(state.tables, null, 'a locked screen shows no money at all')
  assert.ok(state.vault, 'but the marker stays: the phone still knows what it is asking for')
  assert.equal(JSON.stringify(stored()), sealed, 'and locking rewrote nothing')
  assert.equal(await usePocket.getState().unlockVaultWith(PASSPHRASE), null)
  assert.deepEqual(
    usePocket.getState().tables,
    tablesWith([{ id: 't-1', note: NOTE, amount_cents: 90_000 }])
  )
})

test('turning the vault off gives this phone a plain copy again', async () => {
  await startClean()
  assert.equal(await usePocket.getState().enableVault(PASSPHRASE, PASSPHRASE), null)
  const sealed = JSON.stringify(stored())
  const wrong = await usePocket.getState().disableVault('not the phrase')
  assert.ok(wrong)
  assert.equal(wrong.retry, true)
  assert.equal(JSON.stringify(stored()), sealed, 'a refusal rewrote nothing')
  assert.ok(usePocket.getState().vault, 'and the phone is still sealed')
  assert.equal(usePocket.getState().status, 'ready', 'a typo in this box does not lock a working phone')
  assert.equal(await usePocket.getState().disableVault(PASSPHRASE), null)
  const state = usePocket.getState()
  assert.equal(state.vault, null)
  assert.equal(state.status, 'ready')
  assert.deepEqual(state.tables, tablesWith([{ id: 't-1', note: NOTE, amount_cents: 90_000 }]))
  assert.match(state.notice ?? '', /no longer sealed/)
  assert.ok('tables' in stored(), 'the copy on disk is readable again')
  // And it comes back on its own next time, which is the whole point of asking.
  usePocket.setState({ status: 'loading', tables: null })
  await usePocket.getState().load()
  assert.equal(usePocket.getState().status, 'ready')
})

test('a new passphrase opens the copy and retires the one it replaces', async () => {
  await startClean()
  assert.equal(await usePocket.getState().enableVault(PASSPHRASE, PASSPHRASE), null)
  const before = stored()
  const refused = await usePocket
    .getState()
    .changeVaultPassphrase('not the phrase', 'sixteen characters of a new phrase', 'sixteen characters of a new phrase')
  assert.ok(refused)
  assert.match(refused.message, /does not open this phone/)
  assert.deepEqual(stored(), before, 'a wrong current phrase rewrote nothing')
  assert.ok(usePocket.getState().vault)
  assert.equal(usePocket.getState().status, 'ready')
  assert.equal(
    await usePocket
      .getState()
      .changeVaultPassphrase(PASSPHRASE, 'sixteen characters of a new phrase', 'sixteen characters of a new phrase'),
    null
  )
  const state = usePocket.getState()
  assert.ok(state.vault)
  assert.notEqual(state.vault.salt, (before.vault as { salt: string }).salt, 'a new salt, not a re-wrap')
  assert.equal(state.status, 'ready')
  assert.deepEqual(state.tables, tablesWith([{ id: 't-1', note: NOTE, amount_cents: 90_000 }]))
  const copy = stored()
  assert.doesNotMatch(JSON.stringify(copy), new RegExp(NOTE), 'and the new copy is as sealed as the old')
  lockVault()
  usePocket.setState({ status: 'locked', tables: null })
  const stale = await usePocket.getState().unlockVaultWith(PASSPHRASE)
  assert.ok(stale)
  assert.match(stale.message, /does not open this phone/, 'the phrase it replaced is finished')
  assert.equal(
    await usePocket.getState().unlockVaultWith('sixteen characters of a new phrase'),
    null
  )
  assert.deepEqual(
    usePocket.getState().tables,
    tablesWith([{ id: 't-1', note: NOTE, amount_cents: 90_000 }])
  )
})

test('a save while sealed writes the sealed copy, not a plain one beside it', async () => {
  await startClean()
  assert.equal(await usePocket.getState().enableVault(PASSPHRASE, PASSPHRASE), null)
  await usePocket
    .getState()
    .edit((tables) => ({
      ...tables,
      transactions: [...tables.transactions, { id: 't-2', note: 'the bus', amount_cents: 300 }]
    }))
  const state = usePocket.getState()
  assert.equal(state.error, null)
  assert.equal(records.size, 1, 'one record, as there has always been')
  assert.doesNotMatch(JSON.stringify(stored()), /tables|the bus/, 'and it is still only cipher text')
  lockVault()
  usePocket.setState({ status: 'locked', tables: null })
  assert.equal(await usePocket.getState().unlockVaultWith(PASSPHRASE), null)
  assert.deepEqual(
    (usePocket.getState().tables ?? { transactions: [] }).transactions.map((row) => row.id),
    ['t-1', 't-2'],
    'the save is in the copy that comes back'
  )
})

test('forgetting the phone takes the key with it', async () => {
  await startClean()
  assert.equal(await usePocket.getState().enableVault(PASSPHRASE, PASSPHRASE), null)
  await usePocket.getState().forget()
  const state = usePocket.getState()
  assert.equal(state.status, 'empty')
  assert.equal(state.vault, null)
  assert.equal(records.size, 0)
  // The key is in the vault module, not in this state, so the store cannot prove it
  // went: this asserts the record is gone, which is what the screen claims.
})

test('a page with no cipher is refused for what it is, and the phone keeps working', async () => {
  await startClean()
  const problem = await withoutCipher(async () => {
    const first = await usePocket.getState().enableVault(PASSPHRASE, PASSPHRASE)
    assert.ok(first, 'the store answers with a sentence instead of throwing')
    assert.equal(
      first.message,
      NO_CIPHER_HERE,
      'and the sentence is the crypto seam’s own, not a storage message rewritten around it'
    )
    assert.equal(first.retry, false, 'typing again cannot produce a cipher')
    return first
  })
  const state = usePocket.getState()
  assert.equal(state.vault, null, 'no vault was made')
  assert.equal(state.status, 'ready', 'a page that cannot seal still shows its own ledger')
  assert.ok('tables' in stored(), 'and the plain copy is exactly where it was')
  assert.equal(records.size, 1, 'nothing was written on the way to the refusal')
  assert.equal(state.error, null, 'and no storage error was invented to explain it')
  assert.equal(problem.retry, false)
})

test('a sealed phone on a page with no cipher is not told to its owner as damage', async () => {
  await startClean()
  assert.equal(await usePocket.getState().enableVault(PASSPHRASE, PASSPHRASE), null)
  lockVault()
  usePocket.setState({ status: 'locked', tables: null })
  await withoutCipher(async () => {
    const problem = await usePocket.getState().unlockVaultWith(PASSPHRASE)
    assert.ok(problem)
    assert.equal(problem.message, NO_CIPHER_HERE)
    assert.equal(problem.retry, false, 'the phrase is not the thing that failed here')
    assert.doesNotMatch(
      problem.message,
      /changed since|damaged/,
      'and the copy is not reported as broken because a browser withheld its crypto'
    )
    assert.equal(usePocket.getState().status, 'locked', 'no key is left half-derived')
  })
  assert.equal(await usePocket.getState().unlockVaultWith(PASSPHRASE), null, 'on a page with a cipher, the same phrase opens it')
  assert.equal(usePocket.getState().status, 'ready')
})

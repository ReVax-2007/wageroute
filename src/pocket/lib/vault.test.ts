import assert from 'node:assert/strict'
import test from 'node:test'
import { IMPORT_TABLES, type ImportTables } from '@shared/importRepair'
import { EnvelopeError, MIN_ITERATIONS, fromBase64 } from '@shared/envelope'
import type { StoredLedger } from './idb'
import { deriveKey, hasCipher, NO_CIPHER_HERE, openPart, sealPart } from './webcrypto'
import { withoutCipher } from './without-cipher'
import type { PasskeyAnswer, PasskeyRequest } from '@shared/passkey-ceremony'
import {
  VaultError,
  addVaultWrap,
  assertMarker,
  changeVaultPassphrase,
  changeVaultPin,
  createVault,
  isV2,
  removeVaultWrap,
  unlockVaultWithPasskey,
  lockVault,
  looksSealed,
  openRecord,
  sealRecord,
  unlockVault,
  vaultIsOpen,
  type VaultMarker
} from './vault'

/**
 * The whole suite runs at the guard rail's floor on purpose: 600 000 PBKDF2 rounds
 * is what a person gets, and a test that asks for the real cost would spend most of
 * its time waiting for a key. The count is a number in the marker, and the marker is
 * what these tests prove is honoured — so the speed is not a fiction the format has
 * to keep up with.
 */
const CHEAP = { iterations: MIN_ITERATIONS }
const PHRASE = 'correct horse battery staple'
const OTHER = 'a horse of a different colour entirely'

function tablesWith(transactions: Record<string, unknown>[]): ImportTables {
  const tables = {} as ImportTables
  for (const name of IMPORT_TABLES) tables[name] = []
  tables.transactions = transactions
  return tables
}

/** A copy of the kind this phone holds, with one note only a readable ledger could carry. */
function ledgerOf(overrides: Partial<StoredLedger> = {}): StoredLedger {
  return {
    tables: tablesWith([{ id: 't-1', note: 'the rent', amount_cents: 90_000 }]),
    version: 10,
    importedAt: '2026-03-01T09:00:00.000Z',
    exportedAt: '2026-02-28T09:00:00.000Z',
    sourceName: 'wageroute-backup.json',
    localIds: ['t-1'],
    ...overrides
  }
}

test.afterEach(() => {
  // A key left in the module would let the next test seal without ever having
  // proved a passphrase, which is the one thing this file is here to catch.
  lockVault()
})

test('a vault opens with the phrase it was made from and no other', async () => {
  const marker = await createVault(PHRASE, CHEAP)
  assert.equal(marker.iterations, MIN_ITERATIONS, 'the marker carries its own cost')
  assert.equal(vaultIsOpen(), false, 'making a vault does not open one')
  await assert.rejects(() => unlockVault(marker, OTHER), (error: unknown) => {
    assert.ok(error instanceof VaultError)
    assert.equal(error.failure, 'passphrase')
    return true
  })
  assert.equal(vaultIsOpen(), false, 'a wrong phrase is not half a way in')
  await unlockVault(marker, PHRASE)
  assert.equal(vaultIsOpen(), true)
})

test('an empty box is refused before any key stretching runs', async () => {
  const marker = await createVault(PHRASE, CHEAP)
  await assert.rejects(() => unlockVault(marker, ''), (error: unknown) => {
    assert.ok(error instanceof VaultError)
    assert.equal(error.failure, 'passphrase')
    assert.match(error.message, /Type the passphrase/)
    return true
  })
})

test('the ledger round-trips through the vault, and the plaintext never reaches storage', async () => {
  const marker = await createVault(PHRASE, CHEAP)
  await unlockVault(marker, PHRASE)
  const ledger = ledgerOf()
  const copy = await sealRecord(marker, ledger)
  assert.equal(looksSealed(copy), true)
  assert.deepEqual(copy.vault, marker)
  const text = JSON.stringify(copy)
  assert.doesNotMatch(text, /the rent/, 'a note is inside the cipher, not beside it')
  assert.doesNotMatch(text, /wageroute-backup\.json/, 'even the file it came from stays sealed')
  assert.deepEqual(await openRecord(copy), ledger)
})

test('two saves of the same ledger are not the same bytes', async () => {
  const marker = await createVault(PHRASE, CHEAP)
  await unlockVault(marker, PHRASE)
  const ledger = ledgerOf()
  const first = await sealRecord(marker, ledger)
  const second = await sealRecord(marker, ledger)
  assert.notEqual(first.record.iv, second.record.iv, 'one key over many saves needs a fresh IV each time')
  assert.notEqual(first.record.ciphertext, second.record.ciphertext)
  assert.notEqual(first.record.tag, second.record.tag)
  assert.deepEqual(await openRecord(first), ledger, 'and both still say the same ledger')
  assert.deepEqual(await openRecord(second), ledger)
})

test('a record touched after it was written does not open', async () => {
  const marker = await createVault(PHRASE, CHEAP)
  await unlockVault(marker, PHRASE)
  const copy = await sealRecord(marker, ledgerOf())
  const bytes = copy.record.ciphertext
  // Flipping one character is what a damaged file looks like from the outside, and
  // it is also what someone editing the phone's storage gets: a refusal, not a
  // ledger with one number quietly changed.
  const tampered = { ...copy, record: { ...copy.record, ciphertext: `${bytes.slice(0, -2)}${bytes.endsWith('AA') ? 'BB' : 'AA'}` } }
  await assert.rejects(() => openRecord(tampered), (error: unknown) => {
    assert.ok(error instanceof VaultError)
    assert.equal(error.failure, 'shape', 'typing the phrase again cannot fix a changed file')
    assert.match(error.message, /changed since WageRoute wrote it/)
    return true
  })
})

test('sealing with a vault that has closed says so instead of writing garbage', async () => {
  const marker = await createVault(PHRASE, CHEAP)
  await unlockVault(marker, PHRASE)
  lockVault()
  await assert.rejects(() => sealRecord(marker, ledgerOf()), (error: unknown) => {
    assert.ok(error instanceof VaultError)
    assert.equal(error.failure, 'closed')
    assert.match(error.message, /Type its passphrase first/)
    return true
  })
})

test('a screen holding an old marker will not seal under a new vault', async () => {
  const first = await createVault(PHRASE, CHEAP)
  const second = await createVault(OTHER, CHEAP)
  await unlockVault(second, OTHER)
  // Two tabs: one is still showing the vault that was replaced. Sealing with the
  // open key under the stale marker would write a copy the stored marker cannot open.
  await assert.rejects(() => sealRecord(first, ledgerOf()), (error: unknown) => {
    assert.ok(error instanceof VaultError)
    assert.equal(error.failure, 'closed')
    assert.match(error.message, /Unlock it again/)
    return true
  })
})

test('a vault closed and reopened opens the copy its key sealed', async () => {
  const marker = await createVault(PHRASE, CHEAP)
  await unlockVault(marker, PHRASE)
  const copy = await sealRecord(marker, ledgerOf())
  lockVault()
  assert.equal(vaultIsOpen(), false)
  await unlockVault(marker, PHRASE)
  assert.deepEqual(await openRecord(copy), ledgerOf())
})

test('a changed passphrase opens the new vault and not the old one', async () => {
  const marker = await createVault(PHRASE, CHEAP)
  const ledger = ledgerOf()
  await unlockVault(marker, PHRASE)
  const copy = await sealRecord(marker, ledger)
  const changed = await changeVaultPassphrase(marker, PHRASE, OTHER, CHEAP)
  assert.notEqual(changed.salt, marker.salt, 'a new phrase is a new salt, not a re-wrap')
  assert.equal(vaultIsOpen(), true, 'and this page keeps working under the new one')
  assert.deepEqual(await openRecord(await sealRecord(changed, ledger)), ledger)
  // The old marker still exists on disk until the caller replaces it, and the old
  // phrase must be finished with it: the copy is the same bytes either way, so the
  // only proof is that the new key opens what the new marker describes.
  lockVault()
  await assert.rejects(() => unlockVault(marker, OTHER), /does not open/)
  await assert.rejects(() => unlockVault(changed, PHRASE), /does not open/)
  await unlockVault(changed, OTHER)
})

test('the wrong current phrase stops a change before anything is rewritten', async () => {
  const marker = await createVault(PHRASE, CHEAP)
  await assert.rejects(
    () => changeVaultPassphrase(marker, 'not the phrase', OTHER, CHEAP),
    (error: unknown) => {
      assert.ok(error instanceof VaultError)
      assert.equal(error.failure, 'passphrase')
      return true
    }
  )
  assert.equal(vaultIsOpen(), false, 'a refused change leaves no key behind')
})

test('a marker that does not parse is refused before a key is made from it', async () => {
  const marker = await createVault(PHRASE, CHEAP)
  const cases: [string, unknown, RegExp][] = [
    ['a foreign format', { ...marker, format: 'other-vault' }, /format WageRoute does not recognise/],
    ['a newer version', { ...marker, version: 3 }, /newer WageRoute/],
    ['an unknown cipher', { ...marker, cipher: 'AES-128-CBC' }, /cannot open/],
    ['a missing salt', { ...marker, salt: undefined }, /missing its salt/],
    [
      'a check with no tag',
      { ...marker, check: { iv: marker.check.iv, ciphertext: marker.check.ciphertext } },
      /missing the tag/
    ],
    ['nothing at all', null, /no vault parameters came with it/]
  ]
  for (const [what, value, message] of cases) {
    assert.throws(() => assertMarker(value), message, what)
  }
  // A cost outside the guard rails is caught when it is used, not when the marker is
  // read: a hostile marker must not be able to make the derivation cheap.
  await assert.rejects(
    () => unlockVault({ ...marker, iterations: 1 } as VaultMarker, PHRASE),
    (error: unknown) => {
      assert.ok(error instanceof VaultError)
      assert.equal(error.failure, 'shape')
      assert.match(error.message, /outside what WageRoute will do/)
      return true
    }
  )
  await assert.rejects(
    () => unlockVault({ ...marker, iterations: 999_999_999 } as VaultMarker, PHRASE),
    /outside what WageRoute will do/,
    'and an absurd count is refused too, before the person waiting for their data hangs'
  )
  assert.match(
    JSON.stringify({ ...marker, salt: 'c2FsdA==' }),
    /c2FsdA==/,
    'a short salt is a base64 string like any other, so the length is checked where it is decoded'
  )
  await assert.rejects(
    () => unlockVault({ ...marker, salt: 'c2FsdA==' } as VaultMarker, PHRASE),
    (error: unknown) => {
      assert.ok(error instanceof VaultError)
      assert.equal(error.failure, 'shape')
      assert.match(error.message, /salt is 4 bytes and it should be 16/)
      return true
    }
  )
})

test('a record that is not a vault is not treated as one', () => {
  assert.equal(looksSealed(ledgerOf()), false)
  assert.equal(looksSealed({ vault: {}, record: {} }), false, 'an empty object is not a marker')
  assert.equal(looksSealed(null), false)
  assert.equal(looksSealed({ vault: { format: 'wageroute-vault' }, record: {} }), true)
})

test('a sealed record that does not hold a ledger is reported, not trusted', async () => {
  const marker = await createVault(PHRASE, CHEAP)
  // The cipher authenticates the bytes, so this can only be reached by a build that
  // wrote something other than a ledger. The key is derived the way the vault
  // derives it, and the wrong object is sealed with the same cipher: that is the
  // only way to hand `openRecord` something it must refuse rather than show an empty
  // app over nothing.
  const key = await deriveKey(PHRASE, fromBase64(marker.salt, 'salt'), MIN_ITERATIONS, ['encrypt'])
  const junk = await sealPart(key, JSON.stringify({ version: 10 }))
  await unlockVault(marker, PHRASE)
  await assert.rejects(
    () => openRecord({ vault: marker, record: junk }),
    (error: unknown) => {
      assert.ok(error instanceof VaultError)
      assert.equal(error.failure, 'shape')
      assert.match(error.message, /does not hold a ledger/)
      return true
    }
  )
  const notJson = await sealPart(key, 'this was never an object')
  await assert.rejects(
    () => openRecord({ vault: marker, record: notJson }),
    /does not hold readable ledger data/
  )
})

/** A page with no cipher has to be refused as itself: not a bad phrase, not a damaged file. */
function refusedForNoCipher(error: unknown): true {
  assert.ok(error instanceof EnvelopeError || error instanceof VaultError, 'a typed refusal')
  assert.equal(error.failure, 'shape', 'nothing a person can fix by typing again')
  assert.match(error.message, /no cipher/)
  assert.doesNotMatch(
    error.message,
    /does not open|changed since/,
    'and the sentence never blames the phrase or the file'
  )
  return true
}

test('the cipher seam refuses a page that has no cipher instead of meeting undefined', async () => {
  const marker = await createVault(PHRASE, CHEAP)
  const salt = fromBase64(marker.salt, 'salt')
  const key = await deriveKey(PHRASE, salt, MIN_ITERATIONS, ['encrypt', 'decrypt'])
  const part = await sealPart(key, 'the rent')
  await withoutCipher(async () => {
    assert.equal(hasCipher(), false, 'the page is the shape of one served over a LAN address')
    await assert.rejects(() => deriveKey(PHRASE, salt, MIN_ITERATIONS, ['encrypt']), refusedForNoCipher)
    await assert.rejects(() => sealPart(key, 'the rent'), refusedForNoCipher)
    // `openPart` answers a bad tag with null, because a wrong phrase and a damaged
    // file are the same fact to the cipher. A page with no cipher is a third thing,
    // and returning null for it would be heard as one of the other two.
    await assert.rejects(() => openPart(key, part), refusedForNoCipher)
  })
  assert.equal(hasCipher(), true, 'and the page gets its cipher back')
  assert.equal(await openPart(key, part), 'the rent', 'sealed before the walk, readable after it')
})

test('a vault neither starts nor opens on a page with no cipher, and says which', async () => {
  const marker = await createVault(PHRASE, CHEAP)
  await unlockVault(marker, PHRASE)
  const copy = await sealRecord(marker, ledgerOf())
  lockVault()
  await withoutCipher(async () => {
    await assert.rejects(() => createVault(OTHER, CHEAP), refusedForNoCipher)
    assert.equal(vaultIsOpen(), false, 'a seal that could not run leaves no key behind')
    await assert.rejects(() => unlockVault(marker, PHRASE), refusedForNoCipher)
    assert.equal(vaultIsOpen(), false, 'and an unlock that could not run is not half in')
  })
  await unlockVault(marker, PHRASE)
  assert.deepEqual(
    await openRecord(copy),
    ledgerOf(),
    'the phrase that opens this vault still opens it after a page with no cipher refused'
  )
})

/*
 * Vault v2 (ADR 0031): a data key with wraps. Every test below starts from a v1
 * vault, because that is what every phone already holds.
 */
const PIN = '482915'
const CHEAP_V2 = { iterations: MIN_ITERATIONS, pinIterations: MIN_ITERATIONS }

function bytes(fill: number): string {
  return Buffer.alloc(32, fill).toString('base64')
}

/** A platform authenticator stand-in: the same PRF output every time, unless told not to. */
function ceremony(options: { same?: boolean; cancel?: boolean } = {}) {
  const seen: PasskeyRequest[] = []
  const run = async (request: PasskeyRequest): Promise<PasskeyAnswer> => {
    seen.push(request)
    if (options.cancel) return { ok: false, reason: 'cancelled', detail: 'NotAllowedError' }
    if (request.mode === 'register') {
      return { ok: true, mode: 'register', credentialId: 'cred-1', first: bytes(5), test: bytes(options.same === false ? 6 : 5) }
    }
    return { ok: true, mode: 'assert', output: bytes(5) }
  }
  return { run, seen }
}

async function v1WithLedger(): Promise<{ marker: VaultMarker; ledger: StoredLedger }> {
  const marker = await createVault(PHRASE, CHEAP)
  await unlockVault(marker, PHRASE)
  return { marker, ledger: ledgerOf() }
}

test('a v1 vault stays v1, and still opens, until a PIN is added', async () => {
  const { marker, ledger } = await v1WithLedger()
  assert.equal(marker.version, 1)
  const sealed = await sealRecord(marker, ledger)
  lockVault()
  await unlockVault(marker, PHRASE)
  assert.deepEqual(await openRecord(sealed), ledger)
})

test('adding a PIN moves a v1 vault to v2 in one re-seal, and both the phrase and the PIN open it', async () => {
  const { marker, ledger } = await v1WithLedger()
  const next = await addVaultWrap(marker, PHRASE, { kind: 'pin', pin: PIN }, CHEAP_V2)
  assert.ok(isV2(next))
  assert.ok(next.wraps.passphrase && next.wraps.pin && !next.wraps.passkey)
  assert.equal(next.wraps.passphrase.iterations, MIN_ITERATIONS, 'the phrase keeps the cost it had')
  // The session moved to the new data key, so the record is re-sealed under the new marker.
  const resealed = await sealRecord(next, ledger)
  await assert.rejects(() => sealRecord(marker, ledger), /changed since/, 'the old v1 marker no longer seals')
  assertMarker(JSON.parse(JSON.stringify(next)))

  for (const typed of [PHRASE, PIN]) {
    lockVault()
    await unlockVault(next, typed)
    assert.deepEqual(await openRecord(resealed), ledger, `${typed === PIN ? 'the PIN' : 'the phrase'} opens it`)
  }
  lockVault()
  await assert.rejects(() => unlockVault(next, '482916'), (error: unknown) => {
    assert.ok(error instanceof VaultError)
    assert.equal(error.failure, 'passphrase')
    return true
  })
})

test('the current secret is proved before anything is added', async () => {
  const { marker } = await v1WithLedger()
  await assert.rejects(() => addVaultWrap(marker, OTHER, { kind: 'pin', pin: PIN }, CHEAP_V2), /does not open/)
  await assert.rejects(() => addVaultWrap(marker, PHRASE, { kind: 'pin', pin: '12345' }, CHEAP_V2), /at least 6 digits/)
})

test('a passkey wraps the same key, opens the vault with nothing typed, and leaves the phrase in place', async () => {
  const { marker, ledger } = await v1WithLedger()
  const authenticator = ceremony()
  const next = await addVaultWrap(marker, PHRASE, { kind: 'passkey', rpId: 'ann.wageroute.lan' }, {
    ...CHEAP_V2,
    ceremony: authenticator.run
  })
  assert.ok(isV2(next) && next.wraps.passkey && next.wraps.passphrase)
  assert.equal(next.wraps.passkey.rpId, 'ann.wageroute.lan')
  assert.equal(JSON.stringify(next).includes(bytes(5)), false, 'the PRF output is not stored')
  const sealed = await sealRecord(next, ledger)

  lockVault()
  await unlockVaultWithPasskey(next, authenticator.run)
  assert.deepEqual(await openRecord(sealed), ledger)
  const asked = authenticator.seen.at(-1)
  assert.equal(asked?.mode, 'assert')
  assert.equal(asked?.mode === 'assert' ? asked.credentialId : null, 'cred-1')

  // A lost passkey: the phrase still opens the same copy.
  lockVault()
  await assert.rejects(() => unlockVaultWithPasskey(next, ceremony({ cancel: true }).run), /cancelled/)
  await unlockVault(next, PHRASE)
  assert.deepEqual(await openRecord(sealed), ledger)
})

test('a passkey that does not give the same secret twice is refused and nothing is written', async () => {
  const { marker } = await v1WithLedger()
  await assert.rejects(
    () => addVaultWrap(marker, PHRASE, { kind: 'passkey', rpId: 'localhost' }, { ...CHEAP_V2, ceremony: ceremony({ same: false }).run }),
    /same secret back twice/
  )
})

test('a passkey is never the only way in, and the phrase stays while one exists', async () => {
  const { marker } = await v1WithLedger()
  let next: VaultMarker = await addVaultWrap(marker, PHRASE, { kind: 'pin', pin: PIN }, CHEAP_V2)
  next = await addVaultWrap(next, PIN, { kind: 'passkey', rpId: 'localhost' }, { ...CHEAP_V2, ceremony: ceremony().run })
  assert.throws(() => removeVaultWrap(next, 'passphrase'), /passphrase stays while a fingerprint/)
  next = removeVaultWrap(next, 'pin')
  assert.throws(() => removeVaultWrap(next, 'passphrase'), /passphrase stays/)
  next = removeVaultWrap(next, 'passkey')
  assert.ok(isV2(next) && next.wraps.passphrase && !next.wraps.passkey && !next.wraps.pin)
  assert.throws(() => removeVaultWrap(next, 'passphrase'), /last thing you can type/)

  // Without a passphrase there is no passkey to add.
  let pinOnly: VaultMarker = await addVaultWrap(next, PHRASE, { kind: 'pin', pin: PIN }, CHEAP_V2)
  pinOnly = removeVaultWrap(pinOnly, 'passphrase')
  await assert.rejects(
    () => addVaultWrap(pinOnly, PIN, { kind: 'passkey', rpId: 'localhost' }, { ...CHEAP_V2, ceremony: ceremony().run }),
    /Add a passphrase first/
  )
})

test('a marker whose only wrap is a passkey is not trusted', async () => {
  const { marker } = await v1WithLedger()
  const next = await addVaultWrap(marker, PHRASE, { kind: 'passkey', rpId: 'localhost' }, { ...CHEAP_V2, ceremony: ceremony().run })
  assert.ok(isV2(next))
  const tampered = { ...next, wraps: { passkey: next.wraps.passkey } }
  assert.throws(() => assertMarker(tampered), /nothing typed that opens it/)
})

test('on v2, changing the phrase or the PIN is a rewrap and the record stays readable', async () => {
  const { marker, ledger } = await v1WithLedger()
  const v2 = await addVaultWrap(marker, PHRASE, { kind: 'pin', pin: PIN }, CHEAP_V2)
  const sealed = await sealRecord(v2, ledger)
  const phraseChanged = await changeVaultPassphrase(v2, PHRASE, OTHER, CHEAP)
  const pinChanged = await changeVaultPin(phraseChanged, PIN, '736251', CHEAP)
  await assert.rejects(() => changeVaultPin(pinChanged, '000001', '111112', CHEAP), /does not open/)
  lockVault()
  await assert.rejects(() => unlockVault(pinChanged, PHRASE), /does not open/)
  await unlockVault(pinChanged, OTHER)
  assert.deepEqual(await openRecord(sealed), ledger, 'the same record opens: only the wraps moved')
  lockVault()
  await unlockVault(pinChanged, '736251')
  assert.deepEqual(await openRecord(sealed), ledger)
})


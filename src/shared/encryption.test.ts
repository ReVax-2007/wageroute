import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CUSTODY_COPY,
  MAX_PASSPHRASE_CHARACTERS,
  MIN_PASSPHRASE_CHARACTERS,
  custodyCopy,
  custodyInUse,
  passphraseProblem
} from './encryption'

test('every custody option says what it protects, what it does not and how it locks you out', () => {
  assert.deepEqual(
    CUSTODY_COPY.map((copy) => copy.value),
    ['device', 'passphrase', 'both']
  )
  for (const copy of CUSTODY_COPY) {
    assert.ok(copy.label.trim().length > 0, `${copy.value} has no label`)
    assert.ok(copy.headline.trim().length > 0, `${copy.value} has no headline`)
    assert.ok(copy.protects.trim().length > 0, `${copy.value} claims protection without naming it`)
    // The rule this module exists for: an option may not be offered without its
    // weakness, or the toggle implies a guarantee the app cannot make.
    assert.ok(copy.fails.trim().length > 0, `${copy.value} names no limitation`)
    assert.ok(copy.lockout.trim().length > 0, `${copy.value} does not say how it locks the owner out`)
    assert.ok(copy.fails.split(' ').length > 8, `${copy.value}'s limitation is not a sentence`)
  }
  // The one that matters most: nobody should be able to read this screen and
  // conclude that a wrong passphrase gets tried a limited number of times.
  assert.match(custodyCopy('passphrase').fails, /offline/)
  assert.match(custodyCopy('passphrase').lockout, /no reset/i)
  assert.match(custodyCopy('device').fails, /signed in|signing in/i)
  assert.equal(custodyCopy('both').headline.includes('Either one'), true)
})

test('the passphrase rule is length and repetition, not a strength meter', () => {
  assert.equal(passphraseProblem(''), 'Choose a passphrase — it is the only thing that opens the ledger.')
  assert.match(passphraseProblem('shorty123') ?? '', /at least 10 characters/)
  assert.match(passphraseProblem('x'.repeat(MIN_PASSPHRASE_CHARACTERS - 1)) ?? '', /at least 10 characters/)
  assert.match(passphraseProblem('123456789') ?? '', /at least 10 characters/)
  assert.equal(passphraseProblem('0123456789'), null)
  assert.equal(passphraseProblem('correct horse battery'), null)
  assert.equal(passphraseProblem('correct-horse-battery-staple'), null)
  // Spaces and punctuation are neither stripped nor punished: what the user
  // types is what the wrap is derived from, so the field and the rule must agree.
  assert.equal(passphraseProblem("pâsse 'phraze' ✓ 1234"), null)
  assert.match(passphraseProblem('aaaaaaaaaaaaaaaa') ?? '', /repeated/)
  assert.match(passphraseProblem('éééééééééééé') ?? '', /repeated/)
  assert.equal(passphraseProblem('ab'.repeat(MAX_PASSPHRASE_CHARACTERS / 2)), null)
  assert.match(passphraseProblem('a'.repeat(MAX_PASSPHRASE_CHARACTERS + 1)) ?? '', /1024 characters/)
})

test('the status report maps to the option name the screen shows', () => {
  assert.equal(custodyInUse({ device: true, passphrase: true }), 'both')
  assert.equal(custodyInUse({ device: true, passphrase: false }), 'device')
  assert.equal(custodyInUse({ device: false, passphrase: true }), 'passphrase')
  assert.equal(custodyInUse({ device: false, passphrase: false }), null)
})

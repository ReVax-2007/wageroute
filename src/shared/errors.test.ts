import assert from 'node:assert/strict'
import test from 'node:test'
import { RepositoryError, decodeError, encodeError } from './errors'

test('a repository error carries its code through the wire marker', () => {
  const encoded = encodeError(new RepositoryError('VALIDATION', 'Goal name is required', 'name'))
  const decoded = decodeError(encoded)
  assert.equal(decoded.code, 'VALIDATION')
  assert.equal(decoded.message, 'Goal name is required')
})

test('a plain error keeps its message and gains no code', () => {
  const decoded = decodeError(encodeError(new Error('no such column: foo')))
  assert.equal(decoded.code, null)
  assert.equal(decoded.message, 'no such column: foo')
})

test('a message that already contains the marker is not double-decoded', () => {
  const decoded = decodeError(encodeError(new Error('odd [[wageroute: text')))
  assert.equal(decoded.code, null)
  assert.equal(decoded.message, 'odd [[wageroute: text')
})

test('decoding an unrelated message returns it untouched', () => {
  assert.deepEqual(decodeError('Could not read the file'), {
    code: null,
    message: 'Could not read the file'
  })
})

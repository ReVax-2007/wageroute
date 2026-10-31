import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { writeFileAtomic } from './files'

test('an export replaces the target and keeps its contents private', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wageroute-files-'))
  const target = join(dir, 'backup.json')

  writeFileAtomic(target, '{"first":true}', 0o600)
  writeFileAtomic(target, '{"second":true}', 0o600)

  assert.equal(readFileSync(target, 'utf8'), '{"second":true}')
  // Windows has no POSIX mode bits; there the user profile's ACL is what
  // keeps the file private, so only assert the mode where it is meaningful.
  if (process.platform !== 'win32') {
    assert.equal(statSync(target).mode & 0o777, 0o600)
  }
  assert.deepEqual(
    readdirSync(dir),
    ['backup.json'],
    'no temporary file survives a successful write'
  )
  rmSync(dir, { recursive: true, force: true })
})

test('a failed write leaves the previous file untouched', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wageroute-files-'))
  const target = join(dir, 'backup.json')
  writeFileSync(target, 'previous')

  const missingDirectory = join(dir, 'no-such-folder', 'backup.json')
  assert.throws(() => writeFileAtomic(missingDirectory, 'next', 0o600))
  assert.equal(readFileSync(target, 'utf8'), 'previous')
  assert.deepEqual(readdirSync(dir), ['backup.json'])
  rmSync(dir, { recursive: true, force: true })
})

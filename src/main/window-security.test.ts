import assert from 'node:assert/strict'
import test from 'node:test'
import { isAllowedExternalUrl, isTrustedPageUrl, permissionAllowed } from './window-security'

const PACKAGED = 'file:///Applications/WageRoute.app/out/renderer/index.html'
const DEV = 'http://localhost:5173'

test('the packaged page is trusted exactly, not by string prefix', () => {
  assert.equal(isTrustedPageUrl(PACKAGED, undefined, PACKAGED), true)
  assert.equal(isTrustedPageUrl(`${PACKAGED}#/goals`, undefined, PACKAGED), true)
  assert.equal(isTrustedPageUrl(`${PACKAGED}.attacker.test/`, undefined, PACKAGED), false)
  assert.equal(isTrustedPageUrl('file:///tmp/other.html', undefined, PACKAGED), false)
})

test('the dev server is trusted by origin, so a lookalike host is refused', () => {
  assert.equal(isTrustedPageUrl(`${DEV}/`, DEV, PACKAGED), true)
  assert.equal(isTrustedPageUrl('http://localhost:5173/#/settings', DEV, PACKAGED), true)
  assert.equal(isTrustedPageUrl('http://localhost:5173.attacker.test/', DEV, PACKAGED), false)
  assert.equal(isTrustedPageUrl('http://localhost:5174/', DEV, PACKAGED), false)
  assert.equal(isTrustedPageUrl('not a url', DEV, PACKAGED), false)
})

test('only the support page may open in the system browser', () => {
  assert.equal(isAllowedExternalUrl('https://buymeacoffee.com/revax'), true)
  assert.equal(isAllowedExternalUrl('https://buymeacoffee.com/revax/'), true)
  assert.equal(isAllowedExternalUrl('https://buymeacoffee.com.evil.test/revax'), false)
  assert.equal(isAllowedExternalUrl('https://evil.test/revax'), false)
  assert.equal(isAllowedExternalUrl('http://buymeacoffee.com/revax'), false, 'https only')
  assert.equal(isAllowedExternalUrl('file:///etc/passwd'), false)
  assert.equal(isAllowedExternalUrl('javascript:alert(1)'), false)
})

test('only a sanitised clipboard write is permitted', () => {
  assert.equal(permissionAllowed('clipboard-sanitized-write'), true, 'the copy buttons need it')
  for (const denied of [
    'clipboard-read',
    'media',
    'geolocation',
    'notifications',
    'openExternal',
    'fullscreen',
    'pointerLock',
    ''
  ]) {
    assert.equal(permissionAllowed(denied), false, `${denied} stays denied`)
  }
})

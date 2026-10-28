const { execFileSync } = require('node:child_process')
const { readdirSync } = require('node:fs')
const { join } = require('node:path')

// electron-builder runs this after each macOS app bundle is assembled and
// before the DMG is built. Without it the bundle ships with an invalid
// signature, which Gatekeeper reports as "damaged" on Apple Silicon.
module.exports = async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return
  const app = readdirSync(context.appOutDir).find((entry) => entry.endsWith('.app'))
  if (!app) throw new Error(`no app bundle found in ${context.appOutDir}`)
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', join(context.appOutDir, app)], {
    stdio: 'inherit'
  })
}

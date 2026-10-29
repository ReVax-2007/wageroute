const { execFileSync } = require('node:child_process')
const { readdirSync } = require('node:fs')
const { join } = require('node:path')

// electron-builder runs this after the signing step and the fuse flip, so the
// ad-hoc signature covers the final binary before the DMG is built. Without
// it the bundle ships unsigned, which Gatekeeper reports as "damaged".
module.exports = async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return
  const app = readdirSync(context.appOutDir).find((entry) => entry.endsWith('.app'))
  if (!app) throw new Error(`no app bundle found in ${context.appOutDir}`)
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', join(context.appOutDir, app)], {
    stdio: 'inherit'
  })
}

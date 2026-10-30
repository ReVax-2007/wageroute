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
  const appPath = join(context.appOutDir, app)
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' })
  // A silent signing failure would only surface as "app is damaged" on someone
  // else's Mac, so the signature is checked here while the build can still fail.
  // spctl is deliberately not used: it rejects ad-hoc signatures by design.
  execFileSync('codesign', ['--verify', '--strict', '--verbose=2', appPath], {
    stdio: 'inherit'
  })
}

const { execFileSync } = require('node:child_process')
const { lstatSync, readdirSync } = require('node:fs')
const { join, sep } = require('node:path')

/**
 * electron-builder runs this after the signing step and the fuse flip, so the
 * ad-hoc signature covers the final binary before the DMG is built. Without it
 * the bundle ships unsigned, which Gatekeeper reports as "damaged".
 *
 * `--deep` is avoided on purpose: it lets codesign choose an order Apple says
 * is unreliable. Every Mach-O file and every nested bundle is signed from the
 * deepest path up, so a seal is only written after everything it covers. The
 * Electron Framework binary has no extension, which is why a suffix rule is not
 * enough; `file` decides what is code. Verification afterwards uses --deep
 * because there it only checks, it does not choose what to sign.
 */

const BUNDLE_SUFFIXES = ['.app', '.framework', '.xpc', '.appex', '.plugin', '.bundle']

function walk(directory, visit) {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry)
    const info = lstatSync(path)
    // Symlinks such as Versions/Current point at a path that is already walked.
    if (info.isSymbolicLink()) continue
    if (info.isDirectory()) walk(path, visit)
    else visit(path)
  }
}

function walkBundles(directory, out) {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry)
    const info = lstatSync(path)
    if (info.isSymbolicLink() || !info.isDirectory()) continue
    if (BUNDLE_SUFFIXES.some((suffix) => entry.endsWith(suffix))) out.add(path)
    walkBundles(path, out)
  }
}

function isMachO(path) {
  try {
    return execFileSync('file', ['-b', path], { encoding: 'utf8' }).includes('Mach-O')
  } catch {
    return false
  }
}

function depth(path) {
  return path.split(sep).length
}

function sign(target) {
  execFileSync('codesign', ['--force', '--sign', '-', '--timestamp=none', target], {
    stdio: 'inherit'
  })
}

module.exports = async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return
  const app = readdirSync(context.appOutDir).find((entry) => entry.endsWith('.app'))
  if (!app) throw new Error(`no app bundle found in ${context.appOutDir}`)
  const appPath = join(context.appOutDir, app)

  const nested = new Set()
  walk(appPath, (path) => {
    if (isMachO(path)) nested.add(path)
  })
  walkBundles(appPath, nested)

  for (const target of [...nested].sort((a, b) => depth(b) - depth(a))) sign(target)
  sign(appPath)

  // A silent signing failure would only surface as "app is damaged" on someone
  // else's Mac, so the signature is checked here while the build can still fail.
  // spctl is deliberately not used: it rejects ad-hoc signatures by design, so
  // passing it is not a property this build can have.
  execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath], {
    stdio: 'inherit'
  })
}

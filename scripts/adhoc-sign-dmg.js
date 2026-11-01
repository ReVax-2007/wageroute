const { execFileSync } = require('node:child_process')

/**
 * Signs the disk image itself after it is built. The signature inside the DMG
 * already protects the app; this makes the outer container carry one too, so a
 * tampered download is detectable before it is mounted.
 */
module.exports = async function adhocSignArtifacts(buildResult) {
  if (process.platform !== 'darwin') return []
  for (const artifact of buildResult.artifactPaths.filter((path) => path.endsWith('.dmg'))) {
    execFileSync('codesign', ['--force', '--sign', '-', artifact], { stdio: 'inherit' })
    execFileSync('codesign', ['--verify', '--verbose=2', artifact], { stdio: 'inherit' })
  }
  return []
}

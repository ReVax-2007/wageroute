// Packages the app on this machine, stamped as a development build.
//
//   npm run dist:local          unpacked app for this machine (release/<platform>/)
//   npm run dist:mac | win | linux | dist
//
// A build made here is not a release, so its version gets a `-dev` suffix
// (1.3.1 -> 1.3.1-dev): the sidebar, Settings -> About and the diagnostics
// report then say so. Releases are packaged by .github/workflows/build.yml,
// which calls electron-builder directly and keeps the plain version. A release
// assembled by hand sets WAGEROUTE_RELEASE=1 to keep it plain here too.
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const release = process.env.WAGEROUTE_RELEASE === '1'
const stamped = release || version.endsWith('-dev') ? version : `${version}-dev`
const args = [...process.argv.slice(2), `-c.extraMetadata.version=${stamped}`, '--publish', 'never']

process.stdout.write(`dist: packaging WageRoute ${stamped}\n`)
const run = spawnSync('electron-builder', args, { stdio: 'inherit', shell: process.platform === 'win32' })
process.exit(run.status ?? 1)

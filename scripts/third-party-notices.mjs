#!/usr/bin/env node
/**
 * Builds THIRD-PARTY-NOTICES.txt from the lockfile's production tree.
 *
 * Electron ships its own licence with the runtime, and every package that ends
 * up inside the bundle is listed here with the licence text its own package
 * contains. Dev-only packages are left out because they are not distributed.
 */
import { readFileSync, readdirSync, writeFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const lockPath = join(root, 'package-lock.json')
const outputPath = join(root, 'THIRD-PARTY-NOTICES.txt')

const LICENSE_FILE = /^(licen[cs]e|copying|copyright|notice)(\.(md|txt|markdown))?$/i

function readLicenseText(directory) {
  let names
  try {
    names = readdirSync(directory)
  } catch {
    return ''
  }
  const file = names.find((name) => LICENSE_FILE.test(name))
  if (!file) return ''
  try {
    if (!statSync(join(directory, file)).isFile()) return ''
    return readFileSync(join(directory, file), 'utf8').trim()
  } catch {
    return ''
  }
}

function readLock() {
  try {
    return JSON.parse(readFileSync(lockPath, 'utf8'))
  } catch (error) {
    console.error(`Cannot read ${lockPath}: ${error.message}`)
    process.exit(1)
  }
}

const lock = readLock()
const entries = Object.entries(lock.packages ?? {})
  .filter(([path, info]) => path.startsWith('node_modules/') && info.dev !== true)
  .map(([path, info]) => {
    const name = info.name ?? path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length)
    return {
      name,
      version: info.version ?? 'unknown',
      license: info.license ?? 'UNKNOWN',
      repository: typeof info.repository === 'string' ? info.repository : info.repository?.url,
      text: readLicenseText(join(root, path))
    }
  })
  .filter((item) => item.name && item.version)
  .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))

if (entries.length === 0) {
  console.error('No production packages found. Run `npm ci` before generating notices.')
  process.exit(1)
}

const lines = [
  'WageRoute — third-party notices',
  '',
  'WageRoute itself is source-available under the terms in LICENSE.',
  'It is built on the following third-party software. Each entry lists the',
  'package, the licence it declares and the licence text shipped with it.',
  '',
  'Electron is distributed under the MIT licence; its complete notices live',
  'inside the Electron framework bundled with this application.',
  '',
  `Generated from package-lock.json — ${entries.length} production package${entries.length === 1 ? '' : 's'}.`,
  ''
]

for (const entry of entries) {
  lines.push('='.repeat(78))
  lines.push(`${entry.name} ${entry.version}`)
  lines.push(`License: ${entry.license}`)
  if (entry.repository) lines.push(`Repository: ${entry.repository}`)
  lines.push('='.repeat(78))
  lines.push('')
  lines.push(entry.text || 'No licence file was included in the package.')
  lines.push('')
}

writeFileSync(outputPath, `${lines.join('\n')}\n`, 'utf8')
console.log(`Wrote ${outputPath} (${entries.length} packages)`)

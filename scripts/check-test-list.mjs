import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

// The test runner takes an explicit file list, so a new *.test.ts that nobody
// adds to package.json silently never runs. This makes that omission a failure.

const root = process.cwd()
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

const onDisk = []
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) walk(path)
    else if (entry.name.endsWith('.test.ts')) onDisk.push(relative(root, path).split(sep).join('/'))
  }
}
walk(join(root, 'src'))

const listed = new Set(
  pkg.scripts.test.split(/\s+/).filter((part) => part.endsWith('.test.ts'))
)
const unlisted = onDisk.filter((file) => !listed.has(file)).sort()
const missing = [...listed].filter((file) => !onDisk.includes(file)).sort()

if (unlisted.length > 0) {
  console.error(`Not in "npm test", so they would never run:\n  ${unlisted.join('\n  ')}`)
}
if (missing.length > 0) {
  console.error(`In "npm test" but not on disk:\n  ${missing.join('\n  ')}`)
}
if (unlisted.length > 0 || missing.length > 0) process.exit(1)

#!/usr/bin/env node
/**
 * The conventions the compiler cannot see. Deliberately small: every rule here
 * has one unambiguous fix, so a failure never turns into a style debate.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(fileURLToPath(import.meta.url), '..', '..')

const RULES = [
  { pattern: /\bdebugger\b/, message: 'remove the debugger statement' },
  { pattern: /console\.(log|debug)\s*\(/, message: 'remove the console log; surface it in the UI or the log file' },
  { pattern: /@ts-(ignore|expect-error)\b/, message: 'fix the type instead of suppressing it' },
  { pattern: /:\s*any\b/, message: 'name the real type instead of any' },
  {
    pattern: /\bas\s+any\b(?=\s*[,);.\]}]|$)/,
    message: 'narrow with a guard instead of asserting any'
  }
]

function walk(directory) {
  const found = []
  for (const name of readdirSync(directory)) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const path = join(directory, name)
    const info = statSync(path)
    if (info.isDirectory()) found.push(...walk(path))
    else if (/\.(ts|tsx|mjs|cjs)$/.test(name)) found.push(path)
  }
  return found
}

const files = walk(join(root, 'src')).concat(process.argv.slice(2).map((path) => join(root, path)))
const problems = []

for (const file of files) {
  const lines = readFileSync(file, 'utf8').split('\n')
  lines.forEach((line, index) => {
    for (const rule of RULES) {
      if (rule.pattern.test(line)) {
        problems.push(`${relative(root, file)}:${index + 1}  ${rule.message}`)
      }
    }
  })
}

if (problems.length > 0) {
  console.error(`lint: ${problems.length} problem${problems.length === 1 ? '' : 's'}`)
  for (const problem of problems) console.error(`  ${problem}`)
  process.exit(1)
}

console.log(`lint: ${files.length} files clean`)

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

const root = fileURLToPath(new URL('.', import.meta.url))
const outDir = fileURLToPath(new URL('../../dist-pocket', import.meta.url))
const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
  version: string
}

/**
 * The installed app runs from a static origin, so it can afford the same
 * narrow policy the desktop build uses. Dev keeps its inline refresh script.
 */
const PRODUCTION_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'"
].join('; ')

function strictCsp(): Plugin {
  return {
    name: 'wageroute-pocket-csp',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace('__CSP__', PRODUCTION_CSP)
    }
  }
}

/**
 * The service worker lives in `public/`, so Vite copies it without seeing the
 * hashed filenames it must cache. This fills in the release stamp and the exact
 * asset list, which is what makes a reopen with no signal show the app instead
 * of a blank page.
 */
function offlineShell(): Plugin {
  return {
    name: 'wageroute-pocket-sw',
    apply: 'build',
    closeBundle() {
      const template = readFileSync(join(root, 'public', 'sw.js'), 'utf8')
      const assetDir = join(outDir, 'assets')
      const assets = existsSync(assetDir)
        ? readdirSync(assetDir)
            .filter((file) => /\.(js|css|woff2?|png|svg|webp)$/.test(file))
            .sort()
            .map((file) => `./assets/${file}`)
        : []
      const buildId = createHash('sha1').update(assets.join('\n')).digest('hex').slice(0, 8)
      const output = template
        .replace('__SHELL_VERSION__', `pocket-${pkg.version}-${buildId}`)
        .replace('/* __PRECACHE__ */ []', JSON.stringify(assets))
      writeFileSync(join(outDir, 'sw.js'), output)
    }
  }
}

export default defineConfig({
  root,
  base: './',
  define: { __POCKET_VERSION__: JSON.stringify(pkg.version) },
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('../shared', import.meta.url))
    }
  },
  plugins: [react(), strictCsp(), offlineShell()],
  build: {
    outDir,
    emptyOutDir: true
  }
})

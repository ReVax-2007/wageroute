import { readFileSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

const root = fileURLToPath(new URL('.', import.meta.url))
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

export default defineConfig({
  root,
  base: './',
  define: { __POCKET_VERSION__: JSON.stringify(pkg.version) },
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('../shared', import.meta.url))
    }
  },
  plugins: [react(), strictCsp()],
  build: {
    outDir: fileURLToPath(new URL('../../dist-pocket', import.meta.url)),
    emptyOutDir: true
  }
})

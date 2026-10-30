import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'

const shared = resolve('src/shared')

/**
 * The dev renderer needs an inline script for React Refresh and a socket to the
 * Vite server. The packaged one needs neither, so the policy is narrowed at
 * build time instead of being loosened for everyone.
 */
const PRODUCTION_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'"
].join('; ')

function strictCsp(): Plugin {
  return {
    name: 'wageroute-strict-csp',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace(
        /<meta\s+http-equiv="Content-Security-Policy"[^>]*>/,
        `<meta http-equiv="Content-Security-Policy" content="${PRODUCTION_CSP}" />`
      )
    }
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': shared } }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': shared } }
  },
  renderer: {
    base: './',
    resolve: {
      alias: {
        '@shared': shared,
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [react(), strictCsp()]
  }
})

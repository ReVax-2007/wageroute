/**
 * The window may only navigate to its own page, and only one external link is
 * allowed to leave the app. Both checks are exact rather than prefix-based: a
 * prefix test would accept `http://localhost:5173.attacker.test/`, and the
 * navigation guard is the last line of defence for the whole ledger API.
 */
const EXTERNAL_URLS = new Set(['https://buymeacoffee.com/revax'])

export function isAllowedExternalUrl(raw: string): boolean {
  try {
    const url = new URL(raw)
    const page = `${url.origin}${url.pathname.replace(/\/$/, '')}`
    return url.protocol === 'https:' && EXTERNAL_URLS.has(page)
  } catch {
    return false
  }
}

export function isTrustedPageUrl(
  raw: string,
  devUrl: string | undefined,
  packagedUrl: string
): boolean {
  const page = raw.split('#')[0]
  if (!devUrl) return page === packagedUrl
  try {
    return new URL(page).origin === new URL(devUrl).origin
  } catch {
    return false
  }
}

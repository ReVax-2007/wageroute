/**
 * The window may only navigate to its own page, and only one external link is
 * allowed to leave the app. Both checks are exact rather than prefix-based: a
 * prefix test would accept `http://localhost:5173.attacker.test/`, and the
 * navigation guard is the last line of defence for the whole ledger API.
 *
 * One query string is accepted, and only beside the app's own document: the
 * unlock gate loads the same bundle with `?mode=unlock` so a locked ledger can
 * show a prompt without registering a single ledger channel.
 */
const EXTERNAL_URLS = new Set(['https://buymeacoffee.com/revax'])
export const UNLOCK_QUERY = 'mode=unlock'

/**
 * The unlock page's three exact addresses: passphrase only (the plain query, as
 * before), PIN only, or either. Exact strings rather than a parsed query, so the
 * trust check below stays a comparison and not a parser.
 */
export const UNLOCK_QUERIES = [UNLOCK_QUERY, `${UNLOCK_QUERY}&typed=pin`, `${UNLOCK_QUERY}&typed=either`] as const

export function unlockQueryFor(accepts: { passphrase: boolean; pin: boolean }): string {
  if (accepts.pin && accepts.passphrase) return UNLOCK_QUERIES[2]
  if (accepts.pin) return UNLOCK_QUERIES[1]
  return UNLOCK_QUERIES[0]
}

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
  if (page === packagedUrl || UNLOCK_QUERIES.some((query) => page === `${packagedUrl}?${query}`)) return true
  if (!devUrl) return false
  try {
    return new URL(page).origin === new URL(devUrl).origin
  } catch {
    return false
  }
}

/**
 * Chromium asks before a page writes to the clipboard; the copy buttons depend
 * on the sanitised text write. Reading the clipboard, media capture, geolocation
 * and every other capability stay denied — the app is a local ledger and needs
 * none of them. Only sanitised writes are in the allowlist.
 */
const ALLOWED_PERMISSIONS: ReadonlySet<string> = new Set(['clipboard-sanitized-write'])

export function permissionAllowed(permission: string): boolean {
  return ALLOWED_PERMISSIONS.has(permission)
}

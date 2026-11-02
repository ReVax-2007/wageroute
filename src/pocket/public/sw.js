/* WageRoute Pocket keeps its own shell and the release's hashed scripts on the
   phone so the ledger opens with no signal. Nothing here touches the ledger
   itself: that lives in IndexedDB. The build fills in the version and the asset
   list below; in development the list is empty and assets cache as they load. */

const SHELL_VERSION = '__SHELL_VERSION__'
/* The origin may host other apps (GitHub Pages shares one per account), so a
   cache name carries this app's prefix and only prefixed caches are removed. */
const CACHE_PREFIX = 'wageroute-pocket-'
const SHELL_CACHE = `${CACHE_PREFIX}${SHELL_VERSION}`
const ASSETS = /* __PRECACHE__ */ []
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './favicon.svg',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png',
  './apple-touch-icon.png'
]

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE)
      // The core files must all arrive or a reopen without signal shows a
      // blank page. Hashed assets are added one by one, so one bad file cannot
      // block an otherwise working offline shell.
      await cache.addAll(SHELL)
      await Promise.all(ASSETS.map((url) => cache.add(url).catch(() => undefined)))
      await self.skipWaiting()
    })()
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(
          names
            .filter((name) => name.startsWith(CACHE_PREFIX) && name !== SHELL_CACHE)
            .map((name) => caches.delete(name))
        )
      )
      .then(() => self.clients.claim())
  )
})

/** A page load always tries the network, so a release lands on the next open. */
async function navigationResponse(request) {
  try {
    return await fetch(request)
  } catch {
    const cache = await caches.open(SHELL_CACHE)
    // A dev server marks the shell `Vary: Origin`; the fallback still has to
    // find it, and the shell's content does not vary by request header.
    return (
      (await cache.match('./index.html', { ignoreVary: true })) ??
      (await cache.match('./', { ignoreVary: true })) ??
      Response.error()
    )
  }
}

/** Hashed files never change under the same name, so the cache is truth. */
async function assetResponse(request) {
  const cache = await caches.open(SHELL_CACHE)
  // The dev server marks responses `Vary: Origin`; the install fetch and the
  // browser's script request do not carry the same headers, so a plain match
  // misses and the offline page loads without its scripts. A hashed name
  // cannot change, so the variation is irrelevant here.
  const hit = await cache.match(request, { ignoreVary: true })
  if (hit) return hit
  try {
    const response = await fetch(request)
    if (response.ok && response.type === 'basic') cache.put(request, response.clone())
    return response
  } catch {
    // No cached copy and no signal. Answer with a failed response instead of
    // rejecting the fetch handler, which would leave an unhandled error.
    return Response.error()
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return
  event.respondWith(
    request.mode === 'navigate' ? navigationResponse(request) : assetResponse(request)
  )
})

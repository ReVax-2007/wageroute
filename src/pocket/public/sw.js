/* WageRoute Pocket keeps its own shell on the phone so the ledger opens with
   no signal. Nothing here touches the ledger itself: that lives in IndexedDB.
   Bump SHELL_VERSION whenever the app is released so old files are dropped. */

const SHELL_VERSION = 'pocket-1'
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
    caches
      .open(SHELL_VERSION)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(names.filter((name) => name !== SHELL_VERSION).map((name) => caches.delete(name)))
      )
      .then(() => self.clients.claim())
  )
})

/** A page load always tries the network, so a release lands on the next open. */
async function navigationResponse(request) {
  try {
    return await fetch(request)
  } catch {
    const cache = await caches.open(SHELL_VERSION)
    return (await cache.match('./index.html')) ?? (await cache.match('./')) ?? Response.error()
  }
}

/** Hashed files never change under the same name, so the cache is truth. */
async function assetResponse(request) {
  const cache = await caches.open(SHELL_VERSION)
  const hit = await cache.match(request)
  if (hit) return hit
  const response = await fetch(request)
  if (response.ok && response.type === 'basic') cache.put(request, response.clone())
  return response
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

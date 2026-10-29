/* Neteco delivery app service worker. Caches only the static app shell; API traffic is never intercepted or stored. */
const CACHE = 'neteco-reparto-shell-v1'
const SHELL = ['/reparto', '/reparto.webmanifest', '/reparto-icon.svg']

function isStaticAsset(url) {
  return (
    url.pathname.startsWith('/_nuxt/') ||
    url.pathname === '/reparto.webmanifest' ||
    url.pathname === '/reparto-icon.svg'
  )
}
function isShellNavigation(request, url) {
  return request.mode === 'navigate' && (url.pathname === '/reparto' || url.pathname === '/reparto/')
}
/** Pure decision used by the fetch handler (and by tests): what to do with a request. */
function strategyFor(request, selfOrigin) {
  if (request.method !== 'GET') return 'bypass'
  const url = new URL(request.url)
  if (url.origin !== selfOrigin) return 'bypass'
  if (url.pathname.startsWith('/api/')) return 'bypass'
  if (isShellNavigation(request, url)) return 'network-first'
  if (isStaticAsset(url)) return 'cache-first'
  return 'bypass'
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  )
})
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  )
})
self.addEventListener('fetch', (event) => {
  const strategy = strategyFor(event.request, self.location.origin)
  if (strategy === 'bypass') return
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE)
      if (strategy === 'cache-first') {
        const hit = await cache.match(event.request)
        if (hit) return hit
      }
      try {
        const response = await fetch(event.request)
        if (response.ok && response.type !== 'opaque' && response.type !== 'opaqueredirect')
          await cache.put(event.request, response.clone())
        return response
      } catch (error) {
        const fallback = await cache.match(strategy === 'network-first' ? '/reparto' : event.request)
        if (fallback) return fallback
        throw error
      }
    })()
  )
})
// Exposed for tests only; harmless in a worker scope.
self.__strategyFor = strategyFor

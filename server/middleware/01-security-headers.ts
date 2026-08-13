export default defineEventHandler((event) => {
  const config = useRuntimeConfig(event)
  const isProduction = config.appEnv === 'production'
  const path = getRequestURL(event).pathname

  setHeader(
    event,
    'content-security-policy',
    [
      "default-src 'self'",
      "base-uri 'self'",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "form-action 'self' https://sis-t.redsys.es:25443 https://sis.redsys.es",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "style-src 'self' 'unsafe-inline'",
      "script-src 'self' 'unsafe-inline'",
      "connect-src 'self'"
    ].join('; ')
  )
  setHeader(event, 'referrer-policy', 'strict-origin-when-cross-origin')
  setHeader(event, 'permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=()')
  setHeader(event, 'x-content-type-options', 'nosniff')
  setHeader(event, 'x-frame-options', 'DENY')
  setHeader(event, 'cross-origin-opener-policy', 'same-origin')

  if (isProduction) setHeader(event, 'strict-transport-security', 'max-age=63072000; includeSubDomains; preload')
  if (path.startsWith('/admin') || config.appEnv !== 'production') {
    setHeader(event, 'x-robots-tag', 'noindex, nofollow, noarchive')
  }
})

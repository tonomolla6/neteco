const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
const SIGNED_WEBHOOK_PATHS = new Set(['/api/payments/redsys/notification', '/api/webhooks/email'])

function configuredOrigins(baseUrl: string) {
  const configured = (process.env.CORS_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)
  return new Set([new URL(baseUrl).origin, ...configured.map((origin) => new URL(origin).origin)])
}

function normalizedOrigin(value: string | undefined) {
  if (!value) return null
  try {
    return new URL(value).origin
  } catch {
    return null
  }
}

export default defineEventHandler(async (event) => {
  const method = event.method.toUpperCase()
  const requestUrl = getRequestURL(event)
  const path = requestUrl.pathname
  const runtime = useRuntimeConfig(event)
  const origins = configuredOrigins(String(runtime.public.baseUrl))
  const origin = getHeader(event, 'origin')
  const allowedOrigin = !!origin && origins.has(normalizedOrigin(origin) ?? '')

  setHeader(event, 'vary', 'Origin')
  if (origin && allowedOrigin) {
    setHeader(event, 'access-control-allow-origin', origin)
    setHeader(event, 'access-control-allow-credentials', 'true')
  }

  if (method === 'OPTIONS') {
    if (!origin || !allowedOrigin) {
      throw createError({ statusCode: 403, statusMessage: 'Origen no autorizado' })
    }
    setHeader(event, 'access-control-allow-methods', 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS')
    setHeader(event, 'access-control-allow-headers', 'Content-Type, X-CSRF-Token')
    setHeader(event, 'access-control-max-age', '600')
    return sendNoContent(event, 204)
  }

  if (!MUTATING_METHODS.has(method) || SIGNED_WEBHOOK_PATHS.has(path)) return
  if (origin && allowedOrigin) return

  const referer = getHeader(event, 'referer')
  if (!origin && referer) {
    try {
      if (origins.has(new URL(referer).origin)) return
    } catch {
      // A malformed referrer must fail closed.
    }
  }
  throw createError({ statusCode: 403, statusMessage: 'Validación CSRF fallida' })
})

import Redis from 'ioredis'
import { privacyHash } from '../../server/utils/rate-limit'
import { expect, test } from '../fixtures/playwright'

const redisConnection = process.env.REDIS_URL ?? 'redis://localhost:56379/0'

test('blocks cross-site mutations and allows the configured storefront origin', async ({ request, baseURL }) => {
  for (const path of ['/api/auth/logout', '/api/newsletter/subscribe', '/api/support/tickets']) {
    const missingOrigin = await request.post(path)
    expect(missingOrigin.status(), `${path} without Origin`).toBe(403)

    const crossSite = await request.post(path, { headers: { origin: 'https://attacker.invalid' } })
    expect(crossSite.status(), `${path} from a foreign Origin`).toBe(403)
    expect(crossSite.headers()['access-control-allow-origin']).toBeUndefined()
  }

  const sameSite = await request.post('/api/auth/logout', {
    headers: { origin: new URL(baseURL!).origin }
  })
  expect(sameSite.ok()).toBe(true)
  expect(await sameSite.json()).toEqual({ ok: true })

  const sameSiteReferer = await request.post('/api/auth/logout', { headers: { referer: `${baseURL}/cuenta` } })
  expect(sameSiteReferer.status()).toBe(200)
  const malformedReferer = await request.post('/api/auth/logout', { headers: { referer: 'not a URL' } })
  expect(malformedReferer.status()).toBe(403)

  const redsysWebhook = await request.post('/api/payments/redsys/notification')
  expect(redsysWebhook.status()).toBe(400)
  const emailWebhook = await request.post('/api/webhooks/email')
  expect(emailWebhook.status()).toBe(401)
})

test('serves explicit credentialed CORS preflight only to the configured origin', async ({ request, baseURL }) => {
  const origin = new URL(baseURL!).origin
  const allowed = await request.fetch('/api/auth/logout', {
    method: 'OPTIONS',
    headers: { origin, 'access-control-request-method': 'POST' }
  })
  expect(allowed.status()).toBe(204)
  expect(allowed.headers()['access-control-allow-origin']).toBe(origin)
  expect(allowed.headers()['access-control-allow-credentials']).toBe('true')
  expect(allowed.headers()['access-control-allow-methods']).toContain('POST')

  const rejected = await request.fetch('/api/auth/logout', {
    method: 'OPTIONS',
    headers: { origin: 'https://attacker.invalid', 'access-control-request-method': 'POST' }
  })
  expect(rejected.status()).toBe(403)
})

test('returns 429 and Retry-After when the public search budget is exhausted', async ({ request, deterministic }) => {
  const headers = {
    'user-agent': `neteco-rate-test-${deterministic.token('user-agent').slice(0, 16)}`,
    'x-forwarded-for': '198.51.100.101'
  }
  const key = `neteco:rate:search:${privacyHash(`${headers['x-forwarded-for']}:${headers['user-agent']}`)}`
  const redis = new Redis(redisConnection, { maxRetriesPerRequest: 1 })
  try {
    await redis.del(key)
    for (let index = 0; index < 60; index += 1) {
      const response = await request.get('/api/search?q=sin-resultados-rate-limit', { headers })
      expect(response.status()).toBe(200)
    }
    const limited = await request.get('/api/search?q=sin-resultados-rate-limit', { headers })
    expect(limited.status()).toBe(429)
    expect(limited.headers()['retry-after']).toMatch(/^\d+$/)
  } finally {
    await redis.del(key)
    await redis.quit()
  }
})

test('enforces an endpoint-level authentication budget independently by subject', async ({
  request,
  baseURL,
  deterministic
}) => {
  const email = deterministic.email('rate-limited-login')
  const ip = '198.51.100.102'
  const headers = {
    origin: new URL(baseURL!).origin,
    'user-agent': `neteco-login-rate-${deterministic.token('user-agent').slice(0, 16)}`,
    'x-forwarded-for': ip
  }
  const key = `neteco:rate:login:${privacyHash(`${ip}:${email}`)}`
  const redis = new Redis(redisConnection, { maxRetriesPerRequest: 1 })
  try {
    await redis.del(key)
    for (let index = 0; index < 5; index += 1) {
      const response = await request.post('/api/auth/login', {
        data: { email, password: 'Incorrect-password-2026' },
        headers
      })
      expect(response.status()).toBe(401)
      expect(response.headers()['x-ratelimit-remaining']).toBe(String(4 - index))
    }
    const limited = await request.post('/api/auth/login', {
      data: { email, password: 'Incorrect-password-2026' },
      headers
    })
    expect(limited.status()).toBe(429)
    expect(limited.headers()['retry-after']).toMatch(/^\d+$/)
  } finally {
    await redis.del(key)
    await redis.quit()
  }
})

test('escapes XSS in rendered search output and parameterizes SQL-like inputs', async ({ page, request }) => {
  const xss = '<img src=x onerror="globalThis.__netecoXss=true"><script>globalThis.__netecoXss=true</script>'
  await page.goto(`/buscar?q=${encodeURIComponent(xss)}`)
  await expect(page.getByRole('heading', { level: 1 })).toContainText(xss)
  expect(await page.locator('h1 img, h1 script').count()).toBe(0)
  expect(await page.evaluate(() => (globalThis as typeof globalThis & { __netecoXss?: boolean }).__netecoXss)).toBe(
    undefined
  )

  const catalogBefore = await request.get('/api/products?limit=1')
  expect(catalogBefore.status()).toBe(200)
  const before = (await catalogBefore.json()) as { total: number }
  for (const payload of ["' OR 1=1 --", "'; DROP TABLE products; --", "') UNION SELECT pg_sleep(1) --"]) {
    const response = await request.get(
      `/api/products?q=${encodeURIComponent(payload)}&sort=${encodeURIComponent(payload)}`
    )
    expect(response.status(), await response.text()).toBe(200)
  }
  const catalogAfter = await request.get('/api/products?limit=1')
  expect(catalogAfter.status()).toBe(200)
  expect(((await catalogAfter.json()) as { total: number }).total).toBe(before.total)
})

test('sets the complete security-header and private-cookie contract', async ({ request }) => {
  for (const path of ['/api/health/live', '/missing-security-route']) {
    const response = await request.get(path)
    expect(response.status()).toBe(path === '/api/health/live' ? 200 : 404)
    const headers = response.headers()
    expect(headers['content-security-policy']).toContain("default-src 'self'")
    expect(headers['content-security-policy']).toContain("object-src 'none'")
    expect(headers['content-security-policy']).toContain("frame-ancestors 'none'")
    expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin')
    expect(headers['permissions-policy']).toContain('camera=()')
    expect(headers['x-content-type-options']).toBe('nosniff')
    expect(headers['x-frame-options']).toBe('DENY')
    expect(headers['cross-origin-opener-policy']).toBe('same-origin')
    expect(headers['x-correlation-id']).toBeTruthy()
    expect(headers['strict-transport-security']).toBeUndefined()
  }

  const cart = await request.get('/api/cart')
  expect(cart.status()).toBe(200)
  const cookie = (await cart.headersArray())
    .filter(({ name }) => name.toLowerCase() === 'set-cookie')
    .map(({ value }) => value)
    .find((value) => value.startsWith('neteco-cart='))
  expect(cookie).toBeTruthy()
  expect(cookie).toContain('HttpOnly')
  expect(cookie).toContain('SameSite=Lax')
  expect(cookie).toContain('Path=/')
  expect(cookie).toMatch(/Max-Age=\d+/)
  expect(cookie).not.toContain('Secure')
})

import Redis from 'ioredis'
import { privacyHash } from '../../server/utils/rate-limit'
import { expect, test } from '../fixtures/playwright'

const redisConnection = process.env.REDIS_URL ?? 'redis://localhost:56379/0'

test('blocks cross-site mutations and allows the configured storefront origin', async ({ request, baseURL }) => {
  const missingOrigin = await request.post('/api/auth/logout')
  expect(missingOrigin.status()).toBe(403)

  const crossSite = await request.post('/api/auth/logout', {
    headers: { origin: 'https://attacker.invalid' }
  })
  expect(crossSite.status()).toBe(403)
  expect(crossSite.headers()['access-control-allow-origin']).toBeUndefined()

  const sameSite = await request.post('/api/auth/logout', {
    headers: { origin: new URL(baseURL!).origin }
  })
  expect(sameSite.ok()).toBe(true)
  expect(await sameSite.json()).toEqual({ ok: true })
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

import { readFile } from 'node:fs/promises'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { deterministicUuid } from '../fixtures/deterministic'
import { seedInventoryFixture } from '../support/d1-sqlite'
import { provisionPublicationValidityFixture } from '../support/publication-validity-fixture'
import { preferencesFixture, CLAIMS, OPTIONS, NOW, BEFORE } from './d1-account-preferences-fixture'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import { createD1ProductWatch } from '../../workers/marketing/product-watch'
import { handleProductWatchRequest } from '../../workers/marketing/product-watch-http'
import { PRODUCT_WATCH_POLICY_VERSION, productWatchItemSchema } from '../../shared/product-watch'

let fixture: Awaited<ReturnType<typeof preferencesFixture>>
let cookie: string
const origin = 'https://product-watch.example.invalid'
const configuration = { password: 'synthetic-product-watch-http-cookie-over32', maxAgeSeconds: 3600 }
const hmacKey = new Uint8Array(32).fill(7)

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(NOW))
  fixture = await preferencesFixture(true)
  try {
    seedInventoryFixture(fixture.sqlite)
    await provisionPublicationValidityFixture(fixture.database, { productIds: ['p-1'], now: BEFORE })
    fixture.sqlite.exec(await readFile('db/d1/migrations/0087_product_watch.sql', 'utf8'))
    fixture.sqlite.exec(await readFile('db/d1/migrations/0090_cart_recovery.sql', 'utf8'))
    cookie = (await issueD1SessionCookie(fixture.database, CLAIMS, configuration))!.split(';')[0]!
  } catch (cause) {
    fixture.sqlite.close()
    throw cause
  }
})
afterEach(() => {
  fixture?.sqlite.close()
  vi.useRealTimers()
})

it('reads one exact owner-bound watch after its receipt without writes or confirmation credentials', async () => {
  const receipt = await createD1ProductWatch(
    fixture.database,
    CLAIMS,
    {
      variantId: 11,
      kind: 'price_drop',
      consent: true,
      policyVersion: PRODUCT_WATCH_POLICY_VERSION
    },
    deterministicUuid('product-watch-http-create'),
    { ...OPTIONS, hmacKey }
  )
  const before = fixture.sqlite.prepare('SELECT total_changes() total').get()
  const response = await handleProductWatchRequest(
    new Request(`${origin}/api/account/product-watches/${receipt.watchId}`, {
      headers: { Cookie: cookie, 'CF-Connecting-IP': '192.0.2.87' }
    }),
    {
      database: fixture.database,
      sessionCookieConfiguration: configuration,
      origin,
      edgeLimiter: { limit: async () => ({ success: true }) } as unknown as RateLimit,
      rateLimitPepper: 'synthetic-product-watch-http-rate-pepper-over32',
      now: OPTIONS.now,
      hmacKey
    }
  )
  expect(response?.status).toBe(200)
  const body = await response!.json()
  expect(body).toMatchObject({
    source: 'cloudflare',
    evaluatedAt: NOW,
    item: { id: receipt.watchId, version: receipt.version, status: 'pending' }
  })
  expect(productWatchItemSchema.safeParse(body.item).success).toBe(true)
  expect(JSON.stringify(body)).not.toMatch(/pw1\.|token|recipient|@|costNet|costUnit/)
  expect(response!.headers.get('cache-control')).toBe('private, no-store')
  expect(response!.headers.has('set-cookie')).toBe(false)
  expect(fixture.sqlite.prepare('SELECT total_changes() total').get()).toEqual(before)
})

import { readFile } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { returnsFixture, CLAIMS, BUYER_CLAIMS, utc } from './d1-returns-fixture'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import { handleMarketCatalogHttp } from '../../workers/catalog/market-catalog-http'
import { seedDefaultMarkets } from '../../workers/catalog/market-catalog'

const MIGRATION_PATH_106 = 'db/d1/migrations/0106_inventory_lots_costing_forecast.sql'
const MIGRATION_PATH_118 = 'db/d1/migrations/0118_recall_market_messaging.sql'
const MIGRATION_PATH_120 = 'db/d1/migrations/0120_market_catalog_international_shipping.sql'

const origin = 'https://markets.neteco.test'
const config = { password: 'synthetic-market-catalog-secret-password-32', maxAgeSeconds: 3600 }

describe('Market Catalog and International Shipping HTTP Endpoints', () => {
  let f: Awaited<ReturnType<typeof returnsFixture>>
  let adminCookie: string
  let buyerCookie: string
  const productId = 'p-1'

  beforeEach(async () => {
    f = await returnsFixture()
    f.sqlite.exec(await readFile(MIGRATION_PATH_106, 'utf8'))
    f.sqlite.exec(await readFile(MIGRATION_PATH_118, 'utf8'))
    f.sqlite.exec(await readFile(MIGRATION_PATH_120, 'utf8'))
    await seedDefaultMarkets(f.database, { now: () => utc() })

    adminCookie = (await issueD1SessionCookie(f.database, CLAIMS, config))!.split(';')[0]!
    buyerCookie = (await issueD1SessionCookie(f.database, BUYER_CLAIMS, config))!.split(';')[0]!
  })

  afterEach(() => {
    f?.sqlite.close()
  })

  const deps = () => ({
    database: f.database,
    origin,
    sessionCookieConfiguration: config,
    edgeLimiter: { limit: async () => ({ success: true }) } as unknown as RateLimit,
    rateLimitPepper: 'synthetic-pepper-more-than-32-characters-test',
    now: () => utc()
  })

  const req = (path: string, options: { method?: string; body?: unknown; cookie?: string; idempotencyKey?: string } = {}) => {
    const { method = 'GET', body, cookie = adminCookie, idempotencyKey = '11111111-1111-4111-8111-111111111111' } = options
    return new Request(`${origin}${path}`, {
      method,
      headers: {
        ...(cookie ? { Cookie: cookie } : {}),
        Origin: origin,
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
        'CF-Connecting-IP': '192.0.2.15'
      },
      ...(body ? { body: JSON.stringify(body) } : {})
    })
  }

  it('GET /api/storefront/markets lists active markets publicly', async () => {
    const res = await handleMarketCatalogHttp(req('/api/storefront/markets', { cookie: '' }), deps())
    expect(res?.status).toBe(200)
    const data = await res!.json() as any[]
    expect(data.length).toBeGreaterThan(0)
    expect(data.some((m) => m.code === 'ES')).toBe(true)
  })

  it('POST and GET /api/admin/market-catalog/products/:id configures and returns localized product', async () => {
    const postRes = await handleMarketCatalogHttp(
      req(`/api/admin/market-catalog/products/${productId}`, {
        method: 'POST',
        body: {
          action: 'configure',
          expectedVersion: 0,
          marketCode: 'FR',
          locale: 'fr-FR',
          isAvailable: true,
          availabilityStatus: 'available',
          minOrderQuantity: 1,
          title: 'Dégraissant FR',
          description: 'Description en français',
          slug: 'degraissant-fr',
          isCompliant: true,
          clpWarnings: ['H319']
        }
      }),
      deps()
    )
    expect(postRes?.status).toBe(200)

    const getRes = await handleMarketCatalogHttp(req(`/api/admin/market-catalog/products/${productId}`), deps())
    expect(getRes?.status).toBe(200)
    const list = await getRes!.json() as any[]
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({
      marketCode: 'FR',
      title: 'Dégraissant FR',
      slug: 'degraissant-fr'
    })
  })

  it('POST /api/admin/international-shipping/:market configures shipping policy and evaluates via storefront', async () => {
    const postRes = await handleMarketCatalogHttp(
      req('/api/admin/international-shipping/GB', {
        method: 'POST',
        body: {
          marketCode: 'GB',
          expectedVersion: 0,
          customsDeclaredValueRequired: true,
          dutyCollectionType: 'ddp',
          deMinimisThresholdCents: 15000,
          estimatedDutyRateBps: 500,
          customsHandlingFeeCents: 800,
          requiredDocuments: ['commercial_invoice'],
          adrAllowed: true,
          maxHazardClass: 'unrestricted',
          prohibitedUnNumbers: [],
          maxDangerousGoodsVolumeLiters: 100,
          requiresSpecialAdrCarrier: false,
          returnsPermitted: true,
          returnWindowDays: 14,
          hazardousReturnsAllowed: false,
          customerReturnFeeCents: 0
        }
      }),
      deps()
    )
    expect(postRes?.status).toBe(200)

    // Storefront evaluation
    const evalRes = await handleMarketCatalogHttp(
      req('/api/shipping/international-restrictions?market=GB&declaredValue=20000', { cookie: '' }),
      deps()
    )
    expect(evalRes?.status).toBe(200)
    const evalData = await evalRes!.json() as any
    expect(evalData.allowed).toBe(true)
    expect(evalData.duties.estimatedDutyCents).toBe(1000) // 20000 * 5%
  })

  it('rejects unauthorized access from non-admin users on admin endpoints', async () => {
    const res = await handleMarketCatalogHttp(
      req(`/api/admin/market-catalog/products/${productId}`, {
        method: 'POST',
        cookie: buyerCookie,
        body: {
          action: 'configure',
          expectedVersion: 0,
          marketCode: 'FR',
          locale: 'fr-FR',
          isAvailable: true,
          availabilityStatus: 'available',
          minOrderQuantity: 1,
          title: 'T',
          description: 'D',
          slug: 'slug-t',
          isCompliant: true,
          clpWarnings: []
        }
      }),
      deps()
    )
    expect(res?.status).toBe(403)
  })

  it('rejects cross-site origins on state-changing requests', async () => {
    const crossSiteReq = new Request(`${origin}/api/admin/international-shipping/FR`, {
      method: 'POST',
      headers: {
        Cookie: adminCookie,
        Origin: 'https://evil.invalid',
        'Sec-Fetch-Site': 'cross-site',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ marketCode: 'FR' })
    })
    const res = await handleMarketCatalogHttp(crossSiteReq, deps())
    expect(res?.status).toBe(403)
  })
})

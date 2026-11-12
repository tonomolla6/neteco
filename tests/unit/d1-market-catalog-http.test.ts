import { readFile } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { returnsFixture, CLAIMS, BUYER_CLAIMS, utc } from './d1-returns-fixture'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import { handleMarketCatalogHttp } from '../../workers/catalog/market-catalog-http'
import { seedDefaultMarkets } from '../../workers/catalog/market-catalog'
import { testNow } from '../support/deterministic'

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
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(testNow())
    f = await returnsFixture()
    f.sqlite.exec(await readFile(MIGRATION_PATH_106, 'utf8'))
    f.sqlite.exec(await readFile(MIGRATION_PATH_118, 'utf8'))
    f.sqlite.exec(await readFile(MIGRATION_PATH_120, 'utf8'))
    // SQLite's transaction guards use its own clock rather than the faked JS clock.
    f.sqlite
      .prepare("UPDATE auth_sessions SET expires_at='2099-01-01T00:00:00Z' WHERE id IN (?, ?)")
      .run(CLAIMS.sessionId, BUYER_CLAIMS.sessionId)
    await seedDefaultMarkets(f.database, { now: () => utc() })

    adminCookie = (await issueD1SessionCookie(f.database, CLAIMS, config))!.split(';')[0]!
    buyerCookie = (await issueD1SessionCookie(f.database, BUYER_CLAIMS, config))!.split(';')[0]!
  })

  afterEach(() => {
    f?.sqlite.close()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  const deps = () => ({
    database: f.database,
    origin,
    sessionCookieConfiguration: config,
    edgeLimiter: { limit: async () => ({ success: true }) } as unknown as RateLimit,
    rateLimitPepper: 'synthetic-pepper-more-than-32-characters-test',
    now: () => utc()
  })

  const req = (
    path: string,
    options: { method?: string; body?: unknown; cookie?: string; idempotencyKey?: string } = {}
  ) => {
    const {
      method = 'GET',
      body,
      cookie = adminCookie,
      idempotencyKey = '11111111-1111-4111-8111-111111111111'
    } = options
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
    const data = (await res!.json()) as Array<Record<string, unknown>>
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
    const list = (await getRes!.json()) as Array<Record<string, unknown>>
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
    const evalData = (await evalRes!.json()) as Record<string, unknown>
    expect(evalData.allowed).toBe(true)
    expect(evalData.duties).toMatchObject({ estimatedDutyCents: 1000 }) // 20000 * 5%
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

  it.each([
    ['/api/admin/market-catalog/products/p-1', 'GET'],
    ['/api/admin/international-shipping/ES', 'GET'],
    ['/api/admin/catalog-lots/expedition/locate-stock/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'GET'],
    ['/api/admin/catalog-lots/expedition/locate-customers/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'GET'],
    ['/api/admin/catalog-lots/expedition/check-order/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'GET'],
    ['/api/admin/catalog-lots/expedition/block', 'POST'],
    ['/api/admin/catalog-lots/expedition/unblock', 'POST']
  ])('denies a customer with MFA before accessing admin route %s', async (path, method) => {
    f.sqlite.prepare('UPDATE auth_sessions SET mfa_verified=1 WHERE id=?').run(BUYER_CLAIMS.sessionId)
    const res = await handleMarketCatalogHttp(
      req(path, { method, cookie: buyerCookie, ...(method === 'POST' ? { body: {} } : {}) }),
      deps()
    )
    expect(res?.status).toBe(403)
    expect(await res!.json()).toEqual({ error: { code: 'forbidden' } })
  })

  it('rejects a revoked admin session and an admin without MFA on lot reports', async () => {
    const path = '/api/admin/catalog-lots/expedition/locate-customers/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    f.sqlite.prepare('UPDATE auth_sessions SET mfa_verified=0 WHERE id=?').run(CLAIMS.sessionId)
    const noMfa = await handleMarketCatalogHttp(req(path), deps())
    expect(noMfa?.status).toBe(403)
    expect(await noMfa!.json()).toEqual({ error: { code: 'mfa_required' } })

    f.sqlite.prepare('UPDATE auth_sessions SET mfa_verified=1, revoked_at=? WHERE id=?').run(utc(), CLAIMS.sessionId)
    const revoked = await handleMarketCatalogHttp(req(path), deps())
    expect(revoked?.status).toBe(401)
    expect(await revoked!.json()).toEqual({ error: { code: 'unauthenticated' } })
  })

  it('rejects an expired admin session on lot reports', async () => {
    f.sqlite.prepare('UPDATE auth_sessions SET expires_at=? WHERE id=?').run(utc(-1000), CLAIMS.sessionId)
    const res = await handleMarketCatalogHttp(
      req('/api/admin/catalog-lots/expedition/locate-customers/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
      deps()
    )
    expect(res?.status).toBe(401)
    expect(await res!.json()).toEqual({ error: { code: 'unauthenticated' } })
  })

  it('fails closed without a session or when D1 authorization is unavailable', async () => {
    const path = '/api/admin/catalog-lots/expedition/locate-customers/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const noCookie = await handleMarketCatalogHttp(req(path, { cookie: '' }), deps())
    expect(noCookie?.status).toBe(401)
    expect(noCookie?.headers.get('cache-control')).toBe('private, no-store')
    vi.spyOn(f.database, 'prepare').mockImplementation(() => {
      throw new Error('synthetic_d1_unavailable')
    })
    const unavailable = await handleMarketCatalogHttp(req(path), deps())
    expect(unavailable?.status).toBe(500)
    expect(await unavailable!.json()).toEqual({ error: { code: 'internal_server_error' } })
    expect(unavailable?.headers.get('cache-control')).toBe('private, no-store')
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

  it('GET /api/storefront/products/market resolves localized product by market and slug', async () => {
    // First configure FR product
    await handleMarketCatalogHttp(
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
          title: 'Dégraissant FR Storefront',
          description: 'Description pour boutique FR',
          slug: 'degraissant-fr-storefront',
          isCompliant: true,
          clpWarnings: []
        }
      }),
      deps()
    )

    const res = await handleMarketCatalogHttp(
      req('/api/storefront/products/market?market=FR&slug=degraissant-fr-storefront', { cookie: '' }),
      deps()
    )
    expect(res?.status).toBe(200)
    const data = (await res!.json()) as Record<string, unknown>
    expect(data).toMatchObject({
      productId,
      marketCode: 'FR',
      title: 'Dégraissant FR Storefront',
      slug: 'degraissant-fr-storefront'
    })
  })

  it('GET /api/admin/catalog-lots/expedition/locate-stock and locate-customers via HTTP', async () => {
    const lotId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const warehouseLocation = (
      f.sqlite.prepare('SELECT location_id FROM inventory_balances WHERE variant_id=?').get('v-1-1') as {
        location_id: string
      }
    ).location_id

    f.sqlite
      .prepare(
        `INSERT INTO inventory_lots(id, variant_id, lot_number, location_id, status, expires_at, initial_quantity, available_quantity, version, created_at, updated_at)
         VALUES(?, 'v-1-1', 'LOT-HTTP-1', ?, 'active', ?, 100, 80, 1, ?, ?)`
      )
      .run(lotId, warehouseLocation, utc(90 * 86400000), utc(), utc())

    const stockRes = await handleMarketCatalogHttp(
      req(`/api/admin/catalog-lots/expedition/locate-stock/${lotId}`),
      deps()
    )
    expect(stockRes?.status).toBe(200)
    const stockData = (await stockRes!.json()) as Record<string, unknown>
    expect(stockData).toMatchObject({
      lotId,
      lotNumber: 'LOT-HTTP-1',
      availableQuantity: 80,
      isExpeditionBlocked: false
    })

    const customersRes = await handleMarketCatalogHttp(
      req(`/api/admin/catalog-lots/expedition/locate-customers/${lotId}`),
      deps()
    )
    expect(customersRes?.status).toBe(200)
    expect(customersRes?.headers.get('cache-control')).toBe('private, no-store')
    const customerData = (await customersRes!.json()) as Record<string, unknown>
    expect(customerData.affectedCustomers).toEqual([])
  })

  it('POST /api/admin/catalog-lots/expedition/block and unblock via HTTP', async () => {
    const lotId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const warehouseLocation = (
      f.sqlite.prepare('SELECT location_id FROM inventory_balances WHERE variant_id=?').get('v-1-1') as {
        location_id: string
      }
    ).location_id

    f.sqlite
      .prepare(
        `INSERT INTO inventory_lots(id, variant_id, lot_number, location_id, status, expires_at, initial_quantity, available_quantity, version, created_at, updated_at)
         VALUES(?, 'v-1-1', 'LOT-HTTP-BLOCK', ?, 'active', ?, 100, 80, 1, ?, ?)`
      )
      .run(lotId, warehouseLocation, utc(90 * 86400000), utc(), utc())

    const blockRes = await handleMarketCatalogHttp(
      req('/api/admin/catalog-lots/expedition/block', {
        method: 'POST',
        body: {
          lotId,
          blockReason: 'manual_quarantine',
          evidence: 'test-http-hold'
        }
      }),
      deps()
    )
    expect(blockRes?.status).toBe(200)
    const blockData = (await blockRes!.json()) as Record<string, unknown>
    expect(blockData.isBlocked).toBe(true)

    // Unblock
    const unblockRes = await handleMarketCatalogHttp(
      req('/api/admin/catalog-lots/expedition/unblock', {
        method: 'POST',
        body: {
          lotId,
          evidence: 'test-http-released'
        }
      }),
      deps()
    )
    expect(unblockRes?.status).toBe(200)
    const unblockData = (await unblockRes!.json()) as Record<string, unknown>
    expect(unblockData.isBlocked).toBe(false)
  })

  it('GET /api/admin/international-shipping/:market returns 404 when not configured', async () => {
    const res = await handleMarketCatalogHttp(req('/api/admin/international-shipping/ZZ'), deps())
    expect(res?.status).toBe(404)
    const err = (await res!.json()) as Record<string, unknown>
    expect(err).toEqual({ error: { code: 'not_found' } })
  })
})

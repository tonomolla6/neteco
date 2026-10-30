import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { bvFixture, CLAIMS, ID, utc } from './bv-fixture'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import { executeMarketCatalogCommand } from '../../workers/catalog/market-catalog'
import {
  handleInternationalFeedsAdrHttp,
  ownsInternationalFeedsAdrNamespace
} from '../../workers/catalog/international-feeds-adr-http'
import { ownsMarketCatalogNamespace } from '../../workers/catalog/market-catalog-http'
import { upsertVariantAdrSpec } from '../../workers/fulfillment/warehouse-adr-assets'

const ORIGIN = 'https://bv.neteco.test'
const config = { password: 'synthetic-bv-session-secret-password-32-chars', maxAgeSeconds: 3600 }

describe('SEO-033/034 SHP-029 HTTP surface', () => {
  let f: Awaited<ReturnType<typeof bvFixture>>
  let admin: string
  let plain: string
  beforeEach(async () => {
    f = await bvFixture()
    admin = (await issueD1SessionCookie(f.database, CLAIMS, config))!.split(';')[0]!
    plain = (await issueD1SessionCookie(f.database, f.plainClaims, config))!.split(';')[0]!
  })
  afterEach(() => f.sqlite.close())

  const deps = () => ({ database: f.database, origin: ORIGIN, sessionCookieConfiguration: config, now: () => utc() })
  let n = 500
  const call = (
    path: string,
    init: {
      method?: string
      body?: unknown
      cookie?: string | null
      origin?: string | null
      key?: string | null
      raw?: string
      fetchSite?: string
    } = {}
  ) => {
    const method = init.method ?? 'GET'
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (init.cookie !== null && init.cookie !== undefined) headers.cookie = init.cookie
    if (init.origin !== null) headers.origin = init.origin ?? ORIGIN
    if (method !== 'GET' && init.key !== null) headers['idempotency-key'] = init.key ?? ID(++n)
    if (init.fetchSite) headers['sec-fetch-site'] = init.fetchSite
    return handleInternationalFeedsAdrHttp(
      new Request(`${ORIGIN}${path}`, {
        method,
        headers,
        ...(init.raw !== undefined
          ? { body: init.raw }
          : init.body !== undefined
            ? { body: JSON.stringify(init.body) }
            : {})
      }),
      deps()
    )
  }
  const json = async (response: Response | null) => (await response!.json()) as any // eslint-disable-line @typescript-eslint/no-explicit-any

  it('claims only its own namespaces and does not shadow neighbouring routers', () => {
    for (const path of [
      '/api/storefront/seo/hreflang',
      '/api/feeds/channels/google_merchant.json',
      '/api/storefront/adr/hazard-info',
      '/api/shipping/adr/evaluate',
      '/api/admin/seo-international/translation-reviews/p-1',
      '/api/admin/channel-feeds/google_merchant/versions',
      '/api/admin/adr-limited-quantity/carrier-restrictions'
    ]) {
      expect(ownsInternationalFeedsAdrNamespace(path)).toBe(true)
      expect(ownsMarketCatalogNamespace(path)).toBe(false)
    }
    for (const path of [
      '/api/admin/market-catalog/products/p-1',
      '/api/admin/international-shipping/FR',
      '/api/shipping/international-restrictions',
      '/api/storefront/markets',
      '/api/admin/channel-feedsx',
      '/api/feeds'
    ])
      expect(ownsInternationalFeedsAdrNamespace(path)).toBe(false)
    return expect(call('/api/other')).resolves.toBeNull()
  })

  describe('public endpoints', () => {
    it('serves hreflang with caching and a stable error body', async () => {
      const ok = await call('/api/storefront/seo/hreflang?slug=producto-1')
      expect(ok!.status).toBe(200)
      expect(ok!.headers.get('cache-control')).toContain('public')
      const body = await json(ok)
      expect(body.links.map((l: { hreflang: string }) => l.hreflang)).toEqual(['es-ES', 'x-default'])
      const missing = await call('/api/storefront/seo/hreflang?slug=nope')
      expect(missing!.status).toBe(404)
      expect(missing!.headers.get('cache-control')).toContain('no-store')
      expect((await json(missing)).error.code).toBe('not_found')
      expect((await call('/api/storefront/seo/hreflang?slug=BAD SLUG'))!.status).toBe(400)
      expect((await call('/api/storefront/seo/hreflang'))!.status).toBe(400)
      expect((await call('/api/storefront/seo/hreflang?slug=producto-1', { method: 'POST', body: {} }))!.status).toBe(
        405
      )
    })

    it('serves hazard info, stating "unclassified" instead of implying safety', async () => {
      const response = await call('/api/storefront/adr/hazard-info?variantId=v-1-1')
      expect(response!.status).toBe(200)
      expect(await json(response)).toMatchObject({ classified: false, variantId: 'v-1-1' })
      expect((await call('/api/storefront/adr/hazard-info?variantId=nope'))!.status).toBe(404)
      expect((await call('/api/storefront/adr/hazard-info'))!.status).toBe(400)
    })

    it('evaluates an ADR shipment without a session and blocks missing data', async () => {
      const response = await call('/api/shipping/adr/evaluate', {
        method: 'POST',
        body: { carrierCode: 'seur', lines: [{ variantId: 'v-1-1', quantity: 1 }] },
        cookie: null
      })
      expect(response!.status).toBe(200)
      expect(response!.headers.get('cache-control')).toContain('no-store')
      expect(await json(response)).toMatchObject({
        allowed: false,
        blockers: [{ variantId: 'v-1-1', code: 'adr_data_missing' }]
      })
    })

    it('rejects malformed evaluations and cross-site posts', async () => {
      const body = { carrierCode: 'seur', lines: [{ variantId: 'v-1-1', quantity: 1 }] }
      expect(
        (await call('/api/shipping/adr/evaluate', {
          method: 'POST',
          body: { carrierCode: 'x', lines: [] },
          key: null
        }))!.status
      ).toBe(400)
      expect((await call('/api/shipping/adr/evaluate', { method: 'POST', raw: '{nope', key: null }))!.status).toBe(400)
      expect(
        (await call('/api/shipping/adr/evaluate', { method: 'POST', body, origin: 'https://evil.invalid', key: null }))!
          .status
      ).toBe(403)
      expect(
        (await call('/api/shipping/adr/evaluate', { method: 'POST', body, fetchSite: 'cross-site', key: null }))!.status
      ).toBe(403)
      expect((await call('/api/shipping/adr/evaluate'))!.status).toBe(405)
      expect(
        (await call('/api/shipping/adr/evaluate', { method: 'POST', raw: 'x'.repeat(70_000), key: null }))!.status
      ).toBe(413)
    })

    it('does not serve a feed until a version is active', async () => {
      const response = await call('/api/feeds/channels/google_merchant.json')
      expect(response!.status).toBe(404)
      expect((await call('/api/feeds/channels/amazon.json'))!.status).toBe(404)
      expect((await call('/api/feeds/channels/google_merchant.csv'))!.status).toBe(404)
    })
  })

  describe('admin endpoints', () => {
    it('require a session (401), a live administrator (403) and a same-origin mutation', async () => {
      const path = '/api/admin/channel-feeds/google_merchant'
      expect((await call(path))!.status).toBe(401)
      expect((await call(path, { cookie: plain }))!.status).toBe(403)
      expect(
        (await call(`${path}/versions`, {
          method: 'POST',
          body: { expectedLatestVersion: 0, config: {} },
          cookie: plain
        }))!.status
      ).toBe(403)
      const foreign = await call(`${path}/versions`, {
        method: 'POST',
        body: { expectedLatestVersion: 0, config: {} },
        cookie: admin,
        origin: 'https://evil.invalid'
      })
      expect(foreign!.status).toBe(403)
      expect(
        (await call(`${path}/versions`, {
          method: 'POST',
          body: { expectedLatestVersion: 0, config: {} },
          cookie: admin,
          fetchSite: 'cross-site'
        }))!.status
      ).toBe(403)
      expect(f.sqlite.prepare('SELECT count(*) AS c FROM channel_feed_transform_versions').get()).toEqual({ c: 0 })
    })

    it('rejects a revoked session even with a still-valid cookie', async () => {
      f.sqlite.exec(`UPDATE auth_sessions SET revoked_at = '${utc()}' WHERE id = '${CLAIMS.sessionId}'`)
      expect((await call('/api/admin/channel-feeds/google_merchant', { cookie: admin }))!.status).toBe(401)
    })

    it('requires an Idempotency-Key and valid JSON on mutations', async () => {
      const path = '/api/admin/channel-feeds/google_merchant/versions'
      expect(
        (await call(path, {
          method: 'POST',
          body: { expectedLatestVersion: 0, config: {} },
          cookie: admin,
          key: null
        }))!.status
      ).toBe(400)
      expect(
        (await call(path, {
          method: 'POST',
          body: { expectedLatestVersion: 0, config: {} },
          cookie: admin,
          key: 'not-a-uuid'
        }))!.status
      ).toBe(400)
      expect((await call(path, { method: 'POST', raw: '{', cookie: admin }))!.status).toBe(400)
      expect((await call(path, { method: 'PUT', body: {}, cookie: admin }))!.status).toBe(405)
      expect(
        (await call('/api/admin/channel-feeds/google_merchant/unknown', { method: 'POST', body: {}, cookie: admin }))!
          .status
      ).toBe(404)
    })

    it('runs the channel feed lifecycle: publish, activate, serve JSON/XML, reconcile', async () => {
      const base = '/api/admin/channel-feeds/google_merchant'
      const published = await call(`${base}/versions`, {
        method: 'POST',
        cookie: admin,
        body: { expectedLatestVersion: 0, config: { stockBuffer: 2 } }
      })
      expect(published!.status).toBe(200)
      expect(published!.headers.get('cache-control')).toContain('no-store')
      const key = ID(777)
      const activated = await call(`${base}/activate`, {
        method: 'POST',
        cookie: admin,
        key,
        body: { version: 1, expectedActiveVersion: 0 }
      })
      expect(activated!.status).toBe(200)
      const replay = await call(`${base}/activate`, {
        method: 'POST',
        cookie: admin,
        key,
        body: { version: 1, expectedActiveVersion: 0 }
      })
      expect(await json(replay)).toEqual(await json(activated))
      expect(
        (await call(`${base}/activate`, {
          method: 'POST',
          cookie: admin,
          body: { version: 1, expectedActiveVersion: 0 }
        }))!.status
      ).toBe(409)

      const listing = await json(await call(base, { cookie: admin }))
      expect(listing).toMatchObject({ activeVersion: 1, versions: [{ version: 1 }] })

      const feed = await json(await call('/api/feeds/channels/google_merchant.json'))
      expect(feed.transformVersion).toBe(1)
      expect(feed.items.length).toBeGreaterThan(0)
      const xmlResponse = await call('/api/feeds/channels/google_merchant.xml')
      expect(xmlResponse!.headers.get('content-type')).toContain('application/xml')
      expect(await xmlResponse!.text()).toContain('<g:id>SKU-1-1</g:id>')

      const item = feed.items[0]
      const clean = await json(
        await call(`${base}/reconcile`, {
          method: 'POST',
          cookie: admin,
          body: {
            rows: feed.items.map((i: typeof item) => ({
              sku: i.sku,
              priceCents: i.priceCents,
              quantity: i.quantity,
              availability: i.availability
            }))
          }
        })
      )
      expect(clean).toMatchObject({ consistent: true, oversellRisk: false })
      const dirty = await json(
        await call(`${base}/reconcile`, {
          method: 'POST',
          cookie: admin,
          body: {
            rows: [
              { sku: item.sku, priceCents: item.priceCents, quantity: item.quantity + 5, availability: 'in_stock' }
            ]
          }
        })
      )
      expect(dirty.oversellRisk).toBe(true)
      expect((await call(`${base}/reconcile`, { method: 'POST', cookie: admin, body: { rows: 'x' } }))!.status).toBe(
        400
      )
    })

    it('maps allocation and CAS failures to 409', async () => {
      const post = (channel: string, path: string, body: unknown) =>
        call(`/api/admin/channel-feeds/${channel}/${path}`, { method: 'POST', cookie: admin, body })
      await post('google_merchant', 'versions', { expectedLatestVersion: 0, config: { allocationPercent: 70 } })
      await post('meta_catalog', 'versions', { expectedLatestVersion: 0, config: { allocationPercent: 70 } })
      expect((await post('google_merchant', 'activate', { version: 1, expectedActiveVersion: 0 }))!.status).toBe(200)
      const over = await post('meta_catalog', 'activate', { version: 1, expectedActiveVersion: 0 })
      expect(over!.status).toBe(409)
      expect((await json(over)).error.code).toBe('allocation_exceeded')
      expect((await post('google_merchant', 'versions', { expectedLatestVersion: 0, config: {} }))!.status).toBe(409)
    })

    it('records a translation review that publishes the market alternate', async () => {
      await executeMarketCatalogCommand(
        f.database,
        CLAIMS,
        'p-1',
        ID(900),
        {
          action: 'configure',
          expectedVersion: 0,
          marketCode: 'FR',
          locale: 'fr-FR',
          title: 'Nettoyant',
          description: 'Desc',
          slug: 'nettoyant-1'
        },
        { now: () => utc() }
      )
      const path = '/api/admin/seo-international/translation-reviews/p-1'
      const review = await call(path, {
        method: 'POST',
        cookie: admin,
        body: { marketCode: 'FR', reviewedConfigVersion: 1, locale: 'fr-FR', reviewerName: 'Claire Dupont' }
      })
      expect(review!.status).toBe(200)
      const body = await json(await call('/api/storefront/seo/hreflang?slug=producto-1&market=FR'))
      expect(body.links.map((l: { hreflang: string }) => l.hreflang).sort()).toEqual(['es-ES', 'fr-FR', 'x-default'])
      expect(body.canonical).toBe(`${ORIGIN}/fr-fr/producto/nettoyant-1`)
      expect(
        (await call(path, {
          method: 'POST',
          cookie: admin,
          body: { marketCode: 'FR', reviewedConfigVersion: 1, locale: 'fr-FR', reviewerName: 'Claire Dupont' }
        }))!.status
      ).toBe(409)
      expect((await call(path, { method: 'POST', cookie: plain, body: {} }))!.status).toBe(403)
    })

    it('drives the ADR flow end to end over HTTP until the shipment is allowed', async () => {
      await upsertVariantAdrSpec(
        f.database,
        CLAIMS,
        {
          commandId: ID(910),
          variantId: 'v-1-1',
          unNumber: 'UN 1993',
          properShippingName: 'LIQUIDO INFLAMABLE, N.E.P.',
          adrClass: '3',
          packingGroup: 'II',
          tunnelCode: '(D/E)',
          limitedQuantity: '1 L',
          adrPointsFactor: 3,
          pictograms: ['GHS02'],
          signalWord: 'PELIGRO',
          hazardStatements: ['H225'],
          precautionaryStatements: ['P210'],
          ufiCode: null,
          handlingInstructions: ['Evitar calor'],
          sdsVersion: '3.2'
        },
        utc()
      )
      const evaluate = async () =>
        json(
          await call('/api/shipping/adr/evaluate', {
            method: 'POST',
            body: { carrierCode: 'seur', lines: [{ variantId: 'v-1-1', quantity: 6 }] },
            key: null
          })
        )
      expect((await evaluate()).lines[0].blockers).toEqual(['specialist_validation_missing', 'carrier_unknown'])
      const validation = await call('/api/admin/adr-limited-quantity/specialist-validations', {
        method: 'POST',
        cookie: admin,
        body: {
          variantId: 'v-1-1',
          specVersion: 1,
          status: 'validated',
          specialistName: 'Marta DGSA',
          certificateRef: 'DGSA-ES-0042',
          contentUnit: 'ml',
          innerContentAmount: 500,
          unitsPerOuter: 6,
          outerGrossGrams: 4200,
          grossLimitGrams: 30000
        }
      })
      expect(validation!.status).toBe(200)
      const rule = await call('/api/admin/adr-limited-quantity/carrier-restrictions', {
        method: 'POST',
        cookie: admin,
        body: {
          carrierCode: 'seur',
          adrClass: '3',
          packingGroup: 'II',
          allowsLimitedQuantity: true,
          maxGrossGramsPerPackage: 20000,
          expectedVersion: 0
        }
      })
      expect(rule!.status).toBe(200)
      expect(await evaluate()).toMatchObject({ allowed: true })
      expect(
        await json(await call('/api/admin/adr-limited-quantity/carrier-restrictions?carrier=seur', { cookie: admin }))
      ).toHaveLength(1)
      expect(
        await json(
          await call('/api/admin/adr-limited-quantity/specialist-validations?variantId=v-1-1', { cookie: admin })
        )
      ).toMatchObject({ version: 1, status: 'validated' })
      expect(
        (await call('/api/admin/adr-limited-quantity/carrier-restrictions?carrier=BAD!', { cookie: admin }))!.status
      ).toBe(400)
      expect(
        (await call('/api/admin/adr-limited-quantity/carrier-restrictions', {
          method: 'POST',
          cookie: plain,
          body: {}
        }))!.status
      ).toBe(403)
      expect(
        (await call('/api/admin/adr-limited-quantity/carrier-restrictions', {
          method: 'POST',
          cookie: admin,
          origin: 'https://evil.invalid',
          body: {}
        }))!.status
      ).toBe(403)
    })
  })
})

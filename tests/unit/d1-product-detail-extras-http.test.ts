import { readFile } from 'node:fs/promises'
import { splitDemoSql } from '../../scripts/lib/d1-demo-sql'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { d1OverSqlite, openMigratedDatabase, seedInventoryFixture } from '../support/d1-sqlite'
import { provisionPublicationValidityFixture } from '../support/publication-validity-fixture'
import {
  handleProductDetailExtrasHttp,
  ownsProductDetailExtrasNamespace
} from '../../workers/catalog/product-detail-extras-http'
import { productDetailExtrasSchema } from '../../shared/product-detail-extras'

const origin = 'https://extras.neteco.test'
let sqlite: DatabaseSync, database: D1Database, allowed: boolean
const edgeLimiter = { limit: async () => ({ success: allowed }) } as unknown as RateLimit
async function call(path: string, init: RequestInit = {}, db = database) {
  return handleProductDetailExtrasHttp(
    new Request(origin + path, { headers: { 'CF-Connecting-IP': '192.0.2.9' }, ...init }),
    {
      database: db,
      origin,
      edgeLimiter,
      rateLimitPepper: 'synthetic-pepper-for-tests-over-32-chars'
    }
  )
}
beforeEach(async () => {
  allowed = true
  sqlite = await openMigratedDatabase()
  database = d1OverSqlite(sqlite)
  await database.batch(
    splitDemoSql(
      await readFile(new URL('../../db/d1/migrations/0076_catalog_relations.sql', import.meta.url), 'utf8')
    ).map((sql) => database.prepare(sql))
  )
  seedInventoryFixture(sqlite)
  await provisionPublicationValidityFixture(database, { productIds: ['p-1'] })
})
afterEach(() => sqlite.close())

describe('product detail extras HTTP boundary', () => {
  it('owns only its own namespace, also when encoded', () => {
    expect(ownsProductDetailExtrasNamespace('/api/product-detail-extras')).toBe(true)
    expect(ownsProductDetailExtrasNamespace('/api/product-detail-extras/x')).toBe(true)
    expect(ownsProductDetailExtrasNamespace('/api/%70roduct-detail-extras')).toBe(true)
    expect(ownsProductDetailExtrasNamespace('/api/product-relations')).toBe(false)
    expect(ownsProductDetailExtrasNamespace('/api/products/x')).toBe(false)
  })
  it('returns null for foreign paths', async () => {
    expect(await call('/api/other')).toBeNull()
  })
  it('serves a valid response with no-store, nosniff and no cookies required', async () => {
    const response = (await call('/api/product-detail-extras?slug=producto-1'))!
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(productDetailExtrasSchema.parse(await response.json()).productSlug).toBe('producto-1')
  })
  it.each([
    '/api/product-detail-extras',
    '/api/product-detail-extras?slug=Bad',
    '/api/product-detail-extras?slug=a&slug=b',
    '/api/product-detail-extras?slug=a&sort=cheap',
    '/api/product-detail-extras?slug=a&other=1'
  ])('rejects %s with stable invalid_input', async (path) => {
    const response = (await call(path))!
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: { code: 'invalid_input' } })
  })
  it('404 for unknown product', async () => {
    const response = (await call('/api/product-detail-extras?slug=no-existe'))!
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: { code: 'not_found' } })
  })
  it.each(['POST', 'PUT', 'DELETE', 'PATCH'])('rejects %s with 405 and Allow', async (method) => {
    const response = (await call('/api/product-detail-extras?slug=producto-1', { method, body: '{}' }))!
    expect(response.status).toBe(405)
    expect(response.headers.get('allow')).toBe('GET, HEAD')
  })
  it('rejects cross-site and foreign-origin requests', async () => {
    expect(
      (await call('/api/product-detail-extras?slug=producto-1', { headers: { 'Sec-Fetch-Site': 'cross-site' } }))!
        .status
    ).toBe(403)
    expect(
      (await call('/api/product-detail-extras?slug=producto-1', { headers: { Origin: 'https://evil.test' } }))!.status
    ).toBe(403)
  })
  it('rate limits with Retry-After', async () => {
    allowed = false
    const response = (await call('/api/product-detail-extras?slug=producto-1'))!
    expect(response.status).toBe(429)
    expect(response.headers.get('retry-after')).toBe('60')
  })
  it('hides database details behind service_unavailable', async () => {
    sqlite.exec('DROP TABLE order_payment_states')
    const response = (await call('/api/product-detail-extras?slug=producto-1'))!
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: { code: 'service_unavailable' } })
  })
})

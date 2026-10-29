import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { seedInventoryFixture } from '../support/d1-sqlite'
import { categoryCommandFixture } from '../support/category-command-fixture'
import { provisionPublicationValidityFixture } from '../support/publication-validity-fixture'
import { handleProductCompareHttp, ownsProductCompareNamespace } from '../../workers/catalog/product-compare-http'
import type { ProductCompareResponse } from '../../workers/catalog/product-compare'

const ORIGIN = 'https://tienda.neteco.test'
const INSTANT = '2026-08-20T00:00:00Z'

describe('D1 Product Compare HTTP Handler', () => {
  let sqlite: DatabaseSync
  let database: D1Database
  let slug1: string
  let slug2: string
  let slug3: string
  let slug4: string

  beforeEach(async () => {
    ;({ sqlite, database } = await categoryCommandFixture())
    if (!sqlite.prepare("SELECT 1 FROM sqlite_schema WHERE name='catalog_typed_attribute_definitions'").get()) {
      sqlite.exec(
        await readFile(new URL('../../db/d1/migrations/0058_catalog_typed_attributes.sql', import.meta.url), 'utf8')
      )
    }
    seedInventoryFixture(sqlite)

    const publishedRows = sqlite
      .prepare("SELECT slug FROM products WHERE status='published' ORDER BY legacy_id LIMIT 4")
      .all() as Array<{ slug: string }>
    slug1 = publishedRows[0]!.slug
    slug2 = publishedRows[1]!.slug
    slug3 = publishedRows[2]!.slug
    slug4 = publishedRows[3]!.slug

    await provisionPublicationValidityFixture(database, {
      productIds: ['p-1', 'p-2', 'p-3', 'p-4', 'p-5', 'p-6'],
      now: '2026-08-19T00:00:00Z',
      validUntil: '2099-01-01T00:00:00Z'
    })
  })

  afterEach(() => sqlite.close())

  async function call(path: string, method = 'GET') {
    const request = new Request(`${ORIGIN}${path}`, {
      method,
      headers: {
        Accept: 'application/json'
      }
    })
    return await handleProductCompareHttp(request, { database, pricingOptions: { instant: INSTANT } })
  }

  describe('routing and namespace', () => {
    it('matches /api/products/compare correctly', () => {
      expect(ownsProductCompareNamespace('/api/products/compare')).toBe(true)
      expect(ownsProductCompareNamespace('/api/products/compare/')).toBe(true)
      expect(ownsProductCompareNamespace('/api/products')).toBe(false)
      expect(ownsProductCompareNamespace('/api/products/some-slug')).toBe(false)
      expect(ownsProductCompareNamespace('/api/categories')).toBe(false)
    })
  })

  describe('HTTP methods', () => {
    it('rejects POST with 405 Method Not Allowed and Allow header', async () => {
      const response = await call(`/api/products/compare?slugs=${slug1},${slug2}`, 'POST')
      expect(response).not.toBeNull()
      expect(response!.status).toBe(405)
      expect(response!.headers.get('allow')).toBe('GET')
      const json = await response!.json()
      expect(json).toEqual({ error: { code: 'method_not_allowed' } })
    })

    it('rejects PUT and DELETE with 405', async () => {
      const putRes = await call(`/api/products/compare?slugs=${slug1},${slug2}`, 'PUT')
      expect(putRes!.status).toBe(405)
      const delRes = await call(`/api/products/compare?slugs=${slug1},${slug2}`, 'DELETE')
      expect(delRes!.status).toBe(405)
    })
  })

  describe('request validation', () => {
    it('rejects missing slugs query param with 400', async () => {
      const response = await call('/api/products/compare')
      expect(response!.status).toBe(400)
      const json = await response!.json()
      expect(json).toEqual({ error: { code: 'invalid_compare_request' } })
    })

    it('rejects single slug with 400', async () => {
      const response = await call(`/api/products/compare?slugs=${slug1}`)
      expect(response!.status).toBe(400)
      const json = await response!.json()
      expect(json).toEqual({ error: { code: 'invalid_compare_request' } })
    })

    it('rejects 5 slugs with 400', async () => {
      const response = await call(`/api/products/compare?slugs=${slug1},${slug2},${slug3},${slug4},extra-slug`)
      expect(response!.status).toBe(400)
      const json = await response!.json()
      expect(json).toEqual({ error: { code: 'invalid_compare_request' } })
    })

    it('rejects duplicate slugs with 400', async () => {
      const response = await call(`/api/products/compare?slugs=${slug1},${slug1}`)
      expect(response!.status).toBe(400)
      const json = await response!.json()
      expect(json).toEqual({ error: { code: 'invalid_compare_request' } })
    })

    it('rejects invalid slug characters with 400', async () => {
      const response = await call(`/api/products/compare?slugs=${slug1},../hack`)
      expect(response!.status).toBe(400)
      const json = await response!.json()
      expect(json).toEqual({ error: { code: 'invalid_compare_request' } })
    })
  })

  describe('product existence & status', () => {
    it('returns 404 when any product does not exist', async () => {
      const response = await call(`/api/products/compare?slugs=${slug1},inexistente-123`)
      expect(response!.status).toBe(404)
      const json = await response!.json()
      expect(json).toEqual({ error: { code: 'product_not_found' } })
    })

    it('returns 404 without leaking draft product existence', async () => {
      sqlite.prepare("UPDATE products SET status='draft' WHERE slug=?").run(slug2)
      const response = await call(`/api/products/compare?slugs=${slug1},${slug2}`)
      expect(response!.status).toBe(404)
      const json = await response!.json()
      expect(json).toEqual({ error: { code: 'product_not_found' } })
    })
  })

  describe('successful comparison', () => {
    it('returns 200 with 2 products and valid headers', async () => {
      const response = await call(`/api/products/compare?slugs=${slug1},${slug2}`)
      expect(response!.status).toBe(200)
      expect(response!.headers.get('content-type')).toContain('application/json')
      expect(response!.headers.get('cache-control')).toBeTruthy()

      const json = (await response!.json()) as ProductCompareResponse
      expect(json.products).toHaveLength(2)
      expect(json.products[0]!.slug).toBe(slug1)
      expect(json.products[1]!.slug).toBe(slug2)
      expect(Array.isArray(json.rows)).toBe(true)
    })

    it('returns 200 with 4 products', async () => {
      const response = await call(`/api/products/compare?slugs=${slug1},${slug2},${slug3},${slug4}`)
      expect(response!.status).toBe(200)
      const json = (await response!.json()) as ProductCompareResponse
      expect(json.products).toHaveLength(4)
    })
  })
})

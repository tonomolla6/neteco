import { readFile } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { categoryCommandFixture, CATEGORY_CLAIMS, ROOT_CATEGORY } from '../support/category-command-fixture'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import {
  handlePersonalizedRerankHttp,
  ownsPersonalizedRerankNamespace
} from '../../workers/catalog/personalized-rerank-http'

const EXPERIMENT = 'rerank_affinity_v1'
const PRODUCT = '10000000-0000-4000-8000-000000000001'

describe('SEA-020: Personalized rerank & uplift HTTP contract', () => {
  let sqlite: DatabaseSync
  let database: D1Database
  let cookie: string
  const origin = 'https://admin.neteco.invalid'
  const password = 'synthetic-only-cookie-password-32-characters'

  beforeEach(async () => {
    ;({ sqlite, database } = await categoryCommandFixture())

    if (!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE name='search_rerank_experiments'").get()) {
      sqlite.exec(
        await readFile(new URL('../../db/d1/migrations/0104_semantic_search_and_rerank.sql', import.meta.url), 'utf8')
      )
    }

    sqlite.exec(`INSERT INTO brands(id,name,slug,status) VALUES ('brand-test','NETECO','brand-test','published');`)
    sqlite
      .prepare(
        `
      INSERT INTO products(id,legacy_id,name,slug,category_id,brand_id,status)
      VALUES (?, 999, 'Producto Test', 'producto-test', ?, 'brand-test', 'published')
    `
      )
      .run(PRODUCT, ROOT_CATEGORY)

    cookie = (await issueD1SessionCookie(database, CATEGORY_CLAIMS, { password, maxAgeSeconds: 3600 }))!.split(';')[0]!
  })

  afterEach(() => sqlite.close())

  const env = () => ({
    DB: database,
    AUTH_ENABLED: 'true',
    AUTH_ORIGIN: origin,
    NUXT_SESSION_PASSWORD: password
  })

  const request = (path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) =>
    new Request(origin + path, {
      method,
      headers: {
        cookie,
        origin,
        'content-type': 'application/json',
        ...headers
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    })

  it('matches ownsPersonalizedRerankNamespace correctly', () => {
    expect(ownsPersonalizedRerankNamespace('/api/admin/search-personalization/experiments')).toBe(true)
    expect(ownsPersonalizedRerankNamespace('/api/admin/search-personalization/uplift')).toBe(true)
    expect(ownsPersonalizedRerankNamespace('/api/search/rerank/events')).toBe(true)
    expect(ownsPersonalizedRerankNamespace('/api/admin/other')).toBe(false)
  })

  it('admin lists personalization experiments with private no-store cache headers', async () => {
    const res = await handlePersonalizedRerankHttp(request('/api/admin/search-personalization/experiments'), env())
    expect(res).not.toBeNull()
    expect(res!.status).toBe(200)
    expect(res!.headers.get('cache-control')).toBe('private, no-store')
    const body = (await res!.json()) as { items: Array<{ id: string; status: string }> }
    expect(body.items.length).toBeGreaterThan(0)
    expect(body.items[0]!.id).toBe(EXPERIMENT)
  })

  it('admin reads incremental uplift report', async () => {
    const res = await handlePersonalizedRerankHttp(
      request(`/api/admin/search-personalization/uplift?experimentId=${EXPERIMENT}`),
      env()
    )
    expect(res).not.toBeNull()
    expect(res!.status).toBe(200)
    const report = (await res!.json()) as {
      experimentId: string
      control: unknown
      treatment: unknown
      ctrUpliftPercent: number
      convUpliftPercent: number
    }
    expect(report.experimentId).toBe(EXPERIMENT)
    expect(report.control).toBeDefined()
    expect(report.treatment).toBeDefined()
  })

  it('records storefront tracking event (impression and click)', async () => {
    const eventId = '40000000-0000-4000-8000-000000000001'
    const sessionHash = 'a123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'

    // 1. Record impression
    const impRes = await handlePersonalizedRerankHttp(
      request('/api/search/rerank/events', 'POST', {
        type: 'impression',
        eventId,
        experimentId: EXPERIMENT,
        sessionHash,
        variant: 'control',
        userSegment: 'customer',
        queryNormalized: 'desengrasante',
        hasExplicitSort: false,
        hasExplicitFilters: false,
        productsShown: [PRODUCT]
      }),
      env()
    )
    expect(impRes!.status).toBe(201)

    // 2. Record interaction
    const clickRes = await handlePersonalizedRerankHttp(
      request('/api/search/rerank/events', 'POST', {
        type: 'interaction',
        eventId,
        clickedProductId: PRODUCT,
        clickedRank: 1,
        converted: true,
        conversionCents: 2000
      }),
      env()
    )
    expect(clickRes!.status).toBe(201)
  })

  it('rejects unauthenticated requests to administrative uplift endpoints', async () => {
    const unauthReq = new Request(origin + '/api/admin/search-personalization/uplift', {
      method: 'GET',
      headers: { origin }
    })
    const res = await handlePersonalizedRerankHttp(unauthReq, env())
    expect(res!.status).toBe(401)
  })
})

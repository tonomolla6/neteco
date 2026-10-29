import { readFile } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { categoryCommandFixture, CATEGORY_CLAIMS, ROOT_CATEGORY } from '../support/category-command-fixture'
import { provisionPublicationValidityFixture } from '../support/publication-validity-fixture'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import { handleSemanticSearchHttp, ownsSemanticSearchNamespace } from '../../workers/catalog/semantic-search-http'

const PRODUCT = '10000000-0000-4000-8000-000000000001'
const NOW = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')

describe('SEA-019: Semantic search & human evaluation HTTP contract', () => {
  let sqlite: DatabaseSync
  let database: D1Database
  let cookie: string
  const origin = 'https://admin.neteco.invalid'
  const password = 'synthetic-only-cookie-password-32-characters'

  beforeEach(async () => {
    ;({ sqlite, database } = await categoryCommandFixture())

    if (!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE name='search_human_evaluation_commands'").get()) {
      sqlite.exec(
        await readFile(new URL('../../db/d1/migrations/0104_semantic_search_and_rerank.sql', import.meta.url), 'utf8')
      )
    }

    sqlite.exec(`INSERT INTO brands(id,name,slug,status) VALUES ('brand-test','NETECO','brand-test','published');`)
    sqlite.exec(
      `INSERT INTO tax_classes(id,code,name,rate_basis_points,valid_from) VALUES ('tax-test','T21','IVA 21',2100,'2020-01-01T00:00:00Z');`
    )
    sqlite.exec(`INSERT INTO shipping_profiles(id,code,name,kind) VALUES ('ship-test','parcel','Paquete','parcel');`)

    sqlite
      .prepare(
        `
      INSERT INTO products(id,legacy_id,name,slug,category_id,brand_id,status,attributes)
      VALUES (?, 301, 'Desengrasante Profesional 5L', 'desengrasante-prof-5l', ?, 'brand-test', 'published', '{}')
    `
      )
      .run(PRODUCT, ROOT_CATEGORY)

    sqlite
      .prepare(
        `
      INSERT INTO variants(id,legacy_id,product_id,sku,format,status,price_gross_cents,tax_class_id,shipping_profile_id,mpn)
      VALUES ('var-301', 301, ?, 'DES-PROF-01', '5 L', 'published', 1500, 'tax-test', 'ship-test', 'MPN-DES-01')
    `
      )
      .run(PRODUCT)

    await provisionPublicationValidityFixture(database, {
      productIds: [PRODUCT],
      now: NOW,
      validUntil: '2099-01-01T00:00:00Z'
    })

    // Index embedding
    sqlite
      .prepare(
        `
      INSERT INTO catalog_semantic_embeddings (product_id, concept_tokens, embedding_vector, indexed_at)
      VALUES (?, '["desengrasante","grasa","cocina","industrial"]', '[0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9,0.1,0.2,0.3,0.4,0.5,0.6,0.7]', ?)
    `
      )
      .run(PRODUCT, NOW)

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
        'idempotency-key': 'http-cmd-test',
        ...headers
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    })

  it('matches ownsSemanticSearchNamespace for public and admin routes', () => {
    expect(ownsSemanticSearchNamespace('/api/search/semantic')).toBe(true)
    expect(ownsSemanticSearchNamespace('/api/admin/search-evaluations')).toBe(true)
    expect(ownsSemanticSearchNamespace('/api/admin/search-evaluations/benchmark')).toBe(true)
    expect(ownsSemanticSearchNamespace('/api/admin/other')).toBe(false)
  })

  it('serves public semantic search with private no-store headers', async () => {
    const res = await handleSemanticSearchHttp(request('/api/search/semantic?q=desengrasante'), env())
    expect(res).not.toBeNull()
    expect(res!.status).toBe(200)
    expect(res!.headers.get('cache-control')).toBe('private, no-store')
    const body = (await res!.json()) as { items: unknown[]; isSemantic: boolean }
    expect(body.items).toBeDefined()
  })

  it('rejects public semantic search with method other than GET', async () => {
    const res = await handleSemanticSearchHttp(request('/api/search/semantic', 'POST', {}), env())
    expect(res).not.toBeNull()
    expect(res!.status).toBe(405)
  })

  it('admin creates, lists, reads benchmark, and updates human evaluations', async () => {
    // 1. Initial list is empty
    const listRes = await handleSemanticSearchHttp(request('/api/admin/search-evaluations'), env())
    expect(listRes!.status).toBe(200)
    const listBody = (await listRes!.json()) as { items: unknown[]; total: number }
    expect(listBody.total).toBe(0)

    // 2. Create new evaluation
    const createRes = await handleSemanticSearchHttp(
      request(
        '/api/admin/search-evaluations',
        'POST',
        {
          action: 'save',
          id: null,
          expectedVersion: 0,
          query: 'desengrasante cocinas',
          productId: PRODUCT,
          relevanceScore: 4,
          notes: 'Relevancia perfecta para hostelería'
        },
        { 'idempotency-key': 'cmd-eval-create-1' }
      ),
      env()
    )
    expect(createRes!.status).toBe(201)
    const createBody = (await createRes!.json()) as { item: { id: string; version: number } }
    expect(createBody.item.version).toBe(1)
    const evalId = createBody.item.id

    // 3. Read benchmark metrics
    const bmRes = await handleSemanticSearchHttp(request('/api/admin/search-evaluations/benchmark'), env())
    expect(bmRes!.status).toBe(200)
    const bmBody = (await bmRes!.json()) as { totalJudgments: number; ndcgAt5: number }
    expect(bmBody.totalJudgments).toBe(1)

    // 4. Update evaluation
    const updateRes = await handleSemanticSearchHttp(
      request(
        `/api/admin/search-evaluations/${evalId}`,
        'PUT',
        {
          action: 'save',
          id: evalId,
          expectedVersion: 1,
          query: 'desengrasante cocinas',
          productId: PRODUCT,
          relevanceScore: 3,
          notes: 'Ajustado a 3 tras revisión'
        },
        { 'idempotency-key': 'cmd-eval-update-1' }
      ),
      env()
    )
    expect(updateRes!.status).toBe(200)
    const updateBody = (await updateRes!.json()) as { item: { version: number; relevanceScore: number } }
    expect(updateBody.item.version).toBe(2)
    expect(updateBody.item.relevanceScore).toBe(3)
  })

  it('rejects admin evaluation writes with missing idempotency key', async () => {
    const res = await handleSemanticSearchHttp(
      request(
        '/api/admin/search-evaluations',
        'POST',
        {
          action: 'save',
          id: null,
          expectedVersion: 0,
          query: 'desengrasante',
          productId: PRODUCT,
          relevanceScore: 4
        },
        { 'idempotency-key': '' } // empty
      ),
      env()
    )
    expect(res!.status).toBe(400)
  })

  it('rejects cross-site CSRF requests on administrative endpoints', async () => {
    const res = await handleSemanticSearchHttp(
      request(
        '/api/admin/search-evaluations',
        'POST',
        { action: 'save', id: null, expectedVersion: 0, query: 'test', productId: PRODUCT, relevanceScore: 2 },
        { origin: 'https://malicious.example.com', 'idempotency-key': 'csrf-key' }
      ),
      env()
    )
    expect(res!.status).toBe(403)
  })
})

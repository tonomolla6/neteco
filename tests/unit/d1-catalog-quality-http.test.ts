import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import { splitDemoSql } from '../../scripts/lib/d1-demo-sql'
import { d1OverSqlite, openMigratedDatabase, seedInventoryFixture } from '../support/d1-sqlite'
import { handleD1AdminCatalogRequest } from '../../workers/catalog/admin-catalog-http'
import { handleCatalogQualityHttp, ownsCatalogQualityNamespace } from '../../workers/catalog/catalog-quality-http'

const NOW = '2026-09-30T09:00:00Z'
const ORIGIN = 'https://neteco.invalid'
const WRITER_ID = '10000000-0000-4000-8000-000000000095'
const WRITER_SESSION = '20000000-0000-4000-8000-000000000095'
const WRITER_CLAIMS = { identityId: WRITER_ID, sessionId: WRITER_SESSION, sessionVersion: 1 }

const READER_ID = '10000000-0000-4000-8000-000000000096'
const READER_SESSION = '20000000-0000-4000-8000-000000000096'
const READER_CLAIMS = { identityId: READER_ID, sessionId: READER_SESSION, sessionVersion: 1 }

const COOKIE = {
  password: 'admin-catalog-quality-secret-32-characters-minimum',
  maxAgeSeconds: 3600
}

describe('D1 catalog quality HTTP handler and admin-catalog router integration (CAT-017)', () => {
  let sqlite: DatabaseSync
  let database: D1Database
  let writerCookie: string
  let readerCookie: string

  beforeEach(async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(NOW))
    sqlite = await openMigratedDatabase()
    sqlite.limits.exprDepth = 100
    sqlite.limits.variableNumber = 100
    sqlite.limits.functionArg = 32
    database = d1OverSqlite(sqlite)

    const migration = await readFile(
      new URL('../../db/d1/migrations/0092_catalog_quality_review.sql', import.meta.url),
      'utf8'
    )
    await database.batch(splitDemoSql(migration).map((sql) => database.prepare(sql)))

    seedInventoryFixture(sqlite)
    sqlite.exec(`
      INSERT INTO identities(id, email, password_hash, email_verified_at, status, created_at, updated_at)
        VALUES
          ('${WRITER_ID}', 'writer@example.invalid', 'private-hash', '${NOW}', 'active', '${NOW}', '${NOW}'),
          ('${READER_ID}', 'reader@example.invalid', 'private-hash', '${NOW}', 'active', '${NOW}', '${NOW}');

      INSERT INTO auth_sessions(id, identity_id, session_version, mfa_verified, created_at, expires_at)
        VALUES
          ('${WRITER_SESSION}', '${WRITER_ID}', 1, 1, '2026-09-30T08:00:00Z', '2026-09-30T11:00:00Z'),
          ('${READER_SESSION}', '${READER_ID}', 1, 1, '2026-09-30T08:00:00Z', '2026-09-30T11:00:00Z');

      INSERT INTO roles VALUES
        ('catalog_editor', 'Editor', 'fixture'),
        ('catalog_reader', 'Reader', 'fixture');
      INSERT INTO permissions VALUES
        ('catalog.write', 'catalog', 'write', 'fixture'),
        ('catalog.read', 'catalog', 'read', 'fixture');
      INSERT INTO role_permissions VALUES
        ('catalog_editor', 'catalog.write'),
        ('catalog_editor', 'catalog.read'),
        ('catalog_reader', 'catalog.read');
      INSERT INTO identity_roles(identity_id, role_code, granted_at) VALUES
        ('${WRITER_ID}', 'catalog_editor', '${NOW}'),
        ('${READER_ID}', 'catalog_reader', '${NOW}');

      UPDATE products SET
        status = 'draft',
        brand_id = 'b1',
        short_description = 'Descripción corta de prueba para calidad',
        description = 'Descripción larga de prueba para evaluación editorial.',
        usage = 'Uso profesional en superficies industriales.',
        series = 'Serie Control',
        regulatory = '{"requiresSds":false}',
        attributes = '{}'
      WHERE id = 'p-1';
    `)

    writerCookie = (await issueD1SessionCookie(database, WRITER_CLAIMS, COOKIE))!.split(';')[0]!
    readerCookie = (await issueD1SessionCookie(database, READER_CLAIMS, COOKIE))!.split(';')[0]!
  })

  afterEach(() => {
    sqlite.close()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  async function send(
    path: string,
    options: {
      method?: string
      cookie?: string
      headers?: Record<string, string>
      body?: unknown
      database?: D1Database
    } = {}
  ) {
    const headers: Record<string, string> = {
      ...(options.cookie !== undefined ? { cookie: options.cookie } : { cookie: writerCookie }),
      ...options.headers
    }
    if (options.body !== undefined && !headers['content-type']) {
      headers['content-type'] = 'application/json'
    }
    return (await handleD1AdminCatalogRequest(
      new Request(`${ORIGIN}${path}`, {
        method: options.method ?? 'GET',
        headers,
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined
      }),
      {
        database: options.database ?? database,
        sessionCookieConfiguration: COOKIE,
        origin: ORIGIN,
        now: NOW
      }
    ))!
  }

  it('recognizes only catalog quality paths in ownsCatalogQualityNamespace', () => {
    expect(ownsCatalogQualityNamespace('/api/admin/products/quality-queue')).toBe(true)
    expect(ownsCatalogQualityNamespace('/api/admin/products/1/quality-review')).toBe(true)
    expect(ownsCatalogQualityNamespace('/api/admin/products/1/quality-review/commands/cmd-1')).toBe(true)
    expect(ownsCatalogQualityNamespace('/api/admin/products')).toBe(false)
    expect(ownsCatalogQualityNamespace('/api/admin/products/1')).toBe(false)
    expect(ownsCatalogQualityNamespace('/api/admin/products/1/publication-readiness')).toBe(false)
  })

  it('serves GET /api/admin/products/quality-queue with no-store headers to catalog.read and catalog.write actors', async () => {
    const res = await send('/api/admin/products/quality-queue?page=1&perPage=5', {
      cookie: readerCookie
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toContain('no-store')
    const payload = (await res.json()) as {
      source: string
      items: Array<{ productId: number; score: number }>
      pagination: { page: number; perPage: number; total: number }
    }
    expect(payload.source).toBe('cloudflare')
    expect(payload.pagination.page).toBe(1)
    expect(payload.pagination.perPage).toBe(5)
    expect(payload.pagination.total).toBe(6)
    expect(payload.items).toHaveLength(5)
  })

  it('rejects unauthenticated, cross-site, or invalid query requests on GET /api/admin/products/quality-queue', async () => {
    const unauth = await send('/api/admin/products/quality-queue', { cookie: '' })
    expect(unauth.status).toBe(401)

    const crossSite = await send('/api/admin/products/quality-queue', {
      headers: { origin: 'https://attacker.invalid' }
    })
    expect(crossSite.status).toBe(403)
    expect(await crossSite.json()).toEqual({ error: { code: 'csrf_rejected' } })

    const badQuery = await send('/api/admin/products/quality-queue?perPage=999')
    expect(badQuery.status).toBe(400)
    expect(await badQuery.json()).toEqual({ error: { code: 'invalid_input' } })

    const wrongMethod = await send('/api/admin/products/quality-queue', { method: 'POST' })
    expect(wrongMethod.status).toBe(405)
    expect(wrongMethod.headers.get('allow')).toBe('GET')
  })

  it('records quality reviews on POST /api/admin/products/:id/quality-review with CSRF, rate-limit, Idempotency-Key, and CAS', async () => {
    // Missing Origin header on POST is rejected with 403 csrf_rejected
    const noOrigin = await send('/api/admin/products/1/quality-review', {
      method: 'POST',
      headers: { 'idempotency-key': 'idem-quality-no-origin' },
      body: { expectedCatalogVersion: 2, expectedReviewVersion: 0, note: 'Revisión manual' }
    })
    expect(noOrigin.status).toBe(403)
    expect(await noOrigin.json()).toEqual({ error: { code: 'csrf_rejected' } })

    // Reader without catalog.write is rejected with 403 forbidden
    const forbidden = await send('/api/admin/products/1/quality-review', {
      method: 'POST',
      cookie: readerCookie,
      headers: {
        origin: ORIGIN,
        'idempotency-key': 'idem-quality-reader-1'
      },
      body: { expectedCatalogVersion: 2, expectedReviewVersion: 0, note: 'Revisión manual' }
    })
    expect(forbidden.status).toBe(403)
    expect(await forbidden.json()).toEqual({ error: { code: 'forbidden' } })

    // Missing Idempotency-Key is rejected with 400
    const noKey = await send('/api/admin/products/1/quality-review', {
      method: 'POST',
      headers: { origin: ORIGIN },
      body: { expectedCatalogVersion: 2, expectedReviewVersion: 0 }
    })
    expect(noKey.status).toBe(400)
    expect(await noKey.json()).toEqual({ error: { code: 'invalid_idempotency_key' } })

    // Valid POST records the review
    const recorded = await send('/api/admin/products/1/quality-review', {
      method: 'POST',
      headers: {
        origin: ORIGIN,
        'idempotency-key': 'idem-quality-record-1'
      },
      body: {
        expectedCatalogVersion: 2,
        expectedReviewVersion: 0,
        note: 'Revisión técnica completada.'
      }
    })
    expect(recorded.status).toBe(200)
    expect(recorded.headers.get('x-ratelimit-limit')).toBe('60')
    const recordedBody = (await recorded.json()) as {
      status: string
      review: {
        productId: number
        reviewVersion: number
        reviewedCatalogVersion: number
        reviewedBy: string
        note: string | null
      }
    }
    expect(recordedBody.status).toBe('recorded')
    expect(recordedBody.review.productId).toBe(1)
    expect(recordedBody.review.reviewVersion).toBe(1)
    expect(recordedBody.review.reviewedCatalogVersion).toBe(2)
    expect(recordedBody.review.reviewedBy).toBe(WRITER_ID)
    expect(recordedBody.review.note).toBe('Revisión técnica completada.')

    // Command recovery GET endpoint returns the recorded receipt without mutating again
    const recovered = await send('/api/admin/products/1/quality-review/commands/idem-quality-record-1')
    expect(recovered.status).toBe(200)
    const recoveredBody = (await recovered.json()) as { status: string; review: unknown }
    expect(recoveredBody.status).toBe('replayed')
    expect(recoveredBody.review).toEqual(recordedBody.review)

    // GET /api/admin/products/1/quality-review returns updated product quality & review state
    const detail = await send('/api/admin/products/1/quality-review')
    expect(detail.status).toBe(200)
    const detailBody = (await detail.json()) as {
      productId: number
      review: { reviewVersion: number; note: string | null }
    }
    expect(detailBody.productId).toBe(1)
    expect(detailBody.review.reviewVersion).toBe(1)
    expect(detailBody.review.note).toBe('Revisión técnica completada.')

    // CAS mismatch returns 409 version_conflict
    const conflict = await send('/api/admin/products/1/quality-review', {
      method: 'POST',
      headers: {
        origin: ORIGIN,
        'idempotency-key': 'idem-quality-conflict-1'
      },
      body: {
        expectedCatalogVersion: 2,
        expectedReviewVersion: 0,
        note: 'Versión obsoleta.'
      }
    })
    expect(conflict.status).toBe(409)
    expect(await conflict.json()).toEqual({ error: { code: 'version_conflict' } })
  })

  it('returns sanitized 503 service_unavailable when D1 throws an unexpected error', async () => {
    const brokenDb = {
      prepare() {
        throw new Error('SQLITE_CORRUPT: secret_table_name_leak')
      }
    } as unknown as D1Database

    const res = await handleCatalogQualityHttp(
      new Request(`${ORIGIN}/api/admin/products/quality-queue`, {
        headers: { cookie: writerCookie }
      }),
      {
        database: brokenDb,
        sessionCookieConfiguration: COOKIE,
        origin: ORIGIN,
        now: NOW
      }
    )
    expect(res?.status).toBe(503)
    const text = await res!.text()
    expect(text).not.toContain('secret_table_name_leak')
    expect(JSON.parse(text)).toEqual({ error: { code: 'service_unavailable' } })
  })
})

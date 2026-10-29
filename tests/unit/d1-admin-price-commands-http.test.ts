import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { handleD1AdminPricingRequest, ownsD1AdminPricingNamespace } from '../../workers/catalog/admin-pricing-http'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import { catalogPriceListSchema } from '../../shared/catalog-price-commands'
import { d1OverSqlite, openMigratedDatabase, seedInventoryFixture } from '../support/d1-sqlite'
const ORIGIN = 'https://pricing.invalid',
  NOW = '2030-10-01T09:00:00Z'
const IDENTITY = '10000000-0000-4000-8000-000000000139',
  SESSION = '20000000-0000-4000-8000-000000000139'
const PRODUCT = '30000000-0000-4000-8000-000000000139',
  VARIANT = '40000000-0000-4000-8000-000000000139'
const CLAIMS = { identityId: IDENTITY, sessionId: SESSION, sessionVersion: 1 }
const COOKIE = { password: 'synthetic-price-cookie-secret-at-least-32-characters', maxAgeSeconds: 3600 }
const body = () => ({
  variantId: VARIANT,
  expectedCatalogVersion: 1,
  expectedLatestApprovedId: null,
  grossCents: 1200,
  compareAtGrossCents: null,
  volumeTiers: [],
  validFrom: '2030-10-01T10:00:00Z',
  reason: 'Synthetic price review'
})
describe('private price HTTP boundary and complete head read', () => {
  let sqlite: DatabaseSync, database: D1Database, cookie: string
  beforeEach(async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(NOW))
    sqlite = await openMigratedDatabase()
    if (!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE name='catalog_price_commands'").get())
      sqlite.exec(
        await readFile(new URL('../../db/d1/migrations/0039_catalog_price_commands.sql', import.meta.url), 'utf8')
      )
    sqlite.limits.exprDepth = 100
    sqlite.limits.variableNumber = 100
    sqlite.limits.functionArg = 32
    seedInventoryFixture(sqlite)
    sqlite
      .prepare(
        "INSERT INTO products(id,legacy_id,category_id,name,slug,status) VALUES (?,900101,'c1','Pricing HTTP','pricing-http','draft')"
      )
      .run(PRODUCT)
    sqlite
      .prepare(
        "INSERT INTO variants(id,legacy_id,product_id,tax_class_id,shipping_profile_id,sku,format,status,price_gross_cents) VALUES (?,900102,?,'t21','sp1','HTTP-PRICE','Caja','draft',0)"
      )
      .run(VARIANT, PRODUCT)
    sqlite
      .prepare(
        "INSERT INTO identities(id,email,password_hash,email_verified_at,status,created_at,updated_at) VALUES (?,'http@example.invalid','synthetic-only','2020-01-01T00:00:00Z','active','2020-01-01T00:00:00Z','2020-01-01T00:00:00Z')"
      )
      .run(IDENTITY)
    sqlite.exec(
      "INSERT INTO roles VALUES ('price_admin','Price admin','fixture'),('price_reader','Price reader','fixture'); INSERT INTO permissions VALUES ('administration.manage','administration','manage','fixture'),('catalog.write','catalog','write','fixture'); INSERT INTO role_permissions VALUES ('price_admin','administration.manage'),('price_admin','catalog.write'),('price_reader','catalog.write');"
    )
    sqlite
      .prepare(
        "INSERT INTO identity_roles(identity_id,role_code,granted_at) VALUES (?,'price_admin','2020-01-01T00:00:00Z')"
      )
      .run(IDENTITY)
    sqlite
      .prepare(
        "INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at) VALUES (?,?,1,1,'2020-01-01T00:00:00Z','2099-01-01T00:00:00Z')"
      )
      .run(SESSION, IDENTITY)
    database = d1OverSqlite(sqlite)
    cookie = (await issueD1SessionCookie(database, CLAIMS, COOKIE))!.split(';')[0]!
  })
  afterEach(() => {
    sqlite.close()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })
  async function request(
    path = '/api/admin/prices',
    options: { method?: string; body?: unknown; headers?: Record<string, string>; raw?: BodyInit; cookie?: string } = {}
  ) {
    const method = options.method ?? 'POST'
    return (await handleD1AdminPricingRequest(
      new Request(ORIGIN + path, {
        method,
        headers: {
          cookie: options.cookie ?? cookie,
          origin: ORIGIN,
          'content-type': 'application/json',
          'idempotency-key': 'http-price-key',
          ...options.headers
        },
        ...(method === 'GET'
          ? {}
          : { body: options.raw ?? JSON.stringify(Object.hasOwn(options, 'body') ? options.body : body()) })
      }),
      { database, origin: ORIGIN, sessionCookieConfiguration: COOKIE, now: NOW }
    ))!
  }
  const count = () => sqlite.prepare('SELECT count(*) AS total FROM catalog_price_commands').get()
  it('schedules, returns byte-identical durable replay, rejects a changed command and cancels by exact real ID', async () => {
    const first = await request()
    expect(first.status).toBe(201)
    const bytes = await first.text(),
      receipt = JSON.parse(bytes)
    expect(await (await request()).text()).toBe(bytes)
    expect(count()).toEqual({ total: 1 })
    const changed = await request('/api/admin/prices', { body: { ...body(), grossCents: 1300 } })
    expect(changed.status).toBe(409)
    expect(await changed.json()).toEqual({ error: { code: 'idempotency_conflict' } })
    const cancelBody = {
      expectedCatalogVersion: 1,
      expectedLatestApprovedId: receipt.priceId,
      reason: 'Synthetic cancellation review'
    }
    const cancelled = await request(`/api/admin/prices/${encodeURIComponent(receipt.priceId)}/cancel`, {
      body: cancelBody,
      headers: { 'idempotency-key': 'cancel-http' }
    })
    expect(cancelled.status).toBe(200)
    expect(await cancelled.json()).toMatchObject({ action: 'price_cancel', priceId: receipt.priceId, updated: true })
    expect(count()).toEqual({ total: 2 })
    for (const response of [first, changed, cancelled]) {
      expect(response.headers.get('cache-control')).toBe('private, no-store')
      expect(response.headers.get('vary')).toBe('Cookie')
      expect(response.headers.get('referrer-policy')).toBe('no-referrer')
    }
  })
  it('projects current real identity and complete latest approved head outside the history page', async () => {
    sqlite
      .prepare(
        'INSERT INTO variant_price_versions(id,variant_id,gross_cents,valid_from,reason,created_at) VALUES (?,?,1200,?,?,?)'
      )
      .run('legacy:' + VARIANT, VARIANT, '2030-09-01T10:00:00Z', 'Synthetic real imported ID', '2030-09-01T00:00:00Z')
    sqlite
      .prepare(
        "INSERT INTO variant_price_versions(id,variant_id,gross_cents,valid_from,status,reason,created_at,cancelled_by,cancelled_at,cancellation_reason) VALUES ('cancelled-later',?,1300,'2030-10-02T10:00:00Z','cancelled','Synthetic',?,?,'2030-10-01T09:00:00Z','Synthetic cancelled')"
      )
      .run(VARIANT, '2030-09-01T00:00:00Z', IDENTITY)
    const response = await request('/api/admin/prices?variant=900102&perPage=1&historyPage=2&historyPerPage=1', {
      method: 'GET'
    })
    const value = catalogPriceListSchema.parse(await response.json())
    expect(response.status).toBe(200)
    expect(value.capabilities).toMatchObject({ priceSchedule: true, priceCancel: true, priceWrite: false })
    expect(value.items[0]).toMatchObject({
      productId: 900101,
      productUuid: PRODUCT,
      catalogVersion: 1,
      currentPrice: { kind: 'governed', versionId: 'legacy:' + VARIANT },
      latestApproved: { id: 'legacy:' + VARIANT, status: 'approved' },
      cancellable: false
    })
    expect(value.items[0]!.history).toHaveLength(1)
  })
  it('a reader gets no write grant and cannot POST even with an admin cookie role name', async () => {
    sqlite.exec("UPDATE identity_roles SET role_code='price_reader'")
    const read = await request('/api/admin/prices?variant=900102', { method: 'GET' })
    expect(read.status).toBe(200)
    expect(catalogPriceListSchema.parse(await read.json()).capabilities).toMatchObject({
      priceSchedule: false,
      priceCancel: false
    })
    const denied = await request()
    expect(denied.status).toBe(403)
    expect(await denied.json()).toEqual({ error: { code: 'forbidden' } })
    expect(count()).toEqual({ total: 0 })
  })
  it('denies read if catalog permission is revoked during the later writer-authority await', async () => {
    const prepare = database.prepare.bind(database)
    vi.spyOn(database, 'prepare').mockImplementation((sql) => {
      const stmt = prepare(sql),
        bind = stmt.bind.bind(stmt)
      vi.spyOn(stmt, 'bind').mockImplementation((...parameters) => {
        const bound = bind(...parameters)
        if (parameters.includes('administration.manage')) {
          const first = bound.first.bind(bound)
          vi.spyOn(bound, 'first').mockImplementation(async () => {
            const result = await first()
            sqlite.exec("DELETE FROM role_permissions WHERE permission_code='catalog.write'")
            return result
          })
        }
        return bound
      })
      return stmt
    })
    const response = await request('/api/admin/prices?variant=900102', { method: 'GET' })
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: { code: 'forbidden' } })
  })
  it.each(['', 'https://evil.invalid', 'null'])(
    'requires the configured HTTPS origin for writes (%s)',
    async (origin) => {
      const response = await request('/api/admin/prices', { headers: { origin } })
      expect(response.status).toBe(403)
      expect(await response.json()).toEqual({ error: { code: 'csrf_rejected' } })
      expect(count()).toEqual({ total: 0 })
    }
  )
  it.each(['?now=2030-10-01T09:00:00Z', '?q=x', '?q=x&q=y'])('rejects write queries %s', async (query) => {
    expect((await request('/api/admin/prices' + query)).status).toBe(400)
    expect(count()).toEqual({ total: 0 })
  })
  it.each([
    '/api/admin/prices/',
    '/api/admin/%70rices',
    '/api/admin/prices/x%2Fy/cancel',
    '/api/admin/prices/%69d/cancel',
    '/api/admin/prices/%00/cancel',
    '/api/admin/prices/x/cancel/'
  ])('reserves but rejects noncanonical aliases %s', async (path) => {
    expect(ownsD1AdminPricingNamespace(path)).toBe(true)
    expect((await request(path)).status).not.toBe(201)
    expect(count()).toEqual({ total: 0 })
  })
  it('accepts canonical encoded imported TEXT cancellation IDs without UUID/prefix inference', async () => {
    sqlite
      .prepare(
        'INSERT INTO variant_price_versions(id,variant_id,gross_cents,valid_from,reason,created_at) VALUES (?,?,1200,?,?,?)'
      )
      .run('imported head (1)', VARIANT, '2030-10-01T10:00:00Z', 'Synthetic', '2030-09-01T00:00:00Z')
    const response = await request('/api/admin/prices/' + encodeURIComponent('imported head (1)') + '/cancel', {
      body: {
        expectedCatalogVersion: 1,
        expectedLatestApprovedId: 'imported head (1)',
        reason: 'Synthetic cancellation'
      }
    })
    expect(response.status).toBe(200)
  })
  it.each([
    { raw: '{', status: 400, code: 'invalid_json' },
    { raw: 'x'.repeat(65537), status: 413, code: 'body_too_large' },
    { raw: '{}', headers: { 'content-type': 'text/plain' }, status: 415, code: 'json_required' }
  ])('bounds streaming/type/JSON before mutation %#', async ({ raw, headers, status, code }) => {
    const response = await request('/api/admin/prices', { raw, headers })
    expect(response.status).toBe(status)
    expect(await response.json()).toEqual({ error: { code } })
    expect(count()).toEqual({ total: 0 })
  })
  it('checks authentication before parsing a hostile body and quota before replay', async () => {
    const denied = await request('/api/admin/prices', { raw: '{', cookie: 'invalid' })
    expect(denied.status).toBe(401)
    expect((await request()).status).toBe(201)
    sqlite
      .prepare("UPDATE identity_rate_limits SET used=60 WHERE identity_id=? AND scope='admin-price-commands'")
      .run(IDENTITY)
    const limited = await request()
    expect(limited.status).toBe(429)
    expect(await limited.json()).toEqual({ error: { code: 'rate_limited' } })
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0)
    expect(count()).toEqual({ total: 1 })
  })
})

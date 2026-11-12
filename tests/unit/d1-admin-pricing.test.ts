import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { readFile } from 'node:fs/promises'
import { defaults, seal } from 'iron-webcrypto'
import { ironCrypto } from '../../workers/auth/iron-crypto'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import {
  ADMIN_PRICING_CAPABILITIES,
  listD1AdminPrices,
  parseAdminPricingLegacyId
} from '../../workers/catalog/admin-pricing'
import type { AdminPricingQuery, D1AdminPricingList } from '../../workers/catalog/admin-pricing'
import { handleD1AdminPricingRequest, parseAdminPricingQuery } from '../../workers/catalog/admin-pricing-http'
import { effectiveGrossCentsExpression, parameterizeEffectivePricingSql } from '../../workers/catalog/pricing'
import { d1OverSqlite, openMigratedDatabase, seedInventoryFixture } from '../support/d1-sqlite'

const NOW = '2026-09-30T09:00:00Z'
const ORIGIN = 'https://neteco.invalid'
const IDENTITY = '10000000-0000-4000-8000-000000000001'
const SESSION = '20000000-0000-4000-8000-000000000001'
const CLAIMS = { identityId: IDENTITY, sessionId: SESSION, sessionVersion: 1 }
const COOKIE = { password: 'synthetic-admin-pricing-cookie-password-at-least-32', maxAgeSeconds: 3600 }
const QUERY: AdminPricingQuery = { q: '', page: 1, perPage: 500, historyPage: 1, historyPerPage: 8 }

describe('private D1 pricing reads against every migrated SQLite table', () => {
  let sqlite: DatabaseSync
  let database: D1Database
  let cookie: string

  beforeEach(async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(NOW))
    sqlite = await openMigratedDatabase()
    database = d1OverSqlite(sqlite)
    seedInventoryFixture(sqlite)
    sqlite.exec(`
      INSERT INTO identities(id,email,password_hash,email_verified_at,status,created_at,updated_at)
        VALUES ('${IDENTITY}','fixture@example.invalid','synthetic-secret-hash','${NOW}','active','${NOW}','${NOW}');
      INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at)
        VALUES ('${SESSION}','${IDENTITY}',1,1,'2026-09-30T08:00:00Z','2026-09-30T11:00:00Z');
      INSERT INTO roles VALUES ('catalog_editor','Editor','fixture'),('customer','Customer','fixture'),('admin','Admin','fixture');
      INSERT INTO permissions VALUES ('catalog.write','catalog','write','fixture'),('catalog.read','catalog','read','fixture');
      INSERT INTO role_permissions VALUES ('catalog_editor','catalog.write'),('customer','catalog.read'),('admin','catalog.write');
      INSERT INTO identity_roles(identity_id,role_code,granted_at) VALUES ('${IDENTITY}','catalog_editor','2026-09-01T00:00:00Z');
      UPDATE products SET status='draft',name='Ácido editorial',attributes='{"imageRights":{"owner":"private-rights-owner"}}' WHERE id='p-1';
      UPDATE products SET status='hidden' WHERE id='p-2';
      UPDATE products SET status='discontinued' WHERE id='p-5';
      UPDATE variants SET status='draft',compare_at_gross_cents=1000,created_at='2026-09-01 10:11:12' WHERE id='v-1-1';
      UPDATE variants SET status='hidden' WHERE id='v-2-1';
      UPDATE variants SET status='discontinued' WHERE id='v-6-1';
    `)
    cookie = (await issueD1SessionCookie(database, CLAIMS, COOKIE))!.split(';')[0]!
  })
  afterEach(() => {
    sqlite.close()
    vi.useRealTimers()
  })

  async function request(
    path = '/api/admin/prices',
    options: {
      method?: string
      headers?: Record<string, string>
      database?: D1Database
      origin?: string
      now?: string
    } = {}
  ) {
    return (await handleD1AdminPricingRequest(
      new Request(`${ORIGIN}${path}`, {
        method: options.method ?? 'GET',
        headers: { cookie, ...options.headers }
      }),
      {
        database: options.database ?? database,
        sessionCookieConfiguration: COOKIE,
        origin: options.origin ?? ORIGIN,
        now: options.now ?? NOW
      }
    ))!
  }
  async function data(response: Response) {
    return response.json() as Promise<D1AdminPricingList>
  }
  function insertVersion(
    id: string,
    overrides: {
      variantId?: string
      gross?: number
      compareAt?: number | null
      reference?: number | null
      tiers?: string
      from?: string
      until?: string | null
      created?: string
      cancelled?: boolean
    } = {}
  ) {
    sqlite
      .prepare(
        `INSERT INTO variant_price_versions(id,variant_id,gross_cents,compare_at_gross_cents,
      reference_gross_cents_30d,volume_tiers,valid_from,valid_until,status,reason,created_by,created_at,
      cancelled_by,cancelled_at,cancellation_reason) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        id,
        overrides.variantId ?? 'v-1-1',
        overrides.gross ?? 700,
        overrides.compareAt ?? null,
        overrides.reference ?? null,
        overrides.tiers ?? '[]',
        overrides.from ?? '2026-09-29T00:00:00Z',
        overrides.until ?? null,
        overrides.cancelled ? 'cancelled' : 'approved',
        'Governed local fixture reason',
        'private-creator-id',
        overrides.created ?? '2026-09-01T00:00:00Z',
        overrides.cancelled ? 'private-canceller-id' : null,
        overrides.cancelled ? NOW : null,
        overrides.cancelled ? 'Private cancellation audit reason' : null
      )
  }
  function afterHistory(action: () => void): D1Database {
    return {
      ...database,
      prepare(sql: string) {
        const statement = database.prepare(sql)
        if (sql.includes('SELECT * FROM ranked')) {
          const all = statement.all.bind(statement)
          statement.all = async <T>() => {
            const result = await all<T>()
            action()
            return result
          }
        }
        return statement
      }
    } as D1Database
  }

  it('preserves Node list fields, real draft/hidden variants, explicit readonly capabilities and honest legacy fallback', async () => {
    const response = await request()
    expect(response.status).toBe(200)
    const body = await data(response)
    expect(body).toMatchObject({
      source: 'cloudflare',
      capabilities: ADMIN_PRICING_CAPABILITIES,
      pricingInstant: NOW,
      pagination: { page: 1, perPage: 500, total: 5, pages: 1 }
    })
    expect(body.items.map((item) => item.id)).toEqual([21, 31, 41, 51, 11])
    const item = body.items.find((item) => item.id === 11)!
    expect(item).toEqual({
      variantId: 'v-1-1',
      id: 11,
      sku: 'SKU-1-1',
      format: 'Botella 1 L',
      product: 'Ácido editorial',
      currency: 'EUR',
      grossCents: 500,
      compareAtGrossCents: 1000,
      referenceGrossCents30d: null,
      volumeTiers: [],
      pricingVersion: 'legacy:v-1-1',
      currentPrice: { kind: 'legacy', versionId: null },
      productId: 1,
      productUuid: 'p-1',
      catalogVersion: 2,
      quantityRules: { minimumQuantity: 1, maximumQuantity: null, quantityIncrement: 1 },
      latestApproved: null,
      cancellable: false,
      validFrom: '2026-09-01T10:11:12.000Z',
      history: [],
      scheduled: null,
      historyPagination: { page: 1, perPage: 8, total: 0, pages: 0 }
    })
    expect(body.items.some((item) => item.id === 51)).toBe(true) // product discontinued, variant retained like Node
    expect(JSON.stringify(body)).not.toMatch(
      /fixture@example|synthetic-secret|private-rights-owner|created_by|cancelled_by/
    )
    expect(
      Object.entries(body.capabilities)
        .filter(([key]) => /Write|Schedule$|Cancel$/.test(key))
        .every(([, value]) => value === false)
    ).toBe(true)
  })

  it('uses the one effective-pricing rule for winner and every dependent current field', async () => {
    insertVersion('price-old', { gross: 600, from: '2026-09-01T00:00:00Z', until: '2026-09-29T00:00:00Z' })
    insertVersion('price-current', {
      gross: 700,
      compareAt: 900,
      reference: 650,
      tiers: '[{"minimumQuantity":10,"unitGrossCents":600}]'
    })
    insertVersion('price-future', { gross: 800, from: '2026-10-01T00:00:00Z' })
    insertVersion('price-cancelled', { gross: 999, from: '2026-09-30T00:00:00Z', cancelled: true })
    const body = await data(await request('/api/admin/prices?variant=11'))
    expect(body.items[0]).toMatchObject({
      grossCents: 700,
      compareAtGrossCents: 900,
      referenceGrossCents30d: 650,
      volumeTiers: [{ minimumQuantity: 10, unitGrossCents: 600 }],
      pricingVersion: 'price-current',
      validFrom: '2026-09-29T00:00:00Z',
      scheduled: { id: 'price-future', grossCents: 800, status: 'approved' }
    })
    const resolver = parameterizeEffectivePricingSql(
      `SELECT ${effectiveGrossCentsExpression('v')} AS gross FROM variants v WHERE v.id=?`,
      NOW
    )
    expect(sqlite.prepare(resolver.sql).get(...resolver.instantParameters, 'v-1-1')).toMatchObject({
      gross: body.items[0]!.grossCents
    })
    expect(body.items[0]!.history.map((entry) => entry.id)).toEqual([
      'price-future',
      'price-cancelled',
      'price-current',
      'price-old'
    ])
    expect(body.items[0]!.history.find((entry) => entry.id === 'price-current')).toEqual({
      id: 'price-current',
      grossCents: 700,
      compareAtGrossCents: 900,
      referenceGrossCents30d: 650,
      volumeTiers: [{ minimumQuantity: 10, unitGrossCents: 600 }],
      validFrom: '2026-09-29T00:00:00Z',
      validUntil: null,
      status: 'approved',
      reason: 'Governed local fixture reason'
    })
    expect(JSON.stringify(body)).not.toMatch(/private-creator|private-canceller|Private cancellation/)
  })

  it('preserves the effective version null compare-at without mixing legacy metadata', async () => {
    insertVersion('version-no-compare')
    expect((await data(await request('/api/admin/prices?variant=11'))).items[0]!.compareAtGrossCents).toBeNull()
  })

  it.each(['v-1-1', 'v-2-1'])(
    'cannot confuse a corrupt version ID with the legacy sentinel (%s)',
    async (variantId) => {
      insertVersion('legacy:v-1-1', {
        variantId,
        gross: 1100,
        compareAt: 1200,
        reference: 1000,
        from: '2026-10-01T00:00:00Z'
      })
      const item = (await data(await request('/api/admin/prices?variant=11'))).items[0]!
      expect(item).toMatchObject({
        grossCents: 500,
        compareAtGrossCents: 1000,
        referenceGrossCents30d: null,
        pricingVersion: 'legacy:v-1-1',
        validFrom: '2026-09-01T10:11:12.000Z'
      })
    }
  )

  it.each([
    ['inclusive seconds start', '2026-09-30T09:00:00Z', null, 700],
    ['inclusive milliseconds start', '2026-09-30T09:00:00.000Z', null, 700],
    ['future milliseconds start', '2026-09-30T09:00:00.001Z', null, 500],
    ['exclusive seconds end', '2026-09-29T00:00:00Z', '2026-09-30T09:00:00Z', 500],
    ['exclusive milliseconds end', '2026-09-29T00:00:00Z', '2026-09-30T09:00:00.000Z', 500],
    ['later milliseconds end', '2026-09-29T00:00:00Z', '2026-09-30T09:00:00.001Z', 700]
  ] as const)('resolves %s precisely', async (_name, from, until, expected) => {
    insertVersion('window', { from, until })
    expect((await data(await request('/api/admin/prices?variant=11'))).items[0]!.grossCents).toBe(expected)
  })

  it('normalizes mixed precision and breaks valid-from/created-at ties deterministically by version ID', async () => {
    insertVersion('tie-a', { gross: 600, from: '2026-09-30T08:00:00Z', created: '2026-09-29T00:00:00.001Z' })
    insertVersion('tie-b', { gross: 700, from: '2026-09-30T08:00:00.000Z', created: '2026-09-29T00:00:00.001Z' })
    insertVersion('tie-z-old', { gross: 800, from: '2026-09-30T08:00:00Z', created: '2026-09-29T00:00:00Z' })
    const item = (await data(await request('/api/admin/prices?variant=11'))).items[0]!
    expect(item.pricingVersion).toBe('tie-b')
    expect(item.history.map((entry) => entry.id)).toEqual(['tie-b', 'tie-a', 'tie-z-old'])
  })

  it('paginates history per variant and computes scheduled from all versions, including outside the page', async () => {
    insertVersion('current')
    insertVersion('nearest-future', { from: '2026-10-01T00:00:00Z' })
    insertVersion('nearest-future-tie', {
      gross: 710,
      from: '2026-10-01T00:00:00.000Z',
      created: '2026-09-02T00:00:00Z'
    })
    insertVersion('future-latest', { gross: 800, from: '2026-11-01T00:00:00Z' })
    insertVersion('future-cancelled', { from: '2026-10-01T00:00:00.001Z', cancelled: true })
    const item = (await data(await request('/api/admin/prices?variant=11&historyPage=2&historyPerPage=1'))).items[0]!
    expect(item.history).toHaveLength(1)
    expect(item.history[0]!.id).toBe('future-cancelled')
    expect(item.historyPagination).toEqual({ page: 2, perPage: 1, total: 5, pages: 5 })
    expect(item.scheduled?.id).toBe('nearest-future-tie')
    const beyond = (await data(await request('/api/admin/prices?variant=11&historyPage=100&historyPerPage=1')))
      .items[0]!
    expect(beyond.history).toEqual([])
    expect(beyond.historyPagination.total).toBe(5)
    expect(beyond.scheduled?.id).toBe('nearest-future-tie')
  })

  it('keeps totals/history isolated to each selected variant', async () => {
    for (let index = 0; index < 3; index++) insertVersion(`a-${index}`, { from: `2026-09-2${index}T00:00:00Z` })
    insertVersion('b-only', { variantId: 'v-2-1', gross: 900, from: '2026-10-03T00:00:00Z' })
    const result = await data(await request('/api/admin/prices?historyPerPage=1'))
    expect(result.items.find((item) => item.id === 11)!.historyPagination.total).toBe(3)
    expect(result.items.find((item) => item.id === 21)!.history).toMatchObject([{ id: 'b-only' }])
    expect(result.items.find((item) => item.id === 31)!.history).toEqual([])
  })

  it.each(['not-a-timestamp', '2026-02-30T00:00:00Z', '2026-09-01T00:00:00+02:00', '2026-09-01'])(
    'returns explicit null instead of inventing legacy validity for %s',
    async (createdAt) => {
      sqlite.prepare("UPDATE variants SET created_at=? WHERE id='v-1-1'").run(createdAt)
      expect((await data(await request('/api/admin/prices?variant=11'))).items[0]!.validFrom).toBeNull()
    }
  )

  it('accepts real canonical legacy UTC milliseconds and returns stored currency without guessing', async () => {
    sqlite.exec("UPDATE variants SET created_at='2026-09-01T00:00:00.123Z',currency='USD' WHERE id='v-1-1'")
    expect((await data(await request('/api/admin/prices?variant=11'))).items[0]).toMatchObject({
      validFrom: '2026-09-01T00:00:00.123Z',
      currency: 'USD'
    })
  })

  it.each(['%', '_', "' OR 1=1 --", '\\', 'ácido', 'ACIDO'])(
    'searches literal bound text without SQL or wildcard semantics: %s',
    async (term) => {
      if (!['ácido', 'ACIDO'].includes(term))
        sqlite.prepare("UPDATE products SET name=? WHERE id='p-1'").run(`Literal ${term} needle`)
      const response = await request(`/api/admin/prices?q=${encodeURIComponent(term)}`)
      expect(response.status).toBe(200)
      expect((await data(response)).items.map((item) => item.id)).toEqual([11])
      expect(sqlite.prepare('SELECT count(*) AS total FROM identities').get()).toMatchObject({ total: 1 })
    }
  )

  it('searches SKU and uses stable variant-level pagination with totals distinct from histories', async () => {
    const sku = await data(await request('/api/admin/prices?q=sku-2-1'))
    expect(sku.items.map((item) => item.id)).toEqual([21])
    const page = await data(await request('/api/admin/prices?page=2&perPage=2'))
    expect(page.items.map((item) => item.id)).toEqual([41, 51])
    expect(page.pagination).toEqual({ page: 2, perPage: 2, total: 5, pages: 3 })
    const missing = await data(await request('/api/admin/prices?variant=999'))
    expect(missing.items).toEqual([])
    expect(missing.pagination.total).toBe(0)
  })

  it('excludes unmapped/unsafe variant legacy IDs without fabricating numeric identifiers', async () => {
    sqlite.exec(
      "UPDATE variants SET legacy_id=NULL WHERE id='v-2-1'; UPDATE variants SET legacy_id=9007199254740992 WHERE id='v-3-1'"
    )
    expect((await data(await request())).items.map((item) => item.id)).toEqual([41, 51, 11])
  })

  it('keeps query count and bound-parameter count fixed with 600 variants; never performs per-item reads', async () => {
    const insert =
      sqlite.prepare(`INSERT INTO variants(id,legacy_id,product_id,tax_class_id,shipping_profile_id,sku,format,status,price_gross_cents)
      VALUES (?,?,'p-4','t21','sp1',?,'Fixture','draft',500)`)
    for (let index = 0; index < 600; index++) {
      insert.run(`large-${index}`, 1000 + index, `LARGE-${index}`)
      for (let entry = 0; entry < 12; entry++)
        insertVersion(`large-version-${index}-${entry}`, {
          variantId: `large-${index}`,
          from: `2026-09-${String(entry + 1).padStart(2, '0')}T00:00:00Z`
        })
    }
    const statements: string[] = []
    const boundSizes: number[] = []
    const counted = {
      ...database,
      prepare(sql: string) {
        statements.push(sql)
        const statement = database.prepare(sql)
        const bind = statement.bind.bind(statement)
        statement.bind = (...values: unknown[]) => {
          boundSizes.push(values.length)
          return bind(...values)
        }
        return statement
      }
    } as D1Database
    const result = await data(await request('/api/admin/prices?q=Producto&perPage=500', { database: counted }))
    expect(result.items).toHaveLength(500)
    expect(result.pagination.total).toBe(604)
    expect(result.limits).toEqual({ itemsPerPageMax: 500, historyPerPageMax: 8, returnedVersionRecordsMax: 5000 })
    expect(result.items.reduce((total, item) => total + item.historyPagination.total, 0)).toBeGreaterThan(5000)
    expect(result.items.reduce((total, item) => total + item.history.length, 0)).toBeLessThanOrEqual(4000)
    expect(result.items.every((item) => item.history.length <= 8)).toBe(true)
    expect(statements).toHaveLength(7)
    expect(Math.max(...boundSizes)).toBeLessThan(15)
    expect(statements.filter((sql) => sql.includes('row_number()'))).toHaveLength(1)
  })

  it.each([
    ['UPDATE identities SET email_verified_at=NULL', 'email_unverified', 403],
    ['UPDATE auth_sessions SET mfa_verified=0', 'mfa_required', 403],
    ["UPDATE identities SET status='locked'", 'unauthenticated', 401],
    ["UPDATE identities SET status='disabled'", 'unauthenticated', 401],
    ['DELETE FROM identities', 'unauthenticated', 401],
    ['UPDATE identities SET session_version=2', 'unauthenticated', 401],
    ['UPDATE auth_sessions SET session_version=2', 'unauthenticated', 401],
    ["UPDATE auth_sessions SET revoked_at='2026-09-30T09:00:00Z'", 'unauthenticated', 401],
    ["UPDATE auth_sessions SET expires_at='2026-09-30T09:00:00Z'", 'unauthenticated', 401],
    ['DELETE FROM identity_roles', 'forbidden', 403],
    ["DELETE FROM role_permissions WHERE permission_code='catalog.write'", 'forbidden', 403],
    ["UPDATE identity_roles SET expires_at='2026-09-30T09:00:00Z'", 'forbidden', 403],
    ["UPDATE identity_roles SET granted_at='2026-10-01T00:00:00Z'", 'forbidden', 403]
  ] as const)('requires live authority: %s', async (mutation, code, status) => {
    sqlite.exec(mutation)
    const result = await request()
    expect(result.status).toBe(status)
    expect(await result.json()).toEqual({ error: { code } })
  })

  it('does not trust admin/MFA flags in a valid sealed role cookie when D1 only grants customer catalog.read', async () => {
    sqlite.exec(
      "DELETE FROM identity_roles; INSERT INTO identity_roles(identity_id,role_code,granted_at) VALUES ('" +
        IDENTITY +
        "','customer','2026-09-01T00:00:00Z')"
    )
    const forged = await seal(
      ironCrypto,
      {
        id: SESSION,
        createdAt: Date.parse(NOW),
        data: { sessionId: SESSION, sessionVersion: 1, user: { id: IDENTITY, role: 'admin', mfaVerified: true } }
      },
      COOKIE.password,
      { ...defaults, ttl: 3600_000 }
    )
    const result = await request('/api/admin/prices', {
      headers: { cookie: `neteco-session=${encodeURIComponent(forged)}`, 'x-user-role': 'admin' }
    })
    expect(result.status).toBe(403)
    expect(await result.json()).toEqual({ error: { code: 'forbidden' } })
  })

  it.each([
    ["UPDATE auth_sessions SET revoked_at='2026-09-30T09:00:00Z'", 'unauthenticated'],
    ['UPDATE auth_sessions SET mfa_verified=0', 'mfa_required'],
    ['UPDATE identities SET email_verified_at=NULL', 'email_unverified'],
    ["DELETE FROM role_permissions WHERE permission_code='catalog.write'", 'forbidden'],
    ['DELETE FROM identities', 'unauthenticated']
  ] as const)('rechecks %s after awaited raw reads before projecting any private history', async (mutation, code) => {
    insertVersion('malformed-private-tiers', { tiers: '[{"secret":"private-value"}]' })
    const result = await request('/api/admin/prices', { database: afterHistory(() => sqlite.exec(mutation)) })
    expect(result.status).toBe(code === 'unauthenticated' ? 401 : 403)
    expect(await result.json()).toEqual({ error: { code } })
  })

  it.each(['role', 'session'] as const)(
    'uses elapsed server time when a %s expires while reads await',
    async (scope) => {
      if (scope === 'role') sqlite.exec("UPDATE identity_roles SET expires_at='2026-09-30T09:00:01Z'")
      else sqlite.exec("UPDATE auth_sessions SET expires_at='2026-09-30T09:00:01Z'")
      const result = await request('/api/admin/prices', {
        database: afterHistory(() => vi.setSystemTime(Date.parse(NOW) + 2000))
      })
      expect(result.status).toBe(scope === 'role' ? 403 : 401)
      expect(await result.json()).toEqual({ error: { code: scope === 'role' ? 'forbidden' : 'unauthenticated' } })
    }
  )

  it.each([
    '',
    'neteco-session=bad',
    'neteco-session=%ZZ',
    'neteco-session=a; neteco-session=b',
    'neteco-session=' + 'x'.repeat(9000)
  ])('rejects invalid/ambiguous cookies without trusting headers: %s', async (badCookie) => {
    const result = await request('/api/admin/prices', {
      headers: { cookie: badCookie, authorization: `Bearer ${SESSION}`, 'x-user-role': 'admin' }
    })
    expect(result.status).toBe(401)
    expect(await result.json()).toEqual({ error: { code: 'unauthenticated' } })
  })

  it.each(['https://evil.invalid', 'https://neteco.invalid/', 'null'])(
    'rejects non-exact Origin %s',
    async (origin) => {
      expect((await request('/api/admin/prices', { headers: { origin } })).status).toBe(403)
    }
  )
  it('rejects cross-site reads while accepting absent/exact Origin and never deriving authority from Host', async () => {
    expect((await request('/api/admin/prices', { headers: { 'sec-fetch-site': 'cross-site' } })).status).toBe(403)
    expect(
      (await request('/api/admin/prices', { headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin' } })).status
    ).toBe(200)
    expect(
      (await request('/api/admin/prices', { headers: { host: 'evil.invalid', 'x-forwarded-host': 'evil.invalid' } }))
        .status
    ).toBe(200)
    expect((await request('/api/admin/prices', { origin: ORIGIN + '/path' })).status).toBe(503)
  })

  it.each(['HEAD', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])(
    'returns immediate 405 for %s without consuming a body or issuing D1 reads',
    async (method) => {
      const unavailable = {
        prepare() {
          throw new Error('Should not contact D1')
        }
      } as unknown as D1Database
      for (const path of ['/api/admin/prices', '/api/admin/prices/version-id/cancel']) {
        const response = await request(path, { method, database: unavailable })
        expect(response.status).toBe(405)
        expect(response.headers.get('allow')).toBe(path === '/api/admin/prices' ? 'GET, POST' : 'POST')
        expect(await response.json()).toEqual({ error: { code: 'method_not_allowed' } })
      }
    }
  )

  it('does not own catalog/media/public routes and offers no invented GET history route', async () => {
    for (const path of ['/api/admin/products', '/api/admin/media', '/api/products', '/api/admin/prices-other'])
      expect(
        await handleD1AdminPricingRequest(new Request(ORIGIN + path), {
          database,
          origin: ORIGIN,
          sessionCookieConfiguration: COOKIE
        })
      ).toBeNull()
    expect((await request('/api/admin/prices/history')).status).toBe(404)
  })

  it('sanitizes provider failures and invalid governed tier projection to no-store 503', async () => {
    const unavailable = {
      prepare() {
        throw new Error('SELECT private_email FROM private_provider')
      }
    } as unknown as D1Database
    const response = await request('/api/admin/prices', { database: unavailable })
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: { code: 'service_unavailable' } })
    insertVersion('invalid-tiers', { tiers: '[{"minimumQuantity":2,"unitGrossCents":999}]' })
    expect((await request('/api/admin/prices')).status).toBe(503)
  })

  it('keeps every result/error/method response uncached, noindex and free of CORS grants', async () => {
    const cases: Array<NonNullable<Parameters<typeof request>[1]>> = [
      {},
      { method: 'POST' },
      { headers: { cookie: '' } },
      { headers: { origin: 'https://evil.invalid' } }
    ]
    for (const options of cases) {
      const response = await request('/api/admin/prices', options)
      expect(response.headers.get('cache-control')).toBe('private, no-store')
      expect(response.headers.get('pragma')).toBe('no-cache')
      expect(response.headers.get('vary')).toBe('Cookie')
      expect(response.headers.get('x-robots-tag')).toContain('noindex')
      expect(response.headers.get('x-content-type-options')).toBe('nosniff')
      expect(response.headers.get('referrer-policy')).toBe('no-referrer')
      expect(response.headers.get('access-control-allow-origin')).toBeNull()
    }
  })

  it('validates direct-domain arguments and has no Node/PG imports or private field projection', async () => {
    await expect(listD1AdminPrices(database, CLAIMS, NOW, { ...QUERY, perPage: 501 })).rejects.toThrow(
      'invalid_admin_pricing_query'
    )
    expect(await listD1AdminPrices(database, null, NOW, QUERY)).toEqual({ outcome: 'denied', code: 'unauthenticated' })
    const source = await readFile(new URL('../../workers/catalog/admin-pricing.ts', import.meta.url), 'utf8')
    expect(source).not.toMatch(/from ['"](?:node:|postgres|.*server\/services)/)
    expect(source).toContain('effectiveGovernedVersionIdExpression')
    expect(source).not.toMatch(/console\.(?:log|error)/)
  })
})

describe('admin pricing strict query/legacy ID boundary', () => {
  it('sets bounded Node-compatible defaults and accepts safe query bounds', () => {
    expect(parseAdminPricingQuery(new URLSearchParams())).toEqual(QUERY)
    expect(
      parseAdminPricingQuery(
        new URLSearchParams('q=%20sku%20&variant=11&page=1000000&perPage=500&historyPage=1000000&historyPerPage=100')
      )
    ).toEqual({ q: 'sku', variant: 11, page: 1_000_000, perPage: 500, historyPage: 1_000_000, historyPerPage: 100 })
    expect(parseAdminPricingLegacyId('9007199254740991')).toBe(Number.MAX_SAFE_INTEGER)
  })
  it.each([
    'q=' + 'x'.repeat(161),
    'q=%00',
    'q=%0A',
    'q=a&q=b',
    'page=0',
    'page=01',
    'page=1000001',
    'page=1.0',
    'page=1e2',
    'perPage=501',
    'perPage=-1',
    'perPage=0',
    'historyPerPage=9',
    'historyPerPage=101',
    'variant=11&historyPerPage=101',
    'historyPage=01',
    'historyPage=1000001',
    'variant=0',
    'variant=01',
    'variant=1.0',
    'variant=-1',
    'variant=9007199254740992',
    'variant=v-1-1',
    'variant=11&variant=21',
    'instant=2026-10-01T00:00:00Z',
    'status=approved',
    'q=%7F',
    'unknown=a'
  ])('rejects malformed/ambiguous/client-clock query %s', (query) => {
    expect(parseAdminPricingQuery(new URLSearchParams(query))).toBeNull()
  })
  it.each(['0', '01', '-1', '1.0', '1e1', 'NaN', 'Infinity', '9007199254740992', 'v-1-1', '11 '])(
    'rejects legacy aliases/unsafe ID %s',
    (id) => {
      expect(parseAdminPricingLegacyId(id)).toBeNull()
    }
  )
})

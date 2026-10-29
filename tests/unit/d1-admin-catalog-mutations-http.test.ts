import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import { handleD1AdminCatalogRequest } from '../../workers/catalog/admin-catalog-http'
import { d1OverSqlite, openMigratedDatabase, seedInventoryFixture } from '../support/d1-sqlite'

const ORIGIN = 'https://neteco.invalid'
const IDENTITY = 'a1000000-0000-4000-8000-000000000001'
const SESSION = 'a2000000-0000-4000-8000-000000000001'
const CLAIMS = { identityId: IDENTITY, sessionId: SESSION, sessionVersion: 1 }
const CONFIGURATION = { password: 'synthetic-catalog-http-cookie-password-32-characters', maxAgeSeconds: 3600 }
const utc = (milliseconds: number) => new Date(milliseconds).toISOString().replace(/\.\d{3}Z$/, 'Z')

describe('private draft-metadata HTTP boundary with migrated D1 SQLite', () => {
  let sqlite: DatabaseSync
  let database: D1Database
  let cookie: string
  let version: number

  beforeEach(async () => {
    sqlite = await openMigratedDatabase()
    database = d1OverSqlite(sqlite)
    seedInventoryFixture(sqlite)
    const now = utc(Date.now() - 60_000)
    const expires = utc(Date.now() + 3_600_000)
    sqlite
      .prepare(
        `INSERT INTO identities(id,email,password_hash,email_verified_at,status,created_at,updated_at)
        VALUES (?, 'editor-http@example.invalid', 'unusable-synthetic-hash', ?, 'active', ?, ?)`
      )
      .run(IDENTITY, now, now, now)
    sqlite
      .prepare(
        'INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at) VALUES (?, ?, 1, 1, ?, ?)'
      )
      .run(SESSION, IDENTITY, now, expires)
    sqlite.exec(`INSERT INTO roles VALUES ('catalog_editor', 'Editor', 'fixture');
      INSERT INTO permissions VALUES ('catalog.write', 'catalog', 'write', 'fixture');
      INSERT INTO role_permissions VALUES ('catalog_editor', 'catalog.write');`)
    sqlite
      .prepare('INSERT INTO identity_roles(identity_id,role_code,granted_at) VALUES (?, ?, ?)')
      .run(IDENTITY, 'catalog_editor', now)
    sqlite.exec(
      "UPDATE products SET status = 'draft', short_description = 'Texto breve', description = 'Texto original' WHERE id = 'p-1'"
    )
    version = (
      sqlite.prepare("SELECT catalog_version AS version FROM products WHERE id = 'p-1'").get() as { version: number }
    ).version
    cookie = (await issueD1SessionCookie(database, CLAIMS, CONFIGURATION))!.split(';')[0]!
  })

  afterEach(() => {
    sqlite.close()
  })

  function command(extra: Record<string, unknown> = {}) {
    return { expectedVersion: version, reason: 'Corrección editorial de prueba', name: 'Nombre corregido', ...extra }
  }

  function makeRequest(
    body: BodyInit | null = JSON.stringify(command()),
    headers: Record<string, string> = {},
    path = '/api/admin/products/1'
  ) {
    return new Request(`${ORIGIN}${path}`, {
      method: 'PUT',
      headers: {
        cookie,
        origin: ORIGIN,
        'content-type': 'application/json',
        'idempotency-key': 'http-edit-1',
        ...headers
      },
      body,
      ...(body instanceof ReadableStream ? { duplex: 'half' } : {})
    } as RequestInit)
  }

  async function handle(request: Request, overrides: { database?: D1Database; origin?: string; now?: string } = {}) {
    return (await handleD1AdminCatalogRequest(request, {
      database,
      sessionCookieConfiguration: CONFIGURATION,
      origin: ORIGIN,
      ...overrides
    }))!
  }

  function untouched() {
    expect(sqlite.prepare("SELECT name,catalog_version FROM products WHERE id = 'p-1'").get()).toMatchObject({
      name: 'Producto 1',
      catalog_version: version
    })
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM catalog_draft_commands').get()).toMatchObject({ n: 0 })
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM catalog_draft_audit').get()).toMatchObject({ n: 0 })
  }

  it('saves only draft metadata and returns the same persisted receipt after a later status/version change', async () => {
    const first = await handle(makeRequest())
    expect(first.status).toBe(200)
    const bytes = await first.text()
    expect(JSON.parse(bytes)).toEqual({
      source: 'cloudflare',
      productId: 1,
      productUuid: 'p-1',
      catalogVersion: version + 1,
      updated: true
    })
    expect(first.headers.get('x-ratelimit-limit')).toBe('60')
    expect(sqlite.prepare("SELECT name,status,slug FROM products WHERE id = 'p-1'").get()).toMatchObject({
      name: 'Nombre corregido',
      status: 'draft',
      slug: 'producto-1'
    })
    sqlite.exec("UPDATE products SET name = 'Nombre posterior', status = 'published' WHERE id = 'p-1'")
    const after = sqlite.prepare("SELECT catalog_version FROM products WHERE id = 'p-1'").get()
    const replay = await handle(makeRequest())
    expect(replay.status).toBe(200)
    expect(await replay.text()).toBe(bytes)
    expect(sqlite.prepare("SELECT name FROM products WHERE id = 'p-1'").get()).toMatchObject({
      name: 'Nombre posterior'
    })
    expect(sqlite.prepare("SELECT catalog_version FROM products WHERE id = 'p-1'").get()).toEqual(after)
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM catalog_draft_commands').get()).toMatchObject({ n: 1 })
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM catalog_draft_audit').get()).toMatchObject({ n: 1 })
  })

  it.each(['', 'https://evil.invalid', 'https://neteco.invalid/', 'null'])(
    'rejects nonexact write Origin %s before cookie/D1/body',
    async (origin) => {
      const prepare = vi.fn(() => {
        throw new Error('must not read D1')
      })
      const request = makeRequest(undefined, { origin })
      const result = await handle(request, { database: { prepare } as unknown as D1Database })
      expect(result.status).toBe(403)
      expect(await result.json()).toEqual({ error: { code: 'csrf_rejected' } })
      expect(prepare).not.toHaveBeenCalled()
      expect(request.bodyUsed).toBe(false)
      untouched()
    }
  )

  it('rejects absent Origin and cross-site metadata before body reads, ignoring Host/forwarded headers', async () => {
    const absent = makeRequest()
    absent.headers.delete('origin')
    expect((await handle(absent)).status).toBe(403)
    const crossSite = makeRequest(undefined, {
      'sec-fetch-site': 'cross-site',
      host: 'neteco.invalid',
      'x-forwarded-host': 'neteco.invalid'
    })
    expect((await handle(crossSite)).status).toBe(403)
    expect(absent.bodyUsed).toBe(false)
    expect(crossSite.bodyUsed).toBe(false)
    untouched()
  })

  it('fails closed for malformed trusted origin configuration before contacting D1', async () => {
    const prepare = vi.fn(() => {
      throw new Error('private SQL or credential')
    })
    const result = await handle(makeRequest(), {
      database: { prepare } as unknown as D1Database,
      origin: `${ORIGIN}/path`
    })
    expect(result.status).toBe(503)
    expect(await result.json()).toEqual({ error: { code: 'service_unavailable' } })
    expect(prepare).not.toHaveBeenCalled()
  })

  it.each(['01', '1.0', '1e0', 'p-1', '%31', '9007199254740992', '1?now=2099-01-01T00:00:00Z'])(
    'rejects alias/query %s before D1 or body',
    async (id) => {
      const prepare = vi.fn(() => {
        throw new Error('must not read D1')
      })
      const request = makeRequest(undefined, {}, `/api/admin/products/${id}`)
      const result = await handle(request, { database: { prepare } as unknown as D1Database })
      expect(result.status).toBe(400)
      expect(prepare).not.toHaveBeenCalled()
      expect(request.bodyUsed).toBe(false)
    }
  )

  it.each(['', 'neteco-session=forged-synthetic-cookie'])(
    'requires a verified session cookie without reading a body (%s)',
    async (cookieHeader) => {
      const request = makeRequest(undefined, { cookie: cookieHeader })
      expect((await handle(request)).status).toBe(401)
      expect(request.bodyUsed).toBe(false)
      untouched()
    }
  )

  it.each([
    ['UPDATE auth_sessions SET mfa_verified = 0', 'mfa_required'],
    ['UPDATE identities SET email_verified_at = NULL', 'email_unverified'],
    ['DELETE FROM identity_roles', 'forbidden']
  ])('requires live identity permission, email and MFA (%s)', async (sql, code) => {
    sqlite.exec(sql)
    const request = makeRequest()
    const result = await handle(request)
    expect(result.status).toBe(403)
    expect(await result.json()).toEqual({ error: { code } })
    expect(request.bodyUsed).toBe(false)
    untouched()
  })

  it('does not disclose or replay a successful command after permission revocation', async () => {
    expect((await handle(makeRequest())).status).toBe(200)
    sqlite.exec('DELETE FROM identity_roles')
    const result = await handle(makeRequest())
    expect(result.status).toBe(403)
    expect(await result.json()).toEqual({ error: { code: 'forbidden' } })
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM catalog_draft_audit').get()).toMatchObject({ n: 1 })
  })

  it.each(['', ' ', 'a'.repeat(201), 'bad/key'])('requires a bounded idempotency key before body (%s)', async (key) => {
    const request = makeRequest(undefined, { 'idempotency-key': key })
    const result = await handle(request)
    expect(result.status).toBe(400)
    expect(await result.json()).toEqual({ error: { code: 'invalid_idempotency_key' } })
    expect(request.bodyUsed).toBe(false)
    untouched()
  })

  it.each([
    'active',
    'status',
    'brand',
    'slug',
    'variants',
    'image',
    'imageRights',
    'price',
    'stock',
    'now',
    'regulatory'
  ])('rejects the entire hostile %s payload instead of silently stripping it', async (field) => {
    const result = await handle(makeRequest(JSON.stringify(command({ [field]: 'hostile' }))))
    expect(result.status).toBe(422)
    expect(await result.json()).toEqual({ error: { code: 'invalid_input' } })
    untouched()
  })

  it.each(['', 'text/plain', 'application/json; charset=latin1'])('requires explicit JSON UTF-8 (%s)', async (type) => {
    const request = makeRequest(undefined, { 'content-type': type })
    expect((await handle(request)).status).toBe(415)
    expect(request.bodyUsed).toBe(false)
    untouched()
  })

  it('rejects malformed JSON and malformed UTF-8 rather than replacing bytes', async () => {
    expect((await handle(makeRequest('{'))).status).toBe(400)
    const bytes = new Uint8Array([0x7b, 0x22, 0xc3, 0x28, 0x22, 0x3a, 0x31, 0x7d])
    const result = await handle(makeRequest(bytes))
    expect(result.status).toBe(400)
    expect(await result.json()).toEqual({ error: { code: 'invalid_json' } })
    untouched()
  })

  it.each(['65537', '-1', '1e5', 'not-a-number'])(
    'rejects oversized or invalid declared byte count %s before streaming',
    async (length) => {
      const request = makeRequest(undefined, { 'content-length': length })
      expect((await handle(request)).status).toBe(413)
      expect(request.bodyUsed).toBe(false)
      untouched()
    }
  )

  it('enforces streamed multibyte byte size even with a misleading small declared length', async () => {
    const bytes = new TextEncoder().encode(JSON.stringify(command({ name: '🧴'.repeat(17_000) })))
    let cancelled = false
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes)
      },
      cancel() {
        cancelled = true
      }
    })
    const result = await handle(makeRequest(stream, { 'content-length': '1' }))
    expect(result.status).toBe(413)
    expect(cancelled).toBe(true)
    untouched()
  })

  it('checks a durable identity write quota and never consumes the body of an over-limit write', async () => {
    const now = Math.floor(Date.now() / 1000)
    sqlite
      .prepare(
        `INSERT INTO identity_rate_limits(identity_id,scope,used,window_started_at,expires_at)
      VALUES (?, 'admin-catalog-metadata', 60, ?, ?)`
      )
      .run(IDENTITY, now, now + 3600)
    const request = makeRequest()
    const result = await handle(request)
    expect(result.status).toBe(429)
    expect(result.headers.get('retry-after')).not.toBeNull()
    expect(result.headers.get('x-ratelimit-remaining')).toBe('0')
    expect(request.bodyUsed).toBe(false)
    untouched()
  })

  it('uses the actual write execution clock, not the optional read-test instant', async () => {
    expect((await handle(makeRequest(), { now: '2099-01-01T00:00:00Z' })).status).toBe(200)
  })

  it('sanitizes storage outages and preserves private headers on success and every failure', async () => {
    const outage = {
      prepare() {
        throw new Error('SELECT secret_token FROM private_provider')
      }
    } as unknown as D1Database
    const results = [
      await handle(makeRequest(), { database: outage }),
      await handle(makeRequest(undefined, { origin: 'https://evil.invalid' })),
      await handle(makeRequest()),
      await handle(makeRequest(null, {}, '/api/admin/products'))
    ]
    expect(results[0]!.status).toBe(503)
    expect(await results[0]!.json()).toEqual({ error: { code: 'service_unavailable' } })
    for (const result of results) {
      expect(result.headers.get('cache-control')).toBe('private, no-store')
      expect(result.headers.get('pragma')).toBe('no-cache')
      expect(result.headers.get('vary')).toBe('Cookie')
      expect(result.headers.get('x-content-type-options')).toBe('nosniff')
      expect(result.headers.get('x-robots-tag')).toContain('noindex')
      expect(result.headers.get('access-control-allow-origin')).toBeNull()
    }
  })

  function readinessRequest(
    path = '/api/admin/products/1/publication-readiness',
    headers: Record<string, string> = {}
  ) {
    return new Request(`${ORIGIN}${path}`, { headers: { cookie, ...headers } })
  }

  it('returns a private advisory snapshot without writing products, inventory, commands or quota', async () => {
    const before = sqlite.prepare('SELECT total_changes() AS n').get()
    const result = await handle(readinessRequest())
    expect(result.status).toBe(200)
    const body = await result.json()
    expect(body).toMatchObject({
      source: 'cloudflare',
      advisory: true,
      publicationEnabled: false,
      productId: 1,
      productUuid: 'p-1',
      catalogVersion: version,
      issues: expect.any(Array),
      limitations: expect.any(Array)
    })
    expect(body).not.toHaveProperty('ready')
    expect(result.headers.get('cache-control')).toBe('private, no-store')
    expect(result.headers.get('x-robots-tag')).toContain('noindex')
    expect(result.headers.get('vary')).toBe('Cookie')
    expect(result.headers.get('access-control-allow-origin')).toBeNull()
    expect(sqlite.prepare('SELECT total_changes() AS n').get()).toEqual(before)
    untouched()
  })

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])(
    'rejects readiness %s before cookie, storage or body access',
    async (method) => {
      const prepare = vi.spyOn(database, 'prepare')
      const request = new Request(`${ORIGIN}/api/admin/products/1/publication-readiness`, {
        method,
        headers: { cookie, origin: ORIGIN },
        body: 'untrusted-publication-command'
      })
      const result = await handle(request)
      expect(result.status).toBe(405)
      expect(result.headers.get('allow')).toBe('GET')
      expect(request.bodyUsed).toBe(false)
      expect(prepare).not.toHaveBeenCalled()
      prepare.mockRestore()
      untouched()
    }
  )

  it.each(['01', '0', '-1', '9007199254740992'])('rejects noncanonical readiness product ID %s', async (id) => {
    expect((await handle(readinessRequest(`/api/admin/products/${id}/publication-readiness`))).status).toBe(400)
    untouched()
  })

  it('never accepts a client pricing/evaluation instant or other readiness query', async () => {
    expect(
      (await handle(readinessRequest('/api/admin/products/1/publication-readiness?instant=2099-01-01T00:00:00Z')))
        .status
    ).toBe(400)
    untouched()
  })

  it('protects advisory reads with the verified cookie and live staff, MFA and email authority', async () => {
    expect((await handle(readinessRequest(undefined, { cookie: 'invalid' }))).status).toBe(401)
    sqlite.prepare('UPDATE auth_sessions SET mfa_verified=0 WHERE id=?').run(SESSION)
    expect((await handle(readinessRequest())).status).toBe(403)
    sqlite.prepare('UPDATE auth_sessions SET mfa_verified=1 WHERE id=?').run(SESSION)
    sqlite.prepare('UPDATE identities SET email_verified_at=NULL WHERE id=?').run(IDENTITY)
    expect((await handle(readinessRequest())).status).toBe(403)
    sqlite.prepare('UPDATE identities SET email_verified_at=? WHERE id=?').run(utc(Date.now() - 60_000), IDENTITY)
    sqlite.prepare('DELETE FROM identity_roles WHERE identity_id=?').run(IDENTITY)
    expect((await handle(readinessRequest())).status).toBe(403)
    untouched()
  })

  it.each<Record<string, string>>([{ origin: 'https://evil.invalid' }, { 'sec-fetch-site': 'cross-site' }])(
    'rejects hostile readiness read metadata before storage: %#',
    async (headers) => {
      const prepare = vi.spyOn(database, 'prepare')
      expect((await handle(readinessRequest(undefined, headers))).status).toBe(403)
      expect(prepare).not.toHaveBeenCalled()
      prepare.mockRestore()
      untouched()
    }
  )

  it('distinguishes a missing product from a sanitized database outage', async () => {
    expect((await handle(readinessRequest('/api/admin/products/999/publication-readiness'))).status).toBe(404)
    const prepare = vi.spyOn(database, 'prepare').mockImplementation(() => {
      throw new Error('private SQL token')
    })
    const failure = await handle(readinessRequest())
    expect(failure.status).toBe(503)
    expect(await failure.json()).toEqual({ error: { code: 'service_unavailable' } })
    expect(failure.headers.get('cache-control')).toBe('private, no-store')
    prepare.mockRestore()
    untouched()
  })
})

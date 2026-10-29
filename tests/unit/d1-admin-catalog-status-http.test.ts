import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import {
  handleD1AdminCatalogRequest,
  type AdminCatalogHttpDependencies
} from '../../workers/catalog/admin-catalog-http'
import { AdminCatalogStatusError, type CatalogPublicationGate } from '../../workers/catalog/admin-catalog-status'
import { d1OverSqlite, openMigratedDatabase, seedInventoryFixture } from '../support/d1-sqlite'

const ORIGIN = 'https://neteco.invalid'
const IDENTITY = 'a1000000-0000-4000-8000-000000000035'
const SESSION = 'a2000000-0000-4000-8000-000000000035'
const CLAIMS = { identityId: IDENTITY, sessionId: SESSION, sessionVersion: 1 }
const CONFIGURATION = { password: 'synthetic-status-http-cookie-password-32-characters', maxAgeSeconds: 3600 }
const PRIVATE = 'SELECT private_token FROM quarantine/private-owner@example.invalid'
const FINGERPRINT = 'a'.repeat(64)
const utc = (milliseconds: number) => new Date(milliseconds).toISOString().replace(/\.\d{3}Z$/, 'Z')

describe('catalog status HTTP boundary against real migrated D1 SQLite', () => {
  let sqlite: DatabaseSync
  let database: D1Database
  let cookie: string
  let version: number

  beforeEach(async () => {
    sqlite = await openMigratedDatabase()
    sqlite.limits.exprDepth = 100
    database = d1OverSqlite(sqlite)
    seedInventoryFixture(sqlite)
    const past = utc(Date.now() - 60_000)
    sqlite
      .prepare(
        `INSERT INTO identities(id,email,password_hash,email_verified_at,status,created_at,updated_at)
        VALUES (?, 'status-http@example.invalid', 'synthetic-unusable-password-hash', ?, 'active', ?, ?)`
      )
      .run(IDENTITY, past, past, past)
    sqlite
      .prepare(
        `INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at)
        VALUES (?, ?, 1, 1, ?, ?)`
      )
      .run(SESSION, IDENTITY, past, utc(Date.now() + 3600_000))
    sqlite.exec(`INSERT INTO roles VALUES ('status_editor','Editor','Synthetic fixture'),
        ('status_publisher','Publisher','Synthetic fixture'),('status_customer','Customer','Synthetic fixture');
      INSERT INTO permissions VALUES ('catalog.write','catalog','write','Synthetic fixture'),
        ('catalog.publish','catalog','publish','Synthetic fixture'),('catalog.read','catalog','read','Synthetic fixture');
      INSERT INTO role_permissions VALUES ('status_editor','catalog.write'),
        ('status_publisher','catalog.publish'),('status_customer','catalog.read');`)
    assignRole('status_publisher')
    version = currentVersion()
    cookie = (await issueD1SessionCookie(database, CLAIMS, CONFIGURATION))!.split(';')[0]!
  })

  afterEach(() => {
    sqlite.close()
    vi.restoreAllMocks()
  })

  function assignRole(role: 'status_editor' | 'status_publisher' | 'status_customer') {
    sqlite.prepare('DELETE FROM identity_roles WHERE identity_id=?').run(IDENTITY)
    sqlite
      .prepare('INSERT INTO identity_roles(identity_id,role_code,granted_at) VALUES (?,?,?)')
      .run(IDENTITY, role, utc(Date.now() - 60_000))
  }
  function currentVersion() {
    const value = sqlite.prepare("SELECT catalog_version FROM products WHERE id='p-1'").get()!.catalog_version
    if (typeof value !== 'number') throw new Error('Invalid synthetic fixture version')
    return value
  }
  function command(extra: Record<string, unknown> = {}) {
    return { status: 'hidden', expectedVersion: version, reason: 'Revisión editorial sintética', ...extra }
  }
  function request(
    body: BodyInit | null = JSON.stringify(command()),
    headers: Record<string, string> = {},
    path = '/api/admin/products/1/status',
    method = 'PUT'
  ) {
    const init: RequestInit = {
      method,
      headers: {
        cookie,
        origin: ORIGIN,
        'content-type': 'application/json',
        'idempotency-key': 'status-http-1',
        ...headers
      },
      body
    }
    if (body instanceof ReadableStream) Object.assign(init, { duplex: 'half' })
    return new Request(`${ORIGIN}${path}`, init)
  }
  async function handle(candidate: Request, overrides: Partial<AdminCatalogHttpDependencies> = {}) {
    const result = await handleD1AdminCatalogRequest(candidate, {
      database,
      origin: ORIGIN,
      sessionCookieConfiguration: CONFIGURATION,
      ...overrides
    })
    expect(result).not.toBeNull()
    return result!
  }
  function originalProduct() {
    return sqlite.prepare("SELECT * FROM products WHERE id='p-1'").get()
  }
  function expectUnchanged(original = { status: 'published', catalog_version: version }) {
    expect(originalProduct()).toMatchObject(original)
    expect(sqlite.prepare('SELECT count(*) AS n FROM catalog_draft_commands').get()).toMatchObject({ n: 0 })
    expect(sqlite.prepare('SELECT count(*) AS n FROM catalog_draft_audit').get()).toMatchObject({ n: 0 })
    expect(sqlite.prepare('SELECT count(*) AS n FROM catalog_product_status_commands').get()).toMatchObject({ n: 0 })
    expect(sqlite.prepare('SELECT count(*) AS n FROM catalog_product_status_audit').get()).toMatchObject({ n: 0 })
  }
  function failingPrepare() {
    return vi.spyOn(database, 'prepare').mockImplementation(() => {
      throw new Error(PRIVATE)
    })
  }
  // Deliberately synthetic dependency, not proof of policy, rights or R2 bytes.
  // The real gate belongs to a separate production-service integration suite.
  function syntheticGate() {
    const condition = vi.fn((offset: number) => ({ sql: `?${offset + 1}=1`, parameters: [1] }))
    const prepare = vi.fn(async () => ({ fingerprint: FINGERPRINT, condition }))
    const gate: CatalogPublicationGate = { prepare }
    return { gate, prepare, condition }
  }
  async function hiddenProduct() {
    const response = await handle(request())
    expect(response.status).toBe(200)
    return currentVersion()
  }
  function serializedDatabase(): D1Database {
    const batch = database.batch.bind(database)
    let previous = Promise.resolve()
    async function serializedBatch<T>(statements: D1PreparedStatement[]) {
      const waiting = previous
      let release!: () => void
      previous = new Promise<void>((resolve) => {
        release = resolve
      })
      await waiting
      try {
        return await batch<T>(statements)
      } finally {
        release()
      }
    }
    return new Proxy(database, {
      get(target, key, receiver) {
        return key === 'batch' ? serializedBatch : Reflect.get(target, key, receiver)
      }
    })
  }

  it('lets a pure publisher hide a product and returns the exact server receipt', async () => {
    const result = await handle(request())
    expect(result.status).toBe(200)
    expect(await result.json()).toEqual({
      source: 'cloudflare',
      productId: 1,
      productUuid: 'p-1',
      catalogVersion: version + 1,
      status: 'hidden',
      active: false,
      updated: true
    })
    expect(result.headers.get('x-ratelimit-limit')).toBe('60')
    expect(result.headers.get('x-ratelimit-remaining')).toBe('59')
    expect(originalProduct()).toMatchObject({ name: 'Producto 1', slug: 'producto-1', status: 'hidden' })
    expect(sqlite.prepare('SELECT * FROM role_permissions WHERE role_code=?').all('status_publisher')).toEqual([
      expect.objectContaining({ permission_code: 'catalog.publish' })
    ])
  })

  it('preserves a completed receipt on replay after later product status and version changes', async () => {
    const first = await handle(request())
    expect(first.status).toBe(200)
    const receipt = await first.text()
    sqlite.exec("UPDATE products SET status='draft',name='Nombre posterior' WHERE id='p-1'")
    const later = originalProduct()
    const replay = await handle(request())
    expect(replay.status).toBe(200)
    expect(await replay.text()).toBe(receipt)
    expect(originalProduct()).toEqual(later)
  })

  it('enforces the persisted original publisher permission on replay even if catalog.write is now granted', async () => {
    expect((await handle(request())).status).toBe(200)
    assignRole('status_editor')
    const snapshot = originalProduct()
    const replay = await handle(request())
    expect(replay.status).toBe(403)
    expect(await replay.json()).toEqual({ error: { code: 'forbidden' } })
    expect(originalProduct()).toEqual(snapshot)
  })

  it('permits editorial draft→review without a publisher grant, then preserves its original replay permission', async () => {
    sqlite.exec("UPDATE products SET status='draft' WHERE id='p-1'")
    const expectedVersion = currentVersion()
    assignRole('status_editor')
    const body = JSON.stringify(command({ status: 'review', expectedVersion }))
    const first = await handle(request(body))
    expect(first.status).toBe(200)
    expect(await first.json()).toMatchObject({ status: 'review', active: false, catalogVersion: expectedVersion + 1 })
    assignRole('status_publisher')
    const replay = await handle(request(body))
    expect(replay.status).toBe(403)
    expect(await replay.json()).toEqual({ error: { code: 'forbidden' } })
  })

  it('does not authorize publisher-only transitions with a writer grant', async () => {
    assignRole('status_editor')
    const result = await handle(request())
    expect(result.status).toBe(403)
    expect(await result.json()).toEqual({ error: { code: 'forbidden' } })
    expectUnchanged()
  })

  it.each(['', 'https://evil.invalid', `${ORIGIN}/`, 'null'])(
    'rejects nonexact write Origin before cookie, SQL and body: %s',
    async (origin) => {
      const prepare = failingPrepare()
      const candidate = request(undefined, { origin })
      const result = await handle(candidate)
      expect(result.status).toBe(403)
      expect(await result.json()).toEqual({ error: { code: 'csrf_rejected' } })
      expect(prepare).not.toHaveBeenCalled()
      expect(candidate.bodyUsed).toBe(false)
      expectUnchanged()
    }
  )

  it('rejects absent Origin and cross-site metadata before SQL/body', async () => {
    const prepare = failingPrepare()
    const absent = request()
    absent.headers.delete('origin')
    const crossSite = request(undefined, { 'sec-fetch-site': 'cross-site' })
    for (const candidate of [absent, crossSite]) {
      expect((await handle(candidate)).status).toBe(403)
      expect(candidate.bodyUsed).toBe(false)
    }
    expect(prepare).not.toHaveBeenCalled()
  })

  it('rejects malformed trusted origin configuration without reflecting it or contacting D1', async () => {
    const prepare = failingPrepare()
    const candidate = request()
    const result = await handle(candidate, { origin: `${ORIGIN}/private` })
    expect(result.status).toBe(503)
    expect(await result.json()).toEqual({ error: { code: 'service_unavailable' } })
    expect(prepare).not.toHaveBeenCalled()
    expect(candidate.bodyUsed).toBe(false)
  })

  it.each(['0', '-1', '01', '1.0', '1e0', '+1', 'p-1', '%31', '1%20', '9007199254740992'])(
    'rejects noncanonical product ID %s before SQL/body',
    async (id) => {
      const prepare = failingPrepare()
      const candidate = request(undefined, {}, `/api/admin/products/${id}/status`)
      const result = await handle(candidate)
      expect(result.status).toBe(400)
      expect(await result.json()).toEqual({ error: { code: 'invalid_input' } })
      expect(prepare).not.toHaveBeenCalled()
      expect(candidate.bodyUsed).toBe(false)
    }
  )

  it.each(['?now=2099-01-01T00:00:00Z', '?active=1', '?status=hidden', '?x=1&x=2'])(
    'rejects all query controls before SQL/body: %s',
    async (query) => {
      const prepare = failingPrepare()
      const candidate = request(undefined, {}, `/api/admin/products/1/status${query}`)
      expect((await handle(candidate)).status).toBe(400)
      expect(prepare).not.toHaveBeenCalled()
      expect(candidate.bodyUsed).toBe(false)
    }
  )

  it.each(['GET', 'HEAD', 'POST', 'PATCH', 'DELETE', 'OPTIONS'])(
    'offers only PUT on the new status endpoint, not %s',
    async (method) => {
      const prepare = failingPrepare()
      const candidate = request(null, {}, '/api/admin/products/1/status', method)
      const result = await handle(candidate)
      expect(result.status).toBe(405)
      expect(result.headers.get('allow')).toBe('PUT')
      expect(prepare).not.toHaveBeenCalled()
      expect(candidate.bodyUsed).toBe(false)
    }
  )

  it('does not add an active alias or another status route', async () => {
    const prepare = failingPrepare()
    for (const path of ['/api/admin/products/1/active', '/api/admin/products/1/status/']) {
      const candidate = request(undefined, {}, path)
      expect((await handle(candidate)).status).toBe(405)
      expect(candidate.bodyUsed).toBe(false)
    }
    expect(prepare).not.toHaveBeenCalled()
  })

  it.each(['', 'neteco-session=forged-synthetic-cookie'])(
    'requires a sealed session before SQL/body: %s',
    async (header) => {
      const prepare = failingPrepare()
      const candidate = request(undefined, { cookie: header })
      expect((await handle(candidate)).status).toBe(401)
      expect(prepare).not.toHaveBeenCalled()
      expect(candidate.bodyUsed).toBe(false)
    }
  )

  it.each([
    ['UPDATE auth_sessions SET mfa_verified=0', 403, 'mfa_required'],
    ['UPDATE identities SET email_verified_at=NULL', 403, 'email_unverified'],
    ['DELETE FROM identity_roles', 403, 'forbidden'],
    ["UPDATE auth_sessions SET revoked_at='2020-01-01T00:00:00Z'", 401, 'unauthenticated'],
    ['UPDATE identities SET session_version=2', 401, 'unauthenticated']
  ])('requires live authority before body: %s', async (sql, status, code) => {
    sqlite.exec(String(sql))
    const candidate = request()
    const result = await handle(candidate)
    expect(result.status).toBe(status)
    expect(await result.json()).toEqual({ error: { code } })
    expect(candidate.bodyUsed).toBe(false)
    expectUnchanged()
  })

  it('does not treat customer catalog.read as permission to see or execute a status command', async () => {
    assignRole('status_customer')
    const candidate = request()
    const result = await handle(candidate)
    expect(result.status).toBe(403)
    expect(await result.json()).toEqual({ error: { code: 'forbidden' } })
    expect(candidate.bodyUsed).toBe(false)
    expectUnchanged()
  })

  it('does not disguise a failure of the fallback publisher grant query as forbidden', async () => {
    const original = database.prepare.bind(database)
    vi.spyOn(database, 'prepare').mockImplementation((sql) => {
      const statement = original(sql)
      if (sql.includes('role_permissions')) {
        const bind = statement.bind.bind(statement)
        vi.spyOn(statement, 'bind').mockImplementation((...values: unknown[]) => {
          if (values.includes('catalog.publish')) throw new Error(PRIVATE)
          return bind(...values)
        })
      }
      return statement
    })
    const candidate = request()
    const result = await handle(candidate)
    expect(result.status).toBe(503)
    expect(await result.json()).toEqual({ error: { code: 'service_unavailable' } })
    expect(candidate.bodyUsed).toBe(false)
    expectUnchanged()
  })

  it.each(['', ' ', 'a'.repeat(201), 'bad/key', 'bad,key'])(
    'requires a bounded idempotency key before streaming: %s',
    async (key) => {
      const candidate = request(undefined, { 'idempotency-key': key })
      const result = await handle(candidate)
      expect(result.status).toBe(400)
      expect(await result.json()).toEqual({ error: { code: 'invalid_idempotency_key' } })
      expect(candidate.bodyUsed).toBe(false)
      expectUnchanged()
    }
  )

  it.each(['active', 'name', 'variants', 'price', 'stock', 'now', 'publicationGate', 'fingerprint', '__proto__'])(
    'rejects the entire request with unexpected field %s',
    async (field) => {
      const result = await handle(request(JSON.stringify(command({ [field]: PRIVATE }))))
      expect(result.status).toBe(422)
      expect(await result.json()).toEqual({ error: { code: 'invalid_input' } })
      expectUnchanged()
    }
  )

  it.each([
    { status: 'ready' },
    { status: true },
    { expectedVersion: '1' },
    { expectedVersion: 0 },
    { expectedVersion: Number.MAX_SAFE_INTEGER },
    { reason: 'ab' },
    { reason: 'x'.repeat(501) },
    { reason: 'valid reason\n' }
  ])('does not coerce invalid status input: %j', async (input) => {
    const result = await handle(request(JSON.stringify(command(input))))
    expect(result.status).toBe(422)
    expect(await result.json()).toEqual({ error: { code: 'invalid_input' } })
    expectUnchanged()
  })

  it.each(['', 'text/plain', 'application/json; charset=latin1'])(
    'requires explicit JSON UTF-8 media type %s before body',
    async (type) => {
      const candidate = request(undefined, { 'content-type': type })
      expect((await handle(candidate)).status).toBe(415)
      expect(candidate.bodyUsed).toBe(false)
      expectUnchanged()
    }
  )

  it('rejects empty body, malformed JSON and invalid UTF-8 without mutation', async () => {
    expect((await handle(request(null))).status).toBe(400)
    expect((await handle(request(''))).status).toBe(400)
    const malformed = await handle(request('{'))
    expect(malformed.status).toBe(400)
    expect(await malformed.json()).toEqual({ error: { code: 'invalid_json' } })
    const invalid = await handle(request(new Uint8Array([0x7b, 0x22, 0xc3, 0x28, 0x22, 0x3a, 0x31, 0x7d])))
    expect(invalid.status).toBe(400)
    expect(await invalid.json()).toEqual({ error: { code: 'invalid_json' } })
    expectUnchanged()
  })

  it.each(['65537', '-1', '1e5', 'not-a-number'])(
    'rejects invalid or oversized declared bytes before streaming: %s',
    async (length) => {
      const candidate = request(undefined, { 'content-length': length })
      expect((await handle(candidate)).status).toBe(413)
      expect(candidate.bodyUsed).toBe(false)
      expectUnchanged()
    }
  )

  it('limits actual streamed UTF-8 bytes even when Content-Length claims one byte', async () => {
    const bytes = new TextEncoder().encode(JSON.stringify(command({ reason: '🧴'.repeat(17_000) })))
    let cancelled = false
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes)
      },
      cancel() {
        cancelled = true
      }
    })
    expect((await handle(request(stream, { 'content-length': '1' }))).status).toBe(413)
    expect(cancelled).toBe(true)
    expectUnchanged()
  })

  it('enforces a separate durable status quota before consuming the body', async () => {
    const now = Math.floor(Date.now() / 1000)
    sqlite
      .prepare(
        `INSERT INTO identity_rate_limits(identity_id,scope,used,window_started_at,expires_at)
        VALUES (?,'admin-catalog-status',60,?,?)`
      )
      .run(IDENTITY, now, now + 3600)
    const candidate = request()
    const result = await handle(candidate)
    expect(result.status).toBe(429)
    expect(result.headers.get('retry-after')).not.toBeNull()
    expect(result.headers.get('x-ratelimit-limit')).toBe('60')
    expect(result.headers.get('x-ratelimit-remaining')).toBe('0')
    expect(candidate.bodyUsed).toBe(false)
    expectUnchanged()
  })

  it('fails quota persistence closed with a sanitized 503 before consuming body', async () => {
    const original = database.prepare.bind(database)
    vi.spyOn(database, 'prepare').mockImplementation((sql) => {
      if (sql.includes('INSERT INTO identity_rate_limits')) throw new Error(PRIVATE)
      return original(sql)
    })
    const candidate = request()
    const result = await handle(candidate)
    expect(result.status).toBe(503)
    expect(await result.json()).toEqual({ error: { code: 'abuse_control_unavailable' } })
    expect(candidate.bodyUsed).toBe(false)
    expectUnchanged()
  })

  it('does not forward the optional read-test clock to status mutation', async () => {
    expect((await handle(request(), { now: '2099-01-01T00:00:00Z' })).status).toBe(200)
  })

  it.each([
    ['DELETE FROM identity_roles', 403, 'forbidden'],
    ["UPDATE auth_sessions SET expires_at=strftime('%Y-%m-%dT%H:%M:%SZ','now','-1 second')", 401, 'unauthenticated']
  ])('reauthorizes after authority changes during body streaming: %s', async (sql, status, code) => {
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          sqlite.exec(String(sql))
          controller.enqueue(new TextEncoder().encode(JSON.stringify(command())))
          controller.close()
        }
      },
      { highWaterMark: 0 }
    )
    const result = await handle(request(stream))
    expect(result.status).toBe(status)
    expect(await result.json()).toEqual({ error: { code } })
    expect(sqlite.prepare('SELECT used FROM identity_rate_limits WHERE scope=?').get('admin-catalog-status')).toEqual({
      used: 1
    })
    expectUnchanged()
  })

  it('reports version and graph business conflicts as sanitized 409s', async () => {
    const stale = await handle(request(JSON.stringify(command({ expectedVersion: version + 1 }))))
    expect(stale.status).toBe(409)
    expect(await stale.json()).toEqual({ error: { code: 'version_conflict' } })
    const noOp = await handle(request(JSON.stringify(command({ status: 'published' }))))
    expect(noOp.status).toBe(409)
    expect(await noOp.json()).toEqual({ error: { code: 'invalid_transition' } })
    const invalid = await handle(request(JSON.stringify(command({ status: 'review' }))))
    expect(invalid.status).toBe(409)
    expect(await invalid.json()).toEqual({ error: { code: 'invalid_transition' } })
    expectUnchanged()
  })

  it('reports unknown canonical products as not_found without leaking data', async () => {
    const result = await handle(request(undefined, {}, '/api/admin/products/999/status'))
    expect(result.status).toBe(404)
    expect(await result.json()).toEqual({ error: { code: 'not_found' } })
    expectUnchanged()
  })

  it('rejects key reuse with another payload and preserves the first command', async () => {
    expect((await handle(request())).status).toBe(200)
    const product = originalProduct()
    const result = await handle(request(JSON.stringify(command({ reason: 'Otra razón válida' }))))
    expect(result.status).toBe(409)
    expect(await result.json()).toEqual({ error: { code: 'idempotency_conflict' } })
    expect(originalProduct()).toEqual(product)
  })

  it('returns one persisted receipt for identical concurrent HTTP commands', async () => {
    const serial = serializedDatabase()
    const results = await Promise.all([
      handle(request(), { database: serial }),
      handle(request(), { database: serial })
    ])
    expect(results.map((response) => response.status)).toEqual([200, 200])
    expect(await results[0]!.text()).toBe(await results[1]!.text())
    expect(currentVersion()).toBe(version + 1)
  })

  it('forwards only a trusted publication gate and lets a pure publisher publish', async () => {
    const nextVersion = await hiddenProduct()
    const { gate, prepare, condition } = syntheticGate()
    const result = await handle(
      request(JSON.stringify(command({ status: 'published', expectedVersion: nextVersion })), {
        'idempotency-key': 'status-http-publish'
      }),
      { publicationGate: gate, now: '2099-01-01T00:00:00Z' }
    )
    expect(result.status).toBe(200)
    expect(await result.json()).toEqual({
      source: 'cloudflare',
      productId: 1,
      productUuid: 'p-1',
      catalogVersion: nextVersion + 1,
      status: 'published',
      active: true,
      updated: true
    })
    expect(prepare).toHaveBeenCalledExactlyOnceWith(database, { productUuid: 'p-1', productId: 1 }, CLAIMS)
    expect(condition).toHaveBeenCalled()
  })

  it('fails publication closed when the trusted gate is absent', async () => {
    const nextVersion = await hiddenProduct()
    const product = originalProduct()
    const result = await handle(
      request(JSON.stringify(command({ status: 'published', expectedVersion: nextVersion })), {
        'idempotency-key': 'status-http-publish'
      })
    )
    expect(result.status).toBe(409)
    expect(await result.json()).toMatchObject({ error: { code: 'publication_blocked', issues: expect.any(Array) } })
    expect(originalProduct()).toEqual(product)
  })

  it('exposes only controlled issue codes/paths and locally generated generic messages', async () => {
    const nextVersion = await hiddenProduct()
    const gate: CatalogPublicationGate = {
      async prepare() {
        throw new AdminCatalogStatusError('publication_blocked', [
          { code: 'category.status', path: 'category', message: PRIVATE },
          { code: 'variant.tax', path: 'variants.0.tax', message: FINGERPRINT },
          { code: 'policy.document', path: 'documents.sds', message: PRIVATE },
          { code: PRIVATE, path: 'media', message: PRIVATE },
          { code: 'media.object_integrity', path: PRIVATE, message: PRIVATE },
          { code: 'variant.tax', path: 'variants.0.tax\n', message: PRIVATE }
        ])
      }
    }
    const result = await handle(
      request(JSON.stringify(command({ status: 'published', expectedVersion: nextVersion })), {
        'idempotency-key': 'status-http-publish'
      }),
      { publicationGate: gate }
    )
    expect(result.status).toBe(409)
    const body = await result.text()
    expect(body).not.toContain(PRIVATE)
    expect(body).not.toContain(FINGERPRINT)
    expect(JSON.parse(body)).toEqual({
      error: {
        code: 'publication_blocked',
        issues: [
          {
            code: 'category.status',
            path: 'category',
            message: 'Revisa este requisito antes de publicar el producto.'
          },
          {
            code: 'variant.tax',
            path: 'variants.0.tax',
            message: 'Revisa este requisito antes de publicar el producto.'
          },
          {
            code: 'policy.document',
            path: 'documents.sds',
            message: 'Revisa este requisito antes de publicar el producto.'
          },
          ...Array.from({ length: 3 }, () => ({
            code: 'publication.snapshot',
            path: 'publication',
            message: 'No se han podido validar todos los requisitos de publicación.'
          }))
        ]
      }
    })
    expect(originalProduct()).toMatchObject({ status: 'hidden', catalog_version: nextVersion })
  })

  it('bounds publication errors rather than reflecting an unbounded provider list', async () => {
    const nextVersion = await hiddenProduct()
    const gate: CatalogPublicationGate = {
      async prepare() {
        throw new AdminCatalogStatusError(
          'publication_blocked',
          Array.from({ length: 101 }, () => ({ code: 'media.object_unavailable', path: 'media', message: PRIVATE }))
        )
      }
    }
    const result = await handle(
      request(JSON.stringify(command({ status: 'published', expectedVersion: nextVersion })), {
        'idempotency-key': 'status-http-publish'
      }),
      { publicationGate: gate }
    )
    expect(result.status).toBe(409)
    const body: unknown = await result.json()
    const parsed = z
      .object({
        error: z
          .object({
            code: z.literal('publication_blocked'),
            issues: z.array(z.object({ code: z.string(), path: z.string(), message: z.string() }).strict())
          })
          .strict()
      })
      .strict()
      .parse(body)
    expect(parsed.error.issues).toHaveLength(100)
    expect(JSON.stringify(body)).not.toContain(PRIVATE)
  })

  it('maps unexpected storage/gate outages to 503 and never reflects private messages', async () => {
    const nextVersion = await hiddenProduct()
    const gate: CatalogPublicationGate = {
      async prepare() {
        throw new Error(PRIVATE)
      }
    }
    const result = await handle(
      request(JSON.stringify(command({ status: 'published', expectedVersion: nextVersion })), {
        'idempotency-key': 'status-http-publish'
      }),
      { publicationGate: gate }
    )
    expect(result.status).toBe(503)
    expect(await result.json()).toEqual({ error: { code: 'service_unavailable' } })
    expect(originalProduct()).toMatchObject({ status: 'hidden', catalog_version: nextVersion })
  })

  it('preserves private response headers across success, authorization, business failure and outage', async () => {
    const results = [
      await handle(request(undefined, { origin: 'https://evil.invalid' })),
      await handle(request(JSON.stringify(command({ expectedVersion: version + 1 })))),
      await handle(request())
    ]
    failingPrepare()
    results.push(await handle(request()))
    for (const result of results) {
      expect(result.headers.get('cache-control')).toBe('private, no-store')
      expect(result.headers.get('pragma')).toBe('no-cache')
      expect(result.headers.get('vary')).toBe('Cookie')
      expect(result.headers.get('x-content-type-options')).toBe('nosniff')
      expect(result.headers.get('x-robots-tag')).toContain('noindex')
      expect(result.headers.get('referrer-policy')).toBe('no-referrer')
      expect(result.headers.get('access-control-allow-origin')).toBeNull()
    }
    expect(results.map((result) => result.status)).toEqual([403, 409, 200, 503])
  })

  it('preserves existing GET/readiness/metadata PUT while status remains a separate command', async () => {
    assignRole('status_editor')
    for (const path of [
      '/api/admin/products',
      '/api/admin/products/1',
      '/api/admin/products/1/publication-readiness'
    ]) {
      expect((await handle(request(null, {}, path, 'GET'))).status).toBe(200)
    }
    sqlite.exec("UPDATE products SET status='draft' WHERE id='p-1'")
    const expectedVersion = currentVersion()
    const response = await handle(
      request(
        JSON.stringify({ expectedVersion, reason: 'Corrección de texto sintética', name: 'Nuevo nombre de borrador' }),
        { 'idempotency-key': 'unchanged-metadata-put' },
        '/api/admin/products/1'
      )
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      source: 'cloudflare',
      productId: 1,
      productUuid: 'p-1',
      catalogVersion: expectedVersion + 1,
      updated: true
    })
    expect(originalProduct()).toMatchObject({ status: 'draft', name: 'Nuevo nombre de borrador' })
  })
})

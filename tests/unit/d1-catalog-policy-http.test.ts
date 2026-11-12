import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { catalogPolicyReceiptSchema } from '../../shared/catalog-publication-policy'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import { handleCatalogPolicyHttp, type CatalogPolicyHttpEnvironment } from '../../workers/catalog/catalog-policy-http'
import { d1OverSqlite, openMigratedDatabase, seedInventoryFixture } from '../support/d1-sqlite'
import { testNow } from '../support/deterministic'

const ORIGIN = 'https://neteco.invalid'
const COLLECTION = '/api/admin/catalog/policies'
const PRODUCT_PATH = '/api/admin/products/101/publication-policy'
const EXCEPTIONS = '/api/admin/products/101/identifier-exceptions'
const IDENTITY = 'a1000000-0000-4000-8000-000000000037'
const SESSION = 'a2000000-0000-4000-8000-000000000037'
const PRODUCT = '81000000-0000-4000-8000-000000000037'
const VARIANT = '82000000-0000-4000-8000-000000000037'
const UNKNOWN = '83abcdef-0000-4000-8000-000000000037'
const CLAIMS = { identityId: IDENTITY, sessionId: SESSION, sessionVersion: 1 }
const PASSWORD = 'synthetic-policy-http-cookie-password-32-characters'
const PRIVATE = 'SELECT private_provider_token FROM quarantine/private-owner@example.invalid'
const PAST = '2020-01-01T00:00:00Z'
const REASON = 'Revisión sintética de política; no es una aprobación comercial'
const utc = (milliseconds: number) => new Date(milliseconds).toISOString().replace(/\.\d{3}Z$/, 'Z')

describe('private publication-policy HTTP boundary against real D1 SQLite migrations', () => {
  let sqlite: DatabaseSync
  let database: D1Database
  let env: CatalogPolicyHttpEnvironment
  let cookie: string
  let before: ReturnType<typeof state>

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(testNow())
    sqlite = await openMigratedDatabase()
    sqlite.function('synthetic_catalog_policy_http_clock', () => {
      const clock = vi.getMockedSystemTime()
      if (!clock) throw new Error('missing_synthetic_catalog_policy_http_clock')
      return clock.toISOString().replace(/\.\d{3}Z$/, 'Z')
    })
    const nativeExec = sqlite.exec.bind(sqlite)
    sqlite.exec = (sql: string) => nativeExec(sql.replaceAll("'now'", 'synthetic_catalog_policy_http_clock()'))
    const nativeDatabase = d1OverSqlite(sqlite),
      nativePrepare = nativeDatabase.prepare.bind(nativeDatabase)
    database = new Proxy(nativeDatabase, {})
    database.prepare = (sql: string) => nativePrepare(sql.replaceAll("'now'", 'synthetic_catalog_policy_http_clock()'))
    seedInventoryFixture(sqlite)
    const past = utc(testNow() - 60_000)
    sqlite
      .prepare(
        `INSERT INTO identities(id,email,password_hash,email_verified_at,status,created_at,updated_at)
      VALUES (?, 'policy-http@example.invalid', 'unusable-synthetic-hash', ?, 'active', ?, ?)`
      )
      .run(IDENTITY, past, past, past)
    sqlite
      .prepare(
        `INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at)
      VALUES (?,?,1,1,?,?)`
      )
      .run(SESSION, IDENTITY, past, utc(testNow() + 3600_000))
    sqlite.exec(`INSERT INTO roles VALUES ('policy_publisher','Publisher','Synthetic fixture'),
      ('policy_writer','Writer','Synthetic fixture'),('policy_customer','Customer','Synthetic fixture');
      INSERT INTO permissions VALUES ('catalog.publish','catalog','publish','Synthetic fixture'),
        ('catalog.write','catalog','write','Synthetic fixture'),('catalog.read','catalog','read','Synthetic fixture');
      INSERT INTO role_permissions VALUES ('policy_publisher','catalog.publish'),
        ('policy_writer','catalog.write'),('policy_customer','catalog.read');`)
    assignRole('policy_publisher')
    // UUID domain identities match the public policy contracts. The seeded
    // inventory supplies only shared FK fixtures, not policy/legal approval.
    sqlite
      .prepare(
        `INSERT INTO products(id,legacy_id,category_id,brand_id,slug,name,status,regulatory,attributes)
      VALUES (?,101,'c1','b1','synthetic-policy-product','Producto sintético de política','draft','{}',
        '{"protectedExtra":"keep","visual":{"type":"garrafa","color":"#123456"}}')`
      )
      .run(PRODUCT)
    sqlite
      .prepare(
        `INSERT INTO variants(id,legacy_id,product_id,tax_class_id,shipping_profile_id,sku,format,status,price_gross_cents)
      SELECT ?,1001,? ,tax_class_id,shipping_profile_id,'SYNTHETIC-POLICY-101',format,'draft',price_gross_cents
      FROM variants WHERE id='v-1-1'`
      )
      .run(VARIANT, PRODUCT)
    env = { DB: database, AUTH_ENABLED: 'true', AUTH_ORIGIN: ORIGIN, NUXT_SESSION_PASSWORD: PASSWORD }
    cookie = (await issueD1SessionCookie(database, CLAIMS, { password: PASSWORD, maxAgeSeconds: 3600 }))!.split(';')[0]!
    before = state()
  })

  afterEach(() => {
    sqlite.close()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  function assignRole(role: 'policy_publisher' | 'policy_writer' | 'policy_customer') {
    sqlite.prepare('DELETE FROM identity_roles WHERE identity_id=?').run(IDENTITY)
    sqlite
      .prepare('INSERT INTO identity_roles(identity_id,role_code,granted_at) VALUES (?,?,?)')
      .run(IDENTITY, role, utc(testNow() - 60_000))
  }
  function version() {
    const value = sqlite.prepare('SELECT catalog_version FROM products WHERE id=?').get(PRODUCT)!.catalog_version
    if (typeof value !== 'number') throw new Error('Invalid synthetic fixture version')
    return value
  }
  function policy(extra: Record<string, unknown> = {}) {
    return {
      code: 'synthetic_type',
      name: 'Política sintética',
      expectedVersion: 0,
      requiredFields: [],
      requiredMediaRoles: [],
      identifierExceptionsAllowed: true,
      validFrom: PAST,
      validUntil: null,
      reason: REASON,
      ...extra
    }
  }
  function assignment(policyId: string, extra: Record<string, unknown> = {}) {
    return {
      expectedVersion: version(),
      policyId,
      regulatory: { productType: 'synthetic_type', requiresSds: false },
      reason: REASON,
      ...extra
    }
  }
  function exception(extra: Record<string, unknown> = {}) {
    return {
      expectedVersion: version(),
      variantId: VARIANT,
      reason: REASON,
      evidenceReference: 'Referencia sintética sin efectos legales',
      validFrom: PAST,
      validUntil: null,
      ...extra
    }
  }
  function request(
    body: BodyInit | null = JSON.stringify(policy()),
    headers: Record<string, string> = {},
    path = COLLECTION,
    method = 'POST'
  ) {
    const init: RequestInit = {
      method,
      body,
      headers: {
        cookie,
        origin: ORIGIN,
        'content-type': 'application/json',
        'idempotency-key': 'policy-http-1',
        ...headers
      }
    }
    if (body instanceof ReadableStream) Object.assign(init, { duplex: 'half' })
    return new Request(`${ORIGIN}${path}`, init)
  }
  async function handle(candidate: Request, overrides: Partial<CatalogPolicyHttpEnvironment> = {}) {
    const result = await handleCatalogPolicyHttp(candidate, { ...env, ...overrides })
    expect(result).not.toBeNull()
    return result!
  }
  function read(path = COLLECTION) {
    return request(null, {}, path, 'GET')
  }
  function state() {
    return {
      product: sqlite.prepare('SELECT * FROM products WHERE id=?').get(PRODUCT),
      variant: sqlite.prepare('SELECT * FROM variants WHERE id=?').get(VARIANT),
      rows: [
        'catalog_publication_policies',
        'catalog_publication_policy_withdrawals',
        'catalog_product_publication_policies',
        'catalog_variant_identifier_exceptions',
        'catalog_variant_identifier_exception_withdrawals',
        'catalog_policy_commands',
        'catalog_policy_audit',
        'catalog_policy_guards'
      ].map((table) => sqlite.prepare(`SELECT * FROM ${table} ORDER BY id`).all())
    }
  }
  function untouched() {
    expect(state()).toEqual(before)
  }
  function failingPrepare() {
    return vi.spyOn(database, 'prepare').mockImplementation(() => {
      throw new Error(PRIVATE)
    })
  }
  async function createPolicy(extra: Record<string, unknown> = {}, key = 'fixture-create-policy') {
    const response = await handle(request(JSON.stringify(policy(extra)), { 'idempotency-key': key }))
    expect(response.status).toBe(200)
    return catalogPolicyReceiptSchema.parse(await response.json())
  }
  async function assignPolicy(policyId: string, key = 'fixture-assign-policy') {
    const response = await handle(
      request(JSON.stringify(assignment(policyId)), { 'idempotency-key': key }, PRODUCT_PATH, 'PUT')
    )
    expect(response.status).toBe(200)
    return catalogPolicyReceiptSchema.parse(await response.json())
  }
  function serializedDatabase(): D1Database {
    const original = database.batch.bind(database)
    let previous = Promise.resolve()
    async function batch<T>(statements: D1PreparedStatement[]) {
      const waiting = previous
      let release!: () => void
      previous = new Promise<void>((resolve) => {
        release = resolve
      })
      await waiting
      try {
        return await original<T>(statements)
      } finally {
        release()
      }
    }
    return new Proxy(database, {
      get(target, key, receiver) {
        return key === 'batch' ? batch : Reflect.get(target, key, receiver)
      }
    })
  }

  it('creates a reviewed policy with a pure publisher grant and exact persisted receipt', async () => {
    const started = utc(testNow())
    const response = await handle(request())
    expect(response.status).toBe(200)
    const receipt = catalogPolicyReceiptSchema.parse(await response.json())
    expect(receipt).toEqual({
      source: 'cloudflare',
      action: 'policy_create',
      entityId: receipt.entityId,
      resourceId: receipt.entityId,
      policyVersion: 1,
      productId: null,
      productUuid: null,
      catalogVersion: null,
      updated: true
    })
    expect(response.headers.get('x-ratelimit-limit')).toBe('60')
    expect(response.headers.get('x-ratelimit-remaining')).toBe('59')
    const command = sqlite.prepare('SELECT response,created_at FROM catalog_policy_commands').get()!
    expect(command.response).toBe(JSON.stringify(receipt))
    expect(String(command.created_at) >= started).toBe(true)
    expect(String(command.created_at) <= utc(testNow())).toBe(true)
    expect(sqlite.prepare('SELECT count(*) AS n FROM catalog_policy_audit').get()!.n).toBe(1)
    expect(sqlite.prepare('SELECT count(*) AS n FROM catalog_policy_guards').get()!.n).toBe(0)
    expect(state().product).toEqual(before.product)
  })

  it('supports all five fixed actions without accepting an action or a clock in JSON', async () => {
    const created = await createPolicy()
    const assigned = await assignPolicy(created.entityId)
    expect(assigned).toEqual({
      source: 'cloudflare',
      action: 'policy_assign',
      entityId: assigned.entityId,
      resourceId: created.entityId,
      policyVersion: 1,
      productId: 101,
      productUuid: PRODUCT,
      catalogVersion: 2,
      updated: true
    })
    const added = await handle(request(JSON.stringify(exception()), { 'idempotency-key': 'add-exception' }, EXCEPTIONS))
    expect(added.status).toBe(200)
    const exceptionReceipt = catalogPolicyReceiptSchema.parse(await added.json())
    expect(exceptionReceipt).toEqual({
      source: 'cloudflare',
      action: 'exception_create',
      entityId: exceptionReceipt.entityId,
      resourceId: VARIANT,
      policyVersion: 1,
      productId: 101,
      productUuid: PRODUCT,
      catalogVersion: 3,
      updated: true
    })
    const withdrew = await handle(
      request(
        JSON.stringify({ expectedVersion: version(), reason: REASON }),
        { 'idempotency-key': 'withdraw-exception' },
        `${EXCEPTIONS}/${exceptionReceipt.entityId}/withdraw`
      )
    )
    expect(withdrew.status).toBe(200)
    const withdrawal = catalogPolicyReceiptSchema.parse(await withdrew.json())
    expect(withdrawal).toEqual({
      source: 'cloudflare',
      action: 'exception_withdraw',
      entityId: withdrawal.entityId,
      resourceId: exceptionReceipt.entityId,
      policyVersion: null,
      productId: 101,
      productUuid: PRODUCT,
      catalogVersion: 4,
      updated: true
    })
    const unused = await createPolicy({ code: 'unused_type' }, 'unused-policy')
    const policyWithdrawal = await handle(
      request(
        JSON.stringify({ expectedVersion: 1, reason: REASON }),
        { 'idempotency-key': 'withdraw-policy' },
        `${COLLECTION}/${unused.entityId}/withdraw`
      )
    )
    expect(policyWithdrawal.status).toBe(200)
    const withdrawn = catalogPolicyReceiptSchema.parse(await policyWithdrawal.json())
    expect(withdrawn).toEqual({
      source: 'cloudflare',
      action: 'policy_withdraw',
      entityId: withdrawn.entityId,
      resourceId: unused.entityId,
      policyVersion: 1,
      productId: null,
      productUuid: null,
      catalogVersion: null,
      updated: true
    })
    expect(version()).toBe(4)
    expect(state().product).toMatchObject({ slug: 'synthetic-policy-product', attributes: before.product!.attributes })
    expect(state().variant).toEqual(before.variant)
  })

  it('returns only the privileged policy list/product projections, with filtering and pagination', async () => {
    const created = await createPolicy()
    await assignPolicy(created.entityId)
    const response = await handle(read(`${COLLECTION}?page=1&perPage=1&code=synthetic_type`))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      source: 'cloudflare',
      capabilities: { publicationPoliciesRead: true, publicationPoliciesWrite: true },
      items: [{ id: created.entityId, code: 'synthetic_type', version: 1 }],
      pagination: { page: 1, perPage: 1, total: 1, pages: 1 }
    })
    const product = await handle(read(PRODUCT_PATH))
    expect(product.status).toBe(200)
    const value: unknown = await product.json()
    expect(value).toMatchObject({
      source: 'cloudflare',
      productId: 101,
      productUuid: PRODUCT,
      catalogVersion: 2,
      status: 'draft',
      policy: { id: created.entityId },
      regulatory: { productType: 'synthetic_type', requiresSds: false },
      variants: [{ id: VARIANT }],
      capabilities: {
        productPublicationPolicyRead: true,
        productPublicationPolicyWrite: true,
        productIdentifierExceptionsWrite: true
      }
    })
    const serialized = JSON.stringify(value)
    for (const privateValue of [
      IDENTITY,
      SESSION,
      'policy-http@example.invalid',
      'unusable-synthetic-hash',
      'protectedExtra'
    ])
      expect(serialized).not.toContain(privateValue)
  })

  it('allows same-origin SSR reads without Origin and never consumes quota or bodies on GET', async () => {
    const candidate = read()
    candidate.headers.delete('origin')
    const result = await handle(candidate)
    expect(result.status).toBe(200)
    expect(candidate.bodyUsed).toBe(false)
    expect(sqlite.prepare('SELECT count(*) AS n FROM identity_rate_limits').get()!.n).toBe(0)
    untouched()
  })

  it('replays the original policy receipt after a later version, without rebuilding it from current state', async () => {
    const first = await handle(request())
    expect(first.status).toBe(200)
    const bytes = await first.text()
    await createPolicy({ expectedVersion: 1, name: 'Segunda versión sintética' }, 'later-policy-version')
    const after = state()
    const replay = await handle(request())
    expect(replay.status).toBe(200)
    expect(await replay.text()).toBe(bytes)
    expect(state()).toEqual(after)
  })

  it('does not disclose or replay completed policy commands after live publisher revocation', async () => {
    expect((await handle(request())).status).toBe(200)
    assignRole('policy_writer')
    for (const candidate of [request(), read(), read(PRODUCT_PATH)]) {
      const response = await handle(candidate)
      expect(response.status).toBe(403)
      expect(await response.json()).toEqual({ error: { code: 'forbidden' } })
      expect(candidate.bodyUsed).toBe(false)
    }
    expect(sqlite.prepare('SELECT count(*) AS n FROM catalog_policy_audit').get()!.n).toBe(1)
  })

  it.each(['policy_writer', 'policy_customer'] as const)(
    'never treats %s as policy read/write authority',
    async (role) => {
      assignRole(role)
      for (const candidate of [request(), read(), read(PRODUCT_PATH)]) {
        expect((await handle(candidate)).status).toBe(403)
        expect(candidate.bodyUsed).toBe(false)
      }
      untouched()
    }
  )

  it.each([
    ['UPDATE auth_sessions SET mfa_verified=0', 403, 'mfa_required'],
    ['UPDATE identities SET email_verified_at=NULL', 403, 'email_unverified'],
    ['DELETE FROM identity_roles', 403, 'forbidden'],
    ["UPDATE auth_sessions SET revoked_at='2020-01-01T00:00:00Z'", 401, 'unauthenticated'],
    ['UPDATE identities SET session_version=2', 401, 'unauthenticated'],
    ["UPDATE auth_sessions SET expires_at=strftime('%Y-%m-%dT%H:%M:%SZ','now','-1 second')", 401, 'unauthenticated']
  ])('checks persisted authority for reads and writes before bodies: %s', async (sql, status, code) => {
    sqlite.exec(String(sql))
    for (const candidate of [request(), read(), read(PRODUCT_PATH)]) {
      const result = await handle(candidate)
      expect(result.status).toBe(status)
      expect(await result.json()).toEqual({ error: { code } })
      expect(candidate.bodyUsed).toBe(false)
    }
    untouched()
  })

  it.each(['', 'neteco-session=forged-synthetic-cookie'])(
    'rejects unauthenticated cookies before SQL/body: %s',
    async (header) => {
      const prepare = failingPrepare()
      const candidate = request(undefined, { cookie: header })
      expect((await handle(candidate)).status).toBe(401)
      expect(prepare).not.toHaveBeenCalled()
      expect(candidate.bodyUsed).toBe(false)
      untouched()
    }
  )

  it.each(['', 'https://evil.invalid', `${ORIGIN}/`, 'null'])(
    'rejects nonexact write Origin %s before cookie/SQL/body',
    async (origin) => {
      const prepare = failingPrepare()
      const candidate = request(undefined, { origin })
      expect((await handle(candidate)).status).toBe(403)
      expect(prepare).not.toHaveBeenCalled()
      expect(candidate.bodyUsed).toBe(false)
      untouched()
    }
  )

  it('rejects missing write Origin and cross-site read/write metadata, ignoring Host and forwarded authority', async () => {
    const prepare = failingPrepare()
    const absent = request()
    absent.headers.delete('origin')
    const candidates = [
      absent,
      request(undefined, {
        'sec-fetch-site': 'cross-site',
        host: 'neteco.invalid',
        'x-forwarded-host': 'neteco.invalid'
      }),
      request(null, { 'sec-fetch-site': 'cross-site' }, COLLECTION, 'GET'),
      request(null, { origin: 'https://evil.invalid' }, PRODUCT_PATH, 'GET')
    ]
    for (const candidate of candidates) {
      expect((await handle(candidate)).status).toBe(403)
      expect(candidate.bodyUsed).toBe(false)
    }
    expect(prepare).not.toHaveBeenCalled()
  })

  it('fails invalid trusted configuration and disabled auth closed without reading SQL/body', async () => {
    const prepare = failingPrepare()
    for (const overrides of [
      { AUTH_ORIGIN: `${ORIGIN}/private` },
      { AUTH_ENABLED: 'false' },
      { NUXT_SESSION_PASSWORD: 'short' }
    ]) {
      const candidate = request()
      const response = await handle(candidate, overrides)
      expect(response.status).toBe(503)
      expect(await response.json()).toEqual({ error: { code: 'service_unavailable' } })
      expect(candidate.bodyUsed).toBe(false)
    }
    expect(prepare).not.toHaveBeenCalled()
  })

  it.each(['0', '-1', '01', '1.0', '1e2', '+101', 'p-1', '%31%30%31', '101%20', '9007199254740992'])(
    'rejects noncanonical product target %s before SQL/body',
    async (id) => {
      const prepare = failingPrepare()
      for (const suffix of [
        'publication-policy',
        'identifier-exceptions',
        `identifier-exceptions/${UNKNOWN}/withdraw`
      ]) {
        const candidate = request(
          undefined,
          {},
          `/api/admin/products/${id}/${suffix}`,
          suffix === 'publication-policy' ? 'PUT' : 'POST'
        )
        expect((await handle(candidate)).status).toBe(400)
        expect(candidate.bodyUsed).toBe(false)
      }
      expect(prepare).not.toHaveBeenCalled()
    }
  )

  it.each(['not-a-uuid', UNKNOWN.toUpperCase(), `${UNKNOWN}%20`, UNKNOWN.replace(/-/g, ''), `${UNKNOWN}%0A`])(
    'rejects noncanonical resource UUID %s',
    async (id) => {
      const prepare = failingPrepare()
      for (const path of [`${COLLECTION}/${id}/withdraw`, `${EXCEPTIONS}/${id}/withdraw`]) {
        expect((await handle(request(undefined, {}, path))).status).toBe(400)
      }
      expect(prepare).not.toHaveBeenCalled()
    }
  )

  it.each([
    `${COLLECTION}/`,
    `${COLLECTION}/unexpected`,
    `${COLLECTION}%2F${UNKNOWN}%2Fwithdraw`,
    '/api/admin/catalog%2Fpolicies',
    '/api/admin/products/101/publication%2Dpolicy',
    '/api/admin/products/101/publication-policy/',
    '/api/admin/products//publication-policy',
    '/api/admin/products//identifier-exceptions',
    '/api/admin/products/101/identifier-exceptions%2Fbad%2Fwithdraw',
    '/api/admin/products/101/identifier-exceptions/bad/withdraw/extra'
  ])('reserves malformed/encoded owned namespace instead of falling through: %s', async (path) => {
    const prepare = failingPrepare()
    const candidate = request(undefined, {}, path)
    expect((await handle(candidate)).status).toBe(400)
    expect(prepare).not.toHaveBeenCalled()
    expect(candidate.bodyUsed).toBe(false)
  })

  it.each([
    '/api/admin/products',
    '/api/admin/products/101',
    '/api/admin/products/101/status',
    '/api/admin/products/101/publication-readiness',
    '/api/admin/media',
    '/api/admin/catalog/policies-extra',
    '/catalogo'
  ])('returns null only for unowned route %s', async (path) => {
    const prepare = failingPrepare()
    expect(await handleCatalogPolicyHttp(request(undefined, {}, path), env)).toBeNull()
    expect(prepare).not.toHaveBeenCalled()
  })

  it.each([
    [COLLECTION, 'PUT', 'GET, POST'],
    [COLLECTION, 'DELETE', 'GET, POST'],
    [COLLECTION, 'OPTIONS', 'GET, POST'],
    [PRODUCT_PATH, 'POST', 'GET, PUT'],
    [PRODUCT_PATH, 'HEAD', 'GET, PUT'],
    [EXCEPTIONS, 'GET', 'POST'],
    [`${COLLECTION}/${UNKNOWN}/withdraw`, 'DELETE', 'POST'],
    [`${EXCEPTIONS}/${UNKNOWN}/withdraw`, 'PATCH', 'POST']
  ])('returns a fixed allowed-method contract for %s %s', async (path, method, allow) => {
    const prepare = failingPrepare()
    const response = await handle(request(null, {}, path, method))
    expect(response.status).toBe(405)
    expect(response.headers.get('allow')).toBe(allow)
    expect(prepare).not.toHaveBeenCalled()
  })

  it.each(['?now=2099-01-01T00:00:00Z', '?code=synthetic_type', '?x=1&x=2', '?page=1'])(
    'rejects any mutation query before SQL/body: %s',
    async (query) => {
      const prepare = failingPrepare()
      const candidate = request(undefined, {}, `${COLLECTION}${query}`)
      expect((await handle(candidate)).status).toBe(400)
      expect(prepare).not.toHaveBeenCalled()
      expect(candidate.bodyUsed).toBe(false)
    }
  )

  it.each([
    'page=0',
    'page=01',
    'page=1.0',
    'page=1000001',
    'perPage=0',
    'perPage=51',
    'perPage=01',
    'page=1&page=1',
    'code=synthetic_type&code=synthetic_type',
    'code=',
    'code=UPPER',
    'code=bad%2Ftype',
    'code=synthetic_type%0A',
    'now=2099-01-01T00:00:00Z',
    'action=policy_create'
  ])('validates the unique canonical list query %s before SQL', async (query) => {
    const prepare = failingPrepare()
    expect((await handle(read(`${COLLECTION}?${query}`))).status).toBe(400)
    expect(prepare).not.toHaveBeenCalled()
  })

  it('rejects any product-view query, including a caller-controlled read clock', async () => {
    const prepare = failingPrepare()
    expect((await handle(read(`${PRODUCT_PATH}?now=2099-01-01T00:00:00Z`))).status).toBe(400)
    expect(prepare).not.toHaveBeenCalled()
  })

  it.each(['', ' ', 'a'.repeat(201), 'bad/key', 'bad,key', 'bad\tkey'])(
    'requires a visible canonical bounded idempotency key before streaming: %s',
    async (key) => {
      const candidate = request(undefined, { 'idempotency-key': key })
      const response = await handle(candidate)
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({ error: { code: 'invalid_idempotency_key' } })
      expect(candidate.bodyUsed).toBe(false)
      untouched()
    }
  )

  it.each([
    'action',
    'target',
    'actorId',
    'now',
    'catalogVersion',
    'source',
    'fingerprint',
    '__proto__',
    'constructor',
    'prototype'
  ])('rejects unknown/prototype keys in JSON without side effects: %s', async (field) => {
    const response = await handle(request(JSON.stringify(policy({ [field]: PRIVATE }))))
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: { code: 'invalid_input' } })
    untouched()
  })

  it.each([
    { code: 'UPPER' },
    { code: 'synthetic_type\n' },
    { name: 'ab' },
    { name: 'abc\u0000' },
    { expectedVersion: '0' },
    { expectedVersion: -1 },
    { expectedVersion: Number.MAX_SAFE_INTEGER },
    { identifierExceptionsAllowed: 'true' },
    { requiredFields: ['not_supported'] },
    { requiredFields: ['usage', 'usage'] },
    { requiredMediaRoles: ['image'] },
    { requiredMediaRoles: ['sds', 'sds'] },
    { validFrom: '2020-01-01T00:00:00.000Z' },
    { validFrom: '2020-02-31T00:00:00Z' },
    { validUntil: PAST },
    { reason: 'too short' },
    { reason: `${REASON}\n` }
  ])('rejects malformed policy input rather than coercing it: %j', async (extra) => {
    const result = await handle(request(JSON.stringify(policy(extra))))
    expect(result.status).toBe(400)
    expect(await result.json()).toEqual({ error: { code: 'invalid_input' } })
    untouched()
  })

  it.each(['null', '[]', 'true', '42', '"text"'])('does not accept a non-record JSON command %s', async (body) => {
    expect((await handle(request(body))).status).toBe(400)
    untouched()
  })

  it('rejects unknown/nested/prototype regulatory fields and nonexplicit SDS applicability as a whole', async () => {
    const created = await createPolicy()
    const unchanged = state()
    for (const regulatory of [
      { productType: 'synthetic_type' },
      { productType: 'synthetic_type', requiresSds: 'false' },
      { productType: 'synthetic_type', requiresSds: false, unknown: PRIVATE },
      JSON.parse('{"productType":"synthetic_type","requiresSds":false,"__proto__":{"polluted":true}}'),
      { productType: 'synthetic_type', requiresSds: false, manufacturer: false }
    ]) {
      const result = await handle(
        request(
          JSON.stringify(assignment(created.entityId, { regulatory })),
          { 'idempotency-key': 'invalid-assignment' },
          PRODUCT_PATH,
          'PUT'
        )
      )
      expect(result.status).toBe(400)
      expect(await result.json()).toEqual({ error: { code: 'invalid_input' } })
      expect(state()).toEqual(unchanged)
    }
  })

  it.each(['', 'text/plain', 'application/json; charset=latin1'])(
    'requires JSON UTF-8 media type %s before reading',
    async (type) => {
      const candidate = request(undefined, { 'content-type': type })
      expect((await handle(candidate)).status).toBe(415)
      expect(candidate.bodyUsed).toBe(false)
      untouched()
    }
  )

  it('rejects missing body, malformed JSON and invalid UTF-8 without storing commands', async () => {
    expect((await handle(request(null))).status).toBe(400)
    expect((await handle(request(''))).status).toBe(400)
    const malformed = await handle(request('{'))
    expect(await malformed.json()).toEqual({ error: { code: 'invalid_json' } })
    const invalid = await handle(request(new Uint8Array([0x7b, 0x22, 0xc3, 0x28, 0x22, 0x3a, 0x31, 0x7d])))
    expect(invalid.status).toBe(400)
    expect(await invalid.json()).toEqual({ error: { code: 'invalid_json' } })
    untouched()
  })

  it.each(['65537', '-1', '1e5', 'not-a-number'])(
    'rejects oversized/invalid declared bytes %s before streaming',
    async (length) => {
      const candidate = request(undefined, { 'content-length': length })
      expect((await handle(candidate)).status).toBe(413)
      expect(candidate.bodyUsed).toBe(false)
      untouched()
    }
  )

  it('limits actual UTF-8 bytes, cancels oversize and ignores a smaller Content-Length', async () => {
    const bytes = new TextEncoder().encode(JSON.stringify(policy({ reason: '🧴'.repeat(17_000) })))
    let cancelled = false
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes)
      },
      cancel() {
        cancelled = true
      }
    })
    const result = await handle(request(stream, { 'content-length': '1' }))
    expect(result.status).toBe(413)
    expect(cancelled).toBe(true)
    untouched()
  })

  it('enforces the separate durable admin-catalog-policy quota before consuming a command', async () => {
    const now = Math.floor(testNow() / 1000)
    sqlite
      .prepare(
        `INSERT INTO identity_rate_limits(identity_id,scope,used,window_started_at,expires_at)
      VALUES (?,'admin-catalog-policy',60,?,?)`
      )
      .run(IDENTITY, now, now + 3600)
    const candidate = request()
    const result = await handle(candidate)
    expect(result.status).toBe(429)
    expect(result.headers.get('x-ratelimit-limit')).toBe('60')
    expect(result.headers.get('x-ratelimit-remaining')).toBe('0')
    expect(result.headers.get('retry-after')).not.toBeNull()
    expect(candidate.bodyUsed).toBe(false)
    untouched()
  })

  it('maps durable quota outage to a private sanitized 503 before body', async () => {
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
    untouched()
  })

  it.each([
    ['DELETE FROM identity_roles', 403, 'forbidden'],
    ["UPDATE auth_sessions SET expires_at=strftime('%Y-%m-%dT%H:%M:%SZ','now','-1 second')", 401, 'unauthenticated']
  ])('reauthorizes when authority expires/revokes during body streaming: %s', async (sql, status, code) => {
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          sqlite.exec(String(sql))
          controller.enqueue(new TextEncoder().encode(JSON.stringify(policy())))
          controller.close()
        }
      },
      { highWaterMark: 0 }
    )
    const result = await handle(request(stream))
    expect(result.status).toBe(status)
    expect(await result.json()).toEqual({ error: { code } })
    expect(
      sqlite.prepare('SELECT used FROM identity_rate_limits WHERE scope=?').get('admin-catalog-policy')
    ).toMatchObject({ used: 1 })
    untouched()
  })

  it('returns business version/idempotency conflicts without raw input or provider messages', async () => {
    expect((await handle(request())).status).toBe(200)
    const after = state()
    const reused = await handle(request(JSON.stringify(policy({ name: 'Otra política sintética' }))))
    expect(reused.status).toBe(409)
    expect(await reused.json()).toEqual({ error: { code: 'idempotency_conflict' } })
    const stale = await handle(request(JSON.stringify(policy()), { 'idempotency-key': 'stale-policy' }))
    expect(stale.status).toBe(409)
    expect(await stale.json()).toEqual({ error: { code: 'version_conflict' } })
    expect(state()).toEqual(after)
  })

  it('returns a single immutable receipt for concurrent identical commands', async () => {
    const serial = serializedDatabase()
    const replies = await Promise.all([handle(request(), { DB: serial }), handle(request(), { DB: serial })])
    expect(replies.map((response) => response.status)).toEqual([200, 200])
    expect(await replies[0]!.text()).toBe(await replies[1]!.text())
    expect(sqlite.prepare('SELECT count(*) AS n FROM catalog_policy_commands').get()!.n).toBe(1)
    expect(sqlite.prepare('SELECT count(*) AS n FROM catalog_policy_audit').get()!.n).toBe(1)
  })

  it('reports unknown canonical resources/products as sanitized not_found', async () => {
    for (const candidate of [
      read('/api/admin/products/999/publication-policy'),
      request(JSON.stringify({ expectedVersion: 1, reason: REASON }), {}, `${COLLECTION}/${UNKNOWN}/withdraw`)
    ]) {
      const result = await handle(candidate)
      expect(result.status).toBe(404)
      expect(await result.json()).toEqual({ error: { code: 'not_found' } })
    }
    untouched()
  })

  it('maps database read/write outages to generic 503 rather than a business conflict', async () => {
    const prepare = failingPrepare()
    for (const candidate of [request(), read(), read(PRODUCT_PATH)]) {
      const result = await handle(candidate)
      expect(result.status).toBe(503)
      expect(await result.json()).toEqual({ error: { code: 'service_unavailable' } })
      expect(candidate.bodyUsed).toBe(false)
    }
    expect(prepare).toHaveBeenCalled()
    untouched()
  })

  it('does not classify a provider outage mentioning a table as a SQLite business constraint', async () => {
    vi.spyOn(database, 'batch').mockRejectedValueOnce(
      new Error(`catalog_policy_commands provider unavailable: ${PRIVATE}`)
    )
    const result = await handle(request())
    expect(result.status).toBe(503)
    expect(await result.json()).toEqual({ error: { code: 'service_unavailable' } })
    untouched()
  })

  it.each([
    [COLLECTION, 'DELETE FROM identity_roles', 403, 'forbidden'],
    [PRODUCT_PATH, 'DELETE FROM identity_roles', 403, 'forbidden'],
    [
      COLLECTION,
      "UPDATE auth_sessions SET expires_at=strftime('%Y-%m-%dT%H:%M:%SZ','now','-1 second')",
      401,
      'unauthenticated'
    ],
    [
      PRODUCT_PATH,
      "UPDATE auth_sessions SET expires_at=strftime('%Y-%m-%dT%H:%M:%SZ','now','-1 second')",
      401,
      'unauthenticated'
    ],
    [
      COLLECTION,
      "UPDATE identity_roles SET expires_at=strftime('%Y-%m-%dT%H:%M:%SZ','now','-1 second')",
      403,
      'forbidden'
    ],
    [
      PRODUCT_PATH,
      "UPDATE identity_roles SET expires_at=strftime('%Y-%m-%dT%H:%M:%SZ','now','-1 second')",
      403,
      'forbidden'
    ]
  ])('denies a %s read after authority changes while reading D1: %s', async (path, sql, status, code) => {
    const original = database.batch.bind(database)
    async function batch<T>(statements: D1PreparedStatement[]) {
      const result = await original<T>(statements)
      sqlite.exec(String(sql))
      return result
    }
    const duringRead = new Proxy(database, {
      get(target, key, receiver) {
        return key === 'batch' ? batch : Reflect.get(target, key, receiver)
      }
    })
    const result = await handle(read(path), { DB: duringRead })
    expect(result.status).toBe(status)
    expect(await result.json()).toEqual({ error: { code } })
    untouched()
  })

  it('preserves product data on unavailable policy, product version and noneditable status conflicts', async () => {
    const created = await createPolicy()
    const unavailable = await createPolicy({ code: 'future_type', validFrom: '2099-01-01T00:00:00Z' }, 'future-policy')
    const denied = await handle(
      request(
        JSON.stringify(
          assignment(unavailable.entityId, {
            regulatory: { productType: 'future_type', requiresSds: false }
          })
        ),
        { 'idempotency-key': 'future-assignment' },
        PRODUCT_PATH,
        'PUT'
      )
    )
    expect(denied.status).toBe(409)
    expect(await denied.json()).toEqual({ error: { code: 'policy_unavailable' } })
    const stale = await handle(
      request(
        JSON.stringify(assignment(created.entityId, { expectedVersion: version() + 1 })),
        { 'idempotency-key': 'stale-assignment' },
        PRODUCT_PATH,
        'PUT'
      )
    )
    expect(stale.status).toBe(409)
    expect(await stale.json()).toEqual({ error: { code: 'version_conflict' } })
    expect(state().product).toEqual(before.product)
    sqlite.prepare("UPDATE products SET status='published' WHERE id=?").run(PRODUCT)
    const published = state()
    const invalid = await handle(
      request(
        JSON.stringify(assignment(created.entityId)),
        { 'idempotency-key': 'published-assignment' },
        PRODUCT_PATH,
        'PUT'
      )
    )
    expect(invalid.status).toBe(409)
    expect(await invalid.json()).toEqual({ error: { code: 'invalid_state' } })
    expect(state()).toEqual(published)
  })

  it('does not withdraw the policy currently assigned to a published product', async () => {
    const created = await createPolicy()
    await assignPolicy(created.entityId)
    sqlite.prepare("UPDATE products SET status='published' WHERE id=?").run(PRODUCT)
    const published = state()
    const result = await handle(
      request(
        JSON.stringify({ expectedVersion: 1, reason: REASON }),
        { 'idempotency-key': 'published-policy-withdrawal' },
        `${COLLECTION}/${created.entityId}/withdraw`
      )
    )
    expect(result.status).toBe(409)
    expect(await result.json()).toEqual({ error: { code: 'policy_in_use' } })
    expect(state()).toEqual(published)
  })

  it('requires explicit assigned exception permission instead of inferring approval from an exception request', async () => {
    const result = await handle(
      request(JSON.stringify(exception()), { 'idempotency-key': 'unassigned-exception' }, EXCEPTIONS)
    )
    expect(result.status).toBe(409)
    expect(await result.json()).toEqual({ error: { code: 'policy_unavailable' } })
    untouched()
  })

  it('fails corrupted stored policy rules with a sanitized 503, never a false domain success', async () => {
    sqlite
      .prepare(
        `INSERT INTO catalog_publication_policies(id,code,version,name,required_fields,required_media_roles,
      identifier_exceptions_allowed,actor_id,reason,valid_from,created_at)
      VALUES (?,'corrupt_type',1,'Corrupt synthetic policy','["not_supported"]','[]',0,?,?,?,?)`
      )
      .run(UNKNOWN, IDENTITY, REASON, PAST, utc(testNow() - 60_000))
    const result = await handle(read())
    expect(result.status).toBe(503)
    expect(await result.json()).toEqual({ error: { code: 'service_unavailable' } })
  })

  it('ignores caller clock headers and leaves mutation execution time on the server', async () => {
    const result = await handle(
      request(undefined, { 'x-now': '2099-01-01T00:00:00Z', 'x-execution-clock': '1900-01-01T00:00:00Z' })
    )
    expect(result.status).toBe(200)
    expect(sqlite.prepare('SELECT created_at FROM catalog_policy_commands').get()!.created_at).not.toBe(
      '2099-01-01T00:00:00Z'
    )
    expect(sqlite.prepare('SELECT created_at FROM catalog_policy_commands').get()!.created_at).not.toBe(
      '1900-01-01T00:00:00Z'
    )
  })

  it('preserves private security headers and never emits CORS across all outcomes', async () => {
    const results = [
      await handle(request(undefined, { origin: 'https://evil.invalid' })),
      await handle(request(JSON.stringify(policy({ reason: 'invalid' })))),
      await handle(request())
    ]
    failingPrepare()
    results.push(await handle(read()))
    expect(results.map((result) => result.status)).toEqual([403, 400, 200, 503])
    for (const result of results) {
      expect(result.headers.get('cache-control')).toBe('private, no-store')
      expect(result.headers.get('pragma')).toBe('no-cache')
      expect(result.headers.get('vary')).toBe('Cookie')
      expect(result.headers.get('x-content-type-options')).toBe('nosniff')
      expect(result.headers.get('x-robots-tag')).toContain('noindex')
      expect(result.headers.get('referrer-policy')).toBe('no-referrer')
      expect(result.headers.get('access-control-allow-origin')).toBeNull()
    }
  })
})

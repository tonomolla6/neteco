import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { catalogDraftAuthoringReceiptSchema } from '../../shared/catalog-draft-authoring'
import {
  catalogDraftAuthoringOptionsSchema,
  catalogDraftAuthoringSnapshotSchema
} from '../../shared/catalog-draft-authoring-options'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import {
  handleCatalogDraftAuthoringHttp,
  type CatalogDraftAuthoringHttpEnvironment
} from '../../workers/catalog/admin-catalog-authoring-http'
import { readD1CatalogDraftAuthoringOptions } from '../../workers/catalog/admin-catalog-references'
import { readD1AdminProduct } from '../../workers/catalog/admin-catalog'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'

const ORIGIN = 'https://draft-authoring.neteco.invalid'
const IDENTITY = '10000000-0000-4000-8000-000000000038'
const SESSION = '20000000-0000-4000-8000-000000000038'
const CATEGORY = '30000000-0000-4000-8000-000000000038'
const BRAND = '40000000-0000-4000-8000-000000000038'
const TAX = '50000000-0000-4000-8000-000000000038'
const SHIPPING = '60000000-0000-4000-8000-000000000038'
const CLAIMS = { identityId: IDENTITY, sessionId: SESSION, sessionVersion: 1 }
const PASSWORD = 'synthetic-draft-http-cookie-password-with-32-characters'
const PRIVATE = 'SQL private_provider_token owner@example.invalid'
const utc = (offset = 0) => new Date(Date.now() + offset).toISOString().replace(/\.\d{3}Z$/, 'Z')
function variant(sku = 'SYNTHETIC-DRAFT-ONE') {
  return {
    sku,
    format: 'Botella 1 L',
    ean: null,
    gtin: null,
    mpn: null,
    taxClassId: TAX,
    shippingProfileId: SHIPPING,
    unitBase: 'L',
    unitLabel: 'litro',
    contentQuantity: 1,
    unitsPerCase: 6,
    casesPerPallet: null,
    minimumQuantity: 1,
    quantityIncrement: 1,
    maximumQuantity: null,
    weightGrams: 1100,
    widthMm: 100,
    heightMm: 200,
    depthMm: 100,
    backorderAllowed: false,
    leadTimeDays: null,
    color: null
  }
}
function draft() {
  return {
    expectedVersion: 0,
    reason: 'Synthetic local-only authoring decision',
    name: 'Synthetic draft product',
    categoryId: 10,
    brandId: BRAND,
    shortDesc: 'Synthetic local draft description',
    description: 'Synthetic draft without publication or price approval.',
    usage: null,
    series: null,
    featured: false,
    badges: [],
    visual: { type: 'botella', color: '#00aa00' },
    attrs: [],
    initialVariant: variant()
  }
}

describe('draft authoring private HTTP and bounded reference reads', () => {
  let sqlite: DatabaseSync
  let database: D1Database
  let env: CatalogDraftAuthoringHttpEnvironment
  let cookie: string
  beforeEach(async () => {
    sqlite = await openMigratedDatabase()
    sqlite.limits.exprDepth = 100
    sqlite.limits.variableNumber = 100
    database = d1OverSqlite(sqlite)
    sqlite
      .prepare(
        "INSERT INTO categories(id,legacy_id,name,slug,status) VALUES (?,10,'Draft category','draft-category','draft')"
      )
      .run(CATEGORY)
    sqlite.prepare("INSERT INTO brands(id,name,slug,status) VALUES (?,'Draft brand','draft-brand','draft')").run(BRAND)
    sqlite
      .prepare(
        "INSERT INTO tax_classes(id,code,name,rate_basis_points,valid_from) VALUES (?,'DRAFT-ZERO','Zero valid tax',0,'2020-01-01T00:00:00Z')"
      )
      .run(TAX)
    sqlite
      .prepare("INSERT INTO shipping_profiles(id,code,name,kind) VALUES (?,'DRAFT-SHIP','Draft shipping','parcel')")
      .run(SHIPPING)
    sqlite
      .prepare(
        "INSERT INTO inventory_locations(id,code,name,kind,active,created_at) VALUES ('draft-warehouse','DRAFT-WH','Only warehouse','warehouse',1,?)"
      )
      .run(utc(-86400_000))
    const past = utc(-86400_000)
    sqlite
      .prepare(
        "INSERT INTO identities(id,email,password_hash,email_verified_at,status,created_at,updated_at) VALUES (?,'draft-http@example.invalid','synthetic-unusable-hash',?,'active',?,?)"
      )
      .run(IDENTITY, past, past, past)
    sqlite.exec(
      "INSERT INTO roles VALUES ('draft_author','Draft author','Synthetic fixture'); INSERT INTO permissions VALUES ('catalog.write','catalog','write','Draft write'); INSERT INTO role_permissions VALUES ('draft_author','catalog.write');"
    )
    sqlite
      .prepare("INSERT INTO identity_roles(identity_id,role_code,granted_at) VALUES (?,'draft_author',?)")
      .run(IDENTITY, past)
    sqlite
      .prepare(
        'INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at) VALUES (?,?,1,1,?,?)'
      )
      .run(SESSION, IDENTITY, past, utc(3600_000))
    env = { DB: database, AUTH_ENABLED: 'true', AUTH_ORIGIN: ORIGIN, NUXT_SESSION_PASSWORD: PASSWORD }
    cookie = (await issueD1SessionCookie(database, CLAIMS, { password: PASSWORD, maxAgeSeconds: 3600 }))!.split(';')[0]!
  })
  afterEach(() => {
    sqlite.close()
    vi.restoreAllMocks()
  })
  function request(
    path = '/api/admin/products',
    method = 'POST',
    body: BodyInit | null = JSON.stringify(draft()),
    headers: Record<string, string> = {}
  ) {
    const init: RequestInit = {
      method,
      body,
      headers: {
        cookie,
        origin: ORIGIN,
        'content-type': 'application/json',
        'idempotency-key': 'draft-http-create',
        ...headers
      }
    }
    if (body instanceof ReadableStream) Object.assign(init, { duplex: 'half' })
    return new Request(`${ORIGIN}${path}`, init)
  }
  async function handle(candidate: Request, overrides: Partial<CatalogDraftAuthoringHttpEnvironment> = {}) {
    const response = await handleCatalogDraftAuthoringHttp(candidate, { ...env, ...overrides })
    expect(response).not.toBeNull()
    expect(response!.headers.get('cache-control')).toBe('private, no-store')
    expect(response!.headers.get('vary')).toBe('Cookie')
    expect(response!.headers.get('x-robots-tag')).toBe('noindex, nofollow, noarchive')
    return response!
  }
  function state() {
    return [
      'products',
      'variants',
      'inventory_balances',
      'inventory_movements',
      'variant_price_versions',
      'catalog_draft_authoring_commands',
      'catalog_draft_authoring_audit',
      'catalog_draft_legacy_counters'
    ].map((table) => sqlite.prepare(`SELECT * FROM ${table}`).all())
  }
  async function create() {
    const response = await handle(request())
    expect(response.status).toBe(201)
    return catalogDraftAuthoringReceiptSchema.parse(await response.json())
  }
  it('serves explicit current references and creates one isolated draft with a historical replay', async () => {
    const options = await handle(request('/api/admin/products/authoring-options', 'GET', null))
    expect(options.status).toBe(200)
    const view = catalogDraftAuthoringOptionsSchema.parse(await options.json())
    expect(view.categories).toEqual([{ id: 10, name: 'Draft category', parentId: null, status: 'draft' }])
    expect(view.taxClasses[0]?.rateBasisPoints).toBe(0)
    const receipt = await create(),
      before = state()
    expect(receipt.catalogVersion).toBe(1)
    expect(sqlite.prepare('SELECT price_gross_cents,status FROM variants').get()).toEqual({
      price_gross_cents: 0,
      status: 'draft'
    })
    expect(sqlite.prepare('SELECT physical_quantity,blocked_quantity FROM inventory_balances').get()).toEqual({
      physical_quantity: 0,
      blocked_quantity: 0
    })
    expect(sqlite.prepare('SELECT count(*) AS n FROM variant_price_versions').get()?.n).toBe(0)
    expect(sqlite.prepare('SELECT count(*) AS n FROM inventory_movements').get()?.n).toBe(0)
    expect(await (await handle(request())).json()).toEqual(receipt)
    expect(state()).toEqual(before)
    const detail = await readD1AdminProduct(database, CLAIMS, utc(), String(receipt.productId))
    expect(detail.outcome).toBe('found')
    if (detail.outcome !== 'found') throw new Error('Missing synthetic draft')
    expect(catalogDraftAuthoringSnapshotSchema.parse(detail.data.authoring).brandId).toBe(BRAND)
    expect(detail.data.capabilities.productCreate).toBe(false)
    expect(detail.data.capabilities.variantWrite).toBe(false)
    expect(detail.data.capabilities.productDraftCreate).toBe(true)
  })
  it('dispatches brand and variant commands, and never reinterprets old full-product PUT', async () => {
    const first = await create(),
      base = `/api/admin/products/${first.productId}`
    const second = await handle(
      request(
        `${base}/variants`,
        'POST',
        JSON.stringify({ expectedVersion: 1, reason: 'Synthetic explicit variant', ...variant('SYNTHETIC-SECOND') }),
        { 'idempotency-key': 'draft-http-variant' }
      )
    )
    expect(second.status).toBe(200)
    const added = catalogDraftAuthoringReceiptSchema.parse(await second.json())
    const updated = await handle(
      request(
        `${base}/variants/${added.variantId}`,
        'PUT',
        JSON.stringify({ expectedVersion: 2, reason: 'Synthetic explicit format', format: 'Caja 6 L' }),
        { 'idempotency-key': 'draft-http-update' }
      )
    )
    expect(updated.status).toBe(200)
    const assigned = await handle(
      request(
        `${base}/brand`,
        'PUT',
        JSON.stringify({ expectedVersion: 3, reason: 'Synthetic brand assignment', brandId: BRAND }),
        { 'idempotency-key': 'draft-http-brand' }
      )
    )
    expect(assigned.status).toBe(200)
    const retired = await handle(
      request(
        `${base}/variants/${added.variantId}/discontinue`,
        'POST',
        JSON.stringify({ expectedVersion: 4, reason: 'Synthetic explicit retirement' }),
        { 'idempotency-key': 'draft-http-retire' }
      )
    )
    expect(retired.status).toBe(200)
    expect(sqlite.prepare('SELECT catalog_version FROM products').get()?.catalog_version).toBe(5)
    expect(await handleCatalogDraftAuthoringHttp(request(base, 'PUT'), env)).toBeNull()
    expect(await handleCatalogDraftAuthoringHttp(request('/api/admin/products', 'GET', null), env)).toBeNull()
  })
  it.each([
    ['/api/admin/%70roducts', 'POST', 400],
    ['/api/admin/products%2F', 'POST', 400],
    ['/api/admin/products/', 'POST', 400],
    ['/api/admin/products/01/variants', 'POST', 400],
    ['/api/admin/products/9007199254740992/brand', 'PUT', 400],
    ['/api/admin/products/1/variants/01', 'PUT', 400],
    ['/api/admin/products/1/%76ariants', 'POST', 400],
    ['/api/admin/products/authoring-options?now=2020-01-01', 'GET', 400],
    ['/api/admin/products?price=1', 'POST', 400],
    ['/api/admin/products/authoring-options', 'POST', 405],
    ['/api/admin/products/1/variants', 'DELETE', 405]
  ])('rejects alias/query/method %s %s without catalog effects', async (path, method, status) => {
    const before = state()
    const result = await handle(request(path, method, method === 'GET' ? null : JSON.stringify(draft())))
    expect(result.status).toBe(status)
    expect(state()).toEqual(before)
  })
  it.each([
    'missing_origin',
    'cross_site',
    'wrong_origin',
    'no_cookie',
    'wrong_cookie',
    'unverified',
    'no_mfa',
    'no_grant',
    'disabled'
  ])('rejects %s before authoring', async (scenario) => {
    const before = state(),
      headers: Record<string, string> = {}
    if (scenario === 'cross_site') headers['sec-fetch-site'] = 'cross-site'
    if (scenario === 'wrong_origin') headers.origin = 'https://attacker.invalid'
    if (scenario === 'no_cookie') headers.cookie = ''
    if (scenario === 'wrong_cookie') headers.cookie = 'nuxt-session=invalid'
    if (scenario === 'unverified')
      sqlite.prepare('UPDATE identities SET email_verified_at=NULL WHERE id=?').run(IDENTITY)
    if (scenario === 'no_mfa') sqlite.prepare('UPDATE auth_sessions SET mfa_verified=0 WHERE id=?').run(SESSION)
    if (scenario === 'no_grant') sqlite.exec("DELETE FROM role_permissions WHERE permission_code='catalog.write'")
    const candidate = request('/api/admin/products', 'POST', JSON.stringify(draft()), headers)
    if (scenario === 'missing_origin') candidate.headers.delete('origin')
    const result = await handle(candidate, scenario === 'disabled' ? { AUTH_ENABLED: 'false' } : {})
    expect(result.status).toBe(
      scenario === 'disabled' ? 503 : ['no_cookie', 'wrong_cookie'].includes(scenario) ? 401 : 403
    )
    expect(state()).toEqual(before)
  })
  it('revalidates authority before replay and sanitizes storage failures', async () => {
    await create()
    const before = state()
    sqlite.exec("DELETE FROM role_permissions WHERE permission_code='catalog.write'")
    expect((await handle(request())).status).toBe(403)
    expect(state()).toEqual(before)
    vi.spyOn(database, 'prepare').mockImplementation(() => {
      throw new Error(PRIVATE)
    })
    const failed = await handle(request())
    expect(failed.status).toBe(503)
    expect(await failed.text()).toBe('{"error":{"code":"service_unavailable"}}')
  })
  it.each([
    ['invalid_json', '{', {}, 400],
    ['json_required', JSON.stringify(draft()), { 'content-type': 'text/plain' }, 415],
    ['body_too_large', 'x'.repeat(65537), {}, 413],
    ['body_too_large', JSON.stringify(draft()), { 'content-length': '65537' }, 413],
    ['invalid_idempotency_key', JSON.stringify(draft()), { 'idempotency-key': '../unsafe' }, 400],
    ['invalid_input', JSON.stringify({ ...draft(), price: 1, stock: 100 }), {}, 422]
  ] as Array<[string, string, Record<string, string>, number]>)(
    'bounds and validates %s',
    async (code, body, headers, status) => {
      const before = state(),
        result = await handle(request('/api/admin/products', 'POST', body, headers))
      expect(result.status).toBe(status)
      expect(await result.json()).toEqual({ error: { code } })
      expect(state()).toEqual(before)
    }
  )
  it('classifies payload conflict without accepting changed values', async () => {
    await create()
    const before = state(),
      response = await handle(
        request('/api/admin/products', 'POST', JSON.stringify({ ...draft(), name: 'Different draft name' }))
      )
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: { code: 'idempotency_conflict' } })
    expect(state()).toEqual(before)
  })
  it.each(
    ['categories', 'brands', 'tax_classes', 'shipping_profiles'].flatMap((table) =>
      ['false', 'missing', 'inherited'].map((flag) => [table, flag] as const)
    )
  )('refuses %s provider results with %s success flags', async (table, flag) => {
    const original = database.prepare.bind(database)
    vi.spyOn(database, 'prepare').mockImplementation((sql) => {
      const statement = original(sql)
      if (!new RegExp(`FROM ${table}\\b`).test(sql)) return statement
      const result =
        flag === 'inherited'
          ? (Object.create({ success: true }) as Record<string, unknown>)
          : ({} as Record<string, unknown>)
      result.results = []
      if (flag === 'false') result.success = false
      const wrapped = new Proxy(statement, {
        get(target, key, receiver) {
          if (key === 'bind')
            return (...values: unknown[]) => {
              statement.bind(...values)
              return wrapped
            }
          if (key === 'all') return async <T>() => result as unknown as D1Result<T>
          return Reflect.get(target, key, receiver)
        }
      })
      return wrapped
    })
    const before = state()
    const response = await handle(request('/api/admin/products/authoring-options', 'GET', null))
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: { code: 'service_unavailable' } })
    expect(state()).toEqual(before)
  })
  it('filters retired and expired references without manufacturing defaults', async () => {
    sqlite.exec(
      "UPDATE categories SET status='discontinued'; UPDATE brands SET status='archived'; UPDATE tax_classes SET valid_until='2020-01-02T00:00:00Z'; DELETE FROM shipping_profiles;"
    )
    const result = await readD1CatalogDraftAuthoringOptions(database, CLAIMS)
    expect(result.outcome).toBe('found')
    if (result.outcome !== 'found') throw new Error('Missing synthetic references')
    expect(result.data.categories).toEqual([])
    expect(result.data.brands).toEqual([])
    expect(result.data.taxClasses).toEqual([])
    expect(result.data.shippingProfiles).toEqual([])
    expect(sqlite.prepare('SELECT count(*) AS n FROM products').get()?.n).toBe(0)
  })
  it('refuses corrupted or oversized option snapshots instead of truncating selectable data', async () => {
    const insertion = sqlite.prepare(
      "INSERT INTO shipping_profiles(id,code,name,kind) VALUES (?,?,'Synthetic shipping','parcel')"
    )
    for (let index = 0; index < 500; index += 1) insertion.run(crypto.randomUUID(), `SYNTHETIC-${index}`)
    const response = await handle(request('/api/admin/products/authoring-options', 'GET', null))
    expect(response.status).toBe(503)
    expect(await response.text()).not.toContain(PRIVATE)
  })
})

describe('draft authoring reference DTO guards', () => {
  const valid = () => ({
    source: 'cloudflare',
    capabilities: {
      productDraftCreate: true,
      productDraftBrandUpdate: true,
      variantDraftCreate: true,
      variantDraftUpdate: true,
      variantDraftDiscontinue: true
    },
    categories: [],
    brands: [],
    taxClasses: [],
    shippingProfiles: []
  })
  it('accepts exact own data and null-prototype records', () => {
    expect(catalogDraftAuthoringOptionsSchema.safeParse(valid()).success).toBe(true)
    expect(
      catalogDraftAuthoringOptionsSchema.safeParse(Object.assign(Object.create(null) as object, valid())).success
    ).toBe(true)
  })
  it('does not certify a missing capability inherited from Object.prototype', () => {
    const previous = Object.getOwnPropertyDescriptor(Object.prototype, 'variantDraftUpdate')
    const value = valid(),
      capabilities = { ...value.capabilities } as Record<string, unknown>
    Reflect.deleteProperty(capabilities, 'variantDraftUpdate')
    Object.defineProperty(Object.prototype, 'variantDraftUpdate', { value: true, configurable: true, writable: true })
    try {
      expect(catalogDraftAuthoringOptionsSchema.safeParse({ ...value, capabilities }).success).toBe(false)
    } finally {
      if (previous) Object.defineProperty(Object.prototype, 'variantDraftUpdate', previous)
      else Reflect.deleteProperty(Object.prototype, 'variantDraftUpdate')
    }
  })
  it('requires the same lower-case UUIDs as the authoring command contracts', () => {
    const candidate = {
      ...valid(),
      brands: [{ id: 'ABCDEF00-AAAA-4AAA-8AAA-AAAAAAAA0038', name: 'Synthetic brand', status: 'draft' }]
    }
    expect(catalogDraftAuthoringOptionsSchema.safeParse(candidate).success).toBe(false)
    candidate.brands[0]!.id = candidate.brands[0]!.id.toLowerCase()
    expect(catalogDraftAuthoringOptionsSchema.safeParse(candidate).success).toBe(true)
  })
  it.each(['accessor', 'inherited', 'cycle', 'sparse', 'symbol', 'unexpected', 'bad_source'])(
    'rejects %s without reading accessors',
    (kind) => {
      const value: Record<string, unknown> = valid(),
        spy = vi.fn(() => 'cloudflare')
      if (kind === 'accessor') Object.defineProperty(value, 'source', { get: spy, enumerable: true })
      if (kind === 'inherited') Object.setPrototypeOf(value, { trusted: true })
      if (kind === 'cycle') value.categories = [value]
      if (kind === 'sparse') value.categories = new Array(1)
      if (kind === 'symbol') Object.defineProperty(value, Symbol('private'), { value: 1 })
      if (kind === 'unexpected') value.defaultPrice = 1
      if (kind === 'bad_source') value.source = 'node'
      expect(catalogDraftAuthoringOptionsSchema.safeParse(value).success).toBe(false)
      expect(spy).not.toHaveBeenCalled()
    }
  )
  it('rejects category cycles, duplicate identifiers and impossible timestamps', () => {
    expect(
      catalogDraftAuthoringOptionsSchema.safeParse({
        ...valid(),
        categories: [
          { id: 1, name: 'One', parentId: 2, status: 'draft' },
          { id: 2, name: 'Two', parentId: 1, status: 'draft' }
        ]
      }).success
    ).toBe(false)
    expect(
      catalogDraftAuthoringOptionsSchema.safeParse({
        ...valid(),
        brands: [
          { id: BRAND, name: 'Brand', status: 'draft' },
          { id: BRAND, name: 'Duplicate', status: 'review' }
        ]
      }).success
    ).toBe(false)
    expect(
      catalogDraftAuthoringOptionsSchema.safeParse({
        ...valid(),
        taxClasses: [
          {
            id: TAX,
            code: 'ZERO',
            name: 'Tax',
            rateBasisPoints: 0,
            validFrom: '2026-13-45T99:99:99Z',
            validUntil: null
          }
        ]
      }).success
    ).toBe(false)
  })
})

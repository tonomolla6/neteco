import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { readFile } from 'node:fs/promises'
import { defaults, seal } from 'iron-webcrypto'
import { ironCrypto } from '../../workers/auth/iron-crypto'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import {
  ADMIN_CATALOG_CAPABILITIES,
  listD1AdminCategories,
  listD1AdminProducts,
  parseAdminCatalogLegacyId,
  readD1AdminProduct,
  type D1AdminProductList,
  type D1AdminProductDetail,
  type D1AdminCategoryResponse
} from '../../workers/catalog/admin-catalog'
import { handleD1AdminCatalogRequest, parseAdminCatalogQuery } from '../../workers/catalog/admin-catalog-http'
import { listPublishedCategories } from '../../workers/catalog/categories'
import { getPublishedProductDetail } from '../../workers/catalog/product-detail'
import { listPublishedProducts } from '../../workers/catalog/products'
import { listAvailability } from '../../workers/catalog/inventory'
import { d1OverSqlite, openMigratedDatabase, seedInventoryFixture } from '../support/d1-sqlite'
import { provisionPublicationValidityFixture } from '../support/publication-validity-fixture'

const NOW = '2026-09-30T09:00:00Z'
const ORIGIN = 'https://neteco.invalid'
const IDENTITY = '10000000-0000-4000-8000-000000000001'
const SESSION = '20000000-0000-4000-8000-000000000001'
const CLAIMS = { identityId: IDENTITY, sessionId: SESSION, sessionVersion: 1 }
const COOKIE = { password: 'admin-catalog-test-secret-32-characters-or-more', maxAgeSeconds: 3600 }
const QUERY = { q: '', page: 1, perPage: 500 }

describe('D1 editorial catalog read adapter against migrated SQLite', () => {
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
      INSERT INTO identities(id, email, password_hash, email_verified_at, status, created_at, updated_at)
        VALUES ('${IDENTITY}', 'editor@example.invalid', 'private-password-hash', '${NOW}', 'active', '${NOW}', '${NOW}');
      INSERT INTO auth_sessions(id, identity_id, session_version, mfa_verified, created_at, expires_at)
        VALUES ('${SESSION}', '${IDENTITY}', 1, 1, '2026-09-30T08:00:00Z', '2026-09-30T11:00:00Z');
      INSERT INTO roles VALUES ('catalog_editor', 'Editor', 'fixture'), ('customer', 'Customer', 'fixture'), ('admin', 'Admin', 'fixture');
      INSERT INTO permissions VALUES ('catalog.write', 'catalog', 'write', 'fixture'), ('catalog.read', 'catalog', 'read', 'fixture'),
        ('administration.manage', 'administration', 'manage', 'fixture');
      INSERT INTO role_permissions VALUES ('catalog_editor', 'catalog.write'), ('catalog_editor', 'catalog.read'),
        ('customer', 'catalog.read'), ('admin', 'catalog.write'), ('admin', 'administration.manage');
      INSERT INTO identity_roles(identity_id, role_code, granted_at) VALUES ('${IDENTITY}', 'catalog_editor', '${NOW}');
      INSERT INTO categories(id, legacy_id, parent_id, name, slug, status, sort_order) VALUES
        ('c2', 8, NULL, 'Familia borrador', 'familia-borrador', 'draft', 8),
        ('c3', 9, 'c2', 'Subfamilia oculta', 'subfamilia-oculta', 'hidden', 9),
        ('c4', 10, 'c1', 'Subfamilia revisión', 'subfamilia-revision', 'review', 10);
      UPDATE products SET status = 'draft', brand_id = 'b1', featured = 1,
        short_description = 'Texto breve', description = 'Descripción privada', usage = 'Uso profesional', series = 'Serie A',
        attributes = '{"badges":["eco","pro"],"visual":{"type":"cubo","color":"#123456"},"image":"/img/products/fixture.webp","imageAlt":"Producto de prueba","imageRights":{"owner":"Titular de prueba","license":"Autorización","authorizedAt":"2026-09-01"},"attrs":[{"k":"Material","v":"Acero"}]}'
        WHERE id = 'p-1';
      UPDATE products SET status = 'hidden', category_id = 'c2' WHERE id = 'p-2';
      UPDATE products SET status = 'review', category_id = 'c3' WHERE id = 'p-3';
      UPDATE products SET status = 'discontinued' WHERE id = 'p-5';
      UPDATE variants SET status = 'draft', format = 'Caja 6 unidades', content_quantity = 6, unit_label = 'ud', unit_base = 'unit',
        units_per_case = 6, cases_per_pallet = 40, minimum_quantity = 2, quantity_increment = 2, maximum_quantity = 100,
        weight_grams = 1200, width_mm = 150, height_mm = 200, depth_mm = 250, lead_time_days = 3, backorder_allowed = 1,
        ean = '1234567890123', gtin = '01234567890123', mpn = 'MPN-A', color = '#654321', image = '/img/products/variant.webp'
        WHERE id = 'v-1-1';
      UPDATE variants SET status = 'hidden' WHERE id = 'v-2-1';
      INSERT INTO variants(id, legacy_id, product_id, tax_class_id, shipping_profile_id, sku, format, status, price_gross_cents, compare_at_gross_cents)
        VALUES ('v-1-2', 12, 'p-1', 't21', 'sp1', 'SKU-1-2', 'Botella 2 L', 'published', 950, 1000),
        ('v-1-3', 13, 'p-1', 't21', 'sp1', 'SKU-1-3', 'Obsoleto', 'discontinued', 999, NULL);
    `)
    cookie = (await issueD1SessionCookie(database, CLAIMS, COOKIE))!.split(';')[0]!
  })

  afterEach(() => {
    sqlite.close()
    vi.useRealTimers()
  })

  type CatalogResponse<Path extends string> = Omit<Response, 'json'> & {
    json(): Promise<
      Path extends '/api/admin/categories'
        ? D1AdminCategoryResponse
        : Path extends `/api/admin/products/${string}`
          ? D1AdminProductDetail
          : D1AdminProductList
    >
  }
  async function request<Path extends string = '/api/admin/products'>(
    path: Path = '/api/admin/products' as Path,
    options: {
      headers?: Record<string, string>
      method?: string
      database?: D1Database
      origin?: string
      now?: string
    } = {}
  ) {
    return (await handleD1AdminCatalogRequest(
      new Request(`${ORIGIN}${path}`, {
        headers: { cookie, ...options.headers },
        method: options.method ?? 'GET'
      }),
      {
        database: options.database ?? database,
        sessionCookieConfiguration: COOKIE,
        origin: options.origin ?? ORIGIN,
        now: options.now ?? NOW
      }
    ))! as CatalogResponse<Path>
  }

  type ProviderRead = 'list' | 'count' | 'variants' | 'categories'
  const providerPath = (read: ProviderRead) =>
    read === 'variants'
      ? '/api/admin/products/1'
      : read === 'categories'
        ? '/api/admin/categories'
        : '/api/admin/products'
  function alteredProvider(read: ProviderRead, alter: (result: unknown) => unknown): D1Database {
    return new Proxy(database, {
      get(target, property) {
        if (property === 'batch' && (read === 'list' || read === 'count'))
          return async (statements: D1PreparedStatement[]) => {
            const results = await target.batch(statements)
            return results.map((result, index) => (index === (read === 'list' ? 0 : 1) ? alter(result) : result))
          }
        if (property === 'prepare' && (read === 'variants' || read === 'categories'))
          return (sql: string) => {
            const statement = target.prepare(sql)
            if (
              !sql.includes(
                read === 'variants' ? 'FROM variants v JOIN tax_classes tax' : 'FROM categories c LEFT JOIN products p'
              )
            )
              return statement
            const wrapped: D1PreparedStatement = new Proxy(statement, {
              get(selected, key) {
                if (key === 'bind')
                  return (...parameters: unknown[]) => {
                    selected.bind(...parameters)
                    return wrapped
                  }
                if (key === 'all') return async () => alter(await selected.all())
                const value: unknown = Reflect.get(selected, key, selected)
                return typeof value === 'function' ? value.bind(selected) : value
              }
            })
            return wrapped
          }
        const value: unknown = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      }
    })
  }
  function catalogRows() {
    return ['products', 'variants', 'categories', 'inventory_balances', 'catalog_draft_authoring_commands'].map(
      (table) => sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()
    )
  }
  async function expectUnavailable(path: string, db: D1Database) {
    const before = catalogRows()
    const result = await request(path, { database: db })
    expect(result.status).toBe(503)
    expect(await result.json()).toEqual({ error: { code: 'service_unavailable' } })
    expect(result.headers.get('cache-control')).toBe('private, no-store')
    expect(result.headers.get('pragma')).toBe('no-cache')
    expect(result.headers.get('vary')).toBe('Cookie')
    expect(result.headers.get('x-robots-tag')).toContain('noindex')
    expect(result.headers.get('access-control-allow-origin')).toBeNull()
    expect(catalogRows()).toEqual(before)
  }

  function version(
    id: string,
    gross: number,
    from = '2026-09-29T00:00:00Z',
    until: string | null = null,
    created = from,
    cancelled = false
  ) {
    sqlite
      .prepare(
        `INSERT INTO variant_price_versions(id, variant_id, gross_cents, compare_at_gross_cents,
        reference_gross_cents_30d, volume_tiers, valid_from, valid_until, status, reason, created_at,
        cancelled_at, cancelled_by, cancellation_reason)
      VALUES (?, 'v-1-1', ?, ?, 700, '[{"minimumQuantity":6,"unitGrossCents":300}]', ?, ?, ?, 'Local price test', ?, ?, ?, ?)`
      )
      .run(
        id,
        gross,
        gross + 200,
        from,
        until,
        cancelled ? 'cancelled' : 'approved',
        created,
        cancelled ? NOW : null,
        cancelled ? IDENTITY : null,
        cancelled ? 'Cancelled test version' : null
      )
  }

  it('preserves the product-list contract across every editorial status and declared capabilities', async () => {
    const result = await request()
    expect(result.status).toBe(200)
    const body = await result.json()
    expect(body).toMatchObject({
      source: 'cloudflare',
      pricingInstant: NOW,
      pagination: { page: 1, perPage: 500, total: 6, pages: 1 },
      capabilities: ADMIN_CATALOG_CAPABILITIES
    })
    expect(body.items.map((item: { id: number }) => item.id)).toEqual([1, 2, 3, 4, 5, 6])
    expect(body.items[0]).toEqual({
      id: 1,
      uuid: 'p-1',
      catalogVersion: 2,
      name: 'Producto 1',
      slug: 'producto-1',
      brand: 'NETECO',
      featured: true,
      active: false,
      status: 'draft',
      series: 'Serie A',
      visual: { type: 'cubo', color: '#123456' },
      categoryId: 7,
      categoryName: 'Químicos',
      minPrice: 500,
      formats: 3
    })
    expect(body.items[1]!.status).toBe('hidden')
    expect(body.items[4]!.status).toBe('discontinued')
    // Narrow draft commands do not activate the old complete-product payload,
    // financial writes, category CRUD or implicit variant replacement.
    expect(body.capabilities).toMatchObject({
      productCreate: false,
      productUpdate: false,
      productDelete: false,
      categoryCreate: false,
      categoryUpdate: false,
      categoryDelete: false,
      variantWrite: false,
      priceWrite: false,
      inventoryWrite: false,
      productDraftCreate: true,
      productDraftBrandUpdate: true,
      variantDraftCreate: true,
      variantDraftUpdate: true,
      variantDraftDiscontinue: true
    })
    expect(body.capabilities.productMetadataUpdate).toBe(true)
    expect(body.capabilities.productImportJobPreparation).toBe(true)
    expect(body.capabilities.productImportJobCommands).toBe(true)
  })

  it('preserves every detail/variant field for drafts and includes physical and authoritative sellable stock', async () => {
    const result = await request('/api/admin/products/1')
    expect(result.status).toBe(200)
    const body = await result.json()
    expect(body).toMatchObject({
      id: 1,
      catalogVersion: 2,
      name: 'Producto 1',
      slug: 'producto-1',
      brand: 'NETECO',
      categoryId: 7,
      shortDesc: 'Texto breve',
      description: 'Descripción privada',
      usage: 'Uso profesional',
      badges: ['eco', 'pro'],
      visual: { type: 'cubo', color: '#123456' },
      featured: true,
      active: false,
      status: 'draft',
      series: 'Serie A',
      image: '/img/products/fixture.webp',
      imageAlt: 'Producto de prueba',
      imageRightsOwner: 'Titular de prueba',
      imageRightsLicense: 'Autorización',
      imageAuthorizedAt: '2026-09-01',
      attrs: [{ k: 'Material', v: 'Acero' }],
      fieldAvailability: { identifierExceptionReason: false }
    })
    expect(body.variants.map((variant: { id: number }) => variant.id)).toEqual([11, 12])
    expect(body.variants[0]).toEqual({
      id: 11,
      uuid: 'v-1-1',
      format: 'Caja 6 unidades',
      sku: 'SKU-1-1',
      ean: '1234567890123',
      gtin: '01234567890123',
      mpn: 'MPN-A',
      identifierExceptionReason: null,
      status: 'draft',
      price: 500,
      stock: 25,
      physicalStock: 25,
      sellableStock: 24,
      units: 6,
      unitLabel: 'ud',
      unitBase: 'unit',
      unitsPerCase: 6,
      casesPerPallet: 40,
      minimumQuantity: 2,
      quantityIncrement: 2,
      maximumQuantity: 100,
      weightGrams: 1200,
      widthMm: 150,
      heightMm: 200,
      depthMm: 250,
      safetyStock: 1,
      backorderAllowed: true,
      leadTimeDays: 3,
      color: '#654321',
      image: '/img/products/variant.webp',
      taxRateBasisPoints: 2100,
      netPrice: 413,
      compareAtPrice: null,
      referencePrice30d: null,
      pricingVersion: 'legacy:v-1-1',
      priceTiers: []
    })
    expect(body.variants[1]).toMatchObject({
      stock: 0,
      physicalStock: 0,
      sellableStock: 0,
      price: 950,
      compareAtPrice: 1000
    })
    expect(body.uuid).toBe('p-1')
    expect(JSON.stringify(body)).not.toMatch(/private-password-hash|editor@example|sessionId|token_envelope/)
    expect((await (await request('/api/admin/products/2')).json()).variants[0]!.status).toBe('hidden')
  })

  it('uses current reservation/blocked/safety semantics, including expired-but-unreleased reservations', async () => {
    sqlite.exec(`UPDATE inventory_balances SET blocked_quantity = 3 WHERE variant_id = 'v-1-1';
      INSERT INTO inventory_reservations(id, idempotency_key, payload_hash, status, correlation_id, expires_at, created_at, updated_at)
        VALUES ('reserved', 'reserved', '${'a'.repeat(64)}', 'reserved', 'fixture', '2026-09-29T00:00:00Z', '2026-09-28T00:00:00Z', '2026-09-28T00:00:00Z');
      INSERT INTO inventory_reservation_lines VALUES ('reserved', 'v-1-1', 'loc-main', 5);`)
    const availability = await listAvailability(database, { variantId: 'v-1-1' })
    const body = await (await request('/api/admin/products/1')).json()
    expect(body.variants[0]).toMatchObject({
      stock: 25,
      physicalStock: 25,
      sellableStock: availability[0]!.sellableQuantity
    })
    expect(body.variants[0]!.sellableStock).toBe(16)
    sqlite.exec(
      "UPDATE inventory_reservations SET status = 'released', released_at = '2026-09-30T09:00:00Z', updated_at = '2026-09-30T09:00:00Z'"
    )
    expect((await (await request('/api/admin/products/1')).json()).variants[0]!.sellableStock).toBe(21)
  })

  it('uses the shared deterministic price winner for minima, gross/net/compare/reference/tier fields', async () => {
    version('price-a', 450)
    version('price-b', 400)
    version('future', 301, '2026-09-30T09:00:01Z')
    version('ended', 302, '2026-09-30T08:00:00Z', NOW)
    version('cancelled', 303, '2026-09-30T08:30:00Z', null, '2026-09-30T08:30:00Z', true)
    const detail = await (await request('/api/admin/products/1')).json()
    const list = await (await request()).json()
    expect(detail.variants[0]).toMatchObject({
      price: 400,
      netPrice: 331,
      compareAtPrice: 600,
      referencePrice30d: 700,
      pricingVersion: 'price-b',
      priceTiers: [{ minimumQuantity: 6, unitGrossCents: 300 }]
    })
    expect(list.items[0]!.minPrice).toBe(400)
  })

  it('handles inclusive/exclusive millisecond price windows exactly like public detail/list pricing', async () => {
    sqlite.exec(
      "UPDATE products SET status = 'published' WHERE id = 'p-1'; UPDATE variants SET status = 'published', ean='8412345678905', gtin='08412345678905' WHERE id = 'v-1-1'"
    )
    await provisionPublicationValidityFixture(database, {
      productIds: ['p-1'],
      now: '2026-09-29T00:00:00Z',
      validUntil: '2099-01-01T00:00:00Z'
    })
    version('seconds', 400, NOW)
    version('milliseconds', 350, '2026-09-30T09:00:00.100Z', '2026-09-30T09:00:00.200Z', '2026-09-30T09:00:00.001Z')
    for (const [instant, expected] of [
      ['2026-09-30T09:00:00.099Z', 400],
      ['2026-09-30T09:00:00.100Z', 350],
      ['2026-09-30T09:00:00.199Z', 350],
      ['2026-09-30T09:00:00.200Z', 400]
    ] as const) {
      const admin = await (await request('/api/admin/products/1', { now: instant })).json()
      const publicDetail = await getPublishedProductDetail(database, 'producto-1', { instant })
      const publicList = await listPublishedProducts(database, { page: 1, limit: 10, sort: 'default' }, { instant })
      expect(admin.variants[0]!.price).toBe(expected)
      expect(admin.variants[0]!.price).toBe(publicDetail!.variants[0]!.price)
      expect(admin.variants[0]!.netPrice).toBe(publicDetail!.variants[0]!.netPrice)
      expect(
        (await (await request('/api/admin/products?q=Producto%201', { now: instant })).json()).items[0]!.minPrice
      ).toBe(publicList!.items.find((item) => item.id === 1)!.minPrice)
    }
  })

  it('falls back to base prices when no version applies and does not invent a price for an empty product', async () => {
    version('ended', 400, '2026-09-29T00:00:00Z', NOW)
    sqlite.exec(
      "INSERT INTO products(id, legacy_id, category_id, name, slug, status) VALUES ('empty', 90, 'c1', 'Sin variantes', 'sin-variantes', 'draft')"
    )
    const body = await (await request()).json()
    expect(body.items.find((item: { id: number }) => item.id === 1)!.minPrice).toBe(500)
    expect(body.items.find((item: { id: number }) => item.id === 90)).toMatchObject({ minPrice: null, formats: 0 })
    expect((await (await request('/api/admin/products/90')).json()).variants).toEqual([])
  })

  it.each([
    ['active=1', [4, 6]],
    ['active=0', [1, 2, 3, 5]],
    ['status=draft', [1]],
    ['status=review', [3]],
    ['status=hidden', [2]],
    ['status=discontinued', [5]],
    ['category=8', [2]],
    ['category=9', [3]],
    ['active=1&status=hidden', []],
    ['category=999', []]
  ])('applies legacy-compatible editorial filters (%s)', async (parameters, ids) => {
    const body = await (await request(`/api/admin/products?${parameters}`)).json()
    expect(body.items.map((item: { id: number }) => item.id)).toEqual(ids)
    expect(body.pagination.total).toBe(ids.length)
  })

  it.each(['%', '_', '\\', "' OR 1=1 --", 'SELECT * FROM identities'])(
    'treats q as a literal bound string (%s)',
    async (query) => {
      sqlite.prepare('UPDATE products SET name = ? WHERE id = ?').run(`Literal ${query} needle`, 'p-1')
      const result = await request(`/api/admin/products?q=${encodeURIComponent(query)}`)
      expect(result.status).toBe(200)
      const body = await result.json()
      expect(body.items.map((item: { id: number }) => item.id)).toEqual([1])
      expect(sqlite.prepare('SELECT COUNT(*) AS n FROM identities').get()).toMatchObject({ n: 1 })
    }
  )

  it('searches product, brand and hidden-variant SKU case-insensitively without public exposure', async () => {
    sqlite.exec(
      "UPDATE products SET name = 'QUÍMICO profesional' WHERE id = 'p-2'; UPDATE brands SET name = 'MÁRCA de prueba'"
    )
    for (const [q, expected] of [
      ['quimico', [2]],
      ['marca', [1]],
      ['sku-2-1', [2]]
    ] as const)
      expect(
        (await (await request(`/api/admin/products?q=${q}`)).json()).items.map((item: { id: number }) => item.id)
      ).toEqual(expected)
    expect(await getPublishedProductDetail(database, 'producto-2', { instant: NOW })).toBeNull()
  })

  it('paginates deterministically with tied names, bounded defaults and observable totals', async () => {
    sqlite.exec("UPDATE products SET name = 'same' WHERE id IN ('p-1','p-2','p-3')")
    const first = await (await request('/api/admin/products?q=same&perPage=2')).json()
    const second = await (await request('/api/admin/products?q=same&perPage=2&page=2')).json()
    expect(first.pagination).toEqual({ page: 1, perPage: 2, total: 3, pages: 2 })
    expect(first.items.map((item: { id: number }) => item.id)).toEqual([1, 2])
    expect(second.items.map((item: { id: number }) => item.id)).toEqual([3])
    expect((await (await request('/api/admin/products?page=999999')).json()).items).toEqual([])
    const insert = sqlite.prepare(
      "INSERT INTO products(id, legacy_id, category_id, name, slug, status) VALUES (?, ?, 'c1', ?, ?, 'draft')"
    )
    for (let i = 0; i < 501; i++)
      insert.run(`bound-${i}`, 1000 + i, `Bound ${String(i).padStart(3, '0')}`, `bound-${i}`)
    const bounded = await (await request('/api/admin/products?q=Bound')).json()
    expect(bounded.items).toHaveLength(500)
    expect(bounded.pagination).toEqual({ page: 1, perPage: 500, total: 501, pages: 2 })
    expect((await (await request('/api/admin/products?q=Bound&page=2')).json()).items).toHaveLength(1)
  })

  it('returns a complete administrative category hierarchy without changing public publication filtering', async () => {
    const result = await request('/api/admin/categories')
    expect(result.status).toBe(200)
    const body = await result.json()
    expect(body.flat.map((category: { id: number }) => category.id)).toEqual([7, 8, 9, 10])
    expect(body.roots.map((category: { id: number }) => category.id)).toEqual([7, 8])
    expect(body.roots[0]).toMatchObject({
      id: 7,
      parentId: null,
      status: 'published',
      directCount: 4,
      count: 4,
      children: [{ id: 10, parentId: 7, status: 'review' }]
    })
    expect(body.roots[1]).toMatchObject({
      id: 8,
      status: 'draft',
      directCount: 1,
      count: 2,
      children: [{ id: 9, parentId: 8, status: 'hidden', directCount: 1, count: 1 }]
    })
    const publicCategories = await listPublishedCategories(database)
    expect(publicCategories.flat.map((category) => category.id)).toEqual([7])
    expect(body.unmappedCategories).toBe(0)
    expect(body.capabilities).toMatchObject({
      categoriesRead: true,
      categoryCreate: false,
      categoryUpdate: false,
      categoryDelete: false
    })
    expect(body.roots[0]!.authoring).toMatchObject({
      id: 7,
      uuid: 'c1',
      version: 1,
      actualParentUuid: null,
      actualParentId: null,
      parentMapped: true,
      directChildren: 1,
      directProducts: 4
    })
  })

  it('traverses unmapped ancestors without null-ID collisions or lost mapped descendants', async () => {
    sqlite.exec(`INSERT INTO categories(id, parent_id, name, slug, status, sort_order) VALUES ('unmapped', 'c1', 'Sin mapeo', 'sin-mapeo', 'draft', 11);
      UPDATE categories SET parent_id = 'unmapped' WHERE id = 'c4'; UPDATE products SET category_id = 'unmapped' WHERE id = 'p-6';`)
    const body = await (await request('/api/admin/categories')).json()
    expect(body.unmappedCategories).toBe(1)
    expect(body.roots[0]).toMatchObject({ id: 7, count: 4, directCount: 3, children: [{ id: 10, parentId: 7 }] })
    expect(body.roots[0]!.children[0]!.authoring).toMatchObject({
      id: 10,
      uuid: 'c4',
      version: 2,
      actualParentUuid: 'unmapped',
      actualParentId: null,
      parentMapped: false
    })
    expect(body.flat.every((category: { id: number }) => Number.isSafeInteger(category.id) && category.id > 0)).toBe(
      true
    )
    expect((await (await request()).json()).items.map((item: { id: number }) => item.id)).not.toContain(6)
  })

  it('fails closed for corrupt category cycles instead of looping or manufacturing a tree', async () => {
    sqlite.exec("UPDATE categories SET parent_id = 'c3' WHERE id = 'c2'")
    const result = await request('/api/admin/categories')
    expect(result.status).toBe(503)
    expect(await result.json()).toEqual({ error: { code: 'service_unavailable' } })
  })

  it('validates JSON editor projections without accepting arbitrary object fields', async () => {
    sqlite.exec(
      `UPDATE products SET attributes = '{"visual":"invalid","badges":["eco",42,{"private":"secret"}],"attrs":[{"k":"Valid","v":"entry","extra":"secret"},{"k":"Bad","v":9}]}' WHERE id = 'p-1'`
    )
    const body = await (await request('/api/admin/products/1')).json()
    expect(body.visual).toEqual({ type: 'caja', color: '#009ac9' })
    expect(body.badges).toEqual(['eco'])
    expect(body.attrs).toEqual([{ k: 'Valid', v: 'entry' }])
  })

  it.each([
    ['UPDATE auth_sessions SET mfa_verified = 0', 'mfa_required', 403],
    ['UPDATE identities SET email_verified_at = NULL', 'email_unverified', 403],
    ["UPDATE identities SET email_verified_at = '2026-09-30T10:00:00Z'", 'email_unverified', 403],
    ["UPDATE auth_sessions SET revoked_at = '2026-09-30T09:00:00Z'", 'unauthenticated', 401],
    ["UPDATE identities SET status = 'disabled'", 'unauthenticated', 401],
    ["UPDATE identities SET status = 'locked'", 'unauthenticated', 401],
    ['UPDATE identities SET session_version = 2', 'unauthenticated', 401],
    ["UPDATE auth_sessions SET expires_at = '2026-09-30T09:00:00Z'", 'unauthenticated', 401],
    [
      "UPDATE identity_roles SET expires_at = '2026-09-30T09:00:00Z', granted_at = '2026-09-30T08:00:00Z'",
      'forbidden',
      403
    ],
    ["UPDATE identity_roles SET granted_at = '2026-09-30T09:00:01Z'", 'forbidden', 403],
    ["DELETE FROM role_permissions WHERE permission_code = 'catalog.write'", 'forbidden', 403],
    ['DELETE FROM identity_roles', 'forbidden', 403],
    ['DELETE FROM auth_sessions', 'unauthenticated', 401]
  ])('uses live session/MFA/email/permission authority (%s)', async (sql, code, status) => {
    sqlite.exec(sql)
    for (const path of ['/api/admin/products', '/api/admin/products/1', '/api/admin/categories']) {
      const result = await request(path)
      expect(result.status).toBe(status)
      expect(await result.json()).toEqual({ error: { code } })
    }
  })

  it('rejects deleted identities and does not treat a cached role/MFA flag as authority', async () => {
    sqlite.exec("UPDATE identity_roles SET role_code = 'customer'; UPDATE auth_sessions SET mfa_verified = 0")
    const forged = await seal(
      ironCrypto,
      {
        id: crypto.randomUUID(),
        createdAt: Date.now(),
        data: {
          sessionId: SESSION,
          sessionVersion: 1,
          user: { id: IDENTITY, role: 'admin', roles: ['admin'], mfaVerified: true },
          mfaVerified: true
        }
      },
      COOKIE.password,
      { ...defaults, ttl: 3600_000 }
    )
    expect(
      (await request('/api/admin/products/1', { headers: { cookie: `neteco-session=${encodeURIComponent(forged)}` } }))
        .status
    ).toBe(403)
    sqlite.exec('UPDATE auth_sessions SET mfa_verified = 1')
    expect(await (await request()).json()).toEqual({ error: { code: 'forbidden' } })
    sqlite.exec('DELETE FROM identity_roles; DELETE FROM auth_sessions; DELETE FROM identities')
    expect((await request()).status).toBe(401)
  })

  it('allows a verified administrator only through its live catalog grant', async () => {
    sqlite.exec("UPDATE identity_roles SET role_code = 'admin'")
    expect((await request()).status).toBe(200)
    sqlite.exec("DELETE FROM role_permissions WHERE role_code = 'admin' AND permission_code = 'catalog.write'")
    expect((await request()).status).toBe(403)
  })

  it.each([
    '',
    'neteco-session=not-signed',
    'neteco-session=%ZZ',
    'neteco-session=x; neteco-session=x',
    `neteco-session=${'x'.repeat(8193)}`
  ])('rejects absent/invalid/ambiguous/oversized cookies (%s)', async (invalidCookie) => {
    const result = await request('/api/admin/products/1', {
      headers: { cookie: invalidCookie, authorization: `Bearer ${SESSION}`, 'x-user-role': 'admin' }
    })
    expect(result.status).toBe(401)
    expect(await result.json()).toEqual({ error: { code: 'unauthenticated' } })
  })

  it.each([
    ["UPDATE auth_sessions SET revoked_at = '2026-09-30T09:00:00Z'", 'unauthenticated'],
    ["DELETE FROM role_permissions WHERE permission_code = 'catalog.write'", 'forbidden'],
    ["UPDATE identities SET status = 'disabled'", 'unauthenticated'],
    ['UPDATE auth_sessions SET mfa_verified = 0', 'mfa_required'],
    ['UPDATE identities SET email_verified_at = NULL', 'email_unverified']
  ])('rechecks authority after catalog loading and before private projection (%s)', async (sql, code) => {
    for (const path of ['/api/admin/products', '/api/admin/products/1', '/api/admin/categories']) {
      sqlite.exec(`UPDATE identities SET status = 'active', email_verified_at = '${NOW}'; UPDATE auth_sessions SET revoked_at = NULL, mfa_verified = 1;
        INSERT OR IGNORE INTO role_permissions VALUES ('catalog_editor','catalog.write');`)
      let calls = 0
      const raced = {
        ...database,
        prepare(query: string) {
          const statement = database.prepare(query)
          if (!query.includes('FROM auth_sessions s JOIN identities i')) return statement
          const first = statement.first.bind(statement)
          statement.first = async <T>() => {
            if (++calls === 2) sqlite.exec(sql)
            return first<T>()
          }
          return statement
        }
      } as D1Database
      const result = await request(path, { database: raced })
      // Categories additionally await administration.manage to expose narrow
      // writer capabilities, then must recheck catalog.write after that await.
      expect(calls).toBe(path === '/api/admin/categories' ? 3 : 2)
      expect(result.status).toBe(code === 'unauthenticated' ? 401 : 403)
      expect(await result.json()).toEqual({ error: { code } })
    }
  })

  it.each(['grant', 'session'])(
    'uses fresh elapsed time if %s expiry happens during a multi-query read',
    async (kind) => {
      if (kind === 'grant') sqlite.exec("UPDATE identity_roles SET expires_at = '2026-09-30T09:00:01Z'")
      else sqlite.exec("UPDATE auth_sessions SET expires_at = '2026-09-30T09:00:01Z'")
      const raced = {
        ...database,
        prepare(query: string) {
          const statement = database.prepare(query)
          if (!query.includes('FROM variants v JOIN tax_classes tax')) return statement
          const all = statement.all.bind(statement)
          statement.all = async <T>() => {
            const result = await all<T>()
            vi.setSystemTime(new Date('2026-09-30T09:00:02Z'))
            return result
          }
          return statement
        }
      } as D1Database
      const result = await request('/api/admin/products/1', { database: raced })
      expect(result.status).toBe(kind === 'grant' ? 403 : 401)
      expect(await result.json()).toEqual({ error: { code: kind === 'grant' ? 'forbidden' : 'unauthenticated' } })
    }
  )

  it('uses fixed query counts with no per-product, per-category or per-variant D1 requests', async () => {
    let preparations = 0
    let batches = 0
    const counted = {
      ...database,
      prepare(sql: string) {
        preparations++
        return database.prepare(sql)
      },
      async batch<T>(statements: D1PreparedStatement[]) {
        batches++
        return database.batch<T>(statements)
      }
    } as D1Database
    expect((await request('/api/admin/products', { database: counted })).status).toBe(200)
    expect({ preparations, batches }).toEqual({ preparations: 4, batches: 1 })
    preparations = 0
    batches = 0
    expect((await request('/api/admin/products/1', { database: counted })).status).toBe(200)
    expect({ preparations, batches }).toEqual({ preparations: 4, batches: 0 })
    preparations = 0
    expect((await request('/api/admin/categories', { database: counted })).status).toBe(200)
    expect(preparations).toBe(5)
  })

  it.each([
    { origin: 'https://evil.invalid' },
    { origin: 'null' },
    { origin: `${ORIGIN}/` },
    { origin: `${ORIGIN}:443` },
    { 'sec-fetch-site': 'cross-site' },
    { origin: ORIGIN, 'sec-fetch-site': 'cross-site' }
  ])('rejects cross-origin/cross-site private API reads (%s)', async (headers) => {
    const result = await request('/api/admin/products/1', { headers: headers as Record<string, string> })
    expect(result.status).toBe(403)
    expect(await result.json()).toEqual({ error: { code: 'csrf_rejected' } })
  })

  it('permits normal same-origin browser/SSR reads and does not trust forged Host configuration', async () => {
    expect(
      (await request('/api/admin/products/1', { headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin' } })).status
    ).toBe(200)
    expect(
      (
        await request('/api/admin/products/1', {
          headers: { host: 'evil.invalid', 'x-forwarded-host': 'evil.invalid' }
        })
      ).status
    ).toBe(200)
    expect((await request('/api/admin/products/1', { origin: 'https://neteco.invalid/unsafe' })).status).toBe(503)
  })

  it.each(['HEAD', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'])(
    'returns immediate 405 for unimplemented %s without consuming a body or contacting D1',
    async (method) => {
      const unusable = {
        prepare() {
          throw new Error('must not query D1')
        }
      } as unknown as D1Database
      for (const path of [
        '/api/admin/products',
        '/api/admin/products/1',
        '/api/admin/products/1/active',
        '/api/admin/categories',
        '/api/admin/categories/7'
      ]) {
        if (method === 'PUT' && path === '/api/admin/products/1') continue // The separately governed draft endpoint.
        const result = await request(path, { method, database: unusable })
        expect(result.status).toBe(405)
        expect(result.headers.get('allow')).toBe(path === '/api/admin/products/1' ? 'GET, PUT' : 'GET')
        expect(await result.json()).toEqual({ error: { code: 'method_not_allowed' } })
      }
    }
  )

  it('does not intercept media or public routes, and owns unknown catalog subroutes', async () => {
    for (const path of [
      '/api/admin/media',
      '/api/admin/media/id',
      '/api/products',
      '/api/categories',
      '/api/admin/prices'
    ])
      expect(
        await handleD1AdminCatalogRequest(new Request(`${ORIGIN}${path}`), {
          database,
          sessionCookieConfiguration: COOKIE,
          origin: ORIGIN
        })
      ).toBeNull()
    expect((await request('/api/admin/products/1/unknown')).status).toBe(404)
    expect((await request('/api/admin/categories/7')).status).toBe(404)
  })

  it.each(['0', '-1', '01', '1.0', '1e2', '9007199254740992', 'NaN', 'Infinity', 'p-1', '1%20', '%31', '1%2Factive'])(
    'rejects noncanonical/unsafe legacy ID %s',
    async (id) => {
      const result = await request(`/api/admin/products/${id}`)
      expect(result.status).toBe(400)
      expect(await result.json()).toEqual({ error: { code: 'invalid_input' } })
    }
  )

  it('returns private 404 for a valid missing numeric legacy ID', async () => {
    const result = await request('/api/admin/products/999')
    expect(result.status).toBe(404)
    expect(await result.json()).toEqual({ error: { code: 'not_found' } })
  })

  it.each(['/api/admin/products', '/api/admin/products/1', '/api/admin/categories'])(
    'uses sanitized no-store 503 on a D1 outage (%s)',
    async (path) => {
      const unavailable = {
        prepare() {
          throw new Error('SELECT private-token FROM private_provider')
        }
      } as unknown as D1Database
      const result = await request(path, { database: unavailable })
      expect(result.status).toBe(503)
      expect(await result.json()).toEqual({ error: { code: 'service_unavailable' } })
      expect(result.headers.get('cache-control')).toBe('private, no-store')
    }
  )

  it.each(
    (['list', 'count', 'variants', 'categories'] as const).flatMap((read) =>
      [
        'false_success',
        'missing_success',
        'inherited_success',
        'accessor_success',
        'missing_results',
        'inherited_results',
        'accessor_results',
        'nonarray_results',
        'null_result'
      ].map((shape) => [read, shape] as const)
    )
  )('rejects unconfirmed %s provider envelopes (%s) without projecting private data', async (read, shape) => {
    let accesses = 0
    const invalid = alteredProvider(read, (source) => {
      const rows: unknown =
        source && typeof source === 'object' ? Object.getOwnPropertyDescriptor(source, 'results')?.value : []
      const result: Record<string, unknown> = { success: true, results: rows }
      if (shape === 'false_success') result.success = false
      if (shape === 'missing_success') delete result.success
      if (shape === 'inherited_success') {
        delete result.success
        Object.setPrototypeOf(result, { success: true })
      }
      if (shape === 'accessor_success')
        Object.defineProperty(result, 'success', {
          get() {
            accesses++
            throw new Error('SELECT private-token FROM private_provider')
          }
        })
      if (shape === 'missing_results') delete result.results
      if (shape === 'inherited_results') {
        delete result.results
        Object.setPrototypeOf(result, { results: rows })
      }
      if (shape === 'accessor_results')
        Object.defineProperty(result, 'results', {
          get() {
            accesses++
            throw new Error('SELECT private-token FROM private_provider')
          }
        })
      if (shape === 'nonarray_results') result.results = { private: 'editor@example.invalid' }
      return shape === 'null_result' ? null : result
    })
    await expectUnavailable(providerPath(read), invalid)
    expect(accesses).toBe(0)
  })

  it.each(['missing', 'extra', 'nonarray', 'sparse'] as const)(
    'rejects an incomplete product-list batch (%s)',
    async (shape) => {
      const invalid = new Proxy(database, {
        get(target, property) {
          if (property === 'batch')
            return async (statements: D1PreparedStatement[]) => {
              const results = await target.batch(statements)
              if (shape === 'missing') return results.slice(0, 1)
              if (shape === 'extra') return [...results, results[0]]
              if (shape === 'sparse') {
                const sparse = [...results]
                Reflect.deleteProperty(sparse, '0')
                return sparse
              }
              return { 0: results[0], 1: results[1], length: 2 }
            }
          const value: unknown = Reflect.get(target, property, target)
          return typeof value === 'function' ? value.bind(target) : value
        }
      })
      await expectUnavailable('/api/admin/products', invalid)
    }
  )

  it.each([
    'empty',
    'duplicate',
    'null',
    'missing_total',
    'inherited_total',
    'accessor_total',
    'accessor_row',
    'negative',
    'fractional',
    'unsafe',
    'nan',
    'infinite',
    'string'
  ])('rejects an unconfirmed or invalid count row (%s), never substituting zero', async (shape) => {
    let accesses = 0
    const invalid = alteredProvider('count', () => {
      const row: Record<string, unknown> = { total: 6 }
      if (shape === 'missing_total') delete row.total
      if (shape === 'inherited_total') {
        delete row.total
        Object.setPrototypeOf(row, { total: 6 })
      }
      if (shape === 'accessor_total')
        Object.defineProperty(row, 'total', {
          get() {
            accesses++
            return 6
          }
        })
      if (shape === 'negative') row.total = -1
      if (shape === 'fractional') row.total = 1.5
      if (shape === 'unsafe') row.total = Number.MAX_SAFE_INTEGER + 1
      if (shape === 'nan') row.total = Number.NaN
      if (shape === 'infinite') row.total = Number.POSITIVE_INFINITY
      if (shape === 'string') row.total = '6'
      const rows: unknown[] =
        shape === 'empty' ? [] : shape === 'duplicate' ? [row, row] : shape === 'null' ? [null] : [row]
      if (shape === 'accessor_row')
        Object.defineProperty(rows, '0', {
          get() {
            accesses++
            return row
          }
        })
      return { success: true, results: rows }
    })
    await expectUnavailable('/api/admin/products', invalid)
    expect(accesses).toBe(0)
  })

  it('preserves a genuine confirmed zero-count/list and empty variant/category result', async () => {
    const empty = await (await request('/api/admin/products?category=999')).json()
    expect(empty.items).toEqual([])
    expect(empty.pagination).toEqual({ page: 1, perPage: 500, total: 0, pages: 0 })
    sqlite.exec(
      "INSERT INTO products(id,legacy_id,category_id,name,slug,status) VALUES ('empty-confirmed',99,'c1','Confirmed empty','confirmed-empty','draft')"
    )
    expect((await (await request('/api/admin/products/99')).json()).authoring.variants).toEqual([])
    const category = await request('/api/admin/categories', {
      database: alteredProvider('categories', () => ({ success: true, results: [] }))
    })
    expect(category.status).toBe(200)
    expect(await category.json()).toMatchObject({ roots: [], flat: [], unmappedCategories: 0 })
  })

  it.each(['list', 'count', 'variants', 'categories'] as const)(
    'authorizes before requesting %s provider data and rejects live revocation after a confirmed read',
    async (read) => {
      let reads = 0
      const observed = alteredProvider(read, (result) => {
        reads++
        sqlite.exec(`UPDATE auth_sessions SET revoked_at='${NOW}' WHERE id='${SESSION}'`)
        return result
      })
      expect((await request(providerPath(read), { database: observed, headers: { cookie: '' } })).status).toBe(401)
      expect(reads).toBe(0)
      const result = await request(providerPath(read), { database: observed })
      expect(result.status).toBe(401)
      expect(await result.json()).toEqual({ error: { code: 'unauthenticated' } })
      expect(reads).toBe(1)
    }
  )

  it('keeps successful/error/method responses private, uncached, noindex and free of CORS grants', async () => {
    for (const [path, options] of [
      ['/api/admin/products', {}],
      ['/api/admin/products/999', {}],
      ['/api/admin/products?q=a&q=b', {}],
      ['/api/admin/products', { headers: { cookie: '' } }],
      ['/api/admin/products', { method: 'PUT' }]
    ] as const) {
      const result = await request(path, options)
      expect(result.headers.get('cache-control')).toBe('private, no-store')
      expect(result.headers.get('pragma')).toBe('no-cache')
      expect(result.headers.get('vary')).toBe('Cookie')
      expect(result.headers.get('x-content-type-options')).toBe('nosniff')
      expect(result.headers.get('x-robots-tag')).toContain('noindex')
      expect(result.headers.get('access-control-allow-origin')).toBeNull()
    }
  })

  it('sanitizes a failure of the second authority check and projection rather than releasing private rows', async () => {
    let calls = 0
    const unavailable = {
      ...database,
      prepare(query: string) {
        const statement = database.prepare(query)
        if (!query.includes('FROM auth_sessions s JOIN identities i')) return statement
        const first = statement.first.bind(statement)
        statement.first = async <T>() => {
          if (++calls === 2) throw new Error('private-after-check-SQL')
          return first<T>()
        }
        return statement
      }
    } as D1Database
    const result = await request('/api/admin/products/1', { database: unavailable })
    expect(result.status).toBe(503)
    expect(await result.json()).toEqual({ error: { code: 'service_unavailable' } })
    version('malformed-tier', 400)
    sqlite.exec(`UPDATE variant_price_versions SET volume_tiers = '[{"minimumQuantity":6,"unitGrossCents":999}]'`)
    expect((await request('/api/admin/products/1')).status).toBe(503)
  })

  it('keeps service callers behind live authorization and rejects invalid internal pagination', async () => {
    expect(await listD1AdminProducts(database, null, NOW, QUERY)).toEqual({
      outcome: 'denied',
      code: 'unauthenticated'
    })
    expect(await readD1AdminProduct(database, null, NOW, '1')).toEqual({ outcome: 'denied', code: 'unauthenticated' })
    expect(await listD1AdminCategories(database, null, NOW)).toEqual({ outcome: 'denied', code: 'unauthenticated' })
    await expect(listD1AdminProducts(database, CLAIMS, NOW, { ...QUERY, perPage: 501 })).rejects.toThrow(
      'invalid_admin_catalog_query'
    )
  })

  it('uses only the Worker D1 services and dependency-free money helpers, never a Node/PG catalog bridge', async () => {
    for (const path of ['workers/catalog/admin-catalog.ts', 'workers/catalog/admin-catalog-http.ts']) {
      const source = await readFile(path, 'utf8')
      expect(source).not.toMatch(/from ['"](?:node:|postgres|.*server\/(?:api|db|services)|.*db\/client)/)
    }
  })
})

describe('strict administrative catalog input parsing', () => {
  it('preserves defaults and existing filter names', () => {
    expect(parseAdminCatalogQuery(new URLSearchParams())).toEqual(QUERY)
    expect(
      parseAdminCatalogQuery(new URLSearchParams('q=foo&category=7&active=0&status=draft&page=2&perPage=25'))
    ).toEqual({ q: 'foo', category: 7, active: '0', status: 'draft', page: 2, perPage: 25 })
    expect(parseAdminCatalogLegacyId('9007199254740991')).toBe(Number.MAX_SAFE_INTEGER)
    for (const value of ['1\n', '1\r', '1\r\n', '1 ', ' 1']) expect(parseAdminCatalogLegacyId(value)).toBeNull()
  })
  it.each([
    'q=a&q=b',
    'unknown=1',
    'category=0',
    'category=-1',
    'category=01',
    'category=1e2',
    'category=9007199254740992',
    'active=true',
    'active=',
    'status=archived',
    'status=',
    'page=0',
    'page=01',
    'page=1000001',
    'perPage=501',
    'perPage=0',
    'perPage=1.0',
    'q=%00',
    'q=%7f',
    `q=${'a'.repeat(161)}`
  ])('rejects malformed/duplicate/unbounded input (%s)', (query) => {
    expect(parseAdminCatalogQuery(new URLSearchParams(query))).toBeNull()
  })
})

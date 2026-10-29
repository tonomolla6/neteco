import { afterEach, describe, expect, it } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import { searchPublishedProducts } from '../../workers/catalog/search'
import { handlePublicSearchHttp } from '../../workers/catalog/search-http'
import { listPublishedProducts } from '../../workers/catalog/products'
import { provisionPublicationValidityFixture } from '../support/publication-validity-fixture'
import { readFile } from 'node:fs/promises'
import { createSearchSynonymPreview, executeSearchSynonymCommand } from '../../workers/catalog/search-synonyms'
import { categoryCommandFixture, CATEGORY_CLAIMS } from '../support/category-command-fixture'

const NOW = '2026-09-30T12:00:00Z'
const databases: DatabaseSync[] = []
afterEach(() => {
  for (const database of databases.splice(0)) database.close()
})

async function fixture() {
  const db = await openMigratedDatabase()
  databases.push(db)
  db.exec(`
    INSERT INTO brands (id,name,slug,status) VALUES ('brand','Química Ñandú','quimica-nandu','published');
    INSERT INTO categories (id,legacy_id,name,slug,status) VALUES ('category',1,'Desinfección','desinfeccion','published');
    INSERT INTO categories (id,legacy_id,name,slug,status) VALUES ('private',2,'Desinfección privada','privada','hidden');
    INSERT INTO tax_classes (id,code,name,rate_basis_points,valid_from)
      VALUES ('tax21','ES21','IVA 21',2100,'2020-01-01T00:00:00Z'), ('tax10','ES10','IVA 10',1000,'2020-01-01T00:00:00Z');
    INSERT INTO shipping_profiles (id,code,name,kind) VALUES ('shipping','parcel','Paquete','parcel');
  `)
  let nextProductLegacyId = 1
  function product(
    id: string,
    name: string,
    options: { status?: string; category?: string; featured?: number; attributes?: string } = {}
  ) {
    db.prepare(
      `INSERT INTO products (id,legacy_id,name,slug,brand_id,category_id,status,featured,attributes)
      VALUES (?,?,?,?,'brand',?,?,?,?)`
    ).run(
      id,
      nextProductLegacyId++,
      name,
      id,
      options.category ?? 'category',
      options.status ?? 'published',
      options.featured ?? 0,
      options.attributes ?? '{}'
    )
  }
  let nextVariantLegacyId = 1
  function variant(
    id: string,
    productId: string,
    options: {
      sku?: string
      status?: string
      gross?: number
      tax?: string
      ean?: string
      gtin?: string
      mpn?: string
    } = {}
  ) {
    db.prepare(
      `INSERT INTO variants (id,legacy_id,product_id,tax_class_id,shipping_profile_id,sku,format,status,price_gross_cents,ean,gtin,mpn)
      VALUES (?,?,?,?,'shipping',?,'1 L',?,?,?,?,?)`
    ).run(
      id,
      nextVariantLegacyId++,
      productId,
      options.tax ?? 'tax21',
      options.sku ?? id,
      options.status ?? 'published',
      options.gross ?? 1210,
      options.ean ?? null,
      options.gtin ?? null,
      options.mpn ?? null
    )
  }
  return { db, product, variant, database: d1OverSqlite(db) }
}

describe('D1 public search', () => {
  it('applies direct normalized active synonyms to both suggestions and full catalog, never recursive or private products', async () => {
    const { sqlite: db, database } = await categoryCommandFixture()
    databases.push(db)
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='search_synonym_commands'").get())
      db.exec(await readFile(new URL('../../db/d1/migrations/0061_search_synonyms.sql', import.meta.url), 'utf8'))
    db.exec(`INSERT INTO brands(id,name,slug,status) VALUES ('syn-brand','NETECO','syn-brand','published');
      INSERT INTO tax_classes(id,code,name,rate_basis_points,valid_from) VALUES ('syn-tax','SYN21','IVA',2100,'2020-01-01T00:00:00Z');
      INSERT INTO shipping_profiles(id,code,name,kind) VALUES ('syn-shipping','SYN','Paquete','parcel');
      INSERT INTO products(id,legacy_id,name,slug,category_id,brand_id,status) VALUES
       ('syn-p1',100,'Hipoclorito industrial','hipoclorito','30000000-0000-4000-8000-000000000040','syn-brand','published'),
       ('syn-p2',101,'Cloro concentrado','cloro','30000000-0000-4000-8000-000000000040','syn-brand','published'),
       ('syn-private',102,'Hipoclorito secreto','hipoclorito-privado','30000000-0000-4000-8000-000000000040','syn-brand','draft');
      INSERT INTO variants(id,legacy_id,product_id,tax_class_id,shipping_profile_id,sku,format,status,price_gross_cents) VALUES
       ('syn-v1',100,'syn-p1','syn-tax','syn-shipping','SYN1','1 L','published',1210),
       ('syn-v2',101,'syn-p2','syn-tax','syn-shipping','SYN2','1 L','published',1210),
       ('syn-v3',102,'syn-private','syn-tax','syn-shipping','SYN3','1 L','published',1210);`)
    await provisionPublicationValidityFixture(database, {
      productIds: ['syn-p1', 'syn-p2'],
      now: '2026-08-19T00:00:00Z',
      validUntil: '2099-01-01T00:00:00Z'
    })
    const save = async (sourceTerm: string, replacements: string[]) => {
      const p = await createSearchSynonymPreview(database, CATEGORY_CLAIMS, {
        draft: {
          id: null,
          expectedVersion: 0,
          sourceTerm,
          replacements,
          active: true,
          reason: 'Vocabulario sintético revisado',
          action: 'save'
        },
        query: sourceTerm
      })
      if (sourceTerm === 'lejía') {
        expect(p.before).toEqual([])
        expect(p.after).toEqual([{ slug: 'hipoclorito', name: 'Hipoclorito industrial' }])
        expect((await searchPublishedProducts(database, 'lejía')).items).toEqual([])
      }
      return executeSearchSynonymCommand(
        database,
        CATEGORY_CLAIMS,
        { previewId: p.previewId, previewHash: p.previewHash },
        { idempotencyKey: crypto.randomUUID() }
      )
    }
    await save('hipoclorito', ['cloro'])
    const synonym = await save('lejía', ['hipoclorito'])
    expect((await searchPublishedProducts(database, '  LEJIA ')).items.map((item) => item.slug)).toEqual([
      'hipoclorito'
    ])
    expect(
      (await listPublishedProducts(database, { search: 'LEJÍA', page: 1, limit: 20, sort: 'default' }))!.items.map(
        (item) => item.slug
      )
    ).toEqual(['hipoclorito'])
    const paused = await createSearchSynonymPreview(database, CATEGORY_CLAIMS, {
      draft: {
        id: synonym.item.id,
        expectedVersion: 1,
        sourceTerm: 'lejía',
        replacements: ['hipoclorito'],
        active: false,
        reason: 'Pausa comercial sintética',
        action: 'save'
      },
      query: 'lejía'
    })
    await executeSearchSynonymCommand(
      database,
      CATEGORY_CLAIMS,
      { previewId: paused.previewId, previewHash: paused.previewHash },
      { idempotencyKey: crypto.randomUUID() }
    )
    expect((await searchPublishedProducts(database, 'lejía')).items).toEqual([])
    expect(
      (await listPublishedProducts(database, { search: 'lejía', page: 1, limit: 20, sort: 'default' }))!.items
    ).toEqual([])
    await save('alias referencia', ['SYN1'])
    expect((await searchPublishedProducts(database, 'alias referencia')).items.map((item) => item.slug)).toEqual([
      'hipoclorito'
    ])
    expect(
      (await listPublishedProducts(database, {
        search: 'alias referencia',
        page: 1,
        limit: 20,
        sort: 'default'
      }))!.items.map((item) => item.slug)
    ).toEqual(['hipoclorito'])
  })
  it('returns effective price/IVA with catalog, governed-media and fresh authority reads, excluding legacy originals', async () => {
    const { db, product, variant, database } = await fixture()
    product('limpiador', 'Limpiador ecológico', {
      attributes: JSON.stringify({
        visual: { type: 'garrafa', color: '#123456' },
        image: '/img/products/limpiador.webp'
      })
    })
    variant('v1', 'limpiador', { gross: 2420 })
    variant('v2', 'limpiador', { gross: 2200, tax: 'tax10' })
    db.exec(`INSERT INTO variant_price_versions(id,variant_id,gross_cents,valid_from,reason,created_at)
      VALUES ('price1','v1',1210,'2026-09-01T00:00:00Z','Precio efectivo para prueba','2026-09-01T00:00:00Z'),
      ('future','v1',500,'2027-01-01T00:00:00Z','Precio futuro para prueba','2026-09-01T00:00:00Z');`)
    const evidence = await provisionPublicationValidityFixture(database, {
      productIds: ['limpiador'],
      now: '2026-08-19T00:00:00Z',
      validUntil: '2099-01-01T00:00:00Z'
    })
    let statements = 0
    const counted = {
      ...database,
      prepare(sql: string) {
        statements++
        return database.prepare(sql)
      }
    } as D1Database
    expect(await searchPublishedProducts(counted, 'limpiador', { instant: NOW })).toEqual({
      items: [
        {
          name: 'Limpiador ecológico',
          slug: 'limpiador',
          brand: 'Química Ñandú',
          visual: { type: 'garrafa', color: '#123456' },
          image: `/media/${evidence.mainPublications.get('limpiador')!.id}/image?w=800&format=jpeg`,
          imageAlt: 'Synthetic selected product image',
          minPrice: 1210,
          minNetPrice: 1000,
          sku: null
        }
      ]
    })
    expect(statements).toBe(3)
    // No inventory balance is required: discovery does not reserve or hide stock.
    expect(db.prepare('SELECT count(*) AS n FROM inventory_reservations').get()).toEqual({ n: 0 })
  })

  it.each(['desengrasante ecologico', 'DESENGRASANTE ECOLÓGICO', '  desengrasante   ecológico  '])(
    'handles Spanish accents, case and whitespace: %s',
    async (query) => {
      const { product, variant, database } = await fixture()
      product('ecologico', 'Desengrasante ecológico')
      variant('v1', 'ecologico')
      await provisionPublicationValidityFixture(database, {
        productIds: ['ecologico'],
        now: '2026-08-19T00:00:00Z',
        validUntil: '2099-01-01T00:00:00Z'
      })
      expect((await searchPublishedProducts(database, query)).items.map((item) => item.slug)).toEqual(['ecologico'])
    }
  )

  it.each(['quimica nandu', 'desinfeccion'])(
    'matches folded brands/categories not present in product FTS: %s',
    async (query) => {
      const { product, variant, database } = await fixture()
      product('producto', 'Producto neutro')
      variant('v1', 'producto')
      await provisionPublicationValidityFixture(database, {
        productIds: ['producto'],
        now: '2026-08-19T00:00:00Z',
        validUntil: '2099-01-01T00:00:00Z'
      })
      expect((await searchPublishedProducts(database, query)).items).toHaveLength(1)
    }
  )

  it('ranks exact SKU before name and featured matches and returns matched SKU for navigation', async () => {
    const { product, variant, database } = await fixture()
    product('featured', 'ABC-123 recomendación', { featured: 1 })
    variant('v1', 'featured', { sku: 'ABC-123-EXTRA' })
    product('exact', 'Zzz detergente')
    variant('v2', 'exact', { sku: 'ABC-123' })
    await provisionPublicationValidityFixture(database, {
      productIds: ['featured', 'exact'],
      now: '2026-08-19T00:00:00Z',
      validUntil: '2099-01-01T00:00:00Z'
    })
    expect((await searchPublishedProducts(database, 'abc-123')).items.map((item) => [item.slug, item.sku])).toEqual([
      ['exact', 'ABC-123'],
      ['featured', 'ABC-123-EXTRA']
    ])
  })

  it.each(['ean', 'gtin', 'mpn'] as const)('looks up an exact published %s and returns its SKU', async (field) => {
    const { product, variant, database } = await fixture()
    product('identifier', 'Producto')
    variant('v1', 'identifier', { sku: 'SKU-READ', [field]: '8412345678905' })
    await provisionPublicationValidityFixture(database, {
      productIds: ['identifier'],
      now: '2026-08-19T00:00:00Z',
      validUntil: '2099-01-01T00:00:00Z'
    })
    expect((await searchPublishedProducts(database, '8412345678905')).items[0]?.sku).toBe('SKU-READ')
  })

  it('never discovers unpublished products/categories/variants or their identifiers', async () => {
    const { product, variant, database } = await fixture()
    product('hidden', 'Secreto detergente', { status: 'hidden' })
    variant('v1', 'hidden')
    product('review', 'Secreto detergente en revisión', { status: 'review' })
    variant('review-variant', 'review')
    product('category-hidden', 'Secreto detergente', { category: 'private' })
    variant('v2', 'category-hidden')
    product('variant-hidden', 'Secreto detergente')
    variant('v3', 'variant-hidden', { status: 'draft' })
    product('public', 'Producto visible')
    variant('v4', 'public')
    variant('v5', 'public', { sku: 'SECRET-SKU', status: 'hidden', gross: 1 })
    await provisionPublicationValidityFixture(database, {
      productIds: ['hidden', 'review', 'category-hidden', 'variant-hidden', 'public'],
      now: '2026-08-19T00:00:00Z',
      validUntil: '2099-01-01T00:00:00Z'
    })
    expect((await searchPublishedProducts(database, 'secreto')).items).toEqual([])
    expect((await searchPublishedProducts(database, 'SECRET-SKU')).items).toEqual([])
    expect((await searchPublishedProducts(database, 'visible')).items[0]?.minPrice).toBe(1210)
  })

  it('does not discover a public product through a hidden variant SKU in the full /buscar catalog', async () => {
    const { product, variant, database } = await fixture()
    product('visible', 'Producto neutro')
    variant('visible-variant', 'visible', { sku: 'PUBLIC-SKU' })
    variant('hidden-variant', 'visible', { sku: 'PRIVATE-REFERENCE', status: 'hidden' })
    await provisionPublicationValidityFixture(database, {
      productIds: ['visible'],
      now: '2026-08-19T00:00:00Z',
      validUntil: '2099-01-01T00:00:00Z'
    })
    const hidden = await listPublishedProducts(database, {
      search: 'PRIVATE-REFERENCE',
      page: 1,
      limit: 12,
      sort: 'default',
      facets: true
    })
    expect(hidden?.total).toBe(0)
    expect(hidden?.items).toEqual([])
    expect(hidden?.facets?.brands).toEqual([])
    const published = await listPublishedProducts(database, {
      search: 'PUBLIC-SKU',
      page: 1,
      limit: 12,
      sort: 'default'
    })
    expect(published?.total).toBe(1)
    expect(published?.items[0]?.uuid).toBe('visible')
  })

  it('binds hostile SQL/FTS input and treats wildcard characters literally', async () => {
    const { product, variant, database } = await fixture()
    product('literal', 'Producto literal')
    variant('v1', 'literal', { sku: 'XX_%' })
    product('other', 'Producto diferente')
    variant('v2', 'other', { sku: 'XXAB' })
    await provisionPublicationValidityFixture(database, {
      productIds: ['literal', 'other'],
      now: '2026-08-19T00:00:00Z',
      validUntil: '2099-01-01T00:00:00Z'
    })
    expect((await searchPublishedProducts(database, 'XX_%')).items.map((item) => item.slug)).toEqual(['literal'])
    expect((await searchPublishedProducts(database, "' OR 1=1 --")).items).toEqual([])
    expect((await searchPublishedProducts(database, '"* NEAR()')).items).toEqual([])
    expect((await searchPublishedProducts(database, '%_')).items).toEqual([])
  })
  it('preserves literal long identifier substring matching and the accepted 160-character boundary', async () => {
    const { product, variant, database } = await fixture()
    const literal = 'literal%_\\' + 'x'.repeat(70)
    product('long-literal', 'Producto literal largo')
    variant('long-v', 'long-literal', { sku: 'prefix-' + literal + '-suffix' })
    product('long-other', 'Producto diferente')
    variant('other-v', 'long-other', { sku: 'prefix-literalAB' + 'x'.repeat(70) + '-suffix' })
    await provisionPublicationValidityFixture(database, {
      productIds: ['long-literal', 'long-other'],
      now: '2026-08-19T00:00:00Z',
      validUntil: '2099-01-01T00:00:00Z'
    })
    expect((await searchPublishedProducts(database, literal, { instant: NOW })).items.map((item) => item.slug)).toEqual(
      ['long-literal']
    )
    expect((await searchPublishedProducts(database, 'z'.repeat(160), { instant: NOW })).items).toEqual([])
    expect(
      (
        await listPublishedProducts(
          database,
          { search: literal, page: 1, limit: 20, sort: 'default' },
          { instant: NOW }
        )
      )?.items.map((item) => item.slug)
    ).toEqual(['long-literal'])
  })

  it('limits results to eight and resolves stable ties by product ID', async () => {
    const { product, variant, database } = await fixture()
    for (let i = 0; i < 10; i++) {
      product(`p${i}`, 'Producto')
      variant(`v${i}`, `p${i}`)
    }
    await provisionPublicationValidityFixture(database, {
      productIds: Array.from({ length: 10 }, (_, i) => `p${i}`),
      now: '2026-08-19T00:00:00Z',
      validUntil: '2099-01-01T00:00:00Z'
    })
    expect((await searchPublishedProducts(database, 'producto')).items.map((item) => item.slug)).toEqual(
      Array.from({ length: 8 }, (_, i) => `p${i}`)
    )
  })

  it('falls back from non-object visual attributes', async () => {
    const { product, variant, database } = await fixture()
    product('visual', 'Producto', { attributes: '{"visual":null}' })
    variant('v1', 'visual')
    await provisionPublicationValidityFixture(database, {
      productIds: ['visual'],
      now: '2026-08-19T00:00:00Z',
      validUntil: '2099-01-01T00:00:00Z'
    })
    expect((await searchPublishedProducts(database, 'producto')).items[0]?.visual).toEqual({
      type: 'botella',
      color: '#64748b'
    })
  })
})

describe('public search HTTP boundary', () => {
  it('owns only the exact route and allows GET only', async () => {
    const { database } = await fixture()
    expect(
      await handlePublicSearchHttp(new Request('https://neteco.invalid/api/search/private'), { database })
    ).toBeNull()
    const response = await handlePublicSearchHttp(
      new Request('https://neteco.invalid/api/search', { method: 'POST' }),
      { database }
    )
    expect(response?.status).toBe(405)
    expect(response?.headers.get('Allow')).toBe('GET')
    expect(response?.headers.get('Cache-Control')).toBe('no-store')
  })

  it.each(['', '?q=a', '?q=++++'])('answers short/missing terms without touching D1: %s', async (query) => {
    const database = {
      prepare() {
        throw new Error('must not read')
      }
    } as unknown as D1Database
    const response = await handlePublicSearchHttp(new Request(`https://neteco.invalid/api/search${query}`), {
      database
    })
    expect(response?.status).toBe(200)
    expect(await response?.json()).toEqual({ items: [] })
  })

  it.each([`?q=${'x'.repeat(161)}`, '?q=a&q=b', '?q=abc%00', '?q=abc%0A'])(
    'rejects invalid terms without database reads: %s',
    async (query) => {
      const database = {
        prepare() {
          throw new Error('must not read')
        }
      } as unknown as D1Database
      const response = await handlePublicSearchHttp(new Request(`https://neteco.invalid/api/search${query}`), {
        database
      })
      expect(response?.status).toBe(400)
      expect(await response?.json()).toEqual({ error: { code: 'invalid_query' } })
      expect(response?.headers.get('Cache-Control')).toBe('no-store')
    }
  )

  it('serves public catalog without personalization/cookies; query cannot set the pricing instant', async () => {
    const { db, product, variant, database } = await fixture()
    product('p1', 'Producto')
    variant('v1', 'p1')
    db.exec(`INSERT INTO variant_price_versions(id,variant_id,gross_cents,valid_from,reason,created_at)
      VALUES ('future','v1',500,'2099-01-01T00:00:00Z','Precio futuro de prueba','2026-09-01T00:00:00Z')`)
    await provisionPublicationValidityFixture(database, {
      productIds: ['p1'],
      now: '2026-08-19T00:00:00Z',
      validUntil: '2099-01-01T00:00:00Z'
    })
    const response = await handlePublicSearchHttp(
      new Request('https://neteco.invalid/api/search?q=producto&instant=2099-02-01T00%3A00%3A00Z', {
        headers: { Cookie: 'private-session=ignored' }
      }),
      { database }
    )
    expect(response?.status).toBe(200)
    expect(response?.headers.get('Cache-Control')).toBe('private, no-store')
    expect(response?.headers.get('CDN-Cache-Control')).toBe('no-store')
    expect(response?.headers.has('Set-Cookie')).toBe(false)
    expect(((await response?.json()) as { items: { minPrice: number }[] }).items[0]?.minPrice).toBe(1210)
  })

  it('does not expose database failure details or cache errors', async () => {
    const database = {
      prepare() {
        throw new Error('SQL PRIVATE_TOKEN')
      }
    } as unknown as D1Database
    const response = await handlePublicSearchHttp(new Request('https://neteco.invalid/api/search?q=producto'), {
      database
    })
    expect(response?.status).toBe(500)
    expect(await response?.json()).toEqual({ error: { code: 'internal' } })
    expect(response?.headers.get('Cache-Control')).toBe('no-store')
  })
})

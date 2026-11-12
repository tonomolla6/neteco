import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import sharp from 'sharp'
import { renderD1CategorySeed, stableUuid } from '../../scripts/lib/d1-category-seed'
import { renderD1ProductSeed } from '../../scripts/lib/d1-product-seed'
import { renderD1InventorySeed } from '../../scripts/lib/d1-inventory-seed'
import { renderD1ShippingSeed } from '../../scripts/lib/d1-shipping-seed'
import {
  CATALOG_PDF_PARENT_CATEGORY_ID,
  loadCatalogPdf,
  planCatalogPdf,
  renewDemoSeedAuthority,
  type ImageStore
} from '../../scripts/lib/demo-catalog-pdf'
import { provisionPublicationValidityFixture } from '../support/publication-validity-fixture'
import { applyGeneratedSeed, d1OverSqlite, openAccountSecurityDatabase } from '../support/d1-sqlite'

const { default: worker } = await import('../../workers/canary')

const SOURCE = {
  productos: [
    {
      nombre: 'Olla alta con tapa',
      familia: 'Ollas y cazos',
      marca: 'Lacor',
      descripcion: 'Olla alta con tapa. Referencia 40121.',
      atributos_tecnicos: { serie: 'TriChef' },
      pagina_pdf: 40,
      pagina_impresa: 39,
      referencia_imagen: '40121',
      variantes: [
        { referencia: '40121', atributos: { diametro_cm: '20', capacidad_l: '5,50', unidad_venta: '1' }, precio: null },
        { referencia: '40125', atributos: { diametro_cm: '24', capacidad_l: '9,00', unidad_venta: '1' }, precio: null }
      ]
    },
    {
      nombre: 'Cubertería Garinox',
      familia: 'Cubiertos',
      marca: 'Garinox',
      descripcion: 'Cubiertos de acero inoxidable.',
      atributos_tecnicos: { marcados: ['RoHS', 'CE'] },
      pagina_pdf: 60,
      referencia_imagen: 'G100',
      variantes: [{ referencia: 'G100', atributos: { color: 'negro', unidad_venta: '12' }, precio: null }]
    },
    {
      nombre: 'Colador chino',
      familia: 'Coladores y escurridores',
      marca: 'Lacor',
      descripcion: 'Colador chino profesional.',
      pagina_pdf: 70,
      referencia_imagen: '62020',
      variantes: [{ referencia: '62020', atributos: {}, precio: null }]
    }
  ]
}

function store() {
  const objects = new Map<string, Uint8Array>()
  const bucket: ImageStore & { objects: typeof objects } = {
    objects,
    async head(key) {
      const value = objects.get(key)
      return value ? { size: value.byteLength } : null
    },
    async put(key, value) {
      if (objects.has(key)) return null
      objects.set(key, value)
      return { size: value.byteLength, etag: `etag-${objects.size}` } as R2Object
    }
  }
  return bucket
}
const jpeg = async (seed: number) =>
  new Uint8Array(
    await sharp({ create: { width: 64, height: 48, channels: 3, background: { r: seed, g: 90, b: 120 } } })
      .jpeg()
      .toBuffer()
  )
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')

describe('preproduction PDF catalogue loader', () => {
  let sqlite: DatabaseSync
  let database: D1Database
  let env: CloudflareEnv
  const api = async (path: string) => {
    const response = await worker.fetch(new Request(`https://neteco.invalid${path}`), env)
    return { status: response.status, body: (await response.json()) as Record<string, unknown> }
  }
  const readImage = async (reference: string) => jpeg(reference.length * 20)

  beforeEach(async () => {
    sqlite = await openAccountSecurityDatabase()
    for (const render of [renderD1CategorySeed, renderD1ProductSeed, renderD1InventorySeed, renderD1ShippingSeed])
      applyGeneratedSeed(sqlite, render())
    database = d1OverSqlite(sqlite)
    env = { DB: database, AUTH_ENABLED: 'false', REDSYS_ENABLED: 'false' } as CloudflareEnv
  })
  afterEach(() => sqlite.close())

  it('plans every family under the six Menaje y hostelería categories with MPN = reference', () => {
    const plan = planCatalogPdf(SOURCE)
    expect(plan.categories.map((category) => category.name)).toEqual([
      'Cocción y cacerolas',
      'Mesa y servicio',
      'Corte y preparación',
      'Repostería y moldes',
      'Termos, botellas y sifones',
      'Menaje de cocina'
    ])
    expect(plan.brands.map((brand) => brand.name)).toEqual(['Lacor', 'Garinox'])
    const variants = plan.products.flatMap((product) => product.variants)
    expect(variants.map((variant) => [variant.sku, variant.mpn])).toEqual([
      ['40121', '40121'],
      ['40125', '40125'],
      ['G100', 'G100'],
      ['62020', '62020']
    ])
    expect(variants[0]!.format).toBe('Diámetro 20 cm · Capacidad 5,50 l')
    expect(variants[2]).toMatchObject({ format: 'Color negro', unitsPerCase: 12 })
    expect(variants[3]!.format).toBe('Ref. 62020')
    expect(JSON.parse(plan.products[1]!.attributes).attrs).toContainEqual({ k: 'Marcados', v: 'RoHS, CE' })
    expect(() => planCatalogPdf({ productos: [{ ...SOURCE.productos[0], familia: 'Desconocida' }] })).toThrow(
      'catalog_pdf_family_unmapped'
    )
  })

  it('publishes the products as "Consultar precio" with brand, category and governed main image', async () => {
    const bucket = store()
    const now = iso(Date.now() - 60_000)
    const summary = await loadCatalogPdf(database, bucket, { source: SOURCE, readImage, now })
    expect(summary).toMatchObject({
      products: { planned: 3, inserted: 3 },
      variants: { planned: 4, inserted: 4 },
      images: { uploaded: 3, reused: 0 },
      authority: { policyCreated: true, assignments: 3, receipts: 3, publications: 3 }
    })
    expect(bucket.objects.size).toBe(3)

    const listing = await api('/api/products?limit=100&q=Olla')
    expect(listing.status).toBe(200)
    expect(JSON.stringify(listing.body)).toContain('olla-alta-con-tapa')

    const detail = await api('/api/products/olla-alta-con-tapa')
    expect(detail.status).toBe(200)
    const product = detail.body as {
      brand?: { name?: string } | string
      variants: Array<{ sku: string; price?: number; priceGrossCents?: number }>
    }
    expect(JSON.stringify(product)).toContain('Lacor')
    expect(product.variants.map((variant) => variant.sku).sort()).toEqual(['40121', '40125'])
    expect(JSON.stringify(product)).toMatch(/\/media\/[0-9a-f-]{36}\/image/)
    for (const variant of product.variants) expect(variant.price ?? variant.priceGrossCents ?? 0).toBe(0)

    const categories = sqlite
      .prepare('SELECT name FROM categories WHERE parent_id=? ORDER BY name')
      .all(CATALOG_PDF_PARENT_CATEGORY_ID)
      .map((row) => row.name)
    expect(categories).toEqual(
      expect.arrayContaining([
        'Cocción y cacerolas',
        'Mesa y servicio',
        'Corte y preparación',
        'Repostería y moldes',
        'Termos, botellas y sifones',
        'Menaje de cocina'
      ])
    )
    const byCategory = await api('/api/products?limit=100&category=mesa-y-servicio')
    expect(JSON.stringify(byCategory.body)).toContain('Cubertería Garinox')
  })

  it('is idempotent and renews only what would lapse, never overwriting existing rows', async () => {
    const bucket = store()
    const now = iso(Date.now() - 60_000)
    await loadCatalogPdf(database, bucket, { source: SOURCE, readImage, now })
    sqlite.prepare("UPDATE products SET name='Editado' WHERE slug='colador-chino'").run()
    const again = await loadCatalogPdf(database, bucket, { source: SOURCE, readImage, now })
    expect(again).toMatchObject({
      products: { inserted: 0 },
      variants: { inserted: 0 },
      images: { uploaded: 0, reused: 3 },
      authority: { policyCreated: false, assignments: 0, receipts: 0, publications: 0 }
    })
    expect(sqlite.prepare("SELECT name FROM products WHERE slug='colador-chino'").get()).toEqual({ name: 'Editado' })
    const later = await loadCatalogPdf(database, bucket, {
      source: SOURCE,
      readImage,
      now: iso(Date.parse(now) + 70 * 86400_000)
    })
    expect(later.authority).toMatchObject({ policyCreated: true, assignments: 3, receipts: 3, publications: 3 })
    expect(sqlite.prepare('SELECT count(*) AS n FROM auth_sessions WHERE revoked_at IS NULL').get()).toEqual({ n: 0 })
    expect(sqlite.prepare("SELECT count(*) AS n FROM role_permissions WHERE role_code='demo_bootstrap'").get()).toEqual(
      { n: 0 }
    )
  })

  it('refuses to load over a different row holding a planned slug or SKU', async () => {
    sqlite.prepare("UPDATE variants SET sku='40125' WHERE legacy_id=1").run()
    await expect(
      loadCatalogPdf(database, store(), { source: SOURCE, readImage, now: iso(Date.now() - 60_000) })
    ).rejects.toThrow('catalog_pdf_collision:variants.sku=40125')
  })
})

describe('demo seed publication authority renewal', () => {
  it('brings the expired synthetic seed back to the public catalogue (append-only)', async () => {
    const sqlite = await openAccountSecurityDatabase()
    try {
      for (const render of [renderD1CategorySeed, renderD1ProductSeed, renderD1InventorySeed, renderD1ShippingSeed])
        applyGeneratedSeed(sqlite, render())
      const database = d1OverSqlite(sqlite)
      const env = { DB: database, AUTH_ENABLED: 'false', REDSYS_ENABLED: 'false' } as CloudflareEnv
      // Remote state since 2026-10-10: seed policy and its 7-day media evidence both expired.
      const past = Date.now() - 40 * 86400_000
      const productIds = sqlite
        .prepare("SELECT id FROM products WHERE status='published'")
        .all()
        .map((row) => String(row.id))
      const { policyId } = await provisionPublicationValidityFixture(database, {
        productIds,
        now: iso(past),
        validUntil: iso(past + 7 * 86400_000),
        media: false
      })
      const actor = (
        sqlite.prepare('SELECT actor_id FROM catalog_publication_policies WHERE id=?').get(policyId) as {
          actor_id: string
        }
      ).actor_id
      const upload = stableUuid('demo:owned-illustration:v1')
      const checksum = 'a'.repeat(64)
      const key = `quarantine/${upload}/${checksum}`
      sqlite
        .prepare(
          `INSERT INTO media_uploads(id,actor_id,idempotency_key,payload_hash,checksum,object_key,filename,content_type,byte_size,
          width,height,alt,rights_owner,rights_license,rights_source,storage_status,r2_etag,created_at,stored_at)
          VALUES(?,?,'demo-owned-illustration-v1',?,?,?,'demo.png','image/png',100,800,800,'Ilustración DEMO','NETECO','Propia','{}','quarantined','etag',?,?)`
        )
        .run(upload, actor, checksum, checksum, key, iso(past), iso(past))
      sqlite
        .prepare(
          `INSERT INTO media_scan_receipts(id,upload_id,checksum,object_key,byte_size,verdict,scanner_version,scanned_at,expires_at,received_at,payload_hash)
          VALUES(?,?,?,?,100,'clean','synthetic',?,?,?,?)`
        )
        .run(crypto.randomUUID(), upload, checksum, key, iso(past), iso(past + 7 * 86400_000), iso(past), checksum)
      sqlite
        .prepare(
          `INSERT INTO media_rights_decisions(id,upload_id,decision,reason,actor_id,evidence_authorized_at,evidence_reference,
          rights_owner,rights_license,created_at,idempotency_key,payload_hash)
          VALUES(?,?,'approved','Ilustración propia',?,?,'demo','NETECO','Propia',?,'demo-rights',?)`
        )
        .run(crypto.randomUUID(), upload, actor, iso(past).slice(0, 10), iso(past), checksum)
      const total = async () =>
        (
          (await (await worker.fetch(new Request('https://neteco.invalid/api/products?limit=100'), env)).json()) as {
            total: number
          }
        ).total
      expect(await total()).toBe(0)
      const policies = (sqlite.prepare('SELECT count(*) AS n FROM catalog_publication_policies').get() as { n: number })
        .n
      const result = await renewDemoSeedAuthority(database, { now: iso(Date.now() - 60_000) })
      expect(result).toMatchObject({
        products: 20,
        renewed: { policyCreated: true, assignments: 20, receipts: 1, publications: 20 }
      })
      expect(await total()).toBe(20)
      expect((sqlite.prepare('SELECT count(*) AS n FROM catalog_publication_policies').get() as { n: number }).n).toBe(
        policies + 1
      )
    } finally {
      sqlite.close()
    }
  }, 60_000)
})

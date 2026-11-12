import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import sharp from 'sharp'
import { renderD1CategorySeed } from '../../scripts/lib/d1-category-seed'
import { renderD1ProductSeed } from '../../scripts/lib/d1-product-seed'
import { renderD1InventorySeed } from '../../scripts/lib/d1-inventory-seed'
import { renderD1ShippingSeed } from '../../scripts/lib/d1-shipping-seed'
import { CATALOG_PDF_GROUPS, loadCatalogPdf, type ImageStore } from '../../scripts/lib/demo-catalog-pdf'
import { applyCatalogPrices, planCatalogPrices } from '../../scripts/lib/demo-catalog-prices'
import { applyGeneratedSeed, d1OverSqlite, openAccountSecurityDatabase } from '../support/d1-sqlite'

const { default: worker } = await import('../../workers/canary')

const variant = (referencia: string, atributos: Record<string, string>) => ({ referencia, atributos, precio: null })
const SOURCE = {
  productos: [
    {
      nombre: 'Olla alta con tapa',
      familia: 'Ollas y cazos',
      marca: 'Lacor',
      descripcion: 'Olla alta con tapa. Referencia 40121.',
      pagina_pdf: 40,
      referencia_imagen: '40121',
      variantes: [
        variant('40121', { diametro_cm: '20', capacidad_l: '5,50', unidad_venta: '1' }),
        variant('40125', { diametro_cm: '24', capacidad_l: '9,00', unidad_venta: '1' }),
        variant('40129', { diametro_cm: '28', capacidad_l: '13,50', unidad_venta: '1' })
      ]
    },
    {
      nombre: 'Cubertería Garinox',
      familia: 'Cubiertos',
      marca: 'Garinox',
      descripcion: 'Cubiertos de acero inoxidable.',
      pagina_pdf: 60,
      referencia_imagen: 'G100',
      variantes: [variant('G100', { color: 'negro', unidad_venta: '12' }), variant('G101', { color: 'oro' })]
    },
    {
      nombre: 'Colador chino',
      familia: 'Coladores y escurridores',
      marca: 'Lacor',
      descripcion: 'Colador chino profesional.',
      pagina_pdf: 70,
      referencia_imagen: '62020',
      variantes: [variant('62020', {})]
    }
  ]
}

function store() {
  const objects = new Map<string, Uint8Array>()
  const bucket: ImageStore = {
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
const readImage = async (reference: string) =>
  new Uint8Array(
    await sharp({
      create: { width: 64, height: 48, channels: 3, background: { r: reference.length * 20, g: 90, b: 120 } }
    })
      .jpeg()
      .toBuffer()
  )
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')

describe('demo catalogue price table', () => {
  it('is deterministic, commercially rounded, grows with size and respects the unit of sale', () => {
    const first = planCatalogPrices(SOURCE)
    expect(planCatalogPrices(structuredClone(SOURCE))).toEqual(first)
    expect(first.map((row) => row.sku)).toEqual(['40121', '40125', '40129', 'G100', 'G101', '62020'])
    for (const row of first) {
      expect(row.grossCents % 100 === 0 || row.grossCents % 100 === 50 || row.grossCents % 100 === 95).toBe(true)
      expect(row.stock).toBeGreaterThanOrEqual(10)
      expect(row.stock).toBeLessThanOrEqual(120)
    }
    const pots = first.slice(0, 3).map((row) => row.grossCents)
    expect(pots[0]).toBeLessThan(pots[1]!)
    expect(pots[1]).toBeLessThan(pots[2]!)
    expect(pots[0]).toBeGreaterThanOrEqual(2500)
    expect(pots[2]).toBeLessThanOrEqual(18000)
    expect(first.find((row) => row.sku === 'G100')!.stock % 12).toBe(0)
    for (const row of first.filter((item) => item.family === 'Cubiertos'))
      expect(row.grossCents).toBeLessThanOrEqual(600)
  })

  it('has a price range for every catalogue family', () => {
    const families = Object.values(CATALOG_PDF_GROUPS).flat()
    const source = {
      productos: families.map((familia, index) => ({
        ...SOURCE.productos[2]!,
        familia,
        referencia_imagen: `F${index}`,
        variantes: [variant(`F${index}`, {})]
      }))
    }
    const rows = planCatalogPrices(source)
    expect(rows).toHaveLength(families.length)
    for (const row of rows) expect(row.grossCents).toBeGreaterThan(0)
  })
})

describe('demo catalogue price and stock loader', () => {
  let sqlite: DatabaseSync
  let database: D1Database
  let env: CloudflareEnv
  beforeEach(async () => {
    sqlite = await openAccountSecurityDatabase()
    for (const render of [renderD1CategorySeed, renderD1ProductSeed, renderD1InventorySeed, renderD1ShippingSeed])
      applyGeneratedSeed(sqlite, render())
    database = d1OverSqlite(sqlite)
    env = { DB: database, AUTH_ENABLED: 'false', REDSYS_ENABLED: 'false' } as CloudflareEnv
    await loadCatalogPdf(database, store(), { source: SOURCE, readImage, now: iso(Date.now() - 120_000) })
  })
  afterEach(() => sqlite.close())

  it('prices and stocks every variant through governed commands, idempotently', async () => {
    const now = iso(Date.now() - 60_000)
    const expected = planCatalogPrices(SOURCE)
    const summary = await applyCatalogPrices(database, { source: SOURCE, now })
    expect(summary).toMatchObject({ variants: 6, priced: 6, alreadyPriced: 0, stocked: 6, alreadyStocked: 0 })

    for (const row of expected) {
      const stored = sqlite
        .prepare(
          `SELECT p.gross_cents, p.status, b.physical_quantity FROM variants v
           JOIN variant_price_versions p ON p.variant_id=v.id JOIN inventory_balances b ON b.variant_id=v.id WHERE v.sku=?`
        )
        .all(row.sku)
      expect(stored).toEqual([{ gross_cents: row.grossCents, status: 'approved', physical_quantity: row.stock }])
    }
    expect(sqlite.prepare('SELECT count(*) AS n FROM catalog_price_audit').get()).toEqual({ n: 6 })
    expect(
      sqlite.prepare("SELECT count(*) AS n FROM inventory_movements WHERE reference_type='admin_inventory'").get()
    ).toEqual({
      n: 6
    })
    expect(sqlite.prepare('SELECT count(*) AS n FROM auth_sessions WHERE revoked_at IS NULL').get()).toEqual({ n: 0 })
    expect(sqlite.prepare("SELECT count(*) AS n FROM role_permissions WHERE role_code='demo_bootstrap'").get()).toEqual(
      {
        n: 0
      }
    )

    const detail = await worker.fetch(new Request('https://neteco.invalid/api/products/olla-alta-con-tapa'), env)
    const body = (await detail.json()) as { variants: Array<{ sku: string; price?: number; priceGrossCents?: number }> }
    for (const item of body.variants) {
      const row = expected.find((candidate) => candidate.sku === item.sku)!
      expect(item.priceGrossCents ?? item.price).toBe(row.grossCents)
    }

    const count = (table: string) => (sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n
    const versions = count('variant_price_versions')
    const movements = count('inventory_movements')
    const again = await applyCatalogPrices(database, { source: SOURCE, now: iso(Date.parse(now) + 3600_000) })
    expect(again).toMatchObject({ priced: 0, alreadyPriced: 6, stocked: 0, alreadyStocked: 6 })
    expect(count('variant_price_versions')).toBe(versions)
    expect(count('inventory_movements')).toBe(movements)
    expect(count('catalog_price_commands')).toBe(6)
  }, 60_000)
})

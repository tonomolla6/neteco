import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { seedInventoryFixture } from '../support/d1-sqlite'
import { provisionPublicationValidityFixture } from '../support/publication-validity-fixture'
import { executeD1CatalogTypedAttributeDefinitionCommand } from '../../workers/catalog/typed-attribute-definitions'
import { categoryCommandFixture, CATEGORY_CLAIMS } from '../support/category-command-fixture'
import {
  getProductsComparison,
  parseCompareSlugs,
  normalizeCompareUnit,
  compareAttributeValues,
  InvalidCompareRequestError,
  CompareProductNotFoundError
} from '../../workers/catalog/product-compare'

const INSTANT = '2026-08-20T00:00:00Z'
const REASON = 'Definición para comparador de productos'

describe('D1 Product Compare Engine', () => {
  let sqlite: DatabaseSync
  let database: D1Database
  let slug1: string
  let slug2: string
  let slug3: string
  let slug4: string
  let id1: string
  let id2: string

  beforeEach(async () => {
    ;({ sqlite, database } = await categoryCommandFixture())
    if (!sqlite.prepare("SELECT 1 FROM sqlite_schema WHERE name='catalog_typed_attribute_definitions'").get()) {
      sqlite.exec(
        await readFile(new URL('../../db/d1/migrations/0058_catalog_typed_attributes.sql', import.meta.url), 'utf8')
      )
    }
    seedInventoryFixture(sqlite)

    const publishedRows = sqlite
      .prepare("SELECT id, slug FROM products WHERE status='published' ORDER BY legacy_id LIMIT 4")
      .all() as Array<{ id: string; slug: string }>
    id1 = publishedRows[0]!.id
    slug1 = publishedRows[0]!.slug
    id2 = publishedRows[1]!.id
    slug2 = publishedRows[1]!.slug
    slug3 = publishedRows[2]!.slug
    slug4 = publishedRows[3]!.slug

    await provisionPublicationValidityFixture(database, {
      productIds: ['p-1', 'p-2', 'p-3', 'p-4', 'p-5', 'p-6'],
      now: '2026-08-19T00:00:00Z',
      validUntil: '2099-01-01T00:00:00Z'
    })
  })

  afterEach(() => sqlite.close())

  async function createDefinition(kind: 'text' | 'number' | 'unit' | 'boolean' | 'list', config: unknown, code = kind) {
    const cat = sqlite
      .prepare('SELECT c.legacy_id FROM products p JOIN categories c ON c.id=p.category_id WHERE p.id=?')
      .get(id1) as { legacy_id: number }
    return (
      await executeD1CatalogTypedAttributeDefinitionCommand(
        database,
        CATEGORY_CLAIMS,
        'create',
        {},
        {
          categoryId: cat.legacy_id,
          code,
          kind,
          label: `Atributo ${code}`,
          config: config as never,
          expectedVersion: 0,
          reason: REASON
        },
        { idempotencyKey: crypto.randomUUID() }
      )
    ).definition
  }

  function setTypedAttributes(
    productId: string,
    entries: Array<{ definition: { id: string; revision: number }; value: unknown }>
  ) {
    sqlite.prepare("UPDATE products SET attributes=json_set(attributes, '$.typed', json(?)) WHERE id=?").run(
      JSON.stringify({
        version: 1,
        values: entries.map((entry) => ({
          definitionId: entry.definition.id,
          revision: entry.definition.revision,
          value: entry.value
        }))
      }),
      productId
    )
  }

  describe('slug parsing and validation', () => {
    it('accepts 2 to 4 valid distinct slugs', () => {
      expect(parseCompareSlugs('a,b')).toEqual({ success: true, slugs: ['a', 'b'] })
      expect(parseCompareSlugs(['a', 'b', 'c'])).toEqual({ success: true, slugs: ['a', 'b', 'c'] })
      expect(parseCompareSlugs('a,b,c,d')).toEqual({ success: true, slugs: ['a', 'b', 'c', 'd'] })
    })

    it('rejects fewer than 2 slugs', () => {
      expect(parseCompareSlugs('a')).toEqual({ success: false, error: 'min_products_required' })
      expect(parseCompareSlugs('')).toEqual({ success: false, error: 'invalid_slugs' })
      expect(parseCompareSlugs([])).toEqual({ success: false, error: 'invalid_slugs' })
    })

    it('rejects more than 4 slugs', () => {
      expect(parseCompareSlugs('a,b,c,d,e')).toEqual({ success: false, error: 'max_products_exceeded' })
      expect(parseCompareSlugs(['a', 'b', 'c', 'd', 'e'])).toEqual({ success: false, error: 'max_products_exceeded' })
    })

    it('rejects duplicate slugs', () => {
      expect(parseCompareSlugs('a,a')).toEqual({ success: false, error: 'duplicate_slugs' })
      expect(parseCompareSlugs(['a', 'b', 'a'])).toEqual({ success: false, error: 'duplicate_slugs' })
    })

    it('rejects malformed slugs', () => {
      expect(parseCompareSlugs('a/b,c')).toEqual({ success: false, error: 'invalid_slug_format' })
      expect(parseCompareSlugs('../secret,a')).toEqual({ success: false, error: 'invalid_slug_format' })
      expect(parseCompareSlugs('UPPER,lower')).toEqual({ success: false, error: 'invalid_slug_format' })
    })
  })

  describe('unit normalization and convertibility', () => {
    it('normalizes volume units to liters (l)', () => {
      const ml = normalizeCompareUnit(500, 'ml')
      const l = normalizeCompareUnit(0.5, 'l')
      expect(ml.canonicalQuantity).toBe(0.5)
      expect(ml.canonicalUnit).toBe('l')
      expect(ml.family).toBe('volume')
      expect(l.canonicalQuantity).toBe(0.5)
      expect(ml.canonicalQuantity).toBe(l.canonicalQuantity)
    })

    it('normalizes mass units to kilograms (kg)', () => {
      const g = normalizeCompareUnit(2500, 'g')
      const kg = normalizeCompareUnit(2.5, 'kg')
      expect(g.canonicalQuantity).toBe(2.5)
      expect(g.canonicalUnit).toBe('kg')
      expect(g.family).toBe('mass')
      expect(g.canonicalQuantity).toBe(kg.canonicalQuantity)
    })

    it('normalizes length units to meters (m)', () => {
      const mm = normalizeCompareUnit(1500, 'mm')
      const cm = normalizeCompareUnit(150, 'cm')
      const m = normalizeCompareUnit(1.5, 'm')
      expect(mm.canonicalQuantity).toBe(1.5)
      expect(cm.canonicalQuantity).toBe(1.5)
      expect(m.canonicalQuantity).toBe(1.5)
      expect(mm.canonicalUnit).toBe('m')
      expect(mm.family).toBe('length')
    })

    it('detects incomparable units between different families', () => {
      const vol = normalizeCompareUnit(1, 'l')
      const mass = normalizeCompareUnit(1, 'kg')
      expect(vol.family).not.toBe(mass.family)
    })
  })

  describe('comparison resolution and differences highlighting', () => {
    it('marks identical convertible unit values as equal with no difference', () => {
      const values = [
        { productSlug: 'p1', present: true, value: { quantity: 1000, unit: 'ml' as const }, kind: 'unit' as const },
        { productSlug: 'p2', present: true, value: { quantity: 1, unit: 'l' as const }, kind: 'unit' as const }
      ]
      const result = compareAttributeValues(values, 'unit')
      expect(result.comparable).toBe(true)
      expect(result.hasDifference).toBe(false)
      expect(result.items[0]!.canonicalQuantity).toBe(1)
      expect(result.items[1]!.canonicalQuantity).toBe(1)
    })

    it('marks different convertible unit values as having difference', () => {
      const values = [
        { productSlug: 'p1', present: true, value: { quantity: 500, unit: 'ml' as const }, kind: 'unit' as const },
        { productSlug: 'p2', present: true, value: { quantity: 1, unit: 'l' as const }, kind: 'unit' as const }
      ]
      const result = compareAttributeValues(values, 'unit')
      expect(result.comparable).toBe(true)
      expect(result.hasDifference).toBe(true)
      expect(result.items[0]!.isDifferent).toBe(true)
      expect(result.items[1]!.isDifferent).toBe(true)
    })

    it('marks incomparable unit values as comparable=false and hasDifference=false', () => {
      const values = [
        { productSlug: 'p1', present: true, value: { quantity: 1, unit: 'l' as const }, kind: 'unit' as const },
        { productSlug: 'p2', present: true, value: { quantity: 1, unit: 'kg' as const }, kind: 'unit' as const }
      ]
      const result = compareAttributeValues(values, 'unit')
      expect(result.comparable).toBe(false)
      expect(result.hasDifference).toBe(false)
      expect(result.items[0]!.isDifferent).toBe(false)
      expect(result.items[1]!.isDifferent).toBe(false)
    })

    it('marks absent attributes as "no indicado" and never considers them equal to anything', () => {
      const values = [
        { productSlug: 'p1', present: true, value: 7, kind: 'number' as const },
        { productSlug: 'p2', present: false, value: null, kind: 'number' as const }
      ]
      const result = compareAttributeValues(values, 'number')
      expect(result.comparable).toBe(true)
      expect(result.hasDifference).toBe(false) // Only 1 present value, so no difference between present values
      expect(result.items[1]!.displayValue).toBe('no indicado')
      expect(result.items[1]!.present).toBe(false)
      expect(result.items[1]!.isDifferent).toBe(false)
    })

    it('does not consider two absent attributes as equal', () => {
      const values = [
        { productSlug: 'p1', present: false, value: null, kind: 'number' as const },
        { productSlug: 'p2', present: false, value: null, kind: 'number' as const }
      ]
      const result = compareAttributeValues(values, 'number')
      expect(result.hasDifference).toBe(false)
      expect(result.items[0]!.displayValue).toBe('no indicado')
      expect(result.items[1]!.displayValue).toBe('no indicado')
    })

    it('highlights differences between present values even when third product is absent', () => {
      const values = [
        { productSlug: 'p1', present: true, value: 5, kind: 'number' as const },
        { productSlug: 'p2', present: true, value: 10, kind: 'number' as const },
        { productSlug: 'p3', present: false, value: null, kind: 'number' as const }
      ]
      const result = compareAttributeValues(values, 'number')
      expect(result.hasDifference).toBe(true)
      expect(result.items[0]!.isDifferent).toBe(true)
      expect(result.items[1]!.isDifferent).toBe(true)
      expect(result.items[2]!.isDifferent).toBe(false) // absent value is not highlighted as different
      expect(result.items[2]!.displayValue).toBe('no indicado')
    })

    it('does not highlight differences when all present values are identical, with one absent', () => {
      const values = [
        { productSlug: 'p1', present: true, value: 7, kind: 'number' as const },
        { productSlug: 'p2', present: true, value: 7, kind: 'number' as const },
        { productSlug: 'p3', present: false, value: null, kind: 'number' as const }
      ]
      const result = compareAttributeValues(values, 'number')
      expect(result.hasDifference).toBe(false)
      expect(result.items[0]!.isDifferent).toBe(false)
      expect(result.items[1]!.isDifferent).toBe(false)
      expect(result.items[2]!.isDifferent).toBe(false)
    })
  })

  describe('getProductsComparison endpoint query behavior', () => {
    it('returns comparison for 2 published products with prices, formats and availability', async () => {
      const comparison = await getProductsComparison(database, [slug1, slug2], { instant: INSTANT })
      expect(comparison.products).toHaveLength(2)
      expect(comparison.products[0]!.slug).toBe(slug1)
      expect(comparison.products[1]!.slug).toBe(slug2)
      expect(comparison.products[0]!.minPrice).toBeGreaterThan(0)
      expect(comparison.products[0]!.formats.length).toBeGreaterThan(0)
      expect(comparison.products[0]!.availability).toMatch(/in_stock|out_of_stock|backorder/)
    })

    it('returns comparison for 4 published products', async () => {
      const comparison = await getProductsComparison(database, [slug1, slug2, slug3, slug4], { instant: INSTANT })
      expect(comparison.products).toHaveLength(4)
      expect(comparison.products.map((p) => p.slug)).toEqual([slug1, slug2, slug3, slug4])
    })

    it('fails with CompareProductNotFoundError when product does not exist', async () => {
      await expect(
        getProductsComparison(database, [slug1, 'producto-inexistente'], { instant: INSTANT })
      ).rejects.toThrow(CompareProductNotFoundError)
    })

    it('fails with CompareProductNotFoundError when product is draft, without leaking draft status', async () => {
      sqlite.prepare("UPDATE products SET status='draft' WHERE slug=?").run(slug2)
      await expect(getProductsComparison(database, [slug1, slug2], { instant: INSTANT })).rejects.toThrow(
        CompareProductNotFoundError
      )
    })

    it('fails with CompareProductNotFoundError when category is draft', async () => {
      const catId = sqlite.prepare('SELECT category_id FROM products WHERE slug=?').get(slug2) as {
        category_id: string
      }
      sqlite.prepare("UPDATE categories SET status='draft' WHERE id=?").run(catId.category_id)
      await expect(getProductsComparison(database, [slug1, slug2], { instant: INSTANT })).rejects.toThrow(
        CompareProductNotFoundError
      )
    })

    it('fails with InvalidCompareRequestError when fewer than 2 slugs provided', async () => {
      await expect(getProductsComparison(database, [slug1], { instant: INSTANT })).rejects.toThrow(
        InvalidCompareRequestError
      )
    })

    it('fails with InvalidCompareRequestError when duplicate slugs provided', async () => {
      await expect(getProductsComparison(database, [slug1, slug1], { instant: INSTANT })).rejects.toThrow(
        InvalidCompareRequestError
      )
    })

    it('compares typed attributes correctly in the matrix', async () => {
      const defUnit = await createDefinition('unit', { precision: 2, units: ['ml', 'l'] }, 'capacidad')
      const defNum = await createDefinition('number', { precision: 1, min: 0, max: 14 }, 'ph')

      setTypedAttributes(id1, [
        { definition: defUnit, value: { quantity: 1000, unit: 'ml' } },
        { definition: defNum, value: 7.0 }
      ])
      setTypedAttributes(id2, [
        { definition: defUnit, value: { quantity: 1, unit: 'l' } },
        { definition: defNum, value: 11.5 }
      ])

      const comparison = await getProductsComparison(database, [slug1, slug2], { instant: INSTANT })
      const capacidadRow = comparison.rows.find((r) => r.code === 'capacidad')
      const phRow = comparison.rows.find((r) => r.code === 'ph')

      expect(capacidadRow).toBeDefined()
      expect(capacidadRow!.comparable).toBe(true)
      expect(capacidadRow!.hasDifference).toBe(false) // 1000 ml == 1 l

      expect(phRow).toBeDefined()
      expect(phRow!.comparable).toBe(true)
      expect(phRow!.hasDifference).toBe(true) // 7.0 != 11.5
      expect(phRow!.values[0]!.isDifferent).toBe(true)
      expect(phRow!.values[1]!.isDifferent).toBe(true)
    })

    it('presents regulatory safety disclosures without declaring a winner or better product', async () => {
      sqlite
        .prepare(
          "UPDATE products SET regulatory=json_set(regulatory, '$.pictograms', json('[\"GHS05\",\"GHS07\"]'), '$.hazardStatements', json('[\"H314 Provoca quemaduras graves\"]'), '$.signalWord', 'Peligro') WHERE id=?"
        )
        .run(id1)
      sqlite
        .prepare(
          "UPDATE products SET regulatory=json_set(regulatory, '$.pictograms', json('[]'), '$.hazardStatements', json('[]'), '$.signalWord', null) WHERE id=?"
        )
        .run(id2)

      const comparison = await getProductsComparison(database, [slug1, slug2], { instant: INSTANT })
      expect(comparison.products[0]!.regulatory.pictograms).toEqual(['GHS05', 'GHS07'])
      expect(comparison.products[0]!.regulatory.hazardStatements).toEqual(['H314 Provoca quemaduras graves'])
      expect(comparison.products[0]!.regulatory.signalWord).toBe('Peligro')

      // Regulatory rows must exist, be factual and have no winner
      const regRows = comparison.rows.filter((r) => r.group === 'regulatory')
      expect(regRows.length).toBeGreaterThan(0)
      for (const row of regRows) {
        expect(row.comparable).toBe(false)
        expect(row.hasWinner).toBe(false)
      }
    })
  })
})

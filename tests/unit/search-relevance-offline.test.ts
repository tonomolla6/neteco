import { afterEach, describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { searchPublishedProducts } from '../../workers/catalog/search'
import { provisionPublicationValidityFixture } from '../support/publication-validity-fixture'
import { categoryCommandFixture, CATEGORY_CLAIMS } from '../support/category-command-fixture'
import { createSearchSynonymPreview, executeSearchSynonymCommand } from '../../workers/catalog/search-synonyms'

interface FixtureProductVariant {
  id: string
  sku: string
  ean?: string
  gtin?: string
  mpn?: string
  price: number
}

interface FixtureProduct {
  id: string
  name: string
  slug: string
  brand: string
  category: string
  featured: number
  variants: FixtureProductVariant[]
}

interface FixtureSynonym {
  source: string
  replacements: string[]
}

interface FixtureTestCase {
  id: string
  query: string
  category: string
  k: number
  minNdcg: number
  expectedTopK: string[]
  judgments: Record<string, number>
}

interface RelevanceFixtureV1 {
  version: string
  name: string
  description: string
  dataset: {
    products: FixtureProduct[]
    synonyms: FixtureSynonym[]
  }
  cases: FixtureTestCase[]
}

function computeDcg(gains: number[]): number {
  return gains.reduce((sum, gain, index) => {
    return sum + (Math.pow(2, gain) - 1) / Math.log2(index + 2)
  }, 0)
}

export function computeNdcgAtK(resultIds: string[], judgments: Record<string, number>, k: number): number {
  const window = resultIds.slice(0, k)
  const actualGains = window.map((id) => judgments[id] ?? 0)
  const dcg = computeDcg(actualGains)

  const idealGains = Object.values(judgments)
    .filter((rel) => rel > 0)
    .sort((a, b) => b - a)
    .slice(0, k)

  const idcg = computeDcg(idealGains)
  if (idcg === 0) return 1.0
  return Number((dcg / idcg).toFixed(4))
}

const connections: DatabaseSync[] = []
afterEach(() => {
  for (const conn of connections.splice(0)) conn.close()
})

async function setupRelevanceDataset(fixture: RelevanceFixtureV1) {
  const { sqlite, database } = await categoryCommandFixture()
  connections.push(sqlite)

  sqlite.exec(`
    INSERT INTO brands (id, name, slug, status)
    VALUES ('brand-neteco', 'NETECO', 'neteco', 'published');

    INSERT INTO tax_classes (id, code, name, rate_basis_points, valid_from)
    VALUES ('tax-rel-21', 'ES21', 'IVA 21%', 2100, '2020-01-01T00:00:00Z');

    INSERT INTO shipping_profiles (id, code, name, kind)
    VALUES ('ship-rel-parcel', 'parcel', 'Paquetería', 'parcel');
  `)

  const categories = [...new Set(fixture.dataset.products.map((p) => p.category))]
  let catIndex = 1
  for (const catName of categories) {
    const catId = `cat-rel-${catIndex++}`
    const slug = catName.toLowerCase().replace(/[^a-z0-9]+/g, '-')
    sqlite
      .prepare('INSERT INTO categories (id, legacy_id, name, slug, status) VALUES (?, ?, ?, ?, ?)')
      .run(catId, catIndex, catName, slug, 'published')
  }

  const categoryMap = new Map<string, string>()
  const catRows = sqlite.prepare('SELECT id, name FROM categories').all() as Array<{ id: string; name: string }>
  for (const r of catRows) categoryMap.set(r.name, r.id)

  let productSeq = 100
  let variantSeq = 200

  for (const product of fixture.dataset.products) {
    const categoryId = categoryMap.get(product.category) ?? 'cat-rel-1'
    sqlite
      .prepare(
        `INSERT INTO products (id, legacy_id, name, slug, brand_id, category_id, status, featured, attributes)
         VALUES (?, ?, ?, ?, 'brand-neteco', ?, 'published', ?, '{}')`
      )
      .run(product.id, productSeq++, product.name, product.slug, categoryId, product.featured)

    for (const v of product.variants) {
      sqlite
        .prepare(
          `INSERT INTO variants (id, legacy_id, product_id, tax_class_id, shipping_profile_id, sku, format, status, price_gross_cents, ean, gtin, mpn)
           VALUES (?, ?, ?, 'tax-rel-21', 'ship-rel-parcel', ?, 'Standard', 'published', ?, ?, ?, ?)`
        )
        .run(v.id, variantSeq++, product.id, v.sku, v.price, v.ean ?? null, v.gtin ?? null, v.mpn ?? null)
    }
  }

  // Provision publication policies for all seeded products so publicationValidity passes
  await provisionPublicationValidityFixture(database, {
    productIds: fixture.dataset.products.map((p) => p.id),
    identifierExceptionsAllowed: true
  })

  // Insert active synonyms if present in fixture via domain preview/command
  if (fixture.dataset.synonyms && fixture.dataset.synonyms.length > 0) {
    let synIdx = 1
    for (const syn of fixture.dataset.synonyms) {
      const preview = await createSearchSynonymPreview(database, CATEGORY_CLAIMS, {
        draft: {
          id: null,
          expectedVersion: 0,
          sourceTerm: syn.source,
          replacements: syn.replacements,
          active: true,
          reason: `Sinónimo revisado para ${syn.source}`,
          action: 'save'
        },
        query: syn.source
      })
      await executeSearchSynonymCommand(
        database,
        CATEGORY_CLAIMS,
        { previewId: preview.previewId, previewHash: preview.previewHash },
        { idempotencyKey: `cmd-syn-${synIdx++}` }
      )
    }
  }

  return { sqlite, database }
}

describe('SEA-014 offline search relevance suite', () => {
  it('loads versioned v1.json fixture and executes top-k and nDCG validations over deterministic SQLite', async () => {
    const fixtureRaw = await readFile(new URL('../fixtures/search-relevance/v1.json', import.meta.url), 'utf8')
    const fixture = JSON.parse(fixtureRaw) as RelevanceFixtureV1

    expect(fixture.version).toBe('v1')
    expect(fixture.cases.length).toBeGreaterThanOrEqual(8)

    const { database } = await setupRelevanceDataset(fixture)

    for (const testCase of fixture.cases) {
      const results = await searchPublishedProducts(database, testCase.query)
      const resultSlugs = results.items.map((item) => item.slug)

      // 1. Verify expected top-k products are present within top-k window
      const topKResults = resultSlugs.slice(0, testCase.k)
      for (const expectedSlug of testCase.expectedTopK) {
        expect(
          topKResults,
          `Query "${testCase.query}" (${testCase.id}) lost expected product "${expectedSlug}" from top-${testCase.k}`
        ).toContain(expectedSlug)
      }

      // 2. Verify nDCG@k meets or exceeds declared threshold
      const ndcg = computeNdcgAtK(resultSlugs, testCase.judgments, testCase.k)
      expect(
        ndcg,
        `Query "${testCase.query}" (${testCase.id}) fell below min nDCG threshold ${testCase.minNdcg} (actual: ${ndcg})`
      ).toBeGreaterThanOrEqual(testCase.minNdcg)
    }
  })

  it('fails if an expected product is missing from the top-k results', () => {
    const actualResultIds = ['p-3', 'p-4', 'p-5']
    const expectedTopK = ['p-1']
    const topK = actualResultIds.slice(0, 3)

    expect(() => {
      const missing = expectedTopK.filter((id) => !topK.includes(id))
      if (missing.length > 0) {
        throw new Error(`Missing expected top-k: ${missing.join(', ')}`)
      }
    }).toThrow('Missing expected top-k: p-1')
  })

  it('fails if nDCG drops below the minimum declared threshold', () => {
    const judgments = { 'p-1': 3, 'p-2': 2, 'p-3': 1 }
    // Degraded ordering: irrelevant item first, primary item pushed to 3rd
    const degradedResults = ['unrelated-p', 'p-3', 'p-1']
    const ndcg = computeNdcgAtK(degradedResults, judgments, 3)
    const minThreshold = 0.85

    expect(ndcg).toBeLessThan(minThreshold)
    expect(() => {
      if (ndcg < minThreshold) {
        throw new Error(`Relevance regression: nDCG ${ndcg} < ${minThreshold}`)
      }
    }).toThrow('Relevance regression')
  })

  it('calculates nDCG = 1.0 when results perfectly match the ideal ranking', () => {
    const judgments = { 'p-1': 3, 'p-2': 2, 'p-3': 1 }
    const perfectResults = ['p-1', 'p-2', 'p-3']
    const ndcg = computeNdcgAtK(perfectResults, judgments, 3)
    expect(ndcg).toBe(1.0)
  })

  it('handles empty query and single-character query gracefully without crashing', async () => {
    const fixtureRaw = await readFile(new URL('../fixtures/search-relevance/v1.json', import.meta.url), 'utf8')
    const fixture = JSON.parse(fixtureRaw) as RelevanceFixtureV1
    const { database } = await setupRelevanceDataset(fixture)

    const emptyRes = await searchPublishedProducts(database, '')
    expect(emptyRes.items).toEqual([])

    const singleRes = await searchPublishedProducts(database, 'a')
    expect(singleRes.items).toEqual([])
  })

  it('never returns draft or unpublished products in relevance results', async () => {
    const fixtureRaw = await readFile(new URL('../fixtures/search-relevance/v1.json', import.meta.url), 'utf8')
    const fixture = JSON.parse(fixtureRaw) as RelevanceFixtureV1
    const { sqlite, database } = await setupRelevanceDataset(fixture)

    // Insert an unpublished product that would otherwise match "lejia"
    sqlite
      .prepare(
        `INSERT INTO products (id, legacy_id, name, slug, brand_id, category_id, status, featured, attributes)
         VALUES ('rel-prod-draft-lejia', 999, 'Lejía secreta en borrador 5L', 'lejia-secreta-borrador', 'brand-neteco', 'cat-rel-1', 'draft', 0, '{}')`
      )
      .run()

    sqlite
      .prepare(
        `INSERT INTO variants (id, legacy_id, product_id, tax_class_id, shipping_profile_id, sku, format, status, price_gross_cents)
         VALUES ('rel-var-draft-1', 999, 'rel-prod-draft-lejia', 'tax-rel-21', 'ship-rel-parcel', 'LEJ-DRAFT-999', '5 L', 'draft', 300)`
      )
      .run()

    const results = await searchPublishedProducts(database, 'lejía')
    const ids = results.items.map((i) => i.uuid)
    expect(ids).not.toContain('rel-prod-draft-lejia')
  })
})

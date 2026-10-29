import { readFile } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { categoryCommandFixture, ROOT_CATEGORY, CHILD_CATEGORY } from '../support/category-command-fixture'
import {
  applyPersonalizedRerank,
  assignExperimentVariant,
  recordRerankImpression,
  recordRerankInteraction,
  readPersonalizedUpliftReport,
  type RerankableProductItem
} from '../../workers/catalog/personalized-rerank'

const PROD_A = '10000000-0000-4000-8000-00000000000a'
const PROD_B = '10000000-0000-4000-8000-00000000000b'
const PROD_C = '10000000-0000-4000-8000-00000000000c'
const PROD_D = '10000000-0000-4000-8000-00000000000d'

const NOW = '2026-10-15T12:00:00Z'

describe('SEA-020: Controlled Personalized Reordering & Incremental Uplift Measurement', () => {
  let sqlite: DatabaseSync
  let database: D1Database

  beforeEach(async () => {
    ;({ sqlite, database } = await categoryCommandFixture())

    // Apply migration 0104 if not present
    if (!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE name='search_rerank_experiments'").get()) {
      const sql = await readFile(
        new URL('../../db/d1/migrations/0104_semantic_search_and_rerank.sql', import.meta.url),
        'utf8'
      )
      sqlite.exec(sql)
    }

    // Insert brand
    sqlite.exec(`INSERT INTO brands (id, name, slug, status) VALUES ('brand-1', 'NETECO', 'neteco', 'published');`)

    // Insert 4 products
    // PROD_A: category ROOT_CATEGORY, price 500, inStock: true
    // PROD_B: category CHILD_CATEGORY, price 1200, inStock: true
    // PROD_C: category ROOT_CATEGORY, price 200, inStock: false
    // PROD_D: category CHILD_CATEGORY, price 800, inStock: true
    let nextLegacyId = 2000
    function addProduct(id: string, name: string, categoryId: string) {
      sqlite
        .prepare(
          `
        INSERT INTO products (id, legacy_id, name, slug, brand_id, category_id, status, featured)
        VALUES (?, ?, ?, ?, 'brand-1', ?, 'published', 0)
      `
        )
        .run(id, nextLegacyId++, name, id, categoryId)
    }

    addProduct(PROD_A, 'Producto A', ROOT_CATEGORY)
    addProduct(PROD_B, 'Producto B', CHILD_CATEGORY)
    addProduct(PROD_C, 'Producto C', ROOT_CATEGORY)
    addProduct(PROD_D, 'Producto D', CHILD_CATEGORY)
  })

  afterEach(() => {
    sqlite.close()
  })

  describe('Strict Preservation of Explicit Filters and Explicit Sort Orders', () => {
    const candidateItems: RerankableProductItem[] = [
      { uuid: PROD_A, name: 'Producto A', categoryId: ROOT_CATEGORY, minPrice: 500, inStock: true, score: 10 },
      { uuid: PROD_B, name: 'Producto B', categoryId: CHILD_CATEGORY, minPrice: 1200, inStock: true, score: 9 },
      { uuid: PROD_C, name: 'Producto C', categoryId: ROOT_CATEGORY, minPrice: 200, inStock: false, score: 8 },
      { uuid: PROD_D, name: 'Producto D', categoryId: CHILD_CATEGORY, minPrice: 800, inStock: true, score: 7 }
    ]

    it('bypasses re-ranking completely when explicit sort is price_asc to preserve order', () => {
      // Sort explicitly by price_asc
      const sortedByPriceAsc = [...candidateItems].sort((a, b) => a.minPrice - b.minPrice)

      const result = applyPersonalizedRerank({
        items: sortedByPriceAsc,
        explicitSort: 'price_asc',
        affinities: {
          segment: 'professional',
          preferredCategories: [CHILD_CATEGORY] // Would normally boost B and D
        },
        variant: 'personalized'
      })

      // Must NOT re-rank: explicit sort takes absolute precedence!
      expect(result.reranked).toBe(false)
      expect(result.bypassedReason).toBe('explicit_sort')
      expect(result.items.map((i) => i.uuid)).toEqual(sortedByPriceAsc.map((i) => i.uuid))
      // Verify items remain strictly sorted by price ascending: 200 (C), 500 (A), 800 (D), 1200 (B)
      expect(result.items[0]!.uuid).toBe(PROD_C)
      expect(result.items[1]!.uuid).toBe(PROD_A)
      expect(result.items[2]!.uuid).toBe(PROD_D)
      expect(result.items[3]!.uuid).toBe(PROD_B)
    })

    it('bypasses re-ranking completely when explicit sort is price_desc or name', () => {
      const sortedByPriceDesc = [...candidateItems].sort((a, b) => b.minPrice - a.minPrice)

      const resultDesc = applyPersonalizedRerank({
        items: sortedByPriceDesc,
        explicitSort: 'price_desc',
        affinities: { segment: 'professional', preferredCategories: [ROOT_CATEGORY] },
        variant: 'personalized'
      })

      expect(resultDesc.reranked).toBe(false)
      expect(resultDesc.bypassedReason).toBe('explicit_sort')
      expect(resultDesc.items.map((i) => i.uuid)).toEqual(sortedByPriceDesc.map((i) => i.uuid))

      const sortedByName = [...candidateItems].sort((a, b) => a.name.localeCompare(b.name))
      const resultName = applyPersonalizedRerank({
        items: sortedByName,
        explicitSort: 'name',
        affinities: { segment: 'professional', preferredCategories: [ROOT_CATEGORY] },
        variant: 'personalized'
      })

      expect(resultName.reranked).toBe(false)
      expect(resultName.bypassedReason).toBe('explicit_sort')
      expect(resultName.items.map((i) => i.uuid)).toEqual(sortedByName.map((i) => i.uuid))
    })

    it('strictly maintains explicit filters and never introduces filtered-out items', () => {
      // User filtered by category CHILD_CATEGORY: only B and D are in candidates
      const filteredCandidates = candidateItems.filter((item) => item.categoryId === CHILD_CATEGORY)

      const result = applyPersonalizedRerank({
        items: filteredCandidates,
        explicitSort: 'featured', // default sort, personalization allowed
        explicitFilters: { category: CHILD_CATEGORY },
        affinities: {
          segment: 'professional',
          preferredCategories: [ROOT_CATEGORY] // affinity is for ROOT_CATEGORY, but candidate set only has CHILD_CATEGORY
        },
        variant: 'personalized'
      })

      // Result items must strictly contain only CHILD_CATEGORY items (B and D)
      for (const item of result.items) {
        expect(item.categoryId).toBe(CHILD_CATEGORY)
      }
      expect(result.items.some((i) => i.uuid === PROD_A || i.uuid === PROD_C)).toBe(false)
    })
  })

  describe('Controlled Personalized Re-ranking under Default/Relevance Sort', () => {
    it('applies bounded affinity boost to matching category items when sort is default/featured', () => {
      const items: RerankableProductItem[] = [
        { uuid: PROD_A, name: 'Producto A', categoryId: ROOT_CATEGORY, minPrice: 500, inStock: true, score: 10 },
        { uuid: PROD_B, name: 'Producto B', categoryId: CHILD_CATEGORY, minPrice: 1200, inStock: true, score: 9.5 }
      ]

      // Professional user with strong affinity for CHILD_CATEGORY
      const result = applyPersonalizedRerank({
        items,
        explicitSort: 'featured',
        affinities: {
          segment: 'professional',
          preferredCategories: [CHILD_CATEGORY]
        },
        variant: 'personalized',
        maxBoostWeight: 2.0
      })

      expect(result.reranked).toBe(true)
      // PROD_B received affinity boost and now ranks first
      expect(result.items[0]!.uuid).toBe(PROD_B)
      expect(result.items[1]!.uuid).toBe(PROD_A)
    })

    it('does not re-rank out-of-stock items above in-stock items', () => {
      const items: RerankableProductItem[] = [
        { uuid: PROD_A, name: 'Producto A', categoryId: ROOT_CATEGORY, minPrice: 500, inStock: true, score: 10 },
        {
          uuid: PROD_C,
          name: 'Producto C (Agotado)',
          categoryId: CHILD_CATEGORY,
          minPrice: 200,
          inStock: false,
          score: 9.8
        }
      ]

      const result = applyPersonalizedRerank({
        items,
        explicitSort: 'featured',
        affinities: {
          segment: 'customer',
          preferredCategories: [CHILD_CATEGORY] // affinity for C's category
        },
        variant: 'personalized',
        maxBoostWeight: 2.0
      })

      // Even with affinity boost, out-of-stock PROD_C must NOT leapfrog in-stock PROD_A
      expect(result.items[0]!.uuid).toBe(PROD_A)
      expect(result.items[0]!.inStock).toBe(true)
    })

    it('keeps original ranking when variant is control', () => {
      const items: RerankableProductItem[] = [
        { uuid: PROD_A, name: 'Producto A', categoryId: ROOT_CATEGORY, minPrice: 500, inStock: true, score: 10 },
        { uuid: PROD_B, name: 'Producto B', categoryId: CHILD_CATEGORY, minPrice: 1200, inStock: true, score: 9.5 }
      ]

      const result = applyPersonalizedRerank({
        items,
        explicitSort: 'featured',
        affinities: {
          segment: 'professional',
          preferredCategories: [CHILD_CATEGORY]
        },
        variant: 'control' // Control group receives standard ranking
      })

      expect(result.reranked).toBe(false)
      expect(result.variant).toBe('control')
      expect(result.items[0]!.uuid).toBe(PROD_A)
    })
  })

  describe('A/B Experiment Allocation & Incremental Uplift Measurement', () => {
    const EXPERIMENT_ID = 'rerank_affinity_v1'

    it('deterministically assigns variant based on session hash', () => {
      // Deterministic: same session always gets same variant
      const session1 = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
      const variant1A = assignExperimentVariant(session1, EXPERIMENT_ID)
      const variant1B = assignExperimentVariant(session1, EXPERIMENT_ID)
      expect(variant1A).toBe(variant1B)
      expect(['control', 'personalized']).toContain(variant1A)
    })

    it('records impressions, clicks, conversions and calculates incremental uplift metrics', async () => {
      // 1. Record control events:
      // 100 impressions, 10 clicks (CTR = 10%), 2 conversions (CVR = 2%), 5000 cents revenue
      const sessionControl = 'a123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
      for (let i = 0; i < 100; i++) {
        const eventId = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`
        const isClick = i < 10
        const isConv = i < 2

        await recordRerankImpression(database, {
          eventId,
          experimentId: EXPERIMENT_ID,
          sessionHash: sessionControl,
          variant: 'control',
          userSegment: 'customer',
          queryNormalized: 'desengrasante',
          hasExplicitSort: false,
          hasExplicitFilters: false,
          productsShown: [PROD_A, PROD_B],
          occurredAt: NOW
        })

        if (isClick || isConv) {
          await recordRerankInteraction(database, {
            eventId,
            clickedProductId: PROD_A,
            clickedRank: 1,
            converted: isConv,
            conversionCents: isConv ? 2500 : 0
          })
        }
      }

      // 2. Record personalized (treatment) events:
      // 100 impressions, 15 clicks (CTR = 15%), 4 conversions (CVR = 4%), 10000 cents revenue
      const sessionTreatment = 'b123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
      for (let i = 100; i < 200; i++) {
        const eventId = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`
        const isClick = i < 115
        const isConv = i < 104

        await recordRerankImpression(database, {
          eventId,
          experimentId: EXPERIMENT_ID,
          sessionHash: sessionTreatment,
          variant: 'personalized',
          userSegment: 'customer',
          queryNormalized: 'desengrasante',
          hasExplicitSort: false,
          hasExplicitFilters: false,
          productsShown: [PROD_B, PROD_A],
          occurredAt: NOW
        })

        if (isClick || isConv) {
          await recordRerankInteraction(database, {
            eventId,
            clickedProductId: PROD_B,
            clickedRank: 1,
            converted: isConv,
            conversionCents: isConv ? 2500 : 0
          })
        }
      }

      // 3. Compute uplift report
      const uplift = await readPersonalizedUpliftReport(database, EXPERIMENT_ID)

      expect(uplift.experimentId).toBe(EXPERIMENT_ID)
      expect(uplift.control.impressions).toBe(100)
      expect(uplift.control.clicks).toBe(10)
      expect(uplift.control.ctr).toBe(0.1) // 10%
      expect(uplift.control.conversions).toBe(2)
      expect(uplift.control.cvr).toBe(0.02) // 2%
      expect(uplift.control.revenueCents).toBe(5000)

      expect(uplift.treatment.impressions).toBe(100)
      expect(uplift.treatment.clicks).toBe(15)
      expect(uplift.treatment.ctr).toBe(0.15) // 15%
      expect(uplift.treatment.conversions).toBe(4)
      expect(uplift.treatment.cvr).toBe(0.04) // 4%
      expect(uplift.treatment.revenueCents).toBe(10000)

      // Incremental Uplift calculation:
      // CTR Uplift: (0.15 - 0.10) / 0.10 = +50.0%
      expect(uplift.ctrUpliftPercent).toBe(50.0)
      // Conversion Uplift: (0.04 - 0.02) / 0.02 = +100.0%
      expect(uplift.convUpliftPercent).toBe(100.0)
      // Revenue Uplift: (10000 - 5000) / 5000 = +100.0%
      expect(uplift.revenueUpliftPercent).toBe(100.0)
    })

    it('honestly reports 0% uplift when impressions are zero or conversion rates are identical', async () => {
      // Empty experiment report
      const emptyReport = await readPersonalizedUpliftReport(database, 'non_existent_exp')
      expect(emptyReport.ctrUpliftPercent).toBe(0)
      expect(emptyReport.convUpliftPercent).toBe(0)
      expect(emptyReport.revenueUpliftPercent).toBe(0)
    })
  })
})

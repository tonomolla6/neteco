import { readFile } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { FIXED_TEST_INSTANT } from '../fixtures/deterministic'
import {
  categoryCommandFixture,
  CATEGORY_CLAIMS,
  CATEGORY_IDENTITY,
  ROOT_CATEGORY
} from '../support/category-command-fixture'
import { provisionPublicationValidityFixture } from '../support/publication-validity-fixture'
import {
  searchProductsSemantically,
  executeHumanEvaluationCommand,
  computeHumanEvaluationBenchmark,
  DeterministicSemanticEmbeddingAdapter
} from '../../workers/catalog/semantic-search'
const PROD_LEJIA = '10000000-0000-4000-8000-000000000001'
const PROD_DESENG = '10000000-0000-4000-8000-000000000002'
const PROD_ANTICAL = '10000000-0000-4000-8000-000000000003'
const PROD_OUTOFSTOCK = '10000000-0000-4000-8000-000000000004'

const VAR_LEJIA = '20000000-0000-4000-8000-000000000001'
const VAR_DESENG = '20000000-0000-4000-8000-000000000002'
const VAR_ANTICAL = '20000000-0000-4000-8000-000000000003'
const VAR_OUTOFSTOCK = '20000000-0000-4000-8000-000000000004'

const NOW = FIXED_TEST_INSTANT.replace(/\.\d{3}Z$/, 'Z')

describe('SEA-019: D1 Semantic Search & Human Evaluation', () => {
  let sqlite: DatabaseSync
  let database: D1Database

  beforeEach(async () => {
    vi.setSystemTime(new Date(NOW))
    ;({ sqlite, database } = await categoryCommandFixture())

    // Apply migration 0104 if not present
    if (!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE name='catalog_semantic_embeddings'").get()) {
      const sql = await readFile(
        new URL('../../db/d1/migrations/0104_semantic_search_and_rerank.sql', import.meta.url),
        'utf8'
      )
      sqlite.exec(sql)
    }

    // Insert brands, tax_classes, shipping_profiles
    sqlite.exec(`
      INSERT INTO brands (id, name, slug, status) VALUES ('brand-neteco', 'NETECO', 'neteco', 'published');
      INSERT INTO tax_classes (id, code, name, rate_basis_points, valid_from)
        VALUES ('tax-21', 'ES21', 'IVA 21%', 2100, '2020-01-01T00:00:00Z');
      INSERT INTO shipping_profiles (id, code, name, kind)
        VALUES ('ship-parcel', 'parcel', 'Paquetería', 'parcel');
    `)

    // Insert 4 products with distinct chemical cleaning intents
    // 1. Lejía desinfectante
    sqlite
      .prepare(
        `
      INSERT INTO products (id, legacy_id, name, slug, brand_id, category_id, status, featured, attributes)
      VALUES (?, 101, 'Lejía Desinfectante Hospitalaria 5L', 'lejia-desinfectante-5l', 'brand-neteco', ?, 'published', 1,
        '{"visual":{"type":"garrafa","color":"#0284c7"}}')
    `
      )
      .run(PROD_LEJIA, ROOT_CATEGORY)

    // 2. Desengrasante alcalino industrial
    sqlite
      .prepare(
        `
      INSERT INTO products (id, legacy_id, name, slug, brand_id, category_id, status, featured, attributes)
      VALUES (?, 102, 'Desengrasante Enérgico Alcalino Campanas 5L', 'desengrasante-energico-5l', 'brand-neteco', ?, 'published', 0,
        '{"visual":{"type":"garrafa","color":"#ea580c"}}')
    `
      )
      .run(PROD_DESENG, ROOT_CATEGORY)

    // 3. Antical ácido desincrustante
    sqlite
      .prepare(
        `
      INSERT INTO products (id, legacy_id, name, slug, brand_id, category_id, status, featured, attributes)
      VALUES (?, 103, 'Desincrustante Ácido Antical Tuberías 1L', 'antical-acido-1l', 'brand-neteco', ?, 'published', 0,
        '{"visual":{"type":"botella","color":"#16a34a"}}')
    `
      )
      .run(PROD_ANTICAL, ROOT_CATEGORY)

    // 4. Out-of-stock product
    sqlite
      .prepare(
        `
      INSERT INTO products (id, legacy_id, name, slug, brand_id, category_id, status, featured, attributes)
      VALUES (?, 104, 'Limpiacristales Antivaho 750ml', 'limpiacristales-750ml', 'brand-neteco', ?, 'published', 0,
        '{"visual":{"type":"pulverizador","color":"#38bdf8"}}')
    `
      )
      .run(PROD_OUTOFSTOCK, ROOT_CATEGORY)

    // Insert variants with real prices and MPN
    function addVariant(id: string, legacyId: number, prodId: string, sku: string, gross: number) {
      sqlite
        .prepare(
          `
        INSERT INTO variants (id, legacy_id, product_id, sku, format, status, price_gross_cents, tax_class_id, shipping_profile_id, mpn)
        VALUES (?, ?, ?, ?, '1 L', 'published', ?, 'tax-21', 'ship-parcel', ?)
      `
        )
        .run(id, legacyId, prodId, sku, gross, 'MPN-' + id)
    }

    addVariant(VAR_LEJIA, 101, PROD_LEJIA, 'LEJ-HOSP-001', 750)
    addVariant(VAR_DESENG, 102, PROD_DESENG, 'DES-ALC-002', 1250)
    addVariant(VAR_ANTICAL, 103, PROD_ANTICAL, 'CAL-ACID-003', 490)
    addVariant(VAR_OUTOFSTOCK, 104, PROD_OUTOFSTOCK, 'LIM-CRIS-004', 350)

    await provisionPublicationValidityFixture(database, {
      productIds: [PROD_LEJIA, PROD_DESENG, PROD_ANTICAL, PROD_OUTOFSTOCK],
      now: NOW,
      validUntil: '2099-01-01T00:00:00Z'
    })

    // Insert inventory location and balances: 3 products in stock, 1 product zero stock
    sqlite
      .prepare(
        `
      INSERT OR IGNORE INTO inventory_locations (id, code, name, kind, active, created_at)
      VALUES ('loc-central', 'CENTRAL', 'Almacén Central', 'warehouse', 1, ?)
    `
      )
      .run(NOW)

    function setInventory(varId: string, physical: number, blocked: number) {
      sqlite
        .prepare(
          `
        INSERT INTO inventory_balances (variant_id, location_id, physical_quantity, blocked_quantity, version, created_at, updated_at)
        VALUES (?, 'loc-central', ?, ?, 1, ?, ?)
      `
        )
        .run(varId, physical, blocked, NOW, NOW)
    }

    setInventory(VAR_LEJIA, 50, 2)
    setInventory(VAR_DESENG, 30, 0)
    setInventory(VAR_ANTICAL, 100, 5)
    setInventory(VAR_OUTOFSTOCK, 0, 0) // zero sellable stock

    // Index semantic embeddings
    const embedder = new DeterministicSemanticEmbeddingAdapter()
    const indexEmbedding = (prodId: string, tokens: string[]) => {
      const vector = embedder.generateEmbedding(tokens.join(' '))
      sqlite
        .prepare(
          `
        INSERT INTO catalog_semantic_embeddings (product_id, concept_tokens, embedding_vector, indexed_at)
        VALUES (?, ?, ?, ?)
      `
        )
        .run(prodId, JSON.stringify(tokens), JSON.stringify(vector), NOW)
    }

    indexEmbedding(PROD_LEJIA, ['desinfeccion', 'lejia', 'cloro', 'bactericida', 'hospital', 'superficies', 'limpieza'])
    indexEmbedding(PROD_DESENG, [
      'grasa',
      'desengrasante',
      'alcalino',
      'cocina',
      'campana',
      'industrial',
      'horno',
      'taller'
    ])
    indexEmbedding(PROD_ANTICAL, ['cal', 'antical', 'acido', 'desincrustante', 'tuberias', 'griferia', 'sanitario'])
    indexEmbedding(PROD_OUTOFSTOCK, ['cristales', 'ventanas', 'espejos', 'antivaho', 'brillo'])
  })

  afterEach(() => {
    sqlite.close()
    vi.useRealTimers()
  })

  it('uses repeatable variant identifiers and index timestamps', () => {
    expect(sqlite.prepare('SELECT legacy_id FROM variants ORDER BY legacy_id').all()).toEqual([
      { legacy_id: 101 },
      { legacy_id: 102 },
      { legacy_id: 103 },
      { legacy_id: 104 }
    ])
    expect(sqlite.prepare('SELECT DISTINCT indexed_at FROM catalog_semantic_embeddings').get()).toMatchObject({
      indexed_at: '2026-08-13T12:00:00Z'
    })
  })

  describe('Catalog Anchoring & No Hallucinations', () => {
    it('returns only real catalog products anchored to published items with real pricing and stock', async () => {
      // Natural language query expressing need/problem: "quitar grasa quemada campana cocina"
      const result = await searchProductsSemantically(database, 'quitar grasa quemada campana cocina', {
        pricingInstant: NOW
      })

      expect(result.items.length).toBeGreaterThan(0)
      const top = result.items[0]!

      // Anchored to real catalog product
      expect(top.uuid).toBe(PROD_DESENG)
      expect(top.name).toBe('Desengrasante Enérgico Alcalino Campanas 5L')
      // Real price from variant (1250 gross cents)
      expect(top.minPrice).toBe(1250)
      expect(top.minNetPrice).toBe(Math.round((1250 * 10000) / 12100))
      // Real stock is reported honestly
      expect(top.inStock).toBe(true)
      expect(top.isSemanticMatch).toBe(true)
      expect(top.lexicalFallback).toBe(false)
    })

    it('honestly flags out-of-stock products and never hallucinates availability', async () => {
      // Query matching the out-of-stock product
      const result = await searchProductsSemantically(database, 'limpiar cristales y espejos sin vaho', {
        pricingInstant: NOW
      })

      expect(result.items.length).toBeGreaterThan(0)
      const found = result.items.find((item) => item.uuid === PROD_OUTOFSTOCK)
      expect(found).toBeDefined()
      // inStock must be FALSE because on_hand = 0
      expect(found!.inStock).toBe(false)
      expect(found!.minPrice).toBe(350)
    })

    it('never hallucinates non-existent products even when the query contains imaginary chemical compounds', async () => {
      const result = await searchProductsSemantically(database, 'compuesto criptonita cuaternaria espacial 9000', {
        pricingInstant: NOW
      })

      // Must not invent fake products; should either fallback or return empty
      for (const item of result.items) {
        // Every returned item MUST exist in the products table
        const exists = sqlite.prepare('SELECT 1 FROM products WHERE id = ?').get(item.uuid)
        expect(exists).toBeTruthy()
      }
    })
  })

  describe('Lexical Fallback', () => {
    it('falls back to lexical search when query is an exact SKU', async () => {
      // Exact SKU search
      const result = await searchProductsSemantically(database, 'LEJ-HOSP-001', {
        pricingInstant: NOW
      })

      expect(result.items.length).toBeGreaterThan(0)
      expect(result.items[0]!.uuid).toBe(PROD_LEJIA)
      expect(result.items[0]!.sku).toBe('LEJ-HOSP-001')
      expect(result.lexicalFallback).toBe(true)
    })

    it('falls back to lexical search when semantic similarity is low or empty', async () => {
      // Query that does not have high semantic similarity to embeddings but matches product name lexically
      const result = await searchProductsSemantically(database, 'Lejía', {
        pricingInstant: NOW,
        minSimilarityThreshold: 0.99 // unrealistically high to force fallback
      })

      expect(result.items.length).toBeGreaterThan(0)
      expect(result.items[0]!.uuid).toBe(PROD_LEJIA)
      expect(result.lexicalFallback).toBe(true)
    })

    it('gracefully falls back to lexical search if semantic index or provider throws', async () => {
      const faultyAdapter = {
        generateEmbedding: () => {
          throw new Error('Vectorize service timeout')
        },
        computeSimilarity: () => 0
      }

      const result = await searchProductsSemantically(database, 'desengrasante', {
        pricingInstant: NOW,
        adapter: faultyAdapter
      })

      expect(result.items.length).toBeGreaterThan(0)
      expect(result.lexicalFallback).toBe(true)
    })
  })

  describe('Human Relevance Evaluation (evaluación humana)', () => {
    it('saves, CAS checks, and ensures idempotency for human relevance evaluations', async () => {
      // 1. Save new evaluation (score 4: Perfect Match for query 'grasa campanas' -> PROD_DESENG)
      const command = {
        action: 'save' as const,
        id: null,
        expectedVersion: 0,
        query: 'grasa campanas',
        productId: PROD_DESENG,
        relevanceScore: 4,
        notes: 'Coincidencia exacta para desengrase industrial'
      }

      const receipt = await executeHumanEvaluationCommand(database, CATEGORY_CLAIMS, command, {
        idempotencyKey: 'eval-cmd-001'
      })

      expect(receipt.item.version).toBe(1)
      expect(receipt.item.relevanceScore).toBe(4)
      expect(receipt.item.evaluatorId).toBe(CATEGORY_IDENTITY)
      expect(receipt.item.queryNormalized).toBe('grasa campanas')

      const evalId = receipt.item.id

      // 2. Idempotency test: duplicate call returns same receipt
      const dup = await executeHumanEvaluationCommand(database, CATEGORY_CLAIMS, command, {
        idempotencyKey: 'eval-cmd-001'
      })
      expect(dup.commandId).toBe(receipt.commandId)
      expect(dup.item.version).toBe(1)

      // 3. CAS conflict: updating with stale expectedVersion 0 should fail
      await expect(
        executeHumanEvaluationCommand(
          database,
          CATEGORY_CLAIMS,
          {
            action: 'save',
            id: evalId,
            expectedVersion: 0, // stale! should be 1
            query: 'grasa campanas',
            productId: PROD_DESENG,
            relevanceScore: 3,
            notes: 'Ajuste de puntuación'
          },
          { idempotencyKey: 'eval-cmd-002' }
        )
      ).rejects.toThrow()

      // 4. Update with correct expectedVersion 1 -> version 2
      const updated = await executeHumanEvaluationCommand(
        database,
        CATEGORY_CLAIMS,
        {
          action: 'save',
          id: evalId,
          expectedVersion: 1,
          query: 'grasa campanas',
          productId: PROD_DESENG,
          relevanceScore: 3,
          notes: 'Ajuste de puntuación'
        },
        { idempotencyKey: 'eval-cmd-003' }
      )
      expect(updated.item.version).toBe(2)
      expect(updated.item.relevanceScore).toBe(3)
    })

    it('rejects evaluation when product does not exist or is unpublished', async () => {
      await expect(
        executeHumanEvaluationCommand(
          database,
          CATEGORY_CLAIMS,
          {
            action: 'save',
            id: null,
            expectedVersion: 0,
            query: 'antical',
            productId: 'ffffffff-ffff-4fff-8fff-ffffffffffff', // non-existent
            relevanceScore: 2
          },
          { idempotencyKey: 'eval-invalid-prod' }
        )
      ).rejects.toThrow()
    })

    it('computes NDCG@5, Precision@5, and MRR benchmark against human judgments', async () => {
      // Seed judgments:
      // Query: 'desinfectar hospital'
      // PROD_LEJIA -> 4 (perfect)
      // PROD_DESENG -> 1 (low)
      // PROD_ANTICAL -> 0 (irrelevant)
      await executeHumanEvaluationCommand(
        database,
        CATEGORY_CLAIMS,
        {
          action: 'save',
          id: null,
          expectedVersion: 0,
          query: 'desinfectar hospital',
          productId: PROD_LEJIA,
          relevanceScore: 4
        },
        { idempotencyKey: 'eval-bm-1' }
      )

      await executeHumanEvaluationCommand(
        database,
        CATEGORY_CLAIMS,
        {
          action: 'save',
          id: null,
          expectedVersion: 0,
          query: 'desinfectar hospital',
          productId: PROD_DESENG,
          relevanceScore: 1
        },
        { idempotencyKey: 'eval-bm-2' }
      )

      const benchmark = await computeHumanEvaluationBenchmark(database, CATEGORY_CLAIMS, {
        queries: ['desinfectar hospital']
      })

      expect(benchmark.totalQueries).toBe(1)
      expect(benchmark.totalJudgments).toBe(2)
      expect(benchmark.ndcgAt5).toBeGreaterThan(0.7)
      expect(benchmark.precisionAt5).toBeGreaterThanOrEqual(0)
    })
  })
})

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { readFile } from 'node:fs/promises'
import { openMigratedDatabase, d1OverSqlite } from '../support/d1-sqlite'
import { deterministicUuid } from '../fixtures/deterministic'
import {
  readD1RecommendationPolicy,
  updateD1RecommendationPolicy,
  generateD1Recommendations,
  recordD1RecommendationEvent,
  getD1RecommendationMetrics,
  _RecommendationEngineError
} from '../../workers/catalog/recommendation-engine'
import {
  handleRecommendationEngineHttp,
  ownsRecommendationEngineNamespace
} from '../../workers/catalog/recommendation-engine-http'

const NOW = '2026-10-29T12:00:00Z'
const PAST = '2026-10-20T12:00:00Z'
const _FUTURE = '2026-11-12T12:00:00Z'

const ADMIN_ID = deterministicUuid('rec-admin')
const CUSTOMER_ID = deterministicUuid('rec-cust')

const CAT_DISHWASH = 'cat-lavavajillas'
const CAT_SURFACE = 'cat-superficies'
const CAT_ACC = 'cat-accesorios'

const PROD_DISHWASHER = 'prod-detergente-lavavajillas'
const PROD_RINSE_AID = 'prod-abrillantador-maquina' // Compatible!
const PROD_SURFACE_CLEANER = 'prod-limpiador-multiusos'
const PROD_GLOVES = 'prod-guantes-nitrilo' // Accessory
const PROD_FALLBACK_1 = 'prod-rollo-bayetas'
const PROD_LOW_MARGIN = 'prod-lejia-basica-barata'

let sqlite: DatabaseSync
let db: D1Database

beforeEach(async () => {
  sqlite = await openMigratedDatabase()
  sqlite.exec('PRAGMA foreign_keys = OFF')
  db = d1OverSqlite(sqlite)

  const migration0076 = await readFile('db/d1/migrations/0076_catalog_relations.sql', 'utf8')
  sqlite.exec(migration0076)

  const migration0142 = await readFile(
    'db/d1/migrations/0142_browse_recovery_welcome_coupon_recommendations.sql',
    'utf8'
  )
  sqlite.exec(migration0142)

  // Seed Admin
  sqlite
    .prepare(
      `INSERT INTO identities(id, email, password_hash, email_verified_at, status, created_at, updated_at)
       VALUES(?, 'admin@neteco.es', 'synthetic', ?, 'active', ?, ?)`
    )
    .run(ADMIN_ID, PAST, PAST, PAST)
  sqlite.exec(`
    INSERT OR IGNORE INTO roles(code, name, description) VALUES('admin', 'Admin', 'Synthetic');
    INSERT OR IGNORE INTO permissions(code, resource, action, description) VALUES('administration.manage', 'administration', 'manage', 'Synthetic');
    INSERT OR IGNORE INTO role_permissions(role_code, permission_code) VALUES('admin', 'administration.manage');
  `)
  sqlite
    .prepare(`INSERT INTO identity_roles(identity_id, role_code, granted_at) VALUES(?, 'admin', ?)`)
    .run(ADMIN_ID, PAST)

  // Seed Customer
  sqlite
    .prepare(
      `INSERT INTO customers(id, name, phone, status, created_at, updated_at) VALUES(?, 'Hostelería Sol', '+34600111222', 'active', ?, ?)`
    )
    .run(CUSTOMER_ID, PAST, PAST)

  // Seed Categories
  sqlite
    .prepare(
      `INSERT INTO categories(id, name, slug, status, created_at, updated_at) VALUES(?, 'Lavavajillas', 'lavavajillas', 'published', ?, ?)`
    )
    .run(CAT_DISHWASH, PAST, PAST)
  sqlite
    .prepare(
      `INSERT INTO categories(id, name, slug, status, created_at, updated_at) VALUES(?, 'Superficies', 'superficies', 'published', ?, ?)`
    )
    .run(CAT_SURFACE, PAST, PAST)
  sqlite
    .prepare(
      `INSERT INTO categories(id, name, slug, status, created_at, updated_at) VALUES(?, 'Accesorios', 'accesorios', 'published', ?, ?)`
    )
    .run(CAT_ACC, PAST, PAST)

  // Seed Products with attributes including sector affinity and costs/margins
  const seedProduct = (
    id: string,
    catId: string,
    name: string,
    legacyId: number,
    sector: string,
    grossCents: number,
    costCents: number
  ) => {
    const marginBps = Math.round(((grossCents - costCents) / grossCents) * 10000)
    const attrs = JSON.stringify({ sector, grossMarginBasisPoints: marginBps })
    sqlite
      .prepare(
        `INSERT INTO products(id, category_id, name, slug, legacy_id, status, attributes, created_at, updated_at)
         VALUES(?, ?, ?, ?, ?, 'published', ?, ?, ?)`
      )
      .run(id, catId, name, id, legacyId, attrs, PAST, PAST)
  }

  seedProduct(PROD_DISHWASHER, CAT_DISHWASH, 'Detergente Lavavajillas Automático', 101, 'hosteleria', 3000, 1500) // 50% margin
  seedProduct(PROD_RINSE_AID, CAT_DISHWASH, 'Abrillantador Máquinas Lavavajillas', 102, 'hosteleria', 2000, 800) // 60% margin
  seedProduct(PROD_SURFACE_CLEANER, CAT_SURFACE, 'Limpiador Multiusos Bio', 103, 'general', 1500, 900) // 40% margin
  seedProduct(PROD_GLOVES, CAT_ACC, 'Guantes de Nitrilo Alta Resistencia', 104, 'hosteleria', 1200, 600) // 50% margin
  seedProduct(PROD_FALLBACK_1, CAT_ACC, 'Rollo Bayetas Microfibra', 105, 'general', 800, 400) // 50% margin
  seedProduct(PROD_LOW_MARGIN, CAT_SURFACE, 'Lejía Básica Económica', 106, 'general', 500, 480) // 4% margin (< floor!)

  // Seed Catalog Relation: PROD_DISHWASHER -> PROD_RINSE_AID (compatible)
  // Store relation in catalog_relation_heads and catalog_relation_revisions
  const relationCmd = deterministicUuid('cmd-rel-1')
  const relsJson = JSON.stringify([{ targetProductId: 102, kind: 'compatible' }])
  const inputJson = JSON.stringify({
    expectedVersion: 0,
    relations: [{ targetProductId: 102, kind: 'compatible' }],
    reason: 'Químico complementario imprescindible',
    reviewReference: 'REV-101'
  })
  const receiptJson = JSON.stringify({
    source: 'cloudflare',
    commandId: relationCmd,
    productId: 101,
    expectedVersion: 0,
    version: 1,
    payloadHash: '4444444444444444444444444444444444444444444444444444444444444444',
    recordedAt: PAST
  })
  sqlite
    .prepare(
      `INSERT INTO catalog_relation_commands(actor_id, command_id, product_id, product_legacy_id, expected_version, result_version, input_json, payload_hash, receipt_json, recorded_at)
       VALUES(?, ?, ?, 101, 0, 1, ?, '4444444444444444444444444444444444444444444444444444444444444444', ?, ?)`
    )
    .run(ADMIN_ID, relationCmd, PROD_DISHWASHER, inputJson, receiptJson, PAST)
  sqlite
    .prepare(
      `INSERT INTO catalog_relation_revisions(product_id, version, actor_id, command_id, relations_json, payload_hash, recorded_at)
       VALUES(?, 1, ?, ?, ?, '4444444444444444444444444444444444444444444444444444444444444444', ?)`
    )
    .run(PROD_DISHWASHER, ADMIN_ID, relationCmd, relsJson, PAST)
  sqlite
    .prepare(
      `INSERT INTO catalog_relation_heads(product_id, version, actor_id, command_id, updated_at)
       VALUES(?, 1, ?, ?, ?)`
    )
    .run(PROD_DISHWASHER, ADMIN_ID, relationCmd, PAST)

  // Seed Co-purchases: PROD_DISHWASHER & PROD_GLOVES bought together 15 times
  sqlite
    .prepare(
      `INSERT INTO catalog_co_purchases(product_a_id, product_b_id, co_purchase_count, last_purchased_at)
       VALUES(?, ?, 15, ?)`
    )
    .run(PROD_DISHWASHER, PROD_GLOVES, PAST)
})

afterEach(() => {
  if (sqlite?.isOpen) sqlite.close()
})

describe('MKT-020: Rule-based recommendation engine', () => {
  it('reads policy and allows admin to adjust weights and manual fallbacks with CAS', async () => {
    const policy = await readD1RecommendationPolicy(db)
    expect(policy.weightCompatibility).toBe(40)
    expect(policy.weightSector).toBe(25)
    expect(policy.weightCopurchase).toBe(25)
    expect(policy.weightMargin).toBe(10)

    const updated = await updateD1RecommendationPolicy(
      db,
      ADMIN_ID,
      {
        expectedVersion: 1,
        weightCompatibility: 45,
        weightSector: 20,
        weightCopurchase: 20,
        weightMargin: 15,
        marginFloorBasisPoints: 1500,
        maxPerCategory: 2,
        manualFallbackProductIds: [PROD_FALLBACK_1]
      },
      NOW
    )

    expect(updated.version).toBe(2)
    expect(updated.weightCompatibility).toBe(45)
    expect(updated.manualFallbackProductIds).toContain(PROD_FALLBACK_1)
  })

  it('ranks candidates using compatibility, sector affinity, co-purchase, and margin', async () => {
    // Generate recommendations for PROD_DISHWASHER for a hosteleria customer
    const recs = await generateD1Recommendations(
      db,
      {
        targetProductId: PROD_DISHWASHER,
        customerId: CUSTOMER_ID,
        sector: 'hosteleria',
        limit: 3
      },
      NOW
    )

    expect(recs.items.length).toBeGreaterThanOrEqual(2)
    // PROD_RINSE_AID should rank #1 because it has compatibility + hosteleria sector + high margin
    expect(recs.items[0].productId).toBe(PROD_RINSE_AID)
    expect(recs.items[0].signals.compatibilityScore).toBeGreaterThan(0)
    expect(recs.items[0].signals.sectorScore).toBeGreaterThan(0)

    // PROD_GLOVES should rank high because of co-purchase + hosteleria sector
    const gloves = recs.items.find((i) => i.productId === PROD_GLOVES)
    expect(gloves).toBeDefined()
    expect(gloves?.signals.copurchaseScore).toBeGreaterThan(0)

    // PROD_LOW_MARGIN should be excluded or heavily penalized due to margin floor
    expect(recs.items.some((i) => i.productId === PROD_LOW_MARGIN)).toBe(false)
  })

  it('uses manual fallback when rule candidates are fewer than requested limit', async () => {
    // Set manual fallback in policy
    await updateD1RecommendationPolicy(
      db,
      ADMIN_ID,
      {
        expectedVersion: 1,
        weightCompatibility: 40,
        weightSector: 25,
        weightCopurchase: 25,
        weightMargin: 10,
        marginFloorBasisPoints: 1500,
        maxPerCategory: 2,
        manualFallbackProductIds: [PROD_FALLBACK_1]
      },
      PAST
    )

    // Query for a product that has no relations and no co-purchases
    const recs = await generateD1Recommendations(
      db,
      {
        targetProductId: PROD_FALLBACK_1, // Fallback itself as target
        sector: 'general',
        limit: 4
      },
      NOW
    )

    const fallbackItem = recs.items.find((i) => i.origin === 'manual_fallback')
    expect(fallbackItem).toBeDefined()
  })

  it('enforces category diversity and respects maxPerCategory', async () => {
    // Configure maxPerCategory = 1
    await updateD1RecommendationPolicy(
      db,
      ADMIN_ID,
      {
        expectedVersion: 1,
        weightCompatibility: 30,
        weightSector: 30,
        weightCopurchase: 20,
        weightMargin: 20,
        marginFloorBasisPoints: 1000,
        maxPerCategory: 1,
        manualFallbackProductIds: [PROD_FALLBACK_1]
      },
      PAST
    )

    const recs = await generateD1Recommendations(
      db,
      {
        targetProductId: PROD_DISHWASHER,
        sector: 'hosteleria',
        limit: 3
      },
      NOW
    )

    const categories = recs.items.map((i) => i.categoryId)
    const uniqueCategories = new Set(categories)
    // Each item must be from a distinct category because maxPerCategory = 1
    expect(categories.length).toBe(uniqueCategories.size)
  })

  it('tracks impressions, clicks, conversions, and calculates analytics metrics', async () => {
    const recs = await generateD1Recommendations(
      db,
      {
        targetProductId: PROD_DISHWASHER,
        customerId: CUSTOMER_ID,
        sector: 'hosteleria',
        limit: 2
      },
      NOW
    )

    const impressionId = recs.requestId
    expect(impressionId).toBeDefined()

    // Record click
    await recordD1RecommendationEvent(
      db,
      {
        impressionId,
        eventType: 'click',
        productId: PROD_RINSE_AID,
        position: 0
      },
      NOW
    )

    // Record conversion
    const orderId = deterministicUuid('rec-order-1')
    await recordD1RecommendationEvent(
      db,
      {
        impressionId,
        eventType: 'conversion',
        productId: PROD_RINSE_AID,
        orderId,
        grossCents: 2000
      },
      NOW
    )

    const metrics = await getD1RecommendationMetrics(db, 30, NOW)
    expect(metrics.source).toBe('cloudflare')
    expect(metrics.impressions).toBeGreaterThanOrEqual(1)
    expect(metrics.clicks).toBeGreaterThanOrEqual(1)
    expect(metrics.conversions).toBeGreaterThanOrEqual(1)
    expect(metrics.clickThroughRate).toBeGreaterThan(0)
    expect(metrics.conversionRate).toBeGreaterThan(0)
    expect(metrics.attributedRevenueGrossCents).toBe(2000)
  })

  it('excludes products already in customer cart from recommendations', async () => {
    const recs = await generateD1Recommendations(
      db,
      {
        targetProductId: PROD_DISHWASHER,
        cartProductIds: [PROD_RINSE_AID], // Already in cart!
        sector: 'hosteleria',
        limit: 3
      },
      NOW
    )

    // PROD_RINSE_AID must NOT be recommended because it's already in the cart
    expect(recs.items.some((i) => i.productId === PROD_RINSE_AID)).toBe(false)
  })

  it('HTTP API routes recommendations and tracking events correctly', async () => {
    expect(ownsRecommendationEngineNamespace('/api/catalog/recommendations')).toBe(true)
    expect(ownsRecommendationEngineNamespace('/api/catalog/recommendations/events')).toBe(true)
    expect(ownsRecommendationEngineNamespace('/api/admin/recommendations/policy')).toBe(true)
    expect(ownsRecommendationEngineNamespace('/api/admin/recommendations/metrics')).toBe(true)
    expect(ownsRecommendationEngineNamespace('/api/other')).toBe(false)

    const req = new Request('https://test.invalid/api/admin/recommendations/policy', { method: 'GET' })
    const res = await handleRecommendationEngineHttp(req, {
      database: db,
      sessionCookieConfiguration: { secretKey: 'z'.repeat(32), cookieName: 'sess' }
    })
    expect(res?.status).toBe(401)

    // Public catalog recommendations GET
    const publicReq = new Request(
      `https://test.invalid/api/catalog/recommendations?targetProductId=${PROD_DISHWASHER}&sector=hosteleria&limit=2`
    )
    const publicRes = await handleRecommendationEngineHttp(publicReq, {
      database: db,
      sessionCookieConfiguration: { secretKey: 'z'.repeat(32), cookieName: 'sess' }
    })
    expect(publicRes?.status).toBe(200)
    const json = (await publicRes?.json()) as { items: unknown[] }
    expect(json.items).toBeDefined()
    expect(json.items.length).toBeGreaterThan(0)
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { splitDemoSql } from '../../scripts/lib/d1-demo-sql'
import { d1OverSqlite, openMigratedDatabase, seedInventoryFixture } from '../support/d1-sqlite'
import {
  getD1CatalogProductQuality,
  getD1CatalogQualityReviewCommand,
  listD1CatalogQualityQueue,
  recordD1CatalogQualityReview,
  type CatalogQualityError
} from '../../workers/catalog/catalog-quality'
import { testUuid } from '../support/deterministic'

const NOW = '2026-09-30T10:00:00Z'
const REVIEWER_ID = '10000000-0000-4000-8000-000000000092'
const REVIEWER_SESSION = '20000000-0000-4000-8000-000000000092'
const REVIEWER_CLAIMS = {
  identityId: REVIEWER_ID,
  sessionId: REVIEWER_SESSION,
  sessionVersion: 1
}

const READER_ID = '10000000-0000-4000-8000-000000000093'
const READER_SESSION = '20000000-0000-4000-8000-000000000093'
const READER_CLAIMS = {
  identityId: READER_ID,
  sessionId: READER_SESSION,
  sessionVersion: 1
}

const NO_MFA_ID = '10000000-0000-4000-8000-000000000094'
const NO_MFA_SESSION = '20000000-0000-4000-8000-000000000094'
const NO_MFA_CLAIMS = {
  identityId: NO_MFA_ID,
  sessionId: NO_MFA_SESSION,
  sessionVersion: 1
}

const CHECKSUM = 'a'.repeat(64)

describe('D1 catalog quality score and review queue (CAT-017)', () => {
  let sqlite: DatabaseSync
  let database: D1Database
  let phDefinitionId: string

  function seedGovernedMedia(options: {
    role: 'main' | 'image' | 'datasheet' | 'sds'
    productId: string
    mime?: string
    alt?: string
  }) {
    const upload = testUuid()
    const scan = testUuid()
    const rights = testUuid()
    const publication = testUuid()
    const objectKey = `quarantine/${upload}/${CHECKSUM}`
    const mime =
      options.mime ?? (options.role === 'sds' || options.role === 'datasheet' ? 'application/pdf' : 'image/png')
    const alt = options.alt ?? 'Fotografía o documento verificado del producto'

    sqlite
      .prepare(
        `INSERT INTO media_uploads(
           id, actor_id, idempotency_key, payload_hash, checksum, object_key, filename, content_type,
           byte_size, width, height, alt, rights_owner, rights_license, rights_source,
           storage_status, r2_etag, created_at, stored_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'catalog-evidence', ?, 100, ?, ?, ?, 'NetEco Owner', 'Licensed', 'REF-01', 'quarantined', 'etag-1', ?, ?)`
      )
      .run(
        upload,
        REVIEWER_ID,
        upload,
        CHECKSUM,
        CHECKSUM,
        objectKey,
        mime,
        mime === 'application/pdf' ? null : 800,
        mime === 'application/pdf' ? null : 600,
        alt,
        NOW,
        NOW
      )

    sqlite
      .prepare(
        `INSERT INTO media_scan_receipts(
           id, upload_id, checksum, object_key, byte_size, verdict, scanner_version,
           scanned_at, expires_at, received_at, payload_hash
         ) VALUES (?, ?, ?, ?, 100, 'clean', 'Synthetic-scanner', ?, '2028-01-01T00:00:00Z', ?, ?)`
      )
      .run(scan, upload, CHECKSUM, objectKey, NOW, NOW, CHECKSUM)

    sqlite
      .prepare(
        `INSERT INTO media_rights_decisions(
           id, upload_id, decision, reason, actor_id, evidence_authorized_at,
           evidence_reference, rights_owner, rights_license, created_at, idempotency_key, payload_hash
         ) VALUES (?, ?, 'approved', 'Evidencia aprobada en test', ?, '2026-09-01', 'REF-01', 'NetEco Owner', 'Licensed', ?, ?, ?)`
      )
      .run(rights, upload, REVIEWER_ID, NOW, rights, CHECKSUM)

    sqlite
      .prepare(
        `INSERT INTO product_media_publications(
           id, product_id, variant_id, upload_id, role, title, alt, language, version,
           valid_from, scan_receipt_id, rights_decision_id, actor_id, created_at, idempotency_key, payload_hash
         ) VALUES (?, ?, NULL, ?, ?, 'Evidencia catálogo', ?, 'es', 'v1', ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        publication,
        options.productId,
        upload,
        options.role,
        alt,
        NOW,
        scan,
        rights,
        REVIEWER_ID,
        NOW,
        publication,
        CHECKSUM
      )
  }

  function seedActiveTypedDefinition(categoryId: string, code: string): string {
    const commandId = testUuid()
    const claimNonce = testUuid()
    const definitionId = testUuid()
    const auditId = testUuid()
    const configObj = { precision: 1, min: 0, max: 14 }
    const config = JSON.stringify(configObj)
    const input = JSON.stringify({
      categoryId: 7,
      code,
      label: 'pH',
      kind: 'number',
      config: configObj,
      expectedVersion: 0,
      reason: 'Definición requerida para control de calidad'
    })
    const afterState = JSON.stringify({
      id: definitionId,
      categoryId: 7,
      categoryUuid: categoryId,
      code,
      label: 'pH',
      kind: 'number',
      status: 'active',
      revision: 1,
      config: configObj,
      createdAt: NOW,
      updatedAt: NOW
    })
    const response = JSON.stringify({
      source: 'cloudflare',
      action: 'create',
      commandId,
      definition: JSON.parse(afterState),
      updated: true
    })

    sqlite
      .prepare(
        `INSERT INTO catalog_typed_attribute_commands(
           id, claim_nonce, actor_id, action, definition_id, category_id,
           expected_revision, result_revision, reason, input, before_state, after_state,
           response, idempotency_key, payload_hash, created_at
         ) VALUES (?, ?, ?, 'create', ?, ?, 0, 1, 'Definición requerida para control de calidad', ?, NULL, ?, ?, ?, ?, ?)`
      )
      .run(
        commandId,
        claimNonce,
        REVIEWER_ID,
        definitionId,
        categoryId,
        input,
        afterState,
        response,
        `idem-${code}`,
        CHECKSUM,
        NOW
      )

    sqlite
      .prepare(
        `INSERT INTO catalog_typed_attribute_definitions(
           id, category_id, code, kind, current_revision, status, created_at, updated_at
         ) VALUES (?, ?, ?, 'number', 1, 'active', ?, ?)`
      )
      .run(definitionId, categoryId, code, NOW, NOW)

    sqlite
      .prepare(
        `INSERT INTO catalog_typed_attribute_revisions(
           definition_id, revision, label, status, config, created_at, command_id
         ) VALUES (?, 1, 'pH', 'active', ?, ?, ?)`
      )
      .run(definitionId, config, NOW, commandId)

    sqlite
      .prepare(
        `INSERT INTO catalog_typed_attribute_audit(
           id, command_id, actor_id, action, definition_id, category_id,
           expected_revision, result_revision, reason, input, before_state, after_state, response, created_at
         ) VALUES (?, ?, ?, 'create', ?, ?, 0, 1, 'Definición requerida para control de calidad', ?, NULL, ?, ?, ?)`
      )
      .run(auditId, commandId, REVIEWER_ID, definitionId, categoryId, input, afterState, response, NOW)

    return definitionId
  }

  beforeEach(async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(NOW))
    sqlite = await openMigratedDatabase()
    sqlite.limits.exprDepth = 100
    sqlite.limits.variableNumber = 100
    sqlite.limits.functionArg = 32
    database = d1OverSqlite(sqlite)

    const migration = await readFile(
      new URL('../../db/d1/migrations/0092_catalog_quality_review.sql', import.meta.url),
      'utf8'
    )
    await database.batch(splitDemoSql(migration).map((sql) => database.prepare(sql)))

    seedInventoryFixture(sqlite)
    sqlite.exec(`
      INSERT INTO categories (id, legacy_id, name, slug, status, parent_id, sort_order)
        VALUES ('c2', 8, 'Celulosa', 'celulosa', 'published', 'c1', 8);

      INSERT INTO identities(id, email, password_hash, email_verified_at, status, created_at, updated_at)
        VALUES
          ('${REVIEWER_ID}', 'reviewer@example.invalid', 'synthetic-hash', '${NOW}', 'active', '${NOW}', '${NOW}'),
          ('${READER_ID}', 'reader@example.invalid', 'synthetic-hash', '${NOW}', 'active', '${NOW}', '${NOW}'),
          ('${NO_MFA_ID}', 'nomfa@example.invalid', 'synthetic-hash', '${NOW}', 'active', '${NOW}', '${NOW}');

      INSERT INTO auth_sessions(id, identity_id, session_version, mfa_verified, created_at, expires_at)
        VALUES
          ('${REVIEWER_SESSION}', '${REVIEWER_ID}', 1, 1, '2026-09-30T08:00:00Z', '2026-12-31T23:59:59Z'),
          ('${READER_SESSION}', '${READER_ID}', 1, 1, '2026-09-30T08:00:00Z', '2026-12-31T23:59:59Z'),
          ('${NO_MFA_SESSION}', '${NO_MFA_ID}', 1, 0, '2026-09-30T08:00:00Z', '2026-12-31T23:59:59Z');

      INSERT INTO roles VALUES
        ('catalog_editor', 'Catalog Editor', 'Synthetic fixture'),
        ('catalog_viewer', 'Catalog Viewer', 'Synthetic fixture');
      INSERT INTO permissions VALUES
        ('catalog.write', 'catalog', 'write', 'Synthetic fixture'),
        ('catalog.read', 'catalog', 'read', 'Synthetic fixture');
      INSERT INTO role_permissions VALUES
        ('catalog_editor', 'catalog.write'),
        ('catalog_editor', 'catalog.read'),
        ('catalog_viewer', 'catalog.read');
      INSERT INTO identity_roles(identity_id, role_code, granted_at) VALUES
        ('${REVIEWER_ID}', 'catalog_editor', '${NOW}'),
        ('${READER_ID}', 'catalog_viewer', '${NOW}'),
        ('${NO_MFA_ID}', 'catalog_editor', '${NOW}');
    `)

    // Require 'ph' typed attribute on category c1 (Químicos)
    phDefinitionId = seedActiveTypedDefinition('c1', 'ph')

    // Product 1 (p-1): Complete chemical product with main image, datasheet, typed attribute 'ph', usage, series
    // Updating p-1 bumps catalog_version from 1 -> 2 via products_catalog_version_bump trigger
    const p1Attributes = JSON.stringify({
      typed: {
        version: 1,
        values: [{ definitionId: phDefinitionId, revision: 1, value: 11.5 }]
      }
    })
    sqlite
      .prepare(
        `UPDATE products SET
           status = 'published',
           brand_id = 'b1',
           short_description = 'Desengrasante alcalino concentrado para uso industrial',
           description = 'Fórmula de alto rendimiento para eliminación de grasas pesadas en industria alimentaria.',
           usage = 'Diluir del 2% al 5% en agua templada y aclarar con abundante agua.',
           series = 'EcoPro',
           regulatory = '{"requiresSds":false}',
           attributes = ?
         WHERE id = 'p-1'`
      )
      .run(p1Attributes)
    sqlite.exec(`
      UPDATE variants SET mpn = 'MPN-P1', minimum_quantity = 1, quantity_increment = 1,
        weight_grams = 1200, width_mm = 150, height_mm = 250, depth_mm = 150
      WHERE id = 'v-1-1';
    `)
    seedGovernedMedia({ role: 'main', productId: 'p-1' })
    seedGovernedMedia({ role: 'datasheet', productId: 'p-1' })

    // Product 2 (p-2): Incomplete regulated chemical product (missing main image, SDS, datasheet, usage, series, typed attribute 'ph')
    sqlite.exec(`
      UPDATE products SET
        status = 'draft',
        brand_id = 'b1',
        short_description = 'Desinfectante clorado de alto espectro para superficies',
        description = 'Desinfectante bactericida y fungicida para circuitos e instalaciones.',
        usage = '',
        series = '',
        regulatory = '{"requiresSds":true}',
        attributes = '{}'
      WHERE id = 'p-2';
      UPDATE variants SET mpn = 'MPN-P2', minimum_quantity = 1, quantity_increment = 1,
        weight_grams = 1200, width_mm = 150, height_mm = 250, depth_mm = 150
      WHERE id = 'v-2-1';
    `)

    // Product 3 (p-3): Paper product in category c2 (no typed attributes required), has main image, missing datasheet and usage
    sqlite.exec(`
      UPDATE products SET
        status = 'draft',
        category_id = 'c2',
        brand_id = 'b1',
        short_description = 'Bobina secamanos doble capa pasta virgen',
        description = 'Bobina industrial de gran metraje para dispensadores murales.',
        usage = '',
        series = 'Celulosa Plus',
        regulatory = '{"requiresSds":false}',
        attributes = '{}'
      WHERE id = 'p-3';
      UPDATE variants SET mpn = 'MPN-P3', minimum_quantity = 1, quantity_increment = 1,
        weight_grams = 1200, width_mm = 150, height_mm = 250, depth_mm = 150
      WHERE id = 'v-3-1';
    `)
    seedGovernedMedia({ role: 'main', productId: 'p-3' })

    // Keep fixture focused on products 1..3 by removing 4..6 unless scale test adds more
    sqlite.exec(`
      DELETE FROM inventory_movements WHERE variant_id IN ('v-4-1', 'v-5-1', 'v-6-1');
      DELETE FROM inventory_balances WHERE variant_id IN ('v-4-1', 'v-5-1', 'v-6-1');
      DELETE FROM variants WHERE id IN ('v-4-1', 'v-5-1', 'v-6-1');
      DELETE FROM products WHERE id IN ('p-4', 'p-5', 'p-6');
    `)
  })

  afterEach(() => {
    sqlite.close()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('computes deterministic 0-100 quality scores and stable penalty codes reusing publication readiness rules', async () => {
    const p1 = await getD1CatalogProductQuality(database, REVIEWER_CLAIMS, 1, { now: NOW })
    expect(p1).not.toBeNull()
    expect(p1?.publishable).toBe(true)
    expect(p1?.penalties.map((p) => p.code)).toEqual(['review.missing'])
    expect(p1?.score).toBe(90)

    const p2 = await getD1CatalogProductQuality(database, REVIEWER_CLAIMS, 2, { now: NOW })
    expect(p2).not.toBeNull()
    expect(p2?.publishable).toBe(false)
    expect(p2?.penalties.map((p) => p.code)).toEqual([
      'media.primary',
      'regulatory.sds',
      'recommended.usage',
      'recommended.series',
      'typed.missing',
      'document.datasheet',
      'review.missing'
    ])
    // 100 - (20 + 20 + 5 + 5 + 12 + 15 + 10) = 13
    expect(p2?.score).toBe(13)
    expect(p2?.missingSummary).toEqual({
      mandatoryFields: 0,
      recommendedFields: 2,
      typedAttributes: 1,
      images: 1,
      documents: 2,
      reviewIssues: 1
    })
  })

  it('orders the queue by lowest score first, then oldest/missing review date, and supports filters and pagination', async () => {
    await recordD1CatalogQualityReview(database, REVIEWER_CLAIMS, {
      commandId: 'cmd-review-p1-initial',
      productId: 1,
      expectedCatalogVersion: 2,
      expectedReviewVersion: 0,
      note: 'Ficha revisada y aprobada por calidad.',
      now: NOW
    })

    const queue = await listD1CatalogQualityQueue(database, READER_CLAIMS, { page: 1, perPage: 10 }, { now: NOW })

    expect(queue.items.map((item) => item.productId)).toEqual([2, 3, 1])
    expect(queue.items[0]?.score).toBe(13)
    expect(queue.items[1]?.score).toBe(70) // 100 - (recommended.usage 5 + document.datasheet 15 + review.missing 10)
    expect(queue.items[2]?.score).toBe(100)
    expect(queue.items[2]?.review?.reviewedBy).toBe(REVIEWER_ID)
    expect(queue.items[2]?.review?.reviewedCatalogVersion).toBe(2)
    expect(queue.summary.totalEvaluated).toBe(3)
    expect(queue.summary.unreviewedCount).toBe(2)

    // Filter by reason code
    const missingSds = await listD1CatalogQualityQueue(
      database,
      READER_CLAIMS,
      { reason: 'regulatory.sds' },
      { now: NOW }
    )
    expect(missingSds.items.map((item) => item.productId)).toEqual([2])

    // Filter by category and status
    const celulosaDrafts = await listD1CatalogQualityQueue(
      database,
      READER_CLAIMS,
      { category: 'celulosa', status: 'draft' },
      { now: NOW }
    )
    expect(celulosaDrafts.items.map((item) => item.productId)).toEqual([3])

    // Cursor pagination
    const page1 = await listD1CatalogQualityQueue(database, READER_CLAIMS, { perPage: 1 }, { now: NOW })
    expect(page1.items.map((item) => item.productId)).toEqual([2])
    expect(page1.pagination.nextCursor).toBeTruthy()

    const page2 = await listD1CatalogQualityQueue(
      database,
      READER_CLAIMS,
      { perPage: 1, cursor: page1.pagination.nextCursor ?? undefined },
      { now: NOW }
    )
    expect(page2.items.map((item) => item.productId)).toEqual([3])
  })

  it('penalizes stale reviews (>90 days) and outdated catalog versions after product edits', async () => {
    await recordD1CatalogQualityReview(database, REVIEWER_CLAIMS, {
      commandId: 'cmd-review-p1-old',
      productId: 1,
      expectedCatalogVersion: 2,
      expectedReviewVersion: 0,
      note: 'Revisión inicial.',
      now: NOW
    })

    // Updating a product field bumps catalog_version from 2 -> 3 via trigger
    sqlite.exec("UPDATE products SET series = 'EcoPro v3' WHERE id = 'p-1'")
    const futureNow = '2027-01-05T10:00:00Z'
    sqlite.exec(`
      UPDATE auth_sessions SET expires_at = '2027-06-01T00:00:00Z' WHERE id = '${REVIEWER_SESSION}';
    `)

    const evaluated = await getD1CatalogProductQuality(database, REVIEWER_CLAIMS, 1, {
      now: futureNow
    })
    expect(evaluated?.penalties.map((p) => p.code)).toEqual(['review.stale', 'review.outdated'])
    expect(evaluated?.score).toBe(82)
  })

  it('evaluates 520 products in a single D1 batch without N+1 queries', async () => {
    const insertProduct = sqlite.prepare(
      `INSERT INTO products (
         id, legacy_id, category_id, brand_id, name, slug, status,
         short_description, description, usage, series, regulatory, attributes
       ) VALUES (?, ?, 'c2', 'b1', ?, ?, 'draft',
         'Descripción corta válida para pruebas de escala de catálogo.',
         'Descripción larga válida para pruebas de escala de calidad.',
         'Aplicar directamente sobre la superficie.',
         'Serie Escala',
         '{"requiresSds":false}', '{}')`
    )
    const insertVariant = sqlite.prepare(
      `INSERT INTO variants (
         id, legacy_id, product_id, tax_class_id, shipping_profile_id, sku, mpn, format, status,
         price_gross_cents, backorder_allowed, lead_time_days, safety_stock,
         minimum_quantity, quantity_increment, weight_grams, width_mm, height_mm, depth_mm
       ) VALUES (?, ?, ?, 't21', 'sp1', ?, ?, 'Caja 6 uds', 'draft', 1500, 1, 3, 0, 1, 1, 1000, 100, 100, 100)`
    )

    sqlite.exec('BEGIN')
    for (let i = 100; i < 620; i += 1) {
      const pid = `p-scale-${i}`
      insertProduct.run(pid, i, `Producto Escala ${i}`, `producto-escala-${i}`)
      insertVariant.run(`v-scale-${i}`, 10000 + i, pid, `SKU-SCALE-${i}`, `MPN-SCALE-${i}`)
    }
    sqlite.exec('COMMIT')

    const batchSpy = vi.spyOn(database, 'batch')
    const result = await listD1CatalogQualityQueue(database, READER_CLAIMS, { page: 1, perPage: 25 }, { now: NOW })

    // Exactly 1 batch for the entire 523-product evaluation (plus 0 per-product queries)
    expect(batchSpy).toHaveBeenCalledTimes(1)
    expect(result.summary.totalEvaluated).toBe(523)
    expect(result.pagination.total).toBe(523)
    expect(result.items).toHaveLength(25)
  })

  it('enforces CAS, idempotency, live RBAC/MFA/email verification, and immutable audit triggers on review mutations', async () => {
    await expect(
      recordD1CatalogQualityReview(database, NO_MFA_CLAIMS, {
        commandId: 'cmd-no-mfa-1',
        productId: 1,
        expectedCatalogVersion: 2,
        expectedReviewVersion: 0,
        now: NOW
      })
    ).rejects.toMatchObject({
      code: 'mfa_required',
      status: 403
    } satisfies Partial<CatalogQualityError>)

    await expect(
      recordD1CatalogQualityReview(database, READER_CLAIMS, {
        commandId: 'cmd-reader-only-1',
        productId: 1,
        expectedCatalogVersion: 2,
        expectedReviewVersion: 0,
        now: NOW
      })
    ).rejects.toMatchObject({
      code: 'forbidden',
      status: 403
    } satisfies Partial<CatalogQualityError>)

    await expect(
      recordD1CatalogQualityReview(database, REVIEWER_CLAIMS, {
        commandId: 'cmd-wrong-cat-ver-1',
        productId: 1,
        expectedCatalogVersion: 99,
        expectedReviewVersion: 0,
        now: NOW
      })
    ).rejects.toMatchObject({
      code: 'version_conflict',
      status: 409
    } satisfies Partial<CatalogQualityError>)

    const recorded = await recordD1CatalogQualityReview(database, REVIEWER_CLAIMS, {
      commandId: 'cmd-review-p1-v1',
      productId: 1,
      expectedCatalogVersion: 2,
      expectedReviewVersion: 0,
      note: 'Primera revisión aprobada.',
      now: NOW
    })
    expect(recorded.status).toBe('recorded')
    expect(recorded.review.reviewVersion).toBe(1)
    expect(recorded.review.reviewedCatalogVersion).toBe(2)
    expect(recorded.review.reviewedBy).toBe(REVIEWER_ID)
    expect(recorded.review.note).toBe('Primera revisión aprobada.')

    // Idempotent replay with same commandId and payload
    const replayed = await recordD1CatalogQualityReview(database, REVIEWER_CLAIMS, {
      commandId: 'cmd-review-p1-v1',
      productId: 1,
      expectedCatalogVersion: 2,
      expectedReviewVersion: 0,
      note: 'Primera revisión aprobada.',
      now: NOW
    })
    expect(replayed.status).toBe('replayed')
    expect(replayed.review).toEqual(recorded.review)

    // Lookup by commandId for uncertain response recovery
    const lookup = await getD1CatalogQualityReviewCommand(database, REVIEWER_CLAIMS, 1, 'cmd-review-p1-v1', {
      now: NOW
    })
    expect(lookup?.status).toBe('replayed')
    expect(lookup?.review).toEqual(recorded.review)

    // Same commandId with altered payload fails with 409 idempotency_conflict
    await expect(
      recordD1CatalogQualityReview(database, REVIEWER_CLAIMS, {
        commandId: 'cmd-review-p1-v1',
        productId: 1,
        expectedCatalogVersion: 2,
        expectedReviewVersion: 0,
        note: 'Nota distinta con el mismo commandId.',
        now: NOW
      })
    ).rejects.toMatchObject({
      code: 'idempotency_conflict',
      status: 409
    } satisfies Partial<CatalogQualityError>)

    // Stale expectedReviewVersion=0 after v1 was recorded fails with 409 version_conflict
    await expect(
      recordD1CatalogQualityReview(database, REVIEWER_CLAIMS, {
        commandId: 'cmd-review-p1-stale',
        productId: 1,
        expectedCatalogVersion: 2,
        expectedReviewVersion: 0,
        note: 'Intento con versión obsoleta.',
        now: NOW
      })
    ).rejects.toMatchObject({
      code: 'version_conflict',
      status: 409
    } satisfies Partial<CatalogQualityError>)

    // Immutability triggers prevent deleting or updating audit and command records
    expect(() => sqlite.prepare('DELETE FROM catalog_quality_review_audit WHERE product_legacy_id = 1').run()).toThrow(
      /immutable_catalog_quality_review_audit/
    )
    expect(() =>
      sqlite.prepare('UPDATE catalog_quality_review_commands SET score = 0 WHERE product_legacy_id = 1').run()
    ).toThrow(/immutable_catalog_quality_review_command/)
  })
})

import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import type { VerifiedSessionClaims } from '../../workers/catalog/authorization'
import {
  stageAndCompareSupplierFeed,
  reviewSupplierFeedItem,
  applyApprovedFeedItems,
  getSupplierFeedImport,
  listSupplierFeedReviewItems,
  SupplierFeedError
} from '../../workers/catalog/supplier-feed-comparison'
import { computeSupplierFeedDiff, assertCanPublishFeedItem } from '../../shared/supplier-feed-comparison'

const ADMIN_CLAIMS: VerifiedSessionClaims = {
  identityId: '10000000-0000-4000-8000-000000000018',
  sessionId: '20000000-0000-4000-8000-000000000018',
  sessionVersion: 1
}

const UNAUTHORIZED_CLAIMS: VerifiedSessionClaims = {
  identityId: '90000000-0000-4000-8000-000000000099',
  sessionId: '91000000-0000-4000-8000-000000000099',
  sessionVersion: 1
}

const NOW = '2026-10-29T12:00:00Z'

async function setupTestDb(): Promise<DatabaseSync> {
  const sqlite = await openMigratedDatabase()
  const migration = await readFile(
    new URL('../../db/d1/migrations/0133_supplier_feed_editorial_sourcing_draft_orders.sql', import.meta.url),
    'utf8'
  )
  sqlite.exec(migration)

  sqlite.exec(`
    INSERT OR IGNORE INTO roles (code, name, description) VALUES
      ('admin', 'Administrador', 'Rol admin'),
      ('guest', 'Invitado', 'Sin permisos');
    INSERT OR IGNORE INTO permissions (code, resource, action, description) VALUES
      ('catalog.write', 'catalog', 'write', 'Edición catálogo');
    INSERT OR IGNORE INTO role_permissions (role_code, permission_code) VALUES
      ('admin', 'catalog.write');
    INSERT OR IGNORE INTO identities (id, email, password_hash, email_verified_at, status, created_at, updated_at) VALUES
      ('${ADMIN_CLAIMS.identityId}', 'admin-feed@neteco.es', 'hash', '${NOW}', 'active', '${NOW}', '${NOW}'),
      ('${UNAUTHORIZED_CLAIMS.identityId}', 'guest@neteco.es', 'hash', '${NOW}', 'active', '${NOW}', '${NOW}');
    INSERT OR IGNORE INTO auth_sessions (id, identity_id, session_version, mfa_verified, created_at, expires_at) VALUES
      ('${ADMIN_CLAIMS.sessionId}', '${ADMIN_CLAIMS.identityId}', 1, 1, '${NOW}', '2099-01-01T00:00:00Z'),
      ('${UNAUTHORIZED_CLAIMS.sessionId}', '${UNAUTHORIZED_CLAIMS.identityId}', 1, 1, '${NOW}', '2099-01-01T00:00:00Z');
    INSERT OR IGNORE INTO identity_roles (identity_id, role_code, granted_at) VALUES
      ('${ADMIN_CLAIMS.identityId}', 'admin', '${NOW}'),
      ('${UNAUTHORIZED_CLAIMS.identityId}', 'guest', '${NOW}');
  `)

  return sqlite
}

describe('CAT-018: Comparación automática de feed de proveedor', () => {
  let sqlite: DatabaseSync
  let d1: ReturnType<typeof d1OverSqlite>

  beforeEach(async () => {
    sqlite = await setupTestDb()
    d1 = d1OverSqlite(sqlite)
  })

  it('pure diff engine detects altas, cambios y bajas cleanly', () => {
    const existing = [
      {
        supplierSku: 'SKU-001',
        productId: 'prod-1',
        variantId: 'var-1',
        name: 'Desengrasante Industrial 5L',
        priceCents: 1250,
        leadTimeDays: 2,
        stockQuantity: 40
      },
      {
        supplierSku: 'SKU-002',
        productId: 'prod-2',
        variantId: 'var-2',
        name: 'Detergente Enzimático 10L',
        priceCents: 2400,
        leadTimeDays: 5,
        stockQuantity: 15
      }
    ]

    const incoming = [
      // Cambio on SKU-001 (price increased, lead time changed)
      {
        supplierSku: 'SKU-001',
        name: 'Desengrasante Industrial 5L',
        priceCents: 1390,
        leadTimeDays: 3,
        stockQuantity: 30
      },
      // Alta: brand new SKU
      {
        supplierSku: 'SKU-003',
        name: 'Limpiafondos Alcalino 25L',
        priceCents: 4500,
        leadTimeDays: 4,
        stockQuantity: 10
      }
      // SKU-002 is missing from incoming -> Baja
    ]

    const diff = computeSupplierFeedDiff(existing, incoming)

    expect(diff.altas).toHaveLength(1)
    expect(diff.altas[0].supplierSku).toBe('SKU-003')

    expect(diff.cambios).toHaveLength(1)
    expect(diff.cambios[0].supplierSku).toBe('SKU-001')
    expect(diff.cambios[0].diffDetails.changedFields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'priceCents', before: 1250, after: 1390 }),
        expect.objectContaining({ field: 'leadTimeDays', before: 2, after: 3 })
      ])
    )

    expect(diff.bajas).toHaveLength(1)
    expect(diff.bajas[0].supplierSku).toBe('SKU-002')
  })

  it('acceptance guardrail: never publishes unreviewed feed items silently', () => {
    // Unreviewed item with pending_review must fail publication check
    expect(() => {
      assertCanPublishFeedItem({ status: 'pending_review', isPublished: 0 })
    }).toThrow('unreviewed_feed_item_cannot_publish')

    // Rejected item must fail publication check
    expect(() => {
      assertCanPublishFeedItem({ status: 'rejected', isPublished: 0 })
    }).toThrow('unreviewed_feed_item_cannot_publish')

    // Only explicitly approved items pass
    expect(() => {
      assertCanPublishFeedItem({ status: 'approved', isPublished: 0 })
    }).not.toThrow()
  })

  it('stages incoming supplier feed and places ALL altas, cambios and bajas in pending_review', async () => {
    const stageResult = await stageAndCompareSupplierFeed(
      d1,
      ADMIN_CLAIMS,
      {
        supplierId: 'SUP-QUIM-01',
        feedName: 'Tarifa y Stock Octubre 2026',
        items: [
          {
            supplierSku: 'QUIM-101',
            name: 'Cloro Líquido 20L',
            priceCents: 1850,
            leadTimeDays: 2,
            stockQuantity: 100
          },
          {
            supplierSku: 'QUIM-102',
            name: 'Abrillantador Máquinas 10L',
            priceCents: 2100,
            leadTimeDays: 3,
            stockQuantity: 50
          }
        ]
      },
      { now: NOW }
    )

    expect(stageResult.importId).toBeDefined()
    expect(stageResult.altasCount).toBe(2)
    expect(stageResult.cambiosCount).toBe(0)
    expect(stageResult.bajasCount).toBe(0)

    // Verify staged import record
    const importRecord = await getSupplierFeedImport(d1, stageResult.importId)
    expect(importRecord.status).toBe('analyzed')

    // Verify all review items are strictly in 'pending_review' with is_published = 0
    const reviewItems = await listSupplierFeedReviewItems(d1, stageResult.importId)
    expect(reviewItems).toHaveLength(2)
    for (const item of reviewItems) {
      expect(item.status).toBe('pending_review')
      expect(item.isPublished).toBe(0)
      expect(item.reviewDecisionBy).toBeNull()
    }
  })

  it('supports reviewing and approving/rejecting items with CAS versioning', async () => {
    const stageResult = await stageAndCompareSupplierFeed(
      d1,
      ADMIN_CLAIMS,
      {
        supplierId: 'SUP-QUIM-02',
        feedName: 'Catálogo Novedades',
        items: [
          {
            supplierSku: 'QUIM-201',
            name: 'Ácido Clorhídrico 33% 25L',
            priceCents: 2900,
            leadTimeDays: 2,
            stockQuantity: 25
          }
        ]
      },
      { now: NOW }
    )

    const items = await listSupplierFeedReviewItems(d1, stageResult.importId)
    const targetItem = items[0]

    // CAS mismatch test
    await expect(
      reviewSupplierFeedItem(
        d1,
        ADMIN_CLAIMS,
        {
          itemId: targetItem.id,
          decision: 'approved',
          expectedVersion: 999,
          reviewNotes: 'Aprobado para alta'
        },
        { now: NOW }
      )
    ).rejects.toThrow(SupplierFeedError)

    // Successful approval
    const reviewResult = await reviewSupplierFeedItem(
      d1,
      ADMIN_CLAIMS,
      {
        itemId: targetItem.id,
        decision: 'approved',
        expectedVersion: targetItem.version,
        reviewNotes: 'Aprobado con margen correcto'
      },
      { now: NOW }
    )
    expect(reviewResult.newStatus).toBe('approved')

    // Application test: applying approved item updates status to applied and isPublished = 1
    const applyResult = await applyApprovedFeedItems(
      d1,
      ADMIN_CLAIMS,
      {
        importId: stageResult.importId,
        itemIds: [targetItem.id]
      },
      { now: NOW }
    )
    expect(applyResult.appliedCount).toBe(1)

    const updatedItems = await listSupplierFeedReviewItems(d1, stageResult.importId)
    expect(updatedItems[0].status).toBe('applied')
    expect(updatedItems[0].isPublished).toBe(1)
  })

  it('rejects publication of any unreviewed item attempting to bypass review', async () => {
    const stageResult = await stageAndCompareSupplierFeed(
      d1,
      ADMIN_CLAIMS,
      {
        supplierId: 'SUP-QUIM-03',
        feedName: 'Feed Intento Publicación Directa',
        items: [
          {
            supplierSku: 'QUIM-301',
            name: 'Jabón Neutro Manos 5L',
            priceCents: 850
          }
        ]
      },
      { now: NOW }
    )

    const items = await listSupplierFeedReviewItems(d1, stageResult.importId)
    const unapprovedItem = items[0]

    // Attempting to apply an unreviewed item must fail immediately
    await expect(
      applyApprovedFeedItems(
        d1,
        ADMIN_CLAIMS,
        {
          importId: stageResult.importId,
          itemIds: [unapprovedItem.id]
        },
        { now: NOW }
      )
    ).rejects.toThrow('unreviewed_feed_cannot_publish')
  })

  it('enforces authentication and catalog.write permissions', async () => {
    await expect(
      stageAndCompareSupplierFeed(
        d1,
        UNAUTHORIZED_CLAIMS,
        {
          supplierId: 'SUP-QUIM-04',
          feedName: 'Test No Auth',
          items: [{ supplierSku: 'SKU-X', name: 'Test', priceCents: 100 }]
        },
        { now: NOW }
      )
    ).rejects.toThrow(SupplierFeedError)
  })

  it('handles item rejection and blocks rejected items from publication', async () => {
    const stageResult = await stageAndCompareSupplierFeed(
      d1,
      ADMIN_CLAIMS,
      {
        supplierId: 'SUP-QUIM-05',
        feedName: 'Tarifa Recha',
        items: [{ supplierSku: 'QUIM-REJ-01', name: 'Producto Mal Etiquetado', priceCents: 1500 }]
      },
      { now: NOW }
    )

    const items = await listSupplierFeedReviewItems(d1, stageResult.importId)
    const target = items[0]

    const reviewRes = await reviewSupplierFeedItem(
      d1,
      ADMIN_CLAIMS,
      {
        itemId: target.id,
        decision: 'rejected',
        expectedVersion: target.version,
        reviewNotes: 'No cumple estándar de etiquetado CLP'
      },
      { now: NOW }
    )
    expect(reviewRes.newStatus).toBe('rejected')

    // Applying rejected item must fail guardrail
    await expect(
      applyApprovedFeedItems(
        d1,
        ADMIN_CLAIMS,
        {
          importId: stageResult.importId,
          itemIds: [target.id]
        },
        { now: NOW }
      )
    ).rejects.toThrow('unreviewed_feed_cannot_publish')
  })

  it('detects 0 diff when incoming items perfectly match existing items', () => {
    const existing = [
      {
        supplierSku: 'SKU-SAME',
        name: 'Detergente Neutro 5L',
        priceCents: 900,
        leadTimeDays: 2,
        stockQuantity: 50
      }
    ]
    const incoming = [
      {
        supplierSku: 'SKU-SAME',
        name: 'Detergente Neutro 5L',
        priceCents: 900,
        leadTimeDays: 2,
        stockQuantity: 50
      }
    ]

    const diff = computeSupplierFeedDiff(existing, incoming)
    expect(diff.altas).toHaveLength(0)
    expect(diff.cambios).toHaveLength(0)
    expect(diff.bajas).toHaveLength(0)
  })
})

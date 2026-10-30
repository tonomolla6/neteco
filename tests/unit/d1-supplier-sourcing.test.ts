import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import type { VerifiedSessionClaims } from '../../workers/catalog/authorization'
import {
  createSupplier,
  upsertSupplierOffering,
  selectAndRecordSourcingDecision,
  listSupplierOfferings,
  listSourcingDecisions,
  SupplierSourcingError
} from '../../workers/catalog/supplier-sourcing'
import { calculateMargin, selectSourcingOffering } from '../../shared/supplier-sourcing'

const ADMIN_CLAIMS: VerifiedSessionClaims = {
  identityId: '10000000-0000-4000-8000-000000000021',
  sessionId: '20000000-0000-4000-8000-000000000021',
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
      ('${ADMIN_CLAIMS.identityId}', 'sourcing@neteco.es', 'hash', '${NOW}', 'active', '${NOW}', '${NOW}'),
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

describe('CAT-021: Multi-proveedor y coste/lead time por proveedor', () => {
  let sqlite: DatabaseSync
  let d1: ReturnType<typeof d1OverSqlite>

  beforeEach(async () => {
    sqlite = await setupTestDb()
    d1 = d1OverSqlite(sqlite)
  })

  it('calculates margin and markup accurately in cents and percentages', () => {
    // Retail PVP: 25.00€ (2500 cents), Cost: 15.00€ (1500 cents)
    const margin = calculateMargin(2500, 1500)
    expect(margin.marginCents).toBe(1000)
    expect(margin.marginPercent).toBe(40.0) // 1000 / 2500 = 40%
    expect(margin.markupPercent).toBe(66.67) // 1000 / 1500 = 66.67%
    expect(margin.isViable).toBe(true)

    // Unviable margin (selling below cost)
    const lossMargin = calculateMargin(1000, 1200)
    expect(lossMargin.marginCents).toBe(-200)
    expect(lossMargin.isViable).toBe(false)
  })

  it('evaluates candidate suppliers and selects optimal offering by strategy', () => {
    const candidates = [
      {
        offeringId: 'off-1',
        supplierId: 'sup-cheaper',
        supplierName: 'Químicos Económicos SL',
        supplierSku: 'ECO-100',
        costCents: 1200, // 12.00€
        leadTimeDays: 7, // 7 days
        minOrderQuantity: 10,
        isPreferred: false,
        reliabilityScore: 85
      },
      {
        offeringId: 'off-2',
        supplierId: 'sup-fast',
        supplierName: 'Distribuciones Exprés Quimia',
        supplierSku: 'EXP-100',
        costCents: 1500, // 15.00€
        leadTimeDays: 1, // 1 day
        minOrderQuantity: 1,
        isPreferred: false,
        reliabilityScore: 98
      },
      {
        offeringId: 'off-3',
        supplierId: 'sup-preferred',
        supplierName: 'Proveedor Químico Preferente SA',
        supplierSku: 'PRF-100',
        costCents: 1350, // 13.50€
        leadTimeDays: 3, // 3 days
        minOrderQuantity: 5,
        isPreferred: true,
        reliabilityScore: 95
      }
    ]

    const retailPriceCents = 2500

    // Strategy 1: Lowest cost
    const lowestCostChoice = selectSourcingOffering(retailPriceCents, candidates, 'lowest_cost')
    expect(lowestCostChoice.selectedOffering.offeringId).toBe('off-1')
    expect(lowestCostChoice.selectedOffering.costCents).toBe(1200)
    expect(lowestCostChoice.margin.marginPercent).toBe(52.0)

    // Strategy 2: Shortest lead time
    const shortestLeadChoice = selectSourcingOffering(retailPriceCents, candidates, 'shortest_lead_time')
    expect(shortestLeadChoice.selectedOffering.offeringId).toBe('off-2')
    expect(shortestLeadChoice.selectedOffering.leadTimeDays).toBe(1)

    // Strategy 3: Preferred supplier
    const preferredChoice = selectSourcingOffering(retailPriceCents, candidates, 'preferred')
    expect(preferredChoice.selectedOffering.offeringId).toBe('off-3')
    expect(preferredChoice.selectedOffering.isPreferred).toBe(true)
  })

  it('records traceable multi-supplier sourcing decisions with margin and snapshot', async () => {
    // 1. Create suppliers
    const supA = await createSupplier(
      d1,
      ADMIN_CLAIMS,
      {
        code: 'SUP-ALFA',
        name: 'Alfa Químicos Industriales',
        leadTimeDaysDefault: 4,
        reliabilityScore: 92
      },
      { now: NOW }
    )

    const supBeta = await createSupplier(
      d1,
      ADMIN_CLAIMS,
      {
        code: 'SUP-BETA',
        name: 'Beta Solventes Rápidos',
        leadTimeDaysDefault: 1,
        reliabilityScore: 99
      },
      { now: NOW }
    )

    // 2. Create supplier offerings for product variant
    const variantId = 'var-desengrasante-5l'
    const productId = 'prod-desengrasante'

    const offA = await upsertSupplierOffering(
      d1,
      ADMIN_CLAIMS,
      {
        supplierId: supA.id,
        productId,
        variantId,
        supplierSku: 'ALFA-DSG-5',
        costCents: 1100, // 11.00€
        leadTimeDays: 4,
        isPreferred: 0
      },
      { now: NOW }
    )
    expect(offA.costCents).toBe(1100)

    const offBeta = await upsertSupplierOffering(
      d1,
      ADMIN_CLAIMS,
      {
        supplierId: supBeta.id,
        productId,
        variantId,
        supplierSku: 'BETA-DSG-5',
        costCents: 1400, // 14.00€
        leadTimeDays: 1,
        isPreferred: 1
      },
      { now: NOW }
    )

    // Verify offerings list
    const offerings = await listSupplierOfferings(d1, variantId)
    expect(offerings).toHaveLength(2)

    // 3. Select sourcing source with strategy 'shortest_lead_time'
    const decision = await selectAndRecordSourcingDecision(
      d1,
      ADMIN_CLAIMS,
      {
        variantId,
        retailPriceCents: 2200, // 22.00€
        strategy: 'shortest_lead_time'
      },
      { now: NOW }
    )
    expect(offA.costCents).toBe(1100)

    expect(decision.selectedSupplierId).toBe(supBeta.id)
    expect(decision.selectedOfferingId).toBe(offBeta.id)
    expect(decision.leadTimeDays).toBe(1)
    expect(decision.costCents).toBe(1400)
    expect(decision.retailPriceCents).toBe(2200)
    expect(decision.marginCents).toBe(800)
    expect(decision.marginPercent).toBe(36.36)
    expect(decision.candidateOptions.length).toBe(2) // complete audit snapshot!

    // Verify traceability history
    const history = await listSourcingDecisions(d1, variantId)
    expect(history).toHaveLength(1)
    expect(history[0].selectionReason).toContain('plazo de entrega más rápido')
  })

  it('rejects unauthorized access without catalog.write permission', async () => {
    await expect(
      createSupplier(
        d1,
        UNAUTHORIZED_CLAIMS,
        {
          code: 'SUP-HACK',
          name: 'Hacker Quim',
          leadTimeDaysDefault: 2
        },
        { now: NOW }
      )
    ).rejects.toThrow(SupplierSourcingError)
  })

  it('rejects offering with non-positive cost cents', async () => {
    await expect(
      upsertSupplierOffering(
        d1,
        ADMIN_CLAIMS,
        {
          supplierId: '00000000-0000-4000-8000-000000000001',
          productId: 'p1',
          variantId: 'v1',
          supplierSku: 'SKU-0',
          costCents: 0,
          leadTimeDays: 1
        },
        { now: NOW }
      )
    ).rejects.toThrow('invalid_cost')
  })

  it('handles tie-breaking and selects shortest lead time when costs are identical', () => {
    const candidates = [
      {
        offeringId: 'off-slow',
        supplierId: 'sup-1',
        supplierName: 'Proveedor Lento',
        supplierSku: 'SKU-SLOW',
        costCents: 1000,
        leadTimeDays: 5,
        minOrderQuantity: 1,
        isPreferred: false,
        reliabilityScore: 90
      },
      {
        offeringId: 'off-fast',
        supplierId: 'sup-2',
        supplierName: 'Proveedor Rápido',
        supplierSku: 'SKU-FAST',
        costCents: 1000,
        leadTimeDays: 2,
        minOrderQuantity: 1,
        isPreferred: false,
        reliabilityScore: 95
      }
    ]

    const choice = selectSourcingOffering(2000, candidates, 'lowest_cost')
    // Both cost 1000, so tie-breaker picks leadTimeDays: 2
    expect(choice.selectedOffering.offeringId).toBe('off-fast')
  })

  it('throws no_suppliers_found if variant has no active supplier offerings', async () => {
    await expect(
      selectAndRecordSourcingDecision(
        d1,
        ADMIN_CLAIMS,
        {
          variantId: 'var-non-existent',
          retailPriceCents: 1000,
          strategy: 'lowest_cost'
        },
        { now: NOW }
      )
    ).rejects.toThrow('no_suppliers_found')
  })
})

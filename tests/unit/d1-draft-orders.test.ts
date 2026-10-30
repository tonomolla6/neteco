import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import type { VerifiedSessionClaims } from '../../workers/catalog/authorization'
import {
  createDraftOrder,
  submitDraftOrderForApproval,
  reviewDraftOrder,
  convertDraftOrderToConfirmed,
  sweepExpiredDraftOrders,
  getDraftOrder,
  DraftOrderError
} from '../../workers/b2b/draft-orders'

const ADMIN_CLAIMS: VerifiedSessionClaims = {
  identityId: '10000000-0000-4000-8000-000000000022',
  sessionId: '20000000-0000-4000-8000-000000000022',
  sessionVersion: 1
}

const UNAUTHORIZED_CLAIMS: VerifiedSessionClaims = {
  identityId: '90000000-0000-4000-8000-000000000099',
  sessionId: '91000000-0000-4000-8000-000000000099',
  sessionVersion: 1
}

const NOW = '2026-10-29T12:00:00Z'
const FUTURE_DATE = '2026-10-31T12:00:00Z' // 48h later

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
      ('orders.manage', 'orders', 'manage', 'Gestión pedidos'),
      ('catalog.write', 'catalog', 'write', 'Edición catálogo');
    INSERT OR IGNORE INTO role_permissions (role_code, permission_code) VALUES
      ('admin', 'orders.manage'),
      ('admin', 'catalog.write');
    INSERT OR IGNORE INTO identities (id, email, password_hash, email_verified_at, status, created_at, updated_at) VALUES
      ('${ADMIN_CLAIMS.identityId}', 'b2b-manager@neteco.es', 'hash', '${NOW}', 'active', '${NOW}', '${NOW}'),
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

describe('CHK-022: Pedido como borrador sujeto a aprobación', () => {
  let sqlite: DatabaseSync
  let d1: ReturnType<typeof d1OverSqlite>

  beforeEach(async () => {
    sqlite = await setupTestDb()
    d1 = d1OverSqlite(sqlite)
  })

  it('acceptance rule: no reserve/charge indefinitely, defines clear expiration and timeline', async () => {
    // 1. Create a draft order
    const draft = await createDraftOrder(
      d1,
      ADMIN_CLAIMS,
      {
        customerId: 'cust-b2b-hospital-01',
        companyName: 'Hospital Virgen del Mar SL',
        contactEmail: 'compras@virgendelmar.es',
        items: [
          {
            variantId: 'var-cloro-25',
            sku: 'CLR-25L',
            name: 'Cloro Hospitalario 25L',
            quantity: 10,
            unitPriceCents: 3200,
            lineTotalCents: 32000
          }
        ],
        shippingCents: 1500,
        taxRatePercent: 21,
        expiresInHours: 48
      },
      { now: NOW }
    )

    expect(draft.id).toBeDefined()
    expect(draft.draftNumber).toMatch(/^DFT-\d+/)
    expect(draft.status).toBe('draft')

    // Acceptance rule checks:
    // 1) No indefinite inventory reservation
    expect(draft.inventoryReserved).toBe(0)
    // 2) No unapproved credit card / balance charge
    expect(draft.paymentStatus).toBe('unbilled')
    // 3) Definite expiration defined
    expect(draft.expiresAt).toBe(FUTURE_DATE)

    // 4) Timeline initialized with 'created' event
    const fetched = await getDraftOrder(d1, draft.id)
    expect(fetched?.timeline).toHaveLength(1)
    expect(fetched?.timeline?.[0].eventType).toBe('created')
  })

  it('tracks full approval timeline progression: draft -> submitted -> approved -> converted', async () => {
    // 1. Create draft
    const draft = await createDraftOrder(
      d1,
      ADMIN_CLAIMS,
      {
        customerId: 'cust-hotel-02',
        companyName: 'Hoteles del Sol SA',
        contactEmail: 'pedidos@hotelesdelsol.es',
        items: [
          {
            variantId: 'var-jabon-5l',
            sku: 'JBN-5L',
            name: 'Gel Hidroalcohólico 5L',
            quantity: 50,
            unitPriceCents: 1500,
            lineTotalCents: 75000
          }
        ],
        expiresInHours: 72
      },
      { now: NOW }
    )

    // 2. Submit for approval
    const submitted = await submitDraftOrderForApproval(
      d1,
      ADMIN_CLAIMS,
      {
        draftOrderId: draft.id,
        expectedVersion: draft.version,
        notes: 'Solicitud de descuento por volumen 50 uds'
      },
      { now: NOW }
    )
    expect(submitted.status).toBe('pending_approval')
    expect(submitted.approvalRequestedAt).toBe(NOW)

    // 3. Reviewer Approves
    const approved = await reviewDraftOrder(
      d1,
      ADMIN_CLAIMS,
      {
        draftOrderId: draft.id,
        decision: 'approved',
        expectedVersion: submitted.version,
        notes: 'Descuento volumen validado por dirección comercial'
      },
      { now: NOW }
    )
    expect(approved.status).toBe('approved')
    expect(approved.approvedBy).toBe(ADMIN_CLAIMS.identityId)

    // 4. Convert to confirmed order
    const converted = await convertDraftOrderToConfirmed(
      d1,
      ADMIN_CLAIMS,
      {
        draftOrderId: draft.id,
        expectedVersion: approved.version,
        confirmedOrderId: 'ord-confirmed-12345'
      },
      { now: NOW }
    )
    expect(converted.status).toBe('converted')
    expect(converted.convertedOrderId).toBe('ord-confirmed-12345')

    // Verify complete timeline trail
    const finalDraft = await getDraftOrder(d1, draft.id)
    const eventTypes = finalDraft?.timeline?.map((e) => e.eventType)
    expect(eventTypes).toEqual(['created', 'submitted_for_approval', 'approved', 'converted'])
  })

  it('sweeps and expires stale draft orders to prevent stale reservations or dangling drafts', async () => {
    // Create draft order expiring in 1 hour
    const draft = await createDraftOrder(
      d1,
      ADMIN_CLAIMS,
      {
        customerId: 'cust-quick-03',
        companyName: 'Lavanderías Rápidas SL',
        contactEmail: 'gerencia@lavarapid.es',
        items: [
          {
            variantId: 'var-detergente-10l',
            sku: 'DET-10L',
            name: 'Detergente Industrial 10L',
            quantity: 5,
            unitPriceCents: 2000,
            lineTotalCents: 10000
          }
        ],
        expiresInHours: 1
      },
      { now: NOW }
    )

    // Fast-forward time to 2 hours later
    const twoHoursLater = '2026-10-29T14:00:00Z'

    // Sweep expired orders
    const sweepResult = await sweepExpiredDraftOrders(d1, twoHoursLater)
    expect(sweepResult.expiredCount).toBeGreaterThanOrEqual(1)

    // Check draft is now 'expired'
    const expiredDraft = await getDraftOrder(d1, draft.id)
    expect(expiredDraft?.status).toBe('expired')

    // Timeline must record 'expired' event by system
    const lastEvent = expiredDraft?.timeline?.slice(-1)[0]
    expect(lastEvent?.eventType).toBe('expired')
    expect(lastEvent?.actorType).toBe('system')

    // Attempting to convert expired draft must fail
    await expect(
      convertDraftOrderToConfirmed(
        d1,
        ADMIN_CLAIMS,
        {
          draftOrderId: draft.id,
          expectedVersion: expiredDraft!.version,
          confirmedOrderId: 'ord-fail'
        },
        { now: twoHoursLater }
      )
    ).rejects.toThrow('draft_order_expired')
  })

  it('rejects unauthorized users without orders.manage permission', async () => {
    await expect(
      createDraftOrder(
        d1,
        UNAUTHORIZED_CLAIMS,
        {
          customerId: 'cust-unauth',
          companyName: 'Test SL',
          contactEmail: 'unauth@test.es',
          items: [{ variantId: 'v1', sku: 'S1', name: 'N1', quantity: 1, unitPriceCents: 100, lineTotalCents: 100 }]
        },
        { now: NOW }
      )
    ).rejects.toThrow(DraftOrderError)
  })

  it('handles draft rejection path and records rejection notes in timeline', async () => {
    const draft = await createDraftOrder(
      d1,
      ADMIN_CLAIMS,
      {
        customerId: 'cust-reject-01',
        companyName: 'Empresa Riesgo SL',
        contactEmail: 'riesgo@empresa.es',
        items: [
          {
            variantId: 'v1',
            sku: 'SKU-R',
            name: 'Producto Riesgo',
            quantity: 1,
            unitPriceCents: 5000,
            lineTotalCents: 5000
          }
        ]
      },
      { now: NOW }
    )

    const submitted = await submitDraftOrderForApproval(
      d1,
      ADMIN_CLAIMS,
      { draftOrderId: draft.id, expectedVersion: draft.version },
      { now: NOW }
    )

    const rejected = await reviewDraftOrder(
      d1,
      ADMIN_CLAIMS,
      {
        draftOrderId: draft.id,
        decision: 'rejected',
        expectedVersion: submitted.version,
        notes: 'Límite de crédito superado'
      },
      { now: NOW }
    )

    expect(rejected.status).toBe('rejected')
    expect(rejected.rejectionReason).toBe('Límite de crédito superado')

    // Cannot convert rejected draft
    await expect(
      convertDraftOrderToConfirmed(
        d1,
        ADMIN_CLAIMS,
        { draftOrderId: draft.id, expectedVersion: rejected.version, confirmedOrderId: 'ord-bad' },
        { now: NOW }
      )
    ).rejects.toThrow(DraftOrderError)
  })

  it('enforces CAS versioning and concurrency controls on all state transitions', async () => {
    const draft = await createDraftOrder(
      d1,
      ADMIN_CLAIMS,
      {
        customerId: 'cust-cas-01',
        companyName: 'CAS Test SL',
        contactEmail: 'cas@test.es',
        items: [
          { variantId: 'v1', sku: 'SKU-CAS', name: 'Item CAS', quantity: 2, unitPriceCents: 1000, lineTotalCents: 2000 }
        ]
      },
      { now: NOW }
    )

    // Stale expectedVersion fails submit
    await expect(
      submitDraftOrderForApproval(d1, ADMIN_CLAIMS, { draftOrderId: draft.id, expectedVersion: 99 }, { now: NOW })
    ).rejects.toThrow('version_conflict')

    const submitted = await submitDraftOrderForApproval(
      d1,
      ADMIN_CLAIMS,
      { draftOrderId: draft.id, expectedVersion: draft.version },
      { now: NOW }
    )

    // Stale expectedVersion fails review
    await expect(
      reviewDraftOrder(
        d1,
        ADMIN_CLAIMS,
        { draftOrderId: draft.id, decision: 'approved', expectedVersion: 1 },
        { now: NOW }
      )
    ).rejects.toThrow('version_conflict')

    const approved = await reviewDraftOrder(
      d1,
      ADMIN_CLAIMS,
      { draftOrderId: draft.id, decision: 'approved', expectedVersion: submitted.version },
      { now: NOW }
    )

    // Stale expectedVersion fails convert
    await expect(
      convertDraftOrderToConfirmed(
        d1,
        ADMIN_CLAIMS,
        { draftOrderId: draft.id, expectedVersion: 2, confirmedOrderId: 'ord-stale' },
        { now: NOW }
      )
    ).rejects.toThrow('version_conflict')

    const converted = await convertDraftOrderToConfirmed(
      d1,
      ADMIN_CLAIMS,
      { draftOrderId: draft.id, expectedVersion: approved.version, confirmedOrderId: 'ord-good' },
      { now: NOW }
    )
    expect(converted.status).toBe('converted')
  })
})

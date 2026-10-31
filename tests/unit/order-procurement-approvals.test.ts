import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import { normalizeCostCenter, normalizePoReference } from '../../shared/order-procurement-approvals'
import {
  assignOrderProcurementDetails,
  reviewOrderProcurementApproval,
  getOrderProcurementDetails,
  exportOrderProcurementCsv,
  getOrderInvoiceProcurementView
} from '../../workers/orders/procurement-approvals'
import {
  handleProcurementApprovalsHttp,
  ownsProcurementApprovalsNamespace
} from '../../workers/orders/procurement-approvals-http'

const now = '2026-10-31T09:00:00Z'
const adminIdentity = '10000000-0000-4000-8000-000000000001'
const adminSession = '20000000-0000-4000-8000-000000000001'
const unprivilegedIdentity = '10000000-0000-4000-8000-000000000002'
const unprivilegedSession = '20000000-0000-4000-8000-000000000002'
const config = { password: 'k'.repeat(64), maxAgeSeconds: 3600 }

let sqlite: DatabaseSync
let database: D1Database
let adminCookie: string
let unprivilegedCookie: string

const testOrderId = '33333333-3333-4333-8333-333333333333'

async function setupTestOrder(orderId: string, grossCents = 150000) {
  const dummyId = `dm-${orderId.slice(0, 18)}`
  const tokenHash = 'a'.repeat(64)
  const expiresAt = '2030-01-01T00:00:00Z'
  const insertNow = '2026-10-31T08:00:00Z'

  sqlite.exec(`
    INSERT OR IGNORE INTO customers(id, name, phone, status, created_at, updated_at)
      VALUES('c-1', 'Cliente Test', NULL, 'active', '${insertNow}', '${insertNow}');
    INSERT OR IGNORE INTO carts(id, token_hash, status, version, expires_at, correlation_id, created_at, updated_at)
      VALUES('${dummyId}', '${tokenHash}', 'active', 1, '${expiresAt}', 'corr-1', '${insertNow}', '${insertNow}');
    INSERT OR IGNORE INTO checkout_quotes(id, cart_id, cart_version, pricing_instant, currency, shipping_gross_cents, shipping_pending, total_net_cents, total_tax_cents, total_gross_cents, snapshot_hash, correlation_id, created_at)
      VALUES('${dummyId}', '${dummyId}', 1, '${insertNow}', 'EUR', 0, 1, ${grossCents}, 0, ${grossCents}, '${tokenHash}', 'corr-1', '${insertNow}');
    INSERT OR IGNORE INTO shipping_quotes(id, cart_id, cart_version, destination_hash, options_json, option_count, snapshot_hash, expires_at, correlation_id, created_at)
      VALUES('${dummyId}', '${dummyId}', 1, '${tokenHash}', '[]', 0, '${tokenHash}', '${expiresAt}', 'corr-1', '${insertNow}');
    INSERT OR IGNORE INTO checkout_attempts(id, cart_id, command_key, state, correlation_id, payload_hash, created_at, updated_at)
      VALUES('${dummyId}', '${dummyId}', 'key-${orderId.slice(0, 8)}', 'failed', 'corr-1', '${tokenHash}', '${insertNow}', '${insertNow}');
    INSERT OR IGNORE INTO orders(id, cart_id, quote_id, shipping_quote_id, attempt_id, token_hash, status, reservation_id, reservation_expires_at, currency, total_net_cents, total_tax_cents, total_gross_cents, shipping_net_cents, shipping_tax_cents, shipping_gross_cents, shipping_method_code, shipping_rate_version, shipping_eta_min_days, shipping_eta_max_days, contact_email, contact_email_hash, consent_tos, consent_privacy, correlation_id, created_at, updated_at, customer_id)
      VALUES('${orderId}', '${dummyId}', '${dummyId}', '${dummyId}', '${dummyId}', '${tokenHash}', 'awaiting_payment', 'res-1', '${expiresAt}', 'EUR', ${grossCents}, 0, ${grossCents}, 0, 0, 0, 'parcel', 1, 1, 3, 'cliente@example.invalid', '${tokenHash}', 1, 1, 'corr-1', '${insertNow}', '${insertNow}', 'c-1');
  `)
}

describe('ORD-020: Pedidos con PO, centro de coste y aprobación', () => {
  beforeEach(async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(now))
    sqlite = await openMigratedDatabase()
    sqlite.exec(await readFile('db/d1/migrations/0074_order_purchase_reference.sql', 'utf8'))
    sqlite.exec(await readFile('db/d1/migrations/0145_orders_procurement_split_contingency.sql', 'utf8'))
    database = d1OverSqlite(sqlite)

    // Admin identity & permissions
    sqlite
      .prepare(
        `
      INSERT INTO identities (id, email, password_hash, email_verified_at, status, created_at, updated_at)
      VALUES (?, 'admin@neteco.es', 'fakehash', ?, 'active', ?, ?)
    `
      )
      .run(adminIdentity, now, now, now)

    sqlite
      .prepare(
        `
      INSERT INTO auth_sessions (id, identity_id, session_version, mfa_verified, created_at, expires_at)
      VALUES (?, ?, 1, 1, ?, '2026-10-31T20:00:00Z')
    `
      )
      .run(adminSession, adminIdentity, now)

    sqlite.exec(`
      INSERT INTO roles (code, name, description) VALUES ('admin', 'Administrator', 'Full admin') ON CONFLICT DO NOTHING;
      INSERT INTO permissions (code, resource, action, description) VALUES ('administration.manage', 'administration', 'manage', 'Admin manage') ON CONFLICT DO NOTHING;
      INSERT INTO role_permissions (role_code, permission_code) VALUES ('admin', 'administration.manage') ON CONFLICT DO NOTHING;
    `)

    sqlite
      .prepare(
        `
      INSERT INTO identity_roles (identity_id, role_code, granted_at)
      VALUES (?, 'admin', ?)
      ON CONFLICT DO NOTHING
    `
      )
      .run(adminIdentity, now)

    // Unprivileged identity
    sqlite
      .prepare(
        `
      INSERT INTO identities (id, email, password_hash, email_verified_at, status, created_at, updated_at)
      VALUES (?, 'user@neteco.es', 'fakehash', ?, 'active', ?, ?)
    `
      )
      .run(unprivilegedIdentity, now, now, now)

    sqlite
      .prepare(
        `
      INSERT INTO auth_sessions (id, identity_id, session_version, mfa_verified, created_at, expires_at)
      VALUES (?, ?, 1, 0, ?, '2026-10-31T20:00:00Z')
    `
      )
      .run(unprivilegedSession, unprivilegedIdentity, now)

    adminCookie = (await issueD1SessionCookie(
      database,
      {
        sessionId: adminSession,
        identityId: adminIdentity,
        sessionVersion: 1
      },
      config
    ))!

    unprivilegedCookie = (await issueD1SessionCookie(
      database,
      {
        sessionId: unprivilegedSession,
        identityId: unprivilegedIdentity,
        sessionVersion: 1
      },
      config
    ))!

    await setupTestOrder(testOrderId, 250000)
  })

  afterEach(() => {
    vi.useRealTimers()
    sqlite.close()
  })

  describe('Validation & Normalization', () => {
    it('normalizes single-line NFC PO reference and rejects invalid characters', () => {
      expect(normalizePoReference('  PO-2026/VAL-01  ')).toBe('PO-2026/VAL-01')
      expect(normalizePoReference('')).toBeNull()
      expect(normalizePoReference(null)).toBeNull()
      expect(() => normalizePoReference('PO\nNewRow')).toThrow()
      expect(() => normalizePoReference('A'.repeat(121))).toThrow()
    })

    it('normalizes Cost Center and rejects control characters or overly long strings', () => {
      expect(normalizeCostCenter('  CC-LOGISTICA-01 ')).toBe('CC-LOGISTICA-01')
      expect(normalizeCostCenter(undefined)).toBeNull()
      expect(() => normalizeCostCenter('CC\r01')).toThrow()
      expect(() => normalizeCostCenter('C'.repeat(81))).toThrow()
    })
  })

  describe('Assign Procurement Details & Approval Rules', () => {
    it('assigns PO and cost center without approval if total is below threshold', async () => {
      const res = await assignOrderProcurementDetails(database, {
        orderId: testOrderId,
        purchaseOrderReference: 'PO-NET-999',
        costCenter: 'CC-HOSPITAL-NORTE',
        approvalThresholdCents: 300000,
        now
      })

      expect(res.approvalStatus).toBe('not_required')
      expect(res.requiresApproval).toBe(false)
      expect(res.purchaseOrderReference).toBe('PO-NET-999')
      expect(res.costCenter).toBe('CC-HOSPITAL-NORTE')
      expect(res.version).toBe(1)
    })

    it('flags pending_approval when order total exceeds threshold or cost center policy requires approval', async () => {
      const res = await assignOrderProcurementDetails(database, {
        orderId: testOrderId,
        purchaseOrderReference: 'PO-BIG-ORDER',
        costCenter: 'CC-CENTRAL',
        approvalThresholdCents: 100000, // 1000 EUR vs 2500 EUR order
        now
      })

      expect(res.approvalStatus).toBe('pending_approval')
      expect(res.requiresApproval).toBe(true)
      expect(res.version).toBe(1)
    })

    it('handles idempotent replays with the same command payload', async () => {
      const input = {
        orderId: testOrderId,
        purchaseOrderReference: 'PO-IDEM-01',
        costCenter: 'CC-IDEM',
        approvalThresholdCents: 500000,
        now
      }
      const first = await assignOrderProcurementDetails(database, input)
      const second = await assignOrderProcurementDetails(database, input)
      expect(second).toEqual(first)
    })
  })

  describe('Approval / Rejection Workflow with CAS & Audit Events', () => {
    it('approves an order with authorized claims, notes and CAS version check', async () => {
      await assignOrderProcurementDetails(database, {
        orderId: testOrderId,
        purchaseOrderReference: 'PO-APPR-01',
        costCenter: 'CC-FINANZAS',
        approvalThresholdCents: 1000,
        now
      })

      const approved = await reviewOrderProcurementApproval(database, {
        orderId: testOrderId,
        action: 'approve',
        expectedVersion: 1,
        actorId: adminIdentity,
        notes: 'Aprobado según presupuesto Q4',
        now
      })

      expect(approved.approvalStatus).toBe('approved')
      expect(approved.approvedBy).toBe(adminIdentity)
      expect(approved.approvedAt).toBe(now)
      expect(approved.version).toBe(2)

      const details = await getOrderProcurementDetails(database, testOrderId)
      expect(details?.approvalStatus).toBe('approved')
      expect(details?.events.length).toBeGreaterThanOrEqual(2)
    })

    it('rejects an order with mandatory reason and transitions status to rejected', async () => {
      await assignOrderProcurementDetails(database, {
        orderId: testOrderId,
        purchaseOrderReference: 'PO-REJ-01',
        costCenter: 'CC-MARKETING',
        approvalThresholdCents: 1000,
        now
      })

      const rejected = await reviewOrderProcurementApproval(database, {
        orderId: testOrderId,
        action: 'reject',
        expectedVersion: 1,
        actorId: adminIdentity,
        rejectionReason: 'Supera el límite trimestral del centro de coste',
        now
      })

      expect(rejected.approvalStatus).toBe('rejected')
      expect(rejected.rejectedBy).toBe(adminIdentity)
      expect(rejected.rejectionReason).toBe('Supera el límite trimestral del centro de coste')
      expect(rejected.version).toBe(2)
    })

    it('rejects stale CAS versions on concurrent approval/rejection attempts', async () => {
      await assignOrderProcurementDetails(database, {
        orderId: testOrderId,
        purchaseOrderReference: 'PO-CAS-01',
        costCenter: 'CC-CAS',
        approvalThresholdCents: 1000,
        now
      })

      await reviewOrderProcurementApproval(database, {
        orderId: testOrderId,
        action: 'approve',
        expectedVersion: 1,
        actorId: adminIdentity,
        now
      })

      await expect(
        reviewOrderProcurementApproval(database, {
          orderId: testOrderId,
          action: 'reject',
          expectedVersion: 1, // Stale! Now version is 2
          actorId: adminIdentity,
          rejectionReason: 'Conflicto tardio',
          now
        })
      ).rejects.toThrow('conflict')
    })
  })

  describe('Invoice Visibility & Exportability (Aceptación ORD-020)', () => {
    it('makes PO reference and cost center visible in invoice representation and metadata', async () => {
      await assignOrderProcurementDetails(database, {
        orderId: testOrderId,
        purchaseOrderReference: 'PO-INV-2026',
        costCenter: 'CC-FACTURACION',
        approvalThresholdCents: 500000,
        now
      })

      const invoiceView = await getOrderInvoiceProcurementView(database, testOrderId)
      expect(invoiceView).not.toBeNull()
      expect(invoiceView?.purchaseOrderReference).toBe('PO-INV-2026')
      expect(invoiceView?.costCenter).toBe('CC-FACTURACION')
      expect(invoiceView?.visibleOnInvoice).toBe(true)
    })

    it('exports procurement order details in CSV with correct BOM, headers, and escaped cells', async () => {
      await assignOrderProcurementDetails(database, {
        orderId: testOrderId,
        purchaseOrderReference: 'PO-EXPORT-01',
        costCenter: 'CC-LOG',
        approvalThresholdCents: 1000,
        now
      })
      await reviewOrderProcurementApproval(database, {
        orderId: testOrderId,
        action: 'approve',
        expectedVersion: 1,
        actorId: adminIdentity,
        notes: 'Export approval',
        now
      })

      const csv = await exportOrderProcurementCsv(database)
      expect(csv.startsWith('\uFEFF')).toBe(true)
      expect(csv).toContain(
        '"orderId","purchaseOrderReference","costCenter","approvalStatus","approvedBy","approvedAt","totalGrossCents","visibleOnInvoice"'
      )
      expect(csv).toContain(testOrderId)
      expect(csv).toContain('PO-EXPORT-01')
      expect(csv).toContain('CC-LOG')
      expect(csv).toContain('approved')
    })
  })

  describe('HTTP Endpoints & Canary Routing Integration', () => {
    it('owns procurement approvals namespace paths', () => {
      expect(ownsProcurementApprovalsNamespace('/api/admin/orders/procurement')).toBe(true)
      expect(ownsProcurementApprovalsNamespace('/api/admin/orders/procurement/assign')).toBe(true)
      expect(ownsProcurementApprovalsNamespace('/api/admin/orders/procurement/approve')).toBe(true)
      expect(ownsProcurementApprovalsNamespace('/api/admin/orders/procurement/export.csv')).toBe(true)
      expect(ownsProcurementApprovalsNamespace('/api/orders/procurement/invoice-view')).toBe(true)
      expect(ownsProcurementApprovalsNamespace('/api/admin/other')).toBe(false)
    })

    it('enforces authentication and administration.manage permission for admin actions', async () => {
      const unauthReq = new Request('https://shop.invalid/api/admin/orders/procurement/assign', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ orderId: testOrderId, purchaseOrderReference: 'PO-UNAUTH' })
      })
      const unauthRes = await handleProcurementApprovalsHttp(unauthReq, { database, now })
      expect(unauthRes?.status).toBe(401)

      const forbiddenReq = new Request('https://shop.invalid/api/admin/orders/procurement/assign', {
        method: 'POST',
        headers: {
          cookie: unprivilegedCookie,
          'content-type': 'application/json'
        },
        body: JSON.stringify({ orderId: testOrderId, purchaseOrderReference: 'PO-DENIED' })
      })
      const forbiddenRes = await handleProcurementApprovalsHttp(forbiddenReq, {
        database,
        sessionCookieConfiguration: config,
        now
      })
      expect(forbiddenRes?.status).toBe(403)
    })

    it('assigns, approves and exports via HTTP with proper responses and headers', async () => {
      const assignReq = new Request('https://shop.invalid/api/admin/orders/procurement/assign', {
        method: 'POST',
        headers: {
          cookie: adminCookie,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          orderId: testOrderId,
          purchaseOrderReference: 'PO-HTTP-01',
          costCenter: 'CC-HTTP',
          approvalThresholdCents: 1000
        })
      })
      const assignRes = await handleProcurementApprovalsHttp(assignReq, {
        database,
        sessionCookieConfiguration: config,
        now
      })
      expect(assignRes?.status).toBe(200)
      const assignBody = await assignRes?.json()
      expect(assignBody.approvalStatus).toBe('pending_approval')

      const approveReq = new Request('https://shop.invalid/api/admin/orders/procurement/approve', {
        method: 'POST',
        headers: {
          cookie: adminCookie,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          orderId: testOrderId,
          expectedVersion: 1,
          notes: 'Approved via Canary HTTP'
        })
      })
      const approveRes = await handleProcurementApprovalsHttp(approveReq, {
        database,
        sessionCookieConfiguration: config,
        now
      })
      expect(approveRes?.status).toBe(200)

      const exportReq = new Request('https://shop.invalid/api/admin/orders/procurement/export.csv', {
        headers: { cookie: adminCookie }
      })
      const exportRes = await handleProcurementApprovalsHttp(exportReq, {
        database,
        sessionCookieConfiguration: config,
        now
      })
      expect(exportRes?.status).toBe(200)
      expect(exportRes?.headers.get('content-type')).toContain('text/csv')
      expect(exportRes?.headers.get('cache-control')).toBe('private, no-store')
      const text = await exportRes?.text()
      expect(text).toContain('PO-HTTP-01')
      expect(text).toContain('CC-HTTP')
    })

    it('enforces append-only immutability on order_procurement_events and blocks cross-customer IDOR on invoice-view', async () => {
      await assignOrderProcurementDetails(database, {
        orderId: testOrderId,
        purchaseOrderReference: 'PO-SECRET-B2B',
        costCenter: 'CC-CONFIDENCIAL',
        approvalThresholdCents: 500000,
        now
      })

      // 1. Append-only trigger prevents UPDATE and DELETE on order_procurement_events
      expect(() => {
        sqlite.exec("UPDATE order_procurement_events SET notes = 'tampered'")
      }).toThrow(/order_procurement_events_immutable/)

      expect(() => {
        sqlite.exec('DELETE FROM order_procurement_events')
      }).toThrow(/order_procurement_events_immutable/)

      // 2. Cross-customer IDOR on /api/orders/procurement/invoice-view is blocked with 403
      const idorReq = new Request(`https://shop.invalid/api/orders/procurement/invoice-view?orderId=${testOrderId}`, {
        headers: { cookie: unprivilegedCookie }
      })
      const idorRes = await handleProcurementApprovalsHttp(idorReq, {
        database,
        sessionCookieConfiguration: config,
        now
      })
      expect(idorRes?.status).toBe(403)
    })
  })
})

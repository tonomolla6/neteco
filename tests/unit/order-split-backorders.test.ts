import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import {
  setCustomerSplitPreferences,
  getCustomerSplitPreferences,
  createOrderSplitShipments,
  reconcileSplitBilling,
  getOrderSplitBillingSummary
} from '../../workers/orders/split-backorders'
import { handleSplitBackordersHttp, ownsSplitBackordersNamespace } from '../../workers/orders/split-backorders-http'

const now = '2026-10-31T09:00:00Z'
const adminIdentity = '10000000-0000-4000-8000-000000000001'
const adminSession = '20000000-0000-4000-8000-000000000001'
const customerIdentity = '10000000-0000-4000-8000-000000000003'
const customerSession = '20000000-0000-4000-8000-000000000003'
const config = { password: 's'.repeat(64), maxAgeSeconds: 3600 }

let sqlite: DatabaseSync
let database: D1Database
let adminCookie: string
let customerCookie: string

const testOrderId = '44444444-4444-4444-8444-444444444444'

async function setupTestOrderWithLines(orderId: string) {
  const dummyId = `dm-${orderId.slice(0, 18)}`
  const tokenHash = 'a'.repeat(64)
  const expiresAt = '2030-01-01T00:00:00Z'
  const insertNow = '2026-10-31T08:00:00Z'

  sqlite.exec(`
    INSERT OR IGNORE INTO customers(id, name, phone, status, created_at, updated_at)
      VALUES('cust-split-1', 'Cliente Split', NULL, 'active', '${insertNow}', '${insertNow}');
    INSERT OR IGNORE INTO carts(id, token_hash, status, version, expires_at, correlation_id, created_at, updated_at)
      VALUES('${dummyId}', '${tokenHash}', 'active', 1, '${expiresAt}', 'corr-1', '${insertNow}', '${insertNow}');
    INSERT OR IGNORE INTO checkout_quotes(id, cart_id, cart_version, pricing_instant, currency, shipping_gross_cents, shipping_pending, total_net_cents, total_tax_cents, total_gross_cents, snapshot_hash, correlation_id, created_at)
      VALUES('${dummyId}', '${dummyId}', 1, '${insertNow}', 'EUR', 0, 1, 18500, 3885, 22385, '${tokenHash}', 'corr-1', '${insertNow}');
    INSERT OR IGNORE INTO shipping_quotes(id, cart_id, cart_version, destination_hash, options_json, option_count, snapshot_hash, expires_at, correlation_id, created_at)
      VALUES('${dummyId}', '${dummyId}', 1, '${tokenHash}', '[]', 0, '${tokenHash}', '${expiresAt}', 'corr-1', '${insertNow}');
    INSERT OR IGNORE INTO checkout_attempts(id, cart_id, command_key, state, correlation_id, payload_hash, created_at, updated_at)
      VALUES('${dummyId}', '${dummyId}', 'key-${orderId.slice(0, 8)}', 'failed', 'corr-1', '${tokenHash}', '${insertNow}', '${insertNow}');
    INSERT OR IGNORE INTO orders(id, cart_id, quote_id, shipping_quote_id, attempt_id, token_hash, status, reservation_id, reservation_expires_at, currency, total_net_cents, total_tax_cents, total_gross_cents, shipping_net_cents, shipping_tax_cents, shipping_gross_cents, shipping_method_code, shipping_rate_version, shipping_eta_min_days, shipping_eta_max_days, contact_email, contact_email_hash, consent_tos, consent_privacy, correlation_id, created_at, updated_at, customer_id)
      VALUES('${orderId}', '${dummyId}', '${dummyId}', '${dummyId}', '${dummyId}', '${tokenHash}', 'awaiting_payment', 'res-1', '${expiresAt}', 'EUR', 18500, 3885, 22385, 500, 105, 605, 'parcel', 1, 1, 3, 'cliente@example.invalid', '${tokenHash}', 1, 1, 'corr-1', '${insertNow}', '${insertNow}', 'cust-split-1');
  `)

  sqlite.exec(`
    INSERT OR IGNORE INTO categories(id,legacy_id,name,slug,status) VALUES('category',1,'Synthetic category','synthetic-category','draft');
    INSERT OR IGNORE INTO tax_classes(id,code,name,rate_basis_points,valid_from) VALUES('tax','SYNTHETIC','Synthetic',2100,'2020-01-01T00:00:00Z');
    INSERT OR IGNORE INTO shipping_profiles(id,code,name,kind) VALUES('ship','SYNTHETIC','Synthetic','parcel');
    INSERT OR IGNORE INTO products(id,legacy_id,category_id,name,slug,status) VALUES('prod-1',1,'category','Synthetic draft','synthetic-draft','draft');
    INSERT OR IGNORE INTO variants(id,legacy_id,product_id,tax_class_id,shipping_profile_id,sku,format,status,unit_base,price_gross_cents,safety_stock)
      VALUES('var-clean-1',11,'prod-1','tax','ship','SKU-CLN-1','Caja','draft','ud',2420,2);
    INSERT OR IGNORE INTO variants(id,legacy_id,product_id,tax_class_id,shipping_profile_id,sku,format,status,unit_base,price_gross_cents,safety_stock)
      VALUES('var-clean-2',12,'prod-1','tax','ship','SKU-CLN-2','Caja','draft','ud',2420,2);
    INSERT OR IGNORE INTO inventory_locations(id,code,name,kind,active,created_at) VALUES('main','MAIN','Synthetic warehouse','warehouse',1,'2020-01-01T00:00:00Z');
    INSERT OR IGNORE INTO variant_price_versions(id,variant_id,gross_cents,valid_from,created_at)
      VALUES('pv-1','var-clean-1',2420,'2020-01-01T00:00:00Z','2020-01-01T00:00:00Z');
    INSERT OR IGNORE INTO variant_price_versions(id,variant_id,gross_cents,valid_from,created_at)
      VALUES('pv-2','var-clean-2',2420,'2020-01-01T00:00:00Z','2020-01-01T00:00:00Z');
  `)

  // Line 0: 5 units of v-clean-1 @ 2420 cents gross
  sqlite
    .prepare(
      `
    INSERT INTO order_lines (order_id, line_index, variant_id, sku, name, quantity,
      unit_gross_cents, net_cents, tax_cents, gross_cents, tax_rate_basis_points,
      price_version_id, location_id, created_at)
    VALUES (?, 0, 'var-clean-1', 'SKU-CLN-1', 'Limpiador Multiusos 5L', 5, 2420, 10000, 2100, 12100, 2100, 'pv-1', 'main', ?)
  `
    )
    .run(orderId, insertNow)

  // Line 1: 4 units of v-clean-2 @ 2420 cents gross
  sqlite
    .prepare(
      `
    INSERT INTO order_lines (order_id, line_index, variant_id, sku, name, quantity,
      unit_gross_cents, net_cents, tax_cents, gross_cents, tax_rate_basis_points,
      price_version_id, location_id, created_at)
    VALUES (?, 1, 'var-clean-2', 'SKU-CLN-2', 'Desinfectante Clorado 10L', 4, 2420, 8000, 1680, 9680, 2100, 'pv-2', 'main', ?)
  `
    )
    .run(orderId, insertNow)
}

describe('ORD-021: Split y backorder por disponibilidad', () => {
  beforeEach(async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(now))
    sqlite = await openMigratedDatabase()
    sqlite.exec(await readFile('db/d1/migrations/0145_orders_procurement_split_contingency.sql', 'utf8'))
    database = d1OverSqlite(sqlite)

    // Admin
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

    // Customer
    sqlite
      .prepare(
        `
      INSERT INTO customers (id, name, created_at, updated_at)
      VALUES ('cust-split-1', 'Cliente Split', ?, ?)
    `
      )
      .run(now, now)

    sqlite
      .prepare(
        `
      INSERT INTO identities (id, email, password_hash, email_verified_at, status, customer_id, created_at, updated_at)
      VALUES (?, 'buyer@cliente.es', 'fakehash', ?, 'active', 'cust-split-1', ?, ?)
    `
      )
      .run(customerIdentity, now, now, now)

    sqlite
      .prepare(
        `
      INSERT INTO auth_sessions (id, identity_id, session_version, mfa_verified, created_at, expires_at)
      VALUES (?, ?, 1, 0, ?, '2026-10-31T20:00:00Z')
    `
      )
      .run(customerSession, customerIdentity, now)

    adminCookie = (await issueD1SessionCookie(
      database,
      {
        sessionId: adminSession,
        identityId: adminIdentity,
        sessionVersion: 1
      },
      config
    ))!

    customerCookie = (await issueD1SessionCookie(
      database,
      {
        sessionId: customerSession,
        identityId: customerIdentity,
        sessionVersion: 1
      },
      config
    ))!

    await setupTestOrderWithLines(testOrderId)
  })

  afterEach(() => {
    vi.useRealTimers()
    sqlite.close()
  })

  describe('Customer Split Acceptance & Preferences', () => {
    it('records customer acceptance of split shipments and agreed extra shipping cost', async () => {
      const prefs = await setCustomerSplitPreferences(database, {
        orderId: testOrderId,
        customerAcceptsSplit: true,
        acceptedExtraShippingCents: 450,
        shippingCostPayer: 'customer',
        customerId: 'cust-split-1',
        now
      })

      expect(prefs.customerAcceptsSplit).toBe(true)
      expect(prefs.acceptedExtraShippingCents).toBe(450)
      expect(prefs.shippingCostPayer).toBe('customer')
      expect(prefs.customerConsentAt).toBe(now)
      expect(prefs.version).toBe(1)

      const saved = await getCustomerSplitPreferences(database, testOrderId)
      expect(saved?.customerAcceptsSplit).toBe(true)
      expect(saved?.acceptedExtraShippingCents).toBe(450)
    })

    it('allows merchant absorption of extra split shipping cost when policy is merchant', async () => {
      const prefs = await setCustomerSplitPreferences(database, {
        orderId: testOrderId,
        customerAcceptsSplit: true,
        acceptedExtraShippingCents: 0,
        shippingCostPayer: 'merchant',
        customerId: 'cust-split-1',
        now
      })

      expect(prefs.shippingCostPayer).toBe('merchant')
      expect(prefs.acceptedExtraShippingCents).toBe(0)
    })
  })

  describe('Split Fulfillment Execution & Stock Coherence', () => {
    it('blocks split shipments if customer has not accepted split delivery', async () => {
      // Customer has NOT consented
      await expect(
        createOrderSplitShipments(database, {
          orderId: testOrderId,
          allocations: [
            { lineIndex: 0, quantityToShip: 5, quantityBackordered: 0 },
            { lineIndex: 1, quantityToShip: 1, quantityBackordered: 3 }
          ],
          estimatedRestockAt: '2026-11-15T00:00:00Z',
          now
        })
      ).rejects.toThrow('split_not_accepted')
    })

    it('splits order into immediate shipment and backorder shipment respecting availability', async () => {
      await setCustomerSplitPreferences(database, {
        orderId: testOrderId,
        customerAcceptsSplit: true,
        acceptedExtraShippingCents: 0,
        shippingCostPayer: 'merchant',
        now
      })

      const result = await createOrderSplitShipments(database, {
        orderId: testOrderId,
        allocations: [
          { lineIndex: 0, quantityToShip: 5, quantityBackordered: 0 }, // Fully available
          { lineIndex: 1, quantityToShip: 1, quantityBackordered: 3 } // Partial (1 available, 3 backordered)
        ],
        estimatedRestockAt: '2026-11-15T00:00:00Z',
        carrier: 'Correos Express',
        now
      })

      expect(result.shipments.length).toBe(2)

      const immediate = result.shipments.find((s) => s.shipmentType === 'immediate')
      const backorder = result.shipments.find((s) => s.shipmentType === 'backorder')

      expect(immediate).toBeDefined()
      expect(immediate?.status).toBe('pending')
      expect(immediate?.items.length).toBe(2)
      expect(immediate?.items.find((i) => i.lineIndex === 0)?.quantityAllocated).toBe(5)
      expect(immediate?.items.find((i) => i.lineIndex === 1)?.quantityAllocated).toBe(1)

      expect(backorder).toBeDefined()
      expect(backorder?.status).toBe('pending')
      expect(backorder?.estimatedRestockAt).toBe('2026-11-15T00:00:00Z')
      expect(backorder?.items.find((i) => i.lineIndex === 1)?.quantityBackordered).toBe(3)
    })

    it('rejects allocation when sum of shipped and backordered does not match order line quantity', async () => {
      await setCustomerSplitPreferences(database, {
        orderId: testOrderId,
        customerAcceptsSplit: true,
        acceptedExtraShippingCents: 0,
        shippingCostPayer: 'merchant',
        now
      })

      await expect(
        createOrderSplitShipments(database, {
          orderId: testOrderId,
          allocations: [
            { lineIndex: 0, quantityToShip: 2, quantityBackordered: 1 } // Total 3 vs requested 5!
          ],
          now
        })
      ).rejects.toThrow('quantity_mismatch')
    })
  })

  describe('Billing Reconciliation & Invoicing Coherence', () => {
    it('reconciles partial billing across split shipments ensuring exact totals matching order', async () => {
      await setCustomerSplitPreferences(database, {
        orderId: testOrderId,
        customerAcceptsSplit: true,
        acceptedExtraShippingCents: 450,
        shippingCostPayer: 'customer',
        now
      })

      const split = await createOrderSplitShipments(database, {
        orderId: testOrderId,
        allocations: [
          { lineIndex: 0, quantityToShip: 5, quantityBackordered: 0 },
          { lineIndex: 1, quantityToShip: 1, quantityBackordered: 3 }
        ],
        estimatedRestockAt: '2026-11-15T00:00:00Z',
        now
      })

      const immediateShipment = split.shipments.find((s) => s.shipmentType === 'immediate')!
      const backorderShipment = split.shipments.find((s) => s.shipmentType === 'backorder')!

      // Immediate invoice: Line 0 (12100) + Line 1 partial 1 unit (2420) + Base Shipping (605) = 15125
      const rec1 = await reconcileSplitBilling(database, {
        orderId: testOrderId,
        shipmentId: immediateShipment.id,
        invoiceNumber: 'FAC-2026-001',
        amountNetCents: 12000,
        taxCents: 2520,
        shippingCents: 605,
        totalGrossCents: 15125,
        now
      })
      expect(rec1.status).toBe('reconciled')

      // Backorder invoice: Line 1 remaining 3 units (7260) + agreed extra shipping (450) = 7710
      // Total gross: 15125 + 7710 = 22835 (Order gross 22385 + accepted extra shipping 450)
      const rec2 = await reconcileSplitBilling(database, {
        orderId: testOrderId,
        shipmentId: backorderShipment.id,
        invoiceNumber: 'FAC-2026-002',
        amountNetCents: 6000,
        taxCents: 1260,
        shippingCents: 450,
        totalGrossCents: 7710,
        now
      })
      expect(rec2.status).toBe('reconciled')

      const summary = await getOrderSplitBillingSummary(database, testOrderId)
      expect(summary.totalBilledCents).toBe(22835)
      expect(summary.expectedTotalCents).toBe(22835)
      expect(summary.isFullyReconciled).toBe(true)
      expect(summary.discrepancyCents).toBe(0)
    })

    it('flags billing discrepancy when partial invoices exceed or fall short of agreed order amount', async () => {
      await setCustomerSplitPreferences(database, {
        orderId: testOrderId,
        customerAcceptsSplit: true,
        acceptedExtraShippingCents: 0,
        shippingCostPayer: 'merchant',
        now
      })

      await reconcileSplitBilling(database, {
        orderId: testOrderId,
        invoiceNumber: 'FAC-WRONG-01',
        amountNetCents: 20000,
        taxCents: 4200,
        shippingCents: 0,
        totalGrossCents: 24200, // Exceeds order total 22385!
        now
      })

      const summary = await getOrderSplitBillingSummary(database, testOrderId)
      expect(summary.isFullyReconciled).toBe(false)
      expect(summary.discrepancyCents).toBe(1815)
    })

    it('enforces idempotency on split shipments and billing reconciliation and rejects arithmetic mismatch', async () => {
      await setCustomerSplitPreferences(database, {
        orderId: testOrderId,
        customerAcceptsSplit: true,
        acceptedExtraShippingCents: 0,
        shippingCostPayer: 'merchant',
        now
      })

      const allocations = [
        { lineIndex: 0, quantityToShip: 5, quantityBackordered: 0 },
        { lineIndex: 1, quantityToShip: 1, quantityBackordered: 3 }
      ]
      const firstSplit = await createOrderSplitShipments(database, {
        orderId: testOrderId,
        allocations,
        now
      })
      const replaySplit = await createOrderSplitShipments(database, {
        orderId: testOrderId,
        allocations,
        now
      })
      expect(replaySplit.shipments.map((s) => s.id)).toEqual(firstSplit.shipments.map((s) => s.id))

      // Arithmetic mismatch in invoice (net + tax + shipping !== gross) must be rejected
      await expect(
        reconcileSplitBilling(database, {
          orderId: testOrderId,
          invoiceNumber: 'FAC-BAD-MATH',
          amountNetCents: 10000,
          taxCents: 2100,
          shippingCents: 0,
          totalGrossCents: 99999,
          now
        })
      ).rejects.toThrow('invalid_invoice_totals')

      // Idempotent billing reconciliation replay does not duplicate invoice totals
      const invInput = {
        orderId: testOrderId,
        invoiceNumber: 'FAC-IDEM-01',
        amountNetCents: 10000,
        taxCents: 2100,
        shippingCents: 0,
        totalGrossCents: 12100,
        now
      }
      const firstInv = await reconcileSplitBilling(database, invInput)
      const secondInv = await reconcileSplitBilling(database, invInput)
      expect(secondInv.id).toBe(firstInv.id)
    })
  })

  describe('HTTP Endpoints & Routing', () => {
    it('owns split backorders namespace paths', () => {
      expect(ownsSplitBackordersNamespace('/api/orders/split-preferences')).toBe(true)
      expect(ownsSplitBackordersNamespace('/api/admin/orders/split-shipments')).toBe(true)
      expect(ownsSplitBackordersNamespace('/api/admin/orders/split-shipments/create')).toBe(true)
      expect(ownsSplitBackordersNamespace('/api/admin/orders/split-billing')).toBe(true)
      expect(ownsSplitBackordersNamespace('/api/admin/orders/split-billing/reconcile')).toBe(true)
      expect(ownsSplitBackordersNamespace('/api/other/unrelated')).toBe(false)
    })

    it('rejects unauthenticated or cross-customer POST to /api/orders/split-preferences', async () => {
      const unauthReq = new Request('https://shop.invalid/api/orders/split-preferences', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          orderId: testOrderId,
          customerAcceptsSplit: true,
          acceptedExtraShippingCents: 0,
          shippingCostPayer: 'merchant'
        })
      })
      const unauthRes = await handleSplitBackordersHttp(unauthReq, {
        database,
        sessionCookieConfiguration: config,
        now
      })
      expect(unauthRes?.status).toBe(401)
    })

    it('saves customer split preferences and performs admin split shipment creation via HTTP', async () => {
      const prefReq = new Request('https://shop.invalid/api/orders/split-preferences', {
        method: 'POST',
        headers: {
          cookie: customerCookie,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          orderId: testOrderId,
          customerAcceptsSplit: true,
          acceptedExtraShippingCents: 0,
          shippingCostPayer: 'merchant'
        })
      })
      const prefRes = await handleSplitBackordersHttp(prefReq, {
        database,
        sessionCookieConfiguration: config,
        now
      })
      expect(prefRes?.status).toBe(200)

      const splitReq = new Request('https://shop.invalid/api/admin/orders/split-shipments/create', {
        method: 'POST',
        headers: {
          cookie: adminCookie,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          orderId: testOrderId,
          allocations: [
            { lineIndex: 0, quantityToShip: 5, quantityBackordered: 0 },
            { lineIndex: 1, quantityToShip: 2, quantityBackordered: 2 }
          ],
          estimatedRestockAt: '2026-11-20T00:00:00Z'
        })
      })
      const splitRes = await handleSplitBackordersHttp(splitReq, {
        database,
        sessionCookieConfiguration: config,
        now
      })
      expect(splitRes?.status).toBe(200)
      const splitBody = await splitRes?.json()
      expect(splitBody.shipments.length).toBe(2)
    })
  })
})

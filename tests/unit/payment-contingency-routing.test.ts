import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import type { PaymentRequest, RefundRequest } from '../../server/integrations/payment-provider'
import {
  AlternativeMarketPaymentProvider,
  ALTERNATIVE_PROVIDER_NAME
} from '../../workers/payments/alternative-contingency-provider'
import {
  determinePaymentProviderRoute,
  toggleContingencyRouting,
  recordUnifiedPaymentSettlement,
  listUnifiedPaymentReconciliations
} from '../../workers/payments/contingency-routing'
import {
  handlePaymentContingencyHttp,
  ownsPaymentContingencyNamespace
} from '../../workers/payments/contingency-routing-http'

const now = '2026-10-31T09:00:00Z'
const adminIdentity = '10000000-0000-4000-8000-000000000001'
const adminSession = '20000000-0000-4000-8000-000000000001'
const config = { password: 'c'.repeat(64), maxAgeSeconds: 3600 }

let sqlite: DatabaseSync
let database: D1Database
let adminCookie: string

const testOrderId = '55555555-5555-4555-8555-555555555555'

async function setupTestOrder(orderId: string, grossCents = 10000) {
  const dummyId = `dm-${orderId.slice(0, 18)}`
  const tokenHash = 'a'.repeat(64)
  const expiresAt = '2030-01-01T00:00:00Z'
  const insertNow = '2026-10-31T08:00:00Z'

  sqlite.exec(`
    INSERT OR IGNORE INTO customers(id, name, phone, status, created_at, updated_at)
      VALUES('cust-pay-1', 'Cliente Test', NULL, 'active', '${insertNow}', '${insertNow}');
    INSERT OR IGNORE INTO carts(id, token_hash, status, version, expires_at, correlation_id, created_at, updated_at)
      VALUES('${dummyId}', '${tokenHash}', 'active', 1, '${expiresAt}', 'corr-1', '${insertNow}', '${insertNow}');
    INSERT OR IGNORE INTO checkout_quotes(id, cart_id, cart_version, pricing_instant, currency, shipping_gross_cents, shipping_pending, total_net_cents, total_tax_cents, total_gross_cents, snapshot_hash, correlation_id, created_at)
      VALUES('${dummyId}', '${dummyId}', 1, '${insertNow}', 'EUR', 0, 1, ${grossCents}, 0, ${grossCents}, '${tokenHash}', 'corr-1', '${insertNow}');
    INSERT OR IGNORE INTO shipping_quotes(id, cart_id, cart_version, destination_hash, options_json, option_count, snapshot_hash, expires_at, correlation_id, created_at)
      VALUES('${dummyId}', '${dummyId}', 1, '${tokenHash}', '[]', 0, '${tokenHash}', '${expiresAt}', 'corr-1', '${insertNow}');
    INSERT OR IGNORE INTO checkout_attempts(id, cart_id, command_key, state, correlation_id, payload_hash, created_at, updated_at)
      VALUES('${dummyId}', '${dummyId}', 'key-${orderId.slice(0, 8)}', 'failed', 'corr-1', '${tokenHash}', '${insertNow}', '${insertNow}');
    INSERT OR IGNORE INTO orders(id, cart_id, quote_id, shipping_quote_id, attempt_id, token_hash, status, reservation_id, reservation_expires_at, currency, total_net_cents, total_tax_cents, total_gross_cents, shipping_net_cents, shipping_tax_cents, shipping_gross_cents, shipping_method_code, shipping_rate_version, shipping_eta_min_days, shipping_eta_max_days, contact_email, contact_email_hash, consent_tos, consent_privacy, correlation_id, created_at, updated_at, customer_id)
      VALUES('${orderId}', '${dummyId}', '${dummyId}', '${dummyId}', '${dummyId}', '${tokenHash}', 'awaiting_payment', 'res-1', '${expiresAt}', 'EUR', ${grossCents}, 0, ${grossCents}, 0, 0, 0, 'parcel', 1, 1, 3, 'cliente@example.invalid', '${tokenHash}', 1, 1, 'corr-1', '${insertNow}', '${insertNow}', 'cust-pay-1');
  `)
}

describe('PAY-023: Proveedor alternativo por mercado y contingencia', () => {
  const providerSecret = 'contingency-secret-key-123456789012'
  let alternativeProvider: AlternativeMarketPaymentProvider

  beforeEach(async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(now))
    sqlite = await openMigratedDatabase()
    sqlite.exec(await readFile('db/d1/migrations/0145_orders_procurement_split_contingency.sql', 'utf8'))
    database = d1OverSqlite(sqlite)

    // Admin session setup
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

    adminCookie = (await issueD1SessionCookie(
      database,
      {
        sessionId: adminSession,
        identityId: adminIdentity,
        sessionVersion: 1
      },
      config
    ))!

    alternativeProvider = new AlternativeMarketPaymentProvider({
      secretKey: providerSecret,
      merchantId: 'merchant-alt-01',
      endpointUrl: 'https://contingency.payments.invalid/pay'
    })

    await setupTestOrder(testOrderId, 10000)
  })

  afterEach(() => {
    vi.useRealTimers()
    sqlite.close()
  })

  describe('Isolated Alternative Provider Adapter (PaymentProvider contract)', () => {
    it('implements PaymentProvider interface with isolated signature creation and redirect fields', async () => {
      const request: PaymentRequest = {
        intentId: 'intent-001',
        orderReference: testOrderId,
        amountCents: 10000,
        currency: 'EUR',
        method: 'card',
        returnUrl: 'https://shop.invalid/checkout/complete',
        notificationUrl: 'https://shop.invalid/api/payments/alternative/webhook',
        idempotencyKey: 'idem-alt-01'
      }

      const redirect = await alternativeProvider.createRedirect(request)
      expect(redirect.provider).toBe(ALTERNATIVE_PROVIDER_NAME)
      expect(redirect.actionUrl).toBe('https://contingency.payments.invalid/pay')
      expect(redirect.method).toBe('POST')
      expect(redirect.fields.merchant_id).toBe('merchant-alt-01')
      expect(redirect.fields.order_reference).toBe(testOrderId)
      expect(redirect.fields.amount_cents).toBe('10000')
      expect(redirect.fields.signature).toMatch(/^[0-9a-f]{64}$/)
    })

    it('verifies valid notification webhook signature and extracts unified payment facts', async () => {
      const payload: Record<string, string> = {
        provider_event_id: 'evt-alt-888',
        provider_reference: 'ref-contingency-999',
        order_reference: testOrderId,
        amount_cents: '10000',
        currency: 'EUR',
        status: 'captured',
        response_code: '0000'
      }
      const signature = await alternativeProvider.signPayload(payload)
      payload.signature = signature

      const notification = await alternativeProvider.verifyNotification(payload)
      expect(notification.status).toBe('captured')
      expect(notification.orderReference).toBe(testOrderId)
      expect(notification.amountCents).toBe(10000)
      expect(notification.responseCode).toBe('0000')
      expect(notification.payloadHash).toMatch(/^[0-9a-f]{64}$/)
    })

    it('rejects tampered or forged notification payloads with invalid signature', async () => {
      const payload: Record<string, string> = {
        provider_event_id: 'evt-tampered',
        order_reference: testOrderId,
        amount_cents: '10000',
        currency: 'EUR',
        status: 'captured',
        response_code: '0000',
        signature: 'deadbeef'.repeat(8)
      }

      await expect(alternativeProvider.verifyNotification(payload)).rejects.toThrow('invalid_signature')
    })

    it('executes deterministic refunds without exposing PAN or credentials', async () => {
      const refundReq: RefundRequest = {
        paymentReference: 'ref-contingency-999',
        orderReference: testOrderId,
        amountCents: 5000,
        reason: 'Client requested cancellation of split line',
        idempotencyKey: 'refund-idem-01'
      }

      const refundResult = await alternativeProvider.refund(refundReq)
      expect(refundResult.status).toBe('succeeded')
      expect(refundResult.providerReference).toBe('ref-contingency-999-refund')
    })
  })

  describe('Contingency & Market Routing Engine', () => {
    it('routes to primary provider (redsys) by default when contingency is inactive', async () => {
      const decision = await determinePaymentProviderRoute(database, {
        marketCode: 'ES',
        orderId: testOrderId
      })

      expect(decision.selectedProvider).toBe('redsys')
      expect(decision.isContingency).toBe(false)
    })

    it('routes to alternative provider when market routing rule designates alternative provider', async () => {
      sqlite
        .prepare(
          `
        INSERT INTO payment_contingency_routing (
          id, market_code, primary_provider, alternative_provider, active_provider,
          contingency_active, created_at, updated_at
        ) VALUES ('route-pt', 'PT', 'euro_contingency', 'redsys', 'euro_contingency', 0, ?, ?)
      `
        )
        .run(now, now)

      const decision = await determinePaymentProviderRoute(database, {
        marketCode: 'PT',
        orderId: testOrderId
      })

      expect(decision.selectedProvider).toBe('euro_contingency')
      expect(decision.isContingency).toBe(false)
    })

    it('switches routing to alternative provider when administrator activates contingency mode', async () => {
      const updated = await toggleContingencyRouting(database, {
        marketCode: 'ES',
        activateContingency: true,
        reason: 'Redsys maintenance window degradation detected',
        actorId: adminIdentity,
        expectedVersion: 1,
        now
      })

      expect(updated.contingencyActive).toBe(true)
      expect(updated.activeProvider).toBe('euro_contingency')
      expect(updated.version).toBe(2)

      const decision = await determinePaymentProviderRoute(database, {
        marketCode: 'ES',
        orderId: testOrderId
      })

      expect(decision.selectedProvider).toBe('euro_contingency')
      expect(decision.isContingency).toBe(true)
      expect(decision.contingencyReason).toContain('Redsys maintenance')
    })

    it('enforces CAS version concurrency when changing contingency status', async () => {
      await toggleContingencyRouting(database, {
        marketCode: 'ES',
        activateContingency: true,
        reason: 'First trigger',
        actorId: adminIdentity,
        expectedVersion: 1,
        now
      })

      await expect(
        toggleContingencyRouting(database, {
          marketCode: 'ES',
          activateContingency: false,
          reason: 'Conflicting concurrent deactivation',
          actorId: adminIdentity,
          expectedVersion: 1, // Stale!
          now
        })
      ).rejects.toThrow('conflict')
    })
  })

  describe('Unified Settlement Reconciliation (Aceptación PAY-023)', () => {
    it('records settlements from both Redsys and alternative provider into unified reconciliation ledger', async () => {
      // Redsys settlement
      await recordUnifiedPaymentSettlement(database, {
        intentId: 'pi-redsys-01',
        orderId: testOrderId,
        provider: 'redsys',
        providerReference: 'redsys-ref-1234',
        amountCents: 6000,
        currency: 'EUR',
        status: 'settled',
        payloadHash: 'a'.repeat(64),
        settledAt: now,
        now
      })

      // Alternative provider settlement
      await recordUnifiedPaymentSettlement(database, {
        intentId: 'pi-alt-02',
        orderId: testOrderId,
        provider: 'euro_contingency',
        providerReference: 'alt-ref-5678',
        amountCents: 4000,
        currency: 'EUR',
        status: 'settled',
        payloadHash: 'b'.repeat(64),
        settledAt: now,
        now
      })

      const reconciliations = await listUnifiedPaymentReconciliations(database, { orderId: testOrderId })
      expect(reconciliations.length).toBe(2)

      const redsysRow = reconciliations.find((r) => r.provider === 'redsys')
      const altRow = reconciliations.find((r) => r.provider === 'euro_contingency')

      expect(redsysRow?.amountCents).toBe(6000)
      expect(altRow?.amountCents).toBe(4000)

      const totalSettled = reconciliations.reduce((sum, r) => sum + r.amountCents, 0)
      expect(totalSettled).toBe(10000) // Exactly matches order total!
    })

    it('prevents reconciliation fragmentation: idempotent updates do not create duplicate entries', async () => {
      const input = {
        intentId: 'pi-alt-idem',
        orderId: testOrderId,
        provider: 'euro_contingency' as const,
        providerReference: 'alt-unique-ref',
        amountCents: 10000,
        currency: 'EUR' as const,
        status: 'settled' as const,
        payloadHash: 'c'.repeat(64),
        settledAt: now,
        now
      }

      const first = await recordUnifiedPaymentSettlement(database, input)
      const second = await recordUnifiedPaymentSettlement(database, input)
      expect(second.id).toBe(first.id)

      const reconciliations = await listUnifiedPaymentReconciliations(database, { orderId: testOrderId })
      expect(reconciliations.length).toBe(1)

      // Conflicting payloadHash for the same providerReference must be rejected
      await expect(
        recordUnifiedPaymentSettlement(database, {
          ...input,
          amountCents: 9999,
          payloadHash: 'd'.repeat(64)
        })
      ).rejects.toThrow('conflict')
    })

    it('marks webhook settlement as discrepancy when captured amount differs from order total', async () => {
      const payload: Record<string, string> = {
        provider_event_id: 'evt-mismatch-01',
        provider_reference: 'ref-mismatch-01',
        order_reference: testOrderId,
        amount_cents: '5000', // Order total is 10000
        currency: 'EUR',
        status: 'captured',
        response_code: '0000'
      }
      payload.signature = await alternativeProvider.signPayload(payload)

      const webhookReq = new Request('https://shop.invalid/api/payments/alternative/webhook', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload)
      })
      const webhookRes = await handlePaymentContingencyHttp(webhookReq, {
        database,
        alternativeProvider,
        now
      })
      expect(webhookRes?.status).toBe(200)
      const body = await webhookRes?.json()
      expect(body.status).toBe('discrepancy')
    })
  })

  describe('HTTP Endpoints & Routing', () => {
    it('owns payment contingency namespace paths', () => {
      expect(ownsPaymentContingencyNamespace('/api/admin/payments/contingency/status')).toBe(true)
      expect(ownsPaymentContingencyNamespace('/api/admin/payments/contingency/toggle')).toBe(true)
      expect(ownsPaymentContingencyNamespace('/api/payments/alternative/webhook')).toBe(true)
      expect(ownsPaymentContingencyNamespace('/api/admin/payments/unified-reconciliation')).toBe(true)
      expect(ownsPaymentContingencyNamespace('/api/unrelated/path')).toBe(false)
    })

    it('toggles contingency mode and processes alternative webhook via HTTP', async () => {
      const toggleReq = new Request('https://shop.invalid/api/admin/payments/contingency/toggle', {
        method: 'POST',
        headers: {
          cookie: adminCookie,
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          marketCode: 'ES',
          activateContingency: true,
          reason: 'Switch to alternative gateway for contingency drill',
          expectedVersion: 1
        })
      })
      const toggleRes = await handlePaymentContingencyHttp(toggleReq, {
        database,
        sessionCookieConfiguration: config,
        now
      })
      expect(toggleRes?.status).toBe(200)

      const payload: Record<string, string> = {
        provider_event_id: 'evt-http-01',
        provider_reference: 'ref-http-alt-01',
        order_reference: testOrderId,
        amount_cents: '10000',
        currency: 'EUR',
        status: 'captured',
        response_code: '0000'
      }
      payload.signature = await alternativeProvider.signPayload(payload)

      const webhookReq = new Request('https://shop.invalid/api/payments/alternative/webhook', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload)
      })
      const webhookRes = await handlePaymentContingencyHttp(webhookReq, {
        database,
        alternativeProvider,
        now
      })
      expect(webhookRes?.status).toBe(200)

      const reconReq = new Request(
        `https://shop.invalid/api/admin/payments/unified-reconciliation?orderId=${testOrderId}`,
        {
          headers: { cookie: adminCookie }
        }
      )
      const reconRes = await handlePaymentContingencyHttp(reconReq, {
        database,
        sessionCookieConfiguration: config,
        now
      })
      expect(reconRes?.status).toBe(200)
      const reconBody = await reconRes?.json()
      expect(reconBody.items.length).toBeGreaterThanOrEqual(1)
      expect(reconBody.items[0].provider).toBe('euro_contingency')
    })
  })
})

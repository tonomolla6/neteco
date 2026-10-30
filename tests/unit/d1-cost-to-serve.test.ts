import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import { type CalculateCostToServeInput, CostToServeError } from '../../shared/cost-to-serve'
import {
  calculateOrderCostToServe,
  getOrderCostToServe,
  readCostToServeSummary
} from '../../workers/analytics/cost-to-serve'
import type { VerifiedSessionClaims } from '../../workers/catalog/authorization'

const NOW = '2026-10-29T12:00:00Z'
const ADMIN_CLAIMS: VerifiedSessionClaims = {
  identityId: '10000000-0000-4000-8000-000000000001',
  sessionId: '20000000-0000-4000-8000-000000000001',
  sessionVersion: 1
}

const CUSTOMER_ID = '30000000-0000-4000-8000-000000000001'
const ORDER_1 = '50000000-0000-4000-8000-000000000001'
const ORDER_2 = '50000000-0000-4000-8000-000000000002'

async function setupTestDb(): Promise<DatabaseSync> {
  const sqlite = await openMigratedDatabase()
  const migration0123 = await readFile(
    new URL('../../db/d1/migrations/0123_seo_b2b_metrics_cost_to_serve.sql', import.meta.url),
    'utf8'
  )
  sqlite.exec(migration0123)

  sqlite.exec(`
    INSERT OR IGNORE INTO roles (code, name, description) VALUES
      ('admin', 'Administrador', 'Rol admin');
    INSERT OR IGNORE INTO permissions (code, resource, action, description) VALUES
      ('administration.manage', 'administration', 'manage', 'Admin manage');
    INSERT OR IGNORE INTO role_permissions (role_code, permission_code) VALUES
      ('admin', 'administration.manage');

    INSERT OR IGNORE INTO customers (id, name, status, created_at, updated_at) VALUES
      ('${CUSTOMER_ID}', 'Cliente Test', 'active', '${NOW}', '${NOW}');

    INSERT OR IGNORE INTO identities (id, customer_id, email, password_hash, email_verified_at, status, session_version, created_at, updated_at) VALUES
      ('${ADMIN_CLAIMS.identityId}', NULL, 'admin-cost@neteco.es', 'hash', '${NOW}', 'active', 1, '${NOW}', '${NOW}');

    INSERT OR IGNORE INTO identity_roles (identity_id, role_code, granted_at) VALUES
      ('${ADMIN_CLAIMS.identityId}', 'admin', '${NOW}');

    INSERT OR IGNORE INTO auth_sessions (id, identity_id, session_version, mfa_verified, created_at, expires_at) VALUES
      ('${ADMIN_CLAIMS.sessionId}', '${ADMIN_CLAIMS.identityId}', 1, 1, '${NOW}', '2026-10-30T12:00:00Z');

    -- Seed carts, quotes, shipping, attempts, and orders for testing
    INSERT OR IGNORE INTO carts(id, token_hash, status, version, expires_at, correlation_id, created_at, updated_at) VALUES
      ('cart-c1', '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', 'active', 1, '2026-10-30T12:00:00Z', 'corr-1', '${NOW}', '${NOW}'),
      ('cart-c2', '1123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', 'active', 1, '2026-10-30T12:00:00Z', 'corr-1', '${NOW}', '${NOW}');

    INSERT OR IGNORE INTO checkout_quotes(id, cart_id, cart_version, pricing_instant, currency, shipping_gross_cents, shipping_pending, total_net_cents, total_tax_cents, total_gross_cents, snapshot_hash, correlation_id, created_at) VALUES
      ('quote-c1', 'cart-c1', 1, '${NOW}', 'EUR', 0, 1, 10000, 2100, 12100, '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', 'corr-1', '${NOW}'),
      ('quote-c2', 'cart-c2', 1, '${NOW}', 'EUR', 0, 1, 5000, 1050, 6050, '1123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', 'corr-1', '${NOW}');

    INSERT OR IGNORE INTO shipping_quotes(id, cart_id, cart_version, destination_hash, options_json, option_count, snapshot_hash, expires_at, correlation_id, created_at) VALUES
      ('sq-c1', 'cart-c1', 1, '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', '[]', 0, '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', '2026-10-30T12:00:00Z', 'corr-1', '${NOW}'),
      ('sq-c2', 'cart-c2', 1, '1123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', '[]', 0, '1123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', '2026-10-30T12:00:00Z', 'corr-1', '${NOW}');

    INSERT OR IGNORE INTO checkout_attempts(id, cart_id, command_key, state, correlation_id, payload_hash, created_at, updated_at) VALUES
      ('att-c1', 'cart-c1', 'key-1', 'failed', 'corr-1', '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', '${NOW}', '${NOW}'),
      ('att-c2', 'cart-c2', 'key-2', 'failed', 'corr-1', '1123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', '${NOW}', '${NOW}');

    INSERT OR IGNORE INTO orders (
      id, cart_id, quote_id, shipping_quote_id, attempt_id, token_hash, status, reservation_id, reservation_expires_at, currency, total_net_cents, total_tax_cents, total_gross_cents, shipping_net_cents, shipping_tax_cents, shipping_gross_cents, shipping_method_code, shipping_rate_version, shipping_eta_min_days, shipping_eta_max_days, contact_email, contact_email_hash, consent_tos, consent_privacy, correlation_id, created_at, updated_at, customer_id
    ) VALUES (
      '${ORDER_1}', 'cart-c1', 'quote-c1', 'sq-c1', 'att-c1', '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', 'awaiting_payment', 'res-c1', '2026-10-30T12:00:00Z', 'EUR', 10600, 2226, 12826, 600, 126, 726, 'parcel', 1, 1, 3, 'cliente1@test.es', '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', 1, 1, 'corr-c1', '${NOW}', '${NOW}', '${CUSTOMER_ID}'
    ), (
      '${ORDER_2}', 'cart-c2', 'quote-c2', 'sq-c2', 'att-c2', '1123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', 'awaiting_payment', 'res-c2', '2026-10-30T12:00:00Z', 'EUR', 5600, 1176, 6776, 600, 126, 726, 'parcel', 1, 1, 3, 'cliente2@test.es', '1123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', 1, 1, 'corr-c2', '${NOW}', '${NOW}', '${CUSTOMER_ID}'
    );
  `)

  return sqlite
}

describe('DAT-021: Cost-to-Serve & Margen de Contribución Core Logic', () => {
  let sqlite: DatabaseSync
  let db: D1Database

  beforeEach(async () => {
    sqlite = await setupTestDb()
    db = d1OverSqlite(sqlite)
  })

  afterEach(() => {
    sqlite.close()
  })

  it('calculates all 7 cost-to-serve factors linked to order and determines contribution margin', async () => {
    // Order 1: Net revenue 10,600 cents (106.00 EUR)
    // COGS: 4,000 cents
    // Descuento: 1,000 cents
    // Pago: 150 cents (card gateway fee)
    // Picking: 250 cents (warehouse labor + packaging box)
    // Porte real: 650 cents (carrier invoice)
    // Devoluciones: 0 cents
    // Soporte: 100 cents (1 inquiry ticket)
    // Total cost to serve = 4000 + 150 + 250 + 650 + 0 + 100 = 5150 cents
    // Contribution Margin = Net revenue (10600) - Total Cost (5150) = 5450 cents (51.4% margin -> high_margin)
    const input: CalculateCostToServeInput = {
      orderId: ORDER_1,
      expectedVersion: 0,
      cogsCents: 4000,
      discountCents: 1000,
      paymentFeeCents: 150,
      pickingCostCents: 250,
      shippingRealCostCents: 650,
      returnsCostCents: 0,
      supportCostCents: 100,
      notes: 'Pedido estándar rentable',
      commandId: 'cmd-cts-1'
    }

    const calculated = await calculateOrderCostToServe(db, ADMIN_CLAIMS, input, { now: () => NOW })
    expect(calculated.orderId).toBe(ORDER_1)
    expect(calculated.version).toBe(1)
    expect(calculated.grossRevenueCents).toBe(12826)
    expect(calculated.netRevenueCents).toBe(10600)
    expect(calculated.totalCostToServeCents).toBe(5150)
    expect(calculated.contributionMarginCents).toBe(5450)
    expect(calculated.marginRatio).toBeCloseTo(5450 / 10600, 3)
    expect(calculated.profitabilityTier).toBe('high_margin')

    // Read back
    const fetched = await getOrderCostToServe(db, ADMIN_CLAIMS, ORDER_1)
    expect(fetched).not.toBeNull()
    expect(fetched?.contributionMarginCents).toBe(5450)
    expect(fetched?.cogsCents).toBe(4000)
    expect(fetched?.paymentFeeCents).toBe(150)
    expect(fetched?.pickingCostCents).toBe(250)
    expect(fetched?.shippingRealCostCents).toBe(650)
    expect(fetched?.returnsCostCents).toBe(0)
    expect(fetched?.supportCostCents).toBe(100)
  })

  it('identifies loss-making orders when returns and carrier exceed revenue', async () => {
    // Order 2: Net revenue 5,600 cents (56.00 EUR)
    // COGS: 2,500
    // Descuento: 500
    // Pago: 100
    // Picking: 250
    // Porte real: 850
    // Devoluciones: 3,000 (customer returned partial goods, restocking & damaged freight)
    // Soporte: 500 (multiple escalation tickets)
    // Total cost = 2500 + 100 + 250 + 850 + 3000 + 500 = 7200 cents
    // Contribution margin = 5600 - 7200 = -1600 cents (negative! -> loss_making)
    const input: CalculateCostToServeInput = {
      orderId: ORDER_2,
      expectedVersion: 0,
      cogsCents: 2500,
      discountCents: 500,
      paymentFeeCents: 100,
      pickingCostCents: 250,
      shippingRealCostCents: 850,
      returnsCostCents: 3000,
      supportCostCents: 500,
      notes: 'Pedido con incidencia y devolución parcial',
      commandId: 'cmd-cts-2'
    }

    const calculated = await calculateOrderCostToServe(db, ADMIN_CLAIMS, input, { now: () => NOW })
    expect(calculated.contributionMarginCents).toBe(-1600)
    expect(calculated.marginRatio).toBeLessThan(0)
    expect(calculated.profitabilityTier).toBe('loss_making')
  })

  it('enforces CAS version increment and idempotency on duplicate commands', async () => {
    const input: CalculateCostToServeInput = {
      orderId: ORDER_1,
      expectedVersion: 0,
      cogsCents: 4000,
      discountCents: 1000,
      paymentFeeCents: 150,
      pickingCostCents: 250,
      shippingRealCostCents: 650,
      returnsCostCents: 0,
      supportCostCents: 100,
      notes: 'Initial calc',
      commandId: 'cmd-cts-cas-1'
    }

    const first = await calculateOrderCostToServe(db, ADMIN_CLAIMS, input, { now: () => NOW })
    expect(first.version).toBe(1)

    // Replay with identical commandId
    const replay = await calculateOrderCostToServe(db, ADMIN_CLAIMS, input, { now: () => NOW })
    expect(replay.version).toBe(1)
    expect(replay.idempotentReplay).toBe(true)

    // Conflict with stale expectedVersion
    await expect(
      calculateOrderCostToServe(
        db,
        ADMIN_CLAIMS,
        { ...input, expectedVersion: 0, commandId: 'cmd-cts-cas-2', cogsCents: 4200 },
        { now: () => NOW }
      )
    ).rejects.toThrow(CostToServeError)

    // Update with correct expectedVersion = 1 -> version = 2
    const second = await calculateOrderCostToServe(
      db,
      ADMIN_CLAIMS,
      { ...input, expectedVersion: 1, commandId: 'cmd-cts-cas-3', cogsCents: 4200 },
      { now: () => NOW }
    )
    expect(second.version).toBe(2)
    expect(second.cogsCents).toBe(4200)
  })

  it('computes aggregated cost-to-serve summary across orders with breakdown percentages', async () => {
    // Calculate for Order 1 (profitable)
    await calculateOrderCostToServe(
      db,
      ADMIN_CLAIMS,
      {
        orderId: ORDER_1,
        expectedVersion: 0,
        cogsCents: 4000,
        discountCents: 1000,
        paymentFeeCents: 150,
        pickingCostCents: 250,
        shippingRealCostCents: 650,
        returnsCostCents: 0,
        supportCostCents: 100,
        notes: 'Profitable order',
        commandId: 'cmd-sum-1'
      },
      { now: () => NOW }
    )

    // Calculate for Order 2 (loss-making)
    await calculateOrderCostToServe(
      db,
      ADMIN_CLAIMS,
      {
        orderId: ORDER_2,
        expectedVersion: 0,
        cogsCents: 2500,
        discountCents: 500,
        paymentFeeCents: 100,
        pickingCostCents: 250,
        shippingRealCostCents: 850,
        returnsCostCents: 3000,
        supportCostCents: 500,
        notes: 'Loss-making order',
        commandId: 'cmd-sum-2'
      },
      { now: () => NOW }
    )

    const summary = await readCostToServeSummary(db, ADMIN_CLAIMS, {}, { now: () => NOW })
    expect(summary.totalOrdersAnalyzed).toBe(2)
    expect(summary.totalNetRevenueCents).toBe(10600 + 5600) // 16200 cents
    expect(summary.totalCogsCents).toBe(4000 + 2500) // 6500 cents
    expect(summary.totalDiscountCents).toBe(1000 + 500) // 1500 cents
    expect(summary.totalPaymentFeeCents).toBe(150 + 100) // 250 cents
    expect(summary.totalPickingCostCents).toBe(250 + 250) // 500 cents
    expect(summary.totalShippingRealCostCents).toBe(650 + 850) // 1500 cents
    expect(summary.totalReturnsCostCents).toBe(3000)
    expect(summary.totalSupportCostCents).toBe(600)
    expect(summary.totalCostToServeCents).toBe(5150 + 7200) // 12350 cents
    expect(summary.totalContributionMarginCents).toBe(16200 - 12350) // 3850 cents

    expect(summary.profitableOrdersCount).toBe(1)
    expect(summary.lossMakingOrdersCount).toBe(1)
    expect(summary.lossMakingRate).toBe(0.5)

    // Tiers breakdown
    expect(summary.tiersBreakdown.highMarginCount).toBe(1)
    expect(summary.tiersBreakdown.lossMakingCount).toBe(1)
  })
})

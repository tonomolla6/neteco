import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import {
  readB2bSalesMetrics,
  recordB2bSalesDailySnapshot
} from '../../workers/b2b/metrics'
import type { VerifiedSessionClaims } from '../../workers/catalog/authorization'

const ADMIN_CLAIMS: VerifiedSessionClaims = {
  identityId: '10000000-0000-4000-8000-000000000001',
  sessionId: '20000000-0000-4000-8000-000000000001',
  sessionVersion: 1
}

const NOW = '2026-10-29T12:00:00Z'

async function setupTestDb(): Promise<DatabaseSync> {
  const sqlite = await openMigratedDatabase()
  const migration0101 = await readFile(
    new URL('../../db/d1/migrations/0101_b2b_price_lists_credit.sql', import.meta.url),
    'utf8'
  )
  sqlite.exec(migration0101)

  const migration0105 = await readFile(
    new URL('../../db/d1/migrations/0105_b2b_credit_terms.sql', import.meta.url),
    'utf8'
  )
  sqlite.exec(migration0105)

  const migration0123 = await readFile(
    new URL('../../db/d1/migrations/0123_seo_b2b_metrics_cost_to_serve.sql', import.meta.url),
    'utf8'
  )
  sqlite.exec(migration0123)

  // Seed admin identity and auth session
  sqlite.exec(`
    INSERT OR IGNORE INTO roles (code, name, description) VALUES
      ('admin', 'Administrador', 'Rol administrador');
    INSERT OR IGNORE INTO permissions (code, resource, action, description) VALUES
      ('administration.manage', 'administration', 'manage', 'Gestión general');
    INSERT OR IGNORE INTO role_permissions (role_code, permission_code) VALUES
      ('admin', 'administration.manage');
    INSERT OR IGNORE INTO identities (id, email, password_hash, email_verified_at, status, created_at, updated_at) VALUES
      ('${ADMIN_CLAIMS.identityId}', 'admin-b2b@neteco.es', 'hash', '2026-01-01T00:00:00Z', 'active', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
    INSERT OR IGNORE INTO auth_sessions (id, identity_id, session_version, mfa_verified, created_at, expires_at) VALUES
      ('${ADMIN_CLAIMS.sessionId}', '${ADMIN_CLAIMS.identityId}', 1, 1, '2026-01-01T00:00:00Z', '2026-10-30T12:00:00Z');
    INSERT OR IGNORE INTO identity_roles (identity_id, role_code, granted_at) VALUES
      ('${ADMIN_CLAIMS.identityId}', 'admin', '2026-01-01T00:00:00Z');
  `)

  // Seed B2B companies, customers, and price list
  sqlite.exec(`
    -- Seed Tax class & Shipping profile
    INSERT OR IGNORE INTO tax_classes (id, code, name, rate_basis_points, valid_from) VALUES
      ('tax_std', 'STD', 'Estándar', 2100, '2020-01-01T00:00:00Z');
    INSERT OR IGNORE INTO shipping_profiles (id, code, name, kind) VALUES
      ('ship_std', 'STD', 'Estándar', 'parcel');

    -- Seed B2B Customers
    INSERT OR IGNORE INTO customers (id, email, status, created_at, updated_at) VALUES
      ('cust-b2b-01', 'compras@lavanderia-norte.es', 'active', '2026-08-01T10:00:00Z', '2026-08-01T10:00:00Z'),
      ('cust-b2b-02', 'admin@talleres-este.es', 'active', '2026-09-01T10:00:00Z', '2026-09-01T10:00:00Z'),
      ('cust-b2b-03', 'pedidos@clinica-centro.es', 'active', '2026-10-15T10:00:00Z', '2026-10-15T10:00:00Z'),
      ('cust-b2b-04', 'gerencia@hotel-sur.es', 'active', '2026-06-01T10:00:00Z', '2026-06-01T10:00:00Z');

    -- Seed Companies
    INSERT OR IGNORE INTO companies (id, customer_id, legal_name, trade_name, tax_id, status, created_at, updated_at) VALUES
      ('comp-01', 'cust-b2b-01', 'Lavanderías Norte S.L.', 'Lavandería Norte', 'B12345678', 'approved', '2026-08-01T10:00:00Z', '2026-08-01T10:00:00Z'),
      ('comp-02', 'cust-b2b-02', 'Talleres Mecánicos Este S.A.', 'Talleres Este', 'A87654321', 'approved', '2026-09-01T10:00:00Z', '2026-09-01T10:00:00Z'),
      ('comp-03', 'cust-b2b-03', 'Clínica Dental Centro S.L.', 'Clínica Centro', 'B11223344', 'approved', '2026-10-15T10:00:00Z', '2026-10-15T10:00:00Z'),
      ('comp-04', 'cust-b2b-04', 'Hotel Sur Vacacional S.A.', 'Hotel Sur', 'A99887766', 'approved', '2026-06-01T10:00:00Z', '2026-06-01T10:00:00Z');

    -- Seed Price List
    INSERT OR IGNORE INTO b2b_pricing_write_context (actor_id, command_id, price_list_id) VALUES
      ('${ADMIN_CLAIMS.identityId}', 'init-list', 'plist-industrial');
    INSERT OR IGNORE INTO b2b_price_lists (id, code, name, status, version, valid_from, created_at, updated_at) VALUES
      ('plist-industrial', 'TAR-IND', 'Tarifa Químicos Industrial', 'active', 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
    DELETE FROM b2b_pricing_write_context WHERE command_id='init-list';

    -- Assign Price List to comp-01 and comp-02
    INSERT OR IGNORE INTO b2b_pricing_write_context (actor_id, command_id, company_id, price_list_id) VALUES
      ('${ADMIN_CLAIMS.identityId}', 'assign-1', 'comp-01', 'plist-industrial'),
      ('${ADMIN_CLAIMS.identityId}', 'assign-2', 'comp-02', 'plist-industrial');
    INSERT OR IGNORE INTO b2b_company_assignments (company_id, price_list_id, version, active, valid_from, updated_at) VALUES
      ('comp-01', 'plist-industrial', 1, 1, '2026-08-01T10:00:00Z', '2026-08-01T10:00:00Z'),
      ('comp-02', 'plist-industrial', 1, 1, '2026-09-01T10:00:00Z', '2026-09-01T10:00:00Z');
    DELETE FROM b2b_pricing_write_context WHERE command_id IN ('assign-1', 'assign-2');

    -- Seed Commercial Terms (Migration 0105 b2b_credit_commands)
    INSERT OR IGNORE INTO b2b_credit_commands (
      actor_id, command_id, session_id, session_version, company_id, expected_version,
      payment_days, credit_limit_cents, blocked, block_reason, reason, payload_hash, created_at
    ) VALUES
      ('${ADMIN_CLAIMS.identityId}', 'cmd-credit-1', '${ADMIN_CLAIMS.sessionId}', 1, 'comp-01', 0, 30, 500000, 0, NULL, 'Aprobación inicial riesgo B2B', '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', '2026-08-01T10:00:00Z'),
      ('${ADMIN_CLAIMS.identityId}', 'cmd-credit-2', '${ADMIN_CLAIMS.sessionId}', 1, 'comp-02', 0, 60, 1000000, 0, NULL, 'Línea de crédito 60 días', '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', '2026-09-01T10:00:00Z'),
      ('${ADMIN_CLAIMS.identityId}', 'cmd-credit-3', '${ADMIN_CLAIMS.sessionId}', 1, 'comp-03', 0, 0, 0, 0, NULL, 'Prepago inicial', '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', '2026-10-15T10:00:00Z'),
      ('${ADMIN_CLAIMS.identityId}', 'cmd-credit-4', '${ADMIN_CLAIMS.sessionId}', 1, 'comp-04', 0, 15, 300000, 1, 'Riesgo impago detectado', 'Bloqueo cautelar mora', '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', '2026-06-01T10:00:00Z');
  `)

  return sqlite
}

// Helper to seed orders
function insertB2bOrder(
  sqlite: DatabaseSync,
  params: {
    orderId: string
    customerId: string
    grossCents: number
    netCents: number
    createdAt: string
    paymentStatus: 'paid' | 'awaiting_payment'
  }
) {
  const attemptId = `att-${params.orderId}`
  const cartId = `cart-${params.orderId}`
  const quoteId = `quote-${params.orderId}`
  const shipQuoteId = `ship-${params.orderId}`

  sqlite.exec(`
    INSERT OR IGNORE INTO carts (id, currency, created_at, updated_at) VALUES
      ('${cartId}', 'EUR', '${params.createdAt}', '${params.createdAt}');
    INSERT OR IGNORE INTO checkout_quotes (id, cart_id, cart_version, currency, subtotal_net_cents, subtotal_tax_cents, subtotal_gross_cents, total_net_cents, total_tax_cents, total_gross_cents, created_at, expires_at) VALUES
      ('${quoteId}', '${cartId}', 1, 'EUR', ${params.netCents}, ${params.grossCents - params.netCents}, ${params.grossCents}, ${params.netCents}, ${params.grossCents - params.netCents}, ${params.grossCents}, '${params.createdAt}', '2026-12-31T00:00:00Z');
    INSERT OR IGNORE INTO shipping_quotes (id, quote_id, shipping_method_code, rate_version, eta_min_days, eta_max_days, net_cents, tax_cents, gross_cents, created_at, expires_at) VALUES
      ('${shipQuoteId}', '${quoteId}', 'parcel', 1, 1, 3, 0, 0, 0, '${params.createdAt}', '2026-12-31T00:00:00Z');
    INSERT OR IGNORE INTO checkout_attempts (id, cart_id, quote_id, shipping_quote_id, customer_id, state, currency, total_gross_cents, reservation_id, reservation_expires_at, correlation_id, idempotency_key, created_at, updated_at) VALUES
      ('${attemptId}', '${cartId}', '${quoteId}', '${shipQuoteId}', '${params.customerId}', 'completed', 'EUR', ${params.grossCents}, 'res-1', '2026-12-31T00:00:00Z', 'corr-1', 'idem-${params.orderId}', '${params.createdAt}', '${params.createdAt}');
    INSERT OR IGNORE INTO orders (id, cart_id, quote_id, shipping_quote_id, attempt_id, token_hash, status, reservation_id, reservation_expires_at, currency, total_net_cents, total_tax_cents, total_gross_cents, shipping_net_cents, shipping_tax_cents, shipping_gross_cents, shipping_method_code, shipping_rate_version, shipping_eta_min_days, shipping_eta_max_days, contact_email, contact_email_hash, consent_tos, consent_privacy, correlation_id, created_at, updated_at) VALUES
      ('${params.orderId}', '${cartId}', '${quoteId}', '${shipQuoteId}', '${attemptId}', '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', 'awaiting_payment', 'res-1', '2026-12-31T00:00:00Z', 'EUR', ${params.netCents}, ${params.grossCents - params.netCents}, ${params.grossCents}, 0, 0, 0, 'parcel', 1, 1, 3, 'empresa@neteco.es', '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', 1, 1, 'corr-1', '${params.createdAt}', '${params.createdAt}');
    INSERT OR IGNORE INTO order_payment_states (order_id, status, paid_gross_cents, updated_at) VALUES
      ('${params.orderId}', '${params.paymentStatus}', ${params.paymentStatus === 'paid' ? params.grossCents : 0}, '${params.createdAt}');
    INSERT OR IGNORE INTO order_customer_ownership (order_id, customer_id, bound_at) VALUES
      ('${params.orderId}', '${params.customerId}', '${params.createdAt}');
  `)
}

describe('DAT-020: B2B Sales Metrics Core Logic', () => {
  let sqlite: DatabaseSync
  let db: D1Database

  beforeEach(async () => {
    sqlite = await setupTestDb()
    db = d1OverSqlite(sqlite)
  })

  afterEach(() => {
    sqlite.close()
  })

  it('measures Activation, Conversion, Recurrence, and Real Commercial Terms without sedes/aprobadores', async () => {
    // Comp-01 (Lavandería): approved 2026-08-01, first order placed 2026-08-11 (10 days activation), second order 2026-09-15 (repeat buyer)
    insertB2bOrder(sqlite, {
      orderId: 'ord-b2b-01',
      customerId: 'cust-b2b-01',
      grossCents: 121000,
      netCents: 100000,
      createdAt: '2026-08-11T14:00:00Z',
      paymentStatus: 'paid'
    })
    insertB2bOrder(sqlite, {
      orderId: 'ord-b2b-02',
      customerId: 'cust-b2b-01',
      grossCents: 181500,
      netCents: 150000,
      createdAt: '2026-09-15T10:00:00Z',
      paymentStatus: 'paid'
    })

    // Comp-02 (Talleres): approved 2026-09-01, first order placed 2026-09-06 (5 days activation), single buyer so far
    insertB2bOrder(sqlite, {
      orderId: 'ord-b2b-03',
      customerId: 'cust-b2b-02',
      grossCents: 242000,
      netCents: 200000,
      createdAt: '2026-09-06T09:00:00Z',
      paymentStatus: 'paid'
    })

    // Comp-03 (Clínica): approved 2026-10-15, NO orders yet (pending activation, aging < 30 days)
    // Comp-04 (Hotel): approved 2026-06-01, NO orders yet (pending activation, aging > 90 days), blocked for credit

    const metrics = await readB2bSalesMetrics(
      db,
      ADMIN_CLAIMS,
      { from: '2026-01-01', to: '2026-10-29' },
      { now: () => NOW }
    )

    // 1. ACTIVATION (DAT-020 acceptance)
    expect(metrics.activation.totalRegisteredCompanies).toBe(4)
    expect(metrics.activation.approvedCompanies).toBe(4)
    expect(metrics.activation.activatedCompanies).toBe(2) // comp-01 and comp-02
    expect(metrics.activation.activationRate).toBe(0.5) // 2 / 4 = 50%
    // Avg days to first order: comp-01 was 10 days, comp-02 was 5 days -> avg 7.5 days
    expect(metrics.activation.avgDaysToFirstOrder).toBeCloseTo(7.5, 1)
    // Aging of non-activated approved companies (comp-03 is 14 days old (<30d), comp-04 is ~150 days old (>90d))
    expect(metrics.activation.pendingActivationAging.under30Days).toBe(1)
    expect(metrics.activation.pendingActivationAging.days30to90).toBe(0)
    expect(metrics.activation.pendingActivationAging.over90Days).toBe(1)

    // 2. CONVERSION (DAT-020 acceptance)
    expect(metrics.conversion.ordersCount).toBe(3)
    expect(metrics.conversion.revenueNetCents).toBe(450000) // 1000 + 1500 + 2000 = 4500.00 EUR
    expect(metrics.conversion.averageOrderValueCents).toBe(150000) // 4500.00 / 3 = 1500.00 EUR
    expect(metrics.conversion.checkoutsCompleted).toBe(3)

    // 3. RECURRENCE (DAT-020 acceptance)
    expect(metrics.recurrence.oneTimeBuyers).toBe(1) // comp-02
    expect(metrics.recurrence.repeatBuyers).toBe(1) // comp-01 has 2 orders
    expect(metrics.recurrence.repeatPurchaseRate).toBe(0.5) // 1 / 2 buyers = 50%
    // Days between orders for comp-01: from 2026-08-11 to 2026-09-15 = 35 days
    expect(metrics.recurrence.avgDaysBetweenOrders).toBe(35)

    // 4. CONDICIONES COMERCIALES REALES (DAT-020 acceptance)
    // Payment terms distribution: comp-01 has 30d, comp-02 has 60d, comp-03 has 0d (prepago), comp-04 has 15d
    const termsDist = metrics.commercialTerms.paymentTermsDistribution
    expect(termsDist.find((t) => t.paymentDays === 30)?.companiesCount).toBe(1)
    expect(termsDist.find((t) => t.paymentDays === 60)?.companiesCount).toBe(1)
    expect(termsDist.find((t) => t.paymentDays === 0)?.companiesCount).toBe(1)
    expect(termsDist.find((t) => t.paymentDays === 15)?.companiesCount).toBe(1)

    // Credit limits and exposure
    // comp-01 (5000€), comp-02 (10000€), comp-03 (0€), comp-04 (3000€) = total 18000€
    expect(metrics.commercialTerms.creditExposure.totalCreditLimitCents).toBe(1800000)
    expect(metrics.commercialTerms.creditExposure.blockedCompaniesCount).toBe(1) // comp-04

    // Pricing tiers
    expect(metrics.commercialTerms.pricingTiersDistribution.length).toBeGreaterThan(0)
    expect(metrics.commercialTerms.pricingTiersDistribution[0]!.priceListId).toBe('plist-industrial')
    expect(metrics.commercialTerms.pricingTiersDistribution[0]!.companiesCount).toBe(2)

    // Top companies ranking
    expect(metrics.topCompanies.length).toBe(2)
    expect(metrics.topCompanies[0]!.legalName).toBe('Lavanderías Norte S.L.')
    expect(metrics.topCompanies[0]!.ordersCount).toBe(2)
    expect(metrics.topCompanies[0]!.revenueNetCents).toBe(250000)
  })

  it('records and retrieves daily B2B snapshot', async () => {
    const res = await recordB2bSalesDailySnapshot(
      db,
      ADMIN_CLAIMS,
      {
        date: '2026-10-28',
        totalCompanies: 4,
        approvedCompanies: 4,
        activatedCompanies: 2,
        ordersCount: 3,
        revenueGrossCents: 544500,
        revenueNetCents: 450000,
        averageOrderValueCents: 150000,
        creditLimitTotalCents: 1800000,
        creditUtilizedCents: 242000,
        overdueCents: 0,
        blockedCompaniesCount: 1
      },
      { commandId: 'cmd-snap-1', now: () => NOW }
    )

    expect(res.snapshotRecorded).toBe(true)
    expect(res.date).toBe('2026-10-28')
  })
})

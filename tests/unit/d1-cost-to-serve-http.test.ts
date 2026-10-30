import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import {
  handleCostToServeHttp,
  ownsCostToServeNamespace,
  type CostToServeHttpDependencies
} from '../../workers/analytics/cost-to-serve-http'

const NOW = '2026-10-29T12:00:00Z'
const ADMIN_ID = '10000000-0000-4000-8000-000000000001'
const NON_ADMIN_ID = '10000000-0000-4000-8000-000000000002'
const SESSION_PASSWORD = 'test-session-password-at-least-32-chars-long!!'
const ORIGIN = 'https://neteco.beply.es'
const ORDER_1 = '50000000-0000-4000-8000-000000000001'

async function setupHttpDb(): Promise<DatabaseSync> {
  const sqlite = await openMigratedDatabase()
  const migration0123 = await readFile(
    new URL('../../db/d1/migrations/0123_seo_b2b_metrics_cost_to_serve.sql', import.meta.url),
    'utf8'
  )
  sqlite.exec(migration0123)

  sqlite.exec(`
    INSERT OR IGNORE INTO roles (code, name, description) VALUES
      ('admin', 'Administrador', 'Rol admin'),
      ('customer', 'Cliente', 'Rol cliente');
    INSERT OR IGNORE INTO permissions (code, resource, action, description) VALUES
      ('administration.manage', 'administration', 'manage', 'Admin manage');
    INSERT OR IGNORE INTO role_permissions (role_code, permission_code) VALUES
      ('admin', 'administration.manage');

    INSERT OR IGNORE INTO identities (id, email, password_hash, email_verified_at, status, created_at, updated_at) VALUES
      ('${ADMIN_ID}', 'admin-cost-http@neteco.es', 'hash', '${NOW}', 'active', '${NOW}', '${NOW}'),
      ('${NON_ADMIN_ID}', 'user-cost-http@neteco.es', 'hash', '${NOW}', 'active', '${NOW}', '${NOW}');

    INSERT OR IGNORE INTO auth_sessions (id, identity_id, session_version, mfa_verified, created_at, expires_at) VALUES
      ('20000000-0000-4000-8000-000000000001', '${ADMIN_ID}', 1, 1, '${NOW}', '2026-10-30T12:00:00Z'),
      ('20000000-0000-4000-8000-000000000002', '${NON_ADMIN_ID}', 1, 1, '${NOW}', '2026-10-30T12:00:00Z');

    INSERT OR IGNORE INTO identity_roles (identity_id, role_code, granted_at) VALUES
      ('${ADMIN_ID}', 'admin', '${NOW}'),
      ('${NON_ADMIN_ID}', 'customer', '${NOW}');

    INSERT OR IGNORE INTO carts(id, token_hash, status, version, expires_at, correlation_id, created_at, updated_at) VALUES
      ('cart-h1', '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', 'active', 1, '2026-10-30T12:00:00Z', 'corr-1', '${NOW}', '${NOW}');

    INSERT OR IGNORE INTO checkout_quotes(id, cart_id, cart_version, pricing_instant, currency, shipping_gross_cents, shipping_pending, total_net_cents, total_tax_cents, total_gross_cents, snapshot_hash, correlation_id, created_at) VALUES
      ('quote-h1', 'cart-h1', 1, '${NOW}', 'EUR', 0, 1, 10000, 2100, 12100, '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', 'corr-1', '${NOW}');

    INSERT OR IGNORE INTO shipping_quotes(id, cart_id, cart_version, destination_hash, options_json, option_count, snapshot_hash, expires_at, correlation_id, created_at) VALUES
      ('sq-h1', 'cart-h1', 1, '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', '[]', 0, '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', '2026-10-30T12:00:00Z', 'corr-1', '${NOW}');

    INSERT OR IGNORE INTO checkout_attempts(id, cart_id, command_key, state, correlation_id, payload_hash, created_at, updated_at) VALUES
      ('att-h1', 'cart-h1', 'key-1', 'failed', 'corr-1', '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', '${NOW}', '${NOW}');

    INSERT OR IGNORE INTO orders (
      id, cart_id, quote_id, shipping_quote_id, attempt_id, token_hash, status, reservation_id, reservation_expires_at, currency, total_net_cents, total_tax_cents, total_gross_cents, shipping_net_cents, shipping_tax_cents, shipping_gross_cents, shipping_method_code, shipping_rate_version, shipping_eta_min_days, shipping_eta_max_days, contact_email, contact_email_hash, consent_tos, consent_privacy, correlation_id, created_at, updated_at
    ) VALUES (
      '${ORDER_1}', 'cart-h1', 'quote-h1', 'sq-h1', 'att-h1', '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', 'awaiting_payment', 'res-h1', '2026-10-30T12:00:00Z', 'EUR', 10500, 2205, 12705, 500, 105, 605, 'parcel', 1, 1, 3, 'cliente-h1@test.es', '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', 1, 1, 'corr-h1', '${NOW}', '${NOW}'
    );
  `)

  return sqlite
}

async function makeCookie(db: D1Database, identityId: string, sessionId: string): Promise<string> {
  const cookie = await issueD1SessionCookie(
    db,
    { identityId, sessionId, sessionVersion: 1 },
    { password: SESSION_PASSWORD, maxAgeSeconds: 3600 }
  )
  return cookie?.split(';')[0] ?? ''
}

describe('DAT-021: Cost-to-Serve HTTP Endpoints', () => {
  let sqlite: DatabaseSync
  let db: D1Database
  let deps: CostToServeHttpDependencies
  let adminCookie: string
  let nonAdminCookie: string

  beforeEach(async () => {
    sqlite = await setupHttpDb()
    db = d1OverSqlite(sqlite)
    deps = {
      database: db,
      origin: ORIGIN,
      sessionCookieConfiguration: { password: SESSION_PASSWORD, maxAgeSeconds: 3600 },
      now: () => NOW
    }
    adminCookie = await makeCookie(db, ADMIN_ID, '20000000-0000-4000-8000-000000000001')
    nonAdminCookie = await makeCookie(db, NON_ADMIN_ID, '20000000-0000-4000-8000-000000000002')
  })

  afterEach(() => {
    sqlite.close()
  })

  it('identifies owned namespace paths', () => {
    expect(ownsCostToServeNamespace('/api/admin/analytics/cost-to-serve')).toBe(true)
    expect(ownsCostToServeNamespace('/api/admin/analytics/cost-to-serve/orders')).toBe(true)
    expect(ownsCostToServeNamespace('/api/admin/analytics/cost-to-serve/calculate')).toBe(true)
    expect(ownsCostToServeNamespace('/api/admin/analytics/other')).toBe(false)
  })

  it('rejects unauthenticated requests with 401', async () => {
    const req = new Request(`${ORIGIN}/api/admin/analytics/cost-to-serve`, {
      method: 'GET',
      headers: { Origin: ORIGIN }
    })
    const res = await handleCostToServeHttp(req, deps)
    expect(res?.status).toBe(401)
  })

  it('rejects non-admin session with 403', async () => {
    const req = new Request(`${ORIGIN}/api/admin/analytics/cost-to-serve`, {
      method: 'GET',
      headers: { Origin: ORIGIN, Cookie: nonAdminCookie }
    })
    const res = await handleCostToServeHttp(req, deps)
    expect(res?.status).toBe(403)
  })

  it('calculates order cost-to-serve via POST /calculate and retrieves summary via GET', async () => {
    const postReq = new Request(`${ORIGIN}/api/admin/analytics/cost-to-serve/calculate`, {
      method: 'POST',
      headers: {
        Origin: ORIGIN,
        Cookie: adminCookie,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        orderId: ORDER_1,
        expectedVersion: 0,
        cogsCents: 4000,
        discountCents: 500,
        paymentFeeCents: 150,
        pickingCostCents: 200,
        shippingRealCostCents: 600,
        returnsCostCents: 0,
        supportCostCents: 100,
        notes: 'Cálculo HTTP inicial',
        commandId: 'cmd-http-cts-1'
      })
    })

    const postRes = await handleCostToServeHttp(postReq, deps)
    expect(postRes?.status).toBe(200)
    const postData = await postRes?.json()
    expect(postData.orderId).toBe(ORDER_1)
    expect(postData.contributionMarginCents).toBe(10500 - (4000 + 150 + 200 + 600 + 0 + 100))
    expect(postData.profitabilityTier).toBe('high_margin')

    // GET summary
    const getReq = new Request(`${ORIGIN}/api/admin/analytics/cost-to-serve`, {
      method: 'GET',
      headers: { Origin: ORIGIN, Cookie: adminCookie }
    })
    const getRes = await handleCostToServeHttp(getReq, deps)
    expect(getRes?.status).toBe(200)
    const summary = await getRes?.json()
    expect(summary.totalOrdersAnalyzed).toBe(1)
    expect(summary.totalNetRevenueCents).toBe(10500)
    expect(summary.profitableOrdersCount).toBe(1)
  })
})

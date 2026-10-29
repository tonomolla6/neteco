import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import type { CustomerPreferencesInput, MarketingAutomationPolicyInput } from '../../shared/marketing-automations'
import {
  handleMarketingAutomationsHttp,
  isAdminMarketingAutomationsPath,
  ownsMarketingAutomationsNamespace,
  type MarketingAutomationsHttpDependencies
} from '../../workers/marketing/marketing-automations-http'

const ORIGIN = 'https://shop.neteco.test'
const NOW = '2026-10-29T12:00:00Z'
const PAST_90_DAYS = '2026-07-20T10:00:00Z'
const PASSWORD = 'test-session-password-at-least-32-characters-long!'
const PEPPER = 'test-rate-limit-pepper-at-least-32-characters-long!'

const ADMIN_ID = '10000000-0000-4000-8000-000000000001'
const ADMIN_SESSION = '20000000-0000-4000-8000-000000000001'

const NO_MFA_ID = '10000000-0000-4000-8000-000000000002'
const NO_MFA_SESSION = '20000000-0000-4000-8000-000000000002'

const CUSTOMER_ID = '30000000-0000-4000-8000-000000000001'
const CUSTOMER_IDENTITY = '10000000-0000-4000-8000-000000000011'
const CUSTOMER_SESSION = '20000000-0000-4000-8000-000000000011'

const ORDER_ID = '50000000-0000-4000-8000-000000000001'

describe('Marketing Automations HTTP API (MKT-015, MKT-018, MKT-019)', () => {
  let sqlite: DatabaseSync
  let db: D1Database
  let adminCookie: string
  let noMfaCookie: string
  let customerCookie: string
  let deps: MarketingAutomationsHttpDependencies

  beforeEach(async () => {
    sqlite = await openMigratedDatabase()
    sqlite.exec(
      await readFile(new URL('../../db/d1/migrations/0107_marketing_automations.sql', import.meta.url), 'utf8')
    )
    db = d1OverSqlite(sqlite)

    sqlite.exec(`
      INSERT OR IGNORE INTO roles (code, name, description) VALUES ('admin', 'Administración', 'Fixture admin');
      INSERT OR IGNORE INTO permissions (code, resource, action, description) VALUES ('administration.manage', 'administration', 'manage', 'Fixture admin');
      INSERT OR IGNORE INTO role_permissions (role_code, permission_code) VALUES ('admin', 'administration.manage');
    `)

    // Admin
    sqlite
      .prepare(
        `INSERT INTO identities (id, email, password_hash, status, session_version, email_verified_at, created_at, updated_at)
         VALUES (?, 'admin@neteco.test', 'pwd-hash', 'active', 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`
      )
      .run(ADMIN_ID)
    sqlite
      .prepare(
        `INSERT INTO auth_sessions (id, identity_id, session_version, mfa_verified, created_at, last_seen_at, expires_at)
         VALUES (?, ?, 1, 1, '2026-01-01T00:00:00Z', '2026-10-29T10:00:00Z', '2027-01-01T00:00:00Z')`
      )
      .run(ADMIN_SESSION, ADMIN_ID)
    sqlite
      .prepare(
        `INSERT INTO identity_roles (identity_id, role_code, granted_by, granted_at) VALUES (?, 'admin', ?, '2026-01-01T00:00:00Z')`
      )
      .run(ADMIN_ID, ADMIN_ID)

    // No MFA
    sqlite
      .prepare(
        `INSERT INTO identities (id, email, password_hash, status, session_version, email_verified_at, created_at, updated_at)
         VALUES (?, 'nomfa@neteco.test', 'pwd-hash', 'active', 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`
      )
      .run(NO_MFA_ID)
    sqlite
      .prepare(
        `INSERT INTO auth_sessions (id, identity_id, session_version, mfa_verified, created_at, last_seen_at, expires_at)
         VALUES (?, ?, 1, 0, '2026-01-01T00:00:00Z', '2026-10-29T10:00:00Z', '2027-01-01T00:00:00Z')`
      )
      .run(NO_MFA_SESSION, NO_MFA_ID)
    sqlite
      .prepare(
        `INSERT INTO identity_roles (identity_id, role_code, granted_by, granted_at) VALUES (?, 'admin', ?, '2026-01-01T00:00:00Z')`
      )
      .run(NO_MFA_ID, ADMIN_ID)

    // Customer
    sqlite
      .prepare(
        `INSERT INTO customers (id, name, status, created_at, updated_at)
         VALUES (?, 'Lavandería Central SL', 'active', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`
      )
      .run(CUSTOMER_ID)
    sqlite
      .prepare(
        `INSERT INTO identities (id, email, password_hash, status, session_version, email_verified_at, customer_id, created_at, updated_at)
         VALUES (?, 'cliente1@neteco.test', 'pwd-hash', 'active', 1, '2026-01-01T00:00:00Z', ?, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`
      )
      .run(CUSTOMER_IDENTITY, CUSTOMER_ID)
    sqlite
      .prepare(
        `INSERT INTO auth_sessions (id, identity_id, session_version, mfa_verified, created_at, last_seen_at, expires_at)
         VALUES (?, ?, 1, 0, '2026-01-01T00:00:00Z', '2026-10-29T10:00:00Z', '2027-01-01T00:00:00Z')`
      )
      .run(CUSTOMER_SESSION, CUSTOMER_IDENTITY)

    const emailHash1 = 'a'.repeat(64)
    sqlite
      .prepare(
        `INSERT INTO newsletter_subscriptions (id, email_normalized, email_hash, status, consent_text, consent_version, consent_source, request_id, request_key, requested_at, confirmation_expires_at, confirmed_at)
         VALUES ('sub-1', 'cliente1@neteco.test', ?, 'confirmed', 'Consent', 'v1', 'web', 'req-1', 'key-1', 1700000000, 1800000000, 1700000010)`
      )
      .run(emailHash1)

    // Orders setup
    sqlite.exec(`
      INSERT INTO shipping_zones (id, code, name, kind, postal_prefixes, active, created_at)
      VALUES ('zone-1', 'peninsular', 'Península', 'parcel_peninsular', '["46"]', 1, '2026-01-01T00:00:00Z');

      INSERT INTO shipping_rates (id, zone_id, method_code, service_profile, net_cents, tax_rate_basis_points, eta_min_days, eta_max_days, rate_version, active, created_at)
      VALUES ('rate-1', 'zone-1', 'parcel', 'parcel', 600, 2100, 1, 2, 1, 1, '2026-01-01T00:00:00Z');
    `)

    const dummyId = `cart-${ORDER_ID}`
    const tokenHash = `${ORDER_ID.replace(/-/g, '')}${'0'.repeat(32)}`.slice(0, 64)
    const expiresAt = '2027-01-01T00:00:00Z'

    sqlite
      .prepare(
        `INSERT OR IGNORE INTO carts(id, token_hash, status, version, expires_at, correlation_id, created_at, updated_at) VALUES(?, ?, 'active', 1, ?, 'corr-1', ?, ?)`
      )
      .run(dummyId, tokenHash, expiresAt, PAST_90_DAYS, PAST_90_DAYS)

    sqlite
      .prepare(
        `INSERT OR IGNORE INTO checkout_quotes(id, cart_id, cart_version, pricing_instant, currency, shipping_gross_cents, shipping_pending, total_net_cents, total_tax_cents, total_gross_cents, snapshot_hash, correlation_id, created_at)
       VALUES(?, ?, 1, ?, 'EUR', 0, 1, 10000, 2100, 12100, ?, 'corr-1', ?)`
      )
      .run(dummyId, dummyId, PAST_90_DAYS, tokenHash, PAST_90_DAYS)

    sqlite
      .prepare(
        `INSERT OR IGNORE INTO shipping_quotes(id, cart_id, cart_version, destination_hash, options_json, option_count, snapshot_hash, expires_at, correlation_id, created_at)
       VALUES(?, ?, 1, ?, '[]', 0, ?, ?, 'corr-1', ?)`
      )
      .run(dummyId, dummyId, tokenHash, tokenHash, expiresAt, PAST_90_DAYS)

    sqlite
      .prepare(
        `INSERT OR IGNORE INTO checkout_attempts(id, cart_id, command_key, state, correlation_id, payload_hash, created_at, updated_at)
       VALUES(?, ?, 'key-1', 'failed', 'corr-1', ?, ?, ?)`
      )
      .run(dummyId, dummyId, tokenHash, PAST_90_DAYS, PAST_90_DAYS)

    sqlite
      .prepare(
        `INSERT INTO orders (id, cart_id, quote_id, shipping_quote_id, attempt_id, token_hash, status, reservation_id, reservation_expires_at, currency, total_net_cents, total_tax_cents, total_gross_cents, shipping_net_cents, shipping_tax_cents, shipping_gross_cents, shipping_method_code, shipping_rate_version, shipping_eta_min_days, shipping_eta_max_days, contact_email, contact_email_hash, consent_tos, consent_privacy, correlation_id, customer_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'awaiting_payment', 'res-1', '2027-01-01T00:00:00Z', 'EUR', 10000, 2100, 12100, 600, 126, 726, 'parcel', 1, 1, 2, 'cliente1@neteco.test', ?, 1, 1, 'corr-1', ?, ?, ?)`
      )
      .run(ORDER_ID, dummyId, dummyId, dummyId, dummyId, tokenHash, emailHash1, CUSTOMER_ID, PAST_90_DAYS, PAST_90_DAYS)

    sqlite
      .prepare(
        `INSERT INTO order_payment_states (order_id, status, paid_gross_cents, updated_at) VALUES (?, 'paid', 12100, ?)`
      )
      .run(ORDER_ID, PAST_90_DAYS)

    const issuedAdmin = await issueD1SessionCookie(
      db,
      { sessionId: ADMIN_SESSION, identityId: ADMIN_ID, sessionVersion: 1 },
      { password: PASSWORD, maxAgeSeconds: 3600 }
    )
    adminCookie = (issuedAdmin ?? '').split(';')[0] ?? ''

    const issuedNoMfa = await issueD1SessionCookie(
      db,
      { sessionId: NO_MFA_SESSION, identityId: NO_MFA_ID, sessionVersion: 1 },
      { password: PASSWORD, maxAgeSeconds: 3600 }
    )
    noMfaCookie = (issuedNoMfa ?? '').split(';')[0] ?? ''

    const issuedCustomer = await issueD1SessionCookie(
      db,
      { sessionId: CUSTOMER_SESSION, identityId: CUSTOMER_IDENTITY, sessionVersion: 1 },
      { password: PASSWORD, maxAgeSeconds: 3600 }
    )
    customerCookie = (issuedCustomer ?? '').split(';')[0] ?? ''

    deps = {
      database: db,
      sessionCookieConfiguration: { password: PASSWORD, maxAgeSeconds: 3600 },
      origin: ORIGIN,
      rateLimitPepper: PEPPER,
      now: NOW
    }
  })

  afterEach(() => {
    sqlite.close()
  })

  it('claims owned paths properly', () => {
    expect(ownsMarketingAutomationsNamespace('/api/admin/marketing-automations')).toBe(true)
    expect(ownsMarketingAutomationsNamespace('/api/admin/marketing-automations/policy')).toBe(true)
    expect(ownsMarketingAutomationsNamespace('/api/admin/marketing-automations/overview')).toBe(true)
    expect(ownsMarketingAutomationsNamespace('/api/account/marketing-preferences')).toBe(true)
    expect(ownsMarketingAutomationsNamespace('/api/other')).toBe(false)

    expect(isAdminMarketingAutomationsPath('/api/admin/marketing-automations/policy')).toBe(true)
    expect(isAdminMarketingAutomationsPath('/api/account/marketing-preferences')).toBe(false)
  })

  it('rejects unauthenticated request to admin policy', async () => {
    const req = new Request(`${ORIGIN}/api/admin/marketing-automations/policy`, {
      method: 'GET'
    })
    const res = await handleMarketingAutomationsHttp(req, deps)
    expect(res?.status).toBe(401)
  })

  it('rejects admin request without MFA', async () => {
    const req = new Request(`${ORIGIN}/api/admin/marketing-automations/policy`, {
      method: 'GET',
      headers: { Cookie: noMfaCookie }
    })
    const res = await handleMarketingAutomationsHttp(req, deps)
    expect(res?.status).toBe(403)
    const body = await res?.json()
    expect(body.error.code).toBe('mfa_required')
  })

  it('allows verified admin to read and update policy', async () => {
    const getReq = new Request(`${ORIGIN}/api/admin/marketing-automations/policy`, {
      method: 'GET',
      headers: { Cookie: adminCookie }
    })
    const getRes = await handleMarketingAutomationsHttp(getReq, deps)
    expect(getRes?.status).toBe(200)
    const policy = await getRes?.json()
    expect(policy.id).toBe('global')
    expect(policy.version).toBe(1)

    const updateInput: MarketingAutomationPolicyInput = {
      welcomeSeriesEnabled: true,
      welcomeDiscountEnabled: true,
      welcomeDiscountPercent: 12,
      welcomeDiscountMaxCents: 1500,
      welcomeMinOrderCents: 5000,
      welcomeMarginFloorBasisPoints: 2000,
      winbackEnabled: true,
      winbackInactivityDays: 60,
      winbackCooldownDays: 90,
      winbackDiscountPercent: 10,
      winbackDiscountMaxCents: 2000,
      winbackMarginFloorBasisPoints: 2000,
      postpurchaseEnabled: true,
      postpurchaseDelayHours: 12,
      expectedVersion: 1
    }

    const putReq = new Request(`${ORIGIN}/api/admin/marketing-automations/policy`, {
      method: 'PUT',
      headers: {
        Cookie: adminCookie,
        'Content-Type': 'application/json',
        'Idempotency-Key': 'http-idem-policy-1'
      },
      body: JSON.stringify(updateInput)
    })
    const putRes = await handleMarketingAutomationsHttp(putReq, deps)
    expect(putRes?.status).toBe(200)
    const receipt = await putRes?.json()
    expect(receipt.appliedVersion).toBe(2)
  })

  it('returns overview metrics to admin', async () => {
    const req = new Request(`${ORIGIN}/api/admin/marketing-automations/overview`, {
      method: 'GET',
      headers: { Cookie: adminCookie }
    })
    const res = await handleMarketingAutomationsHttp(req, deps)
    expect(res?.status).toBe(200)
    const overview = await res?.json()
    expect(overview.counts).toBeDefined()
  })

  it('handles welcome dispatch endpoint (MKT-015)', async () => {
    const req = new Request(`${ORIGIN}/api/admin/marketing-automations/welcome/dispatch`, {
      method: 'POST',
      headers: {
        Cookie: adminCookie,
        'Content-Type': 'application/json',
        'Idempotency-Key': 'http-idem-welcome-1'
      },
      body: JSON.stringify({
        customerId: CUSTOMER_ID,
        step: 'professional_value',
        idempotencyKey: 'http-idem-welcome-1'
      })
    })
    const res = await handleMarketingAutomationsHttp(req, deps)
    expect(res?.status).toBe(200)
    const dispatch = await res?.json()
    expect(dispatch.step).toBe('professional_value')
    expect(dispatch.status).toBe('delivered')
  })

  it('handles winback evaluation endpoint (MKT-018)', async () => {
    const req = new Request(`${ORIGIN}/api/admin/marketing-automations/winback/evaluate`, {
      method: 'POST',
      headers: {
        Cookie: adminCookie,
        'Content-Type': 'application/json',
        'Idempotency-Key': 'http-idem-winback-1'
      },
      body: JSON.stringify({
        customerId: CUSTOMER_ID,
        idempotencyKey: 'http-idem-winback-1'
      })
    })
    const res = await handleMarketingAutomationsHttp(req, deps)
    expect(res?.status).toBe(200)
    const evaluation = await res?.json()
    expect(evaluation.eligibilityStatus).toBe('eligible')
    expect(evaluation.discountCode).toMatch(/^VUELVE-/)
  })

  it('handles postpurchase dispatch endpoint (MKT-019)', async () => {
    const req = new Request(`${ORIGIN}/api/admin/marketing-automations/postpurchase/dispatch`, {
      method: 'POST',
      headers: {
        Cookie: adminCookie,
        'Content-Type': 'application/json',
        'Idempotency-Key': 'http-idem-postpurchase-1'
      },
      body: JSON.stringify({
        orderId: ORDER_ID,
        idempotencyKey: 'http-idem-postpurchase-1'
      })
    })
    const res = await handleMarketingAutomationsHttp(req, deps)
    expect(res?.status).toBe(200)
    const dispatches = await res?.json()
    expect(Array.isArray(dispatches)).toBe(true)
    expect(dispatches.length).toBe(2)
  })

  it('allows authenticated customer to save and read preferences (MKT-015)', async () => {
    const prefInput: CustomerPreferencesInput = {
      preferredCategories: ['degreasers', 'floor_care'],
      frequency: 'weekly',
      channel: 'email',
      technicalContentOptIn: true,
      expectedVersion: 0
    }
    const putReq = new Request(`${ORIGIN}/api/account/marketing-preferences`, {
      method: 'PUT',
      headers: {
        Cookie: customerCookie,
        'Content-Type': 'application/json',
        'Idempotency-Key': 'http-idem-pref-1'
      },
      body: JSON.stringify(prefInput)
    })
    const putRes = await handleMarketingAutomationsHttp(putReq, deps)
    expect(putRes?.status).toBe(200)

    const getReq = new Request(`${ORIGIN}/api/account/marketing-preferences`, {
      method: 'GET',
      headers: { Cookie: customerCookie }
    })
    const getRes = await handleMarketingAutomationsHttp(getReq, deps)
    expect(getRes?.status).toBe(200)
    const pref = await getRes?.json()
    expect(pref.preferredCategories).toEqual(['degreasers', 'floor_care'])
    expect(pref.frequency).toBe('weekly')
  })
})

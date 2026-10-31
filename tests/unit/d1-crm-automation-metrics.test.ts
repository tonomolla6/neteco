import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import {
  type CrmHoldoutPolicyInput,
  type CrmAutomationEventInput,
  calculateMargin,
  calculateIncrementalLift
} from '../../shared/crm-automation-metrics'
import {
  CrmAutomationMetricsError,
  readD1HoldoutPolicy,
  updateD1HoldoutPolicy,
  evaluateD1HoldoutAllocation,
  recordD1AutomationEvent,
  getD1FlowMetricsSummary
} from '../../workers/crm/crm-automation-metrics'
import {
  handleCrmAutomationMetricsHttp,
  ownsCrmAutomationMetricsNamespace
} from '../../workers/crm/crm-automation-metrics-http'

const NOW = '2026-10-29T12:00:00Z'
const PAST_DATE = '2026-10-25T10:00:00Z'

const ADMIN_ID = '10000000-0000-4000-8000-000000000001'
const ADMIN_SESSION = '20000000-0000-4000-8000-000000000001'
const ADMIN_CLAIMS = { identityId: ADMIN_ID, sessionId: ADMIN_SESSION, sessionVersion: 1 }

const CUSTOMER_ID_1 = '30000000-0000-4000-8000-000000000001'
const CUSTOMER_ID_2 = '30000000-0000-4000-8000-000000000002'
const CUSTOMER_ID_3 = '30000000-0000-4000-8000-000000000003'

const CUSTOMER_IDENTITY_1 = '10000000-0000-4000-8000-000000000011'
const CUSTOMER_SESSION_1 = '20000000-0000-4000-8000-000000000011'

const ORDER_ID_1 = '50000000-0000-4000-8000-000000000001'
const ORDER_ID_2 = '50000000-0000-4000-8000-000000000002'

async function setupTestDatabase(): Promise<DatabaseSync> {
  const sqlite = await openMigratedDatabase()
  sqlite.exec(await readFile(new URL('../../db/d1/migrations/0107_marketing_automations.sql', import.meta.url), 'utf8'))
  sqlite.exec(
    await readFile(
      new URL('../../db/d1/migrations/0137_crm_automation_metrics_and_anomaly_detection.sql', import.meta.url),
      'utf8'
    )
  )

  // Roles & permissions
  sqlite.exec(`
    INSERT OR IGNORE INTO roles (code, name, description) VALUES
      ('admin', 'Administración', 'Fixture admin'),
      ('customer', 'Cliente', 'Fixture cliente');
    INSERT OR IGNORE INTO permissions (code, resource, action, description) VALUES
      ('administration.manage', 'administration', 'manage', 'Fixture admin'),
      ('customer.profile.read', 'customer_profile', 'read', 'Fixture customer');
    INSERT OR IGNORE INTO role_permissions (role_code, permission_code) VALUES
      ('admin', 'administration.manage'),
      ('customer', 'customer.profile.read');
  `)

  // Admin identity & session
  sqlite
    .prepare(
      `INSERT INTO identities (id, email, password_hash, status, session_version, email_verified_at, created_at, updated_at)
       VALUES (?, 'admin@neteco.es', 'fixture-hash', 'active', 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`
    )
    .run(ADMIN_ID)

  sqlite
    .prepare(
      `INSERT INTO auth_sessions (id, identity_id, session_version, mfa_verified, created_at, expires_at)
       VALUES (?, ?, 1, 1, '2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z')`
    )
    .run(ADMIN_SESSION, ADMIN_ID)

  sqlite
    .prepare(
      `INSERT INTO identity_roles (identity_id, role_code, granted_at) VALUES (?, 'admin', '2026-01-01T00:00:00Z')`
    )
    .run(ADMIN_ID)

  // Customer profiles
  for (const [id, name] of [
    [CUSTOMER_ID_1, 'Lavandería Central SL'],
    [CUSTOMER_ID_2, 'Restaurante El Puerto'],
    [CUSTOMER_ID_3, 'Clínica Dental Norte']
  ] as const) {
    sqlite
      .prepare(
        `INSERT INTO customers (id, name, status, created_at, updated_at)
         VALUES (?, ?, 'active', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`
      )
      .run(id, name)
  }

  // Customer 1 identity & session
  sqlite
    .prepare(
      `INSERT INTO identities (id, email, password_hash, status, session_version, email_verified_at, customer_id, created_at, updated_at)
       VALUES (?, 'cliente1@neteco.es', 'fixture-hash', 'active', 1, '2026-01-01T00:00:00Z', ?, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`
    )
    .run(CUSTOMER_IDENTITY_1, CUSTOMER_ID_1)

  sqlite
    .prepare(
      `INSERT INTO auth_sessions (id, identity_id, session_version, mfa_verified, created_at, expires_at)
       VALUES (?, ?, 1, 0, '2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z')`
    )
    .run(CUSTOMER_SESSION_1, CUSTOMER_IDENTITY_1)

  sqlite
    .prepare(
      `INSERT INTO identity_roles (identity_id, role_code, granted_at) VALUES (?, 'customer', '2026-01-01T00:00:00Z')`
    )
    .run(CUSTOMER_IDENTITY_1)

  // Helper to insert order with required FKs
  function insertOrderFixture(orderId: string, customerId: string) {
    const dummyId = `cart-${orderId}`
    const tokenHash = `${orderId.replace(/-/g, '')}${'0'.repeat(32)}`.slice(0, 64)
    const expiresAt = '2026-11-20T00:00:00Z'
    sqlite
      .prepare(
        `INSERT OR IGNORE INTO carts(id, token_hash, status, version, expires_at, correlation_id, created_at, updated_at) VALUES(?, ?, 'active', 1, ?, 'corr-1', ?, ?)`
      )
      .run(dummyId, tokenHash, expiresAt, PAST_DATE, PAST_DATE)

    sqlite
      .prepare(
        `INSERT OR IGNORE INTO checkout_quotes(id, cart_id, cart_version, pricing_instant, currency, shipping_gross_cents, shipping_pending, total_net_cents, total_tax_cents, total_gross_cents, snapshot_hash, correlation_id, created_at)
       VALUES(?, ?, 1, ?, 'EUR', 0, 1, 10000, 2100, 12100, ?, 'corr-1', ?)`
      )
      .run(dummyId, dummyId, PAST_DATE, tokenHash, PAST_DATE)

    sqlite
      .prepare(
        `INSERT OR IGNORE INTO shipping_quotes(id, cart_id, cart_version, destination_hash, options_json, option_count, snapshot_hash, expires_at, correlation_id, created_at)
       VALUES(?, ?, 1, ?, '[]', 0, ?, ?, 'corr-1', ?)`
      )
      .run(dummyId, dummyId, tokenHash, tokenHash, expiresAt, PAST_DATE)

    sqlite
      .prepare(
        `INSERT OR IGNORE INTO checkout_attempts(id, cart_id, command_key, state, correlation_id, payload_hash, created_at, updated_at)
       VALUES(?, ?, 'key-1', 'failed', 'corr-1', ?, ?, ?)`
      )
      .run(dummyId, dummyId, tokenHash, PAST_DATE, PAST_DATE)

    sqlite
      .prepare(
        `INSERT INTO orders(
           id, cart_id, quote_id, shipping_quote_id, attempt_id, token_hash, status,
           reservation_id, reservation_expires_at, currency, total_net_cents, total_tax_cents, total_gross_cents,
           shipping_net_cents, shipping_tax_cents, shipping_gross_cents, shipping_method_code, shipping_rate_version,
           shipping_eta_min_days, shipping_eta_max_days, contact_email, contact_email_hash, consent_tos, consent_privacy,
           correlation_id, customer_id, created_at, updated_at
         ) VALUES (
           ?, ?, ?, ?, ?, ?, 'awaiting_payment',
           'res-1', ?, 'EUR', 10000, 2100, 12100,
           0, 0, 0, 'standard', 1, 1, 3, 'test@neteco.es', ?, 1, 1,
           'corr-1', ?, ?, ?
         )`
      )
      .run(
        orderId,
        dummyId,
        dummyId,
        dummyId,
        dummyId,
        tokenHash,
        expiresAt,
        tokenHash,
        customerId,
        PAST_DATE,
        PAST_DATE
      )
  }

  insertOrderFixture(ORDER_ID_1, CUSTOMER_ID_1)
  insertOrderFixture(ORDER_ID_2, CUSTOMER_ID_2)

  return sqlite
}

describe('DAT-016: CRM Automation Metrics & Holdout Experimentation', () => {
  let sqlite: DatabaseSync
  let db: D1Database

  beforeEach(async () => {
    sqlite = await setupTestDatabase()
    db = d1OverSqlite(sqlite)
  })

  afterEach(() => {
    sqlite.close()
  })

  it('reads default holdout policy when none exists for a flow', async () => {
    const policy = await readD1HoldoutPolicy(db, 'welcome_series')
    expect(policy.flowId).toBe('welcome_series')
    expect(policy.version).toBe(1)
    expect(policy.holdoutPercentage).toBe(10)
    expect(policy.holdoutEnabled).toBe(true)
    expect(policy.minSampleSize).toBe(20)
  })

  it('updates holdout policy with CAS version increment', async () => {
    const updateInput: CrmHoldoutPolicyInput = {
      flowId: 'welcome_series',
      holdoutPercentage: 20,
      holdoutEnabled: true,
      minSampleSize: 25,
      expectedVersion: 1
    }

    const res = await updateD1HoldoutPolicy(db, ADMIN_CLAIMS, updateInput, 'cmd-holdout-001', { now: () => NOW })

    expect(res.appliedVersion).toBe(2)

    const updated = await readD1HoldoutPolicy(db, 'welcome_series')
    expect(updated.version).toBe(2)
    expect(updated.holdoutPercentage).toBe(20)
    expect(updated.minSampleSize).toBe(25)
  })

  it('fails policy update on version conflict (CAS)', async () => {
    const updateInput: CrmHoldoutPolicyInput = {
      flowId: 'welcome_series',
      holdoutPercentage: 15,
      holdoutEnabled: true,
      minSampleSize: 20,
      expectedVersion: 99 // incorrect version
    }

    await expect(
      updateD1HoldoutPolicy(db, ADMIN_CLAIMS, updateInput, 'cmd-holdout-cas', { now: () => NOW })
    ).rejects.toThrow(CrmAutomationMetricsError)
  })

  it('evaluates deterministic holdout allocation idempotently', async () => {
    // 1st allocation
    const alloc1 = await evaluateD1HoldoutAllocation(
      db,
      ADMIN_CLAIMS,
      {
        flowId: 'welcome_series',
        step: 'step_1_value',
        customerId: CUSTOMER_ID_1,
        idempotencyKey: 'alloc-key-001'
      },
      { now: () => NOW }
    )

    expect(['treatment', 'holdout']).toContain(alloc1.groupType)

    // 2nd evaluation for same flow, step, customer should return the EXACT same allocation
    const alloc2 = await evaluateD1HoldoutAllocation(
      db,
      ADMIN_CLAIMS,
      {
        flowId: 'welcome_series',
        step: 'step_1_value',
        customerId: CUSTOMER_ID_1,
        idempotencyKey: 'alloc-key-002'
      },
      { now: () => NOW }
    )

    expect(alloc2.groupType).toBe(alloc1.groupType)
  })

  it('allocates 100% to treatment when holdout is disabled', async () => {
    await updateD1HoldoutPolicy(
      db,
      ADMIN_CLAIMS,
      {
        flowId: 'abandoned_cart',
        holdoutPercentage: 0,
        holdoutEnabled: false,
        minSampleSize: 20,
        expectedVersion: 1
      },
      'cmd-disable-holdout',
      { now: () => NOW }
    )

    const alloc = await evaluateD1HoldoutAllocation(
      db,
      ADMIN_CLAIMS,
      {
        flowId: 'abandoned_cart',
        step: 'cart_reminder_1',
        customerId: CUSTOMER_ID_2,
        idempotencyKey: 'alloc-cart-001'
      },
      { now: () => NOW }
    )

    expect(alloc.groupType).toBe('treatment')
  })

  it('records delivery, click, unsubscribe, complaint, and conversion with margin', async () => {
    // 1. Delivery
    await recordD1AutomationEvent(
      db,
      ADMIN_CLAIMS,
      {
        flowId: 'welcome_series',
        step: 'step_1_value',
        customerId: CUSTOMER_ID_1,
        groupType: 'treatment',
        eventType: 'delivery',
        metadata: { channel: 'email' },
        occurredAt: NOW,
        idempotencyKey: 'evt-deliv-001'
      },
      { now: () => NOW }
    )

    // 2. Click
    await recordD1AutomationEvent(
      db,
      ADMIN_CLAIMS,
      {
        flowId: 'welcome_series',
        step: 'step_1_value',
        customerId: CUSTOMER_ID_1,
        groupType: 'treatment',
        eventType: 'click',
        metadata: { target: 'catalog' },
        occurredAt: NOW,
        idempotencyKey: 'evt-click-001'
      },
      { now: () => NOW }
    )

    // 3. Conversion with margin calculation
    const revenueCents = 15000 // 150.00 EUR
    const costCents = 9000 // 90.00 EUR
    const { marginCents, marginBasisPoints } = calculateMargin(revenueCents, costCents)
    expect(marginCents).toBe(6000) // 60.00 EUR
    expect(marginBasisPoints).toBe(4000) // 40.00%

    await recordD1AutomationEvent(
      db,
      ADMIN_CLAIMS,
      {
        flowId: 'welcome_series',
        step: 'step_1_value',
        customerId: CUSTOMER_ID_1,
        groupType: 'treatment',
        eventType: 'conversion',
        orderId: ORDER_ID_1,
        revenueCents,
        costCents,
        metadata: { promoCode: 'WELCOME10' },
        occurredAt: NOW,
        idempotencyKey: 'evt-conv-001'
      },
      { now: () => NOW }
    )

    // 4. Complaint (queja) from customer 2
    await recordD1AutomationEvent(
      db,
      ADMIN_CLAIMS,
      {
        flowId: 'welcome_series',
        step: 'step_1_value',
        customerId: CUSTOMER_ID_2,
        groupType: 'treatment',
        eventType: 'complaint',
        metadata: { reason: 'too_frequent' },
        occurredAt: NOW,
        idempotencyKey: 'evt-comp-001'
      },
      { now: () => NOW }
    )

    // 5. Unsubscribe (baja) from customer 3
    await recordD1AutomationEvent(
      db,
      ADMIN_CLAIMS,
      {
        flowId: 'welcome_series',
        step: 'step_1_value',
        customerId: CUSTOMER_ID_3,
        groupType: 'treatment',
        eventType: 'unsubscribe',
        metadata: { reason: 'not_interested' },
        occurredAt: NOW,
        idempotencyKey: 'evt-unsub-001'
      },
      { now: () => NOW }
    )

    // Verify metrics summary
    const summary = await getD1FlowMetricsSummary(db, 'welcome_series')
    expect(summary.flowId).toBe('welcome_series')
    expect(summary.treatment.deliveries).toBe(1)
    expect(summary.treatment.clicks).toBe(1)
    expect(summary.treatment.ctrPercent).toBe(100)
    expect(summary.treatment.conversions).toBe(1)
    expect(summary.treatment.conversionRatePercent).toBe(100)
    expect(summary.treatment.complaints).toBe(1)
    expect(summary.treatment.unsubscribes).toBe(1)
    expect(summary.treatment.totalRevenueCents).toBe(15000)
    expect(summary.treatment.totalCostCents).toBe(9000)
    expect(summary.treatment.totalMarginCents).toBe(6000)
    expect(summary.treatment.marginBasisPoints).toBe(4000)
  })

  it('correctly calculates incremental lift when holdout is viable', () => {
    const treatment = {
      deliveries: 100,
      clicks: 25,
      ctrPercent: 25,
      conversions: 10,
      conversionRatePercent: 10,
      unsubscribes: 1,
      unsubscribeRatePercent: 1,
      complaints: 0,
      complaintRatePercent: 0,
      totalRevenueCents: 100000,
      totalCostCents: 60000,
      totalMarginCents: 40000,
      marginBasisPoints: 4000,
      averageOrderValueCents: 10000
    }

    const holdout = {
      allocations: 50,
      conversions: 2,
      conversionRatePercent: 4,
      totalRevenueCents: 20000,
      totalCostCents: 12000,
      totalMarginCents: 8000,
      marginBasisPoints: 4000,
      averageOrderValueCents: 10000
    }

    const lift = calculateIncrementalLift(treatment, holdout, 20, true)
    expect(lift.holdoutViable).toBe(true)
    // Treatment rate = 10%, Holdout rate = 4% => incremental conv rate = +6.00%
    expect(lift.incrementalConversionRatePercent).toBe(6)
    // Relative lift = (10 - 4) / 4 = 150.00%
    expect(lift.incrementalLiftPercent).toBe(150)
    // Expected conversions without automation = 4% of 100 = 4. Actual = 10. Incremental conversions = 6
    expect(lift.incrementalConversions).toBe(6)
    // Incremental margin
    expect(lift.incrementalMarginCents).toBe(24000)
  })

  it('marks holdout as not viable when sample size is insufficient', () => {
    const treatment = {
      deliveries: 5,
      clicks: 1,
      ctrPercent: 20,
      conversions: 1,
      conversionRatePercent: 20,
      unsubscribes: 0,
      unsubscribeRatePercent: 0,
      complaints: 0,
      complaintRatePercent: 0,
      totalRevenueCents: 10000,
      totalCostCents: 6000,
      totalMarginCents: 4000,
      marginBasisPoints: 4000,
      averageOrderValueCents: 10000
    }

    const holdout = {
      allocations: 2,
      conversions: 0,
      conversionRatePercent: 0,
      totalRevenueCents: 0,
      totalCostCents: 0,
      totalMarginCents: 0,
      marginBasisPoints: 0,
      averageOrderValueCents: 0
    }

    const lift = calculateIncrementalLift(treatment, holdout, 20, true)
    expect(lift.holdoutViable).toBe(false)
    expect(lift.viabilityReason).toContain('insufficient_sample_size')
    expect(lift.incrementalConversions).toBe(0)
    expect(lift.incrementalMarginCents).toBe(0)
  })

  it('rejects unauthorized caller without administration permission', async () => {
    const customerClaims = {
      identityId: CUSTOMER_IDENTITY_1,
      sessionId: CUSTOMER_SESSION_1,
      sessionVersion: 1
    }

    await expect(
      updateD1HoldoutPolicy(
        db,
        customerClaims,
        {
          flowId: 'welcome_series',
          holdoutPercentage: 10,
          holdoutEnabled: true,
          minSampleSize: 20,
          expectedVersion: 1
        },
        'unauth-cmd',
        { now: () => NOW }
      )
    ).rejects.toThrow(CrmAutomationMetricsError)
  })

  it('handles HTTP API endpoints correctly with namespace check', async () => {
    expect(ownsCrmAutomationMetricsNamespace('/api/admin/crm/metrics/flows')).toBe(true)
    expect(ownsCrmAutomationMetricsNamespace('/api/admin/crm/metrics/events')).toBe(true)
    expect(ownsCrmAutomationMetricsNamespace('/api/admin/crm/metrics/holdout/evaluate')).toBe(true)
    expect(ownsCrmAutomationMetricsNamespace('/api/admin/crm/metrics/holdout/policy')).toBe(true)
    expect(ownsCrmAutomationMetricsNamespace('/api/admin/orders')).toBe(false)

    // GET /api/admin/crm/metrics/flows with mock session
    const req = new Request('https://neteco.es/api/admin/crm/metrics/flows', {
      headers: {
        cookie: `neteco_session=${ADMIN_SESSION}`,
        origin: 'https://neteco.es'
      }
    })

    const res = await handleCrmAutomationMetricsHttp(req, {
      database: db,
      sessionCookieConfiguration: { password: 'secret-password-32-chars-long-xxx', maxAgeSeconds: 3600 },
      origin: 'https://neteco.es',
      claimsResolver: async () => ADMIN_CLAIMS
    })

    expect(res).not.toBeNull()
    expect(res!.status).toBe(200)
    const json = (await res!.json()) as { flows: unknown[] }
    expect(Array.isArray(json.flows)).toBe(true)

    // GET /api/admin/crm/metrics/flows rejects customer session with 403 forbidden
    const customerReq = new Request('https://neteco.es/api/admin/crm/metrics/flows', {
      headers: {
        cookie: `neteco_session=${CUSTOMER_SESSION_1}`,
        origin: 'https://neteco.es'
      }
    })
    const customerRes = await handleCrmAutomationMetricsHttp(customerReq, {
      database: db,
      sessionCookieConfiguration: { password: 'secret-password-32-chars-long-xxx', maxAgeSeconds: 3600 },
      origin: 'https://neteco.es',
      claimsResolver: async () => ({
        identityId: CUSTOMER_IDENTITY_1,
        sessionId: CUSTOMER_SESSION_1,
        sessionVersion: 1
      })
    })
    expect(customerRes).not.toBeNull()
    expect(customerRes!.status).toBe(403)
    const customerBody = (await customerRes!.json()) as { error: { code: string } }
    expect(['forbidden', 'mfa_required']).toContain(customerBody.error.code)
  })

  it('detects idempotency conflict on payload mutation for the same idempotency key', async () => {
    const input1: CrmAutomationEventInput = {
      flowId: 'welcome_series',
      step: 'step_1_value',
      customerId: CUSTOMER_ID_1,
      groupType: 'treatment',
      eventType: 'delivery',
      metadata: { target: 'v1' },
      occurredAt: NOW,
      idempotencyKey: 'idem-conflict-key-01'
    }

    await recordD1AutomationEvent(db, ADMIN_CLAIMS, input1, { now: () => NOW })

    const input2: CrmAutomationEventInput = {
      ...input1,
      eventType: 'click' // mutated eventType!
    }

    await expect(recordD1AutomationEvent(db, ADMIN_CLAIMS, input2, { now: () => NOW })).rejects.toThrow(
      CrmAutomationMetricsError
    )
  })

  it('handles margin edge cases: zero revenue and cost exceeding revenue', () => {
    // Zero revenue
    const zero = calculateMargin(0, 0)
    expect(zero.marginCents).toBe(0)
    expect(zero.marginBasisPoints).toBe(0)

    // Cost exceeds revenue (loss / negative margin)
    const negative = calculateMargin(5000, 7000)
    expect(negative.marginCents).toBe(-2000)
    expect(negative.marginBasisPoints).toBe(-4000) // -40.00%
  })

  it('handles HTTP flow detail, holdout evaluate, event ingest and policy updates', async () => {
    const sessionConfig = { password: 'secret-password-32-chars-long-xxx', maxAgeSeconds: 3600 }

    // 1. GET flow detail
    const getReq = new Request('https://neteco.es/api/admin/crm/metrics/flows/welcome_series')
    const getRes = await handleCrmAutomationMetricsHttp(getReq, {
      database: db,
      sessionCookieConfiguration: sessionConfig,
      claimsResolver: async () => ADMIN_CLAIMS
    })
    expect(getRes?.status).toBe(200)
    const getJson = (await getRes!.json()) as { flowId: string }
    expect(getJson.flowId).toBe('welcome_series')

    // 2. POST evaluate holdout via HTTP
    const evalReq = new Request('https://neteco.es/api/admin/crm/metrics/holdout/evaluate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        flowId: 'welcome_series',
        step: 'step_welcome_coupon',
        customerId: CUSTOMER_ID_3,
        idempotencyKey: 'http-eval-key-01'
      })
    })
    const evalRes = await handleCrmAutomationMetricsHttp(evalReq, {
      database: db,
      sessionCookieConfiguration: sessionConfig,
      claimsResolver: async () => ADMIN_CLAIMS
    })
    expect(evalRes?.status).toBe(200)

    // 3. POST event via HTTP
    const evReq = new Request('https://neteco.es/api/admin/crm/metrics/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        flowId: 'welcome_series',
        step: 'step_welcome_coupon',
        customerId: CUSTOMER_ID_3,
        groupType: 'treatment',
        eventType: 'delivery',
        occurredAt: NOW,
        idempotencyKey: 'http-ev-key-01'
      })
    })
    const evRes = await handleCrmAutomationMetricsHttp(evReq, {
      database: db,
      sessionCookieConfiguration: sessionConfig,
      claimsResolver: async () => ADMIN_CLAIMS
    })
    expect(evRes?.status).toBe(200)

    // 4. PUT policy via HTTP
    const putReq = new Request('https://neteco.es/api/admin/crm/metrics/holdout/policy', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        flowId: 'welcome_series',
        holdoutPercentage: 15,
        holdoutEnabled: true,
        minSampleSize: 30,
        expectedVersion: 1
      })
    })
    const putRes = await handleCrmAutomationMetricsHttp(putReq, {
      database: db,
      sessionCookieConfiguration: sessionConfig,
      claimsResolver: async () => ADMIN_CLAIMS
    })
    expect(putRes?.status).toBe(200)
    const putJson = (await putRes!.json()) as { appliedVersion: number }
    expect(putJson.appliedVersion).toBe(2)
  })

  it('rejects cross-site CSRF requests on mutating HTTP methods', async () => {
    const sessionConfig = { password: 'secret-password-32-chars-long-xxx', maxAgeSeconds: 3600 }
    const csrfReq = new Request('https://neteco.es/api/admin/crm/metrics/events', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'https://evil-attacker.com',
        'sec-fetch-site': 'cross-site'
      },
      body: JSON.stringify({
        flowId: 'welcome_series',
        step: 'step_1',
        customerId: CUSTOMER_ID_1,
        groupType: 'treatment',
        eventType: 'click',
        occurredAt: NOW,
        idempotencyKey: 'csrf-key-01'
      })
    })

    const res = await handleCrmAutomationMetricsHttp(csrfReq, {
      database: db,
      origin: 'https://neteco.es',
      sessionCookieConfiguration: sessionConfig,
      claimsResolver: async () => ADMIN_CLAIMS
    })
    expect(res?.status).toBe(403)
    const json = (await res!.json()) as { error: { code: string } }
    expect(json.error.code).toBe('csrf_rejected')
  })
})

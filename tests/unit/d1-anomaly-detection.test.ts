import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import { type AnomalyPolicyInput, type AnomalySignalInput, ANOMALY_RUNBOOKS } from '../../shared/anomaly-detection'
import {
  AnomalyDetectionError,
  readD1AnomalyPolicy,
  updateD1AnomalyPolicy,
  evaluateD1AnomalySignal,
  listD1AnomalyAlerts,
  getD1AnomalyAlertDetail,
  reviewD1AnomalyAlert
} from '../../workers/observability/anomaly-detection'
import {
  handleAnomalyDetectionHttp,
  ownsAnomalyDetectionNamespace
} from '../../workers/observability/anomaly-detection-http'

const NOW = '2026-10-29T12:00:00Z'

const ADMIN_ID = '10000000-0000-4000-8000-000000000001'
const ADMIN_SESSION = '20000000-0000-4000-8000-000000000001'
const ADMIN_CLAIMS = { identityId: ADMIN_ID, sessionId: ADMIN_SESSION, sessionVersion: 1 }

const CUSTOMER_IDENTITY = '10000000-0000-4000-8000-000000000011'
const CUSTOMER_SESSION = '20000000-0000-4000-8000-000000000011'

async function setupTestDatabase(): Promise<DatabaseSync> {
  const sqlite = await openMigratedDatabase()
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

  // Customer identity
  sqlite
    .prepare(
      `INSERT INTO identities (id, email, password_hash, status, session_version, email_verified_at, created_at, updated_at)
       VALUES (?, 'customer@neteco.es', 'fixture-hash', 'active', 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`
    )
    .run(CUSTOMER_IDENTITY)

  sqlite
    .prepare(
      `INSERT INTO auth_sessions (id, identity_id, session_version, mfa_verified, created_at, expires_at)
       VALUES (?, ?, 1, 0, '2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z')`
    )
    .run(CUSTOMER_SESSION, CUSTOMER_IDENTITY)

  sqlite
    .prepare(
      `INSERT INTO identity_roles (identity_id, role_code, granted_at) VALUES (?, 'customer', '2026-01-01T00:00:00Z')`
    )
    .run(CUSTOMER_IDENTITY)

  return sqlite
}

describe('DAT-024: Anomaly Detection with Noise Avoidance & Operator Review', () => {
  let sqlite: DatabaseSync
  let db: D1Database

  beforeEach(async () => {
    sqlite = await setupTestDatabase()
    db = d1OverSqlite(sqlite)
  })

  afterEach(() => {
    sqlite.close()
  })

  it('reads default anomaly policies for all 5 dimensions', async () => {
    for (const dim of ['conversion', 'payment', 'stock', 'tracking', 'data'] as const) {
      const policy = await readD1AnomalyPolicy(db, dim)
      expect(policy.dimension).toBe(dim)
      expect(policy.version).toBe(1)
      expect(policy.warningDropPercent).toBeGreaterThan(0)
      expect(policy.criticalDropPercent).toBeGreaterThan(policy.warningDropPercent)
      expect(policy.minSampleSize).toBeGreaterThan(0)
      expect(policy.enabled).toBe(true)
    }
  })

  it('updates anomaly policy with CAS version increment', async () => {
    const input: AnomalyPolicyInput = {
      warningDropPercent: 30,
      criticalDropPercent: 60,
      minSampleSize: 50,
      evaluationWindowMinutes: 60,
      cooldownMinutes: 120,
      enabled: true,
      expectedVersion: 1
    }

    const res = await updateD1AnomalyPolicy(db, ADMIN_CLAIMS, 'conversion', input, 'cmd-pol-conv-001', {
      now: () => NOW
    })

    expect(res.appliedVersion).toBe(2)

    const updated = await readD1AnomalyPolicy(db, 'conversion')
    expect(updated.version).toBe(2)
    expect(updated.warningDropPercent).toBe(30)
    expect(updated.criticalDropPercent).toBe(60)
    expect(updated.minSampleSize).toBe(50)
  })

  it('rejects policy update on version conflict (CAS)', async () => {
    const input: AnomalyPolicyInput = {
      warningDropPercent: 25,
      criticalDropPercent: 50,
      minSampleSize: 20,
      evaluationWindowMinutes: 60,
      cooldownMinutes: 60,
      enabled: true,
      expectedVersion: 42 // stale version
    }

    await expect(
      updateD1AnomalyPolicy(db, ADMIN_CLAIMS, 'payment', input, 'cmd-cas-err', { now: () => NOW })
    ).rejects.toThrow(AnomalyDetectionError)
  })

  it('avoids noise when sample size is below minimum threshold', async () => {
    const signal: AnomalySignalInput = {
      dimension: 'conversion',
      metricName: 'checkout_conversion_rate',
      baselineValue: 4.5,
      observedValue: 0.5, // 88% drop!
      sampleSize: 5, // Policy requires at least 20 samples by default!
      detectedAt: NOW,
      idempotencyKey: 'sig-noise-001'
    }

    const res = await evaluateD1AnomalySignal(db, ADMIN_CLAIMS, signal, { now: () => NOW })
    expect(res.isAnomaly).toBe(false)
    expect(res.alertCreated).toBe(false)
    expect(res.reason).toContain('sample_size_below_threshold')

    const alerts = await listD1AnomalyAlerts(db, { dimension: 'conversion' })
    expect(alerts.total).toBe(0)
  })

  it('avoids noise when drop percentage is within normal tolerance bounds', async () => {
    const signal: AnomalySignalInput = {
      dimension: 'conversion',
      metricName: 'checkout_conversion_rate',
      baselineValue: 4.0,
      observedValue: 3.6, // only 10% drop, default warning is 25%
      sampleSize: 100,
      detectedAt: NOW,
      idempotencyKey: 'sig-tol-001'
    }

    const res = await evaluateD1AnomalySignal(db, ADMIN_CLAIMS, signal, { now: () => NOW })
    expect(res.isAnomaly).toBe(false)
    expect(res.alertCreated).toBe(false)
    expect(res.reason).toContain('drop_within_tolerance')
  })

  it('triggers critical alert when drop exceeds critical threshold for conversion', async () => {
    const signal: AnomalySignalInput = {
      dimension: 'conversion',
      metricName: 'checkout_conversion_rate',
      baselineValue: 4.0,
      observedValue: 1.0, // 75% drop! Critical is >= 50%
      sampleSize: 150,
      detectedAt: NOW,
      idempotencyKey: 'sig-crit-001'
    }

    const res = await evaluateD1AnomalySignal(db, ADMIN_CLAIMS, signal, { now: () => NOW })
    expect(res.isAnomaly).toBe(true)
    expect(res.alertCreated).toBe(true)
    expect(res.alert?.severity).toBe('critical')
    expect(res.alert?.runbookId).toBe(ANOMALY_RUNBOOKS.conversion.runbookId)
    expect(res.alert?.status).toBe('open')
  })

  it('triggers alerts across all 5 dimensions with appropriate runbooks', async () => {
    const dimensions = ['payment', 'stock', 'tracking', 'data'] as const
    const metrics = {
      payment: 'gateway_authorization_success_rate',
      stock: 'high_velocity_sku_inventory_level',
      tracking: 'telemetry_event_throughput_per_minute',
      data: 'catalog_sync_freshness_seconds'
    }

    for (const dim of dimensions) {
      const signal: AnomalySignalInput = {
        dimension: dim,
        metricName: metrics[dim],
        baselineValue: 100.0,
        observedValue: 30.0, // 70% drop
        sampleSize: 80,
        detectedAt: NOW,
        idempotencyKey: `sig-${dim}-001`
      }

      const res = await evaluateD1AnomalySignal(db, ADMIN_CLAIMS, signal, { now: () => NOW })
      expect(res.isAnomaly).toBe(true)
      expect(res.alertCreated).toBe(true)
      expect(res.alert?.dimension).toBe(dim)
      expect(res.alert?.runbookId).toBe(ANOMALY_RUNBOOKS[dim].runbookId)
      expect(res.alert?.runbookTitle).toBe(ANOMALY_RUNBOOKS[dim].title)
    }
  })

  it('suppresses redundant alerts during cooldown window to avoid alert fatigue', async () => {
    const signal1: AnomalySignalInput = {
      dimension: 'payment',
      metricName: 'payment_success_rate',
      baselineValue: 98.0,
      observedValue: 40.0,
      sampleSize: 100,
      detectedAt: NOW,
      idempotencyKey: 'sig-cd-001'
    }

    const first = await evaluateD1AnomalySignal(db, ADMIN_CLAIMS, signal1, { now: () => NOW })
    expect(first.alertCreated).toBe(true)

    // Second evaluation for same dimension and metric within cooldown window
    const signal2: AnomalySignalInput = {
      dimension: 'payment',
      metricName: 'payment_success_rate',
      baselineValue: 98.0,
      observedValue: 38.0,
      sampleSize: 110,
      detectedAt: '2026-10-29T12:15:00Z', // 15 mins later, cooldown is 60m
      idempotencyKey: 'sig-cd-002'
    }

    const second = await evaluateD1AnomalySignal(db, ADMIN_CLAIMS, signal2, { now: () => '2026-10-29T12:15:00Z' })
    expect(second.isAnomaly).toBe(true)
    expect(second.alertCreated).toBe(false)
    expect(second.reason).toContain('cooldown_active')
  })

  it('handles operator review workflow (acknowledge, investigate, resolve, dismiss) with CAS and audit trail', async () => {
    // 1. Create alert
    const sig: AnomalySignalInput = {
      dimension: 'conversion',
      metricName: 'funnel_conversion_drop',
      baselineValue: 5.0,
      observedValue: 1.5,
      sampleSize: 200,
      detectedAt: NOW,
      idempotencyKey: 'sig-rev-flow'
    }
    const evalRes = await evaluateD1AnomalySignal(db, ADMIN_CLAIMS, sig, { now: () => NOW })
    const alertId = evalRes.alert!.id

    // 2. Acknowledge alert
    const ackRes = await reviewD1AnomalyAlert(
      db,
      ADMIN_CLAIMS,
      alertId,
      {
        action: 'acknowledge',
        notes: 'Alerta recibida por el equipo de operaciones. Se inicia verificación.',
        expectedVersion: 1,
        idempotencyKey: 'rev-ack-001'
      },
      { now: () => '2026-10-29T12:05:00Z' }
    )
    expect(ackRes.alert.status).toBe('acknowledged')
    expect(ackRes.alert.version).toBe(2)

    // 3. CAS conflict check: attempting to review with stale version 1 fails
    await expect(
      reviewD1AnomalyAlert(
        db,
        ADMIN_CLAIMS,
        alertId,
        {
          action: 'investigate',
          notes: 'Intento con versión desfasada',
          expectedVersion: 1, // Stale! Current is 2
          idempotencyKey: 'rev-stale-001'
        },
        { now: () => '2026-10-29T12:06:00Z' }
      )
    ).rejects.toThrow(AnomalyDetectionError)

    // 4. Mark under investigation
    const invRes = await reviewD1AnomalyAlert(
      db,
      ADMIN_CLAIMS,
      alertId,
      {
        action: 'investigate',
        notes: 'Investigando latencias en la pasarela Sabadell y posibles bloqueos WAF.',
        expectedVersion: 2,
        idempotencyKey: 'rev-inv-001'
      },
      { now: () => '2026-10-29T12:10:00Z' }
    )
    expect(invRes.alert.status).toBe('under_investigation')
    expect(invRes.alert.version).toBe(3)

    // 5. Resolve alert with resolutionAction
    const resRes = await reviewD1AnomalyAlert(
      db,
      ADMIN_CLAIMS,
      alertId,
      {
        action: 'resolve',
        notes: 'Incidencia resuelta. Se conmutó el tráfico hacia pasarela secundaria y la tasa volvió a la normalidad.',
        resolutionAction: 'failover_gateway_activated',
        expectedVersion: 3,
        idempotencyKey: 'rev-res-001'
      },
      { now: () => '2026-10-29T12:30:00Z' }
    )
    expect(resRes.alert.status).toBe('resolved')
    expect(resRes.alert.version).toBe(4)
    expect(resRes.alert.resolutionAction).toBe('failover_gateway_activated')

    // 6. Verify audit history in detail query
    const detail = await getD1AnomalyAlertDetail(db, alertId)
    expect(detail.alert.status).toBe('resolved')
    expect(detail.reviews.length).toBe(3)
    expect(detail.runbook.runbookId).toBe(ANOMALY_RUNBOOKS.conversion.runbookId)
  })

  it('rejects unauthorized caller without administration or operations permission', async () => {
    const unauthClaims = {
      identityId: CUSTOMER_IDENTITY,
      sessionId: CUSTOMER_SESSION,
      sessionVersion: 1
    }

    await expect(
      updateD1AnomalyPolicy(
        db,
        unauthClaims,
        'stock',
        {
          warningDropPercent: 20,
          criticalDropPercent: 50,
          minSampleSize: 10,
          evaluationWindowMinutes: 60,
          cooldownMinutes: 30,
          enabled: true,
          expectedVersion: 1
        },
        'unauth-pol',
        { now: () => NOW }
      )
    ).rejects.toThrow(AnomalyDetectionError)
  })

  it('handles HTTP endpoints for anomaly detection correctly', async () => {
    expect(ownsAnomalyDetectionNamespace('/api/admin/observability/anomalies/alerts')).toBe(true)
    expect(ownsAnomalyDetectionNamespace('/api/admin/observability/anomalies/runbooks')).toBe(true)
    expect(ownsAnomalyDetectionNamespace('/api/admin/observability/anomalies/policies')).toBe(true)
    expect(ownsAnomalyDetectionNamespace('/api/admin/orders')).toBe(false)

    // GET /api/admin/observability/anomalies/runbooks
    const req = new Request('https://neteco.es/api/admin/observability/anomalies/runbooks', {
      headers: {
        cookie: `neteco_session=${ADMIN_SESSION}`,
        origin: 'https://neteco.es'
      }
    })

    const res = await handleAnomalyDetectionHttp(req, {
      database: db,
      sessionCookieConfiguration: { password: 'secret-password-32-chars-long-xxx', maxAgeSeconds: 3600 },
      origin: 'https://neteco.es',
      claimsResolver: async () => ADMIN_CLAIMS
    })

    expect(res).not.toBeNull()
    expect(res!.status).toBe(200)
    const json = (await res!.json()) as { runbooks: unknown[] }
    expect(Array.isArray(json.runbooks)).toBe(true)
    expect(json.runbooks.length).toBe(5)

    // Rejects customer session with 403 forbidden
    const customerReq = new Request('https://neteco.es/api/admin/observability/anomalies/runbooks', {
      headers: {
        cookie: `neteco_session=${CUSTOMER_SESSION}`,
        origin: 'https://neteco.es'
      }
    })
    const customerRes = await handleAnomalyDetectionHttp(customerReq, {
      database: db,
      sessionCookieConfiguration: { password: 'secret-password-32-chars-long-xxx', maxAgeSeconds: 3600 },
      origin: 'https://neteco.es',
      claimsResolver: async () => ({
        identityId: CUSTOMER_IDENTITY,
        sessionId: CUSTOMER_SESSION,
        sessionVersion: 1
      })
    })
    expect(customerRes).not.toBeNull()
    expect(customerRes!.status).toBe(403)
    const customerBody = (await customerRes!.json()) as { error: { code: string } }
    expect(['forbidden', 'mfa_required']).toContain(customerBody.error.code)
  })

  it('filters anomaly alerts by dimension, severity, status, and pagination', async () => {
    // Generate two alerts: one critical conversion, one warning payment
    await evaluateD1AnomalySignal(
      db,
      ADMIN_CLAIMS,
      {
        dimension: 'conversion',
        metricName: 'filter_test_conv',
        baselineValue: 10,
        observedValue: 2, // 80% drop -> critical
        sampleSize: 100,
        detectedAt: NOW,
        idempotencyKey: 'filter-conv-01'
      },
      { now: () => NOW }
    )

    await evaluateD1AnomalySignal(
      db,
      ADMIN_CLAIMS,
      {
        dimension: 'payment',
        metricName: 'filter_test_paym',
        baselineValue: 100,
        observedValue: 75, // 25% drop -> warning (policy warning is 20%)
        sampleSize: 100,
        detectedAt: NOW,
        idempotencyKey: 'filter-paym-01'
      },
      { now: () => NOW }
    )

    // Filter by dimension
    const convOnly = await listD1AnomalyAlerts(db, { dimension: 'conversion' })
    expect(convOnly.items.every((a) => a.dimension === 'conversion')).toBe(true)

    // Filter by severity
    const critOnly = await listD1AnomalyAlerts(db, { severity: 'critical' })
    expect(critOnly.items.every((a) => a.severity === 'critical')).toBe(true)

    // Filter with limit and offset
    const paginated = await listD1AnomalyAlerts(db, { limit: 1, offset: 0 })
    expect(paginated.items.length).toBe(1)
    expect(paginated.total).toBeGreaterThanOrEqual(2)
  })

  it('creates a new alert once cooldown period expires', async () => {
    // First alert
    const first = await evaluateD1AnomalySignal(
      db,
      ADMIN_CLAIMS,
      {
        dimension: 'tracking',
        metricName: 'cooldown_expiry_metric',
        baselineValue: 50,
        observedValue: 10,
        sampleSize: 100,
        detectedAt: '2026-10-29T10:00:00Z',
        idempotencyKey: 'cd-exp-sig-01'
      },
      { now: () => '2026-10-29T10:00:00Z' }
    )
    expect(first.alertCreated).toBe(true)

    // Signal after 75 minutes (policy cooldown is 60m)
    const afterCooldown = await evaluateD1AnomalySignal(
      db,
      ADMIN_CLAIMS,
      {
        dimension: 'tracking',
        metricName: 'cooldown_expiry_metric',
        baselineValue: 50,
        observedValue: 8,
        sampleSize: 120,
        detectedAt: '2026-10-29T11:15:00Z',
        idempotencyKey: 'cd-exp-sig-02'
      },
      { now: () => '2026-10-29T11:15:00Z' }
    )
    expect(afterCooldown.isAnomaly).toBe(true)
    expect(afterCooldown.alertCreated).toBe(true)
    expect(afterCooldown.alert?.id).not.toBe(first.alert?.id)
  })

  it('handles full HTTP API workflow (evaluate, list, detail, review, policies)', async () => {
    const sessionConfig = { password: 'secret-password-32-chars-long-xxx', maxAgeSeconds: 3600 }

    // 1. POST /evaluate via HTTP
    const evalReq = new Request('https://neteco.es/api/admin/observability/anomalies/evaluate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        dimension: 'data',
        metricName: 'http_test_data_lag',
        baselineValue: 100,
        observedValue: 20, // 80% drop -> critical
        sampleSize: 50,
        detectedAt: NOW,
        idempotencyKey: 'http-eval-sig-01'
      })
    })
    const evalRes = await handleAnomalyDetectionHttp(evalReq, {
      database: db,
      sessionCookieConfiguration: sessionConfig,
      claimsResolver: async () => ADMIN_CLAIMS
    })
    expect(evalRes?.status).toBe(200)
    const evalJson = (await evalRes!.json()) as { alertCreated: boolean; alert: { id: string } }
    expect(evalJson.alertCreated).toBe(true)
    const alertId = evalJson.alert.id

    // 2. GET /alerts via HTTP
    const listReq = new Request('https://neteco.es/api/admin/observability/anomalies/alerts?dimension=data')
    const listRes = await handleAnomalyDetectionHttp(listReq, {
      database: db,
      sessionCookieConfiguration: sessionConfig,
      claimsResolver: async () => ADMIN_CLAIMS
    })
    expect(listRes?.status).toBe(200)
    const listJson = (await listRes!.json()) as { total: number }
    expect(listJson.total).toBeGreaterThanOrEqual(1)

    // 3. GET /alerts/:id via HTTP
    const detailReq = new Request(`https://neteco.es/api/admin/observability/anomalies/alerts/${alertId}`)
    const detailRes = await handleAnomalyDetectionHttp(detailReq, {
      database: db,
      sessionCookieConfiguration: sessionConfig,
      claimsResolver: async () => ADMIN_CLAIMS
    })
    expect(detailRes?.status).toBe(200)
    const detailJson = (await detailRes!.json()) as { alert: { id: string }; runbook: { dimension: string } }
    expect(detailJson.alert.id).toBe(alertId)
    expect(detailJson.runbook.dimension).toBe('data')

    // 4. POST /alerts/:id/review via HTTP
    const revReq = new Request(`https://neteco.es/api/admin/observability/anomalies/alerts/${alertId}/review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'acknowledge',
        notes: 'Confirmado por ingeniero de guardia a través de HTTP API.',
        expectedVersion: 1,
        idempotencyKey: 'http-rev-01'
      })
    })
    const revRes = await handleAnomalyDetectionHttp(revReq, {
      database: db,
      sessionCookieConfiguration: sessionConfig,
      claimsResolver: async () => ADMIN_CLAIMS
    })
    expect(revRes?.status).toBe(200)
    const revJson = (await revRes!.json()) as { alert: { status: string } }
    expect(revJson.alert.status).toBe('acknowledged')

    // 5. GET /policies via HTTP
    const polReq = new Request('https://neteco.es/api/admin/observability/anomalies/policies')
    const polRes = await handleAnomalyDetectionHttp(polReq, {
      database: db,
      sessionCookieConfiguration: sessionConfig,
      claimsResolver: async () => ADMIN_CLAIMS
    })
    expect(polRes?.status).toBe(200)
    const polJson = (await polRes!.json()) as { policies: unknown[] }
    expect(polJson.policies.length).toBe(5)
  })

  it('rejects cross-site CSRF requests on mutating HTTP methods', async () => {
    const sessionConfig = { password: 'secret-password-32-chars-long-xxx', maxAgeSeconds: 3600 }
    const csrfReq = new Request('https://neteco.es/api/admin/observability/anomalies/evaluate', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'https://evil-site.com',
        'sec-fetch-site': 'cross-site'
      },
      body: JSON.stringify({
        dimension: 'conversion',
        metricName: 'csrf_test',
        baselineValue: 10,
        observedValue: 2,
        sampleSize: 50,
        detectedAt: NOW,
        idempotencyKey: 'csrf-key-anom-01'
      })
    })

    const res = await handleAnomalyDetectionHttp(csrfReq, {
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

import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import { computeCarrierScorecard, recordCarrierPerformanceEvent } from '../../workers/fulfillment/carrier-scorecard'
import {
  handleCarrierScorecardHttp,
  ownsCarrierScorecardNamespace
} from '../../workers/fulfillment/carrier-scorecard-http'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import { testNow } from '../support/deterministic'

const connections: DatabaseSync[] = []
afterEach(() => {
  for (const db of connections.splice(0)) db.close()
  vi.useRealTimers()
})

const utc = (offset = 0) => new Date(testNow() + offset).toISOString().replace(/\.\d{3}Z$/, 'Z')

const ADMIN_ID = '10000000-0000-4000-8000-000000000043'
const SESSION_ID = '20000000-0000-4000-8000-000000000043'

async function createScorecardFixture() {
  const sqlite = await openMigratedDatabase()
  connections.push(sqlite)

  const migrationSql = await readFile(
    new URL('../../db/d1/migrations/0097_carrier_resilience.sql', import.meta.url),
    'utf8'
  )
  sqlite.exec(migrationSql)

  const now = '2026-10-29T10:00:00Z'
  vi.setSystemTime(new Date(now))
  // Admin permissions setup
  sqlite.exec(`
    INSERT INTO roles VALUES('administrator', 'Administrator', 'Synthetic');
    INSERT INTO permissions VALUES('administration.manage', 'administration', 'manage', 'Synthetic');
    INSERT INTO role_permissions VALUES('administrator', 'administration.manage');
    INSERT INTO identities(id, email, password_hash, email_verified_at, status, created_at, updated_at)
      VALUES('${ADMIN_ID}', 'admin@example.invalid', 'synthetic', '${now}', 'active', '${now}', '${now}');
    INSERT INTO auth_sessions(id, identity_id, session_version, mfa_verified, created_at, expires_at)
      VALUES('${SESSION_ID}', '${ADMIN_ID}', 1, 1, '${now}', '${utc(3600000)}');
    INSERT INTO identity_roles(identity_id, role_code, granted_at) VALUES('${ADMIN_ID}', 'administrator', '${now}');
  `)

  const database = d1OverSqlite(sqlite)
  return { sqlite, database }
}

describe('SHP-021 Carrier Scorecard Domain & Calculations', () => {
  it('returns empty scorecard with zero division guards when no shipments exist in period', async () => {
    const { database } = await createScorecardFixture()

    const report = await computeCarrierScorecard(database, {
      from: '2026-10-01T00:00:00Z',
      to: '2026-10-29T23:59:59Z'
    })

    expect(report.summary.totalShipments).toBe(0)
    expect(report.summary.deliveredShipments).toBe(0)
    expect(report.summary.onTimeRate).toBeNull()
    expect(report.summary.firstAttemptRate).toBeNull()
    expect(report.summary.damageRate).toBeNull()
    expect(report.summary.incidentRate).toBeNull()
    expect(report.summary.averageCostCents).toBe(0)
    expect(report.summary.averageResolutionTimeHours).toBeNull()
    expect(report.summary.hasSufficientSample).toBe(false)
    expect(report.carriers).toEqual([])
  })

  it('calculates on-time, first-attempt, damage, incident, cost and resolution metrics accurately', async () => {
    const { database, sqlite } = await createScorecardFixture()

    // Insert 12 shipments for correos_express to exceed sample threshold (10)
    // 10 delivered on-time, 2 delivered late (onTimeRate = 10/12 = 83.3%)
    // 9 first-attempt success (firstAttemptRate = 9/12 = 75.0%)
    // 1 damaged (damageRate = 1/12 = 8.3%)
    // 2 incidents (incidentRate = 2/12 = 16.7%)
    // costs: 12 * 650 = 7800 -> averageCostCents = 650
    // resolution times: 2 incidents resolved (7200s and 14400s -> avg 10800s = 3.0h)
    for (let i = 1; i <= 12; i++) {
      const isLate = i > 10
      const isDamaged = i === 1
      const isIncident = i <= 2
      const firstAttempt = i <= 9
      const deliveredAt = isLate ? '2026-10-16T18:00:00Z' : '2026-10-15T14:00:00Z'
      const promisedAt = '2026-10-15T18:00:00Z'

      sqlite.exec(`
        INSERT INTO carrier_performance_records(
          id, carrier, order_id, tracking_number, service_code, dispatched_at, promised_delivery_at,
          first_delivery_attempt_at, delivered_at, status, is_delivered, is_on_time, is_first_attempt_success,
          has_damage, has_incident, incident_kind, incident_opened_at, incident_resolved_at, resolution_time_seconds,
          cost_cents, created_at, updated_at
        ) VALUES (
          '00000000-0000-4000-8000-${String(i).padStart(12, '0')}', 'correos_express', NULL,
          'TRACK-${i}', 'EXP-24', '2026-10-14T10:00:00Z', '${promisedAt}',
          '${firstAttempt ? '2026-10-15T11:00:00Z' : '2026-10-15T16:00:00Z'}',
          '${deliveredAt}', 'delivered', 1, ${isLate ? 0 : 1}, ${firstAttempt ? 1 : 0},
          ${isDamaged ? 1 : 0}, ${isIncident ? 1 : 0}, ${isIncident ? "'damage'" : 'NULL'},
          ${isIncident ? "'2026-10-15T11:00:00Z'" : 'NULL'},
          ${isIncident ? (i === 1 ? "'2026-10-15T13:00:00Z'" : "'2026-10-15T15:00:00Z'") : 'NULL'},
          ${isIncident ? (i === 1 ? 7200 : 14400) : 'NULL'},
          650, '2026-10-14T10:00:00Z', '2026-10-14T10:00:00Z'
        );
      `)
    }

    const report = await computeCarrierScorecard(database, {
      from: '2026-10-01T00:00:00Z',
      to: '2026-10-29T23:59:59Z',
      minSampleThreshold: 10
    })

    expect(report.summary.totalShipments).toBe(12)
    expect(report.summary.deliveredShipments).toBe(12)
    expect(report.summary.hasSufficientSample).toBe(true)

    // on-time: 10/12 ≈ 0.8333
    expect(report.summary.onTimeRate).toBeCloseTo(10 / 12, 3)
    // first attempt: 9/12 = 0.75
    expect(report.summary.firstAttemptRate).toBeCloseTo(9 / 12, 3)
    // damage: 1/12 ≈ 0.0833
    expect(report.summary.damageRate).toBeCloseTo(1 / 12, 3)
    // incidents: 2/12 ≈ 0.1667
    expect(report.summary.incidentRate).toBeCloseTo(2 / 12, 3)
    // average cost: 650 cents
    expect(report.summary.averageCostCents).toBe(650)
    // average resolution time: (7200 + 14400) / 2 = 10800s = 3.0h
    expect(report.summary.averageResolutionTimeHours).toBe(3.0)

    expect(report.carriers).toHaveLength(1)
    expect(report.carriers[0]!.carrier).toBe('correos_express')
    expect(report.carriers[0]!.hasSufficientSample).toBe(true)
  })

  it('marks low sample size (< 10) appropriately while still computing rates', async () => {
    const { database, sqlite } = await createScorecardFixture()

    // Insert only 3 shipments
    for (let i = 1; i <= 3; i++) {
      sqlite.exec(`
        INSERT INTO carrier_performance_records(
          id, carrier, order_id, tracking_number, service_code, dispatched_at, promised_delivery_at,
          first_delivery_attempt_at, delivered_at, status, is_delivered, is_on_time, is_first_attempt_success,
          has_damage, has_incident, cost_cents, created_at, updated_at
        ) VALUES (
          '00000000-0000-4000-8000-00000000010${i}', 'gls', NULL,
          'GLS-TRACK-${i}', 'PARCEL', '2026-10-20T10:00:00Z', '2026-10-21T18:00:00Z',
          '2026-10-21T12:00:00Z', '2026-10-21T12:00:00Z', 'delivered', 1, 1, 1, 0, 0, 700,
          '2026-10-20T10:00:00Z', '2026-10-20T10:00:00Z'
        );
      `)
    }

    const report = await computeCarrierScorecard(database, {
      from: '2026-10-01T00:00:00Z',
      to: '2026-10-29T23:59:59Z',
      minSampleThreshold: 10
    })

    expect(report.summary.totalShipments).toBe(3)
    expect(report.summary.hasSufficientSample).toBe(false)
    expect(report.carriers[0]!.hasSufficientSample).toBe(false)
  })

  it('filters strictly by period date range', async () => {
    const { database, sqlite } = await createScorecardFixture()

    // 1 in September, 1 in October, 1 in November
    sqlite.exec(`
      INSERT INTO carrier_performance_records(
        id, carrier, order_id, tracking_number, service_code, dispatched_at, promised_delivery_at,
        delivered_at, status, is_delivered, is_on_time, is_first_attempt_success, has_damage, has_incident,
        cost_cents, created_at, updated_at
      ) VALUES
      ('00000000-0000-4000-8000-000000000201', 'gls', NULL, 'T-SEP', 'PARCEL',
        '2026-09-25T10:00:00Z', '2026-09-26T18:00:00Z', '2026-09-26T12:00:00Z', 'delivered', 1, 1, 1, 0, 0, 700, '2026-09-25T10:00:00Z', '2026-09-25T10:00:00Z'),
      ('00000000-0000-4000-8000-000000000202', 'gls', NULL, 'T-OCT', 'PARCEL',
        '2026-10-15T10:00:00Z', '2026-10-16T18:00:00Z', '2026-10-16T12:00:00Z', 'delivered', 1, 1, 1, 0, 0, 700, '2026-10-15T10:00:00Z', '2026-10-15T10:00:00Z'),
      ('00000000-0000-4000-8000-000000000203', 'gls', NULL, 'T-NOV', 'PARCEL',
        '2026-11-05T10:00:00Z', '2026-11-06T18:00:00Z', '2026-11-06T12:00:00Z', 'delivered', 1, 1, 1, 0, 0, 700, '2026-11-05T10:00:00Z', '2026-11-05T10:00:00Z');
    `)

    const report = await computeCarrierScorecard(database, {
      from: '2026-10-01T00:00:00Z',
      to: '2026-10-31T23:59:59Z',
      now: '2026-10-29T10:01:00Z'
    })

    expect(report.summary.totalShipments).toBe(1)
  })

  it('includes circuit breaker status for each carrier', async () => {
    const { database, sqlite } = await createScorecardFixture()
    const now = '2026-10-29T10:00:00Z'

    // Seed open circuit breaker for correos_express
    sqlite.exec(`
      INSERT INTO carrier_circuit_breakers(carrier, state, failure_count, consecutive_failures, opened_at, updated_at)
      VALUES('correos_express', 'open', 5, 5, '${now}', '${now}');
      INSERT INTO carrier_performance_records(
        id, carrier, order_id, tracking_number, service_code, dispatched_at, promised_delivery_at,
        delivered_at, status, is_delivered, is_on_time, is_first_attempt_success, has_damage, has_incident,
        cost_cents, created_at, updated_at
      ) VALUES
      ('00000000-0000-4000-8000-000000000301', 'correos_express', NULL, 'T-1', 'EXP',
        '${now}', '${now}', '${now}', 'delivered', 1, 1, 1, 0, 0, 600, '${now}', '${now}');
    `)

    const report = await computeCarrierScorecard(database, {
      from: '2026-10-01T00:00:00Z',
      to: '2026-10-31T23:59:59Z',
      now: '2026-10-29T10:01:00Z'
    })

    const carrierItem = report.carriers.find((c) => c.carrier === 'correos_express')
    expect(carrierItem).toBeDefined()
    expect(carrierItem!.circuitBreaker).toBeDefined()
    expect(carrierItem!.circuitBreaker!.state).toBe('open')
    expect(carrierItem!.circuitBreaker!.consecutiveFailures).toBe(5)
  })

  it('records carrier performance event with automatic on-time calculation', async () => {
    const { database } = await createScorecardFixture()
    await recordCarrierPerformanceEvent(database, {
      carrier: 'seur',
      trackingNumber: 'SEUR-999',
      serviceCode: 'EXP',
      dispatchedAt: '2026-10-10T10:00:00Z',
      promisedDeliveryAt: '2026-10-11T18:00:00Z',
      deliveredAt: '2026-10-11T14:00:00Z',
      status: 'delivered',
      hasDamage: false,
      hasIncident: false,
      costCents: 620
    })

    const report = await computeCarrierScorecard(database, {
      from: '2026-10-01T00:00:00Z',
      to: '2026-10-31T23:59:59Z',
      carrier: 'seur'
    })

    expect(report.summary.totalShipments).toBe(1)
    expect(report.summary.onTimeRate).toBe(1)
    expect(report.summary.averageCostCents).toBe(620)
  })
})

describe('SHP-021 Admin Carrier Scorecard HTTP Endpoint', () => {
  it('recognizes carrier scorecard namespace', () => {
    expect(ownsCarrierScorecardNamespace('/api/admin/carriers/scorecard')).toBe(true)
    expect(ownsCarrierScorecardNamespace('/api/admin/carrier-scorecard')).toBe(true)
    expect(ownsCarrierScorecardNamespace('/api/admin/other')).toBe(false)
  })

  it('rejects unauthenticated requests with 401', async () => {
    const { database } = await createScorecardFixture()
    const request = new Request('https://admin.example.invalid/api/admin/carriers/scorecard', {
      method: 'GET'
    })

    const response = await handleCarrierScorecardHttp(request, {
      DB: database,
      AUTH_ENABLED: 'true',
      AUTH_ORIGIN: 'https://admin.example.invalid',
      NUXT_SESSION_PASSWORD: 'supersecretpassword12345678901234'
    })

    expect(response).not.toBeNull()
    expect(response!.status).toBe(401)
  })

  it('rejects cross-site CSRF requests with 403', async () => {
    const { database } = await createScorecardFixture()
    const sessionPassword = 'supersecretpassword12345678901234'
    const cookieHeader = await issueD1SessionCookie(
      database,
      { identityId: ADMIN_ID, sessionId: SESSION_ID, sessionVersion: 1 },
      { password: sessionPassword, maxAgeSeconds: 3600 }
    )
    const cookieValue = cookieHeader ? cookieHeader.split(';')[0] : ''

    const request = new Request('https://admin.example.invalid/api/admin/carriers/scorecard', {
      method: 'GET',
      headers: {
        cookie: cookieValue,
        'sec-fetch-site': 'cross-site'
      }
    })

    const response = await handleCarrierScorecardHttp(request, {
      DB: database,
      AUTH_ENABLED: 'true',
      AUTH_ORIGIN: 'https://admin.example.invalid',
      NUXT_SESSION_PASSWORD: sessionPassword
    })

    expect(response).not.toBeNull()
    expect(response!.status).toBe(403)
  })

  it('allows authorized requests with administration.manage and verified MFA returning 200', async () => {
    const { database } = await createScorecardFixture()
    const sessionPassword = 'supersecretpassword12345678901234'
    const cookieHeader = await issueD1SessionCookie(
      database,
      { identityId: ADMIN_ID, sessionId: SESSION_ID, sessionVersion: 1 },
      { password: sessionPassword, maxAgeSeconds: 3600 }
    )
    const cookieValue = cookieHeader ? cookieHeader.split(';')[0] : ''

    const request = new Request('https://admin.example.invalid/api/admin/carriers/scorecard?period=7d', {
      method: 'GET',
      headers: {
        cookie: cookieValue
      }
    })

    const response = await handleCarrierScorecardHttp(request, {
      DB: database,
      AUTH_ENABLED: 'true',
      AUTH_ORIGIN: 'https://admin.example.invalid',
      NUXT_SESSION_PASSWORD: sessionPassword
    })

    expect(response).not.toBeNull()
    expect(response!.status).toBe(200)
    const body = (await response!.json()) as { summary: { totalShipments: number } }
    expect(body.summary).toBeDefined()
  })

  it('rejects authenticated requests lacking administration.manage with 403', async () => {
    const { sqlite, database } = await createScorecardFixture()
    const sessionPassword = 'supersecretpassword12345678901234'
    // Remove administrator role from identity
    sqlite.exec(`DELETE FROM identity_roles WHERE identity_id = '${ADMIN_ID}';`)

    const cookieHeader = await issueD1SessionCookie(
      database,
      { identityId: ADMIN_ID, sessionId: SESSION_ID, sessionVersion: 1 },
      { password: sessionPassword, maxAgeSeconds: 3600 }
    )
    const cookieValue = cookieHeader ? cookieHeader.split(';')[0] : ''

    const request = new Request('https://admin.example.invalid/api/admin/carriers/scorecard', {
      method: 'GET',
      headers: {
        cookie: cookieValue
      }
    })

    const response = await handleCarrierScorecardHttp(request, {
      DB: database,
      AUTH_ENABLED: 'true',
      AUTH_ORIGIN: 'https://admin.example.invalid',
      NUXT_SESSION_PASSWORD: sessionPassword
    })

    expect(response).not.toBeNull()
    expect(response!.status).toBe(403)
  })
})

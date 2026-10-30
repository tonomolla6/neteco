import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import {
  handleSendTimeOptimizationHttp,
  ownsSendTimeOptimizationNamespace,
  type SendTimeOptimizationHttpDependencies
} from '../../workers/communications/send-time-optimization-http'

const NOW = '2026-10-29T10:00:00Z' // Thursday 10:00 UTC (inside 09:00 - 18:00 window)
const ADMIN_ID = '10000000-0000-4000-8000-000000000001'
const NOPERMS_ID = '10000000-0000-4000-8000-000000000002'
const NOMFA_ID = '10000000-0000-4000-8000-000000000003'

const CUSTOMER_CONSENTED_ID = '30000000-0000-4000-8000-000000000001'
const CUSTOMER_UNCONSENTED_ID = '30000000-0000-4000-8000-000000000002'

const session = (n: number) => `20000000-0000-4000-8000-00000000000${n}`
const ADMIN = { identityId: ADMIN_ID, sessionId: session(1), sessionVersion: 1 }
const NOPERMS = { identityId: NOPERMS_ID, sessionId: session(2), sessionVersion: 1 }
const NOMFA = { identityId: NOMFA_ID, sessionId: session(3), sessionVersion: 1 }

const BASE = 'https://shop.example/api/admin/marketing/send-time'
let counter = 0
const uuid = () => `b0000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`

async function setupTestDb(): Promise<{ sqlite: DatabaseSync; db: D1Database }> {
  const sqlite = await openMigratedDatabase()
  sqlite.exec(
    await readFile(
      new URL('../../db/d1/migrations/0122_operational_alerts_send_time_warehouse_telemetry.sql', import.meta.url),
      'utf8'
    )
  )

  sqlite.exec(`
    INSERT OR IGNORE INTO roles (code, name, description) VALUES
      ('admin', 'Administración', 'Fixture'),
      ('operator', 'Operador', 'Fixture');
    INSERT OR IGNORE INTO permissions (code, resource, action, description) VALUES
      ('administration.manage', 'administration', 'manage', 'Fixture');
    INSERT OR IGNORE INTO role_permissions (role_code, permission_code) VALUES
      ('admin', 'administration.manage');

    INSERT OR IGNORE INTO customers (id, name, status, created_at, updated_at) VALUES
      ('${CUSTOMER_CONSENTED_ID}', 'Química Industrial SL', 'active', '${NOW}', '${NOW}'),
      ('${CUSTOMER_UNCONSENTED_ID}', 'Lavandería Rápida SL', 'active', '${NOW}', '${NOW}');

    INSERT OR IGNORE INTO identities (id, customer_id, email, password_hash, status, email_verified_at, created_at, updated_at) VALUES
      ('${ADMIN_ID}', NULL, 'admin@neteco.test', 'hash', 'active', '${NOW}', '${NOW}', '${NOW}'),
      ('${NOPERMS_ID}', NULL, 'operator@neteco.test', 'hash', 'active', '${NOW}', '${NOW}', '${NOW}'),
      ('${NOMFA_ID}', NULL, 'nomfa@neteco.test', 'hash', 'active', '${NOW}', '${NOW}', '${NOW}'),
      ('10000000-0000-4000-8000-000000000011', '${CUSTOMER_CONSENTED_ID}', 'consented@neteco.test', 'hash', 'active', '${NOW}', '${NOW}', '${NOW}'),
      ('10000000-0000-4000-8000-000000000012', '${CUSTOMER_UNCONSENTED_ID}', 'unconsented@neteco.test', 'hash', 'active', '${NOW}', '${NOW}', '${NOW}');

    INSERT OR IGNORE INTO identity_roles (identity_id, role_code, granted_at) VALUES
      ('${ADMIN_ID}', 'admin', '${NOW}'),
      ('${NOMFA_ID}', 'admin', '${NOW}');

    INSERT OR IGNORE INTO auth_sessions (id, identity_id, session_version, mfa_verified, created_at, expires_at) VALUES
      ('${ADMIN.sessionId}', '${ADMIN_ID}', 1, 1, '${NOW}', '2026-11-29T14:00:00Z'),
      ('${NOPERMS.sessionId}', '${NOPERMS_ID}', 1, 1, '${NOW}', '2026-11-29T14:00:00Z'),
      ('${NOMFA.sessionId}', '${NOMFA_ID}', 1, 0, '${NOW}', '2026-11-29T14:00:00Z');

    INSERT OR IGNORE INTO newsletter_subscriptions (
      id, email_normalized, email_hash, purpose, channel, status,
      consent_text, consent_version, consent_source, request_id, request_key,
      requested_at, confirmation_expires_at, confirmed_at
    ) VALUES (
      'sub-00000000-0000-4000-8000-000000000001',
      'consented@neteco.test',
      'e100000000000000000000000000000000000000000000000000000000000001',
      'newsletter', 'email', 'confirmed',
      'Acepto novedades de productos químicos y promociones', 'v1', 'web',
      'req-1', 'key-1', 1700000000, 1800000000, 1700000100
    );
  `)

  return { sqlite, db: d1OverSqlite(sqlite) }
}

const claimsResolver = async (request: Request) => {
  switch (request.headers.get('x-test-session')) {
    case 'admin':
      return ADMIN
    case 'noperms':
      return NOPERMS
    case 'nomfa':
      return NOMFA
    default:
      return null
  }
}

function req(path: string, options: { method?: string; body?: unknown; session?: string; origin?: string } = {}) {
  const headers = new Headers({
    'content-type': 'application/json; charset=utf-8'
  })
  if (options.session) headers.set('x-test-session', options.session)
  if (options.origin) headers.set('origin', options.origin)
  return new Request(path, {
    method: options.method ?? 'GET',
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined
  })
}

describe('COM-020 Send-Time Optimization HTTP', () => {
  let sqlite: DatabaseSync
  let deps: SendTimeOptimizationHttpDependencies

  beforeEach(async () => {
    const fixture = await setupTestDb()
    sqlite = fixture.sqlite
    deps = {
      database: fixture.db,
      sessionCookieConfiguration: { password: 'x'.repeat(40), maxAgeSeconds: 3600 },
      origin: 'https://shop.example',
      now: () => NOW,
      claimsResolver
    }
  })

  afterEach(() => {
    sqlite?.close()
  })

  it('owns only its namespace', () => {
    expect(ownsSendTimeOptimizationNamespace('/api/admin/marketing/send-time')).toBe(true)
    expect(ownsSendTimeOptimizationNamespace('/api/admin/marketing/send-time/policy')).toBe(true)
    expect(ownsSendTimeOptimizationNamespace('/api/admin/marketing/send-time/evaluate')).toBe(true)
    expect(ownsSendTimeOptimizationNamespace('/api/admin/marketing/send-time/decisions')).toBe(true)
    expect(ownsSendTimeOptimizationNamespace('/api/admin/marketing/other')).toBe(false)
  })

  it('enforces authentication and permissions', async () => {
    const anon = await handleSendTimeOptimizationHttp(req(`${BASE}/policy`), deps)
    expect(anon?.status).toBe(401)
    const noPerms = await handleSendTimeOptimizationHttp(req(`${BASE}/policy`, { session: 'noperms' }), deps)
    expect(noPerms?.status).toBe(403)
  })

  it('reads and updates policy with CAS expectedVersion', async () => {
    const getRes = await handleSendTimeOptimizationHttp(req(`${BASE}/policy`, { session: 'admin' }), deps)
    expect(getRes?.status).toBe(200)
    const getData = await getRes?.json()
    expect(getData.policy.id).toBe('global')
    expect(getData.policy.version).toBe(1)
    expect(getData.policy.holdoutRateBasisPoints).toBe(1000)

    // Update policy
    const putRes = await handleSendTimeOptimizationHttp(
      req(`${BASE}/policy`, {
        method: 'PUT',
        session: 'admin',
        origin: 'https://shop.example',
        body: {
          commandId: uuid(),
          idempotencyKey: 'cmd-policy-update-1',
          expectedVersion: 1,
          holdoutRateBasisPoints: 500, // 5%
          minHoursBetweenMarketing: 24,
          maxWeeklyMarketingSends: 2,
          allowedWindowStartHour: 9,
          allowedWindowEndHour: 19
        }
      }),
      deps
    )
    expect(putRes?.status).toBe(200)
    const putData = await putRes?.json()
    expect(putData.policy.version).toBe(2)
    expect(putData.policy.holdoutRateBasisPoints).toBe(500)

    // Stale CAS fails with 409
    const staleRes = await handleSendTimeOptimizationHttp(
      req(`${BASE}/policy`, {
        method: 'PUT',
        session: 'admin',
        origin: 'https://shop.example',
        body: {
          commandId: uuid(),
          idempotencyKey: 'cmd-policy-update-2',
          expectedVersion: 1, // Stale!
          holdoutRateBasisPoints: 600,
          minHoursBetweenMarketing: 24,
          maxWeeklyMarketingSends: 2,
          allowedWindowStartHour: 9,
          allowedWindowEndHour: 19
        }
      }),
      deps
    )
    expect(staleRes?.status).toBe(409)
  })

  it('OPERATIONAL rule: immediately sends operational messages without delay or marketing caps', async () => {
    const res = await handleSendTimeOptimizationHttp(
      req(`${BASE}/evaluate`, {
        method: 'POST',
        session: 'admin',
        origin: 'https://shop.example',
        body: {
          commandId: uuid(),
          idempotencyKey: 'eval-op-1',
          messageId: 'msg-factura-001',
          customerId: CUSTOMER_UNCONSENTED_ID, // Even unconsented customer gets operational messages!
          category: 'operational',
          channel: 'email'
        }
      }),
      deps
    )
    expect(res?.status).toBe(200)
    const data = await res?.json()
    expect(data.decision.status).toBe('sent_immediate')
    expect(data.decision.holdoutApplied).toBe(false)
    expect(data.decision.scheduledFor).toBe(NOW)
  })

  it('MARKETING rule: suppresses marketing messages when customer has NO valid consent', async () => {
    const res = await handleSendTimeOptimizationHttp(
      req(`${BASE}/evaluate`, {
        method: 'POST',
        session: 'admin',
        origin: 'https://shop.example',
        body: {
          commandId: uuid(),
          idempotencyKey: 'eval-mkt-no-consent-1',
          messageId: 'msg-promo-spring-01',
          customerId: CUSTOMER_UNCONSENTED_ID,
          category: 'marketing',
          channel: 'email',
          campaignCode: 'spring_sale'
        }
      }),
      deps
    )
    expect(res?.status).toBe(200)
    const data = await res?.json()
    expect(data.decision.status).toBe('suppressed_no_consent')
    expect(data.decision.consentVerified).toBe(false)
  })

  it('evaluates consented marketing message and lists decisions history', async () => {
    const res = await handleSendTimeOptimizationHttp(
      req(`${BASE}/evaluate`, {
        method: 'POST',
        session: 'admin',
        origin: 'https://shop.example',
        body: {
          commandId: uuid(),
          idempotencyKey: 'eval-mkt-consented-1',
          messageId: 'msg-promo-spring-02',
          customerId: CUSTOMER_CONSENTED_ID,
          category: 'marketing',
          channel: 'email',
          campaignCode: 'chemicals_cleaning_2026'
        }
      }),
      deps
    )
    expect(res?.status).toBe(200)
    const data = await res?.json()
    expect(data.decision.consentVerified).toBe(true)
    expect(['sent_immediate', 'scheduled_optimized', 'held_out']).toContain(data.decision.status)

    // List decisions
    const listRes = await handleSendTimeOptimizationHttp(
      req(`${BASE}/decisions?customerId=${CUSTOMER_CONSENTED_ID}`, { session: 'admin' }),
      deps
    )
    expect(listRes?.status).toBe(200)
    const listData = await listRes?.json()
    expect(listData.items.length).toBeGreaterThanOrEqual(1)
    expect(listData.items[0].customerId).toBe(CUSTOMER_CONSENTED_ID)
  })
})

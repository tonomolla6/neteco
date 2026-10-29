import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { d1OverSqlite, openAccountSecurityDatabase } from '../support/d1-sqlite'
import {
  handleExperimentsHttp,
  ownsExperimentsNamespace,
  type ExperimentsHttpDependencies
} from '../../workers/analytics/experiments-http'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'

const NOW = '2026-10-29T12:00:00Z'
const PAST_START = '2026-01-01T00:00:00Z'

const ADMIN_ID = '10000000-0000-4000-8000-000000000001'
const ADMIN_SESSION = '20000000-0000-4000-8000-000000000001'
const NON_ADMIN_ID = '10000000-0000-4000-8000-000000000002'
const NON_ADMIN_SESSION = '20000000-0000-4000-8000-000000000002'

const SESSION_PASSWORD = 'a'.repeat(32)
const SESSION_CONFIG = { password: SESSION_PASSWORD, maxAgeSeconds: 3600 }

async function setupTestDatabase(): Promise<DatabaseSync> {
  const sqlite = await openAccountSecurityDatabase()

  // Setup permissions
  sqlite.exec(`
    INSERT OR IGNORE INTO roles (code, name, description) VALUES
      ('admin', 'Administrador', 'Fixture admin'),
      ('customer', 'Cliente', 'Fixture customer');
    INSERT OR IGNORE INTO permissions (code, resource, action, description) VALUES
      ('administration.manage', 'administration', 'manage', 'Fixture admin access'),
      ('experiments.manage', 'experiments', 'manage', 'Fixture experiment management');
    INSERT OR IGNORE INTO role_permissions (role_code, permission_code) VALUES
      ('admin', 'administration.manage'),
      ('admin', 'experiments.manage');
  `)

  // Admin identity
  sqlite.exec(`
    INSERT OR REPLACE INTO identities (id, email, password_hash, email_verified_at, status, session_version, created_at, updated_at)
    VALUES ('${ADMIN_ID}', 'admin.ab@neteco.es', 'fixture_hash', '${PAST_START}', 'active', 1, '${PAST_START}', '${PAST_START}');
    INSERT OR REPLACE INTO identity_roles (identity_id, role_code, granted_at)
    VALUES ('${ADMIN_ID}', 'admin', '${PAST_START}');
    INSERT OR REPLACE INTO auth_sessions (id, identity_id, session_version, mfa_verified, created_at, expires_at)
    VALUES ('${ADMIN_SESSION}', '${ADMIN_ID}', 1, 1, '${PAST_START}', '2026-10-30T12:00:00Z');
  `)

  // Non-admin identity
  sqlite.exec(`
    INSERT OR REPLACE INTO identities (id, email, password_hash, email_verified_at, status, session_version, created_at, updated_at)
    VALUES ('${NON_ADMIN_ID}', 'user@neteco.es', 'fixture_hash', '${PAST_START}', 'active', 1, '${PAST_START}', '${PAST_START}');
    INSERT OR REPLACE INTO identity_roles (identity_id, role_code, granted_at)
    VALUES ('${NON_ADMIN_ID}', 'customer', '${PAST_START}');
    INSERT OR REPLACE INTO auth_sessions (id, identity_id, session_version, mfa_verified, created_at, expires_at)
    VALUES ('${NON_ADMIN_SESSION}', '${NON_ADMIN_ID}', 1, 0, '${PAST_START}', '2026-10-30T12:00:00Z');
  `)

  return sqlite
}

describe('Experiments HTTP Gateway', () => {
  let sqlite: DatabaseSync
  let deps: ExperimentsHttpDependencies

  beforeEach(async () => {
    sqlite = await setupTestDatabase()
    deps = {
      database: d1OverSqlite(sqlite),
      sessionCookieConfiguration: SESSION_CONFIG,
      origin: 'http://localhost:3000',
      now: () => NOW
    }
  })

  afterEach(() => {
    sqlite?.close()
  })

  async function makeAdminCookie(): Promise<string> {
    const cookie = await issueD1SessionCookie(
      deps.database,
      { identityId: ADMIN_ID, sessionId: ADMIN_SESSION, sessionVersion: 1 },
      SESSION_CONFIG
    )
    return cookie ?? ''
  }

  async function makeNonAdminCookie(): Promise<string> {
    const cookie = await issueD1SessionCookie(
      deps.database,
      { identityId: NON_ADMIN_ID, sessionId: NON_ADMIN_SESSION, sessionVersion: 1 },
      SESSION_CONFIG
    )
    return cookie ?? ''
  }

  it('ownsExperimentsNamespace correctly matches routes', () => {
    expect(ownsExperimentsNamespace('/api/admin/experiments')).toBe(true)
    expect(ownsExperimentsNamespace('/api/admin/experiments/123/start')).toBe(true)
    expect(ownsExperimentsNamespace('/api/experiments/assign')).toBe(true)
    expect(ownsExperimentsNamespace('/api/experiments/events')).toBe(true)
    expect(ownsExperimentsNamespace('/api/admin/other')).toBe(false)
  })

  it('blocks unauthenticated requests to admin routes', async () => {
    const req = new Request('http://localhost:3000/api/admin/experiments', {
      method: 'GET'
    })
    const res = await handleExperimentsHttp(req, deps)
    expect(res?.status).toBe(401)
  })

  it('blocks non-admin users from admin routes', async () => {
    const cookie = await makeNonAdminCookie()
    const req = new Request('http://localhost:3000/api/admin/experiments', {
      method: 'GET',
      headers: { cookie }
    })
    const res = await handleExperimentsHttp(req, deps)
    expect(res?.status).toBe(403)
  })

  it('creates and lists experiments via admin endpoints', async () => {
    const cookie = await makeAdminCookie()
    const createReq = new Request('http://localhost:3000/api/admin/experiments', {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/json',
        'idempotency-key': 'http-cmd-create-1'
      },
      body: JSON.stringify({
        key: 'http-banner-test',
        name: 'Test de banner HTTP',
        hypothesis: 'Banner superior genera 15% más clicks en productos con stock',
        experimentType: 'ab_test',
        ownerEmail: 'admin.ab@neteco.es',
        targetSurface: 'homepage_hero',
        targetSegment: 'all',
        primaryMetric: 'click_through_rate',
        guardrails: { cwvLcpMaxMs: 2500 },
        trafficAllocationPercent: 100,
        minSampleSize: 50,
        minDurationDays: 7,
        variants: [
          { variantKey: 'control', name: 'Control', isControl: true, weight: 50 },
          { variantKey: 'treatment', name: 'Tratamiento', weight: 50 }
        ]
      })
    })

    const createRes = await handleExperimentsHttp(createReq, deps)
    expect(createRes?.status).toBe(201)
    const createdData = (await createRes?.json()) as { experimentId: string; key: string }
    expect(createdData.experimentId).toBeDefined()

    // List experiments
    const listReq = new Request('http://localhost:3000/api/admin/experiments', {
      method: 'GET',
      headers: { cookie }
    })
    const listRes = await handleExperimentsHttp(listReq, deps)
    expect(listRes?.status).toBe(200)
    const listData = (await listRes?.json()) as { experiments: Array<{ key: string }> }
    expect(listData.experiments).toHaveLength(1)
    expect(listData.experiments[0]!.key).toBe('http-banner-test')
  })

  it('allows public assignment and event tracking', async () => {
    const cookie = await makeAdminCookie()
    // 1. Create and start experiment
    const createReq = new Request('http://localhost:3000/api/admin/experiments', {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/json',
        'idempotency-key': 'http-cmd-pub-1'
      },
      body: JSON.stringify({
        key: 'public-nav-test',
        name: 'Public Nav Test',
        hypothesis: 'Nueva barra de navegación rápida incrementa add-to-cart',
        experimentType: 'ab_test',
        ownerEmail: 'admin.ab@neteco.es',
        targetSurface: 'category_banner',
        targetSegment: 'all',
        primaryMetric: 'conversion_rate',
        trafficAllocationPercent: 100,
        minSampleSize: 20,
        minDurationDays: 7,
        variants: [
          { variantKey: 'control', name: 'Control', isControl: true, weight: 50 },
          { variantKey: 'sticky_bar', name: 'Sticky Bar', weight: 50 }
        ]
      })
    })
    const createRes = await handleExperimentsHttp(createReq, deps)
    const { experimentId } = (await createRes?.json()) as { experimentId: string }

    const startReq = new Request(`http://localhost:3000/api/admin/experiments/${experimentId}/start`, {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/json',
        'idempotency-key': 'http-cmd-start-pub'
      },
      body: JSON.stringify({ expectedVersion: 1 })
    })
    await handleExperimentsHttp(startReq, deps)

    // 2. Public assignment without cookie
    const assignReq = new Request('http://localhost:3000/api/experiments/assign', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        experimentKey: 'public-nav-test',
        unitType: 'visitor_id',
        unitId: 'visitor-public-9999'
      })
    })
    const assignRes = await handleExperimentsHttp(assignReq, deps)
    expect(assignRes?.status).toBe(200)
    const assignData = (await assignRes?.json()) as { variantKey: string; isAssigned: boolean }
    expect(assignData.isAssigned).toBe(true)
    expect(['control', 'sticky_bar']).toContain(assignData.variantKey)

    // 3. Public event tracking
    const eventReq = new Request('http://localhost:3000/api/experiments/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        experimentKey: 'public-nav-test',
        variantKey: assignData.variantKey,
        unitType: 'visitor_id',
        unitId: 'visitor-public-9999',
        eventType: 'conversion',
        eventValue: 2450
      })
    })
    const eventRes = await handleExperimentsHttp(eventReq, deps)
    expect(eventRes?.status).toBe(200)
    const eventData = (await eventRes?.json()) as { success: boolean }
    expect(eventData.success).toBe(true)
  })
})

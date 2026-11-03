import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import { handleCustomerRiskScoringHttp } from '../../workers/crm/risk-scoring-http'
import { handleCompanyShippingConditionsHttp } from '../../workers/fulfillment/company-shipping-conditions-http'
import { handleCarrierManifestsHttp } from '../../workers/fulfillment/carrier-manifests-http'
import { calculateCustomerRiskScore } from '../../workers/crm/risk-scoring'
import { setCompanyShippingConditions } from '../../workers/fulfillment/company-shipping-conditions'

vi.mock('../../workers/crm/risk-scoring', () => ({
  calculateCustomerRiskScore: vi.fn(async () => ({})),
  reviewCustomerRiskScore: vi.fn(),
  getCustomerScoringProfile: vi.fn(),
  evaluateScoringModelQuality: vi.fn()
}))
vi.mock('../../workers/fulfillment/company-shipping-conditions', () => ({
  setCompanyShippingConditions: vi.fn(async () => ({})),
  getCompanyShippingConditions: vi.fn(),
  CompanyShippingConditionsError: class extends Error {}
}))
const now = '2026-10-29T12:00:00Z'
const identity = '10000000-0000-4000-8000-0000000000c1'
const session = '20000000-0000-4000-8000-0000000000c1'
const config = { password: 'a'.repeat(64), maxAgeSeconds: 3600 }
let sqlite: DatabaseSync
let database: D1Database
let cookie: string

beforeEach(async () => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  vi.setSystemTime(new Date(now))
  sqlite = await openMigratedDatabase()
  sqlite.exec(`
    INSERT OR IGNORE INTO roles (code, name, description) VALUES ('admin','Admin','x');
    INSERT OR IGNORE INTO permissions (code, resource, action, description) VALUES ('administration.manage','administration','manage','x');
    INSERT OR IGNORE INTO role_permissions (role_code, permission_code) VALUES ('admin','administration.manage');
    INSERT INTO identities (id,email,password_hash,email_verified_at,status,created_at,updated_at)
      VALUES ('${identity}','admin@example.invalid','x','${now}','active','${now}','${now}');
    INSERT INTO auth_sessions (id,identity_id,session_version,mfa_verified,created_at,expires_at)
      VALUES ('${session}','${identity}',1,1,'${now}','2099-01-01T00:00:00Z');
    INSERT INTO identity_roles (identity_id,role_code,granted_at) VALUES ('${identity}','admin','2026-10-28T12:00:00Z');
  `)
  database = d1OverSqlite(sqlite)
  cookie = (await issueD1SessionCookie(
    database,
    { identityId: identity, sessionId: session, sessionVersion: 1 },
    config
  ))!
})
afterEach(() => {
  vi.useRealTimers()
  sqlite.close()
})

describe('SECFIX-3 live administration sessions', () => {
  it('rejects a revoked carrier manifest session before accessing manifests', async () => {
    sqlite.prepare('UPDATE auth_sessions SET revoked_at = ? WHERE id = ?').run(now, session)
    const response = await handleCarrierManifestsHttp(
      new Request('https://shop.invalid/api/admin/carrier-manifests', { headers: { cookie } }),
      { database, sessionCookieConfiguration: config, now: () => now }
    )
    expect([401, 403]).toContain(response?.status)
  })
  it.each(['revoked', 'expired-role'])('rejects risk scoring with %s credentials before any write', async (state) => {
    if (state === 'revoked') sqlite.prepare('UPDATE auth_sessions SET revoked_at = ? WHERE id = ?').run(now, session)
    else sqlite.prepare('UPDATE identity_roles SET expires_at = ? WHERE identity_id = ?').run(now, identity)
    const response = await handleCustomerRiskScoringHttp(
      new Request('https://shop.invalid/api/admin/scoring/profiles/customer/calculate', {
        method: 'POST',
        headers: { cookie },
        body: JSON.stringify({ commercialMetrics: {} })
      }),
      { database, sessionCookieConfiguration: config }
    )
    expect([401, 403]).toContain(response?.status)
    expect(calculateCustomerRiskScore).not.toHaveBeenCalled()
  })

  it.each(['revoked', 'expired-role'])(
    'rejects shipping conditions with %s credentials before any write',
    async (state) => {
      if (state === 'revoked') sqlite.prepare('UPDATE auth_sessions SET revoked_at = ? WHERE id = ?').run(now, session)
      else sqlite.prepare('UPDATE identity_roles SET expires_at = ? WHERE identity_id = ?').run(now, identity)
      const response = await handleCompanyShippingConditionsHttp(
        new Request('https://shop.invalid/api/admin/companies/company/shipping-conditions', {
          method: 'PUT',
          headers: { cookie },
          body: JSON.stringify({
            companyId: 'company',
            allowedMethods: ['pickup'],
            expectedVersion: 0,
            commandId: 'cmd'
          })
        }),
        { database: database as never, sessionCookieConfiguration: config }
      )
      expect([401, 403]).toContain(response?.status)
      expect(setCompanyShippingConditions).not.toHaveBeenCalled()
    }
  )
})

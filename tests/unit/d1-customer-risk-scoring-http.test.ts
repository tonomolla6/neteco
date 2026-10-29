import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { d1OverSqlite, openMigratedDatabase, seedInventoryFixture } from '../support/d1-sqlite'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import { handleCustomerRiskScoringHttp, ownsCustomerRiskScoringNamespace } from '../../workers/crm/risk-scoring-http'

const NOW = '2026-10-29T10:00:00Z'
const CUSTOMER_A = '30000000-0000-4000-8000-000000000001'
const COMPANY_A = '40000000-0000-4000-8000-000000000001'
const ADMIN_IDENTITY = '10000000-0000-4000-8000-000000000099'
const ADMIN_SESSION = '20000000-0000-4000-8000-000000000099'
const config = { password: randomBytes(32).toString('hex'), maxAgeSeconds: 3600 }

describe('CUS-031: Assisted Customer Risk Scoring HTTP API', () => {
  let sqlite: DatabaseSync
  let database: D1Database
  let adminCookie: string

  beforeEach(async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(NOW))
    sqlite = await openMigratedDatabase()
    sqlite.limits.exprDepth = 100
    sqlite.exec(await readFile('db/d1/migrations/0108_b2b_shared_lists_edi_scoring.sql', 'utf8'))
    database = d1OverSqlite(sqlite)
    seedInventoryFixture(sqlite)

    sqlite.prepare('INSERT INTO customers(id, created_at, updated_at) VALUES (?, ?, ?)').run(CUSTOMER_A, NOW, NOW)
    sqlite
      .prepare(
        `INSERT INTO companies(id, customer_id, legal_name, tax_id, country_code, status, created_at, updated_at)
         VALUES (?, ?, 'Comercial Química Levantina S.L.', 'B44332211', 'ES', 'approved', ?, ?)`
      )
      .run(COMPANY_A, CUSTOMER_A, NOW, NOW)

    sqlite
      .prepare(
        `INSERT INTO identities(id, email, password_hash, email_verified_at, status, created_at, updated_at)
         VALUES (?, 'admin@neteco.invalid', 'synthetic', ?, 'active', ?, ?)`
      )
      .run(ADMIN_IDENTITY, NOW, NOW, NOW)
    sqlite
      .prepare(
        `INSERT INTO auth_sessions(id, identity_id, session_version, created_at, expires_at)
         VALUES (?, ?, 1, '2026-10-29T08:00:00Z', '2026-10-29T12:00:00Z')`
      )
      .run(ADMIN_SESSION, ADMIN_IDENTITY)
    sqlite
      .prepare(`INSERT OR IGNORE INTO roles(code, name, description) VALUES ('super-admin', 'Super Admin', 'Test')`)
      .run()
    sqlite
      .prepare(`INSERT INTO identity_roles(identity_id, role_code, granted_at) VALUES (?, 'super-admin', ?)`)
      .run(ADMIN_IDENTITY, NOW)

    adminCookie = (await issueD1SessionCookie(
      database,
      { sessionId: ADMIN_SESSION, identityId: ADMIN_IDENTITY, sessionVersion: 1 },
      config
    ))!
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('reconoce el namespace administrativo de scoring', () => {
    expect(ownsCustomerRiskScoringNamespace('/api/admin/scoring/profiles/123')).toBe(true)
    expect(ownsCustomerRiskScoringNamespace('/api/admin/scoring/quality')).toBe(true)
    expect(ownsCustomerRiskScoringNamespace('/api/admin/orders')).toBe(false)
  })

  it('requiere sesión administrativa retornando 401 para peticiones no autenticadas', async () => {
    const req = new Request(`https://neteco.invalid/api/admin/scoring/profiles/${CUSTOMER_A}`)
    const res = await handleCustomerRiskScoringHttp(req, {
      database,
      sessionCookieConfiguration: config
    })
    expect(res?.status).toBe(401)
  })

  it('rechaza con 403 forbidden a un usuario autenticado sin rol de administración', async () => {
    const USER_ID = '10000000-0000-4000-8000-000000000002'
    const USER_SESS = '20000000-0000-4000-8000-000000000002'
    sqlite
      .prepare(
        `INSERT INTO identities(id, email, password_hash, email_verified_at, status, created_at, updated_at)
         VALUES (?, 'user@neteco.invalid', 'synthetic', ?, 'active', ?, ?)`
      )
      .run(USER_ID, NOW, NOW, NOW)
    sqlite
      .prepare(
        `INSERT INTO auth_sessions(id, identity_id, session_version, created_at, expires_at)
         VALUES (?, ?, 1, '2026-10-29T08:00:00Z', '2026-10-29T12:00:00Z')`
      )
      .run(USER_SESS, USER_ID)
    const userCookie = (await issueD1SessionCookie(
      database,
      { sessionId: USER_SESS, identityId: USER_ID, sessionVersion: 1 },
      config
    ))!

    const req = new Request(`https://neteco.invalid/api/admin/scoring/profiles/${CUSTOMER_A}`, {
      headers: { cookie: userCookie }
    })
    const res = await handleCustomerRiskScoringHttp(req, {
      database,
      sessionCookieConfiguration: config
    })
    expect(res?.status).toBe(403)
  })

  it('calcula, consulta y revisa el scoring asistido vía HTTP', async () => {
    // 1. Calculate
    const calcReq = new Request(`https://neteco.invalid/api/admin/scoring/profiles/${CUSTOMER_A}/calculate`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: adminCookie
      },
      body: JSON.stringify({
        commercialMetrics: {
          totalSpentCents: 1500000,
          paidInvoicesCount: 6,
          overdueInvoicesCount: 0,
          averageDaysToPay: 20,
          returnedOrdersCount: 0,
          totalOrdersCount: 6,
          creditLimitCents: 300000,
          outstandingBalanceCents: 50000
        }
      })
    })

    const calcRes = await handleCustomerRiskScoringHttp(calcReq, {
      database,
      sessionCookieConfiguration: config
    })
    expect(calcRes?.status).toBe(200)
    const calcData = (await calcRes?.json()) as { ok: boolean; profile: { riskTier: string; factors: unknown[] } }
    expect(calcData.ok).toBe(true)
    expect(calcData.profile.riskTier).toBe('low')
    expect(calcData.profile.factors).toHaveLength(5)

    // 2. Query
    const getReq = new Request(`https://neteco.invalid/api/admin/scoring/profiles/${CUSTOMER_A}`, {
      headers: { cookie: adminCookie }
    })
    const getRes = await handleCustomerRiskScoringHttp(getReq, {
      database,
      sessionCookieConfiguration: config
    })
    expect(getRes?.status).toBe(200)

    // 3. Human review & override
    const revReq = new Request(`https://neteco.invalid/api/admin/scoring/profiles/${CUSTOMER_A}/review`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: adminCookie
      },
      body: JSON.stringify({
        action: 'override',
        newRiskTier: 'moderate',
        newCreditLimitCents: 200000,
        justification: 'Ajuste preventivo por concentración estacional de compras'
      })
    })

    const revRes = await handleCustomerRiskScoringHttp(revReq, {
      database,
      sessionCookieConfiguration: config
    })
    expect(revRes?.status).toBe(200)
    const revData = (await revRes?.json()) as { ok: boolean; profile: { reviewStatus: string; riskTier: string } }
    expect(revData.profile.reviewStatus).toBe('overridden')
    expect(revData.profile.riskTier).toBe('moderate')

    // 4. Quality evaluation
    const qualReq = new Request('https://neteco.invalid/api/admin/scoring/quality', {
      headers: { cookie: adminCookie }
    })
    const qualRes = await handleCustomerRiskScoringHttp(qualReq, {
      database,
      sessionCookieConfiguration: config
    })
    expect(qualRes?.status).toBe(200)
    const qualData = (await qualRes?.json()) as { quality: { qualityStatus: string; sampleSize: number } }
    expect(qualData.quality.qualityStatus).toBeDefined()
    expect(qualData.quality.sampleSize).toBe(1)
  })
})

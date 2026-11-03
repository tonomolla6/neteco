import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import { handleWelcomeCouponHttp } from '../../workers/marketing/welcome-coupon-http'

// SECFIX-3 finding 3: welcome coupons issued without a session from client-supplied identity.
const now = '2026-10-29T12:00:00Z'
const origin = 'https://tienda.neteco.invalid'
const config = { password: 'w'.repeat(64), maxAgeSeconds: 3600 }
const buyer = { identity: '10000000-0000-4000-8000-0000000000d1', session: '20000000-0000-4000-8000-0000000000d1' }
const orphan = { identity: '10000000-0000-4000-8000-0000000000e1', session: '20000000-0000-4000-8000-0000000000e1' }
const victimCustomer = '30000000-0000-4000-8000-0000000000f1'

let sqlite: DatabaseSync
let database: D1Database
let buyerCookie: string
let orphanCookie: string

beforeEach(async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(now))
  sqlite = await openMigratedDatabase()
  sqlite.exec(await readFile('db/d1/migrations/0142_browse_recovery_welcome_coupon_recommendations.sql', 'utf8'))
  database = d1OverSqlite(sqlite)
  const t = '2026-10-20T12:00:00Z'
  sqlite.exec(`
    INSERT INTO customers(id, name, phone, status, created_at, updated_at) VALUES('cust-buyer','Buyer',NULL,'active','${t}','${t}');
    INSERT INTO customers(id, name, phone, status, created_at, updated_at) VALUES('${victimCustomer}','Victim',NULL,'active','${t}','${t}');
    INSERT INTO identities(id, email, customer_id, password_hash, email_verified_at, status, created_at, updated_at)
      VALUES('${buyer.identity}','buyer@cliente.es','cust-buyer','x','${t}','active','${t}','${t}');
    INSERT INTO identities(id, email, customer_id, password_hash, email_verified_at, status, created_at, updated_at)
      VALUES('${orphan.identity}','orphan@cliente.es',NULL,'x','${t}','active','${t}','${t}');
    INSERT INTO auth_sessions(id, identity_id, session_version, mfa_verified, created_at, expires_at)
      VALUES('${buyer.session}','${buyer.identity}',1,0,'${t}','2026-10-30T12:00:00Z');
    INSERT INTO auth_sessions(id, identity_id, session_version, mfa_verified, created_at, expires_at)
      VALUES('${orphan.session}','${orphan.identity}',1,0,'${t}','2026-10-30T12:00:00Z');
  `)
  buyerCookie = (await issueD1SessionCookie(
    database,
    { identityId: buyer.identity, sessionId: buyer.session, sessionVersion: 1 },
    config
  ))!
  orphanCookie = (await issueD1SessionCookie(
    database,
    { identityId: orphan.identity, sessionId: orphan.session, sessionVersion: 1 },
    config
  ))!
})

afterEach(() => {
  vi.useRealTimers()
  sqlite.close()
})

const grantCount = () => (sqlite.prepare('SELECT COUNT(*) AS n FROM welcome_coupon_grants').get() as { n: number }).n

function call(path: string, headers: Record<string, string>, body: unknown = {}) {
  return handleWelcomeCouponHttp(
    new Request(`${origin}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body)
    }),
    { database, sessionCookieConfiguration: config, origin, now: () => now }
  )
}

const issue = (headers: Record<string, string>, body: unknown = {}) =>
  call('/api/marketing/welcome-coupon/issue', headers, body)

describe('SECFIX-3 POST /api/marketing/welcome-coupon/issue', () => {
  it('rejects anonymous issuance with client-supplied identity (401, nothing written)', async () => {
    const response = await issue(
      { origin },
      { customerId: victimCustomer, identityId: buyer.identity, email: 'attacker@example.com' }
    )
    expect(response?.status).toBe(401)
    expect(grantCount()).toBe(0)
  })

  it('rejects cross-origin and origin-less mutations even with a valid session', async () => {
    expect((await issue({ cookie: buyerCookie, origin: 'https://evil.example' }))?.status).toBe(403)
    expect((await issue({ cookie: buyerCookie }))?.status).toBe(403)
    expect((await issue({ cookie: buyerCookie, origin, 'sec-fetch-site': 'cross-site' }))?.status).toBe(403)
    expect(grantCount()).toBe(0)
  })

  it('refuses client-supplied customer/identity/email fields instead of trusting them', async () => {
    const response = await issue(
      { cookie: buyerCookie, origin },
      { customerId: victimCustomer, identityId: orphan.identity, email: 'attacker@example.com' }
    )
    expect(response?.status).toBe(400)
    expect(grantCount()).toBe(0)
  })

  it('issues the grant to the session identity and its customer, derived server-side', async () => {
    const response = await issue({ cookie: buyerCookie, origin })
    expect(response?.status).toBe(201)
    const { grant } = (await response!.json()) as { grant: { customerId: string; identityId: string } }
    expect(grant.customerId).toBe('cust-buyer')
    expect(grant.identityId).toBe(buyer.identity)
  })

  it('is idempotent per identity: a replay returns the same grant without a second row', async () => {
    const first = (await (await issue({ cookie: buyerCookie, origin }))!.json()) as { grant: { id: string } }
    const replay = await issue({ cookie: buyerCookie, origin })
    expect(replay?.status).toBe(200)
    const second = (await replay!.json()) as { grant: { id: string } }
    expect(second.grant.id).toBe(first.grant.id)
    expect(grantCount()).toBe(1)
  })

  it('forbids identities without a customer account', async () => {
    expect((await issue({ cookie: orphanCookie, origin }))?.status).toBe(403)
    expect(grantCount()).toBe(0)
  })
})

describe('SECFIX-3 POST /api/marketing/welcome-coupon/redeem', () => {
  it('rejects anonymous redemption with client-supplied identity (401)', async () => {
    const response = await call(
      '/api/marketing/welcome-coupon/redeem',
      { origin },
      {
        grantId: '40000000-0000-4000-8000-000000000001',
        couponCode: 'BIENVENIDA-XXXX',
        customerId: victimCustomer,
        orderId: 'ord-x',
        identityId: buyer.identity,
        email: 'attacker@example.com',
        discountAppliedCents: 100,
        grossOrderCents: 1000,
        referencePriceGrossCents: 1000
      }
    )
    expect(response?.status).toBe(401)
  })

  it("forbids redeeming another customer's grant", async () => {
    const issued = (await (await issue({ cookie: buyerCookie, origin }))!.json()) as {
      grant: { id: string; couponCode: string }
    }
    const response = await call(
      '/api/marketing/welcome-coupon/redeem',
      { cookie: orphanCookie, origin },
      {
        grantId: issued.grant.id,
        couponCode: issued.grant.couponCode,
        orderId: 'ord-x',
        discountAppliedCents: 100,
        grossOrderCents: 1000,
        referencePriceGrossCents: 1000
      }
    )
    expect(response?.status).toBe(403)
    const status = sqlite.prepare('SELECT status FROM welcome_coupon_grants WHERE id = ?').get(issued.grant.id) as {
      status: string
    }
    expect(status.status).toBe('active')
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import worker from '../../workers/canary'
import { handleAdminPromotionsHttp, ownsAdminPromotionsNamespace } from '../../workers/catalog/admin-promotions-http'
import { d1OverSqlite, openAccountSecurityDatabase } from '../support/d1-sqlite'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import { adminPromotionIntentHash, adminPromotionReceiptSchema } from '../../shared/admin-promotions'

// Behavioural RED against the existing worker, not an absent import or handler
// stub. The outer authorization gate must own every promotion subroute.
describe('actual canary promotion namespace before any private D1 access', () => {
  it.each([
    ['GET', '/api/admin/promotions'],
    ['POST', '/api/admin/promotions'],
    ['POST', '/api/admin/promotions/preview'],
    ['GET', '/api/admin/promotions/commands/70000000-0000-4000-8000-000000000073'],
    ['PUT', '/api/admin/promotions/60000000-0000-4000-8000-000000000073']
  ])('fails closed with AUTH disabled: %s %s', async (method, path) => {
    const prepare = vi.fn(() => {
      throw new Error('unexpected_database_access')
    })
    const response = await worker.fetch(
      new Request('https://promotions-native.neteco.test' + path, { method }),
      {
        AUTH_ENABLED: 'false',
        DB: { prepare } as unknown as D1Database
      } as never,
      { waitUntil: vi.fn() } as never
    )
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ error: { code: expect.any(String) } })
    expect(response.headers.get('cache-control')).toContain('private')
    expect(response.headers.get('cache-control')).toContain('no-store')
    expect(response.headers.get('set-cookie')).toBeNull()
    expect(prepare).not.toHaveBeenCalled()
  })
})

const origin = 'https://promotions-http.neteco.test',
  root = '/api/admin/promotions',
  password = 'synthetic-promotion-cookie-more-than-32-characters'
describe('promotion HTTP boundaries, real D1 service and sealed sessions', () => {
  let sqlite: DatabaseSync, db: D1Database, cookie: string
  const actor = '10000000-0000-4000-8000-000000000073',
    sessionId = '20000000-0000-4000-8000-000000000073',
    ruleId = '30000000-0000-4000-8000-000000000073'
  const claims = { identityId: actor, sessionId, sessionVersion: 1 }
  const input = () => ({
    expectedVersion: 0,
    reason: 'Synthetic governed promotion',
    rule: {
      id: ruleId,
      version: 1,
      code: 'HTTP-SYNTHETIC',
      status: 'paused',
      channel: 'online',
      startsAt: '2030-01-01T00:00:00Z',
      endsAt: null,
      benefit: { kind: 'percent', basisPoints: 1000 },
      scope: { kind: 'all' },
      segment: 'all',
      totalLimit: null,
      perCustomerLimit: null,
      volumeMode: 'exclude_volume'
    }
  })
  beforeEach(async () => {
    sqlite = await openAccountSecurityDatabase()
    db = d1OverSqlite(sqlite) as unknown as D1Database
    sqlite
      .prepare(
        "INSERT INTO identities(id,email,password_hash,email_verified_at,status,created_at,updated_at) VALUES (?,'promotion-http@example.invalid','synthetic','2020-01-01T00:00:00Z','active','2020-01-01T00:00:00Z','2020-01-01T00:00:00Z')"
      )
      .run(actor)
    sqlite.exec(
      "INSERT OR IGNORE INTO permissions VALUES ('administration.manage','administration','manage','fixture'); INSERT INTO roles VALUES ('promotion_fixture','Promotions','fixture'); INSERT INTO role_permissions VALUES ('promotion_fixture','administration.manage');"
    )
    sqlite
      .prepare(
        "INSERT INTO identity_roles(identity_id,role_code,granted_at) VALUES (?,'promotion_fixture','2020-01-01T00:00:00Z')"
      )
      .run(actor)
    sqlite
      .prepare(
        "INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at) VALUES (?,?,1,1,'2020-01-01T00:00:00Z','2035-01-01T00:00:00Z')"
      )
      .run(sessionId, actor)
    cookie = (await issueD1SessionCookie(db, claims, { password, maxAgeSeconds: 3600 }))!.split(';')[0]!
  })
  afterEach(() => sqlite?.close())
  async function call(path = root, method = 'GET', body?: unknown, headers: Record<string, string> = {}) {
    return (await handleAdminPromotionsHttp(
      new Request(origin + path, {
        method,
        headers: { cookie, origin, 'content-type': 'application/json', ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      }),
      { database: db, sessionCookieConfiguration: { password, maxAgeSeconds: 3600 }, origin }
    ))!
  }
  it('persists a governed POST201, replays201 and recovers exact hash without writing on GET', async () => {
    const key = crypto.randomUUID(),
      body = input(),
      first = await call(root, 'POST', body, { 'Idempotency-Key': key })
    expect(first.status).toBe(201)
    const receipt = adminPromotionReceiptSchema.parse(await first.json())
    const replay = await call(root, 'POST', body, { 'Idempotency-Key': key })
    expect(replay.status).toBe(201)
    expect(await replay.json()).toEqual(receipt)
    const before = sqlite.prepare('SELECT * FROM promotion_admin_commands').all()
    const lookup = await call(root + '/commands/' + key, 'GET', undefined, {
      'X-Neteco-Command-Payload-Hash': await adminPromotionIntentHash(body)
    })
    expect(await lookup.json()).toEqual({ source: 'cloudflare', outcome: 'applied', receipt })
    expect(sqlite.prepare('SELECT * FROM promotion_admin_commands').all()).toEqual(before)
    expect(sqlite.prepare('SELECT count(*) n FROM promotion_redemptions').get()).toEqual({ n: 0 })
  })
  it('accepts a legitimate same-origin GET without Origin and keeps private headers', async () => {
    const response = await handleAdminPromotionsHttp(new Request(origin + root, { headers: { cookie } }), {
      database: db,
      sessionCookieConfiguration: { password, maxAgeSeconds: 3600 },
      origin
    })
    expect(response!.status).toBe(200)
    expect(await response!.json()).toMatchObject({ source: 'cloudflare', items: [], total: 0 })
    expect(response!.headers.get('cache-control')).toBe('private, no-store')
    expect(response!.headers.get('set-cookie')).toBeNull()
  })
  it.each(['?page=0', '?perPage=26', '?page=1&page=2', '?unknown=1'])(
    'rejects malformed/duplicate/unknown list query %s',
    async (suffix) => expect((await call(root + suffix)).status).toBe(400)
  )
  it.each([
    ['DELETE', root, 'GET, POST'],
    ['POST', root + '/' + ruleId, 'GET, PUT'],
    ['POST', root + '/commands/' + crypto.randomUUID(), 'GET']
  ])('rejects method %s before D1', async (method, path, allow) => {
    const prepare = vi.fn(() => {
      throw Error('unexpected_D1')
    })
    const response = await handleAdminPromotionsHttp(new Request(origin + path, { method }), {
      database: { prepare } as unknown as D1Database,
      sessionCookieConfiguration: { password, maxAgeSeconds: 3600 },
      origin
    })
    expect(response!.status).toBe(405)
    expect(response!.headers.get('allow')).toBe(allow)
    expect(prepare).not.toHaveBeenCalled()
  })
  it.each(['/API/ADMIN/PROMOTIONS', '/api/admin/%70romotions', '/api/admin/promotions/unknown'])(
    'owns aliases and fails closed: %s',
    async (path) => {
      expect(ownsAdminPromotionsNamespace(path)).toBe(true)
      expect((await call(path)).status).toBe(404)
    }
  )
  it('rejects cross-host GET without Origin and cross-origin POST before D1', async () => {
    const prepare = vi.fn(() => {
        throw Error('unexpected_D1')
      }),
      deps = {
        database: { prepare } as unknown as D1Database,
        sessionCookieConfiguration: { password, maxAgeSeconds: 3600 },
        origin
      }
    expect((await handleAdminPromotionsHttp(new Request('https://foreign.neteco.test' + root), deps))!.status).toBe(403)
    expect(
      (await handleAdminPromotionsHttp(
        new Request(origin + root, { method: 'POST', headers: { origin: 'https://foreign.neteco.test' } }),
        deps
      ))!.status
    ).toBe(403)
    expect(prepare).not.toHaveBeenCalled()
  })
  it('limits streaming JSON and rejects missing idempotency without creating a rule', async () => {
    expect((await call(root, 'POST', input())).status).toBe(400)
    expect(
      (await call(root, 'POST', { padding: 'x'.repeat(65536) }, { 'Idempotency-Key': crypto.randomUUID() })).status
    ).toBe(413)
    expect(sqlite.prepare('SELECT count(*) n FROM promotion_rules').get()).toEqual({ n: 0 })
  })
  it('strict preview calls the pure engine without creating rules, uses or commands', async () => {
    const rule = input().rule,
      id = crypto.randomUUID(),
      response = await call(root + '/preview', 'POST', {
        rule,
        context: {
          now: rule.startsAt,
          channel: 'online',
          customerId: null,
          companyApproved: false,
          redemptions: { total: 0, customer: 0 },
          lines: [
            {
              lineIndex: 0,
              variantId: id,
              productId: id,
              categoryId: id,
              sku: 'SYNTHETIC',
              quantity: 1,
              baseUnitGrossCents: 1000,
              volumeUnitGrossCents: 1000,
              taxRateBasisPoints: 2100
            }
          ]
        }
      })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      source: 'cloudflare',
      simulation: true,
      eligible: false,
      reason: 'unavailable'
    })
    for (const table of [
      'promotion_rules',
      'promotion_rule_versions',
      'promotion_redemptions',
      'promotion_admin_commands'
    ])
      expect(sqlite.prepare('SELECT count(*) n FROM ' + table).get()).toEqual({ n: 0 })
  })
})

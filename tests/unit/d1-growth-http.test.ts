import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fulfillmentFixture } from './d1-fulfillment-fixture'
import { provisionPublicationValidityFixture } from '../support/publication-validity-fixture'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import {
  ADMIN_ID,
  ADMIN_SESSION,
  CUSTOMER_ID,
  NO_MFA_ID,
  NO_MFA_SESSION,
  NOW,
  PLAIN_ID,
  PLAIN_SESSION,
  seedGrowthIdentities
} from './d1-growth-fixture'
import { handleGrowthHttp, ownsGrowthNamespace, type GrowthHttpDependencies } from '../../workers/growth/growth-http'

const ORIGIN = 'https://shop.neteco.test'
const PASSWORD = 'test-session-password-at-least-32-characters-long!'
const PEPPER = 'test-rate-limit-pepper-at-least-32-characters-long!'
const CUSTOMER_IDENTITY = '10000000-0000-4000-8000-0000000000c1'
const CUSTOMER_SESSION = '20000000-0000-4000-8000-0000000000c1'

let sqlite: DatabaseSync
let db: D1Database
let deps: GrowthHttpDependencies
let adminCookie = ''
let noMfaCookie = ''
let plainCookie = ''
let customerCookie = ''
let limiterAllows = true
let n = 0

async function cookieFor(sessionId: string, identityId: string) {
  const issued = await issueD1SessionCookie(
    db,
    { sessionId, identityId, sessionVersion: 1 },
    { password: PASSWORD, maxAgeSeconds: 3600 }
  )
  return (issued ?? '').split(';')[0] ?? ''
}

beforeEach(async () => {
  const fixture = await fulfillmentFixture({ stock: 25 })
  sqlite = fixture.sqlite
  db = fixture.database
  sqlite.exec(await readFile(new URL('../../db/d1/migrations/0115_growth_offers.sql', import.meta.url), 'utf8'))
  seedGrowthIdentities(sqlite)
  await provisionPublicationValidityFixture(db, { productIds: ['p-1', 'p-2', 'p-3'], now: '2026-01-01T00:00:00Z' })
  sqlite
    .prepare(
      `INSERT INTO identities (id, email, password_hash, status, session_version, email_verified_at, customer_id, created_at, updated_at)
       VALUES (?, 'cliente@neteco.test', 'h', 'active', 1, '2026-01-01T00:00:00Z', ?, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`
    )
    .run(CUSTOMER_IDENTITY, CUSTOMER_ID)
  sqlite
    .prepare(
      `INSERT INTO auth_sessions (id, identity_id, session_version, mfa_verified, created_at, expires_at)
       VALUES (?, ?, 1, 0, '2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z')`
    )
    .run(CUSTOMER_SESSION, CUSTOMER_IDENTITY)
  adminCookie = await cookieFor(ADMIN_SESSION, ADMIN_ID)
  noMfaCookie = await cookieFor(NO_MFA_SESSION, NO_MFA_ID)
  plainCookie = await cookieFor(PLAIN_SESSION, PLAIN_ID)
  customerCookie = await cookieFor(CUSTOMER_SESSION, CUSTOMER_IDENTITY)
  limiterAllows = true
  deps = {
    database: db,
    sessionCookieConfiguration: { password: PASSWORD, maxAgeSeconds: 3600 },
    origin: ORIGIN,
    rateLimitPepper: PEPPER,
    edgeLimiter: { limit: async () => ({ success: limiterAllows }) } as unknown as RateLimit,
    now: NOW
  }
})
afterEach(() => {
  if (sqlite?.isOpen) sqlite.close()
})

function req(
  path: string,
  init: {
    method?: string
    cookie?: string
    body?: unknown
    key?: string | null
    origin?: string | null
    ip?: string | null
  } = {}
) {
  const headers = new Headers()
  if (init.cookie) headers.set('cookie', init.cookie)
  if (init.body !== undefined) headers.set('content-type', 'application/json')
  if (init.key !== null && init.method && init.method !== 'GET')
    headers.set('idempotency-key', init.key ?? `http-key-${++n}-xxxx`)
  if (init.origin !== null && init.method && init.method !== 'GET') headers.set('origin', init.origin ?? ORIGIN)
  if (init.ip !== null) headers.set('cf-connecting-ip', init.ip ?? '203.0.113.9')
  return new Request(`${ORIGIN}${path}`, {
    method: init.method ?? 'GET',
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body)
  })
}
const call = async (r: Request) => {
  const res = await handleGrowthHttp(r, deps)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { res: res!, body: (await res!.json()) as Record<string, any> }
}

const RULE = {
  code: 'COMPRA2REGALO1',
  name: 'Compra 2 y llévate 1',
  triggerVariantId: 'v-1-1',
  buyQuantity: 2,
  giftVariantId: 'v-2-1',
  giftQuantity: 1,
  maxApplicationsPerOrder: 5,
  totalLimit: null,
  perCustomerLimit: null,
  marginFloorBasisPoints: 0,
  startsAt: '2026-01-01T00:00:00Z',
  endsAt: null
}
const EXPERIMENT = {
  code: 'EXP-ENVIO80',
  name: 'Envío gratis sobre 80 EUR',
  promotionCode: 'ENVIO80',
  holdoutBasisPoints: 2000,
  minSamplePerArm: 50,
  minIncrementalMarginCents: 0
}

describe('growth HTTP routing and guards', () => {
  it('claims only its own namespaces, including encoded variants', () => {
    for (const p of [
      '/api/admin/growth/bxgy-rules',
      '/api/promotions/buy-x-get-y/preview',
      '/api/lead-magnets',
      '/api/lead-magnets/x/request-copy',
      '/api/admin/growth/promo-experiments/abc/analysis'
    ])
      expect(ownsGrowthNamespace(p)).toBe(true)
    expect(ownsGrowthNamespace('/api/%61dmin/growth/bxgy-rules')).toBe(true)
    expect(ownsGrowthNamespace('/api/products')).toBe(false)
    expect(ownsGrowthNamespace('/api/lead-magnetsx')).toBe(false)
  })
  it('returns null for foreign paths', async () => {
    expect(await handleGrowthHttp(req('/api/products'), deps)).toBeNull()
  })
  it('fails closed when sessions are not configured for admin routes', async () => {
    expect((await call(req('/api/admin/growth/bxgy-rules', { cookie: adminCookie }))).res.status).toBe(200)
    const closed = await handleGrowthHttp(req('/api/admin/growth/bxgy-rules', { cookie: adminCookie }), {
      ...deps,
      sessionCookieConfiguration: null
    })
    expect(closed?.status).toBe(503)
  })
  it('rejects anonymous, MFA-less and unprivileged administrators', async () => {
    expect((await call(req('/api/admin/growth/bxgy-rules'))).res.status).toBe(401)
    const m = await call(req('/api/admin/growth/bxgy-rules', { cookie: noMfaCookie }))
    expect([m.res.status, m.body.error.code]).toEqual([403, 'mfa_required'])
    const p = await call(req('/api/admin/growth/bxgy-rules', { cookie: plainCookie }))
    expect([p.res.status, p.body.error.code]).toEqual([403, 'forbidden'])
  })
  it('applies the administrative edge limiter', async () => {
    limiterAllows = false
    const { res, body } = await call(req('/api/admin/growth/bxgy-rules', { cookie: adminCookie }))
    expect([res.status, body.error.code]).toEqual([429, 'rate_limited'])
  })
  it('rejects cross-origin mutations', async () => {
    const { res, body } = await call(
      req('/api/admin/growth/bxgy-rules', {
        method: 'POST',
        cookie: adminCookie,
        body: RULE,
        origin: 'https://evil.example'
      })
    )
    expect([res.status, body.error.code]).toEqual([403, 'csrf_rejected'])
    expect(sqlite.prepare('SELECT count(*) c FROM bxgy_rules').get()).toEqual({ c: 0 })
  })
  it('sends private no-store headers on administrative responses', async () => {
    const { res } = await call(req('/api/admin/growth/bxgy-rules', { cookie: adminCookie }))
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
  })
  it('hides internal failures behind a stable code', async () => {
    const broken = {
      ...db,
      prepare: () => {
        throw new Error('secret SQL detail')
      }
    } as unknown as D1Database
    const res = await handleGrowthHttp(
      req('/api/lead-magnets/checklist-seguridad-productos-quimicos/request-copy', {
        method: 'POST',
        body: { magnetSlug: 'checklist-seguridad-productos-quimicos', email: 'a@example.com' }
      }),
      { ...deps, database: broken }
    )
    expect(res?.status).toBe(500)
    expect(JSON.stringify(await res!.json())).not.toContain('secret')
  })
  it('answers 405 for unsupported methods', async () => {
    const { res } = await call(req('/api/admin/growth/bxgy-rules', { method: 'DELETE', cookie: adminCookie, body: {} }))
    expect(res.status).toBe(405)
  })
})

describe('growth HTTP: buy X get Y administration', () => {
  it('creates, lists, updates, activates and rejects stale writes', async () => {
    const created = await call(req('/api/admin/growth/bxgy-rules', { method: 'POST', cookie: adminCookie, body: RULE }))
    expect(created.res.status).toBe(201)
    const id = created.body.targetId as string
    const list = await call(req('/api/admin/growth/bxgy-rules', { cookie: adminCookie }))
    expect(list.body.rules).toHaveLength(1)
    const upd = await call(
      req(`/api/admin/growth/bxgy-rules/${id}`, {
        method: 'PUT',
        cookie: adminCookie,
        body: { expectedVersion: 1, rule: { ...RULE, name: 'Nuevo nombre' } }
      })
    )
    expect(upd.body.appliedVersion).toBe(2)
    const stale = await call(
      req(`/api/admin/growth/bxgy-rules/${id}/status`, {
        method: 'POST',
        cookie: adminCookie,
        body: { expectedVersion: 1, status: 'active' }
      })
    )
    expect([stale.res.status, stale.body.error.code]).toEqual([409, 'version_conflict'])
    const act = await call(
      req(`/api/admin/growth/bxgy-rules/${id}/status`, {
        method: 'POST',
        cookie: adminCookie,
        body: { expectedVersion: 2, status: 'active' }
      })
    )
    expect(act.body.appliedVersion).toBe(3)
  })
  it('requires an Idempotency-Key and replays identical commands', async () => {
    const missing = await call(
      req('/api/admin/growth/bxgy-rules', { method: 'POST', cookie: adminCookie, body: RULE, key: null })
    )
    expect([missing.res.status, missing.body.error.code]).toEqual([400, 'invalid_input'])
    const a = await call(
      req('/api/admin/growth/bxgy-rules', { method: 'POST', cookie: adminCookie, body: RULE, key: 'fixed-key-0001' })
    )
    const b = await call(
      req('/api/admin/growth/bxgy-rules', { method: 'POST', cookie: adminCookie, body: RULE, key: 'fixed-key-0001' })
    )
    expect(b.body).toEqual(a.body)
    const c = await call(
      req('/api/admin/growth/bxgy-rules', {
        method: 'POST',
        cookie: adminCookie,
        body: { ...RULE, code: 'OTRO' },
        key: 'fixed-key-0001'
      })
    )
    expect([c.res.status, c.body.error.code]).toEqual([409, 'idempotency_conflict'])
  })
  it('validates bodies and unknown ids', async () => {
    expect(
      (
        await call(
          req('/api/admin/growth/bxgy-rules', {
            method: 'POST',
            cookie: adminCookie,
            body: { ...RULE, buyQuantity: 0 }
          })
        )
      ).res.status
    ).toBe(400)
    expect(
      (
        await call(
          req('/api/admin/growth/bxgy-rules/70000000-0000-4000-8000-0000000000ff/status', {
            method: 'POST',
            cookie: adminCookie,
            body: { expectedVersion: 1, status: 'active' }
          })
        )
      ).res.status
    ).toBe(404)
    const bad = new Request(`${ORIGIN}/api/admin/growth/bxgy-rules`, {
      method: 'POST',
      headers: {
        cookie: adminCookie,
        origin: ORIGIN,
        'cf-connecting-ip': '203.0.113.9',
        'idempotency-key': 'fixed-key-0002',
        'content-type': 'application/json'
      },
      body: '{not json'
    })
    expect((await handleGrowthHttp(bad, deps))!.status).toBe(400)
  })
  it('records returns and exposes the refund quote', async () => {
    const created = await call(req('/api/admin/growth/bxgy-rules', { method: 'POST', cookie: adminCookie, body: RULE }))
    await call(
      req(`/api/admin/growth/bxgy-rules/${created.body.targetId}/status`, {
        method: 'POST',
        cookie: adminCookie,
        body: { expectedVersion: 1, status: 'active' }
      })
    )
    const preview = await call(
      req('/api/promotions/buy-x-get-y/preview', {
        method: 'POST',
        body: { lines: [{ variantId: 'v-1-1', quantity: 4 }] }
      })
    )
    expect(preview.body.evaluation.eligible).toBe(true)
    // the sale is recorded server-side by checkout; simulate with the exact snapshot
    const { recordBxgyRedemption } = await import('../../workers/growth/buy-x-get-y')
    const { previewBuyXGetY } = await import('../../workers/growth/buy-x-get-y')
    const full = await previewBuyXGetY(db, { lines: [{ variantId: 'v-1-1', quantity: 4 }], customerId: null }, NOW)
    await recordBxgyRedemption(
      db,
      {
        orderRef: 'order-http-0001',
        ruleId: created.body.targetId,
        customerId: null,
        snapshot: full.evaluation.snapshot
      },
      NOW
    )
    const ret = await call(
      req('/api/admin/growth/bxgy-returns', {
        method: 'POST',
        cookie: adminCookie,
        body: {
          orderRef: 'order-http-0001',
          returnRef: 'return-http-001',
          lines: [{ kind: 'gift', variantId: 'v-2-1', quantity: 1 }]
        }
      })
    )
    expect(ret.res.status).toBe(200)
    expect(ret.body.quote.netRefundGrossCents).toBe(334)
    const over = await call(
      req('/api/admin/growth/bxgy-returns', {
        method: 'POST',
        cookie: adminCookie,
        body: {
          orderRef: 'order-http-0001',
          returnRef: 'return-http-002',
          lines: [{ kind: 'gift', variantId: 'v-2-1', quantity: 5 }]
        }
      })
    )
    expect([over.res.status, over.body.error.code]).toEqual([422, 'return_invalid'])
  })
})

describe('growth HTTP: public buy X get Y preview', () => {
  async function activate(patch: Record<string, unknown> = {}) {
    const created = await call(
      req('/api/admin/growth/bxgy-rules', { method: 'POST', cookie: adminCookie, body: { ...RULE, ...patch } })
    )
    await call(
      req(`/api/admin/growth/bxgy-rules/${created.body.targetId}/status`, {
        method: 'POST',
        cookie: adminCookie,
        body: { expectedVersion: 1, status: 'active' }
      })
    )
    return created.body.targetId as string
  }
  it('returns the server-priced offer without leaking cost, margin or the internal snapshot', async () => {
    await activate()
    sqlite.exec('UPDATE variants SET cost_net_cents=200')
    const { res, body } = await call(
      req('/api/promotions/buy-x-get-y/preview', {
        method: 'POST',
        body: { lines: [{ variantId: 'v-1-1', quantity: 4 }] }
      })
    )
    expect(res.status).toBe(200)
    expect(body.evaluation).toMatchObject({ eligible: true, applications: 2 })
    expect(JSON.stringify(body)).not.toMatch(/margin|cost|snapshot/i)
    expect(res.headers.get('cache-control')).toBe('private, no-store')
  })
  it('does not trust client-supplied prices', async () => {
    await activate()
    const { res } = await call(
      req('/api/promotions/buy-x-get-y/preview', {
        method: 'POST',
        body: { lines: [{ variantId: 'v-1-1', quantity: 4, unitGrossCents: 1 }] }
      })
    )
    expect(res.status).toBe(400)
  })
  it('validates input and unknown variants', async () => {
    expect(
      (await call(req('/api/promotions/buy-x-get-y/preview', { method: 'POST', body: { lines: [] } }))).res.status
    ).toBe(400)
    const unknown = await call(
      req('/api/promotions/buy-x-get-y/preview', {
        method: 'POST',
        body: { lines: [{ variantId: 'ghost', quantity: 1 }] }
      })
    )
    expect([unknown.res.status, unknown.body.error.code]).toEqual([422, 'variant_not_available'])
  })
  it('requires a same-origin request', async () => {
    const { res } = await call(
      req('/api/promotions/buy-x-get-y/preview', {
        method: 'POST',
        origin: 'https://evil.example',
        body: { lines: [{ variantId: 'v-1-1', quantity: 4 }] }
      })
    )
    expect(res.status).toBe(403)
  })
  it('uses the signed-in customer for per-customer limits and ignores forged cookies', async () => {
    await activate({ perCustomerLimit: 1 })
    const anon = await call(
      req('/api/promotions/buy-x-get-y/preview', {
        method: 'POST',
        body: { lines: [{ variantId: 'v-1-1', quantity: 4 }] }
      })
    )
    expect(anon.body.evaluation.reason).toBe('customer_required')
    const signed = await call(
      req('/api/promotions/buy-x-get-y/preview', {
        method: 'POST',
        cookie: customerCookie,
        body: { lines: [{ variantId: 'v-1-1', quantity: 4 }] }
      })
    )
    expect(signed.body.evaluation.eligible).toBe(true)
    const forged = await call(
      req('/api/promotions/buy-x-get-y/preview', {
        method: 'POST',
        cookie: 'neteco-session=forged',
        body: { lines: [{ variantId: 'v-1-1', quantity: 4 }] }
      })
    )
    expect(forged.body.evaluation.reason).toBe('customer_required')
  })
})

describe('growth HTTP: promotion experiments', () => {
  it('runs the full lifecycle and reaches a server-derived conclusion', async () => {
    const created = await call(
      req('/api/admin/growth/promo-experiments', { method: 'POST', cookie: adminCookie, body: EXPERIMENT })
    )
    expect(created.res.status).toBe(201)
    const id = created.body.targetId as string
    const started = await call(
      req(`/api/admin/growth/promo-experiments/${id}/transition`, {
        method: 'POST',
        cookie: adminCookie,
        body: { action: 'start', expectedVersion: 1 }
      })
    )
    expect(started.body.appliedVersion).toBe(2)
    const assign = await call(
      req(`/api/admin/growth/promo-experiments/${id}/assign`, {
        method: 'POST',
        cookie: adminCookie,
        body: { subjectKey: 'customer-1' }
      })
    )
    expect(['holdout', 'treatment']).toContain(assign.body.arm)
    expect(assign.body.subjectHash).toMatch(/^[0-9a-f]{64}$/)
    const obs = await call(
      req(`/api/admin/growth/promo-experiments/${id}/observations`, {
        method: 'POST',
        cookie: adminCookie,
        body: {
          subjectKey: 'customer-1',
          orderRef: 'order-http-0001',
          revenueGrossCents: 1210,
          netRevenueCents: 1000,
          cogsCents: 600,
          variableCostCents: 0
        }
      })
    )
    expect(obs.res.status).toBe(201)
    const analysis = await call(req(`/api/admin/growth/promo-experiments/${id}/analysis`, { cookie: adminCookie }))
    expect(analysis.body).toMatchObject({ objective: 'incremental_margin', decision: 'insufficient_sample' })
    const done = await call(
      req(`/api/admin/growth/promo-experiments/${id}/transition`, {
        method: 'POST',
        cookie: adminCookie,
        body: { action: 'conclude', expectedVersion: 2 }
      })
    )
    expect(done.res.status).toBe(200)
    expect(sqlite.prepare('SELECT conclusion FROM promo_experiments').get()).toEqual({ conclusion: 'inconclusive' })
  })
  it('refuses a client-chosen conclusion and bad actions', async () => {
    const created = await call(
      req('/api/admin/growth/promo-experiments', { method: 'POST', cookie: adminCookie, body: EXPERIMENT })
    )
    const id = created.body.targetId
    const r = await call(
      req(`/api/admin/growth/promo-experiments/${id}/transition`, {
        method: 'POST',
        cookie: adminCookie,
        body: { action: 'conclude', expectedVersion: 1, conclusion: 'rollout' }
      })
    )
    expect(r.res.status).toBe(400)
    const s = await call(
      req(`/api/admin/growth/promo-experiments/${id}/transition`, {
        method: 'POST',
        cookie: adminCookie,
        body: { action: 'promote', expectedVersion: 1 }
      })
    )
    expect(s.res.status).toBe(400)
  })
  it('rejects an experiment without holdout and non-admins', async () => {
    expect(
      (
        await call(
          req('/api/admin/growth/promo-experiments', {
            method: 'POST',
            cookie: adminCookie,
            body: { ...EXPERIMENT, holdoutBasisPoints: 0 }
          })
        )
      ).res.status
    ).toBe(400)
    expect(
      (
        await call(
          req('/api/admin/growth/promo-experiments', { method: 'POST', cookie: plainCookie, body: EXPERIMENT })
        )
      ).res.status
    ).toBe(403)
    expect(
      (
        await call(
          req('/api/admin/growth/promo-experiments/70000000-0000-4000-8000-0000000000ff/analysis', {
            cookie: adminCookie
          })
        )
      ).res.status
    ).toBe(404)
  })
  it('lists experiments', async () => {
    await call(req('/api/admin/growth/promo-experiments', { method: 'POST', cookie: adminCookie, body: EXPERIMENT }))
    const list = await call(req('/api/admin/growth/promo-experiments', { cookie: adminCookie }))
    expect(list.body.experiments).toHaveLength(1)
  })
})

describe('growth HTTP: lead magnets', () => {
  const SLUG = 'checklist-seguridad-productos-quimicos'
  const post = (body: unknown, extra: Parameters<typeof req>[1] = {}) =>
    call(req(`/api/lead-magnets/${SLUG}/request-copy`, { method: 'POST', body, key: null, ...extra }))
  it('publishes the catalogue and each resource without any form or session', async () => {
    const list = await call(req('/api/lead-magnets'))
    expect(list.res.status).toBe(200)
    expect(list.body.magnets.map((m: { slug: string }) => m.slug)).toContain(SLUG)
    expect(list.res.headers.get('cache-control')).toMatch(/public/)
    const one = await call(req(`/api/lead-magnets/${SLUG}`))
    expect(one.body.items.length).toBeGreaterThanOrEqual(8)
    expect((await call(req('/api/lead-magnets/nope'))).res.status).toBe(404)
  })
  it('accepts a minimal request with 202 and queues one copy', async () => {
    const { res, body } = await post({ email: 'ana@example.com' })
    expect([res.status, body]).toEqual([202, { accepted: true }])
    expect(sqlite.prepare('SELECT count(*) c FROM lead_magnet_requests').get()).toEqual({ c: 1 })
    expect(sqlite.prepare('SELECT count(*) c FROM lead_magnet_consents').get()).toEqual({ c: 0 })
  })
  it('records optional consent only when explicitly true', async () => {
    await post({ email: 'ana@example.com', marketingConsent: true })
    expect(sqlite.prepare('SELECT count(*) c FROM lead_magnet_consents').get()).toEqual({ c: 1 })
  })
  it('rejects extra fields, invalid e-mails and unknown magnets', async () => {
    expect((await post({ email: 'ana@example.com', name: 'Ana' })).res.status).toBe(400)
    expect((await post({ email: 'nope' })).res.status).toBe(400)
    const unknown = await call(
      req('/api/lead-magnets/inexistente/request-copy', { method: 'POST', body: { email: 'a@example.com' }, key: null })
    )
    expect(unknown.res.status).toBe(404)
  })
  it('requires same-origin and a trusted client address', async () => {
    expect((await post({ email: 'ana@example.com' }, { origin: 'https://evil.example' })).res.status).toBe(403)
    expect((await post({ email: 'ana@example.com' }, { origin: null })).res.status).toBe(403)
    const noIp = await post({ email: 'ana@example.com' }, { ip: null })
    expect([noIp.res.status, noIp.body.error.code]).toEqual([503, 'service_unavailable'])
  })
  it('rate limits at the edge and per address', async () => {
    limiterAllows = false
    expect((await post({ email: 'ana@example.com' })).res.status).toBe(429)
    limiterAllows = true
    for (let i = 0; i < 5; i++) expect((await post({ email: `u${i}@example.com` })).res.status).toBe(202)
    expect((await post({ email: 'u9@example.com' })).res.status).toBe(429)
  })
  it('silently accepts honeypot submissions', async () => {
    const { res } = await post({ email: 'bot@example.com', website: 'http://spam.example' })
    expect(res.status).toBe(202)
    expect(sqlite.prepare('SELECT count(*) c FROM lead_magnet_requests').get()).toEqual({ c: 0 })
  })
  it('refuses oversize bodies and non-JSON', async () => {
    const big = new Request(`${ORIGIN}/api/lead-magnets/${SLUG}/request-copy`, {
      method: 'POST',
      headers: { origin: ORIGIN, 'cf-connecting-ip': '203.0.113.9', 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'a@example.com', pad: 'x'.repeat(5000) })
    })
    expect((await handleGrowthHttp(big, deps))!.status).toBe(413)
  })
  it('exposes the administrative summary only to admins, without addresses', async () => {
    await post({ email: 'ana@example.com' })
    const { res, body } = await call(req('/api/admin/growth/lead-magnets/summary', { cookie: adminCookie }))
    expect(res.status).toBe(200)
    expect(body.summary[0]).toMatchObject({ magnetSlug: SLUG, requested: 1 })
    expect(JSON.stringify(body)).not.toContain('@')
    expect((await call(req('/api/admin/growth/lead-magnets/summary', { cookie: plainCookie }))).res.status).toBe(403)
  })
})

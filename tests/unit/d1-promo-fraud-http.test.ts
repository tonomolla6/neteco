import { readFile } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { categoryCommandFixture, CATEGORY_CLAIMS, categoryUtc as utc } from '../support/category-command-fixture'
import worker from '../../workers/canary'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import { assessPromoFraud } from '../../workers/security/promo-fraud'
import { handlePromoFraudHttp, ownsPromoFraudNamespace } from '../../workers/security/promo-fraud-http'

const origin = 'https://promo.neteco.test'
const PEPPER = 'p'.repeat(40)
const uuid = (n: number, group = 1) => `${group}0000000-0000-4000-8000-${String(n).padStart(12, '0')}`
type Claims = { identityId: string; sessionId: string; sessionVersion: number }
const customerClaims = (n: number): Claims => ({ identityId: uuid(n, 7), sessionId: uuid(n, 8), sessionVersion: 1 })
let sqlite: DatabaseSync,
  database: D1Database,
  command = 0

beforeEach(async () => {
  ;({ sqlite, database } = await categoryCommandFixture())
  sqlite.exec(
    await readFile(
      new URL('../../db/d1/migrations/0147_category_merchandising_promo_fraud.sql', import.meta.url),
      'utf8'
    )
  )
  const past = utc(-86_400_000)
  for (const n of [1, 2, 3, 4, 5]) {
    sqlite.prepare('INSERT INTO customers(id,created_at,updated_at) VALUES(?,?,?)').run(`cust-${n}`, past, past)
    sqlite
      .prepare(
        "INSERT INTO identities(id,email,password_hash,email_verified_at,status,customer_id,created_at,updated_at) VALUES(?,?,'synthetic',?,'active',?,?,?)"
      )
      .run(uuid(n, 7), `c${n}@example.invalid`, past, `cust-${n}`, past, past)
    sqlite
      .prepare(
        'INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at) VALUES(?,?,1,1,?,?)'
      )
      .run(uuid(n, 8), uuid(n, 7), past, utc(3_600_000))
  }
  command = 0
})
afterEach(() => sqlite.close())

async function seedHold() {
  const assess = (n: number, ref: string) =>
    assessPromoFraud(
      database,
      {
        commandId: uuid(++command, 9),
        context: 'referral',
        refId: ref,
        customerId: `cust-${n}`,
        signals: { device: 'dev-H', payment: 'tok-H' }
      },
      { now: utc(), pepper: PEPPER }
    )
  for (const n of [1, 2, 3]) await assess(n, `seed-${n}`)
  return (await assess(4, 'held-ref')).case
}
const deps = (claims: Claims | null = CATEGORY_CLAIMS) => ({ database, origin, session: async () => claims })
function req(path: string, method = 'GET', body?: unknown, headers: Record<string, string | null> = {}) {
  const merged: Record<string, string | null> = {
    origin,
    'content-type': 'application/json',
    'cf-connecting-ip': '192.0.2.1',
    ...headers
  }
  return new Request(origin + path, {
    method,
    headers: Object.fromEntries(Object.entries(merged).filter(([, v]) => v !== null) as [string, string][]),
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) })
  })
}
const ADMIN = '/api/admin/promo-fraud/cases'
const MINE = '/api/account/promo-fraud/cases'
const decision = { expectedVersion: 1, outcome: 'release', note: 'Verificado: misma familia' }

describe('SEC-036 promo-fraud HTTP', () => {
  it('owns both namespaces, also when encoded', () => {
    for (const path of [
      ADMIN,
      MINE,
      '/api/admin/promo-fraud',
      '/api/admin/promo-fraud%2Fcases',
      '/api/account/promo-fraud/x',
      '/api/admin/promo%2Dfraud/cases'
    ])
      expect(ownsPromoFraudNamespace(path), path).toBe(true)
    expect(ownsPromoFraudNamespace('/api/admin/referrals')).toBe(false)
  })
  it('returns null for foreign paths', async () => {
    expect(await handlePromoFraudHttp(req('/api/other'), deps())).toBeNull()
  })
  it('lists and reads cases for an administrator with private headers', async () => {
    const c = await seedHold()
    const list = (await handlePromoFraudHttp(req(ADMIN + '?filter=pending'), deps()))!
    expect(list.status).toBe(200)
    expect(list.headers.get('cache-control')).toBe('private, no-store')
    expect((await list.json()) as { items: unknown[] }).toMatchObject({
      items: expect.arrayContaining([expect.objectContaining({ id: c.id })])
    })
    const one = (await handlePromoFraudHttp(req(`${ADMIN}/${c.id}`), deps()))!
    expect(one.status).toBe(200)
    expect(await one.json()).toMatchObject({ case: { id: c.id }, events: [{ action: 'assessed' }], appeal: null })
  })
  it('validates query strings and ids', async () => {
    expect((await handlePromoFraudHttp(req(ADMIN + '?filter=bad'), deps()))!.status).toBe(422)
    expect((await handlePromoFraudHttp(req(ADMIN + '?limit=0'), deps()))!.status).toBe(422)
    expect((await handlePromoFraudHttp(req(ADMIN + '?x=1'), deps()))!.status).toBe(422)
    expect((await handlePromoFraudHttp(req(ADMIN + '/not-a-uuid'), deps()))!.status).toBe(422)
    expect((await handlePromoFraudHttp(req(`${ADMIN}/${uuid(99)}`), deps()))!.status).toBe(404)
  })
  it('answers 401 anonymous, 403 customers and 403 mfa_required', async () => {
    await seedHold()
    expect((await handlePromoFraudHttp(req(ADMIN), deps(null)))!.status).toBe(401)
    const customer = (await handlePromoFraudHttp(req(ADMIN), deps(customerClaims(1))))!
    expect(customer.status).toBe(403)
    expect(await customer.json()).toEqual({ error: { code: 'forbidden' } })
    sqlite.prepare('UPDATE auth_sessions SET mfa_verified=0 WHERE id=?').run(CATEGORY_CLAIMS.sessionId)
    const weak = (await handlePromoFraudHttp(req(ADMIN), deps()))!
    expect(await weak.json()).toEqual({ error: { code: 'mfa_required' } })
  })
  it('releases a case with POST, then reports a stale version and a repeat', async () => {
    const c = await seedHold()
    const ok = (await handlePromoFraudHttp(req(`${ADMIN}/${c.id}/decision`, 'POST', decision), deps()))!
    expect(ok.status).toBe(200)
    expect(await ok.json()).toMatchObject({ case: { status: 'released', version: 2 } })
    const repeat = (await handlePromoFraudHttp(req(`${ADMIN}/${c.id}/decision`, 'POST', decision), deps()))!
    expect(repeat.status).toBe(200)
    const conflict = (await handlePromoFraudHttp(
      req(`${ADMIN}/${c.id}/decision`, 'POST', { ...decision, outcome: 'uphold' }),
      deps()
    ))!
    expect(conflict.status).toBe(409)
    expect(await conflict.json()).toEqual({ error: { code: 'invalid_transition' } })
  })
  it('rejects foreign or missing Origin and cross-site fetches on every mutation and read', async () => {
    const c = await seedHold()
    for (const headers of [{ origin: null }, { origin: 'https://evil.invalid' }, { 'sec-fetch-site': 'cross-site' }]) {
      const post = (await handlePromoFraudHttp(req(`${ADMIN}/${c.id}/decision`, 'POST', decision, headers), deps()))!
      expect(post.status).toBe(403)
      expect(await post.json()).toEqual({ error: { code: 'csrf_rejected' } })
    }
    const foreignGet = (await handlePromoFraudHttp(
      req(ADMIN, 'GET', undefined, { origin: 'https://evil.invalid' }),
      deps()
    ))!
    expect(foreignGet.status).toBe(403)
    expect(sqlite.prepare('SELECT status FROM promo_fraud_cases WHERE id=?').get(c.id)).toMatchObject({
      status: 'open'
    })
  })
  it('enforces methods, content type, body size and JSON syntax', async () => {
    const c = await seedHold()
    const path = `${ADMIN}/${c.id}/decision`
    const wrongMethod = (await handlePromoFraudHttp(req(path, 'GET'), deps()))!
    expect(wrongMethod.status).toBe(405)
    expect(wrongMethod.headers.get('allow')).toBe('POST')
    expect((await handlePromoFraudHttp(req(ADMIN, 'DELETE'), deps()))!.status).toBe(405)
    expect(
      (await handlePromoFraudHttp(req(path, 'POST', decision, { 'content-type': 'text/plain' }), deps()))!.status
    ).toBe(415)
    expect((await handlePromoFraudHttp(req(path, 'POST', '{bad'), deps()))!.status).toBe(400)
    expect(
      (await handlePromoFraudHttp(req(path, 'POST', { ...decision, note: 'x'.repeat(40_000) }), deps()))!.status
    ).toBe(413)
    expect((await handlePromoFraudHttp(req(path, 'POST', { ...decision, extra: 1 }), deps()))!.status).toBe(422)
  })
  it('rate limits mutations per identity', async () => {
    const c = await seedHold()
    let last: Response | undefined
    for (let i = 0; i < 61; i++)
      last = (await handlePromoFraudHttp(
        req(`${ADMIN}/${c.id}/decision`, 'POST', { ...decision, expectedVersion: 9 }),
        deps()
      ))!
    expect(last!.status).toBe(429)
    expect(last!.headers.get('retry-after')).toMatch(/^\d+$/)
  })
  it('lets the customer list and appeal their own case, and nobody else', async () => {
    const c = await seedHold()
    const mine = (await handlePromoFraudHttp(req(MINE), deps(customerClaims(4))))!
    expect(mine.status).toBe(200)
    const body = (await mine.json()) as { items: Array<Record<string, unknown>> }
    expect(body.items[0]).toMatchObject({ id: c.id, canAppeal: true })
    expect(JSON.stringify(body)).not.toMatch(/score|exceeded|customerId/)
    const appeal = { caseVersion: 1, statement: 'Somos hermanos y compartimos equipo y tarjeta.' }
    const other = (await handlePromoFraudHttp(req(`${MINE}/${c.id}/appeal`, 'POST', appeal), deps(customerClaims(5))))!
    expect(other.status).toBe(404)
    const ok = (await handlePromoFraudHttp(req(`${MINE}/${c.id}/appeal`, 'POST', appeal), deps(customerClaims(4))))!
    expect(ok.status).toBe(200)
    expect(await ok.json()).toMatchObject({ case: { status: 'appealed' } })
    const again = (await handlePromoFraudHttp(
      req(`${MINE}/${c.id}/appeal`, 'POST', { ...appeal, caseVersion: 2 }),
      deps(customerClaims(4))
    ))!
    expect(again.status).toBe(409)
    expect(await again.json()).toEqual({ error: { code: 'appeal_not_allowed' } })
  })
  it('does not trust a customer identity sent in the body or the query', async () => {
    const c = await seedHold()
    const bad = (await handlePromoFraudHttp(
      req(`${MINE}/${c.id}/appeal`, 'POST', {
        caseVersion: 1,
        statement: 'Somos hermanos y compartimos todo.',
        customerId: 'cust-4'
      }),
      deps(customerClaims(5))
    ))!
    expect(bad.status).toBe(422)
    expect((await handlePromoFraudHttp(req(MINE + '?customerId=cust-4'), deps(customerClaims(5))))!.status).toBe(422)
  })
  it('resolves an appeal through the admin route with four eyes', async () => {
    const c = await seedHold()
    await handlePromoFraudHttp(
      req(`${MINE}/${c.id}/appeal`, 'POST', { caseVersion: 1, statement: 'Somos hermanos y compartimos todo.' }),
      deps(customerClaims(4))
    )
    const ok = (await handlePromoFraudHttp(
      req(`${ADMIN}/${c.id}/appeal-resolution`, 'POST', {
        expectedVersion: 2,
        outcome: 'accept',
        note: 'Documentación suficiente'
      }),
      deps()
    ))!
    expect(ok.status).toBe(200)
    expect(await ok.json()).toMatchObject({ case: { status: 'appeal_accepted', appealStatus: 'accepted' } })
  })
  it('is reachable through the real Worker, not shadowed by an earlier router', async () => {
    const c = await seedHold()
    const password = 'synthetic-promo-fraud-cookie-secret-over-32-characters'
    const cookie = async (claims: Claims) =>
      (await issueD1SessionCookie(database, claims, { password, maxAgeSeconds: 3600 }))!.split(';')[0]!
    const env = {
      APP_ENV: 'local',
      AUTH_ENABLED: 'true',
      AUTH_ORIGIN: origin,
      NUXT_SESSION_PASSWORD: password,
      AUTH_RATE_LIMIT_PEPPER: 'synthetic-rate-limit-pepper-over-32',
      ADMIN_EDGE_LIMIT: { limit: async () => ({ success: true }) },
      CART_EDGE_LIMIT: { limit: async () => ({ success: true }) },
      AUTH_EDGE_LIMIT: { limit: async () => ({ success: true }) },
      DB: database
    } as unknown as CloudflareEnv
    const admin = await worker.fetch(req(ADMIN, 'GET', undefined, { cookie: await cookie(CATEGORY_CLAIMS) }), env)
    expect(admin.status).toBe(200)
    expect(await admin.json()).toMatchObject({ items: expect.any(Array) })
    const mine = await worker.fetch(req(MINE, 'GET', undefined, { cookie: await cookie(customerClaims(4)) }), env)
    expect(mine.status).toBe(200)
    expect((await worker.fetch(req(ADMIN), env)).status).toBe(401)
    expect((await worker.fetch(req(MINE), env)).status).toBe(401)
    const foreign = await worker.fetch(
      req(
        `${MINE}/${c.id}/appeal`,
        'POST',
        { caseVersion: 1, statement: 'Somos hermanos y compartimos todo.' },
        { cookie: await cookie(customerClaims(4)), origin: 'https://evil.invalid' }
      ),
      env
    )
    expect(foreign.status).toBe(403)
    expect((await worker.fetch(req(ADMIN), { ...env, AUTH_ENABLED: 'false' })).status).toBe(503)
  })
})

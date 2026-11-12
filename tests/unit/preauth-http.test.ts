import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fakePreauthProvider, ORIGIN, payExtFixture, redsysConfig, signedEnvelope, utc } from './pay-ext-fixture'
import { BUYER_CLAIMS, CLAIMS } from './d1-returns-fixture'
import {
  handlePreauthHttp,
  ownsPreauthNamespace,
  type PreauthHttpDependencies
} from '../../workers/payments/preauth-http'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import { createBoundPreauthProvider, configuredPreauth } from '../../workers/payments/preauth-runtime'
import { testUuid } from '../support/deterministic'

const cookieConfig = { password: 'synthetic-preauth-cookie-password-over-32-characters', maxAgeSeconds: 3600 }
let f: Awaited<ReturnType<typeof payExtFixture>>
let provider: ReturnType<typeof fakePreauthProvider>
beforeEach(async () => {
  f = await payExtFixture()
  provider = fakePreauthProvider()
  f.sqlite.exec(`UPDATE auth_sessions SET expires_at='${utc(86_400_000)}'`)
})
afterEach(() => f?.sqlite.close())

const deps = (over: Partial<PreauthHttpDependencies> = {}): PreauthHttpDependencies => ({
  preauth: { database: f.database, configuration: redsysConfig, provider, inventory: f.inventory, now: () => utc() },
  database: f.database,
  origin: ORIGIN,
  sessionCookieConfiguration: cookieConfig,
  ...over
})
async function cookie(claims = CLAIMS) {
  return (await issueD1SessionCookie(f.database, claims, cookieConfig))!.split(';')[0]!
}
async function call(
  path: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string>; claims?: typeof CLAIMS | null } = {},
  d = deps()
) {
  const method = init.method ?? 'GET'
  const headers: Record<string, string> = { ...(init.headers ?? {}) }
  if (init.claims !== null) headers.cookie = await cookie(init.claims ?? CLAIMS)
  if (method === 'POST') {
    headers['content-type'] ??= 'application/json'
    headers.origin ??= ORIGIN
  }
  return handlePreauthHttp(
    new Request(`${ORIGIN}${path}`, {
      method,
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body)
    }),
    d
  )
}
async function orderWithTotal() {
  const { orderId } = await f.unpaid()
  const total = (f.sqlite.prepare('SELECT total_gross_cents t FROM orders WHERE id=?').get(orderId) as { t: number }).t
  return { orderId, total }
}
const body = (orderId: string, total: number, commandId = testUuid()) => ({
  orderId,
  commandId,
  reasonCode: 'made_to_order',
  justification: 'Made-to-order dilution needs a hold until the batch is confirmed',
  expectedAmountCents: total
})

describe('admin preauthorisation API', () => {
  it('runs request, notification, capture end to end over HTTP', async () => {
    const { orderId, total } = await orderWithTotal()
    const created = (await call('/api/admin/payments/preauthorizations', {
      method: 'POST',
      body: body(orderId, total)
    }))!
    expect(created.status).toBe(201)
    expect(created.headers.get('cache-control')).toContain('no-store')
    const view = await created.json()
    const row = f.sqlite.prepare('SELECT merchant_order m, amount_cents a FROM payment_preauths').get() as {
      m: string
      a: number
    }
    const env = await signedEnvelope(row.m, row.a, { type: '1' })
    const notify = (await handlePreauthHttp(
      new Request(`${ORIGIN}/api/payments/redsys/preauth-notification`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(env).toString()
      }),
      deps()
    ))!
    expect(notify.status).toBe(200)
    expect(await notify.text()).toBe('OK')
    const read = await (await call(`/api/admin/payments/preauthorizations/${view.id}`))!.json()
    expect(read.status).toBe('authorized')
    const capture = (await call(`/api/admin/payments/preauthorizations/${view.id}/capture`, {
      method: 'POST',
      body: { commandId: testUuid(), expectedVersion: read.version }
    }))!
    expect(capture.status).toBe(200)
    expect(await capture.json()).toMatchObject({ status: 'captured' })
    const list = await (await call(`/api/admin/payments/preauthorizations?orderId=${orderId}`))!.json()
    expect(list.preauthorizations).toHaveLength(1)
  })
  it('rejects unauthenticated, forged-cookie, customer and no-MFA callers', async () => {
    const { orderId, total } = await orderWithTotal()
    const req = { method: 'POST', body: body(orderId, total) }
    expect((await call('/api/admin/payments/preauthorizations', { ...req, claims: null }))!.status).toBe(401)
    expect(
      (await call('/api/admin/payments/preauthorizations', {
        ...req,
        claims: null,
        headers: { cookie: 'neteco-session=forged' }
      }))!.status
    ).toBe(401)
    f.sqlite.exec(
      `INSERT OR IGNORE INTO identity_mfa(identity_id,encrypted_secret,recovery_code_hashes,verified_at,updated_at) VALUES('${BUYER_CLAIMS.identityId}','x','[]','${utc(-1000)}','${utc(-1000)}')`
    )
    expect((await call('/api/admin/payments/preauthorizations', { ...req, claims: BUYER_CLAIMS }))!.status).toBe(403)
    f.sqlite.exec('UPDATE auth_sessions SET mfa_verified=0')
    expect((await call('/api/admin/payments/preauthorizations', req))!.status).toBe(403)
    expect(f.sqlite.prepare('SELECT count(*) n FROM payment_preauths').get()).toMatchObject({ n: 0 })
  })
  it('refuses foreign-origin and cross-site mutations before touching the database', async () => {
    const { orderId, total } = await orderWithTotal()
    const make = (headers: Record<string, string>) =>
      call('/api/admin/payments/preauthorizations', { method: 'POST', body: body(orderId, total), headers })
    expect((await make({ origin: 'https://evil.example' }))!.status).toBe(403)
    expect((await make({ origin: ORIGIN, 'sec-fetch-site': 'cross-site' }))!.status).toBe(403)
    const noOrigin = await handlePreauthHttp(
      new Request(`${ORIGIN}/api/admin/payments/preauthorizations`, {
        method: 'POST',
        headers: { cookie: await cookie(), 'content-type': 'application/json' },
        body: JSON.stringify(body(orderId, total))
      }),
      deps()
    )
    expect(noOrigin!.status).toBe(403)
    expect(f.sqlite.prepare('SELECT count(*) n FROM payment_preauths').get()).toMatchObject({ n: 0 })
  })
  it('validates content type, body, query, idempotency header and methods', async () => {
    const { orderId, total } = await orderWithTotal()
    const path = '/api/admin/payments/preauthorizations'
    expect(
      (await call(path, { method: 'POST', body: body(orderId, total), headers: { 'content-type': 'text/plain' } }))!
        .status
    ).toBe(415)
    expect((await call(path, { method: 'POST', body: { ...body(orderId, total), amountCents: 1 } }))!.status).toBe(400)
    expect(
      (await call(path, {
        method: 'POST',
        body: body(orderId, total),
        headers: { 'idempotency-key': testUuid() }
      }))!.status
    ).toBe(400)
    expect((await call(`${path}?x=1`, { method: 'POST', body: body(orderId, total) }))!.status).toBe(400)
    expect((await call(path, { method: 'DELETE' }))!.status).toBe(405)
    expect((await call(`${path}/not-a-uuid`))!.status).toBe(404)
    expect((await call(`${path}?orderId=${orderId}&x=1`))!.status).toBe(400)
    expect(
      (await call(path, { method: 'POST', body: body(orderId, total), headers: { 'content-length': '9999' } }))!.status
    ).toBeGreaterThanOrEqual(400)
  })
  it('is unreachable when the feature is off and owns encoded variants of its namespace', async () => {
    const res = (await call(
      '/api/admin/payments/preauthorizations',
      { method: 'POST', body: {} },
      deps({ preauth: null })
    ))!
    expect(res.status).toBe(503)
    expect(ownsPreauthNamespace('/api/admin/payments/preauthorizations')).toBe(true)
    expect(ownsPreauthNamespace('/api/admin/payments/preauthorizations/x')).toBe(true)
    expect(ownsPreauthNamespace('/api/admin/payments/%70reauthorizations/x')).toBe(true)
    expect(ownsPreauthNamespace('/api/admin/payments/funnel')).toBe(false)
    expect(await handlePreauthHttp(new Request(`${ORIGIN}/api/other`), deps())).toBeNull()
  })
  it('maps domain errors to stable codes', async () => {
    const { orderId, total } = await orderWithTotal()
    const first = body(orderId, total)
    await call('/api/admin/payments/preauthorizations', { method: 'POST', body: first })
    const dup = (await call('/api/admin/payments/preauthorizations', { method: 'POST', body: body(orderId, total) }))!
    expect(dup.status).toBe(409)
    expect(await dup.json()).toEqual({ error: { code: 'conflict' } })
    const missing = (await call(`/api/admin/payments/preauthorizations/${testUuid()}`))!
    expect(missing.status).toBe(404)
  })
})

describe('notification route', () => {
  const post = (form: URLSearchParams | string, type = 'application/x-www-form-urlencoded') =>
    handlePreauthHttp(
      new Request(`${ORIGIN}/api/payments/redsys/preauth-notification`, {
        method: 'POST',
        headers: { 'content-type': type },
        body: form.toString()
      }),
      deps()
    )
  it('rejects wrong methods, types, extra or duplicated fields and bad signatures', async () => {
    expect(
      (await handlePreauthHttp(new Request(`${ORIGIN}/api/payments/redsys/preauth-notification`), deps()))!.status
    ).toBe(405)
    expect((await post('a=b', 'application/json'))!.status).toBe(400)
    const env = await signedEnvelope('1234ABCDEFGH', 100, { type: '1' })
    expect((await post(new URLSearchParams({ ...env, extra: '1' })))!.status).toBe(400)
    const dup = new URLSearchParams(env)
    dup.append('Ds_Signature', env.Ds_Signature)
    expect((await post(dup))!.status).toBe(400)
    expect((await post(new URLSearchParams({ ...env, Ds_Signature: 'AAAA' })))!.status).toBe(400)
    expect((await post(new URLSearchParams(env)))!.status).toBe(400) // unknown merchant order
  })
  it('does not acknowledge a notification that is not locally finished', async () => {
    const { orderId, total } = await orderWithTotal()
    await call('/api/admin/payments/preauthorizations', { method: 'POST', body: body(orderId, total) })
    const row = f.sqlite.prepare('SELECT merchant_order m, amount_cents a FROM payment_preauths').get() as {
      m: string
      a: number
    }
    const broken = deps()
    broken.preauth = {
      ...broken.preauth!,
      inventory: {
        ...f.inventory,
        renew: async () => {
          throw new Error('down')
        }
      }
    }
    const res = await handlePreauthHttp(
      new Request(`${ORIGIN}/api/payments/redsys/preauth-notification`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(await signedEnvelope(row.m, row.a, { type: '1' })).toString()
      }),
      broken
    )
    expect(res!.status).toBe(503)
  })
})

describe('runtime and provider contract', () => {
  it('is off unless flag, configuration, inventory and provider binding are all present', () => {
    const base = {
      DB: f.database,
      INVENTORY: {} as DurableObjectNamespace,
      PAYMENT_PREAUTH_SERVICE: { fetch: async () => new Response() }
    }
    const now = () => utc()
    expect(configuredPreauth({ ...base }, redsysConfig, now)).toBeNull()
    expect(configuredPreauth({ ...base, PAYMENT_PREAUTH_ENABLED: 'true' }, null, now)).toBeNull()
    expect(
      configuredPreauth(
        { ...base, PAYMENT_PREAUTH_ENABLED: 'true', PAYMENT_PREAUTH_SERVICE: undefined },
        redsysConfig,
        now
      )
    ).toBeNull()
    expect(
      configuredPreauth({ ...base, PAYMENT_PREAUTH_ENABLED: 'true', INVENTORY: undefined }, redsysConfig, now)
    ).toBeNull()
    expect(configuredPreauth({ ...base, PAYMENT_PREAUTH_ENABLED: 'true' }, redsysConfig, now)).not.toBeNull()
  })
  it('validates provider responses and treats malformed ones as unavailable', async () => {
    const answer = (value: unknown, type = 'application/json') => ({
      fetch: async () =>
        new Response(typeof value === 'string' ? value : JSON.stringify(value), { headers: { 'content-type': type } })
    })
    const input = { preauthId: 'p', merchantOrder: '1234ABCD', amountCents: 5, idempotencyKey: 'k' }
    expect(
      await createBoundPreauthProvider(answer({ outcome: 'captured', providerReference: 'r' })).capture(input)
    ).toEqual({ outcome: 'captured', providerReference: 'r' })
    expect(await createBoundPreauthProvider(answer({ outcome: 'cancelled' })).cancel(input)).toEqual({
      outcome: 'cancelled'
    })
    for (const bad of [
      { outcome: 'captured', extra: 1 },
      { outcome: 'weird' },
      'not json',
      { outcome: 'captured', responseCode: 'xx' }
    ])
      await expect(createBoundPreauthProvider(answer(bad)).capture(input)).rejects.toThrow()
    await expect(
      createBoundPreauthProvider(answer({ outcome: 'captured' }, 'text/plain')).capture(input)
    ).rejects.toThrow()
    await expect(
      createBoundPreauthProvider({
        fetch: async () => new Response('x'.repeat(5000), { headers: { 'content-type': 'application/json' } })
      }).capture(input)
    ).rejects.toThrow()
    await expect(
      createBoundPreauthProvider({
        fetch: async () => new Response('{}', { status: 500, headers: { 'content-type': 'application/json' } })
      }).cancel(input)
    ).rejects.toThrow()
  })
})

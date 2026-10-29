import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { deterministicUuid } from '../fixtures/deterministic'
import {
  lifecycleFixture,
  CLAIMS,
  AGENT_CLAIMS,
  NOW,
  COMPANY,
  CUSTOMER,
  TICKET,
  OTHER_CLAIMS
} from './account-lifecycle-fixture'
import { handleAccountLifecycleHttp, ownsAccountLifecycleNamespace } from '../../workers/auth/account-lifecycle-http'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import { PREFERENCE_CENTER_POLICY_VERSION as POLICY } from '../../shared/preference-center'

let f: Awaited<ReturnType<typeof lifecycleFixture>>
const origin = 'https://lifecycle.neteco.test',
  configuration = { password: 'synthetic-lifecycle-cookie-secret-more32', maxAgeSeconds: 3600 }
let cookie: string, agentCookie: string, otherCookie: string
let limiterAllows = true
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(NOW))
  limiterAllows = true
  f = await lifecycleFixture()
  f.grantImpersonation()
  cookie = (await issueD1SessionCookie(f.database, CLAIMS, configuration))!.split(';')[0]!
  agentCookie = (await issueD1SessionCookie(f.database, AGENT_CLAIMS, configuration))!.split(';')[0]!
  otherCookie = (await issueD1SessionCookie(f.database, OTHER_CLAIMS, configuration))!.split(';')[0]!
})
afterEach(() => {
  f.sqlite.close()
  vi.useRealTimers()
})
const limiter = () => ({ limit: async () => ({ success: limiterAllows }) }) as unknown as RateLimit
const deps = () => ({
  database: f.database,
  sessionCookieConfiguration: configuration,
  origin,
  customerEdgeLimiter: limiter(),
  adminEdgeLimiter: limiter(),
  rateLimitPepper: 'synthetic-lifecycle-edge-pepper-more32',
  now: () => NOW
})
const key = (n: string) => deterministicUuid(`http-${n}`)
function call(
  path: string,
  init: { method?: string; body?: unknown; cookie?: string; key?: string | null; headers?: Record<string, string> } = {}
) {
  const method = init.method ?? 'GET'
  const headers: Record<string, string> = {
    cookie: init.cookie ?? cookie,
    'CF-Connecting-IP': '192.0.2.44',
    ...(method !== 'GET' ? { origin, 'Content-Type': 'application/json' } : {}),
    ...(init.key !== null && method !== 'GET' && method !== 'DELETE'
      ? { 'Idempotency-Key': init.key ?? key(path + method) }
      : {}),
    ...init.headers
  }
  return handleAccountLifecycleHttp(
    new Request(origin + path, {
      method,
      headers,
      body: init.body === undefined ? undefined : typeof init.body === 'string' ? init.body : JSON.stringify(init.body)
    }),
    deps()
  )
}
const prefs = {
  expectedVersion: 0,
  policyVersion: POLICY,
  acknowledged: true,
  preferences: {
    frequency: 'monthly',
    topics: ['offers'],
    sectors: ['home'],
    channels: { email: true, sms: false, push: false },
    unsubscribeAll: false
  }
}
const doc = {
  kind: 'tax_certificate',
  fileName: 'cert.pdf',
  contentType: 'application/pdf',
  sizeBytes: 1000,
  sha256: 'a'.repeat(64)
}

describe('namespace ownership', () => {
  it.each([
    ['/api/account/preference-center', true],
    ['/api/account/preference-center/', true],
    ['/api/account/replenishment/plans', true],
    ['/api/account/company/documents/x', true],
    ['/api/account/%70reference-center', true],
    ['/api/account/%2570reference-center', true],
    ['/api/admin/support-impersonation/current', true],
    ['/api/admin/support-impersonation%2Fcurrent', true],
    ['/api/admin/companies/abc/documents', true],
    ['/api/admin/companies', false],
    ['/api/account/preferences', false]
  ])('%s -> %s', (path, expected) => {
    // Percent-encoded letters that decode into the prefix are claimed too.
    expect(ownsAccountLifecycleNamespace(path)).toBe(expected)
  })
  it('returns null for foreign paths and 404 for unknown paths inside the namespace', async () => {
    expect(await call('/api/account/preferences')).toBeNull()
    expect((await call('/api/account/replenishment/nope'))!.status).toBe(404)
  })
})

describe('transport guards', () => {
  it('sets private no-store headers and rejects anonymous callers', async () => {
    const response = (await call('/api/account/preference-center', { cookie: 'x=y' }))!
    expect(response.status).toBe(401)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
  })
  it('rejects wrong methods with Allow, query strings, cross-site and missing origin on writes', async () => {
    const wrong = (await call('/api/account/replenishment', { method: 'POST', body: {} }))!
    expect(wrong.status).toBe(405)
    expect(wrong.headers.get('allow')).toBe('GET')
    expect((await call('/api/account/preference-center?x=1'))!.status).toBe(400)
    expect(
      (await call('/api/account/preference-center', { headers: { 'sec-fetch-site': 'cross-site' } }))!.status
    ).toBe(403)
    expect(
      (await call('/api/account/preference-center', {
        method: 'PUT',
        body: prefs,
        headers: { origin: 'https://evil.example' }
      }))!.status
    ).toBe(403)
    const noOrigin = new Request(origin + '/api/account/preference-center', {
      method: 'PUT',
      headers: { cookie, 'Content-Type': 'application/json', 'Idempotency-Key': key('o') },
      body: JSON.stringify(prefs)
    })
    expect((await handleAccountLifecycleHttp(noOrigin, deps()))!.status).toBe(403)
  })
  it('requires a valid Idempotency-Key, JSON content type and a bounded body', async () => {
    expect((await call('/api/account/preference-center', { method: 'PUT', body: prefs, key: null }))!.status).toBe(400)
    expect((await call('/api/account/preference-center', { method: 'PUT', body: prefs, key: 'nope' }))!.status).toBe(
      400
    )
    expect(
      (await call('/api/account/preference-center', {
        method: 'PUT',
        body: prefs,
        headers: { 'Content-Type': 'text/plain' }
      }))!.status
    ).toBe(400)
    expect((await call('/api/account/preference-center', { method: 'PUT', body: '{not json' }))!.status).toBe(400)
    expect(
      (await call('/api/account/preference-center', {
        method: 'PUT',
        body: JSON.stringify({ pad: 'x'.repeat(5000) })
      }))!.status
    ).toBe(400)
  })
  it('maps edge limiter denial to 429 with Retry-After', async () => {
    limiterAllows = false
    const response = (await call('/api/account/preference-center'))!
    expect(response.status).toBe(429)
    expect(response.headers.get('retry-after')).toBe('60')
  })
})

describe('CUS-015/019/016 customer endpoints', () => {
  it('reads defaults then saves, replays and detects stale writes on the preference centre', async () => {
    expect(await (await call('/api/account/preference-center'))!.json()).toMatchObject({ version: 0 })
    const saved = (await call('/api/account/preference-center', { method: 'PUT', body: prefs, key: key('pc') }))!
    expect(saved.status).toBe(200)
    const receipt = await saved.json()
    expect(receipt).toMatchObject({ version: 1, sync: { esp: 'pending', cmp: 'pending' } })
    expect(
      await (await call('/api/account/preference-center', { method: 'PUT', body: prefs, key: key('pc') }))!.json()
    ).toEqual(receipt)
    expect(
      (await call('/api/account/preference-center', { method: 'PUT', body: prefs, key: key('pc2') }))!.status
    ).toBe(409)
    expect(
      await (await call('/api/account/preference-center', {
        method: 'PUT',
        body: {
          ...prefs,
          expectedVersion: 1,
          acknowledged: false,
          preferences: { ...prefs.preferences, topics: ['offers', 'usage_tips'] }
        },
        key: key('pc3')
      }))!.json()
    ).toEqual({ error: { code: 'consent_required' } })
    expect(
      (await call('/api/account/preference-center', {
        method: 'PUT',
        body: { ...prefs, preferences: { ...prefs.preferences, frequency: 'daily' } },
        key: key('pc4')
      }))!.status
    ).toBe(400)
  })
  it('keeps each customer on their own preference centre', async () => {
    await call('/api/account/preference-center', { method: 'PUT', body: prefs })
    expect(await (await call('/api/account/preference-center', { cookie: otherCookie }))!.json()).toMatchObject({
      version: 0
    })
  })
  it('creates and lists replenishment plans', async () => {
    const created = (await call('/api/account/replenishment/plans', {
      method: 'POST',
      body: { variantId: 'v-1-1', action: 'save', expectedVersion: 0, source: 'declared', intervalDays: 30 }
    }))!
    expect(created.status).toBe(200)
    expect(await created.json()).toMatchObject({ variantId: 'v-1-1', status: 'active' })
    expect(await (await call('/api/account/replenishment'))!.json()).toMatchObject({
      plans: [{ sku: 'SKU-1-1' }],
      cap: { maxQueued: 1, windowDays: 7 }
    })
    expect(
      (await call('/api/account/replenishment/plans', {
        method: 'POST',
        body: { variantId: 'v-1-1', action: 'save', expectedVersion: 0, source: 'history' },
        key: key('h')
      }))!.status
    ).toBe(409)
    expect(
      (await call('/api/account/replenishment/plans', {
        method: 'POST',
        body: { variantId: 'v-9-9', action: 'save', expectedVersion: 0, source: 'declared', intervalDays: 30 },
        key: key('nf')
      }))!.status
    ).toBe(404)
    expect(
      (await call('/api/account/replenishment/plans', {
        method: 'POST',
        body: { variantId: 'v-2-1', action: 'save', expectedVersion: 0, source: 'history' },
        key: key('ih')
      }))!.status
    ).toBe(422)
  })
  it('adds, lists and removes company documents', async () => {
    const added = (await call('/api/account/company/documents', { method: 'POST', body: doc }))!
    expect(added.status).toBe(201)
    const created = (await added.json()) as { id: string }
    expect(await (await call('/api/account/company/documents'))!.json()).toMatchObject({
      companyStatus: 'pending',
      documents: [{ id: created.id }]
    })
    expect(
      (await call(`/api/account/company/documents/${created.id}`, { method: 'DELETE', cookie: otherCookie }))!.status
    ).toBe(404)
    expect(
      await (await call(`/api/account/company/documents/${created.id}`, { method: 'DELETE' }))!.json()
    ).toMatchObject({ status: 'removed' })
    expect(
      (await call('/api/account/company/documents', { method: 'POST', body: { ...doc, content: 'AAAA' } }))!.status
    ).toBe(400)
  })
})

describe('CUS-016 admin review and CUS-028 impersonation endpoints', () => {
  const start = {
    customerId: CUSTOMER,
    ticketRef: TICKET,
    reason: 'Reproducir el fallo reportado por el cliente',
    minutes: 5
  }
  it('lets an authorised reviewer read the documents of a company and refuses customers', async () => {
    f.row(`INSERT INTO roles VALUES('r-admin','Admin','S'); INSERT OR IGNORE INTO permissions VALUES('administration.manage','administration','manage','S');
 INSERT INTO role_permissions VALUES('r-admin','administration.manage'); INSERT INTO identity_roles(identity_id,role_code,granted_at) VALUES('${AGENT_CLAIMS.identityId}','r-admin','2020-01-01T00:00:00Z')`)
    await call('/api/account/company/documents', { method: 'POST', body: doc })
    const response = (await call(`/api/admin/companies/${COMPANY}/documents`, { cookie: agentCookie }))!
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ companyId: COMPANY, documents: [{ status: 'active' }] })
    expect((await call(`/api/admin/companies/${COMPANY}/documents`))!.status).toBe(403)
  })
  it('runs the whole impersonation lifecycle with banner data and a complete log', async () => {
    const started = (await call('/api/admin/support-impersonation', {
      method: 'POST',
      body: start,
      cookie: agentCookie
    }))!
    expect(started.status).toBe(201)
    const session = (await started.json()) as { id: string; banner: string }
    expect(session.banner).toContain('Suplantación de soporte activa')
    expect(
      await (await call('/api/admin/support-impersonation/current', { cookie: agentCookie }))!.json()
    ).toMatchObject({ session: { id: session.id, status: 'active' } })
    const base = `/api/admin/support-impersonation/${session.id}`
    expect(
      (await call(`${base}/actions`, {
        method: 'POST',
        body: { action: 'view_orders' },
        cookie: agentCookie,
        key: key('a1')
      }))!.status
    ).toBe(201)
    const blocked = (await call(`${base}/actions`, {
      method: 'POST',
      body: { action: 'pay_order' },
      cookie: agentCookie,
      key: key('a2')
    }))!
    expect(blocked.status).toBe(403)
    expect(await blocked.json()).toMatchObject({
      error: { code: 'action_blocked' },
      result: { outcome: 'blocked', reason: 'sensitive_payment' }
    })
    expect((await call(`${base}/end`, { method: 'POST', body: {}, cookie: agentCookie, key: null }))!.status).toBe(200)
    const log = (await (await call(`${base}/actions`, { cookie: agentCookie }))!.json()) as {
      actions: { action: string }[]
    }
    expect(log.actions.map((a) => a.action)).toEqual(['session.start', 'view_orders', 'pay_order', 'session.end'])
    expect(await (await call('/api/admin/support-impersonation/current', { cookie: agentCookie }))!.json()).toEqual({
      source: 'cloudflare',
      session: null
    })
  })
  it('denies impersonation to customers and to agents without the permission', async () => {
    expect((await call('/api/admin/support-impersonation', { method: 'POST', body: start }))!.status).toBe(403)
    f.row("DELETE FROM role_permissions WHERE permission_code='support.impersonate'")
    expect(
      (await call('/api/admin/support-impersonation', { method: 'POST', body: start, cookie: agentCookie }))!.status
    ).toBe(403)
  })
  it('validates the session id shape and rejects invalid start payloads', async () => {
    expect(
      (await call('/api/admin/support-impersonation/not-a-uuid/end', {
        method: 'POST',
        body: {},
        cookie: agentCookie
      }))!.status
    ).toBe(404)
    expect(
      (await call('/api/admin/support-impersonation', {
        method: 'POST',
        body: { ...start, minutes: 60 },
        cookie: agentCookie
      }))!.status
    ).toBe(400)
  })
})

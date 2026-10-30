import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { returnsFixture, BUYER_CLAIMS, CUSTOMER, utc } from './d1-returns-fixture'
import worker from '../../workers/canary'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import {
  handleQuickOrderCompanyHttp,
  ownsQuickOrderCompanyNamespace
} from '../../workers/catalog/quick-order-company-http'

const origin = 'https://quick.neteco.test',
  companyId = '30000000-0000-4000-8000-000000000098',
  PATH = '/api/account/quick-order/company'
async function world(status = 'approved') {
  const f = await returnsFixture(),
    before = utc(-60000)
  f.sqlite.exec(await readFile('db/d1/migrations/0101_b2b_price_lists_credit.sql', 'utf8'))
  f.sqlite
    .prepare(
      "INSERT INTO companies(id,customer_id,legal_name,status,created_at,updated_at) VALUES(?,?,'Empresa',?,?,?)"
    )
    .run(companyId, CUSTOMER, status, before, before)
  const deps = { database: f.database, origin, session: async () => BUYER_CLAIMS as typeof BUYER_CLAIMS | null }
  return { ...f, deps }
}
const body = { lines: [{ reference: 'SKU-2-1', quantity: 2 }] }
function post(payload: unknown = body, headers: Record<string, string | null> = {}, path = PATH, raw?: string) {
  const merged: Record<string, string | null> = {
    origin,
    'content-type': 'application/json',
    'cf-connecting-ip': '192.0.2.1',
    ...headers
  }
  return new Request(origin + path, {
    method: 'POST',
    headers: Object.fromEntries(Object.entries(merged).filter(([, v]) => v !== null) as [string, string][]),
    body: raw ?? JSON.stringify(payload)
  })
}

describe('SEA-018 company quick-order HTTP', () => {
  it('owns the namespace, including encoded variants', () => {
    expect(ownsQuickOrderCompanyNamespace(PATH)).toBe(true)
    expect(ownsQuickOrderCompanyNamespace(PATH + '/')).toBe(true)
    expect(ownsQuickOrderCompanyNamespace('/api/account/quick-order%2Fcompany')).toBe(true)
    expect(ownsQuickOrderCompanyNamespace('/api/account/quick-order%252Fcompany')).toBe(true)
    expect(ownsQuickOrderCompanyNamespace('/api/account/b2b')).toBe(false)
  })
  it('returns null for foreign paths', async () => {
    const f = await world()
    try {
      expect(await handleQuickOrderCompanyHttp(post(body, {}, '/api/other'), f.deps)).toBeNull()
    } finally {
      f.sqlite.close()
    }
  })
  it('resolves lines privately and without caching', async () => {
    const f = await world()
    try {
      const res = (await handleQuickOrderCompanyHttp(post(), f.deps))!
      expect(res.status).toBe(200)
      expect(res.headers.get('cache-control')).toBe('private, no-store')
      expect(res.headers.get('vary')).toMatch(/cookie/i)
      expect(await res.json()).toMatchObject({ companyId, lines: [{ status: 'ready', variantId: 'v-2-1' }] })
    } finally {
      f.sqlite.close()
    }
  })
  it('rejects a missing or foreign Origin and cross-site fetches', async () => {
    const f = await world()
    try {
      for (const headers of [
        { origin: null },
        { origin: 'https://evil.invalid' },
        { 'sec-fetch-site': 'cross-site' }
      ]) {
        const res = (await handleQuickOrderCompanyHttp(post(body, headers), f.deps))!
        expect(res.status).toBe(403)
        expect(await res.json()).toEqual({ error: { code: 'csrf_rejected' } })
      }
    } finally {
      f.sqlite.close()
    }
  })
  it('requires a session and a company', async () => {
    const f = await world()
    try {
      const anonymous = (await handleQuickOrderCompanyHttp(post(), { ...f.deps, session: async () => null }))!
      expect(anonymous.status).toBe(401)
    } finally {
      f.sqlite.close()
    }
    for (const [status, http, code] of [
      ['pending', 403, 'company_not_approved'],
      ['suspended', 403, 'company_not_approved']
    ] as const) {
      const g = await world(status)
      try {
        const res = (await handleQuickOrderCompanyHttp(post(), g.deps))!
        expect(res.status).toBe(http)
        expect(await res.json()).toEqual({ error: { code } })
      } finally {
        g.sqlite.close()
      }
    }
  })
  it('answers 403 not_company for a customer without a company', async () => {
    const f = await world()
    try {
      f.sqlite.exec('DELETE FROM companies')
      const res = (await handleQuickOrderCompanyHttp(post(), f.deps))!
      expect(res.status).toBe(403)
      expect(await res.json()).toEqual({ error: { code: 'not_company' } })
    } finally {
      f.sqlite.close()
    }
  })
  it('rejects wrong methods, query strings, content types, malformed and oversized bodies', async () => {
    const f = await world()
    try {
      const get = (await handleQuickOrderCompanyHttp(new Request(origin + PATH, { headers: { origin } }), f.deps))!
      expect(get.status).toBe(405)
      expect(get.headers.get('allow')).toBe('POST')
      expect((await handleQuickOrderCompanyHttp(post(body, {}, PATH + '?companyId=x'), f.deps))!.status).toBe(400)
      expect((await handleQuickOrderCompanyHttp(post(body, { 'content-type': 'text/plain' }), f.deps))!.status).toBe(
        415
      )
      expect((await handleQuickOrderCompanyHttp(post(undefined, {}, PATH, '{nope'), f.deps))!.status).toBe(400)
      const huge = { lines: [{ reference: 'A'.repeat(200_000), quantity: 1 }] }
      expect((await handleQuickOrderCompanyHttp(post(huge), f.deps))!.status).toBe(413)
      expect((await handleQuickOrderCompanyHttp(post({ lines: [] }), f.deps))!.status).toBe(422)
      expect((await handleQuickOrderCompanyHttp(post({ ...body, companyId }), f.deps))!.status).toBe(422)
    } finally {
      f.sqlite.close()
    }
  })
  it('rate limits per identity with a stable error', async () => {
    const f = await world()
    try {
      let last: Response | undefined
      for (let i = 0; i < 121; i++) last = (await handleQuickOrderCompanyHttp(post(), f.deps))!
      expect(last!.status).toBe(429)
      expect(last!.headers.get('retry-after')).toMatch(/^\d+$/)
      expect(await last!.json()).toEqual({ error: { code: 'rate_limited' } })
    } finally {
      f.sqlite.close()
    }
  })
  it('is reachable through the real Worker (not shadowed) and respects AUTH_ENABLED', async () => {
    const f = await world()
    try {
      const password = 'synthetic-quick-order-cookie-secret-over-32-characters'
      const cookie = (await issueD1SessionCookie(f.database, BUYER_CLAIMS, { password, maxAgeSeconds: 3600 }))!.split(
        ';'
      )[0]!
      const env = {
        APP_ENV: 'local',
        AUTH_ENABLED: 'true',
        AUTH_ORIGIN: origin,
        NUXT_SESSION_PASSWORD: password,
        AUTH_RATE_LIMIT_PEPPER: 'synthetic-rate-limit-pepper-over-32',
        ADMIN_EDGE_LIMIT: { limit: async () => ({ success: true }) },
        CART_EDGE_LIMIT: { limit: async () => ({ success: true }) },
        AUTH_EDGE_LIMIT: { limit: async () => ({ success: true }) },
        DB: f.database
      } as unknown as CloudflareEnv
      const res = await worker.fetch(post(body, { cookie }), env)
      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({ lines: [{ status: 'ready' }] })
      const noCookie = await worker.fetch(post(), env)
      expect(noCookie.status).toBe(401)
      const foreign = await worker.fetch(post(body, { cookie, origin: 'https://evil.invalid' }), env)
      expect(foreign.status).toBe(403)
      expect((await worker.fetch(post(body, { cookie }), { ...env, AUTH_ENABLED: 'false' })).status).toBe(503)
    } finally {
      f.sqlite.close()
    }
  })
})

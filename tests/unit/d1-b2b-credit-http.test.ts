import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { returnsFixture, CLAIMS, BUYER_CLAIMS, CUSTOMER, utc } from './d1-returns-fixture'
import { handleB2BHttp } from '../../workers/catalog/b2b-http'
import worker from '../../workers/canary'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'

const origin = 'https://b2b.neteco.test',
  companyId = '30000000-0000-4000-8000-000000000099'
async function world() {
  const f = await returnsFixture(),
    now = utc(),
    before = utc(-60000)
  f.sqlite.exec(await readFile('db/d1/migrations/0101_b2b_price_lists_credit.sql', 'utf8'))
  f.sqlite.exec(await readFile('db/d1/migrations/0105_b2b_credit_terms.sql', 'utf8'))
  f.sqlite
    .prepare(
      "INSERT INTO companies(id,customer_id,legal_name,status,created_at,updated_at) VALUES(?,?,'Empresa','approved',?,?)"
    )
    .run(companyId, CUSTOMER, before, before)
  const deps = {
    database: f.database,
    origin,
    now: () => now,
    session: async () => CLAIMS,
    edgeLimiter: { limit: async () => ({ success: true }) } as unknown as RateLimit,
    rateLimitPepper: 'synthetic-rate-limit-pepper-over-32'
  }
  return { ...f, deps }
}
const input = {
  expectedVersion: 0,
  paymentDays: 30,
  creditLimitCents: 100,
  blocked: false,
  blockReason: null,
  reason: 'Contrato comercial'
}
function request(path: string, method = 'GET', body?: unknown) {
  return new Request(origin + path, {
    method,
    headers: {
      origin,
      'Content-Type': 'application/json',
      'Idempotency-Key': crypto.randomUUID(),
      'CF-Connecting-IP': '192.0.2.1'
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  })
}
describe('B2B HTTP', () => {
  it('updates and replays a credit decision and exposes its private customer summary', async () => {
    const f = await world()
    try {
      const req = request(`/api/admin/b2b/companies/${companyId}/credit`, 'PUT', input)
      expect((await handleB2BHttp(req.clone(), f.deps))?.status).toBe(200)
      expect((await handleB2BHttp(req, f.deps))?.status).toBe(200)
      const res = await handleB2BHttp(request('/api/account/b2b'), { ...f.deps, session: async () => BUYER_CLAIMS })
      expect(res?.status).toBe(200)
      expect(await res?.json()).toMatchObject({ terms: { availableCents: 100 } })
      expect(res?.headers.get('cache-control')).toBe('private, no-store')
    } finally {
      f.sqlite.close()
    }
  })
  it('rejects missing or cross-site origin on writes', async () => {
    const f = await world()
    try {
      for (const value of [null, 'https://evil.invalid']) {
        const req = request(`/api/admin/b2b/companies/${companyId}/credit`, 'PUT', input)
        if (value) req.headers.set('origin', value)
        else req.headers.delete('origin')
        expect((await handleB2BHttp(req, f.deps))?.status).toBe(403)
      }
      expect(f.sqlite.prepare('SELECT count(*) n FROM b2b_credit_commands').get()).toMatchObject({ n: 0 })
    } finally {
      f.sqlite.close()
    }
  })
  it('requires admin permission and refuses anonymous account access', async () => {
    const f = await world()
    try {
      expect(
        (await handleB2BHttp(request('/api/admin/b2b'), { ...f.deps, session: async () => BUYER_CLAIMS }))?.status
      ).toBe(403)
      expect((await handleB2BHttp(request('/api/account/b2b'), { ...f.deps, session: async () => null }))?.status).toBe(
        401
      )
    } finally {
      f.sqlite.close()
    }
  })
  it('rejects malformed data and unsupported methods', async () => {
    const f = await world()
    try {
      expect(
        (
          await handleB2BHttp(
            request(`/api/admin/b2b/companies/${companyId}/credit`, 'PUT', { ...input, paymentDays: 45 }),
            f.deps
          )
        )?.status
      ).toBe(400)
      expect((await handleB2BHttp(request('/api/admin/b2b', 'POST'), f.deps))?.status).toBe(405)
      expect(await handleB2BHttp(request('/api/other'), f.deps)).toBeNull()
    } finally {
      f.sqlite.close()
    }
  })
  it('routes signed sessions through the actual Worker and owns disabled namespaces', async () => {
    const f = await world()
    try {
      const password = 'synthetic-b2b-cookie-secret-more-than-32-characters'
      const cookie = (await issueD1SessionCookie(f.database, CLAIMS, { password, maxAgeSeconds: 3600 }))!.split(';')[0]!
      const env = {
        APP_ENV: 'local',
        AUTH_ENABLED: 'true',
        AUTH_ORIGIN: origin,
        NUXT_SESSION_PASSWORD: password,
        AUTH_RATE_LIMIT_PEPPER: 'synthetic-rate-limit-pepper-over-32',
        ADMIN_EDGE_LIMIT: { limit: async () => ({ success: true }) },
        AUTH_EDGE_LIMIT: { limit: async () => ({ success: true }) },
        DB: f.database
      } as unknown as CloudflareEnv
      const req = new Request(origin + '/api/admin/b2b', {
        headers: { cookie, origin, 'CF-Connecting-IP': '192.0.2.1' }
      })
      expect((await worker.fetch(req, env)).status).toBe(200)
      expect(
        (await worker.fetch(new Request(origin + '/api/account/b2b'), { ...env, AUTH_ENABLED: 'false' })).status
      ).toBe(503)
    } finally {
      f.sqlite.close()
    }
  })
  it('creates and assigns a tariff through the HTTP boundary', async () => {
    const f = await world()
    try {
      const list = {
        code: 'PRO',
        name: 'Profesionales',
        status: 'active',
        validFrom: utc(-60000),
        validUntil: null,
        reason: 'Acuerdo comercial',
        variantRules: [{ variantId: 'v-1-1', unitGrossCents: 450 }],
        categoryRules: []
      }
      const created = await handleB2BHttp(request('/api/admin/b2b/price-lists', 'PUT', list), f.deps)
      expect(created?.status).toBe(200)
      const receipt = (await created!.json()) as { priceListId: string }
      const assigned = await handleB2BHttp(
        request(`/api/admin/b2b/companies/${companyId}/assignment`, 'PUT', {
          priceListId: receipt.priceListId,
          expectedVersion: 0,
          validFrom: utc(-60000),
          validUntil: null,
          reason: 'Acuerdo comercial'
        }),
        f.deps
      )
      expect(assigned?.status).toBe(200)
      const summary = await handleB2BHttp(request('/api/account/b2b'), { ...f.deps, session: async () => BUYER_CLAIMS })
      expect(await summary?.json()).toMatchObject({ terms: { priceListName: 'Profesionales' } })
      const index = await handleB2BHttp(request('/api/admin/b2b'), f.deps)
      expect(await index?.json()).toMatchObject({
        priceLists: [{ name: 'Profesionales', variantRules: [{ variantId: 'v-1-1', unitGrossCents: 450 }] }]
      })
    } finally {
      f.sqlite.close()
    }
  })
})

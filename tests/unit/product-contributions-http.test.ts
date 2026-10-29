import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { returnsFixture, CLAIMS, BUYER_CLAIMS, utc } from './d1-returns-fixture'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import {
  handleProductContributionsHttp,
  type ProductContributionsHttpDependencies
} from '../../workers/support/product-contributions-http'

describe('MKT024/025 HTTP real D1 moderation boundary', () => {
  let f: Awaited<ReturnType<typeof returnsFixture>>
  let deps: ProductContributionsHttpDependencies
  let customerCookie: string, adminCookie: string, productId: number
  const origin = 'https://contributions.neteco.test'
  const body = () => ({
    kind: 'review',
    productId,
    score: 5,
    title: 'Reseña sintética explícita',
    body: 'Contenido sintético destinado a revisión antes de publicarse.',
    privacyAcknowledged: true
  })
  const send = (
    path: string,
    method = 'GET',
    value?: unknown,
    cookie = customerCookie,
    extra: Record<string, string> = {},
    selectedDeps = deps
  ) =>
    handleProductContributionsHttp(
      new Request(origin + path, {
        method,
        headers: {
          origin,
          cookie,
          ...(value === undefined
            ? {}
            : { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() }),
          ...extra
        },
        ...(value === undefined ? {} : { body: JSON.stringify(value) })
      }),
      selectedDeps
    )
  beforeEach(async () => {
    f = await returnsFixture()
    f.sqlite
      .prepare("INSERT INTO permissions VALUES('support.manage','support','manage','Synthetic moderation permission')")
      .run()
    f.sqlite.prepare("INSERT INTO role_permissions VALUES('operator','support.manage')").run()
    f.sqlite
      .prepare(
        "INSERT INTO identity_mfa(identity_id,encrypted_secret,verified_at,updated_at) VALUES(?,'synthetic-unused-secret',?,?)"
      )
      .run(CLAIMS.identityId, utc(-60000), utc(-60000))
    const migration = new URL('../../db/d1/migrations/0088_product_contributions.sql', import.meta.url)
    f.sqlite.exec(await readFile(migration, 'utf8'))
    productId = (f.sqlite.prepare("SELECT legacy_id FROM products WHERE id='p-1'").get() as { legacy_id: number })
      .legacy_id
    const configuration = { password: 'synthetic-contribution-cookie-password-0123456789abcdef', maxAgeSeconds: 3600 }
    customerCookie = (await issueD1SessionCookie(f.database, BUYER_CLAIMS, configuration))!.split(';')[0]!
    adminCookie = (await issueD1SessionCookie(f.database, CLAIMS, configuration))!.split(';')[0]!
    deps = {
      database: f.database,
      origin,
      sessionCookieConfiguration: configuration,
      rateLimitPepper: 'synthetic-contribution-rate-pepper-0123456789abcdef',
      edgeGate: async () => 'allowed'
    }
  })
  afterEach(() => f.sqlite.close())
  it('creates a pending contribution then exposes only an explicitly reviewed public projection', async () => {
    const created = await send('/api/account/product-contributions', 'POST', body())
    expect(created?.status).toBe(201)
    const receipt = (await created!.json()) as { contributionId: string }
    const pending = await send(`/api/products/${productId}/contributions`, 'GET', undefined, '')
    expect(pending?.status).toBe(200)
    expect(((await pending!.json()) as { items: unknown[] }).items).toEqual([])
    const published = await send(
      `/api/admin/product-contributions/${receipt.contributionId}/commands`,
      'POST',
      {
        action: 'publish',
        expectedVersion: 1,
        reason: 'Revisión explícita y sintética del contenido',
        reviewReference: 'synthetic-moderation-reference',
        slaDueAt: null
      },
      adminCookie
    )
    expect(published?.status).toBe(201)
    const publicResponse = await send(`/api/products/${productId}/contributions`, 'GET', undefined, '')
    expect(publicResponse?.status).toBe(200)
    const dto = (await publicResponse!.json()) as { items: Array<{ origin: string }> }
    expect(dto.items).toHaveLength(1)
    expect(dto.items[0]?.origin).toBe('unverified')
    for (const secret of ['buyer@example.invalid', 'customerId', 'sessionId', 'reviewReference'])
      expect(JSON.stringify(dto)).not.toContain(secret)
  })
  it('rejects cross-origin create and customer moderation rather than falling through', async () => {
    expect(
      (
        await send('/api/account/product-contributions', 'POST', body(), customerCookie, {
          origin: 'https://hostile.neteco.test'
        })
      )?.status
    ).toBe(403)
    expect((await send('/api/admin/product-contributions', 'GET', undefined, customerCookie))?.status).toBe(403)
  })
  it('checks the required edge gate before any cookie or database access', async () => {
    let reads = 0
    const database = new Proxy(f.database, {
      get(target, key) {
        if (key === 'prepare' || key === 'batch')
          return () => {
            reads++
            throw new Error('must not touch D1')
          }
        return Reflect.get(target, key)
      }
    })
    const response = await send(
      '/api/account/product-contributions',
      'POST',
      body(),
      'invalid-cookie',
      {},
      { ...deps, database, edgeGate: async () => 'limited' }
    )
    expect(response?.status).toBe(429)
    expect(reads).toBe(0)
  })
  it('bounds UTF8 bodies and rejects client authority or unknown query fields', async () => {
    expect(
      (await send('/api/account/product-contributions', 'POST', { ...body(), body: 'á'.repeat(10000) }))?.status
    ).toBe(413)
    expect(
      (await send('/api/account/product-contributions', 'POST', { ...body(), origin: 'verified_purchase' }))?.status
    ).toBe(422)
    expect((await send(`/api/products/${productId}/contributions?customerId=${BUYER_CLAIMS.identityId}`))?.status).toBe(
      422
    )
  })
  it('owns encoded/case aliases but only serves exact canonical routes with safe private headers', async () => {
    expect((await send('/API/admin/product-contributions'))?.status).toBe(404)
    expect((await send('/api/admin/product-%63ontributions'))?.status).toBe(404)
    const response = await send('/api/account/product-contributions', 'DELETE')
    expect(response?.status).toBe(405)
    expect(response?.headers.get('cache-control')).toContain('no-store')
    expect(response?.headers.get('referrer-policy')).toBe('no-referrer')
  })
  it('never returns a confirmed empty public list when its authoritative source is unavailable', async () => {
    const database = new Proxy(f.database, {
      get(target, key) {
        if (key === 'prepare' || key === 'batch')
          return () => {
            throw new Error('synthetic source unavailable')
          }
        return Reflect.get(target, key)
      }
    })
    const response = await send(
      `/api/products/${productId}/contributions`,
      'GET',
      undefined,
      '',
      {},
      { ...deps, database }
    )
    expect(response?.status).toBe(503)
    expect(await response!.json()).toEqual({ error: { code: 'service_unavailable' } })
  })
})

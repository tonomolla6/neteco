import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { adminAuditFixture } from './d1-admin-audit-fixture'
import { readFile } from 'node:fs/promises'
import { seedInventoryFixture } from '../support/d1-sqlite'
import { provisionPublicationValidityFixture } from '../support/publication-validity-fixture'
import { createPackingOrder, REASON, utc } from './d1-order-packing-fixture'
import { adminOrderBulkIntentHash } from '../../shared/admin-order-bulk'
import { handleAdminOrderBulkHttp } from '../../workers/fulfillment/bulk-http'
import { testUuid } from '../support/deterministic'

describe('administrative bulk fulfillment real D1 HTTP security boundary', () => {
  let f: Awaited<ReturnType<typeof adminAuditFixture>>
  const origin = 'https://bulk-fulfillment.neteco.test'
  const base = '/api/admin/orders/bulk-fulfillment'
  beforeEach(async () => {
    f = await adminAuditFixture()
  })
  afterEach(() => f.sqlite.close())
  const deps = () => ({ ...f.deps, origin, rateLimitPepper: 'synthetic-bulk-fulfillment-pepper-0123456789' })
  async function request(path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) {
    return (await handleAdminOrderBulkHttp(
      new Request(origin + path, {
        method,
        headers: {
          cookie: await f.cookie(),
          origin,
          'content-type': 'application/json',
          'idempotency-key': testUuid(),
          ...headers
        },
        body: body === undefined ? undefined : JSON.stringify(body)
      }),
      deps()
    ))!
  }
  async function realOrder() {
    const scripts = await Promise.all(
      ['0085_admin_order_views.sql', '0086_admin_order_bulk.sql'].map((file) =>
        readFile(new URL('../../db/d1/migrations/' + file, import.meta.url), 'utf8')
      )
    )
    f.sqlite.exec('BEGIN;\n' + scripts.join('\n') + '\nCOMMIT;')
    seedInventoryFixture(f.sqlite)
    await provisionPublicationValidityFixture(f.database, { productIds: ['p-1'], now: utc(-60000) })
    f.sqlite
      .prepare(
        "INSERT INTO shipping_zones(id,code,name,kind,postal_prefixes,active,created_at) VALUES('bulk-pickup','bulk-pickup','Synthetic pickup','warehouse_pickup','[]',1,?)"
      )
      .run(utc(-60000))
    f.sqlite
      .prepare(
        "INSERT INTO shipping_rates(id,zone_id,method_code,service_profile,net_cents,tax_rate_basis_points,eta_min_days,eta_max_days,rate_version,active,created_at) VALUES('bulk-pickup-rate','bulk-pickup','pickup','parcel',0,2100,0,0,1,1,?)"
      )
      .run(utc(-60000))
    return createPackingOrder(f.database, { method: 'pickup', stage: 'pending' })
  }
  it('previews a real captured order then creates, replays and manually recovers without executing its transition', async () => {
    const id = await realOrder(),
      previewResponse = await request(`${base}/preview`, 'POST', { action: 'picking', orderIds: [id], reason: REASON })
    expect(previewResponse.status).toBe(200)
    const preview = (await previewResponse.json()) as {
      previewHash: string
      rows: Array<{ orderId: string; expectedVersion: number }>
    }
    const input = {
        action: 'picking',
        orders: preview.rows.map(({ orderId, expectedVersion }) => ({ orderId, expectedVersion })),
        reason: REASON,
        previewHash: preview.previewHash
      },
      key = testUuid()
    const response = await request(`${base}/commands`, 'POST', input, { 'idempotency-key': key })
    expect(response.status).toBe(201)
    const receipt = (await response.json()) as { groupId: string }
    expect(await (await request(`${base}/commands`, 'POST', input, { 'idempotency-key': key })).json()).toEqual(receipt)
    expect(
      await (await request(`${base}/commands/${key}?payloadHash=${await adminOrderBulkIntentHash(input)}`)).json()
    ).toEqual({ source: 'cloudflare', outcome: 'applied', receipt })
    expect(await (await request(`${base}/${receipt.groupId}`)).json()).toMatchObject({
      status: 'pending',
      completed: 0,
      remaining: 1
    })
    expect(f.sqlite.prepare('SELECT count(*) n FROM order_fulfillment_commands').get()).toEqual({ n: 0 })
  })
  it('rejects anonymous reads and recovery without revealing any group', async () => {
    const id = testUuid()
    expect((await request(`${base}/${id}`, 'GET', undefined, { cookie: '' })).status).toBe(401)
    expect(
      (await request(`${base}/commands/${id}?payloadHash=${'a'.repeat(64)}`, 'GET', undefined, { cookie: '' })).status
    ).toBe(401)
  })
  it('requires current enrolled MFA despite an unchanged signed cookie', async () => {
    const cookie = await f.cookie()
    f.sqlite.exec('DELETE FROM identity_mfa')
    expect((await request(`${base}/preview`, 'POST', {}, { cookie })).status).toBe(403)
  })
  it('rejects cross-origin writes before processing commands', async () => {
    expect((await request(`${base}/commands`, 'POST', {}, { origin: 'https://foreign.invalid' })).status).toBe(403)
    const response = await handleAdminOrderBulkHttp(
      new Request('https://foreign.invalid' + base + '/preview', {
        method: 'POST',
        headers: { origin, 'content-type': 'application/json' },
        body: '{}'
      }),
      deps()
    )
    expect(response?.status).toBe(403)
  })
  it('bounds JSON body bytes and rejects unsupported methods', async () => {
    expect((await request(`${base}/preview`, 'POST', { padding: 'x'.repeat(17000) })).status).toBe(413)
    expect((await request(`${base}/preview`, 'GET')).status).toBe(405)
    expect((await request(`${base}/${testUuid()}`, 'DELETE')).status).toBe(405)
  })
  it('retains case and encoded aliases and malformed children without legacy fallthrough', async () => {
    for (const path of [
      '/API/admin/orders/bulk-fulfillment/preview',
      '/api/admin/orders/bulk%2dfulfillment/preview',
      `${base}/preview/`,
      `${base}/not-a-uuid`
    ]) {
      const response = await request(path)
      expect(response.status).toBe(404)
      expect(response.headers.get('cache-control')).toContain('no-store')
      expect(response.headers.get('referrer-policy')).toBe('no-referrer')
    }
  })
  it('runs the mandatory edge limiter before cookies or any D1 access', async () => {
    let queries = 0
    const database = {
      prepare() {
        queries++
        throw new Error('must_not_query_before_edge')
      }
    } as unknown as D1Database
    const req = new Request(origin + base + '/' + testUuid())
    expect((await handleAdminOrderBulkHttp(req, { ...deps(), database, edgeGate: async () => 'denied' }))?.status).toBe(
      429
    )
    expect(
      (await handleAdminOrderBulkHttp(req, { ...deps(), database, edgeGate: async () => 'unavailable' }))?.status
    ).toBe(503)
    expect(queries).toBe(0)
  })
})

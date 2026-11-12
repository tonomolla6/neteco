import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { issueD1SessionCookie, type SessionCookieConfiguration } from '../../workers/auth/session-cookie'
import {
  handleInventoryOpsHttp as handle,
  ownsInventoryOpsNamespace
} from '../../workers/catalog/inventory-commitments-picking-purchasing-http'
import {
  openAdminInventoryFixture,
  INVENTORY_FIXTURE_ACTOR,
  INVENTORY_FIXTURE_SESSION,
  INVENTORY_FIXTURE_VARIANT as V
} from '../support/admin-inventory-fixture'
import { deterministicUuid } from '../fixtures/deterministic'
import { testNow } from '../support/deterministic'

const origin = 'https://inventory.neteco.test'
const at = (days = 0) => new Date(testNow() + days * 86400000).toISOString().replace(/\.\d{3}Z$/, 'Z')
const NOW = at()
const LATER = at(20)
const config: SessionCookieConfiguration = {
  password: 'synthetic-inv-ops-cookie-more-than-32-chars',
  maxAgeSeconds: 3600
}
const claims = { identityId: INVENTORY_FIXTURE_ACTOR, sessionId: INVENTORY_FIXTURE_SESSION, sessionVersion: 1 }
const SUPPLIER = deterministicUuid('http-supplier')
let fixture: Awaited<ReturnType<typeof openAdminInventoryFixture>>
let cookie: string
let limiterOk = true
let n = 0
const id = () => deterministicUuid(`http-${++n}`)

const call = (
  path: string,
  method = 'GET',
  o: { body?: unknown; key?: string; anonymous?: boolean; headers?: Record<string, string> } = {}
) =>
  handle(
    new Request(origin + path, {
      method,
      headers: {
        Origin: origin,
        ...(o.anonymous ? {} : { Cookie: cookie }),
        'Content-Type': 'application/json',
        'CF-Connecting-IP': '192.0.2.100',
        ...(o.key ? { 'Idempotency-Key': o.key } : {}),
        ...o.headers
      },
      ...(o.body === undefined ? {} : { body: JSON.stringify(o.body) })
    }),
    {
      database: fixture.database,
      origin,
      sessionCookieConfiguration: config,
      edgeLimiter: { limit: async () => ({ success: limiterOk }) } as unknown as RateLimit,
      rateLimitPepper: 'synthetic-inv-ops-pepper-more-than-32-chars'
    }
  ) as Promise<Response>
const command = (action: string, targetId: string, input: unknown, key = id()) =>
  call('/api/admin/inventory/operations/commands', 'POST', { body: { action, targetId, input }, key })

beforeEach(async () => {
  n = 0
  limiterOk = true
  fixture = await openAdminInventoryFixture()
  fixture.sqlite.exec(
    await readFile(
      new URL('../../db/d1/migrations/0139_inventory_commitments_picking_purchasing.sql', import.meta.url),
      'utf8'
    )
  )
  fixture.sqlite.exec(
    `INSERT INTO catalog_suppliers(id,code,name,currency,created_at,updated_at) VALUES('${SUPPLIER}','SUP-1','Proveedor Uno','EUR','${NOW}','${NOW}')`
  )
  cookie = (await issueD1SessionCookie(fixture.database, claims, config))!.split(';')[0]!
})
afterEach(() => fixture.sqlite.close())

describe('namespace', () => {
  it('owns only its routes, also when encoded', () => {
    for (const p of [
      'commitments',
      'pick-locations',
      'pick-locations/plan',
      'purchase-orders/x',
      'operations/commands'
    ])
      expect(ownsInventoryOpsNamespace(`/api/admin/inventory/${p}`)).toBe(true)
    expect(ownsInventoryOpsNamespace('/api/admin/inventory/%63ommitments')).toBe(true)
    for (const p of [
      '/api/admin/inventory/lots',
      '/api/admin/inventory/alerts',
      '/api/admin/inventory/commitmentsX',
      '/api/admin/catalog'
    ])
      expect(ownsInventoryOpsNamespace(p)).toBe(false)
  })
  it('returns null for foreign paths', async () => {
    expect(await call('/api/admin/inventory/lots')).toBeNull()
  })
})

describe('security boundary', () => {
  it('401 without session, 403 on CSRF, 429/503 on edge limiter', async () => {
    expect((await call('/api/admin/inventory/commitments', 'GET', { anonymous: true })).status).toBe(401)
    expect(
      (await call('/api/admin/inventory/commitments', 'GET', { headers: { Origin: 'https://evil.invalid' } })).status
    ).toBe(403)
    expect(
      (await call('/api/admin/inventory/commitments', 'GET', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status
    ).toBe(403)
    const post = await call('/api/admin/inventory/operations/commands', 'POST', {
      body: {},
      key: id(),
      headers: { Origin: 'https://evil.invalid' }
    })
    expect(post.status).toBe(403)
    limiterOk = false
    expect((await call('/api/admin/inventory/commitments')).status).toBe(429)
  })
  it('403 when the live role lost inventory.write but may still read', async () => {
    fixture.sqlite.exec("DELETE FROM role_permissions WHERE permission_code='inventory.write'")
    expect((await call('/api/admin/inventory/commitments')).status).toBe(200)
    const res = await command('create_pick_location', id(), { code: 'A-1', zone: 'A', pickSequence: 1 })
    expect(res.status).toBe(403)
    expect(fixture.sqlite.prepare('SELECT count(*) c FROM inventory_pick_locations').get()).toEqual({ c: 0 })
  })
  it('403 when all permissions are revoked mid-flight (no body leaked)', async () => {
    fixture.sqlite.exec('DELETE FROM role_permissions')
    const res = await call('/api/admin/inventory/purchase-orders')
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: { code: 'forbidden' } })
  })
  it('sets no-store headers and rejects other methods', async () => {
    const ok = await call('/api/admin/inventory/commitments')
    expect(ok.headers.get('cache-control')).toBe('private, no-store')
    expect((await call('/api/admin/inventory/commitments', 'DELETE')).status).toBe(405)
    expect((await call('/api/admin/inventory/commitments', 'POST', { body: {}, key: id() })).status).toBe(405)
  })
})

describe('command endpoint', () => {
  it('requires idempotency key and a strict body', async () => {
    const path = '/api/admin/inventory/operations/commands'
    expect((await call(path, 'POST', { body: { action: 'putaway', targetId: id(), input: {} } })).status).toBe(400)
    expect(
      (await call(path, 'POST', { key: 'short', body: { action: 'putaway', targetId: id(), input: {} } })).status
    ).toBe(400)
    expect(
      (await call(path, 'POST', { key: id(), body: { action: 'drop_table', targetId: id(), input: {} } })).status
    ).toBe(400)
    expect(
      (await call(path, 'POST', { key: id(), body: { action: 'putaway', targetId: id(), input: {}, extra: 1 } })).status
    ).toBe(400)
    expect((await call(path, 'POST', { key: id() })).status).toBe(400)
  })

  it('runs the full contract commitment lifecycle over HTTP', async () => {
    const target = id()
    const created = await command('create_commitment', target, {
      variantId: V,
      contractRef: 'CONTRATO-HTTP',
      quantity: 3,
      expiresAt: LATER,
      reason: 'Contrato marco'
    })
    expect(created.status).toBe(200)
    const list = (await (await call('/api/admin/inventory/commitments?status=active')).json()) as {
      items: { id: string; version: number }[]
    }
    expect(list.items).toHaveLength(1)
    const released = await command('release_commitment', target, {
      expectedVersion: list.items[0]!.version,
      reason: 'Fin del contrato'
    })
    expect(released.status).toBe(200)
    expect(
      ((await (await call('/api/admin/inventory/commitments?status=released')).json()) as { items: unknown[] }).items
    ).toHaveLength(1)
  })

  it('maps domain errors to stable codes and statuses', async () => {
    const huge = await command('create_commitment', id(), {
      variantId: V,
      contractRef: 'CONTRATO-X',
      quantity: 999,
      expiresAt: LATER,
      reason: 'Demasiado'
    })
    expect(huge.status).toBe(409)
    expect(await huge.json()).toEqual({ error: { code: 'insufficient_stock' } })
    const missing = await command('release_commitment', id(), { expectedVersion: 1, reason: 'No existe' })
    expect(missing.status).toBe(404)
    const bad = await command('create_commitment', id(), { variantId: V })
    expect(bad.status).toBe(400)
  })

  it('replays the same key and detects reuse with another payload', async () => {
    const target = id()
    const key = id()
    const body = { variantId: V, contractRef: 'CONTRATO-IDEM', quantity: 2, expiresAt: LATER, reason: 'Idempotente' }
    const a = await (await command('create_commitment', target, body, key)).json()
    const b = await (await command('create_commitment', target, body, key)).json()
    expect(b).toEqual(a)
    const mismatch = await command('create_commitment', target, { ...body, quantity: 3 }, key)
    expect(mismatch.status).toBe(409)
    expect(await mismatch.json()).toEqual({ error: { code: 'idempotency_payload_mismatch' } })
  })

  it('rate limits writes per identity', async () => {
    const nowSeconds = Math.floor(testNow() / 1000)
    fixture.sqlite.exec(
      `INSERT INTO identity_rate_limits(identity_id,scope,used,window_started_at,expires_at) VALUES('${INVENTORY_FIXTURE_ACTOR}','admin-inventory',120,${nowSeconds},${nowSeconds + 3600})`
    )
    const res = await command('create_pick_location', id(), { code: 'A-1', zone: 'A', pickSequence: 1 })
    expect(res.status).toBe(429)
    expect(res.headers.get('retry-after')).toBeTruthy()
    expect(fixture.sqlite.prepare('SELECT count(*) c FROM inventory_pick_locations').get()).toEqual({ c: 0 })
  })
})

describe('picking and purchasing reads over HTTP', () => {
  it('picking flow: locations, stock, plan, consistency', async () => {
    const bin = id()
    expect((await command('create_pick_location', bin, { code: 'A-01', zone: 'A', pickSequence: 1 })).status).toBe(200)
    expect(
      (await command('putaway', id(), { variantId: V, pickLocationId: bin, quantity: 6, expectedVersion: 0 })).status
    ).toBe(200)
    expect(
      (await command('putaway', id(), { variantId: V, pickLocationId: bin, quantity: 99, expectedVersion: 1 })).status
    ).toBe(409)
    const locations = (await (await call('/api/admin/inventory/pick-locations')).json()) as {
      items: { stockUnits: number }[]
    }
    expect(locations.items[0]!.stockUnits).toBe(6)
    const stock = (await (await call(`/api/admin/inventory/pick-locations/stock?variantId=${V}`)).json()) as {
      items: { quantity: number; version: number }[]
    }
    expect(stock.items[0]).toMatchObject({ quantity: 6, version: 1 })
    const plan = (await (await call(`/api/admin/inventory/pick-locations/plan?variantId=${V}&quantity=10`)).json()) as {
      shortfall: number
    }
    expect(plan.shortfall).toBe(4)
    const consistency = (await (
      await call(`/api/admin/inventory/pick-locations/consistency?variantId=${V}`)
    ).json()) as { items: { consistent: boolean }[] }
    expect(consistency.items[0]!.consistent).toBe(true)
    expect((await call('/api/admin/inventory/pick-locations/plan?variantId=nope&quantity=1')).status).toBe(400)
    expect((await call(`/api/admin/inventory/pick-locations/plan?variantId=${V}&quantity=0`)).status).toBe(400)
  })

  it('purchase order flow over HTTP including 404 and filters', async () => {
    const po = id()
    expect(
      (
        await command('create_purchase_order', po, {
          supplierId: SUPPLIER,
          poNumber: 'PO-HTTP-1',
          lines: [{ variantId: V, expectedQuantity: 5, unitCostCents: 100 }]
        })
      ).status
    ).toBe(200)
    expect((await command('submit_purchase_order', po, { expectedVersion: 1 })).status).toBe(200)
    const receipt = await command('record_receipt', id(), {
      purchaseOrderId: po,
      expectedVersion: 2,
      receiptNumber: 'REC-HTTP-1',
      receivedAt: NOW,
      lines: [{ lineIndex: 0, receivedQuantity: 4, rejectedQuantity: 1 }],
      documents: [
        {
          kind: 'delivery_note',
          reference: 'ALB-77',
          sha256: 'b'.repeat(64),
          sizeBytes: 10,
          mediaType: 'application/pdf'
        }
      ]
    })
    expect(receipt.status).toBe(200)
    const detail = (await (await call(`/api/admin/inventory/purchase-orders/${po}`)).json()) as {
      status: string
      summary: { hasDiscrepancy: boolean }
      documents: unknown[]
    }
    expect(detail).toMatchObject({ status: 'partially_received', summary: { hasDiscrepancy: true } })
    expect(detail.documents).toHaveLength(1)
    const list = (await (
      await call(`/api/admin/inventory/purchase-orders?status=partially_received&supplierId=${SUPPLIER}`)
    ).json()) as { items: unknown[] }
    expect(list.items).toHaveLength(1)
    expect((await call(`/api/admin/inventory/purchase-orders/${id()}`)).status).toBe(404)
    expect((await call('/api/admin/inventory/purchase-orders?status=bogus')).status).toBe(400)
  })

  it('does not expose unrelated sub-paths', async () => {
    expect((await call('/api/admin/inventory/commitments/extra')).status).toBe(404)
    expect((await call('/api/admin/inventory/operations/other', 'POST', { body: {}, key: id() })).status).toBe(405)
  })
})

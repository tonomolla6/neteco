/* eslint-disable @typescript-eslint/no-explicit-any -- loosely typed JSON/fetch doubles in this test file */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  handleCarrierManifestsHttp,
  ownsCarrierManifestsNamespace
} from '../../workers/fulfillment/carrier-manifests-http'
import { createLocalCarrierManifestAdapter } from '../../workers/fulfillment/carrier-manifest-adapter'
import { ADMIN, NOW, OTHER, opsWorld, seedDispatchedOrder, type OpsWorld } from './shipping-ops-fixture'

let w: OpsWorld
beforeEach(async () => {
  w = await opsWorld()
  seedDispatchedOrder(w.sqlite, 'ord-1', [
    { carrier: 'correos', trackingNumber: 'TRK-1', weightGrams: 1500 },
    { carrier: 'correos', trackingNumber: 'TRK-2', weightGrams: 700 }
  ])
})
afterEach(() => w.close())

const call = async (
  method: string,
  path: string,
  body?: unknown,
  identity: string | null = ADMIN,
  adapter = createLocalCarrierManifestAdapter()
) => {
  const response = await handleCarrierManifestsHttp(
    new Request(`https://tienda.example.com${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    }),
    {
      database: w.db,
      adapter,
      sessionProvider: async () => (identity ? { identityId: identity } : null),
      now: () => NOW
    }
  )
  const text = await response!.text()
  let json: Record<string, any> = {}
  try {
    json = JSON.parse(text)
  } catch {
    /* document download */
  }
  return { response: response!, json, text }
}
const BASE = '/api/admin/carrier-manifests'

describe('SHP-028 carrier manifests HTTP', () => {
  it('owns only its namespace', async () => {
    expect(ownsCarrierManifestsNamespace(BASE)).toBe(true)
    expect(ownsCarrierManifestsNamespace(`${BASE}/m1/close`)).toBe(true)
    expect(ownsCarrierManifestsNamespace('/api/admin/carrier-manifestsx')).toBe(false)
    expect(await handleCarrierManifestsHttp(new Request('https://x.example/api/other'), { database: w.db })).toBeNull()
  })

  it('401 for anonymous, 403 for non-admin, no-store always', async () => {
    const anon = await call('GET', BASE, undefined, null)
    expect(anon.response.status).toBe(401)
    expect(anon.response.headers.get('cache-control')).toContain('no-store')
    expect((await call('GET', BASE, undefined, OTHER)).response.status).toBe(403)
    expect(
      (await call('POST', BASE, { commandId: 'cmd-http-001', carrier: 'correos', pickupDate: '2026-10-30' }, OTHER))
        .response.status
    ).toBe(403)
  })

  it('runs create, hold, close, document download, pickup and scan', async () => {
    const created = await call('POST', BASE, {
      commandId: 'cmd-http-002',
      carrier: 'correos',
      pickupDate: '2026-10-30'
    })
    expect(created.response.status).toBe(201)
    const id = created.json.manifest.id as string
    expect(created.json.manifest.reconciliation).toMatchObject({ included: 2, balanced: true })
    const held = await call('POST', `${BASE}/${id}/items`, {
      commandId: 'cmd-http-003',
      expectedVersion: 1,
      trackingNumber: 'TRK-2',
      decision: 'excluded'
    })
    expect(held.json.manifest.includedShipments).toBe(1)
    const closed = await call('POST', `${BASE}/${id}/close`, { commandId: 'cmd-http-004', expectedVersion: 2 })
    expect(closed.response.status).toBe(200)
    expect(closed.json.manifest.status).toBe('closed')
    const doc = await call('GET', `${BASE}/${id}/documents/manifest_csv`)
    expect(doc.response.status).toBe(200)
    expect(doc.response.headers.get('content-type')).toContain('text/csv')
    expect(doc.response.headers.get('content-disposition')).toContain('attachment')
    expect(doc.response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(doc.response.headers.get('x-document-sha256')).toMatch(/^[0-9a-f]{64}$/)
    expect(doc.text).toContain('TRK-1')
    const pickup = await call('POST', `${BASE}/${id}/pickup`, { commandId: 'cmd-http-005', expectedVersion: 3 })
    expect(pickup.json.manifest.pickup.status).toBe('scheduled')
    const scan = await call('POST', `${BASE}/${id}/pickup/confirm`, {
      commandId: 'cmd-http-006',
      expectedVersion: 4,
      scannedTrackingNumbers: ['TRK-1']
    })
    expect(scan.json.manifest.status).toBe('picked_up')
    expect((await call('GET', `${BASE}/${id}`)).json.manifest.documents).toHaveLength(2)
    expect((await call('GET', `${BASE}?status=picked_up`)).json.manifests).toHaveLength(1)
  })

  it('maps domain errors to stable statuses', async () => {
    const created = await call('POST', BASE, {
      commandId: 'cmd-http-007',
      carrier: 'correos',
      pickupDate: '2026-10-30'
    })
    const id = created.json.manifest.id as string
    expect(
      (await call('POST', `${BASE}/${id}/close`, { commandId: 'cmd-http-008', expectedVersion: 9 })).response.status
    ).toBe(409)
    expect(
      (await call('POST', `${BASE}/${id}/pickup`, { commandId: 'cmd-http-009', expectedVersion: 1 })).json.error.code
    ).toBe('manifest_not_closed')
    expect(
      (await call('POST', BASE, { commandId: 'cmd-http-010', carrier: 'correos', pickupDate: '2026-10-30' })).json.error
        .code
    ).toBe('conflict')
    expect(
      (await call('POST', BASE, { commandId: 'cmd-http-011', carrier: 'zzz', pickupDate: '2026-10-30' })).json.error
        .code
    ).toBe('nothing_to_manifest')
    expect((await call('POST', BASE, { commandId: 'bad', carrier: 'correos' })).response.status).toBe(400)
    expect((await call('GET', `${BASE}/unknown`)).response.status).toBe(404)
    expect((await call('GET', `${BASE}/${id}/documents/manifest_csv`)).response.status).toBe(404)
    expect((await call('GET', `${BASE}/${id}/documents/other`)).response.status).toBe(400)
    expect((await call('GET', `${BASE}?status=bogus`)).response.status).toBe(400)
    expect((await call('DELETE', BASE)).response.status).toBe(405)
    expect((await call('GET', `${BASE}/${id}/nope`)).response.status).toBe(404)
    const failing = await call(
      'POST',
      `${BASE}/${id}/close`,
      { commandId: 'cmd-http-012', expectedVersion: 1 },
      ADMIN,
      createLocalCarrierManifestAdapter({ fail: 'close' })
    )
    expect(failing.response.status).toBe(502)
    expect(failing.json.error.code).toBe('carrier_unavailable')
  })
})

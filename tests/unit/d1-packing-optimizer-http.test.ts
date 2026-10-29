/* eslint-disable @typescript-eslint/no-explicit-any -- loosely typed JSON/fetch doubles in this test file */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  handlePackingOptimizerHttp,
  ownsPackingOptimizerNamespace
} from '../../workers/fulfillment/packing-optimizer-http'
import { ADMIN, NOW, OTHER, opsWorld, type OpsWorld } from './shipping-ops-fixture'

let w: OpsWorld
beforeEach(async () => {
  w = await opsWorld()
})
afterEach(() => w.close())

const call = async (method: string, path: string, body?: unknown, identity: string | null = ADMIN) => {
  const response = await handlePackingOptimizerHttp(
    new Request(`https://tienda.example.com${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) })
    }),
    { database: w.db, sessionProvider: async () => (identity ? { identityId: identity } : null), now: () => NOW }
  )
  return { response: response!, json: (await response!.json()) as Record<string, any> }
}
const profileBody = {
  weightGrams: 1100,
  widthMm: 80,
  heightMm: 200,
  depthMm: 80,
  hazardClass: 'none',
  expectedVersion: 0
}

describe('SHP-030 packing optimiser HTTP', () => {
  it('owns only its namespace', async () => {
    expect(ownsPackingOptimizerNamespace('/api/admin/packing-optimizer')).toBe(true)
    expect(ownsPackingOptimizerNamespace('/api/admin/packing-optimizer/boxes/S')).toBe(true)
    expect(ownsPackingOptimizerNamespace('/api/admin/packing-optimizerx')).toBe(false)
    expect(await handlePackingOptimizerHttp(new Request('https://x.example/api/orders'), { database: w.db })).toBeNull()
  })

  it('rejects anonymous (401) and non-admin (403) callers with no-store', async () => {
    const anonymous = await call('GET', '/api/admin/packing-optimizer', undefined, null)
    expect(anonymous.response.status).toBe(401)
    expect(anonymous.response.headers.get('cache-control')).toContain('no-store')
    const other = await call('GET', '/api/admin/packing-optimizer', undefined, OTHER)
    expect(other.response.status).toBe(403)
    expect(other.json.error.code).toBe('forbidden')
    expect(
      (
        await call(
          'POST',
          '/api/admin/packing-optimizer/suggestions',
          { commandId: 'cmd-http-001', lines: [{ sku: 'A', quantity: 1 }] },
          OTHER
        )
      ).response.status
    ).toBe(403)
  })

  it('runs the whole flow: profile, suggestion, warehouse validation', async () => {
    const config = await call('GET', '/api/admin/packing-optimizer')
    expect(config.response.status).toBe(200)
    expect(config.json.boxes).toHaveLength(3)
    expect((await call('PUT', '/api/admin/packing-optimizer/profiles/SOAP', profileBody)).response.status).toBe(200)
    const created = await call('POST', '/api/admin/packing-optimizer/suggestions', {
      commandId: 'cmd-http-002',
      lines: [{ sku: 'SOAP', quantity: 2, lineIndex: 0 }]
    })
    expect(created.response.status).toBe(201)
    const id = created.json.suggestion.id as string
    expect((await call('GET', `/api/admin/packing-optimizer/suggestions/${id}`)).json.suggestion.status).toBe(
      'suggested'
    )
    const weight = created.json.suggestion.plan.parcels[0].grossWeightGrams as number
    const decided = await call('POST', `/api/admin/packing-optimizer/suggestions/${id}/decision`, {
      commandId: 'cmd-http-003',
      expectedVersion: 1,
      decision: 'accept',
      actualParcels: [{ parcelIndex: 0, weightGrams: weight }]
    })
    expect(decided.response.status).toBe(200)
    expect(decided.json.suggestion.status).toBe('validated')
    const stale = await call('POST', `/api/admin/packing-optimizer/suggestions/${id}/decision`, {
      commandId: 'cmd-http-004',
      expectedVersion: 1,
      decision: 'reject',
      note: 'Segundo intento tardio'
    })
    expect(stale.response.status).toBe(409)
    expect(stale.json.error.code).toBe('invalid_transition')
  })

  it('maps domain errors to stable statuses', async () => {
    expect(
      (
        await call('POST', '/api/admin/packing-optimizer/suggestions', {
          commandId: 'cmd-http-005',
          lines: [{ sku: 'NOPE', quantity: 1 }]
        })
      ).response.status
    ).toBe(422)
    expect((await call('POST', '/api/admin/packing-optimizer/suggestions', '{broken')).response.status).toBe(400)
    expect((await call('POST', '/api/admin/packing-optimizer/suggestions', { commandId: 'x' })).response.status).toBe(
      400
    )
    expect(
      (
        await call('POST', '/api/admin/packing-optimizer/suggestions', {
          commandId: 'cmd-http-006',
          lines: [{ sku: 'A', quantity: 1 }],
          extra: 1
        })
      ).response.status
    ).toBe(400)
    expect((await call('GET', '/api/admin/packing-optimizer/suggestions/missing')).response.status).toBe(404)
    expect(
      (
        await call('PUT', '/api/admin/packing-optimizer/boxes/S', {
          name: 'S',
          widthMm: 200,
          heightMm: 150,
          depthMm: 150,
          tareGrams: 150,
          maxWeightGrams: 5000,
          hazmatAllowed: true,
          active: true,
          expectedVersion: 0
        })
      ).response.status
    ).toBe(409)
    expect((await call('GET', '/api/admin/packing-optimizer/nope')).response.status).toBe(404)
    expect((await call('DELETE', '/api/admin/packing-optimizer')).response.status).toBe(405)
    expect((await call('POST', '/api/admin/packing-optimizer/suggestions', 'x'.repeat(300000))).response.status).toBe(
      413
    )
  })

  it('manages incompatibility rules', async () => {
    expect(
      (
        await call('PUT', '/api/admin/packing-optimizer/incompatibilities', {
          classA: 'toxic',
          classB: 'irritant',
          reason: 'Prueba'
        })
      ).response.status
    ).toBe(200)
    expect(
      (await call('GET', '/api/admin/packing-optimizer')).json.incompatibilities.some(
        (r: any) => r.classA === 'irritant'
      )
    ).toBe(true)
    expect(
      (await call('DELETE', '/api/admin/packing-optimizer/incompatibilities/irritant/toxic')).response.status
    ).toBe(200)
    expect(
      (await call('DELETE', '/api/admin/packing-optimizer/incompatibilities/irritant/toxic')).response.status
    ).toBe(404)
    expect(
      (
        await call('PUT', '/api/admin/packing-optimizer/incompatibilities', {
          classA: 'zzz',
          classB: 'toxic',
          reason: 'Prueba'
        })
      ).response.status
    ).toBe(400)
  })
})

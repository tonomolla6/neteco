/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import {
  handleInventoryPlanningHttp,
  ownsInventoryPlanningNamespace
} from '../../workers/catalog/inventory-planning-http'
import {
  PLANNING_VARIANT,
  claimsA,
  claimsNoRole,
  openPlanningFixture,
  uuid
} from '../support/inventory-planning-fixture'

const ORIGIN = 'https://neteco.test'
let sqlite: DatabaseSync
let db: D1Database
let config: any
beforeEach(async () => {
  ;({ sqlite, database: db } = await openPlanningFixture())
  config = { password: 'synthetic-planning-cookie-more-than-32-chars', maxAgeSeconds: 3600 }
})
afterEach(() => sqlite.close())

async function cookieFor(claims: typeof claimsA) {
  return (await issueD1SessionCookie(db, claims, config))!.split(';')[0]!
}
async function call(
  path: string,
  init: { method?: string; body?: unknown; claims?: typeof claimsA; headers?: Record<string, string> } = {}
) {
  const headers: Record<string, string> = { ...(init.headers ?? {}) }
  if (init.body !== undefined) headers['content-type'] = 'application/json'
  if ((init.method ?? 'GET') === 'POST') {
    headers.origin = ORIGIN
    headers['idempotency-key'] ??= uuid()
  }
  const cookie = init.claims ? await cookieFor(init.claims).catch(() => null) : null
  if (cookie) headers.cookie = cookie
  return handleInventoryPlanningHttp(
    new Request(ORIGIN + path, {
      method: init.method ?? 'GET',
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body)
    }),
    { database: db, origin: ORIGIN, sessionCookieConfiguration: config }
  )
}

describe('INV-017/018/020 http boundary', () => {
  it('owns only its namespaces, including encoded forms', () => {
    expect(ownsInventoryPlanningNamespace('/api/admin/inventory/reorder/policies')).toBe(true)
    expect(ownsInventoryPlanningNamespace('/api/admin/inventory/cycle-counts')).toBe(true)
    expect(ownsInventoryPlanningNamespace('/api/admin/warehouse/barcode-tasks/x')).toBe(true)
    expect(ownsInventoryPlanningNamespace('/api/admin/inventory%2Fcycle-counts')).toBe(true)
    expect(ownsInventoryPlanningNamespace('/api/admin/warehouse/scan')).toBe(false)
    expect(ownsInventoryPlanningNamespace('/api/admin/inventory/count-imports')).toBe(false)
  })
  it('returns null for foreign paths and 404/405 for unknown routes and methods', async () => {
    expect(await call('/api/other')).toBeNull()
    expect((await call('/api/admin/inventory/reorder/unknown', { claims: claimsA }))!.status).toBe(404)
    expect((await call('/api/admin/inventory/reorder/evaluate', { claims: claimsA }))!.status).toBe(405)
    expect((await call('/api/admin/inventory/cycle-counts/not-a-uuid', { claims: claimsA }))!.status).toBe(404)
  })
  it('rejects unauthenticated, cross-origin and missing idempotency key requests', async () => {
    const anon = await call('/api/admin/inventory/reorder/policies')
    expect(anon!.status).toBe(401)
    expect(await anon!.json()).toEqual({ error: { code: 'unauthenticated' } })
    const csrf = await handleInventoryPlanningHttp(
      new Request(ORIGIN + '/api/admin/inventory/reorder/evaluate', {
        method: 'POST',
        headers: { origin: 'https://evil.test', 'content-type': 'application/json' },
        body: '{}'
      }),
      { database: db, origin: ORIGIN, sessionCookieConfiguration: config }
    )
    expect(csrf!.status).toBe(403)
    const noKey = await handleInventoryPlanningHttp(
      new Request(ORIGIN + '/api/admin/inventory/reorder/evaluate', {
        method: 'POST',
        headers: { origin: ORIGIN, 'content-type': 'application/json' },
        body: '{}'
      }),
      { database: db, origin: ORIGIN, sessionCookieConfiguration: config }
    )
    expect([400, 401]).toContain(noKey!.status)
  })
  it('is unavailable without session configuration', async () => {
    const r = await handleInventoryPlanningHttp(new Request(ORIGIN + '/api/admin/inventory/reorder/policies'), {
      database: db,
      origin: ORIGIN,
      sessionCookieConfiguration: null
    })
    expect(r!.status).toBe(503)
  })
  it('serves reads with no-store headers and enforces permission', async () => {
    const ok = await call('/api/admin/inventory/reorder/policies', { claims: claimsA })
    expect(ok!.status).toBe(200)
    expect(ok!.headers.get('cache-control')).toBe('private, no-store')
    expect(await ok!.json()).toEqual({ policies: [] })
    const denied = await call('/api/admin/inventory/reorder/policies', { claims: claimsNoRole })
    expect(denied!.status).toBe(403)
    expect((await call('/api/admin/inventory/reorder/policies?bad=1', { claims: claimsA }))!.status).toBe(400)
    expect((await call('/api/admin/inventory/reorder/suggestions?limit=0', { claims: claimsA }))!.status).toBe(400)
  })
  it('drives the full flow over HTTP: policy, evaluation, plan, count and scan', async () => {
    const policy = await call('/api/admin/inventory/reorder/policies', {
      method: 'POST',
      claims: claimsA,
      body: { variantId: PLANNING_VARIANT, leadTimeDays: 7 }
    })
    expect(policy!.status).toBe(201)
    const badBody = await call('/api/admin/inventory/reorder/policies', {
      method: 'POST',
      claims: claimsA,
      body: { variantId: PLANNING_VARIANT, leadTimeDays: 999 }
    })
    expect(badBody!.status).toBe(400)
    const plan = await call('/api/admin/inventory/cycle-counts', {
      method: 'POST',
      claims: claimsA,
      body: { name: 'Conteo HTTP', scheduledFor: '2026-11-02T08:00:00Z', variantIds: [PLANNING_VARIANT] }
    })
    expect(plan!.status).toBe(201)
    const created = (await plan!.json()) as { id: string }
    const read = await call(`/api/admin/inventory/cycle-counts/${created.id}`, { claims: claimsA })
    expect(((await read!.json()) as any).lines).toHaveLength(1)
    const dup = await call('/api/admin/inventory/cycle-counts/' + created.id + '/start', {
      method: 'POST',
      claims: claimsA,
      body: { expectedVersion: 9 }
    })
    expect(dup!.status).toBe(409)
    const task = await call('/api/admin/warehouse/barcode-tasks', {
      method: 'POST',
      claims: claimsA,
      body: { stage: 'receiving', reference: 'ALB-HTTP', lines: [{ sku: 'SYNTHETIC-SKU', quantity: 1 }] }
    })
    const taskId = ((await task!.json()) as { id: string }).id
    const bad = await call(`/api/admin/warehouse/barcode-tasks/${taskId}/scan`, {
      method: 'POST',
      claims: claimsA,
      body: { barcode: '1111111111111' }
    })
    expect(bad!.status).toBe(409)
    expect(((await bad!.json()) as any).error.code).toBe('barcode_unknown')
    const good = await call(`/api/admin/warehouse/barcode-tasks/${taskId}/scan`, {
      method: 'POST',
      claims: claimsA,
      body: { barcode: '8437001234567' }
    })
    expect(good!.status).toBe(201)
    expect(((await good!.json()) as any).taskStatus).toBe('completed')
  })
  it('rejects non-JSON bodies', async () => {
    const r = await call('/api/admin/inventory/reorder/evaluate', {
      method: 'POST',
      claims: claimsA,
      headers: { 'content-type': 'text/plain' }
    })
    expect([415, 400]).toContain(r!.status)
  })
})

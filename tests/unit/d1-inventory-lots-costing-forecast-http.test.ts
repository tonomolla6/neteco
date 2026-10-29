import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { issueD1SessionCookie, type SessionCookieConfiguration } from '../../workers/auth/session-cookie'
import {
  handleInventoryLotsCostingForecastHttp as handle,
  ownsInventoryLotsCostingForecastNamespace
} from '../../workers/catalog/inventory-lots-costing-forecast-http'
import {
  openAdminInventoryFixture,
  INVENTORY_FIXTURE_ACTOR,
  INVENTORY_FIXTURE_SESSION,
  INVENTORY_FIXTURE_VARIANT
} from '../support/admin-inventory-fixture'
import { lotsCostingIntentHash } from '../../shared/inventory-lots-costing-forecast'

const origin = 'https://inventory.neteco.test'
const sessionCookieConfiguration: SessionCookieConfiguration = {
  password: 'synthetic-lots-costing-cookie-more-than-32-chars',
  maxAgeSeconds: 3600
}
const claims = { identityId: INVENTORY_FIXTURE_ACTOR, sessionId: INVENTORY_FIXTURE_SESSION, sessionVersion: 1 }
const commandId = '70000000-0000-4000-8000-000000000001'
let fixture: Awaited<ReturnType<typeof openAdminInventoryFixture>>
let cookie: string

const dependencies = (database = fixture.database) => ({
  database,
  origin,
  sessionCookieConfiguration,
  edgeLimiter: { limit: async () => ({ success: true }) } as unknown as RateLimit,
  rateLimitPepper: 'synthetic-lots-costing-pepper-more-than-32'
})

const handleLotsCostingHttp = (request: Request, database: D1Database = fixture.database) =>
  handle(request, dependencies(database))

function request(
  path: string,
  method = 'GET',
  options: {
    anonymous?: boolean
    body?: unknown
    headers?: Record<string, string>
    idempotencyKey?: string
    payloadHash?: string
  } = {}
) {
  return new Request(origin + path, {
    method,
    headers: {
      Origin: origin,
      ...(options.anonymous ? {} : { Cookie: cookie }),
      'Content-Type': 'application/json',
      'CF-Connecting-IP': '192.0.2.100',
      ...(options.idempotencyKey ? { 'Idempotency-Key': options.idempotencyKey } : {}),
      ...(options.payloadHash ? { 'X-Neteco-Command-Payload-Hash': options.payloadHash } : {}),
      ...options.headers
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) })
  })
}

beforeEach(async () => {
  fixture = await openAdminInventoryFixture()
  fixture.sqlite.exec(
    await readFile(new URL('../../db/d1/migrations/0106_inventory_lots_costing_forecast.sql', import.meta.url), 'utf8')
  )
  cookie = (await issueD1SessionCookie(fixture.database, claims, sessionCookieConfiguration))!.split(';')[0]!
})

afterEach(() => {
  fixture?.sqlite.close()
  vi.restoreAllMocks()
})

describe('inventory lots, costing & forecast HTTP boundary', () => {
  it('identifies owned namespace correctly', () => {
    expect(ownsInventoryLotsCostingForecastNamespace('/api/admin/inventory/lots')).toBe(true)
    expect(ownsInventoryLotsCostingForecastNamespace('/api/admin/inventory/lots/traceability')).toBe(true)
    expect(ownsInventoryLotsCostingForecastNamespace('/api/admin/inventory/costing/margin')).toBe(true)
    expect(ownsInventoryLotsCostingForecastNamespace('/api/admin/inventory/forecast/evaluate')).toBe(true)
    expect(ownsInventoryLotsCostingForecastNamespace('/api/admin/inventory/forecast/suggestions')).toBe(true)
    expect(ownsInventoryLotsCostingForecastNamespace('/api/admin/inventory/forecast/anomalies')).toBe(true)
    expect(ownsInventoryLotsCostingForecastNamespace('/api/admin/inventory/lots-costing/commands')).toBe(true)

    // Unrelated paths
    expect(ownsInventoryLotsCostingForecastNamespace('/api/admin/catalog')).toBe(false)
    expect(ownsInventoryLotsCostingForecastNamespace('/api/admin/inventory/alerts')).toBe(false)
    expect(ownsInventoryLotsCostingForecastNamespace('/api/admin/inventory/counts')).toBe(false)
  })

  it('rejects unauthenticated requests with 401', async () => {
    const res = await handleLotsCostingHttp(request('/api/admin/inventory/lots', 'GET', { anonymous: true }))
    expect(res).not.toBeNull()
    expect(res!.status).toBe(401)
    const json = (await res!.json()) as { error: { code: string } }
    expect(json.error.code).toBe('unauthenticated')
  })

  it('rejects cross-site CSRF requests with 403', async () => {
    const req = new Request(origin + '/api/admin/inventory/lots', {
      method: 'GET',
      headers: {
        Origin: 'https://evil.attacker.invalid',
        Cookie: cookie
      }
    })
    const res = await handleLotsCostingHttp(req)
    expect(res!.status).toBe(403)
    const json = (await res!.json()) as { error: { code: string } }
    expect(json.error.code).toBe('csrf_rejected')
  })

  it('executes a lot creation command over HTTP with idempotency key', async () => {
    const cmdId = commandId
    const body = {
      variantId: INVENTORY_FIXTURE_VARIANT,
      lotNumber: 'HTTP-LOT-01',
      expiresAt: '2027-01-01T00:00:00Z',
      initialQuantity: 25,
      reason: 'Standard stock lot via HTTP'
    }
    const hash = await lotsCostingIntentHash('create_lot', cmdId, body)

    const res = await handleLotsCostingHttp(
      request('/api/admin/inventory/lots-costing/commands', 'POST', {
        body: { action: 'create_lot', targetId: cmdId, input: body },
        idempotencyKey: cmdId,
        payloadHash: hash
      })
    )

    expect(res!.status).toBe(200)
    expect(res!.headers.get('cache-control')).toBe('private, no-store')
    expect(res!.headers.get('vary')).toBe('Cookie')
    const json = (await res!.json()) as { commandId: string; action: string }
    expect(json.commandId).toBe(cmdId)
    expect(json.action).toBe('create_lot')
  })

  it('lists lots over HTTP GET', async () => {
    const res = await handleLotsCostingHttp(
      request(`/api/admin/inventory/lots?variantId=${INVENTORY_FIXTURE_VARIANT}`, 'GET')
    )
    expect(res!.status).toBe(200)
    const json = (await res!.json()) as { items: unknown[] }
    expect(Array.isArray(json.items)).toBe(true)
  })

  it('returns analytical margin report over HTTP GET', async () => {
    const res = await handleLotsCostingHttp(
      request(
        `/api/admin/inventory/costing/margin?variantId=${INVENTORY_FIXTURE_VARIANT}&periodStart=2026-01-01T00:00:00Z&periodEnd=2026-12-31T23:59:59Z`,
        'GET'
      )
    )
    expect(res!.status).toBe(200)
    const json = (await res!.json()) as { source: string; reconciliationStatus: string }
    expect(json.source).toBe('cloudflare')
    expect(json.reconciliationStatus).toBe('reconciled')
  })

  it('evaluates demand forecast over HTTP POST', async () => {
    const res = await handleLotsCostingHttp(
      request('/api/admin/inventory/forecast/evaluate', 'POST', {
        body: { variantId: INVENTORY_FIXTURE_VARIANT, leadTimeDays: 7, historyDays: 14 }
      })
    )
    expect(res!.status).toBe(200)
    const json = (await res!.json()) as { variantId: string; baselineModel: string }
    expect(json.variantId).toBe(INVENTORY_FIXTURE_VARIANT)
    expect(json.baselineModel).toBe('simple_moving_average')
  })

  it('queries reorder suggestions and anomalies over HTTP GET', async () => {
    const resSugg = await handleLotsCostingHttp(
      request(`/api/admin/inventory/forecast/suggestions?variantId=${INVENTORY_FIXTURE_VARIANT}`, 'GET')
    )
    expect(resSugg!.status).toBe(200)

    const resAnom = await handleLotsCostingHttp(
      request(`/api/admin/inventory/forecast/anomalies?variantId=${INVENTORY_FIXTURE_VARIANT}`, 'GET')
    )
    expect(resAnom!.status).toBe(200)
  })
})

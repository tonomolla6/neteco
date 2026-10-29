import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { issueD1SessionCookie, type SessionCookieConfiguration } from '../../workers/auth/session-cookie'
import { handleAdminInventoryHttp } from '../../workers/catalog/admin-inventory-http'
import { handleInventoryAlertsHttp as handle } from '../../workers/catalog/inventory-alerts-http'
import { inventoryAlertIntentHash } from '../../shared/inventory-alerts'
import {
  openAdminInventoryFixture,
  INVENTORY_FIXTURE_ACTOR,
  INVENTORY_FIXTURE_SESSION
} from '../support/admin-inventory-fixture'

const origin = 'https://inventory-alerts.neteco.test'
const sessionCookieConfiguration: SessionCookieConfiguration = {
  password: 'synthetic-inventory-alerts-cookie-more-than-32',
  maxAgeSeconds: 3600
}
const claims = { identityId: INVENTORY_FIXTURE_ACTOR, sessionId: INVENTORY_FIXTURE_SESSION, sessionVersion: 1 }
const episodeId = '50000000-0000-4000-8000-000000000067'
const commandId = '60000000-0000-4000-8000-000000000067'
let fixture: Awaited<ReturnType<typeof openAdminInventoryFixture>>, cookie: string

const dependencies = (database = fixture.database) => ({
  database,
  origin,
  sessionCookieConfiguration,
  edgeLimiter: { limit: async () => ({ success: true }) } as RateLimit,
  rateLimitPepper: 'synthetic-inventory-alerts-pepper-more-than-32'
})
// Baseline recorded against actual legacy handler: 8 behavioral failures (400
// instead of401/405), valid legacy control passed. Now exercise the real new HTTP.
const handleInventoryAlertsHttp = (request: Request, database: D1Database) => handle(request, dependencies(database))

function request(
  path: string,
  method = 'GET',
  options: { anonymous?: boolean; body?: unknown; headers?: Record<string, string> } = {}
) {
  return new Request(origin + path, {
    method,
    headers: {
      Origin: origin,
      ...(options.anonymous ? {} : { Cookie: cookie }),
      'Content-Type': 'application/json',
      'CF-Connecting-IP': '192.0.2.67',
      'Idempotency-Key': commandId,
      'X-Neteco-Command-Payload-Hash': 'a'.repeat(64),
      ...options.headers
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) })
  })
}
function privateResponse(response: Response | null) {
  expect(response).not.toBeNull()
  expect(response!.headers.get('cache-control')).toBe('private, no-store')
  expect(response!.headers.get('vary')).toBe('Cookie')
  expect(response!.headers.get('set-cookie')).toBeNull()
  expect(response!.headers.get('referrer-policy')).toBe('no-referrer')
}
beforeEach(async () => {
  fixture = await openAdminInventoryFixture()
  if (!fixture.sqlite.prepare("SELECT 1 FROM sqlite_schema WHERE name='inventory_alert_commands'").get())
    fixture.sqlite.exec(
      await readFile(new URL('../../db/d1/migrations/0067_inventory_alerts.sql', import.meta.url), 'utf8')
    )
  cookie = (await issueD1SessionCookie(fixture.database, claims, sessionCookieConfiguration))!.split(';')[0]!
})
afterEach(() => {
  fixture?.sqlite.close()
  vi.restoreAllMocks()
})

describe('inventory alerts private HTTP boundary', () => {
  it.each([
    '/api/admin/inventory/alerts',
    '/api/admin/inventory/variants/11/alert-policy',
    `/api/admin/inventory/alerts/commands/${commandId}`
  ])('requires a current session for canonical GET %s without accessing D1 anonymously', async (path) => {
    const prepare = vi.fn(() => {
      throw new Error('unexpected_anonymous_db')
    })
    const response = await handleInventoryAlertsHttp(request(path, 'GET', { anonymous: true }), {
      prepare
    } as unknown as D1Database)
    expect(response!.status).toBe(401)
    expect(await response!.json()).toEqual({ error: { code: 'unauthenticated' } })
    expect(prepare).not.toHaveBeenCalled()
    privateResponse(response)
  })
  it.each([
    ['/api/admin/inventory/alerts', 'GET'],
    ['/api/admin/inventory/variants/11/alert-policy', 'GET, PUT'],
    [`/api/admin/inventory/alerts/${episodeId}/ack`, 'POST'],
    ['/api/admin/inventory/alerts/evaluate', 'POST'],
    [`/api/admin/inventory/alerts/commands/${commandId}`, 'GET']
  ])('rejects unsupported methods at %s before auth/DB, with Allow %s', async (path, allow) => {
    const prepare = vi.fn(() => {
      throw new Error('unexpected_method_db')
    })
    const response = await handleInventoryAlertsHttp(request(path, 'DELETE', { anonymous: true }), {
      prepare
    } as unknown as D1Database)
    expect(response!.status).toBe(405)
    expect(response!.headers.get('allow')).toBe(allow)
    expect(prepare).not.toHaveBeenCalled()
    privateResponse(response)
  })
  it('uses the real live inventory fixture/session as a valid legacy control', async () => {
    const response = await handleAdminInventoryHttp(
      request('/api/admin/inventory/variants/11'),
      {
        DB: fixture.database,
        AUTH_ENABLED: 'true',
        AUTH_ORIGIN: origin,
        NUXT_SESSION_PASSWORD: sessionCookieConfiguration.password
      },
      {
        coordinate: async () => {
          throw new Error('unexpected_legacy_command')
        }
      }
    )
    expect(response!.status).toBe(200)
    expect(await response!.json()).toMatchObject({ source: 'cloudflare', variant: { id: 11 } })
  })
  it.each(['/api/admin/inventory/variants/11', '/api/admin/inventory/receipts', '/api/admin/inventoryX/alerts'])(
    'does not steal the legacy/unrelated namespace %s',
    async (path) => {
      expect(await handle(request(path), dependencies())).toBeNull()
    }
  )
  it.each([
    '/api/admin/inventory/%61lerts',
    '/api/admin/inventory/alerts%2fevaluate',
    '/api/admin/inventory/variants/11/%61lert-policy',
    '/api/admin/inventory/variants/01/alert-policy',
    '/api/admin/inventory/alerts/unknown'
  ])('fails closed on aliases/malformed owned paths %s', async (path) => {
    const response = await handle(request(path), dependencies())
    expect(response!.status).toBe(400)
    privateResponse(response)
  })
  it.each([
    '?page=01',
    '?perPage=26',
    '?page=1&page=2',
    '?unknown=1',
    '?state=missing',
    '?kind=missing',
    '?q=' + 'a'.repeat(101)
  ])('rejects invalid bounded list query %s', async (query) => {
    const response = await handle(request('/api/admin/inventory/alerts' + query), dependencies())
    expect(response!.status).toBe(400)
  })
  it('fails closed when the mandatory edge limiter is unavailable', async () => {
    const prepare = vi.fn(() => {
      throw new Error('unexpected_db')
    })
    const response = await handle(request('/api/admin/inventory/alerts'), {
      ...dependencies({ prepare } as unknown as D1Database),
      edgeLimiter: undefined as unknown as RateLimit
    })
    expect(response!.status).toBe(503)
    expect(prepare).not.toHaveBeenCalled()
  })
  it('returns429 without DB access when edge limits reject', async () => {
    const prepare = vi.fn(() => {
      throw new Error('unexpected_db')
    })
    const response = await handle(request('/api/admin/inventory/alerts'), {
      ...dependencies({ prepare } as unknown as D1Database),
      edgeLimiter: { limit: async () => ({ success: false }) } as RateLimit
    })
    expect(response!.status).toBe(429)
    expect(prepare).not.toHaveBeenCalled()
  })
  it.each(['email', 'mfa', 'grant', 'session'])(
    'rechecks current %s authority, not sealed grants',
    async (boundary) => {
      if (boundary === 'email')
        fixture.sqlite.prepare('UPDATE identities SET email_verified_at=NULL WHERE id=?').run(claims.identityId)
      if (boundary === 'mfa')
        fixture.sqlite.prepare('UPDATE auth_sessions SET mfa_verified=0 WHERE id=?').run(claims.sessionId)
      if (boundary === 'grant')
        fixture.sqlite.prepare('DELETE FROM identity_roles WHERE identity_id=?').run(claims.identityId)
      if (boundary === 'session')
        fixture.sqlite.prepare('UPDATE identities SET session_version=2 WHERE id=?').run(claims.identityId)
      const response = await handle(request('/api/admin/inventory/alerts'), dependencies())
      expect(response!.status).toBe(boundary === 'session' ? 401 : 403)
      privateResponse(response)
    }
  )
  it('keeps inventory.read separate from inventory.write including command lookup', async () => {
    fixture.sqlite.prepare("DELETE FROM role_permissions WHERE permission_code='inventory.write'").run()
    expect((await handle(request('/api/admin/inventory/alerts'), dependencies()))!.status).toBe(200)
    expect((await handle(request(`/api/admin/inventory/alerts/commands/${commandId}`), dependencies()))!.status).toBe(
      403
    )
    expect(
      (await handle(request('/api/admin/inventory/alerts/evaluate', 'POST', { body: { limit: 1 } }), dependencies()))!
        .status
    ).toBe(403)
  })
  it('changes policy explicitly, recovers exact receipt, and leaves stock untouched', async () => {
    const stock = () => fixture.sqlite.prepare('SELECT * FROM inventory_balances').all()
    const before = stock(),
      input = { expectedVersion: 0, threshold: 20, reason: 'Synthetic warehouse threshold' }
    const send = () =>
      handle(request('/api/admin/inventory/variants/11/alert-policy', 'PUT', { body: input }), dependencies())
    const response = await send()
    expect(response!.status).toBe(200)
    const receipt = await response!.json()
    const hash = await inventoryAlertIntentHash('threshold', '11', input)
    expect(receipt).toMatchObject({ commandId, action: 'threshold', targetId: '11', payloadHash: hash, version: 1 })
    expect(await (await send())!.json()).toEqual(receipt)
    const recovered = await handle(
      request(`/api/admin/inventory/alerts/commands/${commandId}`, 'GET', {
        headers: { 'X-Neteco-Command-Payload-Hash': hash }
      }),
      dependencies()
    )
    expect(await recovered!.json()).toEqual({ source: 'cloudflare', outcome: 'applied', receipt })
    expect(stock()).toEqual(before)
  })
  it('does not equate an unknown durable command with absence', async () => {
    const response = await handle(request(`/api/admin/inventory/alerts/commands/${commandId}`), dependencies())
    expect(response!.status).toBe(200)
    expect(await response!.json()).toEqual({ source: 'cloudflare', outcome: 'unknown' })
  })
  it('allows a legitimate same-origin private GET without an Origin header', async () => {
    const response = await handle(
      new Request(origin + '/api/admin/inventory/alerts', {
        headers: { Cookie: cookie, 'CF-Connecting-IP': '192.0.2.67', 'Sec-Fetch-Site': 'same-origin' }
      }),
      dependencies()
    )
    expect(response!.status).toBe(200)
    expect(await response!.json()).toMatchObject({ source: 'cloudflare', items: [] })
    privateResponse(response)
  })
  it('reads the exact alert UUID even when its SKU exceeds the text query limit', async () => {
    fixture.sqlite.prepare('UPDATE variants SET sku=? WHERE legacy_id=11').run('S'.repeat(120))
    const created = await handle(
      request('/api/admin/inventory/variants/11/alert-policy', 'PUT', {
        body: { expectedVersion: 0, threshold: 20, reason: 'Synthetic exact alert recovery' }
      }),
      dependencies()
    )
    expect(created!.status).toBe(200)
    const id = fixture.sqlite.prepare('SELECT id FROM inventory_alert_episodes').get()!.id as string
    const exact = await handle(request(`/api/admin/inventory/alerts?state=all&alertId=${id}`), dependencies())
    expect(exact!.status).toBe(200)
    expect(await exact!.json()).toMatchObject({ items: [{ id, variantId: 11 }], pagination: { total: 1 } })
    const other = await handle(request(`/api/admin/inventory/alerts?state=all&alertId=${episodeId}`), dependencies())
    expect(other!.status).toBe(200)
    expect(await other!.json()).toMatchObject({ items: [], pagination: { total: 0 } })
  })
  it.each(['not-a-uuid', `${episodeId}&alertId=${episodeId}`])(
    'rejects invalid or repeated exact alert filters %s',
    async (filter) => {
      const response = await handle(request(`/api/admin/inventory/alerts?alertId=${filter}`), dependencies())
      expect(response!.status).toBe(400)
      privateResponse(response)
    }
  )
  it.each([
    { headers: { Origin: 'https://foreign.example.invalid' }, body: { limit: 1 }, expected: 403 },
    { headers: { 'Content-Length': '8193' }, body: { limit: 1 }, expected: 413 },
    { headers: { 'Content-Type': 'text/plain' }, body: { limit: 1 }, expected: 400 },
    { headers: {}, body: { limit: 101 }, expected: 400 },
    { headers: {}, body: { limit: 1, extra: true }, expected: 400 }
  ])('rejects invalid command transport/body before commands ($expected)', async ({ headers, body, expected }) => {
    const response = await handle(
      request('/api/admin/inventory/alerts/evaluate', 'POST', { headers, body }),
      dependencies()
    )
    expect(response!.status).toBe(expected)
    expect(fixture.sqlite.prepare('SELECT count(*) n FROM inventory_alert_commands').get()!.n).toBe(0)
  })
  it('rechecks live authority after a delayed body before executing any command', async () => {
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          fixture.sqlite.prepare('DELETE FROM identity_roles WHERE identity_id=?').run(claims.identityId)
          controller.enqueue(new TextEncoder().encode(JSON.stringify({ limit: 1 })))
          controller.close()
        }
      },
      { highWaterMark: 0 }
    )
    const original = request('/api/admin/inventory/alerts/evaluate', 'POST', { body: {} })
    const streamed = new Request(original.url, {
      method: 'POST',
      headers: original.headers,
      body,
      duplex: 'half'
    } as RequestInit)
    const response = await handle(streamed, dependencies())
    expect(response!.status).toBe(403)
    expect(fixture.sqlite.prepare('SELECT count(*) n FROM inventory_alert_commands').get()!.n).toBe(0)
  })
})

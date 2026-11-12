import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import { handleAdminInventoryHttp, ownsAdminInventoryNamespace } from '../../workers/catalog/admin-inventory-http'
import {
  executeD1AdminInventoryCommand,
  type AdminInventoryCoordinatorCommand
} from '../../workers/catalog/admin-inventory'
import {
  openAdminInventoryFixture,
  INVENTORY_FIXTURE_ACTOR,
  INVENTORY_FIXTURE_SESSION,
  inventoryFixtureUtc
} from '../support/admin-inventory-fixture'
import { testNow } from '../support/deterministic'

const claims = { identityId: INVENTORY_FIXTURE_ACTOR, sessionId: INVENTORY_FIXTURE_SESSION, sessionVersion: 1 }
const origin = 'https://neteco.invalid',
  password = 'synthetic-inventory-http-cookie-with-at-least-32-characters'
describe('private inventory HTTP boundary and existing coordinator contract', () => {
  let sqlite: DatabaseSync, database: D1Database, cookie: string
  const coordinate = vi.fn(async (command: AdminInventoryCoordinatorCommand) =>
    executeD1AdminInventoryCommand(database, command.claims, command.action, command.target, command.input, {
      idempotencyKey: command.idempotencyKey
    })
  )
  beforeEach(async () => {
    ;({ sqlite, database } = await openAdminInventoryFixture())
    coordinate.mockClear()
    cookie = (await issueD1SessionCookie(database, claims, { password, maxAgeSeconds: 3600 }))!.split(';')[0]!
  })
  afterEach(() => {
    sqlite.close()
    vi.restoreAllMocks()
  })
  function request(
    path = '/api/admin/inventory/variants/11/receipts',
    options: { method?: string; body?: unknown; headers?: Record<string, string>; db?: D1Database } = {}
  ) {
    const method = options.method ?? 'POST'
    return handleAdminInventoryHttp(
      new Request(origin + path, {
        method,
        headers: {
          origin,
          cookie,
          'content-type': 'application/json',
          'idempotency-key': 'receipt',
          ...options.headers
        },
        ...(method === 'GET'
          ? {}
          : {
              body: JSON.stringify(
                options.body ?? {
                  expectedBalanceVersion: 1,
                  quantity: 5,
                  reason: 'Synthetic documented physical receipt',
                  reference: 'SYNTHETIC-041'
                }
              )
            })
      }),
      { DB: options.db ?? database, AUTH_ENABLED: 'true', AUTH_ORIGIN: origin, NUXT_SESSION_PASSWORD: password },
      { coordinate }
    )
  }
  function privateHeaders(response: Response | null) {
    expect(response?.headers.get('cache-control')).toBe('private, no-store')
    expect(response?.headers.get('vary')).toBe('Cookie')
    expect(response?.headers.get('x-robots-tag')).toContain('noindex')
  }
  it('allows warehouse context and receipt without catalog/admin grants', async () => {
    const context = await request('/api/admin/inventory/variants/11', { method: 'GET' })
    expect(context?.status).toBe(200)
    privateHeaders(context)
    const receipt = await request()
    expect(receipt?.status).toBe(200)
    privateHeaders(receipt)
    expect(coordinate).toHaveBeenCalledTimes(1)
    expect(coordinate.mock.calls[0]?.[0]).toMatchObject({
      type: 'admin_inventory',
      claims,
      action: 'receipt',
      target: { variantId: '11' }
    })
    expect(Object.hasOwn(coordinate.mock.calls[0]![0], 'now')).toBe(false)
  })
  it('finds variant by SKU/name privately with inventory.read, literal bounded query and no finances', async () => {
    sqlite.exec("DELETE FROM role_permissions WHERE permission_code='inventory.write'")
    const response = await request('/api/admin/inventory/variants?q=synthetic&page=1&perPage=25', { method: 'GET' })
    expect(response?.status).toBe(200)
    privateHeaders(response)
    const body = await response?.text()
    expect(body).toContain('SYNTHETIC-SKU')
    expect(body).not.toContain('price')
    expect(coordinate).not.toHaveBeenCalled()
  })
  it.each([
    '?q=x',
    '?q=valid%0A',
    '?q=valid&perPage=26',
    '?q=valid&q=valid',
    '?q=valid&now=2099-01-01',
    '?q=%25_&page=01'
  ])('rejects noncanonical/unsafe selector query %s', async (query) => {
    expect((await request(`/api/admin/inventory/variants${query}`, { method: 'GET' }))?.status).toBe(400)
    expect(coordinate).not.toHaveBeenCalled()
  })
  it('does not expose a receipt when grant was revoked after a successful coordinated commit', async () => {
    coordinate.mockImplementationOnce(async (command) => {
      const receipt = await executeD1AdminInventoryCommand(
        database,
        command.claims,
        command.action,
        command.target,
        command.input,
        { idempotencyKey: command.idempotencyKey }
      )
      sqlite.exec(`DELETE FROM identity_roles WHERE identity_id='${claims.identityId}'`)
      return receipt
    })
    const response = await request()
    expect(response?.status).toBe(403)
    expect(await response?.text()).not.toContain('physicalQuantity')
    expect(sqlite.prepare('SELECT physical_quantity FROM inventory_balances').get()?.physical_quantity).toBe(25)
  })
  it('returns literally identical original receipt on retry without a second ledger write', async () => {
    const first = await request(),
      replay = await request()
    expect(await first?.text()).toBe(await replay?.text())
    expect(sqlite.prepare('SELECT count(*) AS n FROM inventory_admin_audit').get()?.n).toBe(1)
    expect(sqlite.prepare('SELECT physical_quantity FROM inventory_balances').get()?.physical_quantity).toBe(25)
  })
  it('checks Origin before cookie/body/D1/coordinator', async () => {
    let touched = 0
    const db = new Proxy(database, {
      get() {
        touched++
        throw new Error('must_not_touch')
      }
    })
    const response = await request(undefined, {
      headers: { origin: 'https://hostile.invalid', cookie: 'not-a-cookie' },
      db
    })
    expect(response?.status).toBe(403)
    expect(touched).toBe(0)
    expect(coordinate).not.toHaveBeenCalled()
    privateHeaders(response)
  })
  it.each(['01', '0', '-1', '1.0', '11%0A', '%31%31', '9007199254740992'])(
    'reserves but rejects noncanonical variant alias %s',
    async (id) => {
      const response = await request(`/api/admin/inventory/variants/${id}/receipts`)
      expect(response?.status).toBe(400)
      expect(coordinate).not.toHaveBeenCalled()
    }
  )
  it.each([
    '/api/admin/inventory/',
    '/api/admin/inventory%2Fvariants%2F11',
    '/api/admin%2Finventory/variants/11',
    '/api/admin/inventory\\variants\\11'
  ])('owns malformed inventory namespace %s', async (path) => {
    expect(ownsAdminInventoryNamespace(path)).toBe(true)
    const response = await request(path)
    expect(response).not.toBeNull()
    expect(coordinate).not.toHaveBeenCalled()
  })
  it.each(['?now=2099-01-01T00%3A00%3A00Z', '?page=01', '?perPage=51', '?page=1&page=1'])(
    'rejects clocks/query aliases %s',
    async (query) => {
      expect((await request(`/api/admin/inventory/variants/11${query}`, { method: 'GET' }))?.status).toBe(400)
      expect(coordinate).not.toHaveBeenCalled()
    }
  )
  it('requires live permission before dispatch and also before replay', async () => {
    await request()
    sqlite.exec(`DELETE FROM identity_roles WHERE identity_id='${claims.identityId}'`)
    coordinate.mockClear()
    expect((await request())?.status).toBe(403)
    expect(coordinate).not.toHaveBeenCalled()
  })
  it('denies stale MFA/email/cookie before reading body', async () => {
    sqlite.exec(`UPDATE auth_sessions SET mfa_verified=0 WHERE id='${claims.sessionId}'`)
    expect((await request(undefined, { body: 'not an object' }))?.status).toBe(403)
    expect(coordinate).not.toHaveBeenCalled()
  })
  it('enforces original actor count approval and route-owned proposal ID', async () => {
    const proposal = await request('/api/admin/inventory/variants/11/counts', {
      body: {
        expectedBalanceVersion: 1,
        countedPhysicalQuantity: 15,
        reason: 'Synthetic complete physical count',
        reference: 'COUNT-041'
      }
    })
    const result: unknown = await proposal?.json()
    if (!result || typeof result !== 'object' || !('proposalId' in result) || typeof result.proposalId !== 'string')
      throw new Error('fixture')
    expect(
      (
        await request(`/api/admin/inventory/variants/11/counts/${result.proposalId}/approve`, {
          headers: { 'idempotency-key': 'approval' },
          body: { expectedBalanceVersion: 1, reason: 'Independent count approval reason' }
        })
      )?.status
    ).toBe(409)
    expect(
      (
        await request('/api/admin/inventory/variants/11/counts', {
          body: {
            expectedBalanceVersion: 1,
            countedPhysicalQuantity: 15,
            reason: 'Synthetic complete physical count',
            reference: 'COUNT-041',
            countId: result.proposalId
          }
        })
      )?.status
    ).toBe(422)
  })
  it('rate limits 60 operations hourly before coordinator and never forwards test clocks', async () => {
    sqlite
      .prepare(
        "INSERT INTO identity_rate_limits(identity_id,scope,used,window_started_at,expires_at) VALUES(?,'admin-inventory',60,?,?)"
      )
      .run(claims.identityId, Math.floor(testNow() / 1000), Math.floor(testNow() / 1000) + 3600)
    const response = await request()
    expect(response?.status).toBe(429)
    expect(response?.headers.get('x-ratelimit-limit')).toBe('60')
    expect(coordinate).not.toHaveBeenCalled()
  })
  it('does not disguise coordinator/provider failure as business conflict', async () => {
    coordinate.mockRejectedValueOnce(new Error('inventory_admin_commands provider unavailable'))
    const response = await request()
    expect(response?.status).toBe(503)
    expect(await response?.text()).not.toContain('provider')
    privateHeaders(response)
  })
  it('outage in contextual all() is private 503, never zero stock', async () => {
    const db = new Proxy(database, {
      get(target, key, receiver) {
        if (key === 'prepare')
          return (sql: string) => {
            const stmt = target.prepare(sql)
            if (sql.includes('FROM state')) {
              const proxy: D1PreparedStatement = new Proxy(stmt, {
                get(s, k, r) {
                  if (k === 'bind')
                    return (...parameters: unknown[]) => {
                      s.bind(...parameters)
                      return proxy
                    }
                  if (k === 'all') return async () => ({ results: [] })
                  return Reflect.get(s, k, r)
                }
              })
              return proxy
            }
            return stmt
          }
        return Reflect.get(target, key, receiver)
      }
    })
    const response = await request('/api/admin/inventory/variants/11', { method: 'GET', db })
    expect(response?.status).toBe(503)
    expect(await response?.text()).not.toContain('physicalQuantity')
    privateHeaders(response)
  })
  it('rejects overlong declared body and invalid content type', async () => {
    expect((await request(undefined, { headers: { 'content-length': '65537' } }))?.status).toBe(413)
    expect((await request(undefined, { headers: { 'content-type': 'text/plain' } }))?.status).toBe(415)
    expect(coordinate).not.toHaveBeenCalled()
  })
  it('checks expired live sessions instead of trusting the sealed cookie', async () => {
    sqlite.prepare('UPDATE auth_sessions SET expires_at=? WHERE id=?').run(inventoryFixtureUtc(-1000), claims.sessionId)
    expect((await request())?.status).toBe(401)
    expect(coordinate).not.toHaveBeenCalled()
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { auditNativeReturns } from '../../scripts/lib/audit-native-returns'
import { handleAdminReturnsHttp } from '../../workers/returns/admin-http'
import { handleCustomerReturnsHttp } from '../../workers/returns/customer-http'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import { returnsFixture, CLAIMS, BUYER_CLAIMS } from './d1-returns-fixture'
const origin = 'https://returns-fixture.neteco.test',
  password = 'synthetic-rma-audit-cookie-not-for-production-over-32'
let sqlite: DatabaseSync | undefined
afterEach(() => {
  sqlite?.close()
  sqlite = undefined
  vi.restoreAllMocks()
})
async function fixture(options: { quantity?: number; paid?: boolean; delivered?: boolean } = {}) {
  const result = await returnsFixture()
  sqlite = result.sqlite
  const orderId = await result.order(options),
    adminCookie = (await issueD1SessionCookie(result.database, CLAIMS, { password, maxAgeSeconds: 3600 }))!.split(
      ';'
    )[0]!,
    customerCookie = (await issueD1SessionCookie(result.database, BUYER_CLAIMS, {
      password,
      maxAgeSeconds: 3600
    }))!.split(';')[0]!
  const env = { DB: result.database, AUTH_ENABLED: 'true', AUTH_ORIGIN: origin, NUXT_SESSION_PASSWORD: password }
  const dispatch = async (request: Request) =>
    (await handleAdminReturnsHttp(request, env)) ??
    (await handleCustomerReturnsHttp(request, env)) ??
    new Response(null, { status: 404 })
  const scenario = vi.fn()
  return {
    ...result,
    input: {
      database: result.database,
      dispatch,
      origin,
      adminCookie,
      customerCookie,
      guestCookie: 'neteco-order-access-v2=synthetic-unverified-guest',
      orderId,
      scenario
    }
  }
}
describe('native RMA audit using actual checkout, signed capture, delivery and HTTP engines', () => {
  it.each([1, 2])(
    'proves custody, audit, replay, quantity budget and zero economic effects for %i units',
    async (quantity) => {
      const { input, sqlite: db } = await fixture({ quantity }),
        evidence = await auditNativeReturns(input)
      expect(evidence).toMatchObject({
        finalState: 'resolution_ready',
        receivedUnits: quantity,
        inventoryUnchanged: true,
        contractUnchanged: true,
        economicEffects: false
      })
      expect(evidence.inventoryDigestAfter).toBe(evidence.inventoryDigestBefore)
      expect(input.scenario.mock.calls).toHaveLength(evidence.scenarios)
      expect(evidence.checks).toContain('native_returns_guest_requires_unavailable_verification_contract')
      expect(db.prepare('SELECT state FROM order_returns').get()?.state).toBe('resolution_ready')
      expect(db.prepare('SELECT count(*) AS n FROM order_return_commands').get()?.n).toBe(evidence.version)
      expect(db.prepare('SELECT count(*) AS n FROM order_return_events').get()?.n).toBe(evidence.version)
    }
  )
  it('rejects a real remote origin before dispatch or database access', async () => {
    const database = { batch: vi.fn() } as unknown as D1Database,
      dispatch = vi.fn()
    await expect(
      auditNativeReturns({
        database,
        dispatch,
        origin: 'https://neteco.es',
        adminCookie: 'synthetic=a',
        customerCookie: 'synthetic=b',
        orderId: '30000000-0000-4000-8000-000000000046',
        scenario: vi.fn()
      })
    ).rejects.toThrow('native_returns_local_origin_required')
    expect(dispatch).not.toHaveBeenCalled()
    expect(database.batch).not.toHaveBeenCalled()
  })
  it.each([{ paid: false, delivered: false }, { delivered: false }])(
    'does not manufacture missing paid/delivered proof %#',
    async (options) => {
      const { input, sqlite: db } = await fixture(options)
      await expect(auditNativeReturns(input)).rejects.toThrow('native_returns_baseline_not_ready')
      expect(db.prepare('SELECT count(*) AS n FROM order_return_commands').get()?.n).toBe(0)
    }
  )
  it('detects an inventory digest difference rather than normalizing away an unexpected effect', async () => {
    const { input } = await fixture()
    let count = 0
    const database = new Proxy(input.database, {
      get(target, key) {
        if (key === 'batch')
          return async (statements: D1PreparedStatement[]) => {
            const result = await target.batch(statements)
            if (statements.length > 20 && ++count === 2) {
              const row = result[1]?.results[0]
              if (row) Object.assign(row, { unexpectedEffect: true })
            }
            return result
          }
        const value = Reflect.get(target, key)
        return typeof value === 'function' ? value.bind(target) : value
      }
    })
    await expect(auditNativeReturns({ ...input, database })).rejects.toThrow('native_returns_inventory_changed')
    expect(input.scenario.mock.calls.at(-1)?.[0]).toBe('native_returns_zero_inventory_payment_fiscal_effects')
  })
  it('unconfirmed D1 result envelope stops before any RMA command', async () => {
    const { input, sqlite: db } = await fixture()
    const database = new Proxy(input.database, {
      get(target, key) {
        if (key === 'batch')
          return async (statements: D1PreparedStatement[]) => {
            const result = await target.batch(statements)
            Object.assign(result[0]!, { success: false })
            return result
          }
        const value = Reflect.get(target, key)
        return typeof value === 'function' ? value.bind(target) : value
      }
    })
    await expect(auditNativeReturns({ ...input, database })).rejects.toThrow('native_returns_d1_success_unconfirmed')
    expect(db.prepare('SELECT count(*) AS n FROM order_return_commands').get()?.n).toBe(0)
  })
})

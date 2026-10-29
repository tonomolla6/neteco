import { afterEach, describe, expect, it, vi } from 'vitest'
import worker from '../../workers/canary'
import { handleCartCommand } from '../../workers/cart-coordinator'
import { d1OverSqlite, openMigratedDatabase, seedInventoryFixture } from '../support/d1-sqlite'
import { provisionPublicationValidityFixture } from '../support/publication-validity-fixture'
import { deterministicTestData } from '../fixtures/deterministic'

const ORIGIN = 'https://shop.neteco.test'

describe('cart recovery at the actual Worker entrypoint', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('dispatches a complete ADD, then serves its historical receipt read-only after withdrawal', async () => {
    const sqlite = await openMigratedDatabase()
    try {
      const data = deterministicTestData('cart-worker-recovery', '2026-10-08T12:00:00.000Z')
      vi.useFakeTimers()
      vi.setSystemTime(data.date())
      seedInventoryFixture(sqlite)
      const database = d1OverSqlite(sqlite)
      await provisionPublicationValidityFixture(database, {
        productIds: ['p-1'],
        now: '2020-01-01T00:00:00Z',
        validUntil: '2099-01-01T00:00:00Z'
      })
      const responses = new Map<string, { payloadHash: string; status: number; body: unknown }>()
      const coordinator = vi.fn(async (request: Request) => {
        const command = (await request.json()) as Record<string, unknown>,
          cartId = String(command.cartId)
        const result = await handleCartCommand(command, {
          database,
          getResponse: async (key) => responses.get(`${cartId}:${key}`),
          putResponse: async (key, value) => {
            responses.set(`${cartId}:${key}`, value)
          },
          setAlarm: async () => {}
        })
        return Response.json(result.body, { status: result.status })
      })
      const env = {
        APP_ENV: 'local',
        AUTH_ENABLED: 'false',
        DB: database,
        CART_EDGE_LIMIT: { limit: async () => ({ success: true }) },
        AUTH_RATE_LIMIT_PEPPER: 'synthetic-cart-dispatch-pepper-over-32',
        CARTS: { idFromName: (name: string) => name, get: () => ({ fetch: coordinator }) }
      } as unknown as CloudflareEnv
      const send = (path: string, cookie?: string, payload?: Record<string, unknown>, expectedCartId?: string) =>
        worker.fetch(
          new Request(ORIGIN + path, {
            method: payload ? 'POST' : 'GET',
            headers: {
              'CF-Connecting-IP': '192.0.2.81',
              ...(cookie ? { Cookie: cookie } : {}),
              ...(expectedCartId ? { 'X-Neteco-Cart-Id': expectedCartId } : {}),
              ...(payload ? { Origin: ORIGIN, 'Content-Type': 'application/json' } : {})
            },
            ...(payload ? { body: JSON.stringify(payload) } : {})
          }),
          env
        )
      const created = await send('/api/cart')
      expect(created.status).toBe(200)
      const cookie = created.headers.get('set-cookie')!.split(';')[0]!,
        cart = (await created.json()) as { id: string },
        commandId = data.uuid()
      const added = await send(
        '/api/cart/items',
        cookie,
        {
          variantId: 11,
          quantity: 2,
          expectedVersion: 1,
          idempotencyKey: commandId
        },
        cart.id
      )
      expect(added.status).toBe(200)
      expect(await added.json()).toMatchObject({ items: [{ variantId: 11, qty: 2 }] })
      sqlite.exec(
        "UPDATE variants SET status='draft' WHERE id='v-1-1'; UPDATE carts SET status='expired',expired_at=expires_at"
      )
      const before = sqlite.prepare('SELECT total_changes() AS changes').get(),
        dispatchCount = coordinator.mock.calls.length
      const path = `/api/cart/operations/${commandId}?variantId=11&quantity=2&expectedVersion=1`
      const recovered = await send(path, cookie)
      expect(recovered.status).toBe(200)
      expect(recovered.headers.get('cache-control')).toBe('no-store')
      expect(recovered.headers.get('set-cookie')).toBeNull()
      expect(await recovered.json()).toEqual({
        source: 'cloudflare',
        cartId: cart.id,
        commandId,
        outcome: 'applied',
        appliedVersion: 2
      })
      expect((await send(path.replace('quantity=2', 'quantity=3'), cookie)).status).toBe(409)
      const unknown = await send(path.replace(commandId, data.uuid()), cookie)
      expect(unknown.status).toBe(200)
      expect(await unknown.json()).toMatchObject({ outcome: 'unknown', appliedVersion: null })
      for (const credential of [
        undefined,
        cookie.replace(/[^.]+$/, 'A'.repeat(43)),
        `neteco-cart-v2=v1.${data.uuid()}.${'A'.repeat(43)}`
      ]) {
        const unauthorized = await send(path, credential)
        expect(unauthorized.status).toBe(401)
        expect(await unauthorized.json()).toEqual({ error: { code: 'unauthorized' } })
        expect(unauthorized.headers.get('set-cookie')).toBeNull()
      }
      expect((await send(path.replace('quantity=2', 'quantity=0'), cookie)).status).toBe(400)
      expect(coordinator.mock.calls).toHaveLength(dispatchCount)
      expect(sqlite.prepare('SELECT total_changes() AS changes').get()).toEqual(before)
      expect(sqlite.prepare('SELECT quantity FROM cart_lines').get()).toEqual({ quantity: 2 })
      expect(sqlite.prepare('SELECT count(*) AS count FROM carts').get()).toEqual({ count: 1 })
    } finally {
      sqlite.close()
    }
  })
})

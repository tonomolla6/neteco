import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { Miniflare, convertV4MiniflareOptions, NoOpLog } from 'miniflare'
import { splitDemoSql } from '../../scripts/lib/d1-demo-sql'
import { deterministicTestData } from '../fixtures/deterministic'
import { seedInventoryFixture } from '../support/d1-sqlite'
import { provisionPublicationValidityFixture } from '../support/publication-validity-fixture'
import { createCart, setCartLine } from '../../workers/catalog/cart'
import { handleStorefrontCartHttp } from '../../workers/catalog/storefront-cart'

describe('cart ADD recovery on actual workerd D1', () => {
  it('recovers the exact committed ADD after withdrawal without touching expired state or dispatching', async () => {
    const runtime = new Miniflare(
      convertV4MiniflareOptions({
        name: 'cart-add-recovery-native',
        modules: true,
        script: 'export default {fetch(){return new Response("isolated")}}',
        compatibilityDate: '2026-08-15',
        compatibilityFlags: ['nodejs_compat'],
        cf: false,
        telemetry: { enabled: false },
        log: new NoOpLog(),
        d1Databases: { DB: '00000000-0000-4000-8000-000000000044' },
        outboundService: () => {
          throw new Error('unexpected_outbound')
        }
      })
    )
    try {
      const database = (await runtime.getD1Database('DB')) as unknown as D1Database
      for (const name of (await readdir('db/d1/migrations')).filter((name) => /^\d+.*\.sql$/.test(name)).sort()) {
        const sql = splitDemoSql(await readFile(join('db/d1/migrations', name), 'utf8'))
        for (let index = 0; index < sql.length; index += 50)
          await database.batch(sql.slice(index, index + 50).map((statement) => database.prepare(statement)))
      }
      const seeds: D1PreparedStatement[] = []
      seedInventoryFixture({
        exec(sql: string) {
          for (const statement of splitDemoSql(sql)) seeds.push(database.prepare(statement))
        },
        prepare(sql: string) {
          return {
            run(...parameters: unknown[]) {
              seeds.push(database.prepare(sql).bind(...parameters))
            }
          }
        }
      } as unknown as DatabaseSync)
      await database.batch(seeds)
      const data = deterministicTestData('cart-add-recovery-native', '2030-01-02T12:00:00.000Z'),
        now = data.date().toISOString().replace('.000Z', 'Z')
      await provisionPublicationValidityFixture(database, {
        productIds: ['p-1'],
        now: '2020-01-01T00:00:00Z',
        validUntil: '2099-01-01T00:00:00Z'
      })
      const cart = await createCart(database, { now, correlationId: 'native' }),
        commandId = data.uuid()
      await setCartLine(database, {
        ...cart,
        variantId: 'v-1-1',
        quantity: 2,
        expectedVersion: 1,
        idempotencyKey: commandId,
        mode: 'add',
        now,
        correlationId: 'native'
      })
      await database.prepare("UPDATE variants SET status='draft' WHERE id='v-1-1'").run()
      await database
        .prepare("UPDATE carts SET status='expired',expired_at=expires_at WHERE id=?")
        .bind(cart.cartId)
        .run()
      const replacement = await createCart(database, { now, correlationId: 'native-replacement' })
      const before = await database.prepare('SELECT * FROM carts').all(),
        lines = await database.prepare('SELECT * FROM cart_lines').all(),
        commands = await database.prepare('SELECT * FROM cart_commands').all()
      const cookie = `neteco-cart-v2=v1.${cart.cartId}.${cart.token}`
      const deps = {
        database,
        now: () => now,
        rateLimitPepper: 'native-edge-pepper-01234567890123456789',
        edgeLimiter: { limit: async () => ({ success: true }) } as unknown as RateLimit,
        dispatch: async () => {
          throw new Error('GET must never dispatch')
        }
      }
      const mismatch = await handleStorefrontCartHttp(
        new Request('https://shop.neteco.test/api/cart/items', {
          method: 'POST',
          headers: {
            cookie: `neteco-cart-v2=v1.${replacement.cartId}.${replacement.token}`,
            origin: 'https://shop.neteco.test',
            'content-type': 'application/json',
            'X-Neteco-Cart-Id': cart.cartId
          },
          body: JSON.stringify({ variantId: 11, quantity: 2, expectedVersion: 1, idempotencyKey: commandId })
        }),
        { ...deps, now: () => '2031-01-02T12:00:00Z' }
      )
      expect(mismatch?.status).toBe(409)
      expect(await mismatch!.json()).toEqual({ error: { code: 'conflict' } })
      expect(mismatch!.headers.get('set-cookie')).toBeNull()
      const request = (key: string, quantity = 2, credentials = cookie) =>
        new Request(
          `https://shop.neteco.test/api/cart/operations/${key}?variantId=11&quantity=${quantity}&expectedVersion=1`,
          { headers: { cookie: credentials, 'cf-connecting-ip': '192.0.2.21' } }
        )
      const confirmed = await handleStorefrontCartHttp(request(commandId), deps)
      expect(confirmed?.status).toBe(200)
      expect(await confirmed!.json()).toEqual({
        source: 'cloudflare',
        cartId: cart.cartId,
        commandId,
        outcome: 'applied',
        appliedVersion: 2
      })
      expect(confirmed!.headers.get('set-cookie')).toBeNull()
      expect((await handleStorefrontCartHttp(request(commandId, 3), deps))?.status).toBe(409)
      const unknown = await handleStorefrontCartHttp(request(data.uuid()), deps)
      expect(await unknown!.json()).toMatchObject({ outcome: 'unknown', appliedVersion: null })
      expect((await handleStorefrontCartHttp(request(commandId, 2, ''), deps))?.status).toBe(401)
      expect((await database.prepare('SELECT * FROM carts').all()).results).toEqual(before.results)
      expect((await database.prepare('SELECT * FROM cart_lines').all()).results).toEqual(lines.results)
      expect((await database.prepare('SELECT * FROM cart_commands').all()).results).toEqual(commands.results)
      await database.prepare("UPDATE cart_commands SET response_body='{}'").run()
      const corrupt = await handleStorefrontCartHttp(request(commandId), deps)
      expect(corrupt?.status).toBe(500)
      expect(await corrupt!.json()).toEqual({ error: { code: 'internal' } })
    } finally {
      await runtime.dispose()
    }
  }, 60000)
})

import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { Miniflare, convertV4MiniflareOptions, NoOpLog } from 'miniflare'
import { splitDemoSql } from '../../scripts/lib/d1-demo-sql'
import { deterministicTestData } from '../fixtures/deterministic'
import { seedInventoryFixture } from '../support/d1-sqlite'
import { provisionPublicationValidityFixture } from '../support/publication-validity-fixture'
import { createCart, setCartLine, quoteCart } from '../../workers/catalog/cart'
import { requestShippingOptions, placeOrder } from '../../workers/catalog/checkout'
import { readD1AdminGlobalSearch } from '../../workers/auth/admin-global-search'

describe('global admin search on actual workerd D1', () => {
  it('queries draft/SKU and real placed orders with native limits, permission separation and read-only results', async () => {
    const runtime = new Miniflare(
      convertV4MiniflareOptions({
        name: 'admin-global-search-native',
        modules: true,
        script: 'export default {fetch(){return new Response("isolated")}}',
        compatibilityDate: '2026-08-15',
        compatibilityFlags: ['nodejs_compat'],
        cf: false,
        telemetry: { enabled: false },
        log: new NoOpLog(),
        d1Databases: { DB: '00000000-0000-4000-8000-000000000046' },
        outboundService: () => {
          throw new Error('unexpected_outbound')
        }
      })
    )
    try {
      const database = (await runtime.getD1Database('DB')) as unknown as D1Database
      for (const name of (await readdir('db/d1/migrations')).filter((name) => /^\d+.*\.sql$/.test(name)).sort()) {
        const statements = splitDemoSql(await readFile(join('db/d1/migrations', name), 'utf8'))
        for (let index = 0; index < statements.length; index += 50)
          await database.batch(statements.slice(index, index + 50).map((sql) => database.prepare(sql)))
      }
      const seeds: D1PreparedStatement[] = []
      seedInventoryFixture({
        exec(sql: string) {
          for (const text of splitDemoSql(sql)) seeds.push(database.prepare(text))
        },
        prepare(sql: string) {
          return {
            run(...args: unknown[]) {
              seeds.push(database.prepare(sql).bind(...args))
            }
          }
        }
      } as unknown as DatabaseSync)
      await database.batch(seeds)
      const data = deterministicTestData('admin-global-native', '2030-01-02T12:00:00Z'),
        identity = data.uuid(),
        session = data.uuid(),
        claims = { identityId: identity, sessionId: session, sessionVersion: 1 },
        now = () => '2030-01-02T12:00:00Z'
      await database.batch([
        database
          .prepare(
            "INSERT INTO identities(id,email,password_hash,email_verified_at,status,created_at,updated_at) VALUES (?,'private@example.invalid','synthetic','2020-01-01T00:00:00Z','active','2020-01-01T00:00:00Z','2020-01-01T00:00:00Z')"
          )
          .bind(identity),
        database
          .prepare(
            "INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at) VALUES (?,?,1,1,'2020-01-01T00:00:00Z','2099-01-01T00:00:00Z')"
          )
          .bind(session, identity),
        database.prepare("INSERT INTO roles VALUES('global-search','Synthetic','Synthetic')"),
        database
          .prepare(
            "INSERT INTO identity_roles(identity_id,role_code,granted_at) VALUES (?,'global-search','2020-01-01T00:00:00Z')"
          )
          .bind(identity),
        database.prepare(
          "INSERT INTO permissions VALUES('catalog.write','catalog','write','Synthetic'),('administration.manage','administration','manage','Synthetic')"
        ),
        database.prepare(
          "INSERT INTO role_permissions VALUES('global-search','catalog.write'),('global-search','administration.manage')"
        ),
        database.prepare(
          "INSERT INTO shipping_zones(id,code,name,kind,postal_prefixes,active,created_at) VALUES ('global-pickup','global-pickup','Synthetic','warehouse_pickup','[]',1,'2020-01-01T00:00:00Z')"
        ),
        database.prepare(
          "INSERT INTO shipping_rates(id,zone_id,method_code,service_profile,net_cents,tax_rate_basis_points,eta_min_days,eta_max_days,rate_version,active,created_at) VALUES ('global-rate','global-pickup','pickup','parcel',0,2100,0,0,1,1,'2020-01-01T00:00:00Z')"
        )
      ])
      await provisionPublicationValidityFixture(database, {
        productIds: ['p-1'],
        now: '2020-01-01T00:00:00Z',
        validUntil: '2099-01-01T00:00:00Z'
      })
      const cart = await createCart(database, { correlationId: 'global-native', now: now() })
      await setCartLine(database, {
        cartId: cart.cartId,
        token: cart.token,
        variantId: 'v-1-1',
        quantity: 1,
        expectedVersion: 1,
        idempotencyKey: 'global-add',
        correlationId: 'global-native',
        now: now()
      })
      const shipping = await requestShippingOptions(database, {
        cartId: cart.cartId,
        token: cart.token,
        expectedVersion: 2,
        idempotencyKey: 'global-ship',
        correlationId: 'global-native',
        now: now(),
        destination: { city: 'Ontinyent', postalCode: '46870' }
      })
      if (shipping.outcome !== 'options') throw new Error(shipping.outcome)
      const quote = await quoteCart(database, {
        cartId: cart.cartId,
        token: cart.token,
        expectedVersion: 2,
        idempotencyKey: 'global-quote',
        correlationId: 'global-native',
        now: now()
      })
      if (quote.outcome !== 'quoted') throw new Error(quote.outcome)
      const option = (shipping.body.options as Array<{ optionIndex: number; optionHash: string }>)[0]!
      const placed = await placeOrder(database, {
        cartId: cart.cartId,
        token: cart.token,
        expectedVersion: 2,
        quoteId: quote.quote.quoteId,
        shippingQuoteId: String(shipping.body.shippingQuoteId),
        selectedOptionIndex: option.optionIndex,
        selectedOptionHash: option.optionHash,
        contactEmail: 'private-order@example.invalid',
        shippingAddress: {
          recipientName: 'Private Person',
          line1: 'Private Street 1',
          city: 'Ontinyent',
          province: 'València',
          postalCode: '46870',
          phone: '+34600000000',
          countryCode: 'ES'
        },
        consentTos: true,
        consentPrivacy: true,
        idempotencyKey: 'global-order',
        correlationId: 'global-native',
        now: now()
      })
      if (placed.outcome !== 'order_created') throw new Error(placed.outcome)
      const orderId = String(placed.body.id),
        literal = 'ÁCIDO-' + 'a'.repeat(60) + '-%_\\'
      await database.batch([
        database.prepare("UPDATE products SET name=?,status='draft' WHERE id='p-1'").bind(literal),
        database.prepare("UPDATE variants SET sku=? WHERE id='v-1-1'").bind(literal)
      ])
      const tables = [
          'products',
          'variants',
          'orders',
          'order_lines',
          'carts',
          'cart_lines',
          'cart_commands',
          'auth_sessions',
          'identity_roles'
        ],
        snapshot = async () =>
          Promise.all(
            tables.map(async (table) => (await database.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()).results)
          )
      const before = await snapshot()
      const original = database.prepare.bind(database)
      const readOnly = new Proxy(database, {
        get(target, property) {
          if (property === 'prepare')
            return (sql: string) => {
              expect(sql.trim()).toMatch(/^(SELECT|WITH)\b/)
              return {
                bind(...args: unknown[]) {
                  const bound = original(sql).bind(...args)
                  const all = async () => {
                    const result = await bound.all()
                    expect(result.meta.rows_written).toBe(0)
                    return result
                  }
                  return { all, first: async () => (await all()).results[0] ?? null }
                }
              }
            }
          throw new Error('Only read statements allowed')
        }
      }) as D1Database
      const products = await readD1AdminGlobalSearch(readOnly, claims, { query: literal, now })
      expect(products.items.map((item) => item.id)).toEqual(['1'])
      expect(
        (await readD1AdminGlobalSearch(readOnly, claims, { query: 'acido', now })).items.map((item) => item.id)
      ).toEqual(['1'])
      expect(
        (await readD1AdminGlobalSearch(readOnly, claims, { query: '%_\\', now })).items.map((item) => item.id)
      ).toEqual(['1'])
      const orders = await readD1AdminGlobalSearch(readOnly, claims, { query: orderId, now })
      expect(orders.items).toEqual([
        {
          kind: 'order',
          id: orderId,
          label: `Pedido ${orderId}`,
          description: 'Pedido',
          to: `/admin/pedidos/${orderId}`
        }
      ])
      expect(JSON.stringify(orders)).not.toMatch(/private|email|total|address|token_hash/)
      expect(await snapshot()).toEqual(before)
      await database.prepare("DELETE FROM role_permissions WHERE permission_code='administration.manage'").run()
      expect((await readD1AdminGlobalSearch(database, claims, { query: orderId, now })).items).toEqual([])
      await database.prepare('UPDATE auth_sessions SET revoked_at=? WHERE id=?').bind(now(), session).run()
      await expect(readD1AdminGlobalSearch(database, claims, { query: 'acido', now })).rejects.toMatchObject({
        code: 'unauthenticated'
      })
    } finally {
      await runtime.dispose()
    }
  }, 60000)
})

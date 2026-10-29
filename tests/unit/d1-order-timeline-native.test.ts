import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { Miniflare, convertV4MiniflareOptions, NoOpLog } from 'miniflare'
import { splitDemoSql } from '../../scripts/lib/d1-demo-sql'
import { seedInventoryFixture } from '../support/d1-sqlite'
import { deterministicTestData } from '../fixtures/deterministic'
import { provisionPublicationValidityFixture } from '../support/publication-validity-fixture'
import { createCart, setCartLine, quoteCart } from '../../workers/catalog/cart'
import { requestShippingOptions, placeOrder } from '../../workers/catalog/checkout'
import { readD1OrderTimeline } from '../../workers/catalog/order-timeline'

describe('order timeline actual workerd D1 query', () => {
  it('queries all governed source tables under native limits, returns actual checkout only and rechecks ownership read-only', async () => {
    const runtime = new Miniflare(
      convertV4MiniflareOptions({
        name: 'order-timeline-native',
        modules: true,
        script: 'export default {fetch(){return new Response("isolated")}}',
        compatibilityDate: '2026-08-15',
        compatibilityFlags: ['nodejs_compat'],
        cf: false,
        telemetry: { enabled: false },
        log: new NoOpLog(),
        d1Databases: { DB: '00000000-0000-4000-8000-000000000047' },
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
      const data = deterministicTestData('order-timeline-native', '2026-10-08T12:00:00Z'),
        identity = data.uuid(),
        customer = data.uuid(),
        session = data.uuid(),
        claims = { identityId: identity, sessionId: session, sessionVersion: 1 }
      const clock = await database
        .prepare("SELECT strftime('%Y-%m-%dT%H:%M:%SZ','now') AS now")
        .first<{ now: string }>()
      if (!clock) throw new Error('missing_native_clock')
      const instant = clock.now,
        now = () => instant
      await database.batch([
        database
          .prepare(
            "INSERT INTO customers(id,created_at,updated_at) VALUES (?,'2020-01-01T00:00:00Z','2020-01-01T00:00:00Z')"
          )
          .bind(customer),
        database
          .prepare(
            "INSERT INTO identities(id,email,password_hash,email_verified_at,status,customer_id,created_at,updated_at) VALUES (?,'native-private@example.invalid','synthetic','2020-01-01T00:00:00Z','active',?,'2020-01-01T00:00:00Z','2020-01-01T00:00:00Z')"
          )
          .bind(identity, customer),
        database
          .prepare(
            "INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at) VALUES (?,?,1,1,'2020-01-01T00:00:00Z','2099-01-01T00:00:00Z')"
          )
          .bind(session, identity),
        database.prepare("INSERT INTO roles VALUES('timeline-native','Synthetic','Synthetic')"),
        database.prepare(
          "INSERT INTO permissions VALUES('administration.manage','administration','manage','Synthetic')"
        ),
        database.prepare("INSERT INTO role_permissions VALUES('timeline-native','administration.manage')"),
        database
          .prepare(
            "INSERT INTO identity_roles(identity_id,role_code,granted_at) VALUES (?,'timeline-native','2020-01-01T00:00:00Z')"
          )
          .bind(identity),
        database.prepare(
          "INSERT INTO shipping_zones(id,code,name,kind,postal_prefixes,active,created_at) VALUES('timeline-pickup','timeline-pickup','Synthetic','warehouse_pickup','[]',1,'2020-01-01T00:00:00Z')"
        ),
        database.prepare(
          "INSERT INTO shipping_rates(id,zone_id,method_code,service_profile,net_cents,tax_rate_basis_points,eta_min_days,eta_max_days,rate_version,active,created_at) VALUES('timeline-rate','timeline-pickup','pickup','parcel',0,2100,0,0,1,1,'2020-01-01T00:00:00Z')"
        )
      ])
      await provisionPublicationValidityFixture(database, {
        productIds: ['p-1'],
        now: '2020-01-01T00:00:00Z',
        validUntil: '2099-01-01T00:00:00Z'
      })
      const cart = await createCart(database, { correlationId: 'timeline-native', now: instant })
      await setCartLine(database, {
        cartId: cart.cartId,
        token: cart.token,
        variantId: 'v-1-1',
        quantity: 1,
        expectedVersion: 1,
        idempotencyKey: 'timeline-add',
        correlationId: 'timeline-native',
        now: instant
      })
      const shipping = await requestShippingOptions(database, {
        cartId: cart.cartId,
        token: cart.token,
        expectedVersion: 2,
        idempotencyKey: 'timeline-shipping',
        correlationId: 'timeline-native',
        now: instant,
        destination: { city: 'Ontinyent', postalCode: '46870' }
      })
      if (shipping.outcome !== 'options') throw new Error(shipping.outcome)
      const quote = await quoteCart(database, {
        cartId: cart.cartId,
        token: cart.token,
        expectedVersion: 2,
        idempotencyKey: 'timeline-quote',
        correlationId: 'timeline-native',
        now: instant
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
        contactEmail: 'native-private@example.invalid',
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
        idempotencyKey: 'timeline-checkout',
        correlationId: 'timeline-native',
        now: instant,
        ownerSession: claims
      })
      if (placed.outcome !== 'order_created') throw new Error(placed.outcome)
      const orderId = String(placed.body.id),
        tables = [
          'orders',
          'order_lines',
          'order_events',
          'checkout_commands',
          'auth_sessions',
          'customers',
          'identities'
        ],
        snapshot = async () =>
          Promise.all(
            tables.map(async (table) => (await database.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()).results)
          ),
        before = await snapshot()
      const readOnly = new Proxy(database, {
        get(target, key) {
          if (key === 'prepare')
            return (sql: string) => {
              expect(sql.trim()).toMatch(/^(SELECT|WITH)\b/)
              return {
                bind(...args: unknown[]) {
                  const bound = target.prepare(sql).bind(...args),
                    all = async () => {
                      const result = await bound.all()
                      expect(result.meta.rows_written).toBe(0)
                      return result
                    }
                  return { all, first: async () => (await all()).results[0] ?? null }
                }
              }
            }
          throw new Error('Only SELECT allowed')
        }
      }) as D1Database
      const customerTimeline = await readD1OrderTimeline(readOnly, claims, orderId, {
          audience: 'customer',
          appEnvironment: 'local',
          limit: 1,
          now
        }),
        adminTimeline = await readD1OrderTimeline(readOnly, claims, orderId, {
          audience: 'admin',
          appEnvironment: 'local',
          now
        })
      expect(customerTimeline.items).toEqual(adminTimeline.items)
      expect(customerTimeline.items).toEqual([
        {
          id: expect.stringMatching(/^checkout:/),
          kind: 'checkout',
          state: 'created',
          createdAt: instant,
          validationOnly: null
        }
      ])
      expect(customerTimeline.nextCursor).toBeNull()
      expect(JSON.stringify(customerTimeline)).not.toMatch(/private|email|actor|payload|hash|amount/)
      expect(await snapshot()).toEqual(before)
      await database.prepare('UPDATE auth_sessions SET revoked_at=? WHERE id=?').bind(instant, session).run()
      await expect(
        readD1OrderTimeline(database, claims, orderId, { audience: 'customer', appEnvironment: 'local', now })
      ).rejects.toMatchObject({ code: 'unauthenticated' })
    } finally {
      await runtime.dispose()
    }
  }, 60000)
})

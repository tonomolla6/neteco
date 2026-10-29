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
import { exportD1AdminOrders } from '../../workers/catalog/order-export'
import { readD1AdminOrder } from '../../workers/catalog/admin-orders'
import { verifyOrderExportCsv } from '../../shared/order-export'

describe('order export actual workerd D1', () => {
  it('exports one coherent real checkout snapshot under native SQL limits without writes', async () => {
    const runtime = new Miniflare(
      convertV4MiniflareOptions({
        name: 'order-export-native',
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
      const data = deterministicTestData('order-export-native', '2026-10-08T12:00:00Z'),
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
        buyerCompanyName: 'Empresa de prueba SL',
        buyerTaxId: 'B12345674',
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
        contactName: 'Ácido Ñandú',
        ownerSession: claims
      })
      if (placed.outcome !== 'order_created') throw new Error(placed.outcome)
      const orderId = String(placed.body.id)
      const rows = await database.prepare('SELECT * FROM orders WHERE id=?').bind(orderId).all()
      const readOnly = new Proxy(database, {
        get(target, key) {
          if (key === 'prepare')
            return (sql: string) => {
              expect(sql.trim()).toMatch(/^(SELECT|WITH)\b/)
              return {
                bind(...args: unknown[]) {
                  const bound = target.prepare(sql).bind(...args)
                  const all = async () => {
                    const result = await bound.all()
                    expect(result.meta.rows_written).toBe(0)
                    return result
                  }
                  return { all, first: async () => (await all()).results[0] ?? null }
                }
              }
            }
          const value = Reflect.get(target, key)
          return typeof value === 'function' ? value.bind(target) : value
        }
      }) as D1Database
      const result = await exportD1AdminOrders(
        readOnly,
        claims,
        new URLSearchParams('q=ACIDO&sortKey=name&sortDir=asc'),
        { now }
      )
      expect(result.metadata.rows).toBe(1)
      verifyOrderExportCsv(new TextEncoder().encode(result.csv), result.metadata)
      expect(result.csv).toContain(orderId)
      expect(result.csv).toContain('Ácido Ñandú')
      const byTaxId = await exportD1AdminOrders(readOnly, claims, new URLSearchParams('q=b12345674'), { now })
      expect(byTaxId.metadata.rows).toBe(1)
      expect(byTaxId.csv).toContain(orderId)
      expect(byTaxId.csv).not.toContain('B12345674')
      verifyOrderExportCsv(new TextEncoder().encode(byTaxId.csv), byTaxId.metadata)
      // Exercise the actual administrative detail SQL independently of the SPA
      // harness, so a browser mount failure is not confused with native D1.
      const detail = await readD1AdminOrder(database, claims, instant, orderId)
      expect(detail.outcome).toBe('found')
      if (detail.outcome !== 'found') throw new Error('native_detail_not_found')
      expect(detail.data.order.id).toBe(orderId)
      expect(detail.data.capabilities.orderHistory).toBe(true)
      const empty = await exportD1AdminOrders(readOnly, claims, new URLSearchParams({ q: 'literal%_'.repeat(12) }), {
        now
      })
      expect(empty.metadata.rows).toBe(0)
      verifyOrderExportCsv(new TextEncoder().encode(empty.csv), empty.metadata)
      expect((await database.prepare('SELECT * FROM orders WHERE id=?').bind(orderId).all()).results).toEqual(
        rows.results
      )
    } finally {
      await runtime.dispose()
    }
  }, 60000)
})

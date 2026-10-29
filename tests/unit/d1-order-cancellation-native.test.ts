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
import {
  cancelD1UnpaidOrder,
  readD1OrderCancellation,
  readD1OrderCancellationCommand
} from '../../workers/catalog/order-cancellation'
import { initiateRedsysPayment } from '../../workers/catalog/payments'
import { readD1OrderTimeline } from '../../workers/catalog/order-timeline'
import { REDSYS_OFFICIAL_CONTRACT } from '../fixtures/redsys-official'

describe('unpaid cancellation actual workerd D1', () => {
  it('cancels a real native checkout atomically, recovers read-only and rejects an initiation racing cancellation', async () => {
    const runtime = new Miniflare(
      convertV4MiniflareOptions({
        name: 'order-cancellation-native',
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
      const data = deterministicTestData('order-cancellation-native', '2026-10-08T12:00:00Z'),
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
      const orderId = String(placed.body.id)
      const options = { audience: 'customer' as const, now }
      const commandId = data.uuid()
      const input = {
        expectedStatus: 'awaiting_payment' as const,
        reason: 'Synthetic explicit customer cancellation request.'
      }
      const lines = (await database.prepare('SELECT * FROM order_lines WHERE order_id=?').bind(orderId).all()).results
      expect(await readD1OrderCancellation(database, claims, orderId, options)).toMatchObject({
        eligible: true,
        blocker: null
      })
      const receipt = await cancelD1UnpaidOrder(database, claims, orderId, commandId, input, options)
      expect(receipt).toMatchObject({ outcome: 'cancelled', inventoryEffect: 'released' })
      expect(await cancelD1UnpaidOrder(database, claims, orderId, commandId, input, options)).toEqual(receipt)
      const snapshot = async () =>
        Promise.all(
          [
            'orders',
            'inventory_reservations',
            'inventory_movements',
            'payment_commands',
            'order_events',
            'auth_sessions'
          ].map(async (table) => (await database.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()).results)
        )
      const beforeRead = await snapshot()
      const readOnly = new Proxy(database, {
        get(target, key) {
          if (key === 'prepare')
            return (sql: string) => {
              expect(sql.trim()).toMatch(/^(SELECT|WITH)\b/)
              return {
                bind(...args: unknown[]) {
                  const bound = target.prepare(sql).bind(...args)
                  return {
                    async all() {
                      const result = await bound.all()
                      expect(result.meta.rows_written).toBe(0)
                      return result
                    },
                    async first() {
                      const result = await bound.all()
                      expect(result.meta.rows_written).toBe(0)
                      return result.results[0] ?? null
                    }
                  }
                }
              }
            }
          const value = Reflect.get(target, key)
          return typeof value === 'function' ? value.bind(target) : value
        }
      }) as D1Database
      expect(await readD1OrderCancellationCommand(readOnly, claims, orderId, commandId, options)).toEqual(receipt)
      const history = await readD1OrderTimeline(readOnly, claims, orderId, {
        ...options,
        appEnvironment: 'local'
      })
      expect(history.items.map((item) => item.state)).toEqual(['cancelled', 'created'])
      expect(await snapshot()).toEqual(beforeRead)
      expect(
        (await database.prepare('SELECT * FROM order_lines WHERE order_id=?').bind(orderId).all()).results
      ).toEqual(lines)
      expect(
        (
          await database
            .prepare("SELECT physical_delta,reserved_delta FROM inventory_movements WHERE movement_type='release'")
            .all()
        ).results
      ).toEqual([{ physical_delta: 0, reserved_delta: -1 }])
      expect(await database.prepare('SELECT count(*) n FROM payment_intents').first()).toEqual({ n: 0 })
      // A new checkout lets the actual payment function reach its contested
      // batch; cancellation is committed immediately before that native batch.
      const secondCart = await createCart(database, { correlationId: 'cancellation-native-race', now: instant })
      await setCartLine(database, {
        cartId: secondCart.cartId,
        token: secondCart.token,
        variantId: 'v-1-1',
        quantity: 1,
        expectedVersion: 1,
        idempotencyKey: 'race-add',
        correlationId: 'race',
        now: instant
      })
      const common = {
        cartId: secondCart.cartId,
        token: secondCart.token,
        expectedVersion: 2,
        correlationId: 'race',
        now: instant
      }
      const shipping2 = await requestShippingOptions(database, {
        ...common,
        idempotencyKey: 'race-shipping',
        destination: { city: 'Ontinyent', postalCode: '46870' }
      })
      const quote2 = await quoteCart(database, { ...common, idempotencyKey: 'race-quote' })
      if (shipping2.outcome !== 'options' || quote2.outcome !== 'quoted') throw new Error('race fixture')
      const option2 = (shipping2.body.options as Array<{ optionIndex: number; optionHash: string }>)[0]!
      const second = await placeOrder(database, {
        ...common,
        idempotencyKey: 'race-checkout',
        quoteId: quote2.quote.quoteId,
        shippingQuoteId: String(shipping2.body.shippingQuoteId),
        selectedOptionIndex: option2.optionIndex,
        selectedOptionHash: option2.optionHash,
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
        ownerSession: claims
      })
      if (second.outcome !== 'order_created') throw new Error(second.outcome)
      const raceOrderId = String(second.body.id)
      const raced = new Proxy(database, {
        get(target, key) {
          if (key === 'batch')
            return async (statements: Parameters<D1Database['batch']>[0]) => {
              await cancelD1UnpaidOrder(database, claims, raceOrderId, data.uuid(), input, options)
              return target.batch(statements)
            }
          const value = Reflect.get(target, key)
          return typeof value === 'function' ? value.bind(target) : value
        }
      }) as D1Database
      await expect(
        initiateRedsysPayment(
          raced,
          {
            orderId: raceOrderId,
            orderToken: String(second.body.orderToken),
            method: 'card',
            idempotencyKey: 'race-payment',
            correlationId: 'race',
            now: instant,
            randomUUID: () => data.uuid()
          },
          {
            environment: 'sandbox',
            merchantCode: REDSYS_OFFICIAL_CONTRACT.sandbox.merchantCode,
            terminal: '1',
            secretKey: REDSYS_OFFICIAL_CONTRACT.sandbox.secretKey,
            merchantName: 'NETECO',
            publicBaseUrl: 'https://cancellation.neteco.test'
          }
        )
      ).rejects.toMatchObject({ code: 'not_payable' })
      expect(await database.prepare('SELECT count(*) n FROM payment_intents').first()).toEqual({ n: 0 })
      expect(await database.prepare('SELECT status FROM orders WHERE id=?').bind(raceOrderId).first()).toEqual({
        status: 'cancelled'
      })
    } finally {
      await runtime.dispose()
    }
  }, 60000)
})

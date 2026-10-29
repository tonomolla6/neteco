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
import { assignReservation } from '../../workers/catalog/inventory'
import { executeD1AdminFulfillmentCommand } from '../../workers/fulfillment/admin'
import { listD1CustomerOrders, readD1CustomerOrderLines } from '../../workers/catalog/customer-orders'
import { handleStorefrontCheckoutHttp } from '../../workers/catalog/storefront-checkout'

describe('customer preparation projection on actual workerd D1', () => {
  it('reads real confirmed states in list and detail, with ownership, snapshot prices and corrupt-history fallback', async () => {
    const runtime = new Miniflare(
      convertV4MiniflareOptions({
        name: 'customer-order-preparation-native',
        script: 'export default {fetch(){return new Response("isolated")}}',
        modules: true,
        compatibilityDate: '2026-08-15',
        compatibilityFlags: ['nodejs_compat'],
        cf: false,
        telemetry: { enabled: false },
        log: new NoOpLog(),
        d1Databases: { DB: '00000000-0000-4000-8000-000000000043' },
        outboundService: () => {
          throw new Error('unexpected_outbound')
        }
      })
    )
    try {
      const raw = await runtime.getD1Database('DB'),
        database = raw as unknown as D1Database
      for (const name of (await readdir('db/d1/migrations')).filter((name) => /^\d+.*\.sql$/.test(name)).sort()) {
        const sql = splitDemoSql(await readFile(join('db/d1/migrations', name), 'utf8'))
        for (let index = 0; index < sql.length; index += 50)
          await raw.batch(sql.slice(index, index + 50).map((statement) => raw.prepare(statement)))
      }
      // Reuse the established fixture's INSERTs only. All reads and commands
      // below execute the actual production services against actual D1.
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
      const data = deterministicTestData('customer-preparation-native', '2030-01-02T12:00:00.000Z')
      // Commands share the actual D1 execution clock; deterministic IDs remain
      // fixed, but future synthetic events must not masquerade as live states.
      const clock = await database
        .prepare("SELECT strftime('%Y-%m-%dT%H:%M:%SZ','now') AS now")
        .first<{ now: string }>()
      if (!clock?.now) throw new Error('missing_native_clock')
      const now = clock.now
      await provisionPublicationValidityFixture(database, {
        productIds: ['p-1'],
        now: '2020-01-01T00:00:00Z',
        validUntil: '2099-01-01T00:00:00Z'
      })
      const customer = data.uuid(),
        identity = data.uuid(),
        session = data.uuid(),
        claims = { identityId: identity, sessionId: session, sessionVersion: 1 }
      await database.batch([
        database
          .prepare(
            "INSERT INTO customers(id,created_at,updated_at) VALUES (?,'2020-01-01T00:00:00Z','2020-01-01T00:00:00Z')"
          )
          .bind(customer),
        database
          .prepare(
            "INSERT INTO identities(id,email,password_hash,email_verified_at,status,customer_id,created_at,updated_at) VALUES (?,'native-customer@example.invalid','synthetic','2020-01-01T00:00:00Z','active',?,'2020-01-01T00:00:00Z','2020-01-01T00:00:00Z')"
          )
          .bind(identity, customer),
        database
          .prepare(
            "INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at) VALUES (?,?,1,1,'2020-01-01T00:00:00Z','2099-01-01T00:00:00Z')"
          )
          .bind(session, identity),
        database.prepare("INSERT INTO roles VALUES ('native_operator','Synthetic','Synthetic')"),
        database.prepare(
          "INSERT OR IGNORE INTO permissions VALUES ('administration.manage','administration','manage','Synthetic')"
        ),
        database.prepare("INSERT INTO role_permissions VALUES ('native_operator','administration.manage')"),
        database
          .prepare(
            "INSERT INTO identity_roles(identity_id,role_code,granted_at) VALUES (?,'native_operator','2020-01-01T00:00:00Z')"
          )
          .bind(identity),
        database.prepare(
          "INSERT INTO shipping_zones(id,code,name,kind,postal_prefixes,active,created_at) VALUES ('native-pickup','native-pickup','Synthetic pickup','warehouse_pickup','[]',1,'2020-01-01T00:00:00Z')"
        ),
        database.prepare(
          "INSERT INTO shipping_rates(id,zone_id,method_code,service_profile,net_cents,tax_rate_basis_points,eta_min_days,eta_max_days,rate_version,active,created_at) VALUES ('native-pickup-rate','native-pickup','pickup','parcel',0,2100,0,0,1,1,'2020-01-01T00:00:00Z')"
        )
      ])
      const cart = await createCart(database, { correlationId: 'native-customer-preparation', now })
      await setCartLine(database, {
        cartId: cart.cartId,
        token: cart.token,
        variantId: 'v-1-1',
        quantity: 2,
        expectedVersion: 1,
        idempotencyKey: 'native-line',
        correlationId: 'native',
        now
      })
      const shipping = await requestShippingOptions(database, {
        cartId: cart.cartId,
        token: cart.token,
        expectedVersion: 2,
        idempotencyKey: 'native-shipping',
        correlationId: 'native',
        now,
        destination: { city: 'Ontinyent', postalCode: '46870' }
      })
      if (shipping.outcome !== 'options') throw new Error(shipping.outcome)
      const option = (shipping.body.options as Array<{ optionIndex: number; optionHash: string }>)[0]!
      const quote = await quoteCart(database, {
        cartId: cart.cartId,
        token: cart.token,
        expectedVersion: 2,
        idempotencyKey: 'native-quote',
        correlationId: 'native',
        now
      })
      if (quote.outcome !== 'quoted') throw new Error(quote.outcome)
      const placed = await placeOrder(database, {
        cartId: cart.cartId,
        token: cart.token,
        expectedVersion: 2,
        quoteId: quote.quote.quoteId,
        shippingQuoteId: String(shipping.body.shippingQuoteId),
        selectedOptionIndex: option.optionIndex,
        selectedOptionHash: option.optionHash,
        contactEmail: 'native-customer@example.invalid',
        shippingAddress: {
          recipientName: 'Synthetic customer',
          line1: 'Carrer Major 1',
          city: 'Ontinyent',
          province: 'València',
          postalCode: '46870',
          phone: '+34600000000',
          countryCode: 'ES'
        },
        consentTos: true,
        consentPrivacy: true,
        idempotencyKey: 'native-checkout',
        correlationId: 'native',
        now,
        ownerSession: claims
      })
      if (placed.outcome !== 'order_created') throw new Error(placed.outcome)
      const orderId = String(placed.body.id),
        order = await database
          .prepare('SELECT total_gross_cents total,reservation_id reservation FROM orders WHERE id=?')
          .bind(orderId)
          .first<{ total: number; reservation: string }>()
      if (!order) throw new Error('missing_native_order')
      await assignReservation(database, {
        idempotencyKey: order.reservation,
        correlationId: 'native',
        now,
        reason: 'Synthetic captured payment'
      })
      const payment = data.uuid()
      await database.batch([
        database
          .prepare(
            "INSERT INTO payment_intents(id,order_id,provider,merchant_order,method,status,amount_gross_cents,currency,request_hash,redirect_envelope_hash,response_code,expires_at,correlation_id,created_at,updated_at) VALUES (?,?,'redsys',?,'card','captured',?,'EUR',?,?,'0000','2099-01-01T00:00:00Z','native',?,?)"
          )
          .bind(
            payment,
            orderId,
            '1234' + data.token().slice(0, 8),
            order.total,
            'a'.repeat(64),
            'b'.repeat(64),
            now,
            now
          ),
        database
          .prepare(
            "INSERT INTO order_payment_states(order_id,status,active_intent_id,paid_gross_cents,updated_at) VALUES (?,'paid',?,?,?)"
          )
          .bind(orderId, payment, order.total, now),
        database.prepare('INSERT INTO payment_fulfilment_claims VALUES(?,?,?)').bind(orderId, payment, now),
        database
          .prepare(
            "INSERT INTO payment_recovery_jobs(payment_intent_id,order_id,status,attempts,due_at,created_at,updated_at) VALUES(?,?,'completed',1,?,?,?)"
          )
          .bind(payment, orderId, now, now, now),
        database
          .prepare(
            "INSERT INTO payment_events(id,payment_intent_id,order_id,provider_event_id,event_type,payload_hash,response_code,correlation_id,created_at) VALUES(?,?,?,?,'captured',?,'0000','native',?)"
          )
          .bind(data.uuid(), payment, orderId, data.uuid(), 'c'.repeat(64), now)
      ])
      const baseline = await readD1CustomerOrderLines(database, claims, orderId, now)
      const storefront = () =>
        handleStorefrontCheckoutHttp(
          new Request(`https://shop.neteco.test/api/orders/${orderId}`, {
            headers: { cookie: 'neteco-session=synthetic-native-owner', 'cf-connecting-ip': '192.0.2.43' }
          }),
          {
            database,
            dispatch: async () => {
              throw new Error('unexpected_write')
            },
            edgeLimiter: { limit: async () => ({ success: true }) } as unknown as RateLimit,
            rateLimitPepper: 'synthetic-native-storefront-pepper',
            authenticationEnabled: true,
            session: async () => claims,
            paymentConfiguration: () => null,
            now: () => now
          }
        )
      expect(await (await storefront())!.json()).toMatchObject({ id: orderId, fulfillmentStatus: 'untracked' })
      expect(baseline).toMatchObject({ outcome: 'found', detail: { fulfillmentStatus: null, shipment: null } })
      expect(baseline).toMatchObject({
        outcome: 'found',
        detail: {
          lines: [
            {
              unitGross: 500,
              lineGross: 1000,
              reorderOffer: {
                unitGross: 500,
                lineGross: 1000,
                unitNet: 413,
                lineNet: 826,
                taxRateBasisPoints: 2100,
                pricingVersion: 'legacy:v-1-1',
                availableQuantity: 22,
                purchasable: true
              }
            }
          ]
        }
      })
      for (const [version, state] of ['picking', 'packed', 'ready_for_pickup', 'delivered'].entries()) {
        await executeD1AdminFulfillmentCommand(
          database,
          claims,
          orderId,
          {
            action: state,
            expectedVersion: version,
            reason: 'Synthetic private warehouse reason',
            ...(state === 'delivered' ? { evidence: 'Synthetic private handover evidence' } : {})
          },
          { idempotencyKey: data.uuid(), now }
        )
        const detail = await readD1CustomerOrderLines(database, claims, orderId, now)
        const header = await storefront()
        expect(header?.status).toBe(200)
        expect(await header!.json()).toMatchObject({ id: orderId, fulfillmentStatus: state })
        expect(detail).toMatchObject({ outcome: 'found', detail: { fulfillmentStatus: state, shipment: null } })
        if (detail.outcome !== 'found' || baseline.outcome !== 'found') throw new Error('missing_native_detail')
        expect({
          ...detail.detail,
          fulfillmentStatus: null,
          lines: detail.detail.lines.map(({ reorderOffer: _offer, ...line }) => line)
        }).toEqual({
          ...baseline.detail,
          lines: baseline.detail.lines.map(({ reorderOffer: _offer, ...line }) => line)
        })
        expect(JSON.stringify(detail)).not.toMatch(/private warehouse|private handover|warehouseId|actorId|commandId/)
        expect((await listD1CustomerOrders(database, claims, now))?.orders[0]?.status).toBe(
          (
            {
              picking: 'preparando',
              packed: 'preparando',
              ready_for_pickup: 'listo_recogida',
              delivered: 'entregado'
            } as Record<string, string>
          )[state]
        )
      }
      await database
        .prepare(
          `INSERT INTO variant_price_versions(id,variant_id,gross_cents,volume_tiers,valid_from,status,reason,created_at)
        VALUES ('native-reorder-price','v-1-1',777,'[{"minimumQuantity":2,"unitGrossCents":654}]','2020-01-01T00:00:00Z','approved','Synthetic native reorder offer','2020-01-01T00:00:00Z')`
        )
        .run()
      expect(await readD1CustomerOrderLines(database, claims, orderId, now)).toMatchObject({
        outcome: 'found',
        detail: {
          lines: [
            {
              quantity: 2,
              unitGross: 500,
              lineGross: 1000,
              reorderOffer: {
                unitGross: 654,
                lineGross: 1308,
                unitNet: 540,
                lineNet: 1081,
                pricingVersion: 'native-reorder-price',
                purchasable: true
              }
            }
          ]
        }
      })
      await database.prepare('DROP TRIGGER order_fulfillment_audit_no_update').run()
      await database.prepare("UPDATE order_fulfillment_audit SET reason='Tampered synthetic private history'").run()
      expect((await listD1CustomerOrders(database, claims, now))?.orders[0]?.status).toBe('pagado')
      expect(await readD1CustomerOrderLines(database, claims, orderId, now)).toMatchObject({
        outcome: 'found',
        detail: { fulfillmentStatus: null }
      })
      expect(await (await storefront())!.json()).toMatchObject({ fulfillmentStatus: 'untracked' })
      await database.prepare('UPDATE auth_sessions SET revoked_at=? WHERE id=?').bind(now, session).run()
      expect(await listD1CustomerOrders(database, claims, now)).toBeNull()
      expect(await readD1CustomerOrderLines(database, claims, orderId, now)).toEqual({ outcome: 'unauthenticated' })
      expect((await storefront())?.status).toBe(401)
    } finally {
      await runtime.dispose()
    }
  }, 60000)
})

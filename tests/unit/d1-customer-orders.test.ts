import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import worker from '../../workers/canary'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import { createCart, quoteCart, setCartLine } from '../../workers/catalog/cart'
import {
  getCustomerOwnedOrderView,
  getOrderView,
  placeOrder,
  requestShippingOptions,
  type PlaceOrderInput
} from '../../workers/catalog/checkout'
import { assignReservation, releaseReservation, reserveInventory } from '../../workers/catalog/inventory'
import { executeD1AdminFulfillmentCommand } from '../../workers/fulfillment/admin'
import { deterministicTestData } from '../fixtures/deterministic'
import {
  activeOrderCustomerId,
  listD1CustomerOrders,
  readD1CustomerOrderLines
} from '../../workers/catalog/customer-orders'
import type { CustomerOrderDetailResult } from '../../workers/catalog/customer-orders'
import type { VerifiedSessionClaims } from '../../workers/catalog/authorization'
import { d1OverSqlite, openMigratedDatabase, seedInventoryFixture } from '../support/d1-sqlite'
import { afterPublicMediaRead, publishMediaFixture } from '../support/media-publication-fixture'
import { provisionPublicationValidityFixture } from '../support/publication-validity-fixture'

const NOW = '2026-08-25T09:00:00Z'
const A = '10000000-0000-4000-8000-000000000001'
const B = '10000000-0000-4000-8000-000000000002'
const CA = '30000000-0000-4000-8000-000000000001'
const CB = '30000000-0000-4000-8000-000000000002'
const SA = '20000000-0000-4000-8000-000000000001'
const SB = '20000000-0000-4000-8000-000000000002'
const claimsA: VerifiedSessionClaims = { identityId: A, sessionId: SA, sessionVersion: 1 }
const claimsB: VerifiedSessionClaims = { identityId: B, sessionId: SB, sessionVersion: 1 }
function historicalDetail(result: CustomerOrderDetailResult) {
  return result.outcome === 'found'
    ? {
        ...result,
        detail: { ...result.detail, lines: result.detail.lines.map(({ reorderOffer: _offer, ...line }) => line) }
      }
    : result
}

describe('D1 customer order ownership and read model', () => {
  let sqlite: DatabaseSync
  let database: D1Database
  let preparationData = deterministicTestData('customer-order-preparation', NOW)

  beforeEach(async () => {
    preparationData = deterministicTestData('customer-order-preparation', NOW)
    vi.useFakeTimers()
    vi.setSystemTime(new Date(NOW))
    sqlite = await openMigratedDatabase()
    // Keep production reads on their execution-time SQL clock. Only this local
    // SQLite instance substitutes the test's live Date clock, never captured NOW.
    sqlite.function('synthetic_customer_order_clock', () => {
      const milliseconds = Date.now(),
        instant = new Date(milliseconds).toISOString()
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(instant) || Date.parse(instant) !== milliseconds)
        throw new Error('invalid_synthetic_customer_order_clock')
      return instant
    })
    const nativeDatabase = d1OverSqlite(sqlite),
      nativePrepare = nativeDatabase.prepare.bind(nativeDatabase)
    database = new Proxy(nativeDatabase, {})
    // Capture the real delegate before exposing the wrapper so prepare spies
    // observe this method without recursively calling their own mocked target.
    database.prepare = (sql: string) => nativePrepare(sql.replaceAll("'now'", 'synthetic_customer_order_clock()'))
    const world = seedInventoryFixture(sqlite)
    await provisionPublicationValidityFixture(database, {
      productIds: ['p-1', 'p-2', 'p-3', 'p-4', 'p-5', 'p-6'],
      now: NOW
    })
    sqlite.exec(`
      INSERT INTO shipping_zones(id, code, name, kind, postal_prefixes, active, created_at)
      VALUES ('pickup-zone', 'pickup', 'Pickup', 'warehouse_pickup', '[]', 1, '${NOW}');
      INSERT INTO shipping_rates(id, zone_id, method_code, service_profile, net_cents,
        tax_rate_basis_points, eta_min_days, eta_max_days, rate_version, active, created_at)
      VALUES ('pickup-rate', 'pickup-zone', 'pickup', 'parcel', 0, 2100, 0, 0, 1, 1, '${NOW}');
      UPDATE products SET attributes = '{"image":"/img/products/fixture.webp","visual":{"type":"botella","color":"#123456"}}'
      WHERE id = 'p-1';
    `)
    expect(world.variantId(1, 1)).toBe('v-1-1')
    for (const [id, customerId, sessionId, email] of [
      [A, CA, SA, 'same@example.invalid'],
      [B, CB, SB, 'other@example.invalid']
    ] as const) {
      sqlite.prepare('INSERT INTO customers(id, created_at, updated_at) VALUES (?, ?, ?)').run(customerId, NOW, NOW)
      sqlite
        .prepare(
          `INSERT INTO identities(id, email, password_hash, email_verified_at, status,
        customer_id, created_at, updated_at) VALUES (?, ?, 'fixture', ?, 'active', ?, ?, ?)`
        )
        .run(id, email, NOW, customerId, NOW, NOW)
      sqlite
        .prepare(
          `INSERT INTO auth_sessions(id, identity_id, session_version, created_at, expires_at)
        VALUES (?, ?, 1, '2026-08-25T08:00:00Z', '2026-08-25T10:00:00Z')`
        )
        .run(sessionId, id)
    }
  })

  async function preparationOrder(method = 'pickup') {
    if (method === 'own_delivery')
      sqlite.exec(
        `INSERT INTO shipping_zones(id,code,name,kind,postal_prefixes,active,created_at) VALUES ('preparation-own','preparation-own','Synthetic own delivery','own_delivery','["46"]',1,'${NOW}'); INSERT INTO shipping_rates(id,zone_id,method_code,service_profile,net_cents,tax_rate_basis_points,eta_min_days,eta_max_days,rate_version,active,created_at) VALUES ('preparation-own-rate','preparation-own','own_delivery','parcel',500,2100,1,2,1,1,'${NOW}');`
      )
    const placed = await placeOrder(database, await input({ ownerSession: claimsA }, ['v-1-1'], method))
    if (placed.outcome !== 'order_created') throw new Error(placed.outcome)
    const orderId = String(placed.body.id)
    const row = sqlite
      .prepare('SELECT total_gross_cents total,reservation_id reservation FROM orders WHERE id=?')
      .get(orderId) as { total: number; reservation: string }
    await assignReservation(database, {
      idempotencyKey: row.reservation,
      correlationId: 'synthetic-customer-preparation',
      now: NOW,
      reason: 'Synthetic captured payment'
    })
    const payment = preparationData.uuid()
    sqlite
      .prepare(
        `INSERT INTO payment_intents(id,order_id,provider,merchant_order,method,status,amount_gross_cents,currency,request_hash,redirect_envelope_hash,response_code,expires_at,correlation_id,created_at,updated_at)
      VALUES(?,?,'redsys',?,'card','captured',?,'EUR',?,?,'0000','2026-08-25T10:00:00Z','synthetic',?,?)`
      )
      .run(
        payment,
        orderId,
        '1234' + preparationData.token().slice(0, 8),
        row.total,
        'a'.repeat(64),
        'b'.repeat(64),
        NOW,
        NOW
      )
    sqlite
      .prepare(
        "INSERT INTO order_payment_states(order_id,status,active_intent_id,paid_gross_cents,updated_at) VALUES(?,'paid',?,?,?)"
      )
      .run(orderId, payment, row.total, NOW)
    sqlite.prepare('INSERT INTO payment_fulfilment_claims VALUES(?,?,?)').run(orderId, payment, NOW)
    sqlite
      .prepare(
        "INSERT INTO payment_recovery_jobs(payment_intent_id,order_id,status,attempts,due_at,created_at,updated_at) VALUES(?,?,'completed',1,?,?,?)"
      )
      .run(payment, orderId, NOW, NOW, NOW)
    sqlite
      .prepare(
        "INSERT INTO payment_events(id,payment_intent_id,order_id,provider_event_id,event_type,payload_hash,response_code,correlation_id,created_at) VALUES(?,?,?,?,'captured',?,'0000','synthetic',?)"
      )
      .run(preparationData.uuid(), payment, orderId, preparationData.uuid(), 'c'.repeat(64), NOW)
    sqlite.exec(
      "INSERT OR IGNORE INTO roles VALUES ('customer_order_operator','Synthetic operator','Synthetic'); INSERT OR IGNORE INTO permissions VALUES ('administration.manage','administration','manage','Synthetic'); INSERT OR IGNORE INTO role_permissions VALUES ('customer_order_operator','administration.manage');"
    )
    sqlite
      .prepare("INSERT INTO identity_roles(identity_id,role_code,granted_at) VALUES (?,'customer_order_operator',?)")
      .run(A, NOW)
    sqlite.prepare('UPDATE auth_sessions SET mfa_verified=1 WHERE id=?').run(SA)
    return orderId
  }
  const preparationCommand = (orderId: string, action: string, expectedVersion: number) =>
    executeD1AdminFulfillmentCommand(
      database,
      claimsA,
      orderId,
      {
        action,
        expectedVersion,
        reason: 'Synthetic internal warehouse preparation reason',
        ...(['exception', 'delivered', 'in_transit'].includes(action)
          ? { evidence: 'Synthetic internal verified operational evidence' }
          : {})
      },
      { idempotencyKey: preparationData.uuid(), now: NOW }
    )

  it('exposes only actual confirmed preparation states and preserves immutable customer snapshots', async () => {
    const orderId = await preparationOrder(),
      baseline = await readD1CustomerOrderLines(database, claimsA, orderId, NOW)
    expect(baseline).toMatchObject({ outcome: 'found', detail: { fulfillmentStatus: null, shipment: null } })
    const lines = sqlite.prepare('SELECT * FROM order_lines WHERE order_id=?').all(orderId)
    for (const [version, state] of ['picking', 'packed', 'ready_for_pickup', 'delivered'].entries()) {
      await preparationCommand(orderId, state, version)
      const detail = await readD1CustomerOrderLines(database, claimsA, orderId, NOW)
      expect(detail).toMatchObject({ outcome: 'found', detail: { fulfillmentStatus: state, shipment: null } })
      expect((await listD1CustomerOrders(database, claimsA, NOW))?.orders[0]?.status).toBe(
        (
          {
            picking: 'preparando',
            packed: 'preparando',
            ready_for_pickup: 'listo_recogida',
            delivered: 'entregado'
          } as Record<string, string>
        )[state]
      )
      if (detail.outcome !== 'found' || baseline.outcome !== 'found') throw new Error('missing_customer_detail')
      expect({ ...detail.detail, fulfillmentStatus: null }).toEqual(baseline.detail)
      expect(JSON.stringify(detail)).not.toMatch(
        /internal warehouse|operational evidence|warehouseId|actorId|interruptedState|commandId|timeline/
      )
    }
    expect(sqlite.prepare('SELECT * FROM order_lines WHERE order_id=?').all(orderId)).toEqual(lines)
    expect(await readD1CustomerOrderLines(database, claimsB, orderId, NOW)).toEqual({ outcome: 'not_found' })
  })
  it('does not expose an unconfirmed projection when its matching audit history is missing', async () => {
    const orderId = await preparationOrder()
    await preparationCommand(orderId, 'picking', 0)
    sqlite.exec('DROP TRIGGER order_fulfillment_audit_no_delete; DELETE FROM order_fulfillment_audit')
    expect(await readD1CustomerOrderLines(database, claimsA, orderId, NOW)).toMatchObject({
      outcome: 'found',
      detail: { fulfillmentStatus: null }
    })
  })
  it.each(['audit_mismatch', 'projection_mismatch'] as const)(
    'withholds %s rather than claiming preparation',
    async (fault) => {
      const orderId = await preparationOrder()
      await preparationCommand(orderId, 'picking', 0)
      if (fault === 'audit_mismatch')
        sqlite.exec(
          "DROP TRIGGER order_fulfillment_audit_no_update; UPDATE order_fulfillment_audit SET reason='Tampered internal synthetic reason'"
        )
      else sqlite.exec("DROP TRIGGER order_fulfillments_update; UPDATE order_fulfillments SET status='packed'")
      expect(await readD1CustomerOrderLines(database, claimsA, orderId, NOW)).toMatchObject({
        outcome: 'found',
        detail: { fulfillmentStatus: null }
      })
    }
  )
  it('reads the newest confirmed preparation after asynchronous media decoration in the final owner snapshot', async () => {
    const orderId = await preparationOrder()
    await preparationCommand(orderId, 'picking', 0)
    let advanced = false
    const wrapped = afterPublicMediaRead(database, async () => {
      if (!advanced) {
        advanced = true
        await preparationCommand(orderId, 'packed', 1)
      }
    })
    expect(await readD1CustomerOrderLines(wrapped, claimsA, orderId, NOW)).toMatchObject({
      outcome: 'found',
      detail: { fulfillmentStatus: 'packed' }
    })
    expect(advanced).toBe(true)
  })
  it('projects confirmed own-delivery handover without inventing a shipment or tracking', async () => {
    const orderId = await preparationOrder('own_delivery')
    for (const [version, state] of ['picking', 'packed', 'in_transit'].entries())
      await preparationCommand(orderId, state, version)
    expect(await readD1CustomerOrderLines(database, claimsA, orderId, NOW)).toMatchObject({
      outcome: 'found',
      detail: { fulfillmentStatus: 'in_transit', shippingMethod: 'reparto', shipment: null }
    })
    expect((await listD1CustomerOrders(database, claimsA, NOW))?.orders[0]?.status).toBe('enviado')
  })
  it('never exposes a future confirmed command before its explicit evaluation instant', async () => {
    const orderId = await preparationOrder(),
      future = '2026-08-25T09:00:01Z'
    await executeD1AdminFulfillmentCommand(
      database,
      claimsA,
      orderId,
      { action: 'picking', expectedVersion: 0, reason: 'Synthetic future operational timestamp' },
      { idempotencyKey: preparationData.uuid(), now: future }
    )
    expect(await readD1CustomerOrderLines(database, claimsA, orderId, NOW)).toMatchObject({
      outcome: 'found',
      detail: { fulfillmentStatus: null }
    })
    vi.setSystemTime(new Date(future))
    expect(await readD1CustomerOrderLines(database, claimsA, orderId, future)).toMatchObject({
      outcome: 'found',
      detail: { fulfillmentStatus: 'picking' }
    })
  })
  it('projects a confirmed exception without disclosing its internal explanation and retains history after cancellation', async () => {
    const orderId = await preparationOrder()
    await preparationCommand(orderId, 'exception', 0)
    expect((await listD1CustomerOrders(database, claimsA, NOW))?.orders[0]?.status).toBe('pagado')
    sqlite.prepare("UPDATE orders SET status='cancelled' WHERE id=?").run(orderId)
    expect((await listD1CustomerOrders(database, claimsA, NOW))?.orders[0]?.status).toBe('cancelado')
    const detail = await readD1CustomerOrderLines(database, claimsA, orderId, NOW)
    expect(detail).toMatchObject({ outcome: 'found', detail: { fulfillmentStatus: 'exception', shipment: null } })
    expect(JSON.stringify(detail)).not.toMatch(
      /internal warehouse|operational evidence|warehouseId|actorId|interruptedState/
    )
  })

  afterEach(() => {
    sqlite.close()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  async function input(
    overrides: Partial<PlaceOrderInput> = {},
    variantIds = ['v-1-1'],
    method?: string
  ): Promise<PlaceOrderInput> {
    const cart = await createCart(database, { correlationId: 'fixture', now: NOW })
    for (const [index, variantId] of variantIds.entries())
      await setCartLine(database, {
        cartId: cart.cartId,
        token: cart.token,
        variantId,
        quantity: 2,
        expectedVersion: index + 1,
        idempotencyKey: `add-${index}`,
        correlationId: 'fixture',
        now: NOW
      })
    const shipping = await requestShippingOptions(database, {
      cartId: cart.cartId,
      token: cart.token,
      expectedVersion: variantIds.length + 1,
      idempotencyKey: 'ship',
      correlationId: 'fixture',
      now: NOW,
      destination: { city: 'Ontinyent', postalCode: '46870' }
    })
    if (shipping.outcome !== 'options') throw new Error(`shipping: ${shipping.outcome}`)
    const quote = await quoteCart(database, {
      cartId: cart.cartId,
      token: cart.token,
      expectedVersion: variantIds.length + 1,
      idempotencyKey: 'quote',
      correlationId: 'fixture',
      now: NOW
    })
    if (quote.outcome !== 'quoted') throw new Error(`quote: ${quote.outcome}`)
    const options = shipping.body.options as Array<{ optionIndex: number; optionHash: string; methodCode: string }>
    const option = (method ? options.find((option) => option.methodCode === method) : options[0])!
    if (!option) throw new Error('missing_synthetic_shipping_option')
    return {
      cartId: cart.cartId,
      token: cart.token,
      expectedVersion: quote.quote.cartVersion,
      idempotencyKey: 'checkout',
      correlationId: 'fixture',
      now: NOW,
      quoteId: quote.quote.quoteId,
      shippingQuoteId: shipping.body.shippingQuoteId as string,
      selectedOptionIndex: option.optionIndex,
      selectedOptionHash: option.optionHash,
      contactEmail: 'same@example.invalid',
      consentTos: true,
      consentPrivacy: true,
      shippingAddress: {
        recipientName: 'Persona de prueba',
        line1: 'Carrer Major 1',
        city: 'Ontinyent',
        province: 'València',
        postalCode: '46870',
        phone: '+34600000000',
        countryCode: 'ES'
      },
      ...overrides
    }
  }

  it('decorates only the contractual SKU with its own publication and preserves immutable order snapshots', async () => {
    const placed = await placeOrder(database, await input({ ownerSession: claimsA }))
    if (placed.outcome !== 'order_created') throw new Error(placed.outcome)
    const orderId = (placed.body as { id: string }).id
    const snapshots = sqlite.prepare('SELECT * FROM order_lines WHERE order_id = ?').all(orderId)
    sqlite.exec(`UPDATE products SET attributes = '{"image":"https://unapproved.example.invalid/product.jpg"}' WHERE id = 'p-1';
      UPDATE variants SET image = '/img/products/unapproved.webp' WHERE id = 'v-1-1';
      INSERT INTO variants(id, legacy_id, product_id, sku, mpn, format, status, price_gross_cents, tax_class_id, shipping_profile_id)
      VALUES ('v-1-2', 12, 'p-1', 'SKU-1-2', 'SYNTHETIC-ORDER-SKU-1-2', 'Otro color', 'published', 900, 't21', 'sp1')`)
    await publishMediaFixture(database, { now: NOW, productId: 'p-1' })
    await publishMediaFixture(database, { now: NOW, productId: 'p-1', variantId: 'v-1-2' })
    const baseline = await readD1CustomerOrderLines(database, claimsA, orderId, NOW)
    if (baseline.outcome !== 'found') throw new Error(baseline.outcome)
    expect(baseline.detail.lines[0]).toMatchObject({ image: null, imageAlt: null, unitGross: 500, lineGross: 1000 })
    const photo = await publishMediaFixture(database, {
      now: NOW,
      productId: 'p-1',
      variantId: 'v-1-1',
      imageAlt: 'Foto exacta del SKU contractual'
    })
    const published = await readD1CustomerOrderLines(database, claimsA, orderId, NOW)
    expect(published).toEqual({
      ...baseline,
      detail: {
        ...baseline.detail,
        lines: [{ ...baseline.detail.lines[0], image: photo.image, imageAlt: photo.imageAlt }]
      }
    })
    for (const forbidden of [
      'unapproved',
      'productUuid',
      'variantUuid',
      'currentSku',
      photo.uploadId,
      'object_key',
      'scannerVersion'
    ])
      expect(JSON.stringify(published)).not.toContain(forbidden)
    sqlite.exec(
      "UPDATE variants SET price_gross_cents = 900, format = 'Formato actual cambiado' WHERE id = 'v-1-1'; UPDATE products SET name = 'Nombre actual cambiado' WHERE id = 'p-1'"
    )
    const repriced = await readD1CustomerOrderLines(database, claimsA, orderId, NOW)
    expect(historicalDetail(repriced)).toEqual(historicalDetail(published))
    expect(repriced).toMatchObject({
      outcome: 'found',
      detail: { lines: [{ reorderOffer: { unitGross: 900, lineGross: 1800 } }] }
    })
    await photo.withdraw()
    expect(historicalDetail(await readD1CustomerOrderLines(database, claimsA, orderId, NOW))).toEqual(
      historicalDetail(baseline)
    )
    expect(sqlite.prepare('SELECT * FROM order_lines WHERE order_id = ?').all(orderId)).toEqual(snapshots)
  })

  it('compares the original quantities with current governed tiers, VAT and observed single-location stock without changing history', async () => {
    const placed = await placeOrder(database, await input({ ownerSession: claimsA }))
    if (placed.outcome !== 'order_created') throw new Error(placed.outcome)
    const orderId = String(placed.body.id)
    const history = sqlite.prepare('SELECT * FROM order_lines WHERE order_id=?').all(orderId)
    sqlite.exec(`INSERT INTO tax_classes(id,code,name,rate_basis_points,valid_from) VALUES ('reorder-t10','REORDER-10','Synthetic VAT',1000,'2020-01-01T00:00:00Z');
      UPDATE variants SET tax_class_id='reorder-t10',price_gross_cents=999 WHERE id='v-1-1';
      INSERT INTO variant_price_versions(id,variant_id,gross_cents,volume_tiers,valid_from,status,reason,created_at)
      VALUES('reorder-live','v-1-1',777,'[{"minimumQuantity":2,"unitGrossCents":654}]','2026-08-25T08:00:00Z','approved','Synthetic current offer','2026-08-25T08:00:00Z');`)
    const result = await readD1CustomerOrderLines(database, claimsA, orderId, NOW)
    expect(result).toMatchObject({
      outcome: 'found',
      detail: {
        lines: [
          {
            quantity: 2,
            unitGross: 500,
            lineGross: 1000,
            reorderOffer: {
              evaluatedAt: NOW,
              unitGross: 654,
              lineGross: 1308,
              unitNet: 595,
              lineNet: 1189,
              taxRateBasisPoints: 1000,
              pricingVersion: 'reorder-live',
              minimumQuantity: 1,
              maximumQuantity: null,
              quantityIncrement: 1,
              availableQuantity: 22,
              backorderAllowed: false,
              quantityAllowed: true,
              stockSufficient: true,
              purchasable: true
            }
          }
        ]
      }
    })
    expect(sqlite.prepare('SELECT * FROM order_lines WHERE order_id=?').all(orderId)).toEqual(history)
  })
  it('does not describe a zero-priced current variant as purchasable when checkout requires a positive goods price', async () => {
    const placed = await placeOrder(database, await input({ ownerSession: claimsA }))
    if (placed.outcome !== 'order_created') throw new Error(placed.outcome)
    sqlite.exec("UPDATE variants SET price_gross_cents=0 WHERE id='v-1-1'")
    expect(await readD1CustomerOrderLines(database, claimsA, String(placed.body.id), NOW)).toMatchObject({
      outcome: 'found',
      detail: {
        lines: [
          {
            quantity: 2,
            unitGross: 500,
            lineGross: 1000,
            available: false,
            variantId: null,
            reorderOffer: null
          }
        ]
      }
    })
  })
  it('uses one execution instant for newly confirmed fulfillment and the final observed offer', async () => {
    const orderId = await preparationOrder()
    await preparationCommand(orderId, 'picking', 0)
    const tick = '2026-08-25T09:00:01Z'
    let advanced = false
    const wrapped = new Proxy(database, {
      get(target, property, receiver) {
        if (property === 'prepare')
          return (sql: string) => {
            const original = target.prepare(sql)
            if (!sql.includes('auth_sessions') || !sql.includes('order_lines') || !sql.includes('fulfillmentStatus'))
              return original
            function bindBoundary(statement: D1PreparedStatement): D1PreparedStatement {
              return new Proxy(statement, {
                get(statementTarget, key) {
                  if (key === 'bind') return (...values: unknown[]) => bindBoundary(statementTarget.bind(...values))
                  if (key === 'all')
                    return async () => {
                      if (!advanced) {
                        advanced = true
                        vi.setSystemTime(new Date(tick))
                        await executeD1AdminFulfillmentCommand(
                          database,
                          claimsA,
                          orderId,
                          {
                            action: 'packed',
                            expectedVersion: 1,
                            reason: 'Synthetic confirmed packing during final read'
                          },
                          { idempotencyKey: preparationData.uuid(), now: tick }
                        )
                      }
                      return statementTarget.all()
                    }
                  return Reflect.get(statementTarget, key)
                }
              })
            }
            return bindBoundary(original)
          }
        return Reflect.get(target, property, receiver)
      }
    })
    expect(await readD1CustomerOrderLines(wrapped, claimsA, orderId, NOW)).toMatchObject({
      outcome: 'found',
      detail: { fulfillmentStatus: 'packed', lines: [{ reorderOffer: { evaluatedAt: tick } }] }
    })
    expect(advanced).toBe(true)
  })
  it.each([
    'minimum',
    'maximum',
    'increment',
    'stock',
    'split-stock',
    'inactive-stock',
    'backorder',
    'backorder-no-location'
  ] as const)(
    'reports the original quantity against actual %s constraints without creating reservations',
    async (change) => {
      const placed = await placeOrder(database, await input({ ownerSession: claimsA }))
      if (placed.outcome !== 'order_created') throw new Error(placed.outcome)
      const reservations = sqlite.prepare('SELECT * FROM inventory_reservations').all()
      if (change === 'minimum') sqlite.exec("UPDATE variants SET minimum_quantity=3 WHERE id='v-1-1'")
      if (change === 'maximum') sqlite.exec("UPDATE variants SET maximum_quantity=1 WHERE id='v-1-1'")
      if (change === 'increment') sqlite.exec("UPDATE variants SET quantity_increment=2 WHERE id='v-1-1'")
      if (['stock', 'split-stock', 'inactive-stock', 'backorder', 'backorder-no-location'].includes(change))
        sqlite.exec("UPDATE inventory_balances SET physical_quantity=4 WHERE variant_id='v-1-1'")
      if (change === 'split-stock')
        sqlite.exec(`INSERT INTO inventory_locations(id,code,name,kind,active,created_at) VALUES ('reorder-second','REORDER2','Synthetic second','warehouse',1,'${NOW}');
        INSERT INTO inventory_balances(variant_id,location_id,physical_quantity,blocked_quantity,version,created_at,updated_at) VALUES ('v-1-1','reorder-second',2,0,1,'${NOW}','${NOW}');`)
      if (change === 'inactive-stock')
        sqlite.exec(`INSERT INTO inventory_locations(id,code,name,kind,active,created_at) VALUES ('reorder-inactive','REORDER-INACTIVE','Synthetic inactive','warehouse',0,'${NOW}');
        INSERT INTO inventory_balances(variant_id,location_id,physical_quantity,blocked_quantity,version,created_at,updated_at) VALUES ('v-1-1','reorder-inactive',99,0,1,'${NOW}','${NOW}');`)
      if (change.startsWith('backorder')) sqlite.exec("UPDATE variants SET backorder_allowed=1 WHERE id='v-1-1'")
      if (change === 'backorder-no-location') sqlite.exec('UPDATE inventory_locations SET active=0')
      const result = await readD1CustomerOrderLines(database, claimsA, String(placed.body.id), NOW)
      const quantityAllowed = !['minimum', 'maximum', 'increment'].includes(change)
      const stockSufficient = !['stock', 'split-stock', 'inactive-stock', 'backorder-no-location'].includes(change)
      expect(result).toMatchObject({
        outcome: 'found',
        detail: {
          lines: [
            {
              quantity: 2,
              reorderOffer: {
                quantityAllowed,
                stockSufficient,
                purchasable: quantityAllowed && stockSufficient,
                backorderAllowed: change.startsWith('backorder'),
                availableQuantity:
                  change === 'backorder-no-location'
                    ? 0
                    : ['stock', 'split-stock', 'inactive-stock', 'backorder'].includes(change)
                      ? 1
                      : 22
              }
            }
          ]
        }
      })
      expect(sqlite.prepare('SELECT * FROM inventory_reservations').all()).toEqual(reservations)
    }
  )
  it.each(['product', 'variant', 'category', 'brand', 'policy', 'tax', 'sku'] as const)(
    'does not present a current reorder offer after %s authority/publication drift during media await',
    async (change) => {
      const placed = await placeOrder(database, await input({ ownerSession: claimsA }))
      if (placed.outcome !== 'order_created') throw new Error(placed.outcome)
      const wrapped = afterPublicMediaRead(database, () => {
        if (change === 'product') sqlite.exec("UPDATE products SET status='draft' WHERE id='p-1'")
        if (change === 'variant') sqlite.exec("UPDATE variants SET status='draft' WHERE id='v-1-1'")
        if (change === 'category') sqlite.exec("UPDATE categories SET status='draft' WHERE id='c1'")
        if (change === 'brand') sqlite.exec("UPDATE brands SET status='draft' WHERE id='b1'")
        if (change === 'policy') sqlite.exec("UPDATE products SET regulatory='{}' WHERE id='p-1'")
        if (change === 'tax') sqlite.exec("UPDATE tax_classes SET valid_until='2026-08-25T09:00:00Z' WHERE id='t21'")
        if (change === 'sku') sqlite.exec("UPDATE variants SET sku='DIFFERENT-CURRENT-SKU' WHERE id='v-1-1'")
      })
      expect(await readD1CustomerOrderLines(wrapped, claimsA, String(placed.body.id), NOW)).toMatchObject({
        outcome: 'found',
        detail: {
          lines: [
            {
              sku: 'SKU-1-1',
              quantity: 2,
              unitGross: 500,
              lineGross: 1000,
              reorderOffer: null,
              available: false,
              variantId: null
            }
          ]
        }
      })
    }
  )
  it('observes a price activated during media await and keeps offer reads bounded across six lines', async () => {
    const placed = await placeOrder(
      database,
      await input({ ownerSession: claimsA }, ['v-1-1', 'v-2-1', 'v-3-1', 'v-4-1', 'v-5-1', 'v-6-1'])
    )
    if (placed.outcome !== 'order_created') throw new Error(placed.outcome)
    sqlite.exec(
      `INSERT INTO variant_price_versions(id,variant_id,gross_cents,valid_from,status,reason,created_at) VALUES('reorder-future','v-1-1',888,'2026-08-25T09:00:01Z','approved','Synthetic future offer','${NOW}')`
    )
    const wrapped = afterPublicMediaRead(database, () => {
      vi.setSystemTime(new Date('2026-08-25T09:00:01Z'))
    })
    const prepare = vi.spyOn(database, 'prepare')
    const result = await readD1CustomerOrderLines(wrapped, claimsA, String(placed.body.id), NOW)
    expect(result).toMatchObject({
      outcome: 'found',
      detail: {
        lines: [
          expect.objectContaining({
            reorderOffer: expect.objectContaining({
              evaluatedAt: '2026-08-25T09:00:01Z',
              pricingVersion: 'reorder-future',
              unitGross: 888
            })
          }),
          ...Array.from({ length: 5 }, () => expect.objectContaining({ reorderOffer: expect.any(Object) }))
        ]
      }
    })
    expect(prepare.mock.calls.length).toBeLessThanOrEqual(8)
  })

  it('never labels a historical line with a photo after its current variant SKU has changed', async () => {
    const placed = await placeOrder(database, await input({ ownerSession: claimsA }))
    if (placed.outcome !== 'order_created') throw new Error(placed.outcome)
    const orderId = (placed.body as { id: string }).id
    const baseline = await readD1CustomerOrderLines(database, claimsA, orderId, NOW)
    await publishMediaFixture(database, { now: NOW, productId: 'p-1', variantId: 'v-1-1' })
    sqlite.exec("UPDATE variants SET sku = 'REUSED-DIFFERENT-SKU' WHERE id = 'v-1-1'")
    if (baseline.outcome !== 'found') throw new Error(baseline.outcome)
    expect(await readD1CustomerOrderLines(database, claimsA, orderId, NOW)).toEqual({
      ...baseline,
      detail: {
        ...baseline.detail,
        lines: baseline.detail.lines.map((line) => ({
          ...line,
          available: false,
          variantId: null,
          slug: null,
          visual: null,
          reason: 'No disponible ahora mismo',
          reorderOffer: null
        }))
      }
    })
  })

  it('omits an optional photo that expires before its media SQL executes without changing historical order facts', async () => {
    const placed = await placeOrder(database, await input({ ownerSession: claimsA }))
    if (placed.outcome !== 'order_created') throw new Error(placed.outcome)
    const orderId = String(placed.body.id)
    const snapshots = sqlite.prepare('SELECT * FROM order_lines WHERE order_id=?').all(orderId)
    const baseline = await readD1CustomerOrderLines(database, claimsA, orderId, NOW)
    if (baseline.outcome !== 'found') throw new Error(baseline.outcome)
    const photo = await publishMediaFixture(database, { now: NOW, productId: 'p-1', variantId: 'v-1-1' })
    const withPhoto = await readD1CustomerOrderLines(database, claimsA, orderId, NOW)
    expect(withPhoto).toMatchObject({
      outcome: 'found',
      detail: { lines: [{ image: photo.image, imageAlt: photo.imageAlt }] }
    })
    // Scanner fixture remains its contractual one-day lifetime. Keep only this
    // customer's session live for two days so auth is not the expiry under test.
    sqlite.prepare('UPDATE auth_sessions SET expires_at=? WHERE id=?').run('2026-08-27T09:00:00Z', SA)
    let advanced = false
    const expiredAtExecution = new Proxy(database, {
      get(target, property, receiver) {
        if (property === 'prepare')
          return (sql: string) => {
            if (sql.includes('WITH supplied_now AS') && !advanced) {
              advanced = true
              vi.setSystemTime(new Date('2026-08-26T09:00:00Z'))
            }
            return target.prepare(sql)
          }
        return Reflect.get(target, property, receiver)
      }
    })
    const result = await readD1CustomerOrderLines(expiredAtExecution, claimsA, orderId, NOW)
    expect(advanced).toBe(true)
    expect(historicalDetail(result)).toEqual(historicalDetail(baseline))
    expect(result).toMatchObject({
      outcome: 'found',
      detail: { lines: [{ reorderOffer: { evaluatedAt: '2026-08-26T09:00:00Z' } }] }
    })
    expect(JSON.stringify(result)).not.toContain(photo.image)
    expect(sqlite.prepare('SELECT * FROM order_lines WHERE order_id=?').all(orderId)).toEqual(snapshots)
    expect(sqlite.prepare('SELECT revoked_at FROM auth_sessions WHERE id=?').get(SA)).toEqual({ revoked_at: null })
  })

  it.each([1, 6])('enriches %i historical lines with one bounded media query', async (count) => {
    const placed = await placeOrder(
      database,
      await input(
        { ownerSession: claimsA },
        Array.from({ length: count }, (_, i) => `v-${i + 1}-1`)
      )
    )
    if (placed.outcome !== 'order_created') throw new Error(placed.outcome)
    const prepare = vi.spyOn(database, 'prepare')
    const result = await readD1CustomerOrderLines(database, claimsA, (placed.body as { id: string }).id, NOW)
    expect(result).toMatchObject({
      outcome: 'found',
      detail: { lines: Array.from({ length: count }, () => expect.objectContaining({ image: null, imageAlt: null })) }
    })
    expect(prepare).toHaveBeenCalledTimes(5)
    expect(
      prepare.mock.calls.filter(([sql]) => sql.trimStart().startsWith('SELECT') && sql.includes('WITH supplied_now AS'))
    ).toHaveLength(1)
  })

  it.each(['revoked', 'version', 'customer_blocked', 'customer_rebound', 'email_unverified'] as const)(
    'rechecks private ownership when %s changes during media enrichment',
    async (change) => {
      const placed = await placeOrder(database, await input({ ownerSession: claimsA }))
      if (placed.outcome !== 'order_created') throw new Error(placed.outcome)
      const wrapped = afterPublicMediaRead(database, () => {
        if (change === 'revoked') sqlite.prepare('UPDATE auth_sessions SET revoked_at = ? WHERE id = ?').run(NOW, SA)
        if (change === 'version')
          sqlite.prepare('UPDATE identities SET session_version = session_version + 1 WHERE id = ?').run(A)
        if (change === 'customer_blocked')
          sqlite.prepare("UPDATE customers SET status = 'blocked' WHERE id = ?").run(CA)
        if (change === 'customer_rebound') {
          sqlite.prepare('UPDATE identities SET customer_id = NULL WHERE id = ?').run(B)
          sqlite.prepare('UPDATE identities SET customer_id = ? WHERE id = ?').run(CB, A)
        }
        if (change === 'email_unverified')
          sqlite.prepare('UPDATE identities SET email_verified_at = NULL WHERE id = ?').run(A)
      })
      expect(await readD1CustomerOrderLines(wrapped, claimsA, (placed.body as { id: string }).id, NOW)).toEqual({
        outcome: 'unauthenticated'
      })
    }
  )

  it('withholds private lines when the customer session expires naturally during media enrichment', async () => {
    const placed = await placeOrder(database, await input({ ownerSession: claimsA }))
    if (placed.outcome !== 'order_created') throw new Error(placed.outcome)
    sqlite.prepare('UPDATE auth_sessions SET expires_at = ? WHERE id = ?').run('2026-08-25T09:00:01Z', SA)
    const wrapped = afterPublicMediaRead(database, () => {
      vi.setSystemTime(new Date('2026-08-25T09:00:01Z'))
    })
    expect(await readD1CustomerOrderLines(wrapped, claimsA, (placed.body as { id: string }).id, NOW)).toEqual({
      outcome: 'unauthenticated'
    })
    expect(sqlite.prepare('SELECT revoked_at FROM auth_sessions WHERE id = ?').get(SA)).toEqual({ revoked_at: null })
  })

  it('never claims a guest order by matching its contact email', async () => {
    const placed = await placeOrder(database, await input())
    expect(placed.outcome).toBe('order_created')
    if (placed.outcome !== 'order_created') throw new Error(placed.outcome)
    const orderId = (placed.body as { id: string }).id
    expect(sqlite.prepare('SELECT customer_id FROM orders WHERE id = ?').get(orderId)).toEqual({ customer_id: null })
    expect(await listD1CustomerOrders(database, claimsA, NOW)).toEqual({ orders: [] })
    expect(await readD1CustomerOrderLines(database, claimsA, orderId, NOW)).toEqual({ outcome: 'not_found' })
    expect(() => sqlite.prepare('UPDATE orders SET customer_id = ? WHERE id = ?').run(CA, orderId)).toThrow()
  })

  it('records only a live session customer and scopes list and lines to that immutable owner', async () => {
    const checkout = await input({ ownerSession: claimsA })
    const placed = await placeOrder(database, checkout)
    expect(placed.outcome).toBe('order_created')
    if (placed.outcome !== 'order_created') throw new Error(placed.outcome)
    const orderId = (placed.body as { id: string }).id
    expect(sqlite.prepare('SELECT customer_id FROM orders WHERE id = ?').get(orderId)).toEqual({ customer_id: CA })
    const list = await listD1CustomerOrders(database, claimsA, NOW)
    expect(list?.orders).toEqual([
      expect.objectContaining({
        id: orderId,
        lines: 1,
        status: 'pendiente_pago',
        invoiceAvailable: false,
        fullDetailAvailable: true
      })
    ])
    expect(await listD1CustomerOrders(database, claimsB, NOW)).toEqual({ orders: [] })
    const detail = await readD1CustomerOrderLines(database, claimsA, orderId, NOW)
    expect(detail).toMatchObject({
      outcome: 'found',
      detail: {
        orderId,
        fulfillmentStatus: null,
        shipment: null,
        destination: { line1: null, postalCode: '46870', city: 'Ontinyent' },
        lines: [
          {
            sku: 'SKU-1-1',
            format: 'Botella 1 L',
            quantity: 2,
            available: true,
            variantId: 11,
            slug: 'producto-1',
            image: null,
            imageAlt: null
          }
        ]
      }
    })
    expect(await readD1CustomerOrderLines(database, claimsB, orderId, NOW)).toEqual({ outcome: 'not_found' })
    expect(await getCustomerOwnedOrderView(database, { orderId, claims: claimsA, now: NOW })).toMatchObject({
      id: orderId,
      contactEmail: 'same@example.invalid',
      lines: [{ sku: 'SKU-1-1' }]
    })
    expect(await getCustomerOwnedOrderView(database, { orderId, claims: claimsB, now: NOW })).toBeNull()
    const later = '2026-08-26T09:00:00Z'
    sqlite.prepare('UPDATE auth_sessions SET expires_at = ? WHERE id = ?').run('2026-08-27T09:00:00Z', SA)
    const orderToken = (placed.body as { orderToken: string }).orderToken
    expect(await getOrderView(database, { orderId, token: orderToken, now: later })).toBeNull()
    expect(await getCustomerOwnedOrderView(database, { orderId, claims: claimsA, now: later })).toMatchObject({
      id: orderId
    })
    expect(await readD1CustomerOrderLines(database, claimsA, crypto.randomUUID(), NOW)).toEqual({
      outcome: 'not_found'
    })
    expect(() => sqlite.prepare('UPDATE orders SET customer_id = ? WHERE id = ?').run(CB, orderId)).toThrow()

    sqlite
      .prepare(
        `INSERT INTO order_payment_states(order_id, status, paid_gross_cents, updated_at)
      VALUES (?, 'paid', 1000, ?)`
      )
      .run(orderId, NOW)
    expect((await listD1CustomerOrders(database, claimsA, NOW))?.orders[0]?.status).toBe('pagado')
    sqlite.prepare("UPDATE order_payment_states SET status = 'stock_exception' WHERE order_id = ?").run(orderId)
    expect((await listD1CustomerOrders(database, claimsA, NOW))?.orders[0]?.status).toBe('incidencia_stock')
    sqlite.prepare("UPDATE order_payment_states SET status = 'cancelled' WHERE order_id = ?").run(orderId)
    expect((await listD1CustomerOrders(database, claimsA, NOW))?.orders[0]?.status).toBe('pago_fallido')
  })

  it('rejects replays from another owner or from a guest, without changing the original owner', async () => {
    const checkout = await input({ ownerSession: claimsA })
    const placed = await placeOrder(database, checkout)
    expect(placed.outcome).toBe('order_created')
    await expect(placeOrder(database, { ...checkout, ownerSession: claimsB })).rejects.toThrow('different payload')
    await expect(placeOrder(database, { ...checkout, ownerSession: null })).rejects.toThrow('different payload')
    expect((await placeOrder(database, checkout)).outcome).toBe('order_created')
    expect(sqlite.prepare('SELECT customer_id FROM orders').get()).toEqual({ customer_id: CA })
  })

  it('rejects revoked sessions before checkout and again at the atomic insert gate', async () => {
    const checkout = await input({ ownerSession: claimsA })
    sqlite.prepare('UPDATE auth_sessions SET revoked_at = ? WHERE id = ?').run(NOW, SA)
    expect(await activeOrderCustomerId(database, claimsA, NOW)).toBeNull()
    await expect(placeOrder(database, checkout)).rejects.toThrow('Customer session is no longer active')
    expect(sqlite.prepare('SELECT count(*) AS n FROM orders').get()).toEqual({ n: 0 })

    sqlite.prepare('UPDATE auth_sessions SET revoked_at = NULL WHERE id = ?').run(SA)
    const second = await input({ ownerSession: claimsA })
    await expect(
      placeOrder(database, second, {
        reserve: async (request) => {
          const reserved = await reserveInventory(database, request)
          sqlite.prepare('UPDATE auth_sessions SET revoked_at = ? WHERE id = ?').run(NOW, SA)
          return reserved
        },
        release: (request) => releaseReservation(database, request)
      })
    ).rejects.toThrow('checkout finalisation failed')
    expect(sqlite.prepare('SELECT count(*) AS n FROM orders').get()).toEqual({ n: 0 })
  })

  it('enforces ownership at the HTTP boundary without caching private order data', async () => {
    const placed = await placeOrder(database, await input({ ownerSession: claimsA }))
    expect(placed.outcome).toBe('order_created')
    if (placed.outcome !== 'order_created') throw new Error(placed.outcome)
    const orderId = (placed.body as { id: string }).id
    const password = 'test-only-session-password-with-at-least-32-characters'
    const configuration = { password, maxAgeSeconds: 3600 }
    const ownerCookie = (await issueD1SessionCookie(database, claimsA, configuration))?.split(';')[0]
    const strangerCookie = (await issueD1SessionCookie(database, claimsB, configuration))?.split(';')[0]
    expect(ownerCookie).toBeTruthy()
    expect(strangerCookie).toBeTruthy()
    const env = {
      DB: database,
      AUTH_ENABLED: 'true',
      NUXT_SESSION_PASSWORD: password,
      CART_EDGE_LIMIT: { limit: async () => ({ success: true }) },
      AUTH_RATE_LIMIT_PEPPER: 'test-order-rate-limit-pepper-0123456789abcdef'
    } as unknown as CloudflareEnv
    const get = (path: string, cookie?: string) =>
      worker.fetch(
        new Request(`https://neteco.invalid${path}`, {
          headers: { 'cf-connecting-ip': '192.0.2.19', ...(cookie ? { cookie } : {}) }
        }),
        env
      )

    const unauthenticated = await get('/api/orders')
    expect(unauthenticated.status).toBe(401)
    expect(unauthenticated.headers.get('cache-control')).toBe('no-store')

    const owned = await get('/api/orders', ownerCookie)
    expect(owned.status).toBe(200)
    expect(owned.headers.get('cache-control')).toBe('no-store')
    await expect(owned.json()).resolves.toMatchObject({ orders: [{ id: orderId }] })

    const ownLines = await get(`/api/orders/${orderId}/lines`, ownerCookie)
    expect(ownLines.status).toBe(200)
    expect(ownLines.headers.get('cache-control')).toBe('no-store')
    await expect(ownLines.json()).resolves.toMatchObject({ orderId, lines: [{ sku: 'SKU-1-1' }] })

    const ownDetail = await get(`/api/orders/${orderId}`, ownerCookie)
    expect(ownDetail.status).toBe(200)
    expect(ownDetail.headers.get('cache-control')).toBe('no-store')
    await expect(ownDetail.json()).resolves.toMatchObject({
      source: 'cloudflare',
      id: orderId,
      email: 'same@example.invalid'
    })
    const deniedDetail = await get(`/api/orders/${orderId}`, strangerCookie)
    const unknownDetail = await get(`/api/orders/${crypto.randomUUID()}`, strangerCookie)
    expect(deniedDetail.status).toBe(404)
    expect(await deniedDetail.text()).toBe(await unknownDetail.text())

    sqlite.prepare('UPDATE auth_sessions SET revoked_at = ? WHERE id = ?').run(NOW, SA)
    expect((await get(`/api/orders/${orderId}`, ownerCookie)).status).toBe(401)

    const denied = await get(`/api/orders/${orderId}/lines`, strangerCookie)
    const unknown = await get(`/api/orders/${crypto.randomUUID()}/lines`, strangerCookie)
    expect(denied.status).toBe(404)
    expect(denied.headers.get('cache-control')).toBe('no-store')
    expect(await denied.text()).toBe(await unknown.text())
  })
})

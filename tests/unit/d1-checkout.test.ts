import { describe, expect, it, vi } from 'vitest'
import {
  compensateStaleAttempts,
  getOrderView,
  placeOrder,
  requestShippingOptions,
  type PlaceOrderInput
} from '../../workers/catalog/checkout'
import { createCart, quoteCart, setCartLine } from '../../workers/catalog/cart'
import { releaseReservation, reserveInventory } from '../../workers/catalog/inventory'
import { handleCartCommand } from '../../workers/cart-coordinator'
import { applyGeneratedSeed, d1OverSqlite, openMigratedDatabase, seedInventoryFixture } from '../support/d1-sqlite'

const NOW = '2026-08-25T09:00:00Z'
const UUID_A = '11111111-1111-4111-8111-111111111111'
const UUID_B = '22222222-2222-4222-8222-222222222222'

function shippingSeed() {
  return `
INSERT INTO shipping_zones (id, code, name, kind, postal_prefixes, active, created_at)
VALUES
  ('zone-pickup', 'pickup', 'Recogida almacén Ontinyent', 'warehouse_pickup', '[]', 1, '${NOW}'),
  ('zone-own', 'own', 'Reparto propio Ontinyent', 'own_delivery', '["468"]', 1, '${NOW}'),
  ('zone-parcel', 'parcel', 'Paquetería peninsular', 'parcel_peninsular', '["peninsular"]', 1, '${NOW}');
INSERT INTO shipping_rates (
  id, zone_id, method_code, service_profile, net_cents, tax_rate_basis_points,
  eta_min_days, eta_max_days, rate_version, active, created_at
) VALUES
  ('rate-pickup', 'zone-pickup', 'pickup', 'parcel', 0, 2100, 0, 0, 1, 1, '${NOW}'),
  ('rate-own', 'zone-own', 'own_delivery', 'parcel', 350, 2100, 1, 2, 1, 1, '${NOW}'),
  ('rate-parcel', 'zone-parcel', 'parcel', 'parcel', 495, 2100, 3, 5, 1, 1, '${NOW}'),
  ('rate-pallet', 'zone-parcel', 'parcel', 'pallet', 4900, 2100, 4, 7, 1, 1, '${NOW}'),
  ('rate-adr', 'zone-parcel', 'parcel', 'adr', 9900, 2100, 5, 9, 1, 1, '${NOW}');
`.trim()
}

async function world() {
  const sqlite = await openMigratedDatabase()
  seedInventoryFixture(sqlite)
  sqlite.exec(
    "INSERT INTO products (id, legacy_id, category_id, name, slug, status) VALUES ('p-uuid-a', 201, 'c1', 'Producto UUID A', 'producto-uuid-a', 'published')"
  )
  for (const [index, variantId] of [UUID_A, UUID_B].entries()) {
    sqlite
      .prepare(
        `INSERT INTO variants (
           id, legacy_id, product_id, tax_class_id, shipping_profile_id, sku, format, status,
           price_gross_cents, backorder_allowed, weight_grams
         ) VALUES (?, ?, 'p-uuid-a', 't21', 'sp1', ?, 'Botella 1 L', 'published', 500, 0, 1000)`
      )
      .run(variantId, 2001 + index, `SKU-${variantId.slice(0, 8)}`)
    sqlite
      .prepare(
        `INSERT INTO inventory_balances (
           variant_id, location_id, physical_quantity, blocked_quantity, version, created_at, updated_at
         ) VALUES (?, 'loc-main', 25, 0, 1, '2026-08-12T00:00:00Z', '2026-08-12T00:00:00Z')`
      )
      .run(variantId)
    sqlite
      .prepare(
        `INSERT INTO inventory_movements (
           id, variant_id, location_id, movement_type, physical_delta, reserved_delta,
           reference_type, idempotency_key, correlation_id, reason, created_at
         ) VALUES (?, ?, 'loc-main', 'initial', 25, 0, 'seed', ?, 'fixture', 'Saldo inicial', '2026-08-12T00:00:00Z')`
      )
      .run(`mv-${variantId}`, variantId, `mv-${variantId}`)
  }
  applyGeneratedSeed(sqlite, shippingSeed())

  sqlite
    .prepare(
      `INSERT INTO variant_price_versions (
         id, variant_id, gross_cents, volume_tiers, valid_from, status, reason, created_at
       ) VALUES ('pv-checkout-a', '${UUID_A}', 400, '[]', '2026-01-01T00:00:00Z', 'approved', 'Precio gobernado', '2026-01-01T00:00:00Z')`
    )
    .run()

  return { database: d1OverSqlite(sqlite), sqlite }
}

interface CheckoutContext {
  cartId: string
  expectedVersion: number
  optionHash: string
  quoteId: string
  shippingQuoteId: string
  selectedOptionIndex: number
  token: string
}

async function buildCheckout(database: Awaited<ReturnType<typeof world>>['database']): Promise<CheckoutContext> {
  const created = await createCart(database, { correlationId: 't', now: NOW })
  const add = await setCartLine(database, {
    cartId: created.cartId,
    correlationId: 't',
    expectedVersion: 1,
    idempotencyKey: 'k-add',
    now: NOW,
    quantity: 2,
    token: created.token,
    variantId: UUID_A
  })
  expect(add.outcome).toBe('applied')

  const shipping = await requestShippingOptions(database, {
    cartId: created.cartId,
    correlationId: 't',
    destination: { city: 'Ontinyent', postalCode: '46870' },
    expectedVersion: 2,
    idempotencyKey: 'k-ship',
    now: NOW,
    token: created.token
  })
  if (shipping.outcome !== 'options') throw new Error(`shipping options failed: ${JSON.stringify(shipping)}`)

  const quote = await quoteCart(database, {
    cartId: created.cartId,
    correlationId: 't',
    expectedVersion: await currentVersion(database, created.cartId),
    idempotencyKey: 'k-quote',
    now: NOW,
    token: created.token
  })
  if (quote.outcome !== 'quoted') throw new Error('quote required')

  const options = shipping.body.options as Array<{ methodCode: string; optionHash: string; optionIndex: number }>
  const pickup = options.find((option) => option.methodCode === 'pickup')!
  return {
    cartId: created.cartId,
    expectedVersion: quote.quote.cartVersion,
    optionHash: pickup.optionHash,
    quoteId: quote.quote.quoteId,
    shippingQuoteId: shipping.body.shippingQuoteId as string,
    selectedOptionIndex: pickup.optionIndex,
    token: created.token
  }
}

async function currentVersion(database: Awaited<ReturnType<typeof world>>['database'], cartId: string) {
  const row = await database.prepare('SELECT version AS v FROM carts WHERE id = ?').first<{ v: number }>(cartId)
  return row?.v ?? 1
}

function checkoutInput(ctx: CheckoutContext, overrides: Partial<PlaceOrderInput> = {}): PlaceOrderInput {
  return {
    billingAddress: undefined,
    cartId: ctx.cartId,
    consentPrivacy: true,
    consentTos: true,
    contactEmail: 'comprador@ejemplo.es',
    correlationId: 'audit',
    expectedVersion: ctx.expectedVersion,
    idempotencyKey: 'k-checkout',
    now: NOW,
    quoteId: ctx.quoteId,
    selectedOptionHash: ctx.optionHash,
    selectedOptionIndex: ctx.selectedOptionIndex,
    shippingAddress: {
      city: 'Ontinyent',
      countryCode: 'ES',
      line1: 'Carrer Major 1',
      phone: '+34 600 000 000',
      postalCode: '46870',
      province: 'València',
      recipientName: 'Compra Test'
    },
    shippingQuoteId: ctx.shippingQuoteId,
    token: ctx.token,
    ...overrides
  }
}

describe('checkout acceptance saga', () => {
  it('prices shipping rates from net plus VAT and replays the exact response', async () => {
    const { database } = await world()
    const created = await createCart(database, { correlationId: 't', now: NOW })
    await setCartLine(database, {
      cartId: created.cartId,
      correlationId: 't',
      expectedVersion: 1,
      idempotencyKey: 'shipping-add',
      now: NOW,
      quantity: 1,
      token: created.token,
      variantId: UUID_A
    })
    const input = {
      cartId: created.cartId,
      correlationId: 't',
      destination: { city: 'València', postalCode: '46001' },
      expectedVersion: 2,
      idempotencyKey: 'shipping-options-exact',
      now: NOW,
      token: created.token
    }
    const first = await requestShippingOptions(database, input)
    expect(first.outcome).toBe('options')
    if (first.outcome !== 'options') throw new Error('options required')
    const options = first.body.options as Array<{
      methodCode: string
      netCents: number
      taxCents: number
      grossCents: number
    }>
    expect(options).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ methodCode: 'pickup', netCents: 0, taxCents: 0, grossCents: 0 }),
        expect.objectContaining({ methodCode: 'parcel', netCents: 495, taxCents: 104, grossCents: 599 })
      ])
    )
    await expect(requestShippingOptions(database, input)).resolves.toEqual(first)
    await expect(requestShippingOptions(database, { ...input, expectedVersion: 3 })).rejects.toMatchObject({
      code: 'conflict'
    })
  })

  it('rejects mutation of both checkout and shipping snapshots at the schema boundary', async () => {
    const { database, sqlite } = await world()
    const ctx = await buildCheckout(database)
    expect(() =>
      sqlite.prepare('UPDATE checkout_quotes SET total_gross_cents = 1 WHERE id = ?').run(ctx.quoteId)
    ).toThrow('immutable')
    expect(() => sqlite.prepare('DELETE FROM shipping_quotes WHERE id = ?').run(ctx.shippingQuoteId)).toThrow(
      'immutable'
    )
  })

  it('creates exactly one awaiting_payment order with reservation and converted cart', async () => {
    const { database, sqlite } = await world()
    const ctx = await buildCheckout(database)
    const result = await placeOrder(database, checkoutInput(ctx))
    expect(result.outcome).toBe('order_created')

    const orderRow = sqlite.prepare('SELECT * FROM orders LIMIT 1').get() as Record<string, unknown>
    expect(orderRow.status).toBe('awaiting_payment')
    expect(orderRow.currency).toBe('EUR')
    expect(Number(orderRow.total_gross_cents)).toBeGreaterThan(0)
    expect(Number(orderRow.shipping_gross_cents)).toBe(0)
    expect(Number(orderRow.total_net_cents) + Number(orderRow.total_tax_cents)).toBe(Number(orderRow.total_gross_cents))
    expect(orderRow.contact_email).toBe('comprador@ejemplo.es')
    expect((sqlite.prepare('SELECT count(*) AS c FROM order_lines').get() as { c: number }).c).toBe(1)
    expect(
      (
        sqlite.prepare("SELECT count(*) AS c FROM inventory_reservations WHERE status='reserved'").get() as {
          c: number
        }
      ).c
    ).toBe(1)
    const cartStatus = (sqlite.prepare('SELECT status FROM carts WHERE id = ?').get(ctx.cartId) as { status: string })
      .status
    expect(cartStatus).toBe('converted')

    const replayed = await placeOrder(database, checkoutInput(ctx))
    if (result.outcome !== 'order_created') throw new Error('expected created body')
    expect(replayed).toEqual(result)
    expect(result.body.orderToken).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(sqlite.prepare('SELECT * FROM checkout_commands').all())).not.toContain(
      result.body.orderToken as string
    )
  })

  it('never serves a replay to a wrong token; keys stay isolated per cart', async () => {
    const { database, sqlite } = await world()
    const ctxA = await buildCheckout(database)
    const accepted = await placeOrder(database, checkoutInput(ctxA))
    expect(accepted.outcome).toBe('order_created')
    const commandsBefore = 1

    try {
      await placeOrder(database, checkoutInput(ctxA, { token: 'token-equivocado-token-equivocado-token-e' }))
      throw new Error('should have failed')
    } catch (error) {
      expect((error as { code?: string }).code).toBe('unauthorized')
    }
    const commandsAfterBadToken = (
      sqlite.prepare('SELECT count(*) AS c FROM checkout_commands WHERE command_id=?').get('k-checkout') as {
        c: number
      }
    ).c
    expect(commandsAfterBadToken).toBe(commandsBefore)

    // Same key on another cart is fully independent.
    const ctxB = await buildCheckout(database)
    const independent = await placeOrder(database, checkoutInput(ctxB, { idempotencyKey: 'k-checkout' }))
    expect(independent.outcome).toBe('order_created')
  })

  it('returns revalidation_required when the governed price moves, with zero effects', async () => {
    const { database, sqlite } = await world()
    const ctx = await buildCheckout(database)
    sqlite
      .prepare(
        `INSERT INTO variant_price_versions (
           id, variant_id, gross_cents, volume_tiers, valid_from, status, reason, created_at
         ) VALUES ('pv-move', '${UUID_A}', 999, '[]', '${NOW}', 'approved', 'Subida inmediata', '${NOW}')`
      )
      .run()
    const result = await placeOrder(database, checkoutInput(ctx))
    expect(result.outcome).toBe('revalidation_required')
    if (result.outcome === 'revalidation_required') {
      expect(result.reason).toContain('pricing')
      expect(result.freshQuote?.lines.find((line) => line.variantId === UUID_A)?.unitGrossCents).toBe(999)
    }
    expect((sqlite.prepare('SELECT count(*) AS c FROM orders').get() as { c: number }).c).toBe(0)
    expect((sqlite.prepare('SELECT count(*) AS c FROM inventory_reservations').get() as { c: number }).c).toBe(0)
    expect((sqlite.prepare('SELECT status FROM carts WHERE id = ?').get(ctx.cartId) as { status: string }).status).toBe(
      'active'
    )
  })

  it('recovers the saga after failing between reservation and order creation', async () => {
    const { database, sqlite } = await world()
    const ctx = await buildCheckout(database)
    sqlite.exec(`
      CREATE TRIGGER abort_order_lines BEFORE INSERT ON order_lines
      BEGIN
        SELECT RAISE(ABORT, 'simulated crash after reservation');
      END;
    `)
    await expect(placeOrder(database, checkoutInput(ctx))).rejects.toThrow()

    const attempt = sqlite
      .prepare("SELECT id, reservation_id FROM checkout_attempts WHERE state = 'reserved' LIMIT 1")
      .get() as { id: string; reservation_id: string }
    expect(attempt.reservation_id).toBeTruthy()
    const reservedBefore = (
      sqlite.prepare("SELECT count(*) AS c FROM inventory_reservations WHERE status='reserved'").get() as { c: number }
    ).c

    sqlite.exec('DROP TRIGGER abort_order_lines')
    const retry = await placeOrder(database, checkoutInput(ctx))
    expect(retry.outcome).toBe('order_created')
    expect((sqlite.prepare('SELECT count(*) AS c FROM orders').get() as { c: number }).c).toBe(1)
    expect(
      (
        sqlite.prepare("SELECT count(*) AS c FROM inventory_reservations WHERE status='reserved'").get() as {
          c: number
        }
      ).c
    ).toBe(reservedBefore)
  })

  it('recovers a lost response after inventory committed but before the attempt was marked reserved', async () => {
    const { database, sqlite } = await world()
    const ctx = await buildCheckout(database)
    let loseFirstResponse = true
    const gateway = {
      release: (input: Parameters<typeof releaseReservation>[1]) => releaseReservation(database, input),
      reserve: async (input: Parameters<typeof reserveInventory>[1]) => {
        const result = await reserveInventory(database, input)
        if (loseFirstResponse) {
          loseFirstResponse = false
          throw new Error('simulated lost inventory response')
        }
        return result
      }
    }

    await expect(placeOrder(database, checkoutInput(ctx), gateway)).rejects.toThrow('inventory reservation failed')
    expect((sqlite.prepare('SELECT state FROM checkout_attempts LIMIT 1').get() as { state: string }).state).toBe(
      'reserving'
    )
    expect((sqlite.prepare('SELECT count(*) AS c FROM inventory_reservations').get() as { c: number }).c).toBe(1)

    const retried = await placeOrder(database, checkoutInput(ctx), gateway)
    expect(retried.outcome).toBe('order_created')
    expect((sqlite.prepare('SELECT count(*) AS c FROM inventory_reservations').get() as { c: number }).c).toBe(1)
    expect((sqlite.prepare('SELECT state FROM checkout_attempts LIMIT 1').get() as { state: string }).state).toBe(
      'completed'
    )
  })

  it('does not turn an inventory outage into out_of_stock or a terminal failed attempt', async () => {
    const { database, sqlite } = await world()
    const ctx = await buildCheckout(database)
    const unavailableGateway = {
      release: async () => {
        throw new Error('unavailable')
      },
      reserve: async () => {
        throw new Error('unavailable')
      }
    }
    await expect(placeOrder(database, checkoutInput(ctx), unavailableGateway)).rejects.toThrow(
      'inventory reservation failed'
    )
    expect((sqlite.prepare('SELECT state FROM checkout_attempts LIMIT 1').get() as { state: string }).state).toBe(
      'reserving'
    )
    expect((sqlite.prepare('SELECT count(*) AS c FROM orders').get() as { c: number }).c).toBe(0)
  })

  it('releases a reservation whose successful response was lost when the reserving attempt is abandoned', async () => {
    const { database, sqlite } = await world()
    const ctx = await buildCheckout(database)
    const gateway = {
      release: (input: Parameters<typeof releaseReservation>[1]) => releaseReservation(database, input),
      reserve: async (input: Parameters<typeof reserveInventory>[1]) => {
        await reserveInventory(database, input)
        throw new Error('lost response')
      }
    }
    await expect(placeOrder(database, checkoutInput(ctx), gateway)).rejects.toThrow()
    const earlySweep = await compensateStaleAttempts(database, { at: '2026-08-25T09:06:00Z' })
    expect(earlySweep.compensatedCount).toBe(0)
    const sweep = await compensateStaleAttempts(database, { at: '2026-08-25T09:31:00Z' })
    expect(sweep.compensatedCount).toBe(1)
    expect(
      (sqlite.prepare('SELECT status FROM inventory_reservations LIMIT 1').get() as { status: string }).status
    ).toBe('released')
    expect((sqlite.prepare('SELECT state FROM checkout_attempts LIMIT 1').get() as { state: string }).state).toBe(
      'compensated'
    )
  })

  it('binds idempotency to every contractual field', async () => {
    const { database } = await world()
    const ctx = await buildCheckout(database)
    const accepted = await placeOrder(database, checkoutInput(ctx))
    expect(accepted.outcome).toBe('order_created')
    await expect(
      placeOrder(
        database,
        checkoutInput(ctx, {
          shippingAddress: { ...checkoutInput(ctx).shippingAddress, line1: 'Otra dirección 99' }
        })
      )
    ).rejects.toMatchObject({ code: 'conflict' })
  })

  it('routes checkout inventory through the coordinator gateway and never caches the order token in the cart DO', async () => {
    const { database } = await world()
    const ctx = await buildCheckout(database)
    const reserve = vi.fn((input: Parameters<typeof reserveInventory>[1]) => reserveInventory(database, input))
    const putResponse = vi.fn(async () => undefined)
    const outcome = await handleCartCommand(
      {
        cartId: ctx.cartId,
        commandId: 'k-checkout',
        payload: checkoutInput(ctx),
        type: 'checkout'
      },
      {
        database,
        getResponse: async () => undefined,
        inventory: {
          release: (input) => releaseReservation(database, input),
          reserve
        },
        putResponse,
        setAlarm: async () => undefined
      }
    )
    expect(outcome.status).toBe(200)
    expect(reserve).toHaveBeenCalledOnce()
    expect(putResponse).not.toHaveBeenCalled()
    expect((outcome.body.body as Record<string, unknown>).orderToken).toMatch(/^[0-9a-f]{64}$/)
  })

  it('compensates stale attempts once and never releases finished orders', async () => {
    const { database, sqlite } = await world()
    const ctx = await buildCheckout(database)
    const created = await placeOrder(database, checkoutInput(ctx))
    expect(created.outcome).toBe('order_created')
    const attempt = sqlite
      .prepare("SELECT id, reservation_id FROM checkout_attempts WHERE state='completed'")
      .get() as { id: string; reservation_id: string }

    const compensation = await compensateStaleAttempts(database, { at: '2026-09-01T00:00:00Z' })
    expect(compensation.compensatedCount).toBe(0)
    const reservationStillThere = sqlite
      .prepare('SELECT status FROM inventory_reservations WHERE id = ?')
      .get(attempt.reservation_id) as { status: string }
    expect(reservationStillThere.status).toBe('reserved')

    sqlite.exec(`
      INSERT INTO checkout_attempts (
        id, cart_id, command_key, state, reservation_id, reservation_expires_at,
        reservation_lines_json, correlation_id, payload_hash, created_at, updated_at
      ) VALUES ('att-stale', '${ctx.cartId}', 'k-stale-attempt', 'reserving', NULL,
                '2026-08-20T00:30:00Z', '[]', 'audit', '${'a'.repeat(64)}',
                '2026-08-20T00:00:00Z', '2026-08-20T00:00:00Z');
    `)
    const firstSweep = await compensateStaleAttempts(database, { at: '2026-09-01T00:00:00Z' })
    expect(firstSweep.compensatedCount).toBeGreaterThanOrEqual(1)
    const secondSweep = await compensateStaleAttempts(database, { at: '2026-09-01T00:00:00Z' })
    expect(secondSweep.compensatedCount).toBe(0)
  })

  it('guest lookup is uniform for wrong token or unknown order; hostile input rejected', async () => {
    const { database } = await world()
    const ctx = await buildCheckout(database)
    const created = await placeOrder(database, checkoutInput(ctx))
    if (created.outcome !== 'order_created') throw new Error('expected order')
    const orderId = created.body.id as string
    const orderToken = created.body.orderToken as string

    await expect(getOrderView(database, { orderId, token: orderToken })).resolves.toMatchObject({ id: orderId })

    await expect(getOrderView(database, { orderId, token: ctx.token.replaceAll(/./g, 'x') })).resolves.toBeNull()
    await expect(
      getOrderView(database, { orderId: '00000000-0000-4000-8000-000000000000', token: ctx.token })
    ).resolves.toBeNull()

    await expect(
      placeOrder(database, checkoutInput(ctx, { contactEmail: 'no-es-un-email', consentPrivacy: false }))
    ).rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('fails all-or-nothing when no single location covers a whole line', async () => {
    const { database, sqlite } = await world()
    // Split stock for UUID_B across two locations: the total covers the line,
    // but no single location does — the saga must refuse instead of overselling.
    sqlite.exec(`
      INSERT INTO inventory_locations (id, code, name, kind, active, created_at)
      VALUES ('loc-norte', 'ALM-NORTE', 'Norte', 'warehouse', 1, '${NOW}');
      INSERT INTO inventory_balances (
        variant_id, location_id, physical_quantity, blocked_quantity, version, created_at, updated_at
      ) VALUES ('${UUID_B}', 'loc-norte', 15, 0, 1, '${NOW}', '${NOW}');
      UPDATE inventory_balances SET physical_quantity = 10
        WHERE variant_id = '${UUID_B}' AND location_id = 'loc-main';
    `)

    const created = await createCart(database, { correlationId: 't', now: NOW })
    const add = await setCartLine(database, {
      cartId: created.cartId,
      correlationId: 't',
      expectedVersion: 1,
      idempotencyKey: 'k-split-add',
      now: NOW,
      quantity: 25,
      token: created.token,
      variantId: UUID_B
    })
    expect(add.outcome).toBe('applied')

    const shipping = await requestShippingOptions(database, {
      cartId: created.cartId,
      correlationId: 't',
      destination: { city: 'Ontinyent', postalCode: '46870' },
      expectedVersion: 2,
      idempotencyKey: 'k-split-ship',
      now: NOW,
      token: created.token
    })
    if (shipping.outcome !== 'options') throw new Error(`shipping options: ${JSON.stringify(shipping)}`)
    const quote = await quoteCart(database, {
      cartId: created.cartId,
      correlationId: 't',
      expectedVersion: 2,
      idempotencyKey: 'k-split-quote',
      now: NOW,
      token: created.token
    })
    if (quote.outcome !== 'quoted') throw new Error('quote required')

    const ctx: CheckoutContext = {
      cartId: created.cartId,
      expectedVersion: quote.quote.cartVersion,
      optionHash: (shipping.body.options as Array<{ optionHash: string }>)[0]!.optionHash,
      quoteId: quote.quote.quoteId,
      shippingQuoteId: shipping.body.shippingQuoteId as string,
      selectedOptionIndex: 0,
      token: created.token
    }
    const result = await placeOrder(database, checkoutInput(ctx))
    expect(result.outcome).toBe('out_of_stock')
    if (result.outcome === 'out_of_stock') expect(result.detail).toContain('location')
    expect((sqlite.prepare('SELECT count(*) AS c FROM orders').get() as { c: number }).c).toBe(0)
    expect((sqlite.prepare('SELECT count(*) AS c FROM inventory_reservations').get() as { c: number }).c).toBe(0)
  })
})

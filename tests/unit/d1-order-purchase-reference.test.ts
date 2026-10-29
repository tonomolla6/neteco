import { afterEach, describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { returnsFixture, BUYER_CLAIMS, utc } from './d1-returns-fixture'
import { createCart, quoteCart, setCartLine } from '../../workers/catalog/cart'
import {
  getCustomerOwnedOrderView,
  getOrderView,
  placeOrder,
  requestShippingOptions,
  type PlaceOrderInput
} from '../../workers/catalog/checkout'
import { handleCartCommand } from '../../workers/cart-coordinator'
import { readOrderPurchaseOrderReference } from '../../workers/catalog/order-customer-reference'

let fixture: Awaited<ReturnType<typeof returnsFixture>> | undefined
afterEach(() => fixture?.sqlite.close())

async function prepare(migrated = true) {
  fixture = await returnsFixture()
  if (migrated)
    fixture.sqlite.exec(
      await readFile(new URL('../../db/d1/migrations/0074_order_purchase_reference.sql', import.meta.url), 'utf8')
    )
  const { database } = fixture,
    now = utc()
  const cart = await createCart(database, { correlationId: 'purchase-reference', now })
  await setCartLine(database, {
    cartId: cart.cartId,
    token: cart.token,
    expectedVersion: 1,
    variantId: 'v-1-1',
    quantity: 2,
    idempotencyKey: 'add',
    correlationId: 'purchase-reference',
    now
  })
  const shipping = await requestShippingOptions(database, {
    cartId: cart.cartId,
    token: cart.token,
    expectedVersion: 2,
    destination: { city: 'Ontinyent', postalCode: '46870' },
    idempotencyKey: 'shipping',
    correlationId: 'purchase-reference',
    now
  })
  const quote = await quoteCart(database, {
    cartId: cart.cartId,
    token: cart.token,
    expectedVersion: 2,
    idempotencyKey: 'quote',
    correlationId: 'purchase-reference',
    now
  })
  if (shipping.outcome !== 'options' || quote.outcome !== 'quoted') throw new Error('fixture_quote_failed')
  const selected = (
    shipping.body.options as Array<{ methodCode: string; optionIndex: number; optionHash: string }>
  ).find((option) => option.methodCode === 'pickup')!
  const input: PlaceOrderInput = {
    cartId: cart.cartId,
    token: cart.token,
    expectedVersion: 2,
    quoteId: quote.quote.quoteId,
    shippingQuoteId: shipping.body.shippingQuoteId as string,
    selectedOptionIndex: selected.optionIndex,
    selectedOptionHash: selected.optionHash,
    contactEmail: 'synthetic@example.invalid',
    shippingAddress: {
      recipientName: 'Synthetic buyer',
      line1: 'Carrer Major 1',
      city: 'Ontinyent',
      province: 'Valencia',
      postalCode: '46870',
      phone: '+34600111222'
    },
    consentTos: true,
    consentPrivacy: true,
    idempotencyKey: 'checkout',
    correlationId: 'purchase-reference',
    now
  }
  return { ...fixture, input }
}

describe('optional contractual purchase order reference', () => {
  function interleaveReferenceRead(database: D1Database, change: () => void): D1Database {
    return new Proxy(database, {
      get(target, key) {
        if (key === 'prepare')
          return (sql: string) => {
            const statement = target.prepare(sql)
            if (sql !== 'SELECT * FROM orders WHERE id = ?1') return statement
            return new Proxy(statement, {
              get(prepared, field) {
                if (field === 'bind')
                  return (...values: unknown[]) => {
                    const bound = prepared.bind(...values)
                    return new Proxy(bound, {
                      get(selected, method) {
                        if (method === 'first')
                          return async () => {
                            const row = await selected.first()
                            change()
                            return row
                          }
                        const value = Reflect.get(selected, method)
                        return typeof value === 'function' ? value.bind(selected) : value
                      }
                    })
                  }
                const value = Reflect.get(prepared, field)
                return typeof value === 'function' ? value.bind(prepared) : value
              }
            })
          }
        const value = Reflect.get(target, key)
        return typeof value === 'function' ? value.bind(target) : value
      }
    })
  }
  it('does not release a bearer snapshot revoked during the private PO read', async () => {
    const { database, sqlite, input } = await prepare()
    const result = await placeOrder(database, { ...input, purchaseOrderReference: 'PO-PRIVATE' })
    if (result.outcome !== 'order_created') throw new Error('fixture_order_failed')
    const id = result.body.id as string
    const interleaved = interleaveReferenceRead(database, () =>
      sqlite.prepare('UPDATE orders SET access_revoked_at=? WHERE id=?').run(utc(), id)
    )
    expect(
      await getOrderView(interleaved, { orderId: id, token: result.body.orderToken as string, now: input.now })
    ).toBeNull()
  })
  it('does not release a customer snapshot after session revocation during the private PO read', async () => {
    const { database, sqlite, input } = await prepare()
    const result = await placeOrder(database, {
      ...input,
      ownerSession: BUYER_CLAIMS,
      purchaseOrderReference: 'PO-PRIVATE'
    })
    if (result.outcome !== 'order_created') throw new Error('fixture_order_failed')
    const interleaved = interleaveReferenceRead(database, () =>
      sqlite.prepare('UPDATE auth_sessions SET revoked_at=? WHERE id=?').run(utc(), BUYER_CLAIMS.sessionId)
    )
    expect(
      await getCustomerOwnedOrderView(interleaved, {
        orderId: result.body.id as string,
        claims: BUYER_CLAIMS,
        now: input.now
      })
    ).toBeNull()
  })
  it('normalizes NFC and trims the PO into the committed response and owned snapshot', async () => {
    const { database, input } = await prepare()
    const result = await placeOrder(database, { ...input, purchaseOrderReference: '  PO-Cafe\u0301 / 42  ' })
    expect(result.outcome).toBe('order_created')
    if (result.outcome !== 'order_created') throw new Error('fixture_order_failed')
    expect(result.body.purchaseOrderReference).toBe('PO-Café / 42')
    expect(
      await getOrderView(database, {
        orderId: result.body.id as string,
        token: result.body.orderToken as string,
        now: input.now
      })
    ).toMatchObject({ purchaseOrderReference: 'PO-Café / 42' })
  })
  it('replays the same normalized PO but rejects a changed PO without another order or reservation', async () => {
    const { database, sqlite, input } = await prepare()
    const first = await placeOrder(database, { ...input, purchaseOrderReference: ' PO-42 ' })
    expect(await placeOrder(database, { ...input, purchaseOrderReference: 'PO-42' })).toEqual(first)
    await expect(placeOrder(database, { ...input, purchaseOrderReference: 'PO-43' })).rejects.toMatchObject({
      code: 'conflict'
    })
    expect(sqlite.prepare('SELECT count(*) AS n FROM orders').get()?.n).toBe(1)
    expect(sqlite.prepare('SELECT count(*) AS n FROM inventory_reservations').get()?.n).toBe(1)
  })
  it.each([17, null, {}, 'A'.repeat(121), 'PO\n42', 'PO\r42', 'PO\t42', 'PO\u000042', 'PO\u202842'])(
    'rejects invalid PO input %j before any attempt or reservation',
    async (value) => {
      const { database, sqlite, input } = await prepare()
      Reflect.set(input, 'purchaseOrderReference', value)
      await expect(placeOrder(database, input)).rejects.toMatchObject({ code: 'invalid_input' })
      expect(sqlite.prepare('SELECT count(*) AS n FROM checkout_attempts').get()?.n).toBe(0)
      expect(sqlite.prepare('SELECT count(*) AS n FROM inventory_reservations').get()?.n).toBe(0)
    }
  )
  it('passes a PO through the actual cart coordinator checkout parser', async () => {
    const { database, input } = await prepare()
    const response = await handleCartCommand(
      {
        type: 'checkout',
        cartId: input.cartId,
        commandId: input.idempotencyKey,
        payload: { ...input, purchaseOrderReference: 'PO-COORDINATOR' }
      },
      {
        database,
        getResponse: async () => undefined,
        putResponse: async () => undefined,
        setAlarm: async () => undefined
      }
    )
    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({
      outcome: 'order_created',
      body: { purchaseOrderReference: 'PO-COORDINATOR' }
    })
  })
  it('preserves legacy payload and receipt for omitted versus empty PO on a 0062 database', async () => {
    const { database, sqlite, input } = await prepare(false)
    expect(
      sqlite
        .prepare('PRAGMA table_info(orders)')
        .all()
        .some((row) => row.name === 'purchase_order_reference')
    ).toBe(false)
    const first = await placeOrder(database, input)
    expect(first.outcome).toBe('order_created')
    if (first.outcome !== 'order_created') throw new Error('fixture_order_failed')
    expect(first.body).not.toHaveProperty('purchaseOrderReference')
    expect(await placeOrder(database, { ...input, purchaseOrderReference: '   ' })).toEqual(first)
    expect(await placeOrder(database, { ...input, purchaseOrderReference: '' })).toEqual(first)
    expect(await readOrderPurchaseOrderReference(database, first.body.id as string)).toBeNull()
    expect(
      await getOrderView(database, {
        orderId: first.body.id as string,
        token: first.body.orderToken as string,
        now: input.now
      })
    ).not.toHaveProperty('purchaseOrderReference')
  })
  it('preserves populated historical contracts when the append-only migration is applied', async () => {
    const { database, sqlite, input } = await prepare(false)
    const first = await placeOrder(database, input)
    if (first.outcome !== 'order_created') throw new Error('fixture_order_failed')
    const before = sqlite.prepare('SELECT * FROM orders').all(),
      lines = sqlite.prepare('SELECT * FROM order_lines').all()
    sqlite.exec(
      await readFile(new URL('../../db/d1/migrations/0074_order_purchase_reference.sql', import.meta.url), 'utf8')
    )
    expect(sqlite.prepare('SELECT * FROM orders').all()).toEqual(
      before.map((row) => ({ ...row, purchase_order_reference: null }))
    )
    expect(sqlite.prepare('SELECT * FROM order_lines').all()).toEqual(lines)
    expect(sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    expect(await placeOrder(database, { ...input, purchaseOrderReference: '' })).toEqual(first)
    expect(await readOrderPurchaseOrderReference(database, first.body.id as string)).toBeNull()
  })
  it('forbids changing, deleting or replacing the PO snapshot, even without recursive delete triggers', async () => {
    const { database, sqlite, input } = await prepare()
    const first = await placeOrder(database, { ...input, purchaseOrderReference: 'PO-IMMUTABLE' })
    if (first.outcome !== 'order_created') throw new Error('fixture_order_failed')
    const id = first.body.id as string
    expect(() => sqlite.prepare('UPDATE orders SET purchase_order_reference=? WHERE id=?').run('PO-OTHER', id)).toThrow(
      'order_purchase_reference_immutable'
    )
    expect(() => sqlite.prepare('DELETE FROM orders WHERE id=?').run(id)).toThrow('order_purchase_reference_immutable')
    sqlite.exec('PRAGMA recursive_triggers=OFF')
    expect(() => sqlite.prepare('INSERT OR REPLACE INTO orders SELECT * FROM orders WHERE id=?').run(id)).toThrow(
      'order_purchase_reference_immutable'
    )
    expect(await readOrderPurchaseOrderReference(database, id)).toBe('PO-IMMUTABLE')
  })
})

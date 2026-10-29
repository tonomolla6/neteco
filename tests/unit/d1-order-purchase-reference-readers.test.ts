import { afterEach, expect, it, vi } from 'vitest'
import { readdir, readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { fulfillmentFixture, CLAIMS, SESSION, utc } from './d1-fulfillment-fixture'
import { splitDemoSql } from '../../scripts/lib/d1-demo-sql'
import { createCart, quoteCart, setCartLine } from '../../workers/catalog/cart'
import { placeOrder, requestShippingOptions } from '../../workers/catalog/checkout'
import { readD1AdminOrder } from '../../workers/catalog/admin-orders'
import { readD1AdminFulfillment } from '../../workers/fulfillment/admin'

// Real checkout facts, private readers, historical compatibility and final
// authority: neither reference enrichment nor a failed read may mutate orders.
const opened: DatabaseSync[] = []
afterEach(() => {
  opened.splice(0).forEach((db) => db.close())
  vi.restoreAllMocks()
})
async function fixture(current = true) {
  const f = await fulfillmentFixture()
  opened.push(f.sqlite)
  if (current) {
    const directory = new URL('../../db/d1/migrations/', import.meta.url)
    for (const file of (await readdir(directory))
      .filter((name) => /^\d{4}_.*\.sql$/.test(name) && Number(name.slice(0, 4)) > 62 && Number(name.slice(0, 4)) <= 74)
      .sort()) {
      await f.database.batch(
        splitDemoSql(await readFile(new URL(file, directory), 'utf8')).map((sql) => f.database.prepare(sql))
      )
    }
  }
  return f
}
async function checkout(db: D1Database, reference: string | null) {
  const now = utc(),
    cart = await createCart(db, { correlationId: 'po-readers', now })
  await setCartLine(db, {
    cartId: cart.cartId,
    token: cart.token,
    variantId: 'v-1-1',
    quantity: 2,
    expectedVersion: 1,
    idempotencyKey: 'line',
    correlationId: 'po-readers',
    now
  })
  const shipping = await requestShippingOptions(db, {
    cartId: cart.cartId,
    token: cart.token,
    expectedVersion: 2,
    idempotencyKey: 'shipping',
    correlationId: 'po-readers',
    destination: { city: 'Ontinyent', postalCode: '46870' },
    now
  })
  if (shipping.outcome !== 'options') throw Error(shipping.outcome)
  const option = (shipping.body.options as Array<{ optionIndex: number; optionHash: string; methodCode: string }>).find(
    (item) => item.methodCode === 'pickup'
  )!
  const quote = await quoteCart(db, {
    cartId: cart.cartId,
    token: cart.token,
    expectedVersion: 2,
    idempotencyKey: 'quote',
    correlationId: 'po-readers',
    now
  })
  if (quote.outcome !== 'quoted') throw Error(quote.outcome)
  const address = {
    recipientName: 'Synthetic buyer',
    line1: 'Synthetic street 1',
    city: 'Ontinyent',
    province: 'València',
    postalCode: '46870',
    countryCode: 'ES',
    phone: '+34600111222'
  }
  const input = {
    cartId: cart.cartId,
    token: cart.token,
    expectedVersion: 2,
    quoteId: quote.quote.quoteId,
    shippingQuoteId: shipping.body.shippingQuoteId as string,
    selectedOptionIndex: option.optionIndex,
    selectedOptionHash: option.optionHash,
    contactEmail: 'buyer@example.invalid',
    contactName: 'Synthetic buyer',
    contactPhone: '+34600111222',
    shippingAddress: address,
    billingAddress: address,
    consentTos: true,
    consentPrivacy: true,
    idempotencyKey: 'checkout',
    correlationId: 'po-readers',
    purchaseOrderReference: reference,
    now
  }
  const result = await placeOrder(db, input)
  if (result.outcome !== 'order_created') throw Error(result.outcome)
  return (result.body as { id: string }).id
}
const snapshot = (db: DatabaseSync) =>
  [
    'orders',
    'order_lines',
    'inventory_balances',
    'inventory_movements',
    'auth_sessions',
    'order_fulfillment_commands'
  ].map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())
const readers = [
  {
    name: 'order detail',
    read: (db: D1Database, id: string) => readD1AdminOrder(db, CLAIMS, utc(), id),
    expected: (reference: string | null) => ({
      outcome: 'found',
      data: { order: { purchaseOrderReference: reference } }
    })
  },
  {
    name: 'fulfillment',
    read: (db: D1Database, id: string) => readD1AdminFulfillment(db, CLAIMS, id, { page: 1, perPage: 20 }),
    expected: (reference: string | null) => ({ purchaseOrderReference: reference })
  }
]
for (const reader of readers) {
  it(`${reader.name} exposes only the confirmed checkout PO without writes`, async () => {
    const f = await fixture(),
      id = await checkout(f.database, '  PO-Cafe\u0301-42  '),
      before = snapshot(f.sqlite)
    expect(await reader.read(f.database, id)).toMatchObject(reader.expected('PO-Café-42'))
    expect(snapshot(f.sqlite)).toEqual(before)
  })
  it(`${reader.name} preserves historical 0062 orders as null, not an unavailable read`, async () => {
    const f = await fixture(false),
      id = await f.order('pickup', false)
    expect(await reader.read(f.database, id)).toMatchObject(reader.expected(null))
  })
  it(`${reader.name} never turns a D1 reference outage into null`, async () => {
    const f = await fixture(),
      id = await checkout(f.database, 'PO-42')
    const prepare = f.database.prepare.bind(f.database)
    vi.spyOn(f.database, 'prepare').mockImplementation((sql) => {
      if (/SELECT\s+\*\s+FROM\s+orders\b/i.test(sql)) throw Error('synthetic_reference_outage')
      return prepare(sql)
    })
    await expect(reader.read(f.database, id)).rejects.toThrow('synthetic_reference_outage')
  })
  it(`${reader.name} rechecks live session after the private reference read`, async () => {
    const f = await fixture(),
      id = await checkout(f.database, 'PO-42')
    const prepare = f.database.prepare.bind(f.database)
    vi.spyOn(f.database, 'prepare').mockImplementation((sql) => {
      const statement = prepare(sql)
      if (/SELECT\s+\*\s+FROM\s+orders\b/i.test(sql)) {
        const bind = statement.bind.bind(statement)
        statement.bind = (...values) => {
          const bound = bind(...values),
            first = bound.first.bind(bound)
          bound.first = async <T>() => {
            const result = await first<T>()
            f.sqlite.prepare('UPDATE auth_sessions SET revoked_at=? WHERE id=?').run(utc(), SESSION)
            return result
          }
          return bound
        }
      }
      return statement
    })
    if (reader.name === 'order detail') expect(await reader.read(f.database, id)).toMatchObject({ outcome: 'denied' })
    else await expect(reader.read(f.database, id)).rejects.toMatchObject({ code: 'unauthenticated' })
  })
  it(`${reader.name} denies an actor without the live admin grant before reading PO`, async () => {
    const f = await fixture(),
      id = await checkout(f.database, 'PO-42')
    f.sqlite.prepare('DELETE FROM identity_roles WHERE identity_id=?').run(CLAIMS.identityId)
    const calls = vi.spyOn(f.database, 'prepare')
    if (reader.name === 'order detail')
      expect(await reader.read(f.database, id)).toMatchObject({ outcome: 'denied', code: 'forbidden' })
    else await expect(reader.read(f.database, id)).rejects.toMatchObject({ code: 'forbidden' })
    expect(calls.mock.calls.some(([sql]) => /SELECT\s+\*\s+FROM\s+orders\b/i.test(sql))).toBe(false)
  })
}

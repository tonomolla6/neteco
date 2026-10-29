import { upsertD1B2BPriceList, assignD1CompanyB2BPriceList } from '../../workers/catalog/b2b-pricing'
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { returnsFixture, CLAIMS, BUYER_CLAIMS, CUSTOMER, utc } from './d1-returns-fixture'
import { createCart, quoteCart, setCartLine } from '../../workers/catalog/cart'
import { placeOrder, requestShippingOptions } from '../../workers/catalog/checkout'

async function world() {
  const f = await returnsFixture()
  try {
    f.sqlite.exec(await readFile('db/d1/migrations/0101_b2b_price_lists_credit.sql', 'utf8'))
    const now = utc(),
      before = utc(-60000)
    f.sqlite.exec(`
      INSERT INTO companies(id,customer_id,legal_name,status,created_at,updated_at) VALUES('company','${CUSTOMER}','Empresa','approved','${before}','${before}');
    `)
    await upsertD1B2BPriceList(
      f.database,
      CLAIMS,
      {
        priceListId: 'list',
        expectedVersion: 0,
        code: 'LIST',
        name: 'Tarifa',
        status: 'active',
        validFrom: before,
        validUntil: null,
        variantRules: [{ variantId: 'v-1-1', unitGrossCents: 333 }],
        categoryRules: [],
        reason: 'Acuerdo comercial'
      },
      { idempotencyKey: crypto.randomUUID(), now: () => now }
    )
    await assignD1CompanyB2BPriceList(
      f.database,
      CLAIMS,
      'company',
      { priceListId: 'list', expectedVersion: 0, validFrom: before, validUntil: null, reason: 'Acuerdo comercial' },
      { idempotencyKey: crypto.randomUUID(), now: () => now }
    )
    const cart = await createCart(f.database, { correlationId: 'b2b-test', now })
    await setCartLine(f.database, {
      ...cart,
      expectedVersion: 1,
      idempotencyKey: 'add',
      variantId: 'v-1-1',
      quantity: 2,
      correlationId: 'b2b-test',
      now
    })
    const q = await quoteCart(f.database, {
      ...cart,
      expectedVersion: 2,
      idempotencyKey: 'quote',
      correlationId: 'b2b-test',
      now,
      ownerSession: BUYER_CLAIMS
    })
    const shipping = await requestShippingOptions(f.database, {
      ...cart,
      expectedVersion: 2,
      idempotencyKey: 'shipping',
      correlationId: 'b2b-test',
      now,
      destination: { city: 'Ontinyent', postalCode: '46870' }
    })
    if (q.outcome !== 'quoted' || shipping.outcome !== 'options') throw new Error('fixture failed')
    const option = (
      shipping.body.options as Array<{ methodCode: string; optionIndex: number; optionHash: string }>
    ).find((o) => o.methodCode === 'pickup')!
    return {
      ...f,
      quote: q.quote,
      input: {
        ...cart,
        expectedVersion: 2,
        idempotencyKey: 'checkout',
        correlationId: 'b2b-test',
        now,
        ownerSession: BUYER_CLAIMS,
        quoteId: q.quote.quoteId,
        shippingQuoteId: String(shipping.body.shippingQuoteId),
        selectedOptionIndex: option.optionIndex,
        selectedOptionHash: option.optionHash,
        expectedTotalGrossCents: 666,
        contactEmail: 'buyer@example.invalid',
        contactName: 'Buyer',
        contactPhone: '+34600111222',
        shippingAddress: {
          recipientName: 'Buyer',
          line1: 'Carrer Major 1',
          city: 'Ontinyent',
          province: 'Valencia',
          postalCode: '46870',
          phone: '+34600111222'
        },
        consentTos: true as const,
        consentPrivacy: true as const
      }
    }
  } catch (error) {
    f.sqlite.close()
    throw error
  }
}
describe('contractual checkout', () => {
  it('persists the one-cent minimum and tariff version through checkout', async () => {
    const f = await world()
    try {
      f.sqlite.exec("UPDATE variants SET price_gross_cents=1 WHERE id='v-1-1'")
      await upsertD1B2BPriceList(
        f.database,
        CLAIMS,
        {
          priceListId: 'list',
          expectedVersion: 1,
          code: 'LIST',
          name: 'Tarifa',
          status: 'active',
          validFrom: '2026-01-01T00:00:00Z',
          validUntil: null,
          variantRules: [],
          categoryRules: [{ categoryId: 'c1', discountBps: 9500 }],
          reason: 'Acuerdo comercial'
        },
        { idempotencyKey: crypto.randomUUID(), now: () => f.input.now }
      )
      const q = await quoteCart(f.database, { ...f.input, idempotencyKey: 'minimum-quote' })
      expect(q.outcome).toBe('quoted')
      if (q.outcome !== 'quoted') throw new Error(q.outcome)
      const marker = q.quote.lines[0]?.priceVersionId
      expect(q.quote.lines[0]).toMatchObject({ unitGrossCents: 1, grossCents: 2 })
      expect(marker).toMatch(/^b2b:list:v\d+:a1:category:c1:/)
      const result = await placeOrder(f.database, { ...f.input, quoteId: q.quote.quoteId, expectedTotalGrossCents: 2 })
      expect(result.outcome).toBe('order_created')
      if (result.outcome !== 'order_created') throw new Error(result.outcome)
      expect(
        f.sqlite
          .prepare('SELECT unit_gross_cents,price_version_id FROM order_lines WHERE order_id=?')
          .get(String(result.body.id))
      ).toMatchObject({ unit_gross_cents: 1, price_version_id: marker })
    } finally {
      f.sqlite.close()
    }
  })
  it('revalidates and persists the contractual price and version into the order', async () => {
    const f = await world()
    try {
      const result = await placeOrder(f.database, f.input)
      expect(result.outcome).toBe('order_created')
      if (result.outcome !== 'order_created') throw new Error(result.outcome)
      expect(
        f.sqlite
          .prepare('SELECT unit_gross_cents,price_version_id FROM order_lines WHERE order_id=?')
          .get(String(result.body.id))
      ).toMatchObject({ unit_gross_cents: 333, price_version_id: 'b2b:list:v1:a1:variant:v-1-1' })
    } finally {
      f.sqlite.close()
    }
  })
  it('does not honor the tariff after the company is suspended', async () => {
    const f = await world()
    try {
      f.sqlite.exec("UPDATE companies SET status='suspended' WHERE id='company'")
      expect(await placeOrder(f.database, f.input)).toMatchObject({
        outcome: 'revalidation_required',
        reason: 'pricing_or_quantity_changed'
      })
      expect(f.sqlite.prepare('SELECT count(*) n FROM orders').get()).toMatchObject({ n: 0 })
    } finally {
      f.sqlite.close()
    }
  })
  it('does not commit an order when a tariff changes immediately before finalization', async () => {
    const f = await world()
    try {
      let fired = false
      const sql = new WeakMap<object, string>()
      const db = new Proxy(f.database, {
        get(target, key) {
          if (key === 'prepare')
            return (text: string) => {
              const statement = target.prepare(text)
              const bind = statement.bind.bind(statement)
              statement.bind = (...values: unknown[]) => {
                const bound = bind(...values)
                sql.set(bound, text)
                return bound
              }
              sql.set(statement, text)
              return statement
            }
          if (key === 'batch')
            return async (statements: D1PreparedStatement[]) => {
              if (!fired && statements.some((statement) => sql.get(statement)?.includes('INSERT INTO orders'))) {
                fired = true
                await upsertD1B2BPriceList(
                  f.database,
                  CLAIMS,
                  {
                    priceListId: 'list',
                    expectedVersion: 1,
                    code: 'LIST',
                    name: 'Tarifa',
                    status: 'inactive',
                    validFrom: '2026-01-01T00:00:00Z',
                    validUntil: null,
                    variantRules: [{ variantId: 'v-1-1', unitGrossCents: 333 }],
                    categoryRules: [],
                    reason: 'Cambio comercial'
                  },
                  { idempotencyKey: crypto.randomUUID(), now: () => f.input.now }
                )
              }
              return target.batch(statements)
            }
          const value: unknown = Reflect.get(target, key)
          return typeof value === 'function' ? value.bind(target) : value
        }
      })
      await expect(placeOrder(db, f.input)).rejects.toThrow()
      expect(f.sqlite.prepare('SELECT count(*) n FROM orders').get()).toMatchObject({ n: 0 })
    } finally {
      f.sqlite.close()
    }
  })
  it('rejects an order when a rule changes immediately before finalization', async () => {
    const f = await world()
    try {
      let fired = false
      const sql = new WeakMap<object, string>()
      const db = new Proxy(f.database, {
        get(target, key) {
          if (key === 'prepare')
            return (text: string) => {
              const statement = target.prepare(text)
              const bind = statement.bind.bind(statement)
              statement.bind = (...values: unknown[]) => {
                const bound = bind(...values)
                sql.set(bound, text)
                return bound
              }
              sql.set(statement, text)
              return statement
            }
          if (key === 'batch')
            return async (statements: D1PreparedStatement[]) => {
              if (!fired && statements.some((statement) => sql.get(statement)?.includes('INSERT INTO orders'))) {
                fired = true
                await upsertD1B2BPriceList(
                  f.database,
                  CLAIMS,
                  {
                    priceListId: 'list',
                    expectedVersion: 1,
                    code: 'LIST',
                    name: 'Tarifa',
                    status: 'active',
                    validFrom: '2026-01-01T00:00:00Z',
                    validUntil: null,
                    variantRules: [{ variantId: 'v-1-1', unitGrossCents: 444 }],
                    categoryRules: [],
                    reason: 'Cambio comercial'
                  },
                  { idempotencyKey: crypto.randomUUID(), now: () => f.input.now }
                )
              }
              return target.batch(statements)
            }
          const value: unknown = Reflect.get(target, key)
          return typeof value === 'function' ? value.bind(target) : value
        }
      })
      await expect(placeOrder(db, f.input)).rejects.toThrow()
      expect(f.sqlite.prepare('SELECT count(*) n FROM orders').get()).toMatchObject({ n: 0 })
      expect(
        f.sqlite.prepare("SELECT unit_gross_cents FROM b2b_variant_rules WHERE price_list_id='list'").get()
      ).toMatchObject({ unit_gross_cents: 444 })
    } finally {
      f.sqlite.close()
    }
  })
  it('uses the contractual goods total for free shipping thresholds', async () => {
    const f = await world()
    try {
      f.sqlite
        .exec(`INSERT INTO shipping_zones(id,code,name,kind,postal_prefixes,active,created_at) VALUES('parcel-zone','parcel','Parcel','parcel_peninsular','["peninsular"]',1,'${f.input.now}');
        INSERT INTO shipping_rates(id,zone_id,method_code,service_profile,net_cents,tax_rate_basis_points,eta_min_days,eta_max_days,rate_version,active,created_at) VALUES('parcel-rate','parcel-zone','parcel','parcel',500,2100,1,2,1,1,'${f.input.now}')`)
      const result = await requestShippingOptions(f.database, {
        cartId: f.input.cartId,
        token: f.input.token,
        expectedVersion: 2,
        idempotencyKey: 'shipping-private',
        correlationId: 'b2b-test',
        now: f.input.now,
        ownerSession: BUYER_CLAIMS,
        freeShippingThresholdCents: 800,
        destination: { city: 'Ontinyent', postalCode: '46870' }
      })
      expect(result.outcome).toBe('options')
      if (result.outcome !== 'options') throw new Error(result.outcome)
      const parcel = (result.body.options as Array<{ methodCode: string; grossCents: number }>).find(
        (o) => o.methodCode === 'parcel'
      )
      expect(parcel?.grossCents).toBe(605)
      await expect(
        requestShippingOptions(f.database, {
          cartId: f.input.cartId,
          token: f.input.token,
          expectedVersion: 2,
          idempotencyKey: 'shipping-private',
          correlationId: 'b2b-test',
          now: f.input.now,
          freeShippingThresholdCents: 800,
          destination: { city: 'Ontinyent', postalCode: '46870' }
        })
      ).rejects.toMatchObject({ code: 'conflict' })
      f.sqlite.prepare('UPDATE auth_sessions SET revoked_at=? WHERE id=?').run(f.input.now, BUYER_CLAIMS.sessionId)
      await expect(
        requestShippingOptions(f.database, {
          cartId: f.input.cartId,
          token: f.input.token,
          expectedVersion: 2,
          idempotencyKey: 'shipping-private',
          correlationId: 'b2b-test',
          now: f.input.now,
          ownerSession: BUYER_CLAIMS,
          freeShippingThresholdCents: 800,
          destination: { city: 'Ontinyent', postalCode: '46870' }
        })
      ).rejects.toMatchObject({ code: 'unauthorized' })
    } finally {
      f.sqlite.close()
    }
  })
})

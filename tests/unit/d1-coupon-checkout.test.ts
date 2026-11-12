import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { returnsFixture, CLAIMS, BUYER_CLAIMS, CUSTOMER, utc } from './d1-returns-fixture'
import { provisionPromotionFixture } from '../support/promotion-fixture'
import { createCart, quoteCart, setCartLine } from '../../workers/catalog/cart'
import { requestShippingOptions, placeOrder } from '../../workers/catalog/checkout'
import { splitGross } from '../../server/domain/money'
import type { PromotionRule } from '../../shared/promotions'
import { handleCartCommand } from '../../workers/cart-coordinator'
import { promotionRuleHash } from '../../workers/catalog/promotions'
import { readD1AdminOrder } from '../../workers/catalog/admin-orders'
import { testNow, testUuid } from '../support/deterministic'

vi.mock('../support/d1-sqlite', async (importOriginal) => {
  const original = await importOriginal<typeof import('../support/d1-sqlite')>()
  return {
    ...original,
    openMigratedDatabase: async (...args: Parameters<typeof original.openMigratedDatabase>) => {
      const sqlite = await original.openMigratedDatabase(...args)
      sqlite.function('synthetic_coupon_checkout_clock', () => {
        const clock = vi.getMockedSystemTime()
        if (!clock) throw new Error('missing_synthetic_coupon_checkout_clock')
        return clock.toISOString().replace(/\.\d{3}Z$/, 'Z')
      })
      const nativeExec = sqlite.exec.bind(sqlite)
      sqlite.exec = (sql: string) => nativeExec(sql.replaceAll("'now'", 'synthetic_coupon_checkout_clock()'))
      return sqlite
    },
    d1OverSqlite: (sqlite: Parameters<typeof original.d1OverSqlite>[0]) => {
      const database = original.d1OverSqlite(sqlite),
        nativePrepare = database.prepare.bind(database)
      database.prepare = (sql: string) => nativePrepare(sql.replaceAll("'now'", 'synthetic_coupon_checkout_clock()'))
      return database
    }
  }
})
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(testNow() + 1000)
})
afterEach(() => vi.useRealTimers())

const rule = (changes: Partial<PromotionRule> = {}): PromotionRule => ({
  id: testUuid(),
  version: 1,
  code: 'TEST101',
  status: 'active',
  channel: 'online',
  startsAt: utc(-3600000),
  endsAt: utc(3600000),
  benefit: { kind: 'fixed', grossCents: 101 },
  scope: { kind: 'all' },
  segment: 'all',
  totalLimit: null,
  perCustomerLimit: null,
  volumeMode: 'stack_volume',
  ...changes
})

async function cart(database: D1Database) {
  const created = await createCart(database, { correlationId: 'promotion-test', now: utc() })
  await setCartLine(database, {
    ...created,
    variantId: 'v-1-1',
    quantity: 2,
    expectedVersion: 1,
    idempotencyKey: 'add',
    correlationId: 'promotion-test',
    now: utc()
  })
  return { ...created, expectedVersion: 2, correlationId: 'promotion-test' }
}
async function prepare(database: D1Database) {
  const context = await cart(database)
  const quoteInput = {
    ...context,
    idempotencyKey: 'quote',
    now: utc(),
    couponCode: 'TEST101',
    ownerSession: BUYER_CLAIMS
  }
  const quote = await quoteCart(database, quoteInput)
  const shipping = await requestShippingOptions(database, {
    ...context,
    idempotencyKey: 'shipping',
    now: utc(),
    destination: { city: 'Ontinyent', postalCode: '46870' }
  })
  if (quote.outcome !== 'quoted' || shipping.outcome !== 'options') throw new Error('fixture quote failed')
  const option = (shipping.body.options as Array<{ methodCode: string; optionIndex: number; optionHash: string }>).find(
    (o) => o.methodCode === 'pickup'
  )!
  const input = {
    ...context,
    idempotencyKey: 'checkout',
    now: utc(),
    ownerSession: BUYER_CLAIMS,
    quoteId: quote.quote.quoteId,
    shippingQuoteId: String(shipping.body.shippingQuoteId),
    selectedOptionIndex: option.optionIndex,
    selectedOptionHash: option.optionHash,
    contactEmail: 'buyer@example.invalid',
    shippingAddress: {
      recipientName: 'Buyer',
      line1: 'Carrer Major 1',
      city: 'Ontinyent',
      province: 'Valencia',
      postalCode: '46870',
      phone: '+34600111222'
    },
    consentTos: true as const,
    consentPrivacy: true as const,
    expectedTotalGrossCents: 899
  }
  return { quote, quoteInput, input }
}

function beforeOrderBatch(database: D1Database, change: () => Promise<void>): D1Database {
  const sql = new WeakMap<object, string>()
  let fired = false
  return new Proxy(database, {
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
            await change()
          }
          return target.batch(statements)
        }
      const value: unknown = Reflect.get(target, key)
      return typeof value === 'function' ? value.bind(target) : value
    }
  })
}

describe('coupon economic checkout contract', () => {
  it('exposes the original net subtotal and net discount separately to administration without subtracting twice', async () => {
    const f = await returnsFixture()
    try {
      await provisionPromotionFixture(f.sqlite, rule(), CLAIMS.identityId)
      const a = await prepare(f.database)
      const created = await placeOrder(f.database, a.input)
      if (created.outcome !== 'order_created') throw new Error(created.outcome)
      const detail = await readD1AdminOrder(f.database, CLAIMS, utc(), String(created.body.id))
      expect(detail).toMatchObject({
        outcome: 'found',
        data: {
          order: { totals: { subtotalNet: 826, discountNet: 83, shippingNet: 0, tax: 156, total: 899 } },
          lines: [{ quantity: 2, unitNet: 413, discountNet: 83, tax: 156, lineGross: 899 }]
        }
      })
      if (detail.outcome !== 'found') throw new Error(detail.outcome)
      const t = detail.data.order.totals
      expect(t.subtotalNet - (t.discountNet ?? 0) + t.shippingNet + t.tax).toBe(t.total)
    } finally {
      f.sqlite.close()
    }
  })
  it('rejects a zero payable checkout before any reservation, order or coupon consumption', async () => {
    const f = await returnsFixture()
    try {
      await provisionPromotionFixture(
        f.sqlite,
        rule({ benefit: { kind: 'fixed', grossCents: 1000 } }),
        CLAIMS.identityId
      )
      const a = await prepare(f.database)
      expect(a.quote.quote.totals.grossCents).toBe(0)
      expect(await placeOrder(f.database, { ...a.input, expectedTotalGrossCents: 0 })).toMatchObject({
        outcome: 'revalidation_required',
        reason: 'payment_total_non_positive'
      })
      for (const table of ['orders', 'inventory_reservations', 'promotion_redemptions', 'checkout_attempts'])
        expect(f.sqlite.prepare(`SELECT count(*) n FROM ${table}`).get()?.n).toBe(0)
    } finally {
      f.sqlite.close()
    }
  })
  it('does not permit INSERT OR REPLACE to rewrite rules, revisions, financial lines, evidence or recorded uses', async () => {
    const f = await returnsFixture()
    try {
      await provisionPromotionFixture(f.sqlite, rule(), CLAIMS.identityId)
      const a = await prepare(f.database)
      expect(await placeOrder(f.database, a.input)).toMatchObject({ outcome: 'order_created' })
      for (const table of [
        'promotion_rules',
        'promotion_rule_versions',
        'checkout_quote_lines',
        'order_lines',
        'checkout_quote_promotions',
        'promotion_redemptions'
      ])
        expect(() => f.sqlite.exec(`INSERT OR REPLACE INTO ${table} SELECT * FROM ${table}`)).toThrow(
          /immutable|snapshots/
        )
    } finally {
      f.sqlite.close()
    }
  })
  it('rolls back the entire losing order when another cart consumes the last coupon during finalization', async () => {
    const f = await returnsFixture()
    try {
      await provisionPromotionFixture(f.sqlite, rule({ totalLimit: 1 }), CLAIMS.identityId)
      const a = await prepare(f.database),
        b = await prepare(f.database)
      let winner: unknown
      const raced = beforeOrderBatch(f.database, async () => {
        winner = await placeOrder(f.database, b.input)
      })
      expect(await placeOrder(raced, a.input)).toMatchObject({
        outcome: 'revalidation_required',
        reason: 'promotion_changed'
      })
      expect(winner).toMatchObject({ outcome: 'order_created' })
      expect(f.sqlite.prepare('SELECT count(*) n FROM orders').get()?.n).toBe(1)
      expect(f.sqlite.prepare('SELECT count(*) n FROM promotion_redemptions').get()?.n).toBe(1)
      expect(f.sqlite.prepare('SELECT status,version FROM carts WHERE id=?').get(a.input.cartId)).toMatchObject({
        status: 'active',
        version: 2
      })
      expect(f.sqlite.prepare('SELECT state FROM checkout_attempts WHERE cart_id=?').get(a.input.cartId)?.state).toBe(
        'compensated'
      )
      expect(f.sqlite.prepare('SELECT count(*) n FROM promotion_guards').get()?.n).toBe(0)
    } finally {
      f.sqlite.close()
    }
  })
  it('recovers the same reserved intent after a failed final batch without duplicating discount use', async () => {
    const f = await returnsFixture()
    try {
      await provisionPromotionFixture(f.sqlite, rule(), CLAIMS.identityId)
      const a = await prepare(f.database)
      f.sqlite.exec(
        "CREATE TRIGGER synthetic_promotion_crash BEFORE INSERT ON promotion_redemptions BEGIN SELECT RAISE(ABORT,'synthetic_promotion_crash'); END"
      )
      await expect(placeOrder(f.database, a.input)).rejects.toMatchObject({ name: 'CartInfrastructureError' })
      expect(f.sqlite.prepare('SELECT count(*) n FROM orders').get()?.n).toBe(0)
      expect(f.sqlite.prepare('SELECT count(*) n FROM promotion_redemptions').get()?.n).toBe(0)
      expect(f.sqlite.prepare('SELECT status,version FROM carts WHERE id=?').get(a.input.cartId)).toMatchObject({
        status: 'active',
        version: 2
      })
      f.sqlite.exec('DROP TRIGGER synthetic_promotion_crash')
      const recovered = await placeOrder(f.database, a.input)
      expect(recovered).toMatchObject({ outcome: 'order_created', body: { totalGrossCents: 899 } })
      expect(await placeOrder(f.database, a.input)).toEqual(recovered)
      expect(f.sqlite.prepare('SELECT count(*) n FROM inventory_reservations').get()?.n).toBe(1)
      expect(f.sqlite.prepare('SELECT count(*) n FROM promotion_redemptions').get()?.n).toBe(1)
    } finally {
      f.sqlite.close()
    }
  })
  it('rejects a revised campaign even when its monetary discount has not changed', async () => {
    const f = await returnsFixture()
    try {
      const initial = rule()
      await provisionPromotionFixture(f.sqlite, initial, CLAIMS.identityId)
      const a = await prepare(f.database),
        next = { ...initial, version: 2 }
      f.sqlite
        .prepare(
          'INSERT INTO promotion_rule_versions(rule_id,version,rule_json,rule_hash,created_by,created_at) VALUES(?,?,?,?,?,?)'
        )
        .run(next.id, 2, JSON.stringify(next), await promotionRuleHash(next), CLAIMS.identityId, utc())
      f.sqlite.prepare('UPDATE promotion_rules SET current_version=2,updated_at=? WHERE id=?').run(utc(), initial.id)
      expect(await placeOrder(f.database, a.input)).toMatchObject({
        outcome: 'revalidation_required',
        reason: 'promotion_changed'
      })
      expect(f.sqlite.prepare('SELECT count(*) n FROM orders').get()?.n).toBe(0)
      expect(f.sqlite.prepare('SELECT count(*) n FROM inventory_reservations').get()?.n).toBe(0)
    } finally {
      f.sqlite.close()
    }
  })
  it('does not let the DO response cache erase coupon identity or current customer authorization', async () => {
    const f = await returnsFixture()
    try {
      await provisionPromotionFixture(f.sqlite, rule(), CLAIMS.identityId)
      const context = await cart(f.database)
      const cache = new Map<string, { payloadHash: string; status: number; body: unknown }>()
      const deps = {
        database: f.database,
        getResponse: async (key: string) => cache.get(key),
        putResponse: async (key: string, value: { payloadHash: string; status: number; body: unknown }) => {
          cache.set(key, value)
        },
        setAlarm: async () => {}
      }
      const command = {
        type: 'quote',
        cartId: context.cartId,
        commandId: 'quote',
        payload: { ...context, idempotencyKey: 'quote', now: utc(), couponCode: 'TEST101', ownerSession: BUYER_CLAIMS }
      }
      expect(await handleCartCommand(command, deps)).toMatchObject({
        status: 200,
        body: { quote: { totals: { grossCents: 899 } } }
      })
      expect(
        await handleCartCommand({ ...command, payload: { ...command.payload, couponCode: 'OTHER' } }, deps)
      ).toMatchObject({ status: 409 })
      f.sqlite.prepare('UPDATE auth_sessions SET revoked_at=? WHERE id=?').run(utc(), BUYER_CLAIMS.sessionId)
      expect(await handleCartCommand(command, deps)).toMatchObject({ status: 401 })
    } finally {
      f.sqlite.close()
    }
  })
  it('quotes a server-configured coupon, ignores client money, and persists immutable fiscal amounts', async () => {
    const f = await returnsFixture()
    try {
      await provisionPromotionFixture(f.sqlite, rule(), CLAIMS.identityId)
      const context = await cart(f.database)
      const input = {
        ...context,
        idempotencyKey: 'quote',
        now: utc(),
        couponCode: ' test101 ',
        ownerSession: BUYER_CLAIMS,
        discountGrossCents: 999999,
        totalGrossCents: 0
      }
      const quote = await quoteCart(f.database, input)
      const { netCents, taxCents, grossCents } = splitGross(899, 2100)
      expect(quote).toMatchObject({
        outcome: 'quoted',
        quote: {
          totals: { netCents, taxCents, grossCents },
          promotion: { code: 'TEST101', applied: true, discountGrossCents: 101 },
          lines: [{ unitGrossCents: 500, discountGrossCents: 101, grossCents: 899 }]
        }
      })
      if (quote.outcome !== 'quoted') throw new Error('quote')
      expect(
        f.sqlite
          .prepare('SELECT discount_gross_cents FROM checkout_quote_lines WHERE quote_id=?')
          .get(quote.quote.quoteId)?.discount_gross_cents
      ).toBe(101)
      expect(f.sqlite.prepare('SELECT count(*) AS n FROM promotion_redemptions').get()?.n).toBe(0)
      expect(await quoteCart(f.database, input)).toEqual(quote)
      expect(await quoteCart(f.database, { ...input, couponCode: 'OTHER' })).toMatchObject({ outcome: 'conflict' })
    } finally {
      f.sqlite.close()
    }
  })

  it('consumes a global/customer limit once atomically with the order, and exact replay cannot consume again', async () => {
    const f = await returnsFixture()
    try {
      await provisionPromotionFixture(f.sqlite, rule({ totalLimit: 1, perCustomerLimit: 1 }), CLAIMS.identityId)
      const a = await prepare(f.database),
        b = await prepare(f.database)
      const first = await placeOrder(f.database, a.input)
      expect(first).toMatchObject({ outcome: 'order_created', body: { totalGrossCents: 899 } })
      expect(await placeOrder(f.database, a.input)).toEqual(first)
      expect(await placeOrder(f.database, b.input)).toMatchObject({ outcome: 'revalidation_required' })
      expect(f.sqlite.prepare('SELECT customer_id,discount_gross_cents FROM promotion_redemptions').all()).toEqual([
        expect.objectContaining({ customer_id: CUSTOMER, discount_gross_cents: 101 })
      ])
      expect(f.sqlite.prepare('SELECT count(*) AS n FROM orders').get()?.n).toBe(1)
      expect(f.sqlite.prepare('SELECT discount_gross_cents,gross_cents FROM order_lines').all()).toEqual([
        expect.objectContaining({ discount_gross_cents: 101, gross_cents: 899 })
      ])
    } finally {
      f.sqlite.close()
    }
  })

  it('does not grant registered-only or per-customer coupons to a guest claiming a customer ID', async () => {
    const f = await returnsFixture()
    try {
      await provisionPromotionFixture(f.sqlite, rule({ segment: 'registered', perCustomerLimit: 1 }), CLAIMS.identityId)
      const context = await cart(f.database)
      const input = { ...context, idempotencyKey: 'quote', now: utc(), couponCode: 'TEST101', customerId: CUSTOMER }
      expect(await quoteCart(f.database, input)).toMatchObject({
        outcome: 'quoted',
        quote: {
          totals: { grossCents: 1000 },
          promotion: { applied: false, reason: 'segment_not_eligible' }
        }
      })
      expect(f.sqlite.prepare('SELECT count(*) AS n FROM checkout_quote_promotions').get()?.n).toBe(0)
    } finally {
      f.sqlite.close()
    }
  })
})

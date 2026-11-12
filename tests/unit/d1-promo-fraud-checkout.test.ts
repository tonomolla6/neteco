import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { returnsFixture, CLAIMS, BUYER_CLAIMS, CUSTOMER, utc } from './d1-returns-fixture'
import { provisionPromotionFixture } from '../support/promotion-fixture'
import { createCart, quoteCart, setCartLine } from '../../workers/catalog/cart'
import { requestShippingOptions, placeOrder } from '../../workers/catalog/checkout'
import type { PromotionRule } from '../../shared/promotions'
import { assessPromoFraud, decidePromoFraudCase } from '../../workers/security/promo-fraud'
import { testUuid } from '../support/deterministic'

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

const PEPPER = 'p'.repeat(40)
const SHARED_ADDRESS = 'Carrer Major 1, 46870, Ontinyent'
const fraudCases = (f: { sqlite: { prepare: (sql: string) => { all: () => unknown[] } } }) =>
  f.sqlite.prepare("SELECT * FROM promo_fraud_cases WHERE context='promotion'").all() as Array<{
    ref_id: string
    customer_id: string
    decision: string
    status: string
    id: string
  }>

async function fixture() {
  const f = await returnsFixture()
  f.sqlite.exec(
    await readFile(
      new URL('../../db/d1/migrations/0147_category_merchandising_promo_fraud.sql', import.meta.url),
      'utf8'
    )
  )
  await provisionPromotionFixture(f.sqlite, rule(), CLAIMS.identityId)
  return f
}
/** Other customers that reuse the buyer's e-mail alias and the delivery address: two independent signals. */
async function seedSharedFootprint(f: Awaited<ReturnType<typeof fixture>>, withIdentity = true) {
  const past = utc(-86_400_000)
  for (const n of [1, 2, 3]) {
    const id = `30000000-0000-4000-8000-0000000009${n}0`
    f.sqlite
      .prepare('INSERT INTO customers(id,name,created_at,updated_at) VALUES(?,?,?,?)')
      .run(id, `Otro ${n}`, past, past)
    await assessPromoFraud(
      f.database,
      {
        commandId: testUuid(),
        context: 'promotion',
        refId: `seed-${n}`,
        customerId: id,
        signals:
          n === 1 && withIdentity
            ? { identity: 'buyer@example.invalid', address: SHARED_ADDRESS }
            : { address: SHARED_ADDRESS }
      },
      { now: past, pepper: PEPPER }
    )
  }
}

describe('SEC-036 promotional fraud gate at checkout', () => {
  it('assesses a coupon redemption with server-derived signals and lets a clean buyer order', async () => {
    const f = await fixture()
    try {
      const a = await prepare(f.database)
      const result = await placeOrder(f.database, a.input, undefined, null, { promoFraudPepper: PEPPER })
      expect(result).toMatchObject({ outcome: 'order_created' })
      expect(fraudCases(f)).toMatchObject([{ ref_id: `${CUSTOMER}:TEST101`, customer_id: CUSTOMER, decision: 'clear' }])
      const stored = JSON.stringify(f.sqlite.prepare('SELECT * FROM promo_fraud_signals').all())
      expect(stored).not.toContain('buyer@example.invalid')
      expect(stored).not.toContain('Carrer Major')
    } finally {
      f.sqlite.close()
    }
  })

  it('does not assess orders without an applied coupon', async () => {
    const f = await returnsFixture()
    try {
      f.sqlite.exec(
        await readFile(
          new URL('../../db/d1/migrations/0147_category_merchandising_promo_fraud.sql', import.meta.url),
          'utf8'
        )
      )
      const context = await cart(f.database)
      const quote = await quoteCart(f.database, {
        ...context,
        idempotencyKey: 'quote',
        now: utc(),
        ownerSession: BUYER_CLAIMS
      })
      expect(quote.outcome).toBe('quoted')
      expect(fraudCases(f)).toEqual([])
    } finally {
      f.sqlite.close()
    }
  })

  it('withholds the coupon on a hold: no order, reservation, redemption or attempt is left behind', async () => {
    const f = await fixture()
    try {
      await seedSharedFootprint(f)
      const a = await prepare(f.database)
      expect(await placeOrder(f.database, a.input, undefined, null, { promoFraudPepper: PEPPER })).toMatchObject({
        outcome: 'revalidation_required',
        reason: 'promotion_changed'
      })
      expect(fraudCases(f).find((row) => row.customer_id === CUSTOMER)).toMatchObject({
        decision: 'hold',
        status: 'open'
      })
      for (const table of ['orders', 'promotion_redemptions'])
        expect(f.sqlite.prepare(`SELECT count(*) n FROM ${table}`).get()?.n).toBe(0)
      expect(f.sqlite.prepare("SELECT count(*) n FROM inventory_reservations WHERE status='active'").get()?.n).toBe(0)
    } finally {
      f.sqlite.close()
    }
  })

  it('a single shared signal only asks for review and the order proceeds', async () => {
    const f = await fixture()
    try {
      await seedSharedFootprint(f, false)
      const a = await prepare(f.database)
      expect(await placeOrder(f.database, a.input, undefined, null, { promoFraudPepper: PEPPER })).toMatchObject({
        outcome: 'order_created'
      })
      expect(fraudCases(f).find((row) => row.customer_id === CUSTOMER)).toMatchObject({
        decision: 'review',
        status: 'open'
      })
    } finally {
      f.sqlite.close()
    }
  })

  it('reuses the one case per customer and coupon: a human release lets the retry through', async () => {
    const f = await fixture()
    try {
      await seedSharedFootprint(f)
      const first = await prepare(f.database)
      expect(await placeOrder(f.database, first.input, undefined, null, { promoFraudPepper: PEPPER })).toMatchObject({
        outcome: 'revalidation_required'
      })
      const held = fraudCases(f).find((row) => row.customer_id === CUSTOMER)!
      const again = await prepare(f.database)
      await placeOrder(f.database, again.input, undefined, null, { promoFraudPepper: PEPPER })
      expect(fraudCases(f).filter((row) => row.customer_id === CUSTOMER)).toHaveLength(1)

      await decidePromoFraudCase(
        f.database,
        CLAIMS,
        held.id,
        { expectedVersion: 1, outcome: 'release', note: 'Verificado: misma familia' },
        { now: utc() }
      )
      const retry = await prepare(f.database)
      expect(await placeOrder(f.database, retry.input, undefined, null, { promoFraudPepper: PEPPER })).toMatchObject({
        outcome: 'order_created'
      })
    } finally {
      f.sqlite.close()
    }
  })

  it('an upheld case keeps the coupon blocked', async () => {
    const f = await fixture()
    try {
      await seedSharedFootprint(f)
      await placeOrder(f.database, (await prepare(f.database)).input, undefined, null, { promoFraudPepper: PEPPER })
      const held = fraudCases(f).find((row) => row.customer_id === CUSTOMER)!
      await decidePromoFraudCase(
        f.database,
        CLAIMS,
        held.id,
        { expectedVersion: 1, outcome: 'uphold', note: 'Abuso confirmado' },
        { now: utc() }
      )
      expect(
        await placeOrder(f.database, (await prepare(f.database)).input, undefined, null, { promoFraudPepper: PEPPER })
      ).toMatchObject({ outcome: 'revalidation_required', reason: 'promotion_changed' })
    } finally {
      f.sqlite.close()
    }
  })

  it('fails closed (and releases the reservation) when the pepper is unusable', async () => {
    const f = await fixture()
    try {
      const a = await prepare(f.database)
      await expect(placeOrder(f.database, a.input, undefined, null, { promoFraudPepper: 'short' })).rejects.toBeTruthy()
      expect(f.sqlite.prepare('SELECT count(*) n FROM orders').get()?.n).toBe(0)
      expect(f.sqlite.prepare("SELECT count(*) n FROM inventory_reservations WHERE status='active'").get()?.n).toBe(0)
    } finally {
      f.sqlite.close()
    }
  })
})

import { readFile } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { returnsFixture, CLAIMS, utc } from './d1-returns-fixture'
import { createCart, setCartLine, quoteCart } from '../../workers/catalog/cart'
import { requestShippingOptions, placeOrder, assertCheckoutAddress } from '../../workers/catalog/checkout'
import {
  calculateCheckoutMarket,
  calculateMarketLedger,
  configureCheckoutMarket
} from '../../workers/catalog/market-checkout-policy'
import { seedDefaultMarkets } from '../../workers/catalog/market-catalog'
let f: Awaited<ReturnType<typeof returnsFixture>>
const gb = {
  market: 'GB',
  currency: 'GBP',
  expectedVersion: 0,
  exchangeNumerator: 86,
  exchangeDenominator: 100,
  goodsTaxBps: 2000,
  shippingNetMinor: 450,
  shippingTaxBps: 2000,
  termsVersion: 'gb-terms-v1',
  paymentMethods: ['card']
} as const
let seq = 0
const uuid = () => `11111111-1111-4111-8111-${String(++seq).padStart(12, '0')}`
const configure = (profile: Record<string, unknown> = gb) =>
  configureCheckoutMarket(f.database, CLAIMS, uuid(), profile, { now: () => utc() })
beforeEach(async () => {
  seq = 0
  f = await returnsFixture()
  f.sqlite.exec(await readFile('db/d1/migrations/0106_inventory_lots_costing_forecast.sql', 'utf8'))
  f.sqlite.exec(await readFile('db/d1/migrations/0118_recall_market_messaging.sql', 'utf8'))
  f.sqlite.exec(await readFile('db/d1/migrations/0120_market_catalog_international_shipping.sql', 'utf8'))
  await seedDefaultMarkets(f.database, { now: () => utc() })
})
afterEach(() => f?.sqlite.close())
async function prepare(country: string, postalCode = '46870') {
  const cart = await createCart(f.database, { correlationId: 'market-integration', now: utc() })
  const base = { cartId: cart.cartId, token: cart.token, correlationId: 'market-integration', now: utc() }
  await setCartLine(f.database, {
    ...base,
    variantId: 'v-1-1',
    quantity: 2,
    expectedVersion: 1,
    idempotencyKey: `line-${seq}`
  })
  const quote = await quoteCart(f.database, { ...base, expectedVersion: 2, idempotencyKey: `quote-${seq}` })
  const shipping = await requestShippingOptions(f.database, {
    ...base,
    expectedVersion: 2,
    idempotencyKey: `shipping-${seq}`,
    destination: { city: 'London', postalCode }
  })
  if (quote.outcome !== 'quoted' || shipping.outcome !== 'options') throw new Error('fixture_quote_failed')
  const option = (shipping.body.options as Array<{ optionIndex: number; optionHash: string }>)[0]!
  const command = {
    ...base,
    expectedVersion: 2,
    quoteId: quote.quote.quoteId,
    shippingQuoteId: shipping.body.shippingQuoteId as string,
    selectedOptionIndex: option.optionIndex,
    selectedOptionHash: option.optionHash,
    contactEmail: 'buyer@example.invalid',
    contactName: 'Synthetic buyer',
    contactPhone: '+44123456789',
    shippingAddress: {
      recipientName: 'Synthetic buyer',
      line1: 'Example Street 1',
      city: 'London',
      province: 'London',
      postalCode,
      countryCode: country,
      phone: '+44123456789'
    },
    consentTos: true,
    consentPrivacy: true,
    idempotencyKey: `checkout-${seq}`
  }
  return command
}
const selection = (over: Record<string, unknown> = {}) => ({
  market: 'GB',
  version: 1,
  termsVersion: 'gb-terms-v1',
  paymentMethod: 'card',
  ...over
})
const place = (command: Record<string, unknown>) =>
  placeOrder(f.database, command as unknown as Parameters<typeof placeOrder>[1])
const count = (table: string) => (f.sqlite.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n
describe('checkout per market and currency', () => {
  it('creates a GB order whose tax, shipping, terms and payment method come from the market profile', async () => {
    await configure()
    const command = { ...(await prepare('GB')), marketCheckout: selection() }
    const result = await place(command)
    expect(result.outcome).toBe('order_created')
    if (result.outcome !== 'order_created') throw new Error('market_order_not_created')
    const goodsNet = (
      f.sqlite.prepare('SELECT sum(net_cents) n FROM order_lines WHERE order_id=?').get(result.body.id as string) as {
        n: number
      }
    ).n
    const presentment = calculateCheckoutMarket({ ...gb, version: 1 }, goodsNet)
    const ledger = calculateMarketLedger({ ...gb, version: 1 }, goodsNet)
    expect(result.body).toMatchObject({
      currency: 'EUR',
      market: {
        market: 'GB',
        currency: 'GBP',
        version: 1,
        termsVersion: 'gb-terms-v1',
        paymentMethod: 'card',
        totalMinor: presentment.totalMinor,
        goodsTaxMinor: presentment.goodsTaxMinor,
        shippingNetMinor: 450,
        shippingTaxMinor: 90
      },
      totalNetCents: ledger.goodsNetMinor + ledger.shippingNetMinor,
      totalTaxCents: ledger.goodsTaxMinor + ledger.shippingTaxMinor,
      shippingGrossCents: ledger.shippingNetMinor + ledger.shippingTaxMinor
    })
    const order = f.sqlite
      .prepare(
        'SELECT total_net_cents n,total_tax_cents t,total_gross_cents g,shipping_net_cents sn,shipping_tax_cents st FROM orders WHERE id=?'
      )
      .get(result.body.id as string) as { n: number; t: number; g: number; sn: number; st: number }
    expect(order).toMatchObject({ sn: ledger.shippingNetMinor, st: ledger.shippingTaxMinor })
    expect(order.g).toBe(order.n + order.t)
    expect(order.g).toBe(ledger.totalMinor)
    expect(
      f.sqlite
        .prepare('SELECT country_code c FROM order_shipping_address WHERE order_id=?')
        .get(result.body.id as string)
    ).toEqual({ c: 'GB' })
    expect(
      f.sqlite
        .prepare('SELECT market,market_version v,currency,terms_version t,payment_method p FROM order_market_snapshots')
        .get()
    ).toEqual({ market: 'GB', v: 1, currency: 'GBP', t: 'gb-terms-v1', p: 'card' })
  })
  it('replays the same command without creating a second order and rejects a changed selection', async () => {
    await configure()
    const command = { ...(await prepare('GB')), marketCheckout: selection() }
    const first = await place(command)
    const second = await place(command)
    expect(second).toEqual(first)
    expect(count('orders')).toBeGreaterThan(0)
    expect(count('order_market_snapshots')).toBe(1)
    await expect(
      place({ ...command, marketCheckout: selection({ paymentMethod: 'bank_transfer' }) })
    ).rejects.toMatchObject({ code: 'conflict' })
  })
  it.each([
    ['no market selection for a non-ES destination', {}, 'GB'],
    ['market different from the destination country', { marketCheckout: selection({ market: 'DE' }) }, 'GB'],
    ['payment method not enabled by the profile', { marketCheckout: selection({ paymentMethod: 'credit' }) }, 'GB'],
    ['market without a configured profile', { marketCheckout: selection({ market: 'FR' }) }, 'FR'],
    ['unknown payment method', { marketCheckout: selection({ paymentMethod: 'cash' }) }, 'GB'],
    ['malformed version', { marketCheckout: selection({ version: 0 }) }, 'GB'],
    ['extra selection keys', { marketCheckout: { ...selection(), currency: 'USD' } }, 'GB']
  ])('rejects %s before reserving stock', async (_name, extra, country) => {
    await configure()
    const command = { ...(await prepare(country)), ...extra }
    await expect(place(command)).rejects.toMatchObject({ code: 'invalid_input' })
    expect(count('checkout_attempts')).toBe(0)
    expect(count('orders')).toBe(0)
  })
  it('rejects a market that the catalog has deactivated', async () => {
    await configure()
    f.sqlite.prepare("UPDATE catalog_markets SET is_active=0 WHERE code='GB'").run()
    const command = { ...(await prepare('GB')), marketCheckout: selection() }
    await expect(place(command)).rejects.toMatchObject({ code: 'invalid_input' })
    expect(count('orders')).toBe(0)
  })
  it('asks for revalidation when the profile changed after the buyer saw it', async () => {
    await configure()
    await configure({ ...gb, expectedVersion: 1, goodsTaxBps: 1900 })
    const command = { ...(await prepare('GB')), marketCheckout: selection({ version: 1 }) }
    const result = await place(command)
    expect(result).toMatchObject({ outcome: 'revalidation_required', reason: 'market_changed' })
    expect(count('orders')).toBe(0)
    expect(count('checkout_attempts')).toBe(0)
  })
  it('asks for revalidation when the terms version the buyer accepted is not current', async () => {
    await configure()
    const command = { ...(await prepare('GB')), marketCheckout: selection({ termsVersion: 'gb-terms-v0' }) }
    expect(await place(command)).toMatchObject({ outcome: 'revalidation_required', reason: 'terms_changed' })
    expect(count('orders')).toBe(0)
  })
  it('compares the displayed total with the market presentment total', async () => {
    await configure()
    const command = await prepare('GB')
    const wrong = await place({ ...command, marketCheckout: selection(), expectedTotalGrossCents: 1 })
    expect(wrong).toMatchObject({ outcome: 'revalidation_required', reason: 'display_total_changed' })
    expect(count('orders')).toBe(0)
  })
  it('accepts the displayed market total', async () => {
    await configure()
    const command = await prepare('GB')
    const goodsNet = (
      f.sqlite.prepare('SELECT sum(net_cents) n FROM checkout_quote_lines WHERE quote_id=?').get(command.quoteId) as {
        n: number
      }
    ).n
    const expected = calculateCheckoutMarket({ ...gb, version: 1 }, goodsNet).totalMinor
    const result = await place({ ...command, marketCheckout: selection(), expectedTotalGrossCents: expected })
    expect(result.outcome).toBe('order_created')
  })
  it('does not commit an order when the profile changes between validation and commit', async () => {
    await configure()
    const command = { ...(await prepare('GB')), marketCheckout: selection() }
    const batch = f.database.batch.bind(f.database)
    let raced = false
    f.database.batch = async (statements) => {
      if (!raced) {
        raced = true
        await configure({ ...gb, expectedVersion: 1, shippingNetMinor: 900 })
      }
      return batch(statements)
    }
    const result = await place(command)
    expect(result).toMatchObject({ outcome: 'revalidation_required', reason: 'market_changed' })
    expect(count('orders')).toBe(0)
    expect(count('order_market_snapshots')).toBe(0)
    expect(f.sqlite.prepare("SELECT status FROM inventory_reservations WHERE status='reserved'").all()).toEqual([])
  })
  it('keeps Spanish orders on the legacy path without a snapshot', async () => {
    const command = await prepare('ES')
    const result = await place(command)
    expect(result).toMatchObject({ outcome: 'order_created', body: { currency: 'EUR' } })
    if (result.outcome === 'order_created') expect(result.body.market).toBeUndefined()
    expect(count('order_market_snapshots')).toBe(0)
  })
  it('makes snapshots immutable in the database', async () => {
    await configure()
    await place({ ...(await prepare('GB')), marketCheckout: selection() })
    expect(() => f.sqlite.exec("UPDATE order_market_snapshots SET terms_version='x-terms'")).toThrow(/immutable/)
    expect(() => f.sqlite.exec('DELETE FROM order_market_snapshots')).toThrow(/immutable/)
  })
  it('refuses, in the database, snapshots that do not match a current profile or the order', async () => {
    await configure()
    const legacy = await f.order({ paid: false, delivered: false })
    const insert = (over: Record<string, unknown>) => {
      const row = {
        order_id: legacy,
        market: 'GB',
        market_version: 1,
        currency: 'GBP',
        exchange_numerator: 86,
        exchange_denominator: 100,
        terms_version: 'gb-terms-v1',
        payment_method: 'card',
        ledger_goods_net_cents: 0,
        ledger_goods_tax_cents: 0,
        ledger_shipping_net_cents: 0,
        ledger_shipping_tax_cents: 0,
        goods_net_minor: 0,
        goods_tax_minor: 0,
        shipping_net_minor: 450,
        shipping_tax_minor: 0,
        total_minor: 450,
        created_at: utc(),
        ...over
      }
      const keys = Object.keys(row)
      f.sqlite
        .prepare(`INSERT INTO order_market_snapshots(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')})`)
        .run(...(Object.values(row) as never[]))
    }
    expect(() => insert({})).toThrow(/market_order_mismatch/)
    // Isolate the profile trigger from the order trigger to prove each guard independently.
    f.sqlite.exec('DROP TRIGGER order_market_snapshots_order')
    expect(() => insert({ terms_version: 'gb-terms-v0' })).toThrow(/market_changed/)
    expect(() => insert({ payment_method: 'credit' })).toThrow(/market_changed/)
    expect(() => insert({ market_version: 2 })).toThrow(/market_changed/)
    expect(count('order_market_snapshots')).toBe(0)
  })
})
describe('market address contract', () => {
  const address = (over: Record<string, unknown>) => ({
    recipientName: 'Synthetic buyer',
    line1: 'Example Street 1',
    city: 'London',
    province: 'London',
    postalCode: '46870',
    countryCode: 'GB',
    phone: '+44123456789',
    ...over
  })
  it('accepts alphanumeric postcodes outside Spain but keeps Spanish postcodes numeric', () => {
    expect(() => assertCheckoutAddress(address({ postalCode: 'SW1A 1AA' }), true)).not.toThrow()
    expect(() => assertCheckoutAddress(address({ postalCode: 'SW1A 1AA', countryCode: 'ES' }), true)).toThrow()
    expect(() => assertCheckoutAddress(address({ countryCode: 'ES', postalCode: '46870' }), true)).not.toThrow()
  })
  it.each(['gb', 'GBR', 'G1', '', 'GB; DROP', '1'])('rejects malformed country %j', (countryCode) => {
    expect(() => assertCheckoutAddress(address({ countryCode }), true)).toThrow()
  })
  it.each(['<script>', ' ', 'A', 'x'.repeat(13)])('rejects malformed postcode %j outside Spain', (postalCode) => {
    expect(() => assertCheckoutAddress(address({ postalCode }), true)).toThrow()
  })
})
describe('market ledger calculation', () => {
  it('derives deterministic integer EUR ledger amounts from the profile', () => {
    const p = { ...gb, version: 1 }
    expect(calculateMarketLedger(p, 10000)).toMatchObject({
      goodsNetMinor: 10000,
      goodsTaxMinor: 2000,
      shippingNetMinor: 523,
      shippingTaxMinor: 105,
      totalMinor: 12628
    })
  })
  it('rejects invalid goods amounts', () => {
    expect(() => calculateMarketLedger({ ...gb, version: 1 }, -1)).toThrow()
    expect(() => calculateMarketLedger({ ...gb, version: 1 }, 1.5)).toThrow()
  })
})
describe('cart coordinator checkout command', () => {
  const responses = new Map<string, { payloadHash: string; status: number; body: unknown }>()
  const run = async (payload: Record<string, unknown>) =>
    (await import('../../workers/cart-coordinator')).handleCartCommand(
      { type: 'checkout', commandId: payload.idempotencyKey, cartId: payload.cartId, payload },
      {
        database: f.database,
        getResponse: async (key) => responses.get(key),
        putResponse: async (key, value) => void responses.set(key, value),
        setAlarm: async () => {}
      }
    )
  it('forwards a valid market selection to the checkout core', async () => {
    await configure()
    const command = {
      ...(await prepare('GB')),
      marketCheckout: selection(),
      idempotencyKey: '33333333-3333-4333-8333-333333333333'
    }
    const result = await run(command)
    expect(result.status).toBe(200)
    expect(result.body).toMatchObject({ outcome: 'order_created', body: { market: { market: 'GB', currency: 'GBP' } } })
    expect(count('order_market_snapshots')).toBe(1)
  })
  it.each([
    ['extra key', { ...selection(), currency: 'USD' }],
    ['array', [selection()]],
    ['null', null],
    ['string', 'GB'],
    ['bad version', selection({ version: 1.5 })],
    ['unknown method', selection({ paymentMethod: 'cash' })]
  ])('answers 400 without touching D1 for a malformed selection (%s)', async (_name, marketCheckout) => {
    await configure()
    const command = { ...(await prepare('GB')), marketCheckout, idempotencyKey: '44444444-4444-4444-8444-444444444444' }
    const result = await run(command)
    expect(result).toMatchObject({ status: 400, body: { error: { code: 'invalid_input' } } })
    expect(count('orders')).toBe(0)
    expect(count('checkout_attempts')).toBe(0)
  })
  it('answers 400 for a foreign destination without a market selection', async () => {
    await configure()
    const command = { ...(await prepare('GB')), idempotencyKey: '55555555-5555-4555-8555-555555555555' }
    expect((await run(command)).status).toBe(400)
    expect(count('orders')).toBe(0)
  })
})

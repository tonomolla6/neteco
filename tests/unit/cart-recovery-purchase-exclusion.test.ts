import { afterEach, beforeEach, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { fulfillmentFixture } from './d1-fulfillment-fixture'
import { preferenceSeeds, CLAIMS, NOW } from './d1-account-preferences-fixture'
import { deterministicUuid } from '../fixtures/deterministic'
import { createCart, setCartLine, quoteCart } from '../../workers/catalog/cart'
import { requestShippingOptions, placeOrder } from '../../workers/catalog/checkout'
import { updateD1AccountPreferences } from '../../workers/auth/account-preferences'
import { ACCOUNT_PREFERENCES_POLICY_VERSION } from '../../shared/account-preferences'
import { CART_RECOVERY_POLICY_VERSION } from '../../shared/cart-recovery'
import {
  associateD1CartRecovery,
  updateD1CartRecoveryPreferences,
  evaluateD1CartRecoveries,
  dispatchD1CartRecoveries,
  resolveD1CartRecovery,
  resumeD1CartRecovery
} from '../../workers/marketing/cart-recovery'

let fixture: Awaited<ReturnType<typeof fulfillmentFixture>>
let closed = true
let possession: Awaited<ReturnType<typeof createCart>>
let instant: string
let associationId: string
let providerCalls: number
let capturedToken: string | undefined
const key = (name: string) => deterministicUuid('recovery-purchase-exclusion-' + name)
const policy = { enabled: true, waitSeconds: 3600, frequencyCapSeconds: 86400, tokenTtlSeconds: 86400 }
const options = { now: () => instant, hmacKey: new Uint8Array(32).fill(19) }
const deliveryOptions = { ...options, policy, origin: 'https://recovery.example.invalid' }
const sender = {
  async send(message: { text: string }) {
    providerCalls++
    capturedToken = message.text.match(/cr1\.[a-f0-9]{64}/)?.[0]
    return { messageId: 'explicit-fake-purchase-exclusion-' + providerCalls }
  }
}
function closeFixture() {
  if (closed) return
  closed = true
  fixture.sqlite.close()
}

beforeEach(async () => {
  closed = true
  fixture = await fulfillmentFixture()
  closed = false
  try {
    // Explicit feature migrations, not a changed global baseline or fake rows.
    for (const [table, migration] of [
      ['customer_account_preferences', '0066_account_preferences.sql'],
      ['product_watch_requests', '0087_product_watch.sql'],
      ['cart_recovery_associations', '0090_cart_recovery.sql']
    ]) {
      if (!fixture.sqlite.prepare('SELECT 1 FROM sqlite_schema WHERE name=?').get(table!))
        fixture.sqlite.exec(await readFile('db/d1/migrations/' + migration, 'utf8'))
    }
    for (const sql of preferenceSeeds()) fixture.sqlite.exec(sql)
    instant = NOW
    providerCalls = 0
    capturedToken = undefined
    possession = await createCart(fixture.database, { now: instant, correlationId: 'recovery-purchase-exclusion' })
    expect(
      (
        await setCartLine(fixture.database, {
          ...possession,
          now: instant,
          variantId: 'v-1-1',
          quantity: 2,
          expectedVersion: 1,
          idempotencyKey: key('line'),
          correlationId: 'recovery-purchase-exclusion'
        })
      ).outcome
    ).toBe('applied')
    await updateD1AccountPreferences(
      fixture.database,
      CLAIMS,
      key('global-consent'),
      {
        expectedVersion: 0,
        preferences: { product_updates: true, replenishment: false },
        policyVersion: ACCOUNT_PREFERENCES_POLICY_VERSION
      },
      options
    )
    await updateD1CartRecoveryPreferences(
      fixture.database,
      CLAIMS,
      {
        expectedVersion: 0,
        recoveryEnabled: true,
        policyVersion: CART_RECOVERY_POLICY_VERSION
      },
      key('recovery-consent'),
      options
    )
    const association = await associateD1CartRecovery(
      fixture.database,
      CLAIMS,
      possession,
      {
        expectedCartVersion: 2,
        stage: 'checkout',
        policyVersion: CART_RECOVERY_POLICY_VERSION
      },
      key('associate'),
      options
    )
    expect(association.associationId).not.toBeNull()
    associationId = association.associationId!
    instant = '2030-01-02T14:00:00Z'
  } catch (cause) {
    closeFixture()
    throw cause
  }
})
afterEach(closeFixture)

async function purchase(expectedVersion = 2) {
  const db = fixture.database
  const shipping = await requestShippingOptions(db, {
    ...possession,
    expectedVersion,
    destination: { postalCode: '46870', city: 'Ontinyent' },
    now: instant,
    idempotencyKey: key('shipping'),
    correlationId: 'recovery-purchase-exclusion'
  })
  if (shipping.outcome !== 'options') throw new Error('purchase_shipping_unavailable')
  const quote = await quoteCart(db, {
    ...possession,
    expectedVersion,
    now: instant,
    idempotencyKey: key('quote'),
    correlationId: 'recovery-purchase-exclusion'
  })
  if (quote.outcome !== 'quoted') throw new Error('purchase_quote_unavailable')
  const pickup = (shipping.body.options as Array<{ methodCode: string; optionIndex: number; optionHash: string }>).find(
    (option) => option.methodCode === 'pickup'
  )
  expect(pickup).toBeDefined()
  const result = await placeOrder(db, {
    ...possession,
    ownerSession: CLAIMS,
    expectedVersion: quote.quote.cartVersion,
    quoteId: quote.quote.quoteId,
    shippingQuoteId: shipping.body.shippingQuoteId as string,
    selectedOptionIndex: pickup!.optionIndex,
    selectedOptionHash: pickup!.optionHash,
    contactEmail: 'preferences@example.invalid',
    contactName: 'Synthetic recovery buyer',
    contactPhone: '+34600000000',
    shippingAddress: {
      recipientName: 'Synthetic recovery buyer',
      line1: 'Carrer Major 1',
      city: 'Ontinyent',
      province: 'València',
      postalCode: '46870',
      countryCode: 'ES',
      phone: '+34600000000'
    },
    consentTos: true,
    consentPrivacy: true,
    now: instant,
    idempotencyKey: key('checkout'),
    correlationId: 'recovery-purchase-exclusion'
  })
  expect(result.outcome).toBe('order_created')
  expect(fixture.sqlite.prepare('SELECT status FROM carts WHERE id=?').get(possession.cartId)).toEqual({
    status: 'converted'
  })
  expect(fixture.sqlite.prepare('SELECT count(*) n FROM orders').get()).toEqual({ n: 1 })
  expect(fixture.sqlite.prepare("SELECT count(*) n FROM inventory_reservations WHERE status='reserved'").get()).toEqual(
    { n: 1 }
  )
  expect(fixture.sqlite.prepare('SELECT count(*) n FROM payment_intents').get()).toEqual({ n: 0 })
}
function domain() {
  return JSON.stringify(
    [
      'carts',
      'cart_lines',
      'orders',
      'order_lines',
      'inventory_balances',
      'inventory_movements',
      'inventory_reservations',
      'inventory_reservation_lines',
      'payment_intents',
      'payment_events'
    ].map((table) => fixture.sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())
  )
}

it.each([false, true])('causally excludes converted carts from evaluation (purchase=%s)', async (converted) => {
  if (converted) await purchase()
  const before = domain()
  expect(await evaluateD1CartRecoveries(fixture.database, { ...options, policy })).toMatchObject({
    created: converted ? 0 : 1
  })
  expect(await dispatchD1CartRecoveries(fixture.database, sender, deliveryOptions)).toMatchObject({
    sent: converted ? 0 : 1,
    manualReview: 0
  })
  expect(providerCalls).toBe(converted ? 0 : 1)
  expect(domain()).toBe(before)
})

it('suppresses an already eligible pending reminder after canonical checkout without changing its order or reservation', async () => {
  expect(await evaluateD1CartRecoveries(fixture.database, { ...options, policy })).toMatchObject({ created: 1 })
  expect(
    fixture.sqlite.prepare('SELECT status FROM cart_recovery_deliveries WHERE association_id=?').get(associationId)
  ).toEqual({ status: 'pending' })
  await purchase()
  const before = domain()
  expect(await dispatchD1CartRecoveries(fixture.database, sender, deliveryOptions)).toMatchObject({
    sent: 0,
    skipped: 1,
    manualReview: 0
  })
  expect(providerCalls).toBe(0)
  expect(
    fixture.sqlite.prepare('SELECT status FROM cart_recovery_deliveries WHERE association_id=?').get(associationId)
  ).toEqual({ status: 'skipped' })
  expect(domain()).toBe(before)
})

it('makes a previously valid resolved and resumed capability unavailable after purchase, including exact replay, without rotating the cart again', async () => {
  expect(await evaluateD1CartRecoveries(fixture.database, { ...options, policy })).toMatchObject({ created: 1 })
  expect(await dispatchD1CartRecoveries(fixture.database, sender, deliveryOptions)).toMatchObject({ sent: 1 })
  expect(providerCalls).toBe(1)
  expect(capturedToken).toBeDefined()
  const capability = { id: associationId, token: capturedToken! }
  expect(await resolveD1CartRecovery(fixture.database, CLAIMS, capability, options)).toMatchObject({ cartVersion: 2 })
  const input = { ...capability, expectedCartVersion: 2 }
  const resumed = await resumeD1CartRecovery(fixture.database, CLAIMS, input, key('resume'), options)
  expect(resumed.receipt.cartVersion).toBe(3)
  possession = { ...possession, token: resumed.cart.token }
  await purchase(3)
  const before = domain()
  const tokenBefore = fixture.sqlite.prepare('SELECT token_hash,version FROM carts WHERE id=?').get(possession.cartId)
  await expect(resolveD1CartRecovery(fixture.database, CLAIMS, capability, options)).rejects.toMatchObject({
    code: 'not_found'
  })
  await expect(resumeD1CartRecovery(fixture.database, CLAIMS, input, key('resume'), options)).rejects.toMatchObject({
    code: 'not_found'
  })
  await expect(resumeD1CartRecovery(fixture.database, CLAIMS, input, key('new-resume'), options)).rejects.toMatchObject(
    { code: 'not_found' }
  )
  expect(await evaluateD1CartRecoveries(fixture.database, { ...options, policy })).toMatchObject({ created: 0 })
  expect(await dispatchD1CartRecoveries(fixture.database, sender, deliveryOptions)).toMatchObject({
    sent: 0,
    manualReview: 0
  })
  expect(providerCalls).toBe(1)
  expect(fixture.sqlite.prepare('SELECT token_hash,version FROM carts WHERE id=?').get(possession.cartId)).toEqual(
    tokenBefore
  )
  expect(domain()).toBe(before)
})

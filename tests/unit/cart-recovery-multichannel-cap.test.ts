import { readFile } from 'node:fs/promises'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { newsletterEditorialFixture } from './d1-newsletter-editorial-fixture'
import { preferenceSeeds, CLAIMS, BEFORE } from './d1-account-preferences-fixture'
import { seedInventoryFixture } from '../support/d1-sqlite'
import { provisionPublicationValidityFixture } from '../support/publication-validity-fixture'
import { deterministicUuid } from '../fixtures/deterministic'
import { createCart, setCartLine, prepareQuoteLinesStatement, type RawResolvedLine } from '../../workers/catalog/cart'
import { updateD1AccountPreferences } from '../../workers/auth/account-preferences'
import { ACCOUNT_PREFERENCES_POLICY_VERSION } from '../../shared/account-preferences'
import { CART_RECOVERY_POLICY_VERSION } from '../../shared/cart-recovery'
import { PRODUCT_WATCH_POLICY_VERSION } from '../../shared/product-watch'
import {
  associateD1CartRecovery,
  updateD1CartRecoveryPreferences,
  evaluateD1CartRecoveries,
  dispatchD1CartRecoveries,
  type CartRecoverySender
} from '../../workers/marketing/cart-recovery'
import {
  createD1ProductWatch,
  confirmD1ProductWatch,
  evaluateD1ProductWatches,
  dispatchD1ProductWatchDeliveries,
  type ProductWatchSender
} from '../../workers/marketing/product-watch'
import { dispatchNewsletterCampaigns } from '../../workers/marketing/newsletter-campaign-delivery'

let world: Awaited<ReturnType<typeof newsletterEditorialFixture>>
let initial: string
let recoverySends: number
const email = 'preferences@example.invalid'
const key = (name: string) => deterministicUuid('recovery-multichannel-' + name)
const options = { now: () => world.getNow(), hmacKey: new Uint8Array(32).fill(19) }
const policy = { enabled: true, waitSeconds: 1, frequencyCapSeconds: 3600, tokenTtlSeconds: 86400 }
const recoverySender: CartRecoverySender = {
  async send() {
    recoverySends++
    return { messageId: 'explicit-fake-cross-channel-' + recoverySends }
  }
}
const deliveryOptions = { ...options, origin: 'https://recovery.example.invalid', limit: 5 }
function at(seconds: number) {
  world.setNow(new Date(Date.parse(initial) + seconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'))
}
function domain() {
  return JSON.stringify(
    [
      'carts',
      'cart_lines',
      'orders',
      'payment_intents',
      'inventory_balances',
      'inventory_movements',
      'inventory_reservations',
      'inventory_reservation_lines'
    ].map((table) => world.sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())
  )
}
async function openWorld(seedInstant?: string) {
  world = await newsletterEditorialFixture()
  try {
    initial = seedInstant ?? world.getNow()
    world.setNow(initial)
    recoverySends = 0
    if (!world.sqlite.prepare("SELECT 1 FROM sqlite_schema WHERE name='customer_account_preferences'").get())
      world.sqlite.exec(await readFile('db/d1/migrations/0066_account_preferences.sql', 'utf8'))
    for (const sql of preferenceSeeds()) world.sqlite.exec(sql)
    seedInventoryFixture(world.sqlite)
    await provisionPublicationValidityFixture(world.database, { productIds: ['p-1'], now: BEFORE })
    await updateD1AccountPreferences(
      world.database,
      CLAIMS,
      key('global'),
      {
        expectedVersion: 0,
        preferences: { product_updates: true, replenishment: true },
        policyVersion: ACCOUNT_PREFERENCES_POLICY_VERSION
      },
      options
    )
    await updateD1CartRecoveryPreferences(
      world.database,
      CLAIMS,
      {
        expectedVersion: 0,
        recoveryEnabled: true,
        policyVersion: CART_RECOVERY_POLICY_VERSION
      },
      key('recovery-consent'),
      options
    )
  } catch (cause) {
    world.sqlite.close()
    throw cause
  }
}
beforeEach(() => openWorld())
afterEach(() => world?.sqlite.close())

async function prepareRecoveryCart() {
  const cart = await createCart(world.database, { correlationId: 'cross-channel-fixture', now: initial })
  expect(
    (
      await setCartLine(world.database, {
        cartId: cart.cartId,
        token: cart.token,
        expectedVersion: 1,
        idempotencyKey: key('cart-line'),
        correlationId: 'cross-channel-fixture',
        now: initial,
        variantId: 'v-1-1',
        quantity: 2
      })
    ).outcome
  ).toBe('applied')
  await associateD1CartRecovery(
    world.database,
    CLAIMS,
    cart,
    {
      expectedCartVersion: 2,
      stage: 'cart',
      policyVersion: CART_RECOVERY_POLICY_VERSION
    },
    key('association'),
    options
  )
}

async function prepareRecoveryDelivery(seconds = 2) {
  await prepareRecoveryCart()
  at(seconds)
  expect(await evaluateD1CartRecoveries(world.database, { ...options, policy })).toMatchObject({ created: 1 })
}

async function sendRecovery() {
  await prepareRecoveryDelivery()
  expect(await dispatchD1CartRecoveries(world.database, recoverySender, { ...deliveryOptions, policy })).toMatchObject({
    sent: 1
  })
  expect(recoverySends).toBe(1)
}

it('does not send an approved editorial newsletter immediately after recovery to the same email', async () => {
  // Real DOI, preference, policy and human campaign approval, not seeded caps.
  await world.subscriber(email)
  await world.policy()
  const campaignId = await world.campaign()
  await sendRecovery()
  const before = domain()
  at(3)
  const report = await dispatchNewsletterCampaigns(world.deps, { campaignId })
  expect(report).toMatchObject({ acceptedLocal: 0 })
  expect(world.sent).toHaveLength(0)
  expect(recoverySends).toBe(1)
  expect(domain()).toBe(before)
})

async function confirmedPriceDrop() {
  // Confirmation is an explicit requested consent handoff, not the marketing
  // signal being capped. Complete it before the recovery send under test.
  const messages: Parameters<ProductWatchSender['send']>[0][] = []
  const watchSender: ProductWatchSender = {
    async send(message) {
      messages.push(message)
      return { messageId: 'explicit-fake-cross-watch-' + messages.length }
    }
  }
  const created = await createD1ProductWatch(
    world.database,
    CLAIMS,
    {
      variantId: 11,
      kind: 'price_drop',
      consent: true,
      policyVersion: PRODUCT_WATCH_POLICY_VERSION
    },
    key('watch'),
    options
  )
  expect(await dispatchD1ProductWatchDeliveries(world.database, watchSender, deliveryOptions)).toMatchObject({
    sent: 1
  })
  const token = messages[0]!.text.match(/pw1\.[a-f0-9-]{36}\.[a-f0-9]{64}/)?.[0]
  expect(token).toBeDefined()
  await confirmD1ProductWatch(
    world.database,
    CLAIMS,
    created.watchId,
    {
      expectedVersion: 1,
      token
    },
    key('confirm-watch'),
    options
  )
  world.sqlite
    .prepare(
      `INSERT INTO variant_price_versions(id,variant_id,gross_cents,volume_tiers,valid_from,status,reason,created_at)
    VALUES(?,'v-1-1',400,'[]',?,'approved','Synthetic governed price change',?)`
    )
    .run(key('price400'), initial, initial)
  await provisionPublicationValidityFixture(world.database, { productIds: ['p-1'], now: initial })
  return { messages, watchSender }
}

async function evaluatePriceDrop(seconds = 3) {
  at(seconds)
  expect(await evaluateD1ProductWatches(world.database, options)).toMatchObject({ created: 1 })
  expect(
    world.sqlite
      .prepare("SELECT count(*) n FROM product_watch_deliveries WHERE kind='price_drop' AND status='pending'")
      .get()
  ).toEqual({ n: 1 })
  const canonical = await prepareQuoteLinesStatement(world.database, {
    instant: world.getNow(),
    lines: [{ variantId: 'v-1-1', quantity: 1 }]
  }).all<RawResolvedLine>()
  expect(canonical.success).toBe(true)
  expect(canonical.results).toHaveLength(1)
  const row = canonical.results[0]!
  expect(
    {
      source: {
        unitGrossCents: row.unitGrossCents,
        publicationValid: row.publicationValid,
        variantStatus: row.variantStatus,
        productStatus: row.productStatus
      },
      watch: world.sqlite.prepare('SELECT status,baseline_gross_cents FROM product_watches').get()
    },
    'matched fixture must retain a public, confirmed, genuinely cheaper signal'
  ).toMatchObject({
    source: { unitGrossCents: 400, publicationValid: 1, variantStatus: 'published', productStatus: 'published' },
    watch: { status: 'confirmed', baseline_gross_cents: 500 }
  })
}

it('sends the same confirmed price-drop signal without a recovery send in the matched time window', async () => {
  const { messages, watchSender } = await confirmedPriceDrop()
  await prepareRecoveryCart()
  at(2)
  expect(recoverySends).toBe(0)
  expect(world.sqlite.prepare('SELECT count(*) n FROM cart_recovery_deliveries').get()).toEqual({ n: 0 })
  const before = domain()
  await evaluatePriceDrop()
  const report = await dispatchD1ProductWatchDeliveries(world.database, watchSender, deliveryOptions)
  const signal = world.sqlite.prepare("SELECT status FROM product_watch_deliveries WHERE kind='price_drop'").get()
  expect({ report, signal, providerCalls: messages.length - 1 }).toEqual({
    report: { sent: 1, skipped: 0, manualReview: 0 },
    signal: { status: 'sent' },
    providerCalls: 1
  })
  expect(messages).toHaveLength(2)
  expect(domain()).toBe(before)
})

it('does not send a confirmed price-drop watch immediately after recovery to the same email', async () => {
  const { messages, watchSender } = await confirmedPriceDrop()
  await sendRecovery()
  const before = domain()
  await evaluatePriceDrop()
  expect(await dispatchD1ProductWatchDeliveries(world.database, watchSender, deliveryOptions)).toMatchObject({
    sent: 0
  })
  expect(messages).toHaveLength(1)
  expect(recoverySends).toBe(1)
  expect(domain()).toBe(before)
})

it('allows the confirmed price-drop exactly when the recovery cooldown expires', async () => {
  const { messages, watchSender } = await confirmedPriceDrop()
  await sendRecovery()
  const before = domain()
  await evaluatePriceDrop(2 + policy.frequencyCapSeconds)
  expect(await dispatchD1ProductWatchDeliveries(world.database, watchSender, deliveryOptions)).toEqual({
    sent: 1,
    skipped: 0,
    manualReview: 0
  })
  expect(messages).toHaveLength(2)
  expect(world.sqlite.prepare("SELECT status FROM product_watch_deliveries WHERE kind='price_drop'").get()).toEqual({
    status: 'sent'
  })
  expect(domain()).toBe(before)
})

it('suppresses a price-drop after ambiguous recovery acceptance without retrying either email', async () => {
  const { messages, watchSender } = await confirmedPriceDrop()
  await prepareRecoveryDelivery()
  const ambiguous: CartRecoverySender = {
    async send() {
      recoverySends++
      throw new Error('synthetic_recovery_acceptance_uncertain')
    }
  }
  expect(await dispatchD1CartRecoveries(world.database, ambiguous, { ...deliveryOptions, policy })).toEqual({
    sent: 0,
    skipped: 0,
    manualReview: 1
  })
  const before = domain()
  await evaluatePriceDrop()
  expect(await dispatchD1ProductWatchDeliveries(world.database, watchSender, deliveryOptions)).toEqual({
    sent: 0,
    skipped: 1,
    manualReview: 0
  })
  expect(await dispatchD1ProductWatchDeliveries(world.database, watchSender, deliveryOptions)).toMatchObject({
    sent: 0
  })
  expect(await dispatchD1CartRecoveries(world.database, recoverySender, { ...deliveryOptions, policy })).toMatchObject({
    sent: 0
  })
  expect(recoverySends).toBe(1)
  expect(messages).toHaveLength(1)
  expect(world.sqlite.prepare('SELECT status FROM cart_recovery_deliveries').get()).toEqual({ status: 'manual_review' })
  expect(domain()).toBe(before)
})

it('suppresses a price-drop while the recovery provider acknowledgement is still in flight', async () => {
  const { messages, watchSender } = await confirmedPriceDrop()
  await prepareRecoveryDelivery()
  let acknowledge!: () => void
  let started!: () => void
  const acknowledged = new Promise<void>((resolve) => {
    acknowledge = resolve
  })
  const providerStarted = new Promise<void>((resolve) => {
    started = resolve
  })
  const heldSender: CartRecoverySender = {
    async send() {
      recoverySends++
      started()
      await acknowledged
      return { messageId: 'explicit-fake-cross-channel-held' }
    }
  }
  const recovery = dispatchD1CartRecoveries(world.database, heldSender, { ...deliveryOptions, policy })
  const before = domain()
  try {
    await Promise.race([
      providerStarted,
      recovery.then(() => {
        throw new Error('provider_not_reached')
      })
    ])
    expect(world.sqlite.prepare('SELECT status FROM cart_recovery_deliveries').get()).toEqual({ status: 'sending' })
    await evaluatePriceDrop()
    expect(await dispatchD1ProductWatchDeliveries(world.database, watchSender, deliveryOptions)).toEqual({
      sent: 0,
      skipped: 1,
      manualReview: 0
    })
    expect(messages).toHaveLength(1)
  } finally {
    acknowledge()
    await recovery
  }
  expect(recoverySends).toBe(1)
  expect(domain()).toBe(before)
})

it('does not suppress an explicitly requested watch confirmation after recovery', async () => {
  await sendRecovery()
  at(3)
  const before = domain()
  await createD1ProductWatch(
    world.database,
    CLAIMS,
    {
      variantId: 11,
      kind: 'price_drop',
      consent: true,
      policyVersion: PRODUCT_WATCH_POLICY_VERSION
    },
    key('confirmation-after-recovery'),
    options
  )
  let confirmations = 0
  const confirmationSender: ProductWatchSender = {
    async send() {
      confirmations++
      return { messageId: 'explicit-fake-requested-confirmation' }
    }
  }
  expect(await dispatchD1ProductWatchDeliveries(world.database, confirmationSender, deliveryOptions)).toEqual({
    sent: 1,
    skipped: 0,
    manualReview: 0
  })
  expect(confirmations).toBe(1)
  expect(world.sqlite.prepare("SELECT status FROM product_watch_deliveries WHERE kind='confirmation'").get()).toEqual({
    status: 'sent'
  })
  expect(domain()).toBe(before)
})

// Each causal test first proves its receiver sends with identical governed
// setup, then repeats against a fresh database at the SAME clock. A pending
// signal is not a sent email; DOI confirmations are excluded from this cap.
async function matchedPair(run: (priorEmail: boolean) => Promise<void>) {
  const sameInstant = initial
  await run(false)
  world.sqlite.close()
  await openWorld(sameInstant)
  await run(true)
}

async function whileWatchSending(run: () => Promise<void>) {
  let release!: () => void
  let started!: () => void
  const acknowledgement = new Promise<void>((resolve) => {
    release = resolve
  })
  const providerStarted = new Promise<void>((resolve) => {
    started = resolve
  })
  let signalCalls = 0
  const heldSender: ProductWatchSender = {
    async send() {
      signalCalls++
      started()
      await acknowledgement
      return { messageId: 'explicit-fake-held-watch-signal' }
    }
  }
  const dispatch = dispatchD1ProductWatchDeliveries(world.database, heldSender, deliveryOptions)
  try {
    await Promise.race([
      providerStarted,
      dispatch.then(() => {
        throw new Error('watch_provider_not_reached')
      })
    ])
    expect(signalCalls).toBe(1)
    expect(world.sqlite.prepare("SELECT status FROM product_watch_deliveries WHERE kind='price_drop'").get()).toEqual({
      status: 'sending'
    })
    await run()
  } finally {
    release()
    await dispatch
  }
}

it('causally enforces the durable newsletter cooldown on a later watch signal with a matched sending control', async () => {
  await matchedPair(async (priorNewsletter) => {
    await world.subscriber(email)
    await world.policy()
    const campaignId = await world.campaign()
    const { messages, watchSender } = await confirmedPriceDrop()
    at(2)
    if (priorNewsletter) {
      expect(await dispatchNewsletterCampaigns(world.deps, { campaignId })).toMatchObject({ acceptedLocal: 1 })
      expect(world.sent).toHaveLength(1)
      const cap = world.sqlite.prepare('SELECT next_eligible_at FROM newsletter_editorial_caps').get() as {
        next_eligible_at: string
      }
      expect(cap.next_eligible_at > world.getNow()).toBe(true)
    } else expect(world.sent).toHaveLength(0)
    const before = domain()
    await evaluatePriceDrop()
    const report = await dispatchD1ProductWatchDeliveries(world.database, watchSender, deliveryOptions)
    expect(report.sent).toBe(priorNewsletter ? 0 : 1)
    expect(messages).toHaveLength(priorNewsletter ? 1 : 2)
    expect(world.sqlite.prepare("SELECT status FROM product_watch_deliveries WHERE kind='price_drop'").get()).toEqual({
      status: priorNewsletter ? 'skipped' : 'sent'
    })
    expect(domain()).toBe(before)
  })
})

it('causally excludes recovery while a watch signal is in flight without inventing a watch cooldown', async () => {
  await matchedPair(async (watchInFlight) => {
    await confirmedPriceDrop()
    await evaluatePriceDrop()
    await prepareRecoveryDelivery(4)
    const before = domain()
    const receive = async () => {
      at(5)
      const report = await dispatchD1CartRecoveries(world.database, recoverySender, { ...deliveryOptions, policy })
      expect(report.sent).toBe(watchInFlight ? 0 : 1)
      expect(recoverySends).toBe(watchInFlight ? 0 : 1)
      expect(world.sqlite.prepare('SELECT status FROM cart_recovery_deliveries').get()).toEqual({
        status: watchInFlight ? 'skipped' : 'sent'
      })
    }
    if (watchInFlight) await whileWatchSending(receive)
    else await receive()
    expect(domain()).toBe(before)
  })
})

it('causally excludes editorial email while a watch signal is in flight with a matched editorial sending control', async () => {
  await matchedPair(async (watchInFlight) => {
    await world.subscriber(email)
    await world.policy()
    const campaignId = await world.campaign()
    await confirmedPriceDrop()
    await evaluatePriceDrop()
    const before = domain()
    const receive = async () => {
      at(4)
      const report = await dispatchNewsletterCampaigns(world.deps, { campaignId })
      expect(report.acceptedLocal).toBe(watchInFlight ? 0 : 1)
      expect(world.sent).toHaveLength(watchInFlight ? 0 : 1)
    }
    if (watchInFlight) await whileWatchSending(receive)
    else await receive()
    expect(domain()).toBe(before)
  })
})

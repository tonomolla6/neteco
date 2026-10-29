import { readFile } from 'node:fs/promises'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { preferencesFixture, CLAIMS, OPTIONS, NOW, BEFORE } from './d1-account-preferences-fixture'
import { seedInventoryFixture } from '../support/d1-sqlite'
import { provisionPublicationValidityFixture } from '../support/publication-validity-fixture'
import { deterministicUuid } from '../fixtures/deterministic'
import { createCart, setCartLine } from '../../workers/catalog/cart'
import { updateD1AccountPreferences } from '../../workers/auth/account-preferences'
import { ACCOUNT_PREFERENCES_POLICY_VERSION } from '../../shared/account-preferences'
import { CART_RECOVERY_POLICY_VERSION } from '../../shared/cart-recovery'
import {
  associateD1CartRecovery,
  dispatchD1CartRecoveries,
  evaluateD1CartRecoveries,
  updateD1CartRecoveryPreferences,
  type CartRecoverySender
} from '../../workers/marketing/cart-recovery'

let fixture: Awaited<ReturnType<typeof preferencesFixture>>
let carts: Awaited<ReturnType<typeof createCart>>[]
let instant: string
let sentMessages: number
const key = (name: string) => deterministicUuid('cart-recovery-frequency-' + name)
const options = { now: () => instant, hmacKey: new Uint8Array(32).fill(19) }
const policy = { enabled: true, waitSeconds: 3600, frequencyCapSeconds: 3600, tokenTtlSeconds: 86400 }
const deliveryOptions = { ...options, policy, origin: 'https://recovery.example.invalid', limit: 5 }
// Only the provider boundary is replaced. Consent, carts, publication,
// evaluation, claiming and delivery receipts all use their actual D1 services.
const sender: CartRecoverySender = {
  async send() {
    sentMessages++
    return { messageId: 'explicit-fake-frequency-' + sentMessages }
  }
}
function at(secondsAfterInitialEvaluation: number) {
  instant = new Date(Date.parse(NOW) + (3600 + secondsAfterInitialEvaluation) * 1000)
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z')
}
function domain() {
  return JSON.stringify(
    [
      'carts',
      'cart_lines',
      'inventory_balances',
      'inventory_movements',
      'inventory_reservations',
      'inventory_reservation_lines',
      'orders',
      'payment_intents'
    ].map((table) => fixture.sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())
  )
}
async function associate(index: number) {
  return associateD1CartRecovery(
    fixture.database,
    CLAIMS,
    carts[index]!,
    {
      expectedCartVersion: 2,
      stage: index === 0 ? 'cart' : 'checkout',
      policyVersion: CART_RECOVERY_POLICY_VERSION
    },
    key('association-' + index),
    options
  )
}
beforeEach(async () => {
  fixture = await preferencesFixture(true)
  try {
    instant = NOW
    sentMessages = 0
    if (!fixture.sqlite.prepare("SELECT 1 FROM sqlite_master WHERE name='product_watch_requests'").get())
      fixture.sqlite.exec(await readFile('db/d1/migrations/0087_product_watch.sql', 'utf8'))
    fixture.sqlite.exec(await readFile('db/d1/migrations/0090_cart_recovery.sql', 'utf8'))
    seedInventoryFixture(fixture.sqlite)
    await provisionPublicationValidityFixture(fixture.database, { productIds: ['p-1'], now: BEFORE })
    carts = []
    for (let index = 0; index < 2; index++) {
      const cart = await createCart(fixture.database, { correlationId: 'frequency-fixture', now: NOW })
      expect(
        (
          await setCartLine(fixture.database, {
            cartId: cart.cartId,
            token: cart.token,
            expectedVersion: 1,
            idempotencyKey: key('line-' + index),
            correlationId: 'frequency-fixture',
            now: NOW,
            variantId: 'v-1-1',
            quantity: 2
          })
        ).outcome
      ).toBe('applied')
      carts.push(cart)
    }
    await updateD1AccountPreferences(
      fixture.database,
      CLAIMS,
      key('global'),
      {
        expectedVersion: 0,
        preferences: { product_updates: true, replenishment: false },
        policyVersion: ACCOUNT_PREFERENCES_POLICY_VERSION
      },
      OPTIONS
    )
    await updateD1CartRecoveryPreferences(
      fixture.database,
      CLAIMS,
      {
        expectedVersion: 0,
        recoveryEnabled: true,
        policyVersion: CART_RECOVERY_POLICY_VERSION
      },
      key('consent'),
      options
    )
  } catch (cause) {
    fixture.sqlite.close()
    throw cause
  }
})
afterEach(() => fixture?.sqlite.close())

async function twoOldPending() {
  await associate(0)
  at(0)
  expect(await evaluateD1CartRecoveries(fixture.database, { ...options, policy })).toMatchObject({ created: 1 })
  at(3601)
  await associate(1)
  expect(await evaluateD1CartRecoveries(fixture.database, { ...options, policy })).toMatchObject({ created: 1 })
  expect(
    fixture.sqlite.prepare("SELECT count(*) n FROM cart_recovery_deliveries WHERE status='pending'").get()
  ).toEqual({ n: 2 })
  at(3602)
}

it('caps actual sends when a delayed delivery is sent just before evaluation eligibility reopens', async () => {
  await associate(0)
  const before = domain()
  at(0)
  expect(await evaluateD1CartRecoveries(fixture.database, { ...options, policy })).toMatchObject({ created: 1 })
  at(3599)
  expect(await dispatchD1CartRecoveries(fixture.database, sender, deliveryOptions)).toMatchObject({ sent: 1 })
  at(3601)
  await associate(1)
  await evaluateD1CartRecoveries(fixture.database, { ...options, policy })
  expect(await dispatchD1CartRecoveries(fixture.database, sender, deliveryOptions)).toMatchObject({ sent: 0 })
  expect(sentMessages).toBe(1)
  expect(fixture.sqlite.prepare("SELECT count(*) n FROM cart_recovery_deliveries WHERE status='sent'").get()).toEqual({
    n: 1
  })
  expect(domain()).toBe(before)
})

it('caps two old pending deliveries dispatched in the same tick across cart and checkout stages', async () => {
  await associate(0)
  const before = domain()
  at(0)
  expect(await evaluateD1CartRecoveries(fixture.database, { ...options, policy })).toMatchObject({ created: 1 })
  at(3601)
  await associate(1)
  expect(await evaluateD1CartRecoveries(fixture.database, { ...options, policy })).toMatchObject({ created: 1 })
  expect(
    fixture.sqlite.prepare("SELECT count(*) n FROM cart_recovery_deliveries WHERE status='pending'").get()
  ).toEqual({ n: 2 })
  at(3602)
  expect(await dispatchD1CartRecoveries(fixture.database, sender, deliveryOptions)).toMatchObject({ sent: 1 })
  expect(sentMessages).toBe(1)
  expect(fixture.sqlite.prepare("SELECT count(*) n FROM cart_recovery_deliveries WHERE status='sent'").get()).toEqual({
    n: 1
  })
  expect(domain()).toBe(before)
})

it('atomically holds the customer cap while another dispatcher awaits the provider', async () => {
  await twoOldPending()
  const before = domain()
  let acknowledge!: () => void
  let started!: () => void
  const providerAcknowledgement = new Promise<void>((resolve) => {
    acknowledge = resolve
  })
  const providerStarted = new Promise<void>((resolve) => {
    started = resolve
  })
  const heldSender: CartRecoverySender = {
    async send() {
      sentMessages++
      started()
      await providerAcknowledgement
      return { messageId: 'explicit-fake-held-frequency' }
    }
  }
  const first = dispatchD1CartRecoveries(fixture.database, heldSender, deliveryOptions)
  // Race provider arrival against dispatcher completion so a source failure
  // cannot leave this fixture hanging before cleanup.
  try {
    await Promise.race([
      providerStarted,
      first.then(() => {
        throw new Error('provider_not_reached')
      })
    ])
    expect(
      fixture.sqlite.prepare("SELECT count(*) n FROM cart_recovery_deliveries WHERE status='sending'").get()
    ).toEqual({ n: 1 })
    expect(await dispatchD1CartRecoveries(fixture.database, sender, deliveryOptions)).toMatchObject({ sent: 0 })
    expect(sentMessages).toBe(1)
  } finally {
    acknowledge()
    await first
  }
  expect(fixture.sqlite.prepare("SELECT count(*) n FROM cart_recovery_deliveries WHERE status='sent'").get()).toEqual({
    n: 1
  })
  expect(domain()).toBe(before)
})

it('counts ambiguous provider acceptance toward the cap without retrying that delivery', async () => {
  await associate(0)
  at(0)
  expect(await evaluateD1CartRecoveries(fixture.database, { ...options, policy })).toMatchObject({ created: 1 })
  at(3599)
  const ambiguous: CartRecoverySender = {
    async send() {
      sentMessages++
      throw new Error('synthetic_provider_acknowledgement_lost')
    }
  }
  expect(await dispatchD1CartRecoveries(fixture.database, ambiguous, deliveryOptions)).toMatchObject({
    sent: 0,
    manualReview: 1
  })
  at(3601)
  await associate(1)
  await evaluateD1CartRecoveries(fixture.database, { ...options, policy })
  expect(await dispatchD1CartRecoveries(fixture.database, sender, deliveryOptions)).toMatchObject({ sent: 0 })
  expect(await dispatchD1CartRecoveries(fixture.database, sender, deliveryOptions)).toMatchObject({ sent: 0 })
  expect(sentMessages).toBe(1)
  expect(
    fixture.sqlite.prepare("SELECT count(*) n FROM cart_recovery_deliveries WHERE status='manual_review'").get()
  ).toEqual({ n: 1 })
})

it('allows a new send exactly at the actual-send cap boundary', async () => {
  await associate(0)
  at(0)
  expect(await evaluateD1CartRecoveries(fixture.database, { ...options, policy })).toMatchObject({ created: 1 })
  expect(await dispatchD1CartRecoveries(fixture.database, sender, deliveryOptions)).toMatchObject({ sent: 1 })
  at(3600)
  await associate(1)
  expect(await evaluateD1CartRecoveries(fixture.database, { ...options, policy })).toMatchObject({ created: 1 })
  expect(await dispatchD1CartRecoveries(fixture.database, sender, deliveryOptions)).toMatchObject({ sent: 1 })
  expect(sentMessages).toBe(2)
})

it('never sends a pending delivery at its exact token expiry even after the cap has elapsed', async () => {
  await associate(0)
  at(0)
  expect(await evaluateD1CartRecoveries(fixture.database, { ...options, policy })).toMatchObject({ created: 1 })
  const before = domain()
  at(policy.tokenTtlSeconds)
  expect(await dispatchD1CartRecoveries(fixture.database, sender, deliveryOptions)).toMatchObject({
    sent: 0,
    skipped: 1
  })
  expect(await dispatchD1CartRecoveries(fixture.database, sender, deliveryOptions)).toMatchObject({ sent: 0 })
  expect(sentMessages).toBe(0)
  expect(domain()).toBe(before)
})

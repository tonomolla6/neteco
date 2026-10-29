import { afterEach, beforeEach, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { preferencesFixture, CLAIMS, ACTOR, OPTIONS, NOW, BEFORE } from './d1-account-preferences-fixture'
import { seedInventoryFixture } from '../support/d1-sqlite'
import { provisionPublicationValidityFixture } from '../support/publication-validity-fixture'
import { deterministicUuid } from '../fixtures/deterministic'
import { createCart, setCartLine, getCart, expireCart } from '../../workers/catalog/cart'
import { updateD1AccountPreferences } from '../../workers/auth/account-preferences'
import { ACCOUNT_PREFERENCES_POLICY_VERSION } from '../../shared/account-preferences'
import {
  CART_RECOVERY_POLICY_VERSION,
  cartRecoveryIntentHash,
  cartRecoveryPreferenceSchema,
  cartRecoveryResolvedSchema
} from '../../shared/cart-recovery'
import {
  readD1CartRecoveryPreferences,
  updateD1CartRecoveryPreferences,
  associateD1CartRecovery,
  readD1CartRecoveryCommand,
  resolveD1CartRecovery,
  resumeD1CartRecovery,
  readD1CartRecoveryResumeGrant,
  evaluateD1CartRecoveries,
  dispatchD1CartRecoveries,
  type CartRecoverySender
} from '../../workers/marketing/cart-recovery'

let fixture: Awaited<ReturnType<typeof preferencesFixture>>
let cart: Awaited<ReturnType<typeof createCart>>
let instant: string
const key = (name: string) => deterministicUuid('cart-recovery-' + name)
const policy = { enabled: true, waitSeconds: 3600, frequencyCapSeconds: 86400, tokenTtlSeconds: 86400 }
const options = { now: () => instant, hmacKey: new Uint8Array(32).fill(19) }
const delivery = { ...options, policy, origin: 'https://recovery.example.invalid', limit: 5 }
const preference = { expectedVersion: 0, recoveryEnabled: true, policyVersion: CART_RECOVERY_POLICY_VERSION }
const association = { expectedCartVersion: 2, stage: 'cart' as const, policyVersion: CART_RECOVERY_POLICY_VERSION }
const messages: Parameters<CartRecoverySender['send']>[0][] = []
const sender: CartRecoverySender = {
  async send(message) {
    messages.push(message)
    return { messageId: 'explicit-fake-recovery-' + messages.length }
  }
}
beforeEach(async () => {
  fixture = await preferencesFixture(true)
  try {
    instant = NOW
    messages.length = 0
    if (!fixture.sqlite.prepare("SELECT 1 FROM sqlite_master WHERE name='product_watch_requests'").get())
      fixture.sqlite.exec(await readFile('db/d1/migrations/0087_product_watch.sql', 'utf8'))
    fixture.sqlite.exec(await readFile('db/d1/migrations/0090_cart_recovery.sql', 'utf8'))
    seedInventoryFixture(fixture.sqlite)
    await provisionPublicationValidityFixture(fixture.database, { productIds: ['p-1'], now: BEFORE })
    cart = await createCart(fixture.database, { correlationId: 'recovery-fixture', now: NOW })
    expect(
      (
        await setCartLine(fixture.database, {
          cartId: cart.cartId,
          token: cart.token,
          expectedVersion: 1,
          idempotencyKey: key('cart-line'),
          correlationId: 'recovery-fixture',
          now: NOW,
          variantId: 'v-1-1',
          quantity: 2
        })
      ).outcome
    ).toBe('applied')
  } catch (cause) {
    fixture.sqlite.close()
    throw cause
  }
})
afterEach(() => fixture?.sqlite.close())
function domain() {
  return JSON.stringify(
    [
      'carts',
      'cart_lines',
      'inventory_balances',
      'inventory_movements',
      'inventory_reservations',
      'inventory_reservation_lines',
      'newsletter_subscriptions'
    ].map((table) => fixture.sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())
  )
}
async function optIn() {
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
  return updateD1CartRecoveryPreferences(fixture.database, CLAIMS, preference, key('consent'), options)
}
async function associate(stage: 'cart' | 'checkout' = 'cart') {
  await optIn()
  return associateD1CartRecovery(
    fixture.database,
    CLAIMS,
    cart,
    { ...association, stage },
    key('associate-' + stage),
    options
  )
}
function due() {
  instant = '2030-01-02T14:00:00Z'
}
function credential() {
  const text = messages[0]?.text ?? ''
  const id = text.match(/#id=([a-f0-9-]{36})/)?.[1]
  const token = text.match(/cr1\.[a-f0-9]{64}/)?.[0]
  expect(id).toBeDefined()
  expect(token).toBeDefined()
  return { id, token }
}

it('defaults dedicated recovery consent to false without subscribing newsletter or changing cart and inventory', async () => {
  const before = domain()
  expect(
    cartRecoveryPreferenceSchema.parse(await readD1CartRecoveryPreferences(fixture.database, CLAIMS, options))
  ).toMatchObject({ version: 0, recoveryEnabled: false, updatedAt: null })
  expect(domain()).toBe(before)
  expect(messages).toHaveLength(0)
})
it('records explicit versioned consent and withdrawal with durable correlated receipts, leaving global preferences unchanged', async () => {
  const before = domain()
  const receipt = await updateD1CartRecoveryPreferences(fixture.database, CLAIMS, preference, key('enable'), options)
  expect(receipt).toMatchObject({
    action: 'preferences',
    commandId: key('enable'),
    version: 1,
    payloadHash: await cartRecoveryIntentHash('preferences', preference),
    recoveryEnabled: true
  })
  await updateD1CartRecoveryPreferences(
    fixture.database,
    CLAIMS,
    { ...preference, expectedVersion: 1, recoveryEnabled: false },
    key('disable'),
    options
  )
  expect(await readD1CartRecoveryPreferences(fixture.database, CLAIMS, options)).toMatchObject({
    version: 2,
    recoveryEnabled: false
  })
  expect(fixture.sqlite.prepare('SELECT count(*) n FROM account_preference_commands').get()).toMatchObject({ n: 0 })
  expect(domain()).toBe(before)
})
it('binds a real cart only with live verified session and exact possession/version, rejecting foreign token and stale input', async () => {
  await optIn()
  const before = domain()
  await expect(
    associateD1CartRecovery(
      fixture.database,
      CLAIMS,
      { ...cart, token: 'forged' },
      association,
      key('bad-token'),
      options
    )
  ).rejects.toMatchObject({ code: 'unauthenticated' })
  await expect(
    associateD1CartRecovery(
      fixture.database,
      CLAIMS,
      cart,
      { ...association, expectedCartVersion: 1 },
      key('stale'),
      options
    )
  ).rejects.toMatchObject({ code: 'version_conflict' })
  const receipt = await associateD1CartRecovery(fixture.database, CLAIMS, cart, association, key('associate'), options)
  expect(receipt).toMatchObject({
    action: 'associate',
    cartVersion: 2,
    version: 1,
    inventoryEffect: 'none',
    economicEffect: 'none'
  })
  expect(JSON.stringify(receipt)).not.toMatch(/token|recipient|@/)
  expect(domain()).toBe(before)
})
it('replays original associations by exact key/hash and rejects changed payload without extending eligibility', async () => {
  await optIn()
  const receipt = await associateD1CartRecovery(fixture.database, CLAIMS, cart, association, key('associate'), options)
  expect(await associateD1CartRecovery(fixture.database, CLAIMS, cart, association, key('associate'), options)).toEqual(
    receipt
  )
  expect(
    await readD1CartRecoveryCommand(fixture.database, CLAIMS, key('associate'), receipt.payloadHash, options)
  ).toEqual({ source: 'cloudflare', outcome: 'applied', receipt })
  await expect(
    associateD1CartRecovery(
      fixture.database,
      CLAIMS,
      cart,
      { ...association, stage: 'checkout' },
      key('associate'),
      options
    )
  ).rejects.toMatchObject({ code: 'conflict' })
  await expect(
    readD1CartRecoveryCommand(fixture.database, CLAIMS, key('associate'), '0'.repeat(64), options)
  ).rejects.toMatchObject({ code: 'conflict' })
})
it('checks current session authority before replay and resolve rather than inferring ownership from email', async () => {
  const receipt = await associate()
  fixture.sqlite.prepare('UPDATE auth_sessions SET revoked_at=? WHERE id=?').run(NOW, CLAIMS.sessionId)
  await expect(
    readD1CartRecoveryCommand(fixture.database, CLAIMS, key('associate-cart'), receipt.payloadHash, options)
  ).rejects.toMatchObject({ code: 'unauthenticated' })
  await expect(
    resolveD1CartRecovery(
      fixture.database,
      CLAIMS,
      { id: receipt.associationId, token: 'cr1.' + '0'.repeat(64) },
      options
    )
  ).rejects.toMatchObject({ code: 'unauthenticated' })
})
it('waits for configured abandonment and remains completely off when policy is disabled', async () => {
  await associate()
  const before = domain()
  expect(await evaluateD1CartRecoveries(fixture.database, { ...options, policy })).toMatchObject({ created: 0 })
  due()
  expect(
    await evaluateD1CartRecoveries(fixture.database, { ...options, policy: { ...policy, enabled: false } })
  ).toEqual({ processed: 0, created: 0 })
  expect(await evaluateD1CartRecoveries(fixture.database, { ...options, policy })).toMatchObject({ created: 1 })
  expect(domain()).toBe(before)
  expect(messages).toHaveLength(0)
})
it('deduplicates concurrent evaluation and enforces a customer frequency cap across cart and checkout stages', async () => {
  await associate()
  await associateD1CartRecovery(
    fixture.database,
    CLAIMS,
    cart,
    { ...association, stage: 'checkout' },
    key('checkout-stage'),
    options
  )
  due()
  const results = await Promise.all([
    evaluateD1CartRecoveries(fixture.database, { ...options, policy }),
    evaluateD1CartRecoveries(fixture.database, { ...options, policy })
  ])
  expect(results.reduce((sum, result) => sum + result.created, 0)).toBe(1)
  const ambiguous: CartRecoverySender = {
    async send(message) {
      messages.push(message)
      throw new Error('synthetic_acceptance_uncertain')
    }
  }
  expect(await dispatchD1CartRecoveries(fixture.database, ambiguous, delivery)).toEqual({
    sent: 0,
    skipped: 0,
    manualReview: 1
  })
  expect(await dispatchD1CartRecoveries(fixture.database, sender, delivery)).toMatchObject({ sent: 0 })
  expect((await evaluateD1CartRecoveries(fixture.database, { ...options, policy })).created).toBe(0)
  expect(messages).toHaveLength(1)
})
it('stops queued delivery after dedicated withdrawal and excludes an expired source cart', async () => {
  await associate()
  due()
  await evaluateD1CartRecoveries(fixture.database, { ...options, policy })
  await updateD1CartRecoveryPreferences(
    fixture.database,
    CLAIMS,
    { ...preference, expectedVersion: 1, recoveryEnabled: false },
    key('withdraw'),
    options
  )
  expect(await dispatchD1CartRecoveries(fixture.database, sender, delivery)).toMatchObject({ sent: 0, skipped: 1 })
  expect(messages).toHaveLength(0)
  // A persisted inactive/expired cart is not recoverable, even if an older
  // consent or association remains. This is a source-state fixture, no order.
  instant = cart.expiresAt
  expect(await expireCart(fixture.database, { cartId: cart.cartId, at: instant })).toBe(true)
  expect((await evaluateD1CartRecoveries(fixture.database, { ...options, policy })).created).toBe(0)
})
it('rejects catalog withdrawal before dispatch without touching stock or sending stale product content', async () => {
  await associate()
  due()
  await evaluateD1CartRecoveries(fixture.database, { ...options, policy })
  fixture.sqlite.prepare("UPDATE products SET status='draft' WHERE id='p-1'").run()
  const before = domain()
  expect(await dispatchD1CartRecoveries(fixture.database, sender, delivery)).toMatchObject({ sent: 0, skipped: 1 })
  expect(messages).toHaveLength(0)
  expect(domain()).toBe(before)
})
it('uses an owner-only fragment grant for explicit CAS resume, rotating HttpOnly possession with durable exact recovery and no stock effects', async () => {
  await associate()
  due()
  await evaluateD1CartRecoveries(fixture.database, { ...options, policy })
  expect(await dispatchD1CartRecoveries(fixture.database, sender, delivery)).toMatchObject({ sent: 1 })
  const body = credential(),
    before = domain()
  expect(messages[0]!.text).not.toMatch(/\?[^\s]*token=|v1\.[a-f0-9-]{36}\./)
  const resolved = cartRecoveryResolvedSchema.parse(
    await resolveD1CartRecovery(fixture.database, CLAIMS, body, options)
  )
  expect(resolved).toHaveProperty('cartId', cart.cartId)
  expect(resolved).toMatchObject({
    cartVersion: 2,
    inventoryEffect: 'none',
    economicEffect: 'none',
    lines: [{ variantId: 11, quantity: 2, unitGrossCents: 500, grossCents: 1000 }]
  })
  expect(JSON.stringify(resolved)).not.toMatch(/token|cost|preferences@example/)
  await expect(
    resolveD1CartRecovery(fixture.database, CLAIMS, { ...body, token: cart.token }, options)
  ).rejects.toMatchObject({ code: 'invalid_input' })
  await expect(
    resolveD1CartRecovery(fixture.database, CLAIMS, { ...body, token: 'cr1.' + '0'.repeat(64) }, options)
  ).rejects.toMatchObject({ code: 'not_found' })
  expect(domain()).toBe(before)
  expect(await dispatchD1CartRecoveries(fixture.database, sender, delivery)).toMatchObject({ sent: 0 })
  expect(messages).toHaveLength(1)
  const input = { ...body, expectedCartVersion: 2 },
    command = key('resume')
  const resumed = await resumeD1CartRecovery(fixture.database, CLAIMS, input, command, options)
  expect(resumed.receipt).toMatchObject({ action: 'resume', cartVersion: 3, commandId: command })
  expect(JSON.stringify(resumed.receipt)).not.toContain(resumed.cart.token)
  expect(resumed.cart.token).not.toBe(cart.token)
  expect(await getCart(fixture.database, resumed.cart)).toMatchObject({
    version: 3,
    lines: [{ variantId: 'v-1-1', quantity: 2 }]
  })
  await expect(getCart(fixture.database, cart)).rejects.toMatchObject({ code: 'unauthorized' })
  expect(await resumeD1CartRecovery(fixture.database, CLAIMS, input, command, options)).toEqual(resumed)
  expect(
    await readD1CartRecoveryResumeGrant(fixture.database, CLAIMS, command, resumed.receipt.payloadHash, options)
  ).toEqual(resumed.cart)
  expect(JSON.stringify(fixture.sqlite.prepare('SELECT * FROM cart_recovery_commands').all())).not.toContain(
    resumed.cart.token
  )
  expect(fixture.sqlite.prepare('SELECT count(*) n FROM identities WHERE id=?').get(ACTOR)).toMatchObject({ n: 1 })
})
it('rejects a grant rotated by canonical resume during the final content read instead of releasing a stale recoverable snapshot', async () => {
  await associate()
  due()
  await evaluateD1CartRecoveries(fixture.database, { ...options, policy })
  expect(await dispatchD1CartRecoveries(fixture.database, sender, delivery)).toMatchObject({ sent: 1 })
  const body = credential()
  let contentReads = 0,
    resumeCommitted = false
  const interleaved = new Proxy(fixture.database, {
    get(target, property) {
      if (property !== 'batch') return Reflect.get(target, property)
      return async (statements: D1PreparedStatement[]) => {
        contentReads++
        if (contentReads === 2) {
          // Pause the resolver's final canonical read, not its first grant check.
          // A second request legitimately rotates possession in one atomic batch;
          // it changes no lines, prices, reservations or inventory quantities.
          const resumed = await resumeD1CartRecovery(
            target,
            CLAIMS,
            { ...body, expectedCartVersion: 2 },
            key('interleaved-resume'),
            options
          )
          expect(resumed.receipt.cartVersion).toBe(3)
          expect(await getCart(target, resumed.cart)).toMatchObject({
            version: 3,
            lines: [{ variantId: 'v-1-1', quantity: 2 }]
          })
          resumeCommitted = true
        }
        return target.batch(statements)
      }
    }
  })
  await expect(resolveD1CartRecovery(interleaved, CLAIMS, body, options)).rejects.toMatchObject({ code: 'not_found' })
  expect(contentReads).toBe(2)
  expect(resumeCommitted).toBe(true)
  expect(
    fixture.sqlite.prepare("SELECT count(*) n FROM cart_recovery_commands WHERE action='resume'").get()
  ).toMatchObject({ n: 1 })
})

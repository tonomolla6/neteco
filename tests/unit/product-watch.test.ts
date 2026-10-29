import { readFile } from 'node:fs/promises'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { deterministicUuid } from '../fixtures/deterministic'
import { seedInventoryFixture } from '../support/d1-sqlite'
import { provisionPublicationValidityFixture } from '../support/publication-validity-fixture'
import { preferencesFixture, CLAIMS, OPTIONS, NOW, BEFORE, ACTOR } from './d1-account-preferences-fixture'
import { updateD1AccountPreferences } from '../../workers/auth/account-preferences'
import { ACCOUNT_PREFERENCES_POLICY_VERSION } from '../../shared/account-preferences'
import { reserveInventory, releaseReservation } from '../../workers/catalog/inventory'
import {
  createD1ProductWatch,
  confirmD1ProductWatch,
  cancelD1ProductWatch,
  readD1ProductWatches,
  readD1ProductWatchCommand,
  evaluateD1ProductWatches,
  dispatchD1ProductWatchDeliveries,
  type ProductWatchSender
} from '../../workers/marketing/product-watch'
import {
  PRODUCT_WATCH_POLICY_VERSION,
  productWatchIntentHash,
  productWatchListSchema
} from '../../shared/product-watch'

let f: Awaited<ReturnType<typeof preferencesFixture>>
const key = (name: string) => deterministicUuid(`product-watch-${name}`)
const options = { ...OPTIONS, hmacKey: new Uint8Array(32).fill(7) }
const deliveryOptions = { ...options, origin: 'https://shop.example.invalid', limit: 5 }
const input = {
  variantId: 11,
  kind: 'price_drop' as const,
  consent: true as const,
  policyVersion: PRODUCT_WATCH_POLICY_VERSION
}
const messages: Parameters<ProductWatchSender['send']>[0][] = []
const sender: ProductWatchSender = {
  async send(message) {
    messages.push(message)
    return { messageId: `explicit-fake-product-watch-${messages.length}` }
  }
}
beforeEach(async () => {
  f = await preferencesFixture(true)
  try {
    seedInventoryFixture(f.sqlite)
    await provisionPublicationValidityFixture(f.database, { productIds: ['p-1'], now: BEFORE })
    f.sqlite.exec(await readFile('db/d1/migrations/0087_product_watch.sql', 'utf8'))
    f.sqlite.exec(await readFile('db/d1/migrations/0090_cart_recovery.sql', 'utf8'))
    messages.length = 0
  } catch (cause) {
    f.sqlite.close()
    throw cause
  }
})
afterEach(() => f?.sqlite.close())
function domain() {
  return JSON.stringify(
    [
      'inventory_balances',
      'inventory_movements',
      'inventory_reservations',
      'inventory_reservation_lines',
      'newsletter_subscriptions'
    ].map((table) => f.sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())
  )
}
async function enablePreferences() {
  await updateD1AccountPreferences(
    f.database,
    CLAIMS,
    key('preferences'),
    {
      expectedVersion: 0,
      preferences: { product_updates: true, replenishment: true },
      policyVersion: ACCOUNT_PREFERENCES_POLICY_VERSION
    },
    OPTIONS
  )
}
async function confirmed(kind: 'price_drop' | 'back_in_stock' = 'price_drop') {
  const receipt = await createD1ProductWatch(f.database, CLAIMS, { ...input, kind }, key(`create-${kind}`), options)
  await dispatchD1ProductWatchDeliveries(f.database, sender, deliveryOptions)
  expect(messages).toHaveLength(1)
  const token = messages[0]!.text.match(/pw1\.[a-f0-9-]{36}\.[a-f0-9]{64}/)?.[0]
  expect(token, 'only the explicit fake email handoff receives the confirmation credential').toBeDefined()
  return confirmD1ProductWatch(
    f.database,
    CLAIMS,
    receipt.watchId,
    { expectedVersion: 1, token },
    key(`confirm-${kind}`),
    options
  )
}
function lowerPrice() {
  // Governed price fixture, not a client-provided amount or promotion.
  f.sqlite
    .prepare(
      `INSERT INTO variant_price_versions(id,variant_id,gross_cents,volume_tiers,valid_from,status,reason,created_at)
    VALUES(?,'v-1-1',400,'[]',?,'approved','Synthetic governed price change',?)`
    )
    .run(key('price400'), BEFORE, BEFORE)
}

it('creates pending per-variant consent without exposing a token, enabling newsletter, reserving stock or sending mail', async () => {
  const before = domain()
  const receipt = await createD1ProductWatch(f.database, CLAIMS, input, key('create'), options)
  expect(receipt).toMatchObject({
    action: 'create',
    status: 'pending',
    version: 1,
    inventoryEffect: 'none',
    economicEffect: 'none'
  })
  expect(JSON.stringify(receipt)).not.toMatch(/pw1\.|preferences@example|token|recipient/)
  expect(domain()).toBe(before)
  expect(messages).toHaveLength(0)
  const list = productWatchListSchema.parse(await readD1ProductWatches(f.database, CLAIMS, {}, options))
  expect(list.items).toHaveLength(1)
  expect(list.items[0]).toMatchObject({ id: receipt.watchId, suppressedByPreferences: true, baselineGrossCents: null })
})
it('replays original receipt exactly and recovers by owner/key/hash, rejecting changed same-key input', async () => {
  const receipt = await createD1ProductWatch(f.database, CLAIMS, input, key('create'), options)
  expect(await createD1ProductWatch(f.database, CLAIMS, input, key('create'), options)).toEqual(receipt)
  const hash = await productWatchIntentHash('create', null, input)
  expect(await readD1ProductWatchCommand(f.database, CLAIMS, key('create'), hash, options)).toEqual({
    source: 'cloudflare',
    outcome: 'applied',
    receipt
  })
  await expect(
    createD1ProductWatch(f.database, CLAIMS, { ...input, kind: 'back_in_stock' }, key('create'), options)
  ).rejects.toMatchObject({ code: 'conflict' })
  await expect(
    readD1ProductWatchCommand(f.database, CLAIMS, key('create'), '0'.repeat(64), options)
  ).rejects.toMatchObject({ code: 'conflict' })
})
it('requires live verified owner before both mutation and replay', async () => {
  await createD1ProductWatch(f.database, CLAIMS, input, key('create'), options)
  f.sqlite.prepare('UPDATE identities SET email_verified_at=NULL WHERE id=?').run(ACTOR)
  await expect(createD1ProductWatch(f.database, CLAIMS, input, key('create'), options)).rejects.toMatchObject({
    code: 'email_unverified'
  })
  await expect(
    readD1ProductWatchCommand(
      f.database,
      CLAIMS,
      key('create'),
      await productWatchIntentHash('create', null, input),
      options
    )
  ).rejects.toMatchObject({ code: 'email_unverified' })
})
it('uses a server-only confirmation obligation with explicit fake delivery, dedup and a real confirmed baseline', async () => {
  const receipt = await confirmed()
  expect(receipt).toMatchObject({ action: 'confirm', status: 'confirmed', version: 2 })
  await dispatchD1ProductWatchDeliveries(f.database, sender, deliveryOptions)
  expect(messages).toHaveLength(1)
  expect(messages[0]!.to).toBe('preferences@example.invalid')
  expect((await readD1ProductWatches(f.database, CLAIMS, {}, options)).items[0]).toMatchObject({
    baselineGrossCents: 500,
    status: 'confirmed'
  })
})
it('rejects forged confirmation credentials and prevents confirming a cancelled pending subscription', async () => {
  const receipt = await createD1ProductWatch(f.database, CLAIMS, input, key('create'), options)
  await expect(
    confirmD1ProductWatch(
      f.database,
      CLAIMS,
      receipt.watchId,
      { expectedVersion: 1, token: `pw1.${receipt.watchId}.${'0'.repeat(64)}` },
      key('forged'),
      options
    )
  ).rejects.toMatchObject({ code: 'confirmation_unavailable' })
  const cancelled = await cancelD1ProductWatch(
    f.database,
    CLAIMS,
    receipt.watchId,
    { expectedVersion: 1 },
    key('cancel'),
    options
  )
  expect(cancelled).toMatchObject({ status: 'cancelled', version: 2 })
  await dispatchD1ProductWatchDeliveries(f.database, sender, deliveryOptions)
  expect(messages).toHaveLength(0)
})
it('does not notify pending subscriptions or treat an unchanged price as a price drop', async () => {
  const pending = await createD1ProductWatch(f.database, CLAIMS, input, key('create'), options)
  expect(await evaluateD1ProductWatches(f.database, options)).toMatchObject({ created: 0 })
  await cancelD1ProductWatch(
    f.database,
    CLAIMS,
    pending.watchId,
    { expectedVersion: 1 },
    key('cancel-pending'),
    options
  )
  await enablePreferences()
  await confirmed()
  expect(await evaluateD1ProductWatches(f.database, options)).toMatchObject({ created: 0 })
})
it('records one durable price-drop obligation for repeated evaluations and never mutates stock or money', async () => {
  await enablePreferences()
  await confirmed()
  lowerPrice()
  const before = domain()
  expect(await evaluateD1ProductWatches(f.database, options)).toMatchObject({ created: 1 })
  expect(await evaluateD1ProductWatches(f.database, options)).toMatchObject({ created: 0 })
  await dispatchD1ProductWatchDeliveries(f.database, sender, deliveryOptions)
  expect(messages).toHaveLength(2)
  expect(messages[1]!.text).not.toMatch(/reservad|garantizad/i)
  expect(domain()).toBe(before)
})
it('observes real sellable stock, including reservations, and creates exactly one back-in-stock obligation after release', async () => {
  await enablePreferences()
  await reserveInventory(f.database, {
    idempotencyKey: key('reserve'),
    correlationId: key('reserve'),
    lines: [{ variantId: 'v-1-1', locationId: 'loc-main', quantity: 24 }],
    expiresAt: '2099-01-01T00:00:00Z',
    now: NOW
  })
  await confirmed('back_in_stock')
  expect(await evaluateD1ProductWatches(f.database, options)).toMatchObject({ created: 0 })
  await releaseReservation(f.database, { idempotencyKey: key('reserve'), correlationId: key('release'), now: NOW })
  const before = domain()
  expect(await evaluateD1ProductWatches(f.database, options)).toMatchObject({ created: 1 })
  expect(await evaluateD1ProductWatches(f.database, options)).toMatchObject({ created: 0 })
  expect(domain()).toBe(before)
})
it('global commercial withdrawal suppresses a confirmed watch without enabling preferences or newsletter', async () => {
  await confirmed()
  lowerPrice()
  expect(await evaluateD1ProductWatches(f.database, options)).toMatchObject({ created: 0 })
  await dispatchD1ProductWatchDeliveries(f.database, sender, deliveryOptions)
  expect(messages).toHaveLength(1)
  expect((await readD1ProductWatches(f.database, CLAIMS, {}, options)).items[0]?.suppressedByPreferences).toBe(true)
})
it('cancel invalidates already queued notification work and retains exact original replay', async () => {
  await enablePreferences()
  const receipt = await confirmed()
  lowerPrice()
  await evaluateD1ProductWatches(f.database, options)
  const cancelled = await cancelD1ProductWatch(
    f.database,
    CLAIMS,
    receipt.watchId,
    { expectedVersion: 2 },
    key('cancel'),
    options
  )
  await dispatchD1ProductWatchDeliveries(f.database, sender, deliveryOptions)
  expect(messages).toHaveLength(1)
  expect(
    await cancelD1ProductWatch(f.database, CLAIMS, receipt.watchId, { expectedVersion: 2 }, key('cancel'), options)
  ).toEqual(cancelled)
})
it('does not leak retired catalogue data or create notification work for an unpublished source', async () => {
  await enablePreferences()
  await confirmed()
  lowerPrice()
  f.sqlite.exec("UPDATE products SET status='draft' WHERE id='p-1'")
  expect(await evaluateD1ProductWatches(f.database, options)).toMatchObject({ created: 0 })
  await dispatchD1ProductWatchDeliveries(f.database, sender, deliveryOptions)
  expect(messages).toHaveLength(1)
  await expect(
    createD1ProductWatch(f.database, CLAIMS, { ...input, kind: 'back_in_stock' }, key('hidden'), options)
  ).rejects.toMatchObject({ code: 'variant_unavailable' })
})
it('rolls back consent, commands and confirmation obligations when any statement fails', async () => {
  // Only reached after the API has implemented its real D1 batch boundary.
  const database = new Proxy(f.database, {
    get(target, property) {
      if (property === 'batch')
        return async (statements: D1PreparedStatement[]) =>
          target.batch([
            ...statements,
            target.prepare('INSERT INTO deliberately_missing_product_watch_table VALUES(1)')
          ])
      const value = Reflect.get(target, property)
      return typeof value === 'function' ? value.bind(target) : value
    }
  })
  await expect(createD1ProductWatch(database, CLAIMS, input, key('rollback'), options)).rejects.toMatchObject({
    code: 'service_unavailable'
  })
  expect((await readD1ProductWatches(f.database, CLAIMS, {}, options)).items).toEqual([])
})
it('rechecks live session authority inside the committing batch rather than trusting preflight consent', async () => {
  let revoked = false
  const database = new Proxy(f.database, {
    get(target, property) {
      if (property === 'batch')
        return async (statements: D1PreparedStatement[]) => {
          if (!revoked) {
            revoked = true
            f.sqlite.prepare('UPDATE auth_sessions SET revoked_at=? WHERE identity_id=?').run(NOW, ACTOR)
          }
          return target.batch(statements)
        }
      const value = Reflect.get(target, property)
      return typeof value === 'function' ? value.bind(target) : value
    }
  })
  await expect(createD1ProductWatch(database, CLAIMS, input, key('race'), options)).rejects.toMatchObject({
    code: 'unauthenticated'
  })
  expect(f.sqlite.prepare('SELECT count(*) n FROM product_watch_commands').get()).toEqual({ n: 0 })
  expect(f.sqlite.prepare('SELECT count(*) n FROM product_watch_deliveries').get()).toEqual({ n: 0 })
})
it('rotates the scheduled checkpoint beyond its effective limit without starving later variants or writing stock', async () => {
  await enablePreferences()
  await provisionPublicationValidityFixture(f.database, { productIds: ['p-2', 'p-3'], now: BEFORE })
  const receipts = []
  for (const variantId of [11, 21, 31])
    receipts.push(
      await createD1ProductWatch(f.database, CLAIMS, { ...input, variantId }, key(`fair-create-${variantId}`), options)
    )
  await dispatchD1ProductWatchDeliveries(f.database, sender, deliveryOptions)
  expect(messages).toHaveLength(3)
  for (const receipt of receipts) {
    const token = messages
      .map((message) => message.text.match(/pw1\.[a-f0-9-]{36}\.[a-f0-9]{64}/)?.[0])
      .find((value) => value?.startsWith(`pw1.${receipt.watchId}.`))
    expect(token).toBeDefined()
    await confirmD1ProductWatch(
      f.database,
      CLAIMS,
      receipt.watchId,
      { expectedVersion: 1, token },
      key(`fair-confirm-${receipt.watchId}`),
      options
    )
  }
  const before = domain()
  for (let n = 0; n < 3; n++)
    expect(await evaluateD1ProductWatches(f.database, { ...options, limit: 1 })).toMatchObject({
      processed: 1,
      created: 0
    })
  expect(f.sqlite.prepare('SELECT count(DISTINCT watch_id) n FROM product_watch_observations').get()).toEqual({ n: 3 })
  expect(domain()).toBe(before)
})
it('deduplicates concurrent evaluation of the same confirmed source transition', async () => {
  await enablePreferences()
  await confirmed()
  lowerPrice()
  const result = await Promise.all([
    evaluateD1ProductWatches(f.database, { ...options, afterId: '' }),
    evaluateD1ProductWatches(f.database, { ...options, afterId: '' })
  ])
  expect(result.reduce((sum, row) => sum + row.created, 0)).toBe(1)
  expect(f.sqlite.prepare("SELECT count(*) n FROM product_watch_deliveries WHERE kind='price_drop'").get()).toEqual({
    n: 1
  })
})

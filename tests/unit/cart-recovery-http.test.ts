import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { preferencesFixture, CLAIMS, NOW, BEFORE } from './d1-account-preferences-fixture'
import { seedInventoryFixture } from '../support/d1-sqlite'
import { provisionPublicationValidityFixture } from '../support/publication-validity-fixture'
import { deterministicUuid } from '../fixtures/deterministic'
import { createCart, setCartLine } from '../../workers/catalog/cart'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import {
  handleCartRecoveryRequest,
  type CartRecoveryHttpDependencies
} from '../../workers/marketing/cart-recovery-http'
import {
  CART_RECOVERY_POLICY_VERSION,
  cartRecoveryIntentHash,
  cartRecoveryPreferenceSchema,
  cartRecoveryReceiptSchema
} from '../../shared/cart-recovery'

let fixture: Awaited<ReturnType<typeof preferencesFixture>>
let cart: Awaited<ReturnType<typeof createCart>>, cookie: string
const origin = 'https://recovery-http.example.invalid'
const configuration = { password: 'synthetic-cart-recovery-cookie-over32bytes', maxAgeSeconds: 3600 }
const key = (name: string) => deterministicUuid('cart-recovery-http-' + name)
const preference = { expectedVersion: 0, recoveryEnabled: true, policyVersion: CART_RECOVERY_POLICY_VERSION }
let deps: CartRecoveryHttpDependencies
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(NOW))
  fixture = await preferencesFixture(true)
  try {
    if (!fixture.sqlite.prepare("SELECT 1 FROM sqlite_master WHERE name='product_watch_requests'").get())
      fixture.sqlite.exec(await readFile('db/d1/migrations/0087_product_watch.sql', 'utf8'))
    fixture.sqlite.exec(await readFile('db/d1/migrations/0090_cart_recovery.sql', 'utf8'))
    seedInventoryFixture(fixture.sqlite)
    await provisionPublicationValidityFixture(fixture.database, { productIds: ['p-1'], now: BEFORE })
    cart = await createCart(fixture.database, { now: NOW, correlationId: 'recovery-http-fixture' })
    await setCartLine(fixture.database, {
      cartId: cart.cartId,
      token: cart.token,
      expectedVersion: 1,
      idempotencyKey: key('line'),
      correlationId: 'recovery-http-fixture',
      now: NOW,
      variantId: 'v-1-1',
      quantity: 2
    })
    cookie = (await issueD1SessionCookie(fixture.database, CLAIMS, configuration))!.split(';')[0]!
    deps = {
      database: fixture.database,
      sessionCookieConfiguration: configuration,
      origin,
      edgeLimiter: { limit: async () => ({ success: true }) } as unknown as RateLimit,
      rateLimitPepper: 'synthetic-cart-recovery-http-rate-over32',
      now: () => NOW,
      hmacKey: new Uint8Array(32).fill(19)
    }
  } catch (cause) {
    fixture.sqlite.close()
    throw cause
  }
})
afterEach(() => {
  fixture?.sqlite.close()
  vi.useRealTimers()
})
function call(path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) {
  return handleCartRecoveryRequest(
    new Request(origin + '/api/account/cart-recovery' + path, {
      method,
      headers: {
        Cookie: cookie,
        Origin: origin,
        'Content-Type': 'application/json',
        'Idempotency-Key': key('request'),
        'CF-Connecting-IP': '192.0.2.90',
        ...headers
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    }),
    deps
  )
}
it('reads real default private preferences without writes and rejects missing session before accessing recovery state', async () => {
  const before = fixture.sqlite.prepare('SELECT total_changes() n').get()
  const response = await call('/preferences')
  expect(response?.status).toBe(200)
  expect(cartRecoveryPreferenceSchema.parse(await response!.json())).toMatchObject({
    recoveryEnabled: false,
    version: 0
  })
  expect(response!.headers.get('cache-control')).toBe('private, no-store')
  expect(response!.headers.get('referrer-policy')).toBe('no-referrer')
  expect(fixture.sqlite.prepare('SELECT total_changes() n').get()).toEqual(before)
  expect((await call('/preferences', 'GET', undefined, { Cookie: '' }))?.status).toBe(401)
})
it('accepts only strict explicit consent with exact origin and UUID key; no email or cart credential in receipt', async () => {
  expect((await call('/preferences', 'PUT', preference, { Origin: 'https://foreign.invalid' }))?.status).toBe(403)
  expect((await call('/preferences', 'PUT', { ...preference, email: 'client@example.invalid' }))?.status).toBe(400)
  const response = await call('/preferences', 'PUT', preference)
  expect(response?.status).toBe(201)
  const receipt = cartRecoveryReceiptSchema.parse(await response!.json())
  expect(receipt).toMatchObject({
    action: 'preferences',
    commandId: key('request'),
    payloadHash: await cartRecoveryIntentHash('preferences', preference)
  })
  expect(JSON.stringify(receipt)).not.toMatch(/token|recipient|@/)
  expect(response!.headers.has('set-cookie')).toBe(false)
})
it('requires one exact cart cookie and matching cart ID before authoritative association, never accepts browser goods or owner IDs', async () => {
  await call('/preferences', 'PUT', preference)
  const input = { expectedCartVersion: 2, stage: 'checkout', policyVersion: CART_RECOVERY_POLICY_VERSION }
  expect((await call('/associations', 'POST', input))?.status).toBe(401)
  const headers = {
    Cookie: `${cookie}; neteco-cart-v2=v1.${cart.cartId}.${cart.token}`,
    'X-Neteco-Cart-Id': cart.cartId,
    'Idempotency-Key': key('associate')
  }
  expect((await call('/associations', 'POST', { ...input, goodsGrossCents: 1 }, headers))?.status).toBe(400)
  const response = await call('/associations', 'POST', input, headers)
  expect(response?.status).toBe(201)
  expect(cartRecoveryReceiptSchema.parse(await response!.json())).toMatchObject({
    action: 'associate',
    cartVersion: 2,
    inventoryEffect: 'none',
    economicEffect: 'none'
  })
  expect(
    (
      await call('/associations', 'POST', input, {
        ...headers,
        Cookie: headers.Cookie + `; neteco-cart-v2=v1.${cart.cartId}.${cart.token}`
      })
    )?.status
  ).toBe(401)
})
it('recovers only the current owner exact command payload hash, after live session authorization', async () => {
  const created = await call('/preferences', 'PUT', preference)
  expect(created?.status).toBe(201)
  const receipt = cartRecoveryReceiptSchema.parse(await created!.json())
  const path = '/commands/' + receipt.commandId
  const response = await call(path, 'GET', undefined, { 'X-Neteco-Command-Payload-Hash': receipt.payloadHash })
  expect(response?.status).toBe(200)
  expect(await response!.json()).toEqual({ source: 'cloudflare', outcome: 'applied', receipt })
  expect((await call(path, 'GET', undefined, { 'X-Neteco-Command-Payload-Hash': '0'.repeat(64) }))?.status).toBe(409)
  fixture.sqlite.prepare('UPDATE auth_sessions SET revoked_at=? WHERE id=?').run(NOW, CLAIMS.sessionId)
  expect((await call(path, 'GET', undefined, { 'X-Neteco-Command-Payload-Hash': receipt.payloadHash }))?.status).toBe(
    401
  )
})
it('does not accept fragment capabilities in GET/query; invalid owner-bound credentials never restore a cart or leak D1 failure', async () => {
  expect((await call('/resolve?id=' + key('missing') + '&token=cr1.' + '0'.repeat(64)))?.status).toBe(400)
  const before = fixture.sqlite.prepare('SELECT total_changes() n').get()
  expect((await call('/resolve', 'POST', { id: key('missing'), token: 'cr1.' + '0'.repeat(64) }))?.status).toBe(404)
  expect(fixture.sqlite.prepare('SELECT total_changes() n').get()).toEqual(before)
  const outage = new Proxy(fixture.database, {
    get(target, name) {
      if (name === 'prepare')
        return () => {
          throw new Error('synthetic D1 outage private')
        }
      return Reflect.get(target, name)
    }
  })
  const response = await handleCartRecoveryRequest(
    new Request(origin + '/api/account/cart-recovery/preferences', { headers: { Cookie: cookie } }),
    { ...deps, database: outage }
  )
  expect(response?.status).toBe(503)
  expect(JSON.stringify(await response!.json())).not.toMatch(/synthetic|SELECT|private/)
})
it('rejects a gateway receipt for another payload before releasing any cart cookie', async () => {
  const input = { id: key('association'), token: 'cr1.' + 'a'.repeat(64), expectedCartVersion: 2 }
  deps.resumeGateway = async () => ({
    receipt: {
      source: 'cloudflare',
      commandId: key('request'),
      action: 'resume',
      payloadHash: '0'.repeat(64),
      version: 3,
      associationId: input.id,
      cartVersion: 3,
      recoveryEnabled: true,
      recordedAt: NOW,
      inventoryEffect: 'none',
      economicEffect: 'none'
    },
    cart: { cartId: cart.cartId, token: cart.token, expiresAt: cart.expiresAt }
  })
  const response = await call('/resume', 'POST', input)
  expect(response?.status).toBe(503)
  expect(response!.headers.has('set-cookie')).toBe(false)
  expect(JSON.stringify(await response!.json())).not.toContain(cart.token)
})

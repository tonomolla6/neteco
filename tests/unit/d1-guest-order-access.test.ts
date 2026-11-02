import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyDeliveryPreferencesMigration } from '../support/delivery-preferences-migration'
import { readFile, readdir } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { Miniflare, convertV4MiniflareOptions, NoOpLog } from 'miniflare'
import { splitDemoSql } from '../../scripts/lib/d1-demo-sql'
import { renderD1ShippingSeed } from '../../scripts/lib/d1-shipping-seed'
import { seedInventoryFixture } from '../support/d1-sqlite'
import { provisionPublicationValidityFixture } from '../support/publication-validity-fixture'
import { createCart, setCartLine, quoteCart } from '../../workers/catalog/cart'
import * as checkout from '../../workers/catalog/checkout'
import { handleStorefrontCheckoutHttp } from '../../workers/catalog/storefront-checkout'
import { handleGuestOrderAccessHttp } from '../../workers/catalog/guest-order-access-http'
import { publishEmailOutbox, receiveEmailDispatch } from '../../workers/communications/email-outbox'
import { dispatchTransactionalEmails } from '../../workers/communications/transactional-email-delivery'
import {
  issueD1GuestOrderLinkClaim,
  readD1GuestOrderView,
  revokeD1GuestOrderAccess
} from '../../workers/catalog/guest-order-access'
import { returnsFixture, utc } from './d1-returns-fixture'
import { deterministicTestData } from '../fixtures/deterministic'

const clock = deterministicTestData('guest-order-access', '2026-10-08T12:00:00Z'),
  origin = 'https://guest-order.neteco.test',
  configuration = { password: 'synthetic-guest-order-cookie-password-over32', maxAgeSeconds: 3600 }
let fixture: Awaited<ReturnType<typeof returnsFixture>>, orderId: string, originalToken: string, linkClaim: string
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(clock.date())
  fixture = await returnsFixture()
  await applyDeliveryPreferencesMigration(fixture.sqlite)
  const placeOrder = checkout.placeOrder
  vi.spyOn(checkout, 'placeOrder').mockImplementation(async (...args) => {
    const receipt = await placeOrder(...args)
    if (receipt.outcome === 'order_created') originalToken = String(receipt.body.orderToken)
    return receipt
  })
  orderId = await fixture.order({ owned: false, paid: false, delivered: false })
  linkClaim = await issueD1GuestOrderLinkClaim(fixture.database, orderId, originalToken, configuration, {
    now: () => utc()
  })
})
afterEach(() => {
  fixture?.sqlite.close()
  vi.restoreAllMocks()
  vi.useRealTimers()
})
const deps = () => ({
  database: fixture.database,
  origin,
  edgeLimiter: { limit: async () => ({ success: true }) } as unknown as RateLimit,
  rateLimitPepper: 'synthetic-guest-order-edge-pepper-over32',
  sessionCookieConfiguration: configuration,
  now: () => utc()
})
const storefrontDeps = () => ({
  ...deps(),
  dispatch: async () => {
    throw new Error('unexpected_command')
  },
  paymentConfiguration: () => null,
  session: async () => null,
  authenticationEnabled: false
})
const request = (path: string, method = 'GET', token = linkClaim) =>
  new Request(origin + path, {
    method,
    headers: { Origin: origin, 'CF-Connecting-IP': '192.0.2.167', 'Content-Type': 'application/json' },
    ...(method === 'POST' ? { body: JSON.stringify({ token }) } : {})
  })
async function guestCookie() {
  const response = await handleGuestOrderAccessHttp(request(`/api/orders/${orderId}/access`, 'POST'), deps())
  expect(response?.status).toBe(204)
  return response!.headers.get('set-cookie')!.split(';')[0]!
}
function guestRequest(cookie: string) {
  const value = request(`/api/orders/${orderId}`)
  value.headers.set('cookie', cookie)
  return value
}
describe('short-lived sealed guest link exchange without payment authority', () => {
  it('rejects the original payment bearer as a view-only link claim', async () => {
    const response = await handleGuestOrderAccessHttp(
      request(`/api/orders/${orderId}/access`, 'POST', originalToken),
      deps()
    )
    expect(response?.status).toBe(404)
    expect(response!.headers.has('set-cookie')).toBe(false)
  })
  it('reproduces the existing gap: real checkout bearer cookie works but the URL token alone is ignored', async () => {
    const cookieRequest = request(`/api/orders/${orderId}`)
    cookieRequest.headers.set('cookie', `neteco-order-access-v2=v1.${orderId}.${originalToken}`)
    expect((await handleStorefrontCheckoutHttp(cookieRequest, storefrontDeps()))?.status).toBe(200)
    const claimRequest = request(`/api/orders/${orderId}?token=${originalToken}`)
    expect((await handleStorefrontCheckoutHttp(claimRequest, storefrontDeps()))?.status).toBe(401)
    // This observation is not the new contract: GET API query exchange stays unsupported.
  })
  it('exchanges a real order link before SSR, redirects to a clean URL and emits a separate private cookie', async () => {
    const response = await handleGuestOrderAccessHttp(request(`/pedido/${orderId}?token=${linkClaim}`), deps())
    expect(response?.status).toBe(303)
    expect(response!.headers.get('location')).toBe(`/pedido/${orderId}`)
    expect(response!.headers.get('cache-control')).toBe('private, no-store')
    expect(response!.headers.get('referrer-policy')).toBe('no-referrer')
    const cookie = response!.headers.get('set-cookie')!
    expect(cookie).toMatch(/^neteco-guest-order-access-v1=/)
    expect(cookie).not.toContain(originalToken)
    expect(cookie).not.toContain(linkClaim)
    expect(cookie).toContain('HttpOnly; Secure; SameSite=Lax')
    expect(cookie).toMatch(/Max-Age=(?:[1-9]\d{0,2}|1[0-7]\d{2}|1800);/)
    expect(await response!.text()).toBe('')
  })
  it('accepts only a same-origin explicit POST exchange and never returns the raw link token in JSON', async () => {
    const response = await handleGuestOrderAccessHttp(request(`/api/orders/${orderId}/access`, 'POST'), deps())
    expect(response?.status).toBe(204)
    expect(response!.headers.get('set-cookie')).toContain('neteco-guest-order-access-v1=')
    expect(await response!.text()).toBe('')
  })
  it('authorizes the real immutable snapshot with the separate cookie but not the existing payment facade', async () => {
    const response = await handleGuestOrderAccessHttp(request(`/api/orders/${orderId}/access`, 'POST'), deps())
    expect(response?.status).toBe(204)
    const read = request(`/api/orders/${orderId}`)
    read.headers.set('cookie', response!.headers.get('set-cookie')!.split(';')[0]!)
    const before = fixture.sqlite.prepare('SELECT total_changes() n').get()
    const view = await readD1GuestOrderView(fixture.database, read, orderId, configuration, { now: () => utc() })
    expect(view).toMatchObject({ id: orderId, contactEmail: 'buyer@example.invalid' })
    expect(fixture.sqlite.prepare('SELECT total_changes() n').get()).toEqual(before)
    expect((await handleStorefrontCheckoutHttp(read, storefrontDeps()))?.status).toBe(401)
  })
  it.each(['missing', 'foreign'])('rejects %s POST Origin before private DB access', async (kind) => {
    const candidate = request(`/api/orders/${orderId}/access`, 'POST')
    if (kind === 'missing') candidate.headers.delete('origin')
    else candidate.headers.set('origin', 'https://foreign.invalid')
    const database = {
      prepare: () => {
        throw new Error('unexpected_private_read')
      }
    } as unknown as D1Database
    expect((await handleGuestOrderAccessHttp(candidate, { ...deps(), database }))?.status).toBe(403)
  })
  it('allows navigation without Origin but rejects an explicitly foreign landing origin', async () => {
    const foreign = request(`/pedido/${orderId}?token=${linkClaim}`)
    foreign.headers.set('origin', 'https://foreign.invalid')
    expect((await handleGuestOrderAccessHttp(foreign, deps()))?.status).toBe(403)
    const navigation = request(`/pedido/${orderId}?token=${linkClaim}`)
    navigation.headers.delete('origin')
    expect((await handleGuestOrderAccessHttp(navigation, deps()))?.status).toBe(303)
  })
  it('keeps unknown order and wrong claim indistinguishable without setting a cookie', async () => {
    const wrong = await handleGuestOrderAccessHttp(
      request(`/api/orders/${orderId}/access`, 'POST', '0'.repeat(64)),
      deps()
    )
    const absent = await handleGuestOrderAccessHttp(request(`/api/orders/${clock.uuid()}/access`, 'POST'), deps())
    expect(wrong?.status).toBe(404)
    expect(absent?.status).toBe(404)
    expect(await wrong!.text()).toBe(await absent!.text())
    expect(wrong!.headers.has('set-cookie')).toBe(false)
    expect(absent!.headers.has('set-cookie')).toBe(false)
  })
  it('fails closed on configuration, edge outage and D1 outage without pretending a credential was wrong', async () => {
    const r = () => request(`/api/orders/${orderId}/access`, 'POST')
    expect((await handleGuestOrderAccessHttp(r(), { ...deps(), origin: 'not-a-url' }))?.status).toBe(503)
    expect(
      (
        await handleGuestOrderAccessHttp(r(), {
          ...deps(),
          sessionCookieConfiguration: { password: '', maxAgeSeconds: 30 }
        })
      )?.status
    ).toBe(503)
    expect(
      (
        await handleGuestOrderAccessHttp(r(), {
          ...deps(),
          edgeLimiter: {
            limit: async () => {
              throw new Error('edge_down')
            }
          } as unknown as RateLimit
        })
      )?.status
    ).toBe(503)
    expect(
      (
        await handleGuestOrderAccessHttp(r(), {
          ...deps(),
          database: {
            prepare: () => {
              throw new Error('D1_DOWN_PRIVATE_SENTINEL')
            }
          } as unknown as D1Database
        })
      )?.status
    ).toBe(500)
  })
  it('issuer rejects a guessed original bearer and a bearer from another real order', async () => {
    await expect(
      issueD1GuestOrderLinkClaim(fixture.database, orderId, '0'.repeat(64), configuration, { now: () => utc() })
    ).rejects.toMatchObject({ code: 'not_found' })
    const firstToken = originalToken,
      second = await fixture.order({ owned: false, paid: false, delivered: false })
    await expect(
      issueD1GuestOrderLinkClaim(fixture.database, second, firstToken, configuration, { now: () => utc() })
    ).rejects.toMatchObject({ code: 'not_found' })
    expect(linkClaim).not.toBe(firstToken)
  })
  it('does not renew a valid cookie on reopening the same link, and expires at 30 minutes', async () => {
    const cookie = await guestCookie()
    vi.setSystemTime(clock.date(10 * 60_000))
    const reopen = request(`/pedido/${orderId}?token=${linkClaim}`)
    reopen.headers.set('cookie', cookie)
    const before = fixture.sqlite.prepare('SELECT total_changes() n').get(),
      response = await handleGuestOrderAccessHttp(reopen, deps())
    expect(response?.status).toBe(303)
    expect(response!.headers.has('set-cookie')).toBe(false)
    expect(fixture.sqlite.prepare('SELECT total_changes() n').get()).toEqual(before)
    vi.setSystemTime(clock.date(30 * 60_000))
    expect(
      await readD1GuestOrderView(fixture.database, guestRequest(cookie), orderId, configuration, { now: () => utc() })
    ).toBeNull()
  })
  it('caps re-exchange at the original 24-hour authority, not another 30 minutes', async () => {
    vi.setSystemTime(clock.date((24 * 60 - 10) * 60_000))
    const response = await handleGuestOrderAccessHttp(request(`/api/orders/${orderId}/access`, 'POST'), deps())
    expect(response?.status).toBe(204)
    expect(response!.headers.get('set-cookie')).toContain('Max-Age=600;')
    vi.setSystemTime(clock.date(24 * 60 * 60_000))
    expect((await handleGuestOrderAccessHttp(request(`/api/orders/${orderId}/access`, 'POST'), deps()))?.status).toBe(
      404
    )
    await expect(
      issueD1GuestOrderLinkClaim(fixture.database, orderId, originalToken, configuration, { now: () => utc() })
    ).rejects.toMatchObject({ code: 'not_found' })
  })
  it('global logout revokes the link, both short cookies and the original bearer without money/stock mutations', async () => {
    const first = await guestCookie()
    vi.setSystemTime(clock.date(1000))
    const second = await guestCookie()
    const tables = [
        'order_lines',
        'order_payment_states',
        'payment_intents',
        'inventory_reservations',
        'inventory_balances',
        'inventory_movements'
      ],
      before = tables.map((table) => fixture.sqlite.prepare(`SELECT * FROM ${table}`).all())
    expect(
      await revokeD1GuestOrderAccess(fixture.database, guestRequest(first), configuration, { now: () => utc() })
    ).toContain('Max-Age=0;')
    for (const cookie of [first, second])
      expect(
        await readD1GuestOrderView(fixture.database, guestRequest(cookie), orderId, configuration, { now: () => utc() })
      ).toBeNull()
    expect((await handleGuestOrderAccessHttp(request(`/api/orders/${orderId}/access`, 'POST'), deps()))?.status).toBe(
      404
    )
    expect(await checkout.getOrderView(fixture.database, { orderId, token: originalToken, now: utc() })).toBeNull()
    expect(tables.map((table) => fixture.sqlite.prepare(`SELECT * FROM ${table}`).all())).toEqual(before)
  })
  it('rechecks original authority after the last snapshot await', async () => {
    const cookie = await guestCookie(),
      prepare = fixture.database.prepare.bind(fixture.database)
    let revoked = false
    fixture.database.prepare = (sql: string) => {
      const statement = prepare(sql)
      if (!sql.includes('FROM order_lines WHERE')) return statement
      const original = statement.all.bind(statement)
      statement.all = async <T = Record<string, unknown>>() => {
        const result = await original<T>()
        if (!revoked) {
          revoked = true
          fixture.sqlite.prepare('UPDATE orders SET access_revoked_at=? WHERE id=?').run(utc(), orderId)
        }
        return result
      }
      return statement
    }
    expect(
      await readD1GuestOrderView(fixture.database, guestRequest(cookie), orderId, configuration, { now: () => utc() })
    ).toBeNull()
    expect(revoked).toBe(true)
  })
  it('does not mint a cookie if original authority is revoked during claim exchange', async () => {
    const prepare = fixture.database.prepare.bind(fixture.database)
    let revoked = false
    fixture.database.prepare = (sql: string) => {
      const statement = prepare(sql)
      if (!sql.includes('originalExpiresAt')) return statement
      const original = statement.first.bind(statement)
      statement.first = async (...args: Parameters<typeof statement.first>) => {
        const result = await original(...args)
        if (!revoked) {
          revoked = true
          fixture.sqlite.prepare('UPDATE orders SET access_revoked_at=? WHERE id=?').run(utc(), orderId)
        }
        return result
      }
      return statement
    }
    const response = await handleGuestOrderAccessHttp(request(`/api/orders/${orderId}/access`, 'POST'), deps())
    expect(response?.status).toBe(404)
    expect(response!.headers.has('set-cookie')).toBe(false)
  })
  it('rejects wrong-order, tampered and duplicate cookies without writes', async () => {
    const cookie = await guestCookie(),
      before = fixture.sqlite.prepare('SELECT total_changes() n').get()
    for (const value of [cookie + 'tampered', cookie + '; ' + cookie])
      expect(
        await readD1GuestOrderView(fixture.database, guestRequest(value), orderId, configuration, { now: () => utc() })
      ).toBeNull()
    expect(
      await readD1GuestOrderView(fixture.database, guestRequest(cookie), clock.uuid(), configuration, {
        now: () => utc()
      })
    ).toBeNull()
    expect(fixture.sqlite.prepare('SELECT total_changes() n').get()).toEqual(before)
  })
  it('bounds body/query/method and fails closed at the limiter without D1 access', async () => {
    const database = {
        prepare: () => {
          throw new Error('unexpected_private_read')
        }
      } as unknown as D1Database,
      d = { ...deps(), database }
    expect((await handleGuestOrderAccessHttp(request(`/api/orders/${orderId}/access`), d))?.status).toBe(405)
    expect((await handleGuestOrderAccessHttp(request(`/api/orders/${orderId}/access?x=1`, 'POST'), d))?.status).toBe(
      400
    )
    expect(
      (await handleGuestOrderAccessHttp(request(`/pedido/${orderId}?token=${linkClaim}&token=${linkClaim}`), d))?.status
    ).toBe(400)
    expect(
      (await handleGuestOrderAccessHttp(request(`/api/orders/${orderId}/access`, 'POST', 'a'.repeat(600)), d))?.status
    ).toBe(413)
    expect(
      (
        await handleGuestOrderAccessHttp(request(`/api/orders/${orderId}/access`, 'POST'), {
          ...d,
          edgeLimiter: { limit: async () => ({ success: false }) } as unknown as RateLimit
        })
      )?.status
    ).toBe(429)
    expect(await handleGuestOrderAccessHttp(request(`/pedido/${orderId}`), d)).toBeNull()
  })
  it('exchanges and reads a real unpaid checkout on actual workerd D1 with all current migrations', async () => {
    const runtime = new Miniflare(
      convertV4MiniflareOptions({
        name: 'guest-order-access-native',
        modules: true,
        script: 'export default {fetch(){return new Response("isolated")}}',
        compatibilityDate: '2026-08-15',
        compatibilityFlags: ['nodejs_compat'],
        cf: false,
        telemetry: { enabled: false },
        log: new NoOpLog(),
        d1Databases: { DB: '00000000-0000-4000-8000-000000000008' },
        outboundService: () => {
          throw new Error('unexpected_outbound')
        }
      })
    )
    try {
      const database = (await runtime.getD1Database('DB')) as unknown as D1Database
      for (const name of (await readdir('db/d1/migrations')).filter((n) => /^\d+.*\.sql$/.test(n)).sort()) {
        const statements = splitDemoSql(await readFile('db/d1/migrations/' + name, 'utf8'))
        // Few large batches: per-batch workerd round-trips dominate as migrations accumulate.
        for (let index = 0; index < statements.length; index += 1000)
          await database.batch(statements.slice(index, index + 1000).map((sql) => database.prepare(sql)))
      }
      const seeds: D1PreparedStatement[] = []
      seedInventoryFixture({
        exec(sql: string) {
          for (const statement of splitDemoSql(sql)) seeds.push(database.prepare(statement))
        },
        prepare(sql: string) {
          return {
            run(...parameters: unknown[]) {
              seeds.push(database.prepare(sql).bind(...parameters))
            }
          }
        }
      } as unknown as DatabaseSync)
      await database.batch(seeds)
      const shippingSeed = splitDemoSql(renderD1ShippingSeed())
      for (let index = 0; index < shippingSeed.length; index += 50)
        await database.batch(shippingSeed.slice(index, index + 50).map((sql) => database.prepare(sql)))
      const current = await database.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%SZ','now') now").first<{ now: string }>()
      if (!current) throw new Error('native_clock_unavailable')
      vi.setSystemTime(new Date(current.now))
      const now = () => current.now
      await provisionPublicationValidityFixture(database, {
        productIds: ['p-1'],
        now: '2020-01-01T00:00:00Z',
        validUntil: '2099-01-01T00:00:00Z'
      })
      const cart = await createCart(database, { correlationId: 'guest-native', now: now() })
      await setCartLine(database, {
        cartId: cart.cartId,
        token: cart.token,
        variantId: 'v-1-1',
        quantity: 2,
        expectedVersion: 1,
        idempotencyKey: 'add',
        correlationId: 'guest-native',
        now: now()
      })
      const shipping = await checkout.requestShippingOptions(database, {
          cartId: cart.cartId,
          token: cart.token,
          expectedVersion: 2,
          idempotencyKey: 'shipping',
          correlationId: 'guest-native',
          destination: { city: 'Ontinyent', postalCode: '46870' },
          now: now()
        }),
        quote = await quoteCart(database, {
          cartId: cart.cartId,
          token: cart.token,
          expectedVersion: 2,
          idempotencyKey: 'quote',
          correlationId: 'guest-native',
          now: now()
        })
      if (shipping.outcome !== 'options' || quote.outcome !== 'quoted') throw new Error('native_quote_failed')
      const option = (shipping.body.options as Array<{ optionIndex: number; optionHash: string }>)[0]!
      const placed = await checkout.placeOrder(database, {
        cartId: cart.cartId,
        token: cart.token,
        expectedVersion: 2,
        quoteId: quote.quote.quoteId,
        shippingQuoteId: String(shipping.body.shippingQuoteId),
        selectedOptionIndex: option.optionIndex,
        selectedOptionHash: option.optionHash,
        contactEmail: 'native-guest@example.invalid',
        contactName: 'Synthetic guest',
        contactPhone: '+34600111222',
        shippingAddress: {
          recipientName: 'Synthetic guest',
          line1: 'Carrer sintètic 1',
          city: 'Ontinyent',
          province: 'Valencia',
          postalCode: '46870',
          phone: '+34600111222'
        },
        consentTos: true,
        consentPrivacy: true,
        idempotencyKey: 'checkout',
        correlationId: 'guest-native',
        now: now()
      })
      if (placed.outcome !== 'order_created') throw new Error('native_checkout_failed')
      const id = String(placed.body.id),
        original = String(placed.body.orderToken),
        claim = await issueD1GuestOrderLinkClaim(database, id, original, configuration, { now }),
        incoming = request(`/api/orders/${id}/access`, 'POST', claim),
        response = await handleGuestOrderAccessHttp(incoming, { ...deps(), database, now })
      // Exercise the complete existing outbox/receipt/dispatcher on native D1,
      // with a local fake sender only. No synthetic order or authority inserts.
      await publishEmailOutbox(
        database,
        {
          send: async (message) => {
            expect(await receiveEmailDispatch(database, message, now())).toBe('stored')
          }
        },
        { now: now() }
      )
      const messages: Array<{ html: string; text: string }> = []
      expect(
        await dispatchTransactionalEmails(
          database,
          {
            send: async (message) => {
              messages.push(message)
              return { messageId: 'native-local-fake-email' }
            }
          },
          {
            enabled: true,
            from: 'orders@neteco.test',
            now: now(),
            guestOrderLinks: { publicOrigin: origin, sessionCookieConfiguration: configuration }
          }
        )
      ).toMatchObject({ sent: 1 })
      expect(messages).toHaveLength(1)
      expect(messages[0]!.text).toContain(`${origin}/pedido/${id}?token=${claim}`)
      expect(messages[0]!.html).not.toContain(original)
      expect(response?.status).toBe(204)
      const read = request(`/api/orders/${id}`)
      read.headers.set('cookie', response!.headers.get('set-cookie')!.split(';')[0]!)
      expect(await readD1GuestOrderView(database, read, id, configuration, { now })).toMatchObject({
        id,
        contactEmail: 'native-guest@example.invalid',
        payment: { status: 'awaiting_payment' }
      })
      expect(
        (
          await handleGuestOrderAccessHttp(request(`/api/orders/${id}/access`, 'POST', original), {
            ...deps(),
            database,
            now
          })
        )?.status
      ).toBe(404)
      await revokeD1GuestOrderAccess(database, read, configuration, { now })
      expect(await readD1GuestOrderView(database, read, id, configuration, { now })).toBeNull()
    } finally {
      await runtime.dispose()
    }
    // Applying all 152 migrations to real workerd D1 measures ~11.5 s alone (not reducible by
    // batching: tried 50 vs 1000 statements) and grows with each migration; 20 s flaked under load.
  }, 45000)
})

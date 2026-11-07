import { readFile, readdir } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import { returnsFixture, CLAIMS, BUYER_CLAIMS, CUSTOMER, utc } from './d1-returns-fixture'
import { splitDemoSql } from '../../scripts/lib/d1-demo-sql'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import { handleSalesQuotesHttp, ownsSalesQuotesNamespace } from '../../workers/catalog/sales-quotes-http'
import { reserveInventory, releaseReservation } from '../../workers/catalog/inventory'
import { createCart, setCartLine, quoteCart } from '../../workers/catalog/cart'
import { requestShippingOptions } from '../../workers/catalog/checkout'
import { salesQuoteConversionIntentHash } from '../../shared/sales-quotes'
import { executeD1SalesQuoteCommand, readD1AdminSalesQuote } from '../../workers/catalog/sales-quotes'

const ORIGIN = 'https://sales-quotes.neteco.test'
async function fixture() {
  const f = await returnsFixture()
  try {
    const directory = new URL('../../db/d1/migrations/', import.meta.url)
    const files = (await readdir(directory))
      .filter(
        (name) =>
          /^\d{4}_[a-z0-9_]+\.sql$/.test(name) && Number(name.slice(0, 4)) >= 63 && Number(name.slice(0, 4)) <= 89
      )
      .sort()
    for (const name of files)
      await f.database.batch(
        splitDemoSql(await readFile(new URL(name, directory), 'utf8')).map((sql) => f.database.prepare(sql))
      )
    f.sqlite.exec(
      "INSERT INTO permissions VALUES('catalog.write','catalog','write','Synthetic commercial review'); INSERT INTO role_permissions VALUES('operator','catalog.write')"
    )
    f.sqlite
      .prepare(
        "INSERT INTO identity_mfa(identity_id,encrypted_secret,recovery_code_hashes,verified_at,updated_at) VALUES(?,'synthetic-not-production','[]',?,?)"
      )
      .run(CLAIMS.identityId, utc(-60000), utc(-60000))
    const configuration = { password: 'synthetic-sales-quotes-cookie-password-0123456789abcdef', maxAgeSeconds: 3600 }
    const cookie = (await issueD1SessionCookie(f.database, CLAIMS, configuration))!.split(';')[0]!
    const edgeGate = vi.fn(async () => 'allowed' as const)
    const deps = {
      database: f.database,
      origin: ORIGIN,
      sessionCookieConfiguration: configuration,
      rateLimitPepper: 'synthetic-sales-quotes-rate-pepper-0123456789abcdef',
      edgeGate,
      inventory: {
        reserve: (input: Parameters<typeof reserveInventory>[1]) => reserveInventory(f.database, input),
        release: (input: Parameters<typeof releaseReservation>[1]) => releaseReservation(f.database, input)
      }
    }
    const input = {
      customerId: CUSTOMER,
      lines: [{ variantId: 'v-1-1', quantity: 2 }],
      destination: { city: 'Ontinyent', postalCode: '46870' },
      shippingMethod: 'pickup',
      validUntil: utc(1800000),
      reason: 'Synthetic commercial draft reviewed explicitly'
    }
    const request = (path = '/api/admin/sales-quotes', init: RequestInit = {}) =>
      new Request(`${ORIGIN}${path}`, {
        ...init,
        headers: {
          Cookie: cookie,
          ...(init.method && init.method !== 'GET'
            ? { Origin: ORIGIN, 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() }
            : {}),
          ...init.headers
        }
      })
    return { ...f, deps, cookie, configuration, input, request }
  } catch (error) {
    f.sqlite.close()
    throw error
  }
}

describe('commercial quotes HTTP authority and recovery boundaries', () => {
  it('prepares shipping only through the approved owner quote and rejects client amounts', async () => {
    const f = await fixture()
    try {
      const created = await executeD1SalesQuoteCommand(f.database, CLAIMS, 'create', null, f.input, {
        idempotencyKey: crypto.randomUUID()
      })
      await executeD1SalesQuoteCommand(
        f.database,
        CLAIMS,
        'review',
        created.quoteId,
        { expectedVersion: 1, reason: f.input.reason },
        { idempotencyKey: crypto.randomUUID() }
      )
      const reviewed = await readD1AdminSalesQuote(f.database, CLAIMS, created.quoteId)
      await executeD1SalesQuoteCommand(
        f.database,
        CLAIMS,
        'approve',
        created.quoteId,
        { expectedVersion: 2, reviewedHash: reviewed.reviewedHash, reason: f.input.reason },
        { idempotencyKey: crypto.randomUUID() }
      )
      const snapshot = await readD1AdminSalesQuote(f.database, CLAIMS, created.quoteId)
      const cart = await createCart(f.database, { now: utc(), correlationId: 'shipping-approval-test' })
      await setCartLine(f.database, {
        ...cart,
        now: utc(),
        correlationId: 'shipping-approval-test',
        expectedVersion: 1,
        variantId: 'v-1-1',
        quantity: 2,
        idempotencyKey: crypto.randomUUID()
      })
      const buyer = (await issueD1SessionCookie(f.database, BUYER_CLAIMS, f.configuration))!.split(';')[0]!
      const cookie = `${buyer}; neteco-cart-v2=v1.${cart.cartId}.${cart.token}`
      const path = `/api/account/sales-quotes/${created.quoteId}/shipping-options`
      const body = { expectedVersion: snapshot.version, approvedHash: snapshot.approvedHash }
      const response = await handleSalesQuotesHttp(
        f.request(path, { method: 'POST', headers: { Cookie: cookie }, body: JSON.stringify(body) }),
        f.deps
      )
      expect(response!.status).toBe(200)
      expect(await response!.json()).toMatchObject({
        cartVersion: 2,
        rates: expect.arrayContaining([expect.objectContaining({ profile: 'pickup' })])
      })
      const invalid = await handleSalesQuotesHttp(
        f.request(path, {
          method: 'POST',
          headers: { Cookie: cookie },
          body: JSON.stringify({ ...body, shippingGrossCents: 0 })
        }),
        f.deps
      )
      expect(invalid!.status).toBe(422)
      const noCart = await handleSalesQuotesHttp(
        f.request(path, { method: 'POST', headers: { Cookie: buyer }, body: JSON.stringify(body) }),
        f.deps
      )
      expect(noCart!.status).toBe(401)
      expect(f.sqlite.prepare('SELECT count(*) AS n FROM orders').get()).toEqual({ n: 0 })
      expect(f.sqlite.prepare('SELECT count(*) AS n FROM inventory_reservations').get()).toEqual({ n: 0 })
    } finally {
      f.sqlite.close()
    }
  })
  it('converts with a shared pre-send hash and manually recovers the exact receipt without exposing cookie or server authority', async () => {
    const f = await fixture()
    try {
      const createdResponse = await handleSalesQuotesHttp(
        f.request(undefined, { method: 'POST', body: JSON.stringify(f.input) }),
        f.deps
      )
      expect(createdResponse!.status).toBe(201)
      const created = (await createdResponse!.json()) as { quoteId: string; version: number }
      const reviewedResponse = await handleSalesQuotesHttp(
        f.request(`/api/admin/sales-quotes/${created.quoteId}/commands`, {
          method: 'POST',
          body: JSON.stringify({ action: 'review', expectedVersion: created.version, reason: f.input.reason })
        }),
        f.deps
      )
      expect(reviewedResponse!.status).toBe(201)
      const reviewResponse = await handleSalesQuotesHttp(
        f.request(`/api/admin/sales-quotes/${created.quoteId}`),
        f.deps
      )
      const review = (await reviewResponse!.json()) as { version: number; reviewedHash: string }
      const approvedResponse = await handleSalesQuotesHttp(
        f.request(`/api/admin/sales-quotes/${created.quoteId}/commands`, {
          method: 'POST',
          body: JSON.stringify({
            action: 'approve',
            expectedVersion: review.version,
            reviewedHash: review.reviewedHash,
            reason: f.input.reason
          })
        }),
        f.deps
      )
      expect(approvedResponse!.status).toBe(201)
      const snapshotResponse = await handleSalesQuotesHttp(
        f.request(`/api/admin/sales-quotes/${created.quoteId}`),
        f.deps
      )
      const snapshot = (await snapshotResponse!.json()) as {
        version: number
        approvedHash: string
        total: { grossCents: number }
      }
      const now = utc(),
        cart = await createCart(f.database, { correlationId: 'synthetic-http-conversion', now })
      const common = {
        cartId: cart.cartId,
        token: cart.token,
        now,
        correlationId: 'synthetic-http-conversion',
        expectedVersion: 2
      }
      await setCartLine(f.database, {
        ...common,
        expectedVersion: 1,
        variantId: 'v-1-1',
        quantity: 2,
        idempotencyKey: crypto.randomUUID()
      })
      const quote = await quoteCart(f.database, { ...common, idempotencyKey: crypto.randomUUID() })
      const shipping = await requestShippingOptions(f.database, {
        ...common,
        destination: f.input.destination,
        idempotencyKey: crypto.randomUUID()
      })
      if (quote.outcome !== 'quoted' || shipping.outcome !== 'options')
        throw new Error('synthetic_checkout_fixture_failed')
      const option = (
        shipping.body.options as Array<{ methodCode: string; optionIndex: number; optionHash: string }>
      ).find((item) => item.methodCode === 'pickup')!
      const input = {
        expectedVersion: snapshot.version,
        approvedHash: snapshot.approvedHash,
        checkout: {
          expectedVersion: 2,
          quoteId: quote.quote.quoteId,
          shippingQuoteId: String(shipping.body.shippingQuoteId),
          selectedOptionIndex: option.optionIndex,
          selectedOptionHash: option.optionHash,
          expectedTotalGrossCents: snapshot.total.grossCents,
          contactEmail: 'buyer@example.invalid',
          shippingAddress: {
            recipientName: 'Synthetic buyer',
            line1: 'Synthetic street 1',
            city: 'Ontinyent',
            province: 'Valencia',
            postalCode: '46870',
            phone: '+34600111222'
          },
          consentTos: true,
          consentPrivacy: true
        }
      }
      const hash = await salesQuoteConversionIntentHash(created.quoteId, cart.cartId, input),
        key = crypto.randomUUID()
      const buyerCookie = (await issueD1SessionCookie(f.database, BUYER_CLAIMS, f.configuration))!.split(';')[0]!
      const cookie = `${buyerCookie}; neteco-cart-v2=v1.${cart.cartId}.${cart.token}`
      for (const field of ['phone', 'province'] as const) {
        const shippingAddress: Record<string, unknown> = { ...input.checkout.shippingAddress }
        Reflect.deleteProperty(shippingAddress, field)
        const invalidResponse = await handleSalesQuotesHttp(
          f.request(`/api/account/sales-quotes/${created.quoteId}/convert`, {
            method: 'POST',
            headers: { Cookie: cookie },
            body: JSON.stringify({ ...input, checkout: { ...input.checkout, shippingAddress } })
          }),
          f.deps
        )
        expect(invalidResponse!.status).toBe(422)
        expect(await invalidResponse!.json()).toEqual({ error: { code: 'invalid_input' } })
        expect(f.sqlite.prepare('SELECT count(*) AS n FROM sales_quote_conversions').get()).toEqual({ n: 0 })
        expect(f.sqlite.prepare('SELECT count(*) AS n FROM checkout_attempts').get()).toEqual({ n: 0 })
      }
      const converted = await handleSalesQuotesHttp(
        f.request(`/api/account/sales-quotes/${created.quoteId}/convert`, {
          method: 'POST',
          body: JSON.stringify(input),
          headers: { Cookie: cookie, 'Idempotency-Key': key }
        }),
        f.deps
      )
      expect(converted!.status).toBe(201)
      const receipt = (await converted!.json()) as { payloadHash: string; orderId: string }
      expect(receipt.payloadHash).toBe(hash)
      expect(receipt.orderId).toMatch(/^[a-f0-9-]{36}$/)
      const recovered = await handleSalesQuotesHttp(
        f.request(`/api/account/sales-quotes/commands/${key}`, {
          headers: { Cookie: buyerCookie, 'X-Neteco-Command-Payload-Hash': hash }
        }),
        f.deps
      )
      expect(await recovered!.json()).toEqual({ source: 'cloudflare', outcome: 'applied', receipt })
      expect(f.sqlite.prepare('SELECT count(*) AS n FROM orders').get()).toEqual({ n: 1 })
    } finally {
      f.sqlite.close()
    }
  })
  it('creates a real private draft and replays the exact receipt without a second version or any order/reservation', async () => {
    const f = await fixture()
    try {
      const key = crypto.randomUUID(),
        init = { method: 'POST', body: JSON.stringify(f.input), headers: { 'Idempotency-Key': key } }
      const first = await handleSalesQuotesHttp(f.request(undefined, init), f.deps)
      expect(first!.status).toBe(201)
      expect(first!.headers.get('cache-control')).toContain('no-store')
      const receipt = await first!.json()
      const second = await handleSalesQuotesHttp(f.request(undefined, init), f.deps)
      expect(await second!.json()).toEqual(receipt)
      expect(f.sqlite.prepare('SELECT count(*) AS n FROM sales_quote_versions').get()).toEqual({ n: 1 })
      expect(f.sqlite.prepare('SELECT count(*) AS n FROM orders').get()).toEqual({ n: 0 })
      expect(f.sqlite.prepare('SELECT count(*) AS n FROM inventory_reservations').get()).toEqual({ n: 0 })
    } finally {
      f.sqlite.close()
    }
  })
  it('rejects missing session and a revoked live MFA enrollment', async () => {
    const f = await fixture()
    try {
      const absent = new Request(`${ORIGIN}/api/admin/sales-quotes`)
      expect((await handleSalesQuotesHttp(absent, f.deps))!.status).toBe(401)
      f.sqlite.prepare('DELETE FROM identity_mfa WHERE identity_id=?').run(CLAIMS.identityId)
      expect((await handleSalesQuotesHttp(f.request(), f.deps))!.status).toBe(403)
    } finally {
      f.sqlite.close()
    }
  })
  it('runs edge admission before cookie parsing or D1 and fails closed', async () => {
    const database = new Proxy({} as D1Database, {
      get() {
        throw new Error('D1_must_not_be_accessed')
      }
    })
    const response = await handleSalesQuotesHttp(new Request(`${ORIGIN}/api/admin/sales-quotes`), {
      database,
      origin: ORIGIN,
      sessionCookieConfiguration: null,
      rateLimitPepper: 'synthetic-pepper',
      edgeGate: async () => 'denied',
      inventory: { reserve: vi.fn(), release: vi.fn() }
    })
    expect(response!.status).toBe(429)
    expect(response!.headers.get('cache-control')).toContain('no-store')
  })
  it('rejects alternate request origin even for GET without an Origin header', async () => {
    const f = await fixture()
    try {
      const response = await handleSalesQuotesHttp(
        new Request('https://foreign.neteco.test/api/admin/sales-quotes', { headers: { Cookie: f.cookie } }),
        f.deps
      )
      expect(response!.status).toBe(403)
    } finally {
      f.sqlite.close()
    }
  })
  it('requires exact Origin, CSRF boundary and an idempotency key before a write', async () => {
    const f = await fixture()
    try {
      for (const headers of [
        { Cookie: f.cookie, 'Content-Type': 'application/json' },
        { Cookie: f.cookie, 'Content-Type': 'application/json', Origin: ORIGIN }
      ]) {
        const response = await handleSalesQuotesHttp(
          new Request(`${ORIGIN}/api/admin/sales-quotes`, { method: 'POST', body: JSON.stringify(f.input), headers }),
          f.deps
        )
        expect([400, 403]).toContain(response!.status)
      }
      expect(f.sqlite.prepare('SELECT count(*) AS n FROM sales_quotes').get()).toEqual({ n: 0 })
    } finally {
      f.sqlite.close()
    }
  })
  it('owns encoded/case aliases but rejects them and unsupported methods without reaching core', async () => {
    const f = await fixture()
    try {
      for (const path of ['/api/admin/SALES-QUOTES', '/api/admin/%73ales-quotes', '/api/account/SALES-QUOTES']) {
        expect(ownsSalesQuotesNamespace(path)).toBe(true)
        expect((await handleSalesQuotesHttp(f.request(path), f.deps))!.status).toBe(400)
      }
      expect((await handleSalesQuotesHttp(f.request(undefined, { method: 'DELETE' }), f.deps))!.status).toBe(405)
    } finally {
      f.sqlite.close()
    }
  })
  it('rejects client prices, foreign checkout authority and unbounded/invalid transport bodies', async () => {
    const f = await fixture()
    try {
      const money = await handleSalesQuotesHttp(
        f.request(undefined, {
          method: 'POST',
          body: JSON.stringify({ ...f.input, unitGrossCents: 1, approved: true })
        }),
        f.deps
      )
      expect(money!.status).toBe(422)
      const malformed = await handleSalesQuotesHttp(f.request(undefined, { method: 'POST', body: '{' }), f.deps)
      expect(malformed!.status).toBe(400)
      const huge = await handleSalesQuotesHttp(
        f.request(undefined, { method: 'POST', body: JSON.stringify({ csv: 'a'.repeat(131073) }) }),
        f.deps
      )
      expect(huge!.status).toBe(413)
      expect(f.sqlite.prepare('SELECT count(*) AS n FROM sales_quotes').get()).toEqual({ n: 0 })
    } finally {
      f.sqlite.close()
    }
  })
  it('returns exact actor-bound recovery and denies customer access to another owner without exposing costs', async () => {
    const f = await fixture()
    try {
      const response = await handleSalesQuotesHttp(
        f.request(undefined, { method: 'POST', body: JSON.stringify(f.input) }),
        f.deps
      )
      expect(response!.status).toBe(201)
      const receipt = (await response!.json()) as { quoteId: string; commandId: string; payloadHash: string }
      const recovered = await handleSalesQuotesHttp(
        f.request(`/api/admin/sales-quotes/commands/${receipt.commandId}`, {
          headers: { 'X-Neteco-Command-Payload-Hash': receipt.payloadHash }
        }),
        f.deps
      )
      expect(await recovered!.json()).toEqual({ source: 'cloudflare', outcome: 'applied', receipt })
      const buyerCookie = (await issueD1SessionCookie(f.database, BUYER_CLAIMS, f.configuration))!.split(';')[0]!
      const owned = await handleSalesQuotesHttp(
        f.request(`/api/account/sales-quotes/${receipt.quoteId}`, { headers: { Cookie: buyerCookie } }),
        f.deps
      )
      expect(owned!.status).toBe(200)
      expect(JSON.stringify(await owned!.json())).not.toMatch(/cost|margin|reason|actor|session|token/i)
      const foreignId = crypto.randomUUID(),
        foreignSession = crypto.randomUUID(),
        foreignCustomer = crypto.randomUUID(),
        now = utc(-60000)
      f.sqlite
        .prepare('INSERT INTO customers(id,name,created_at,updated_at) VALUES(?,?,?,?)')
        .run(foreignCustomer, 'Synthetic unrelated buyer', now, now)
      f.sqlite
        .prepare(
          "INSERT INTO identities(id,email,password_hash,email_verified_at,status,customer_id,created_at,updated_at) VALUES(?,?,'synthetic',?,'active',?,?,?)"
        )
        .run(foreignId, 'foreign-http-quote@example.invalid', now, foreignCustomer, now, now)
      f.sqlite
        .prepare(
          'INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at) VALUES(?,?,1,0,?,?)'
        )
        .run(foreignSession, foreignId, now, utc(3600000))
      const foreignCookie = (await issueD1SessionCookie(
        f.database,
        { identityId: foreignId, sessionId: foreignSession, sessionVersion: 1 },
        f.configuration
      ))!.split(';')[0]!
      const foreign = await handleSalesQuotesHttp(
        f.request(`/api/account/sales-quotes/${receipt.quoteId}`, { headers: { Cookie: foreignCookie } }),
        f.deps
      )
      expect(foreign!.status).toBe(404)
    } finally {
      f.sqlite.close()
    }
  })
})

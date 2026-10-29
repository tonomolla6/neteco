import { readFile, readdir } from 'node:fs/promises'
import { applyDeliveryPreferencesMigration } from '../support/delivery-preferences-migration'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { deterministicTestData } from '../fixtures/deterministic'
import { returnsFixture, utc } from './d1-returns-fixture'
import * as checkout from '../../workers/catalog/checkout'
import { publishEmailOutbox, receiveEmailDispatch } from '../../workers/communications/email-outbox'
import { dispatchTransactionalEmails } from '../../workers/communications/transactional-email-delivery'
import { handleGuestOrderAccessHttp } from '../../workers/catalog/guest-order-access-http'
import { issueD1GuestOrderEmailLink, readD1GuestOrderView } from '../../workers/catalog/guest-order-access'

const clock = deterministicTestData('guest-order-email', '2026-10-08T12:00:00Z'),
  origin = 'https://guest-email.neteco.test',
  configuration = { password: 'synthetic-email-guest-cookie-password-over32', maxAgeSeconds: 3600 }
let fixture: Awaited<ReturnType<typeof returnsFixture>>, orderId: string, originalToken: string, eventId: string
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(clock.date())
  fixture = await returnsFixture()
  // Control only SQLite's wall clock; the production source/proof/guard SQL is
  // executed unchanged otherwise, including time advancing inside an await.
  fixture.sqlite.function('guest_email_now', () => utc())
  const database = fixture.database
  fixture.database = {
    ...database,
    prepare: (sql: string) =>
      database.prepare(sql.replaceAll("strftime('%Y-%m-%dT%H:%M:%SZ','now')", 'guest_email_now()'))
  } as D1Database
  for (const name of (await readdir(new URL('../../db/d1/migrations/', import.meta.url))).sort()) {
    if (/^006[3-6]_.*\.sql$/.test(name))
      fixture.sqlite.exec(await readFile(new URL(`../../db/d1/migrations/${name}`, import.meta.url), 'utf8'))
  }
  await applyDeliveryPreferencesMigration(fixture.sqlite)
  const placeOrder = checkout.placeOrder
  vi.spyOn(checkout, 'placeOrder').mockImplementation(async (...args) => {
    const result = await placeOrder(...args)
    if (result.outcome === 'order_created') originalToken = String(result.body.orderToken)
    return result
  })
  orderId = await fixture.order({ owned: false, paid: false, delivered: false })
  eventId = String(fixture.sqlite.prepare('SELECT id FROM email_outbox_events WHERE source_id=?').get(orderId)!.id)
  await publishEmailOutbox(fixture.database, { send: async () => {} }, { now: utc() })
  expect(
    await receiveEmailDispatch(fixture.database, { type: 'email.dispatch.requested', version: 1, eventId }, utc())
  ).toBe('stored')
})
afterEach(() => {
  fixture?.sqlite.close()
  vi.restoreAllMocks()
  vi.useRealTimers()
})
const settings = () => ({
  enabled: true,
  from: 'orders@neteco.test',
  now: utc(),
  guestOrderLinks: { publicOrigin: origin, sessionCookieConfiguration: { ...configuration } }
})
const sender = () => ({
  send: vi.fn(async (_message: { to: string; html: string; text: string }) => ({ messageId: 'fake-local-only' }))
})
function link(text: string) {
  const url = text.match(/https:\/\/guest-email\.neteco\.test\/pedido\/[a-f0-9-]+\?token=[a-f0-9]{64}/)?.[0]
  expect(url, 'real rendered email must contain the operable view-only link').toBeTruthy()
  return new URL(url!)
}
function durableSnapshot() {
  return JSON.stringify(
    ['email_outbox_events', 'email_outbox_delivery', 'email_dispatch_inbox', 'transactional_email_deliveries'].map(
      (table) => fixture.sqlite.prepare(`SELECT * FROM ${table}`).all()
    )
  )
}
function intercept(before: (sql: string) => void): D1Database {
  const database = fixture.database
  const decorate = (statement: D1PreparedStatement, sql: string): D1PreparedStatement =>
    ({
      ...statement,
      bind: (...args: unknown[]) => decorate(statement.bind(...args), sql),
      first: async <T = Record<string, unknown>>() => {
        before(sql)
        return statement.first<T>()
      }
    }) as D1PreparedStatement
  return { ...database, prepare: (sql: string) => decorate(database.prepare(sql), sql) } as D1Database
}

describe('real committed guest checkout to existing transactional email', () => {
  it('renders a separate view-only link which exchanges and reads the original real order', async () => {
    const transport = sender(),
      domain = () =>
        JSON.stringify(
          ['orders', 'order_lines', 'inventory_reservations', 'payment_intents', 'payment_events'].map((table) =>
            fixture.sqlite.prepare(`SELECT * FROM ${table}`).all()
          )
        ),
      before = domain()
    expect(await dispatchTransactionalEmails(fixture.database, transport, settings())).toMatchObject({ sent: 1 })
    const message = transport.send.mock.calls[0]![0],
      url = link(message.text)
    expect(url.pathname).toBe(`/pedido/${orderId}`)
    expect(url.searchParams.get('token')).not.toBe(originalToken)
    expect(message.html).toContain(`href="${url.href}"`)
    expect(message.text).toContain('sólo permite consultar')
    expect(JSON.stringify(message)).not.toContain(originalToken)
    expect(durableSnapshot()).not.toContain(url.searchParams.get('token')!)
    expect(durableSnapshot()).not.toContain(originalToken)
    const response = await handleGuestOrderAccessHttp(
      new Request(url, { headers: { 'CF-Connecting-IP': '192.0.2.168' } }),
      {
        database: fixture.database,
        origin,
        edgeLimiter: { limit: async () => ({ success: true }) } as unknown as RateLimit,
        rateLimitPepper: 'synthetic-email-guest-limiter-pepper-over32',
        sessionCookieConfiguration: configuration,
        now: () => utc()
      }
    )
    expect(response?.status).toBe(303)
    const request = new Request(`${origin}/api/orders/${orderId}`, {
      headers: { cookie: response!.headers.get('set-cookie')!.split(';')[0]! }
    })
    expect(
      await readD1GuestOrderView(fixture.database, request, orderId, configuration, { now: () => utc() })
    ).toMatchObject({ id: orderId })
    // The original facade remains bearer/customer-only; the short cookie does not grant payment authority.
    await expect(
      checkout.getOrderView(fixture.database, { orderId, token: url.searchParams.get('token')!, now: utc() })
    ).resolves.toBeNull()
    expect(domain()).toBe(before)
  })
  it('does not elevate an outbox reference without its confirmed checkout command', async () => {
    // Corrupt authority deliberately inside this disposable database, not an
    // alternative seed for a successful order. The real order/event remain.
    fixture.sqlite
      .prepare(
        "DELETE FROM checkout_commands WHERE kind='checkout' AND cart_id=(SELECT cart_id FROM orders WHERE id=?)"
      )
      .run(orderId)
    const transport = sender()
    await expect(
      issueD1GuestOrderEmailLink(fixture.database, eventId, settings().guestOrderLinks)
    ).rejects.toMatchObject({ code: 'not_found' })
    expect(await dispatchTransactionalEmails(fixture.database, transport, settings())).toMatchObject({
      sent: 0,
      retryable: 1
    })
    expect(transport.send).not.toHaveBeenCalled()
  })
  it('never treats a caller hash or an unknown event ID as issuance authority', async () => {
    await expect(
      issueD1GuestOrderEmailLink(fixture.database, originalToken, settings().guestOrderLinks)
    ).rejects.toMatchObject({ code: 'not_found' })
    await expect(
      issueD1GuestOrderEmailLink(fixture.database, `email:${originalToken}`, settings().guestOrderLinks)
    ).rejects.toMatchObject({ code: 'not_found' })
  })
  it('does not add guest credentials to an account-owned order', async () => {
    const owned = await fixture.order({ owned: true, paid: false, delivered: false }),
      event = String(fixture.sqlite.prepare('SELECT id FROM email_outbox_events WHERE source_id=?').get(owned)!.id)
    expect(await issueD1GuestOrderEmailLink(fixture.database, event, settings().guestOrderLinks)).toBeNull()
  })
  it('keeps disabled work durable without invoking the sender or requiring link configuration', async () => {
    const transport = sender(),
      before = durableSnapshot()
    expect(
      await dispatchTransactionalEmails(fixture.database, transport, {
        ...settings(),
        enabled: false,
        guestOrderLinks: { publicOrigin: 'bad', sessionCookieConfiguration: { password: '', maxAgeSeconds: 0 } }
      })
    ).toMatchObject({ disabled: true, sent: 0 })
    expect(transport.send).not.toHaveBeenCalled()
    expect(durableSnapshot()).toBe(before)
  })
  it.each(['expired', 'revoked'])('sends only the ordinary reference when original access is %s', async (kind) => {
    if (kind === 'expired') vi.setSystemTime(clock.date(24 * 3600_000))
    else fixture.sqlite.prepare('UPDATE orders SET access_revoked_at=? WHERE id=?').run(utc(), orderId)
    const transport = sender()
    expect(await dispatchTransactionalEmails(fixture.database, transport, settings())).toMatchObject({ sent: 1 })
    expect(transport.send.mock.calls[0]![0].text).not.toContain('?token=')
    expect(transport.send.mock.calls[0]![0].text).toContain(orderId)
  })
  it.each(['publicOrigin', 'secret'])('fails closed without sending for invalid %s configuration', async (kind) => {
    const transport = sender(),
      config = settings()
    if (kind === 'publicOrigin') config.guestOrderLinks.publicOrigin = 'https://evil.test/path?private=1'
    else config.guestOrderLinks.sessionCookieConfiguration.password = ''
    expect(await dispatchTransactionalEmails(fixture.database, transport, config)).toMatchObject({
      sent: 0,
      retryable: 1
    })
    expect(transport.send).not.toHaveBeenCalled()
    expect(durableSnapshot()).not.toContain('private=1')
  })
  it('rechecks revocation inside the sending marker and does not hand a stale link to the sender', async () => {
    let changed = false
    const database = intercept((sql) => {
        if (!changed && sql.includes("SET status = 'sending'")) {
          changed = true
          fixture.sqlite.prepare('UPDATE orders SET access_revoked_at=? WHERE id=?').run(utc(), orderId)
        }
      }),
      transport = sender()
    expect(await issueD1GuestOrderEmailLink(database, eventId, settings().guestOrderLinks)).not.toBeNull()
    await dispatchTransactionalEmails(database, transport, settings())
    expect(changed).toBe(true)
    expect(transport.send).not.toHaveBeenCalled()
  })
  it('rechecks original expiry at the sending marker after time advances during preparation', async () => {
    vi.setSystemTime(clock.date(24 * 3600_000 - 1000))
    let changed = false
    const database = intercept((sql) => {
        if (!changed && sql.includes("SET status = 'sending'")) {
          changed = true
          vi.setSystemTime(clock.date(24 * 3600_000))
        }
      }),
      transport = sender()
    expect(await issueD1GuestOrderEmailLink(database, eventId, settings().guestOrderLinks)).not.toBeNull()
    await dispatchTransactionalEmails(database, transport, settings())
    expect(changed).toBe(true)
    expect(transport.send).not.toHaveBeenCalled()
  })
  it('does not send twice on receipt/dispatch replay, or retry an ambiguous accepted email', async () => {
    const transport = sender()
    transport.send.mockImplementationOnce(async () => {
      throw new Error('synthetic accepted acknowledgement lost')
    })
    expect(await dispatchTransactionalEmails(fixture.database, transport, settings())).toMatchObject({
      manualReview: 1
    })
    link(transport.send.mock.calls[0]![0].text)
    await receiveEmailDispatch(fixture.database, { type: 'email.dispatch.requested', version: 1, eventId }, utc())
    await dispatchTransactionalEmails(fixture.database, transport, settings())
    expect(transport.send).toHaveBeenCalledOnce()
    expect(fixture.sqlite.prepare('SELECT count(*) n FROM transactional_email_deliveries').get()!.n).toBe(1)
  })
})

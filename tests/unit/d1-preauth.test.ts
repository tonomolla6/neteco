import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fakePreauthProvider, payExtFixture, redsysConfig, signedEnvelope, utc } from './pay-ext-fixture'
import { BUYER_CLAIMS, CLAIMS } from './d1-returns-fixture'
import {
  cancelPreauthorization,
  capturePreauthorization,
  processPreauthNotification,
  requestPreauthorization,
  sweepPreauthorizations,
  type PreauthDependencies
} from '../../workers/payments/preauth'
import { decodeMerchantParameters } from '../../workers/payments/redsys'
import { initiateRedsysPayment } from '../../workers/catalog/payments'

let f: Awaited<ReturnType<typeof payExtFixture>>
let provider: ReturnType<typeof fakePreauthProvider>
let clockOffset = 0
const deps = (): PreauthDependencies => ({
  database: f.database,
  configuration: redsysConfig,
  provider,
  inventory: f.inventory,
  now: () => utc(clockOffset)
})
const JUSTIFICATION = 'Made-to-order dilution needs a hold until the batch is confirmed'
beforeEach(async () => {
  f = await payExtFixture()
  provider = fakePreauthProvider()
  clockOffset = 0
  f.sqlite.exec(`UPDATE auth_sessions SET expires_at='${utc(40 * 86_400_000)}'`)
})
afterEach(() => f?.sqlite.close())

async function requested(over: Record<string, unknown> = {}) {
  const { orderId, token } = await f.unpaid()
  const total = (f.sqlite.prepare('SELECT total_gross_cents t FROM orders WHERE id=?').get(orderId) as { t: number }).t
  const view = await requestPreauthorization(
    CLAIMS,
    {
      orderId,
      commandId: crypto.randomUUID(),
      reasonCode: 'made_to_order',
      justification: JUSTIFICATION,
      expectedAmountCents: total,
      ...over
    },
    deps()
  )
  return { orderId, token, total, view }
}
async function authorize(view: { id: string }) {
  const row = f.sqlite
    .prepare('SELECT merchant_order m, amount_cents a FROM payment_preauths WHERE id=?')
    .get(view.id) as {
    m: string
    a: number
  }
  return processPreauthNotification(await signedEnvelope(row.m, row.a, { type: '1' }), deps())
}
async function authorized() {
  const base = await requested()
  expect((await authorize(base.view)).outcome).toBe('authorized')
  const row = f.sqlite.prepare('SELECT version v FROM payment_preauths WHERE id=?').get(base.view.id) as { v: number }
  return { ...base, version: row.v }
}
const status = (id: string) =>
  (f.sqlite.prepare('SELECT status FROM payment_preauths WHERE id=?').get(id) as { status: string }).status
const op = (version: number) => ({ commandId: crypto.randomUUID(), expectedVersion: version })

describe('request', () => {
  it('creates a justified type-1 redirect for the server amount and audits it', async () => {
    const { view, total, orderId } = await requested()
    expect(view).toMatchObject({ orderId, amountCents: total, status: 'requested', version: 1 })
    const params = decodeMerchantParameters(view.redirect!.fields.Ds_MerchantParameters)
    expect(params.DS_MERCHANT_TRANSACTIONTYPE).toBe('1')
    expect(params.DS_MERCHANT_AMOUNT).toBe(String(total))
    expect(params.DS_MERCHANT_MERCHANTURL).toContain('/api/payments/redsys/preauth-notification')
    expect(f.sqlite.prepare('SELECT event,actor_id FROM payment_preauth_events').all()).toHaveLength(1)
    expect(f.sqlite.prepare('SELECT count(*) n FROM payment_intents').get()).toMatchObject({ n: 0 })
  })
  it('is idempotent per command id', async () => {
    const { orderId, token, total } = await f.unpaid().then(async (x) => ({
      ...x,
      total: (f.sqlite.prepare('SELECT total_gross_cents t FROM orders WHERE id=?').get(x.orderId) as { t: number }).t
    }))
    void token
    const input = {
      orderId,
      commandId: crypto.randomUUID(),
      reasonCode: 'credit_review' as const,
      justification: JUSTIFICATION,
      expectedAmountCents: total
    }
    const first = await requestPreauthorization(CLAIMS, input, deps())
    const second = await requestPreauthorization(CLAIMS, input, deps())
    expect(second.id).toBe(first.id)
    expect(f.sqlite.prepare('SELECT count(*) n FROM payment_preauths').get()).toMatchObject({ n: 1 })
    await expect(
      requestPreauthorization(CLAIMS, { ...input, reasonCode: 'assisted_sale' }, deps())
    ).rejects.toMatchObject({ code: 'conflict' })
  })
  it('requires live administrator authority with MFA', async () => {
    const { orderId, total } = await (async () => {
      const x = await f.unpaid()
      return {
        ...x,
        total: (f.sqlite.prepare('SELECT total_gross_cents t FROM orders WHERE id=?').get(x.orderId) as { t: number }).t
      }
    })()
    const input = {
      orderId,
      commandId: crypto.randomUUID(),
      reasonCode: 'made_to_order',
      justification: JUSTIFICATION,
      expectedAmountCents: total
    }
    await expect(requestPreauthorization(null, input, deps())).rejects.toMatchObject({ code: 'unauthenticated' })
    await expect(requestPreauthorization(BUYER_CLAIMS, input, deps())).rejects.toMatchObject({ code: 'forbidden' })
    f.sqlite.exec('UPDATE auth_sessions SET mfa_verified=0')
    await expect(requestPreauthorization(CLAIMS, input, deps())).rejects.toMatchObject({ code: 'forbidden' })
    f.sqlite.exec('UPDATE auth_sessions SET mfa_verified=1')
    f.sqlite.exec('DELETE FROM identity_roles')
    await expect(requestPreauthorization(CLAIMS, input, deps())).rejects.toMatchObject({ code: 'forbidden' })
    expect(f.sqlite.prepare('SELECT count(*) n FROM payment_preauths').get()).toMatchObject({ n: 0 })
  })
  it('rejects client-supplied money, free-text reasons and short justifications', async () => {
    const { orderId, total } = await (async () => {
      const x = await f.unpaid()
      return {
        ...x,
        total: (f.sqlite.prepare('SELECT total_gross_cents t FROM orders WHERE id=?').get(x.orderId) as { t: number }).t
      }
    })()
    const base = {
      orderId,
      commandId: crypto.randomUUID(),
      reasonCode: 'made_to_order',
      justification: JUSTIFICATION,
      expectedAmountCents: total
    }
    for (const bad of [
      { reasonCode: 'because' },
      { justification: 'too short' },
      { amountCents: 1 },
      { requestedBy: 'x' },
      { expectedAmountCents: 0 },
      { orderId: 'x' }
    ])
      await expect(requestPreauthorization(CLAIMS, { ...base, ...bad }, deps())).rejects.toMatchObject({
        code: 'invalid_input'
      })
    await expect(
      requestPreauthorization(CLAIMS, { ...base, expectedAmountCents: total + 1 }, deps())
    ).rejects.toMatchObject({ code: 'conflict' })
  })
  it('refuses an order that is paid, being paid, expired or unknown', async () => {
    const live = await f.unpaid()
    const total = (
      f.sqlite.prepare('SELECT total_gross_cents t FROM orders WHERE id=?').get(live.orderId) as { t: number }
    ).t
    await initiateRedsysPayment(
      f.database,
      {
        orderId: live.orderId,
        orderToken: live.token,
        method: 'card',
        now: utc(),
        correlationId: 'c',
        idempotencyKey: 'k'
      },
      redsysConfig
    )
    const input = {
      orderId: live.orderId,
      commandId: crypto.randomUUID(),
      reasonCode: 'made_to_order',
      justification: JUSTIFICATION,
      expectedAmountCents: total
    }
    await expect(requestPreauthorization(CLAIMS, input, deps())).rejects.toMatchObject({ code: 'not_payable' })
    const unknown = { ...input, orderId: crypto.randomUUID(), commandId: crypto.randomUUID() }
    await expect(requestPreauthorization(CLAIMS, unknown, deps())).rejects.toMatchObject({ code: 'not_payable' })
    f.sqlite.exec(`UPDATE inventory_reservations SET status='expired',expired_at='${utc()}'`)
    const fresh = { ...input, commandId: crypto.randomUUID() }
    await expect(requestPreauthorization(CLAIMS, fresh, deps())).rejects.toMatchObject({ code: 'not_payable' })
  })
  it('allows only one live pre-authorisation per order and blocks an ordinary payment meanwhile', async () => {
    const { orderId, token, total } = await requested()
    const input = {
      orderId,
      commandId: crypto.randomUUID(),
      reasonCode: 'made_to_order',
      justification: JUSTIFICATION,
      expectedAmountCents: total
    }
    await expect(requestPreauthorization(CLAIMS, input, deps())).rejects.toMatchObject({ code: 'conflict' })
    await expect(
      initiateRedsysPayment(
        f.database,
        { orderId, orderToken: token, method: 'card', now: utc(), correlationId: 'c', idempotencyKey: 'k' },
        redsysConfig
      )
    ).rejects.toBeDefined()
    expect(f.sqlite.prepare('SELECT count(*) n FROM payment_intents').get()).toMatchObject({ n: 0 })
  })
})

describe('authorisation notification', () => {
  it('authorises, extends the stock reservation over the hold and records an event', async () => {
    const { view } = await authorized()
    const row = f.sqlite
      .prepare('SELECT status,authorized_until,provider_reference FROM payment_preauths WHERE id=?')
      .get(view.id) as Record<string, string>
    expect(row.status).toBe('authorized')
    expect(Date.parse(row.authorized_until!)).toBeGreaterThan(Date.now() + 6 * 86_400_000)
    const reservation = f.sqlite.prepare('SELECT status,expires_at FROM inventory_reservations').get() as Record<
      string,
      string
    >
    expect(reservation.status).toBe('reserved')
    expect(reservation.expires_at >= row.authorized_until!).toBe(true)
    expect(
      f.sqlite
        .prepare('SELECT event FROM payment_preauth_events WHERE preauth_id=? ORDER BY version')
        .all(view.id)
        .map((r) => r.event)
    ).toEqual(['requested', 'authorized'])
  })
  it('is idempotent for a repeated notification', async () => {
    const { view } = await authorized()
    expect((await authorize(view)).outcome).toBe('replayed')
    expect(f.sqlite.prepare('SELECT count(*) n FROM payment_preauth_events').get()).toMatchObject({ n: 2 })
  })
  it('rejects forged, ordinary-type, foreign-terminal and unknown notifications', async () => {
    const { view } = await requested()
    const row = f.sqlite.prepare('SELECT merchant_order m, amount_cents a FROM payment_preauths').get() as {
      m: string
      a: number
    }
    const forged = await signedEnvelope(row.m, row.a, { type: '1' })
    await expect(
      processPreauthNotification({ ...forged, Ds_Signature: forged.Ds_Signature.slice(1) + 'A' }, deps())
    ).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(
      processPreauthNotification(await signedEnvelope(row.m, row.a, { type: '0' }), deps())
    ).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(
      processPreauthNotification(await signedEnvelope('9999ZZZZ', row.a, { type: '1' }), deps())
    ).rejects.toMatchObject({ code: 'not_found' })
    expect(status(view.id)).toBe('requested')
  })
  it('does not authorise when the amount differs', async () => {
    const { view } = await requested()
    const row = f.sqlite.prepare('SELECT merchant_order m, amount_cents a FROM payment_preauths').get() as {
      m: string
      a: number
    }
    expect(
      (await processPreauthNotification(await signedEnvelope(row.m, row.a - 1, { type: '1' }), deps())).outcome
    ).toBe('mismatch')
    expect(status(view.id)).toBe('requested')
  })
  it('marks a declined authorisation failed and allows a new request', async () => {
    const { view, orderId, total } = await requested()
    const row = f.sqlite.prepare('SELECT merchant_order m, amount_cents a FROM payment_preauths').get() as {
      m: string
      a: number
    }
    expect(
      (await processPreauthNotification(await signedEnvelope(row.m, row.a, { type: '1', response: '0190' }), deps()))
        .outcome
    ).toBe('failed')
    expect(status(view.id)).toBe('failed')
    const again = await requestPreauthorization(
      CLAIMS,
      {
        orderId,
        commandId: crypto.randomUUID(),
        reasonCode: 'made_to_order',
        justification: JUSTIFICATION,
        expectedAmountCents: total
      },
      deps()
    )
    expect(again.status).toBe('requested')
  })
  it('re-extends the stock reservation on redelivery when the first attempt failed', async () => {
    const { view } = await requested()
    const failing = {
      ...deps(),
      inventory: { ...f.inventory, renew: async () => Promise.reject(new Error('inventory down')) }
    }
    const row = f.sqlite.prepare('SELECT merchant_order m, amount_cents a FROM payment_preauths').get() as {
      m: string
      a: number
    }
    const envelope = await signedEnvelope(row.m, row.a, { type: '1' })
    expect((await processPreauthNotification(envelope, failing)).outcome).toBe('unavailable')
    expect(status(view.id)).toBe('authorized')
    expect((await processPreauthNotification(envelope, deps())).outcome).toBe('replayed')
    const reservation = f.sqlite.prepare('SELECT expires_at FROM inventory_reservations').get() as {
      expires_at: string
    }
    const until = (f.sqlite.prepare('SELECT authorized_until u FROM payment_preauths').get() as { u: string }).u
    expect(reservation.expires_at >= until).toBe(true)
  })
  it('voids the hold when the stock reservation can no longer be extended', async () => {
    const { view } = await requested()
    f.sqlite.exec(`UPDATE inventory_reservations SET status='expired',expired_at='${utc()}'`)
    expect((await authorize(view)).outcome).toBe('cancelled')
    expect(status(view.id)).toBe('cancelled')
    expect(provider.cancelCalls).toBe(1)
  })
  it('voids a late hold that arrives after the request expired, and audits it', async () => {
    const { view } = await requested()
    clockOffset = 2 * 3_600_000
    await sweepPreauthorizations(deps())
    expect(status(view.id)).toBe('expired')
    expect((await authorize(view)).outcome).toBe('cancelled')
    expect(status(view.id)).toBe('cancelled')
    expect(provider.cancelCalls).toBe(1)
    expect(
      f.sqlite
        .prepare('SELECT event FROM payment_preauth_events WHERE preauth_id=? ORDER BY version')
        .all(view.id)
        .map((r) => r.event)
    ).toEqual(['requested', 'request_expired', 'late_authorization', 'cancelled'])
    expect((await authorize(view)).outcome).toBe('replayed')
    expect(provider.cancelCalls).toBe(1)
  })
})

describe('capture', () => {
  it('captures once, assigns stock, marks the order paid and replays idempotently', async () => {
    const { view, version, orderId, total } = await authorized()
    const input = op(version)
    const done = await capturePreauthorization(CLAIMS, view.id, input, deps())
    expect(done).toMatchObject({ status: 'captured', outcome: 'captured' })
    expect(status(view.id)).toBe('captured')
    expect(
      f.sqlite.prepare('SELECT status,paid_gross_cents p FROM order_payment_states WHERE order_id=?').get(orderId)
    ).toMatchObject({ status: 'paid', p: total })
    expect(f.sqlite.prepare('SELECT status FROM inventory_reservations').get()).toMatchObject({ status: 'assigned' })
    expect(
      f.sqlite.prepare("SELECT count(*) n FROM order_events WHERE event_type='payment_captured'").get()
    ).toMatchObject({ n: 1 })
    const replay = await capturePreauthorization(CLAIMS, view.id, input, deps())
    expect(replay.status).toBe('captured')
    expect(provider.captureCalls).toBe(1)
    await expect(
      capturePreauthorization(CLAIMS, view.id, { ...input, expectedVersion: version + 1 }, deps())
    ).rejects.toMatchObject({ code: 'conflict' })
  })
  it('serialises concurrent captures with CAS: one provider call, one winner', async () => {
    const { view, version } = await authorized()
    const results = await Promise.allSettled([
      capturePreauthorization(CLAIMS, view.id, op(version), deps()),
      capturePreauthorization(CLAIMS, view.id, op(version), deps())
    ])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(provider.captureCalls).toBe(1)
    expect(
      f.sqlite.prepare("SELECT count(*) n FROM order_events WHERE event_type='payment_captured'").get()
    ).toMatchObject({ n: 1 })
  })
  it('keeps the claim when the provider is unavailable and resumes with the same command', async () => {
    const { view, version } = await authorized()
    const input = op(version)
    provider.failNextCapture = 1
    await expect(capturePreauthorization(CLAIMS, view.id, input, deps())).rejects.toMatchObject({ code: 'unavailable' })
    expect(status(view.id)).toBe('capture_pending')
    await expect(capturePreauthorization(CLAIMS, view.id, op(version), deps())).rejects.toMatchObject({
      code: 'conflict'
    })
    expect((await capturePreauthorization(CLAIMS, view.id, input, deps())).status).toBe('captured')
    expect([...provider.captures.keys()]).toHaveLength(1)
  })
  it('is resumed by the scheduled sweep when the admin never retries', async () => {
    const { view, version } = await authorized()
    provider.failNextCapture = 1
    await capturePreauthorization(CLAIMS, view.id, op(version), deps()).catch(() => undefined)
    expect((await sweepPreauthorizations(deps())).resumed).toBe(0) // too recent
    clockOffset = 120_000
    expect((await sweepPreauthorizations(deps())).resumed).toBe(1)
    expect(status(view.id)).toBe('captured')
  })
  it('returns to authorized when the bank rejects the capture', async () => {
    const { view, version } = await authorized()
    provider.rejectCapture = true
    const result = await capturePreauthorization(CLAIMS, view.id, op(version), deps())
    expect(result).toMatchObject({ status: 'authorized', outcome: 'rejected' })
    expect(f.sqlite.prepare('SELECT status FROM order_payment_states').all()).toHaveLength(0)
    expect(f.sqlite.prepare('SELECT status FROM inventory_reservations').get()).toMatchObject({ status: 'reserved' })
  })
  it('flags a stock exception when the reservation is gone after the money moved', async () => {
    const { view, version, orderId } = await authorized()
    f.sqlite.exec(`UPDATE inventory_reservations SET status='released',released_at='${utc()}'`)
    const result = await capturePreauthorization(CLAIMS, view.id, op(version), deps())
    expect(result.outcome).toBe('stock_exception')
    expect(f.sqlite.prepare('SELECT status FROM order_payment_states WHERE order_id=?').get(orderId)).toMatchObject({
      status: 'stock_exception'
    })
  })
  it('refuses after the hold window, without authority, or on a stale version', async () => {
    const { view, version } = await authorized()
    await expect(capturePreauthorization(BUYER_CLAIMS, view.id, op(version), deps())).rejects.toMatchObject({
      code: 'forbidden'
    })
    await expect(capturePreauthorization(CLAIMS, view.id, op(version + 5), deps())).rejects.toMatchObject({
      code: 'conflict'
    })
    await expect(
      capturePreauthorization(CLAIMS, view.id, { commandId: 'bad', expectedVersion: version }, deps())
    ).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(
      capturePreauthorization(CLAIMS, view.id, { ...op(version), amountCents: 1 }, deps())
    ).rejects.toMatchObject({ code: 'invalid_input' })
    clockOffset = 8 * 86_400_000
    await expect(capturePreauthorization(CLAIMS, view.id, op(version), deps())).rejects.toMatchObject({
      code: 'conflict'
    })
    expect(provider.captureCalls).toBe(0)
  })
  it('does not capture a request that was never authorised', async () => {
    const { view } = await requested()
    await expect(capturePreauthorization(CLAIMS, view.id, op(1), deps())).rejects.toMatchObject({ code: 'conflict' })
    await expect(capturePreauthorization(CLAIMS, crypto.randomUUID(), op(1), deps())).rejects.toMatchObject({
      code: 'not_found'
    })
  })
})

describe('cancel and expiry', () => {
  it('cancels once, voids at the bank, releases stock and ends the order payment', async () => {
    const { view, version, orderId } = await authorized()
    const input = op(version)
    expect((await cancelPreauthorization(CLAIMS, view.id, input, deps())).status).toBe('cancelled')
    expect((await cancelPreauthorization(CLAIMS, view.id, input, deps())).status).toBe('cancelled')
    expect(provider.cancelCalls).toBe(1)
    expect(f.sqlite.prepare('SELECT status FROM inventory_reservations').get()).toMatchObject({ status: 'released' })
    expect(f.sqlite.prepare('SELECT status FROM order_payment_states WHERE order_id=?').get(orderId)).toMatchObject({
      status: 'cancelled'
    })
  })
  it('keeps the stock reserved while the bank refuses the void', async () => {
    const { view, version } = await authorized()
    provider.rejectCancel = true
    await expect(cancelPreauthorization(CLAIMS, view.id, op(version), deps())).rejects.toMatchObject({
      code: 'unavailable'
    })
    expect(status(view.id)).toBe('cancel_pending')
    expect(f.sqlite.prepare('SELECT status FROM inventory_reservations').get()).toMatchObject({ status: 'reserved' })
  })
  it('lets exactly one of capture and cancel win a race', async () => {
    const { view, version } = await authorized()
    const results = await Promise.allSettled([
      capturePreauthorization(CLAIMS, view.id, op(version), deps()),
      cancelPreauthorization(CLAIMS, view.id, op(version), deps())
    ])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(['captured', 'cancelled']).toContain(status(view.id))
    expect(provider.captureCalls + provider.cancelCalls).toBe(1)
  })
  it('expires an unanswered request without touching stock or the order state', async () => {
    const { view } = await requested()
    clockOffset = 2 * 3_600_000
    const report = await sweepPreauthorizations(deps())
    expect(report.expired).toBe(1)
    expect(status(view.id)).toBe('expired')
    expect(f.sqlite.prepare('SELECT status FROM inventory_reservations').get()).toMatchObject({ status: 'reserved' })
    expect(f.sqlite.prepare('SELECT count(*) n FROM order_payment_states').get()).toMatchObject({ n: 0 })
    expect(provider.cancelCalls).toBe(0)
  })
  it('expires a lapsed hold, frees the stock and never captures it afterwards', async () => {
    const { view, version, orderId } = await authorized()
    clockOffset = 8 * 86_400_000
    expect((await sweepPreauthorizations(deps())).expired).toBe(1)
    expect(status(view.id)).toBe('expired')
    expect(f.sqlite.prepare('SELECT status FROM order_payment_states WHERE order_id=?').get(orderId)).toMatchObject({
      status: 'cancelled'
    })
    expect(provider.cancelCalls).toBe(1)
    await expect(capturePreauthorization(CLAIMS, view.id, op(version), deps())).rejects.toMatchObject({
      code: 'conflict'
    })
    expect((await sweepPreauthorizations(deps())).expired).toBe(0)
  })
  it('does not expire holds that are still valid', async () => {
    const { view } = await authorized()
    expect(await sweepPreauthorizations(deps())).toEqual({ expired: 0, resumed: 0, failed: 0 })
    expect(status(view.id)).toBe('authorized')
  })
})

describe('database invariants', () => {
  it('rejects illegal transitions, version jumps and audit tampering', async () => {
    const { view } = await authorized()
    expect(() =>
      f.sqlite.prepare("UPDATE payment_preauths SET status='captured',version=version+1 WHERE id=?").run(view.id)
    ).toThrow(/invalid_preauth_transition/)
    expect(() =>
      f.sqlite.prepare("UPDATE payment_preauths SET status='capture_pending',version=version+2 WHERE id=?").run(view.id)
    ).toThrow()
    expect(() => f.sqlite.prepare('UPDATE payment_preauths SET amount_cents=1 WHERE id=?').run(view.id)).toThrow()
    expect(() => f.sqlite.exec('DELETE FROM payment_preauth_events')).toThrow(/append_only/)
    expect(() => f.sqlite.exec("UPDATE payment_preauth_commands SET action='cancel'")).toThrow(/append_only/)
    expect(() => f.sqlite.exec('DELETE FROM payment_preauths')).toThrow(/append_only/)
  })
  it('never stores card data', async () => {
    await authorized()
    const dump =
      JSON.stringify(f.sqlite.prepare('SELECT * FROM payment_preauths').all()) +
      JSON.stringify(f.sqlite.prepare('SELECT * FROM payment_preauth_events').all())
    expect(dump).not.toMatch(/\b\d{13,19}\b/)
  })
})

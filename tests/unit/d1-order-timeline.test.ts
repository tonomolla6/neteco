import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { returnsFixture, CLAIMS, BUYER_CLAIMS, utc } from './d1-returns-fixture'
import * as returnsFixtures from './d1-returns-fixture'
import { refundsCreditFixture, REASON } from './d1-refunds-credit-fixture'
import { queueD1CreditNote, dispatchD1CreditNotes } from '../../workers/fiscal/credit-notes'
import * as checkout from '../../workers/catalog/checkout'
import { initiateRedsysPayment, processRedsysNotification } from '../../workers/catalog/payments'
import { encodeMerchantParameters, signMerchantParameters } from '../../workers/payments/redsys'
import { REDSYS_OFFICIAL_CONTRACT } from '../fixtures/redsys-official'
import { readD1OrderTimeline } from '../../workers/catalog/order-timeline'
import { cancelD1UnpaidOrder } from '../../workers/catalog/order-cancellation'
import {
  encodeOrderTimelineCursor,
  decodeOrderTimelineCursor,
  orderTimelineResponseSchema
} from '../../shared/order-timeline'
import { deterministicTestData } from '../fixtures/deterministic'
import type { DatabaseSync } from 'node:sqlite'
const data = deterministicTestData('order-timeline', '2026-10-08T12:00:00Z')
let f: Awaited<ReturnType<typeof returnsFixture>>, orderId: string, orderToken: string
const opened: DatabaseSync[] = []
beforeEach(async () => {
  vi.useFakeTimers()
  vi.setSystemTime(data.date())
  f = await returnsFixture()
  opened.push(f.sqlite)
  f.sqlite.function('timeline_test_clock', () => utc())
  const prepare = f.database.prepare.bind(f.database)
  f.database.prepare = (sql: string) => prepare(sql.replaceAll("'now'", 'timeline_test_clock()'))
  const place = checkout.placeOrder
  vi.spyOn(checkout, 'placeOrder').mockImplementation(async (...args) => {
    const result = await place(...args)
    if (result.outcome === 'order_created') orderToken = String(result.body.orderToken)
    return result
  })
  orderId = await f.order({ paid: false, delivered: false })
})
afterEach(() => {
  opened.splice(0).forEach((db) => db.close())
  vi.useRealTimers()
  vi.restoreAllMocks()
})
const read = (audience: 'customer' | 'admin' = 'customer', options: Record<string, unknown> = {}) =>
  readD1OrderTimeline(f.database, audience === 'customer' ? BUYER_CLAIMS : CLAIMS, orderId, {
    audience,
    appEnvironment: 'local',
    now: () => utc(),
    ...options
  })
async function financialFixture() {
  vi.spyOn(returnsFixtures, 'returnsFixture').mockResolvedValueOnce(f)
  return refundsCreditFixture()
}
function afterEvents(action: () => void) {
  const original = f.database.prepare.bind(f.database)
  return new Proxy(f.database, {
    get(target, key) {
      if (key === 'prepare')
        return (sql: string) => {
          const statement = original(sql)
          if (!sql.includes('timeline_events')) return statement
          return {
            bind(...args: unknown[]) {
              const bound = statement.bind(...args)
              return {
                async all() {
                  const result = await bound.all()
                  action()
                  return result
                }
              }
            }
          }
        }
      const value = Reflect.get(target, key)
      return typeof value === 'function' ? value.bind(target) : value
    }
  }) as D1Database
}
describe('unified confirmed order timeline', () => {
  it('projects a real unpaid cancellation with its governed receipt, without exposing its reason or writing', async () => {
    const commandId = data.uuid()
    const reason = 'El comprador solicita cancelar antes de iniciar ningún pago.'
    await cancelD1UnpaidOrder(
      f.database,
      BUYER_CLAIMS,
      orderId,
      commandId,
      { expectedStatus: 'awaiting_payment', reason },
      { audience: 'customer', now: () => utc() }
    )
    const before = f.sqlite.prepare('SELECT total_changes() n').get()
    const owner = await read()
    expect(owner.items.filter((item) => item.kind === 'checkout').map((item) => item.state)).toEqual([
      'cancelled',
      'created'
    ])
    expect((await read('admin')).items).toEqual(owner.items)
    expect(JSON.stringify(owner)).not.toContain(reason)
    expect(f.sqlite.prepare('SELECT total_changes() n').get()).toEqual(before)
  })
  it('refuses a cancellation projection whose command fingerprint no longer matches its immutable audit', async () => {
    const commandId = data.uuid()
    await cancelD1UnpaidOrder(
      f.database,
      BUYER_CLAIMS,
      orderId,
      commandId,
      { expectedStatus: 'awaiting_payment', reason: 'Cancelación explícita antes de iniciar el pago.' },
      { audience: 'customer', now: () => utc() }
    )
    f.sqlite
      .prepare('UPDATE payment_commands SET payload_hash=? WHERE order_id=? AND command_id=?')
      .run('0'.repeat(64), orderId, commandId)
    await expect(read()).rejects.toMatchObject({ code: 'read_unconfirmed' })
  })
  it('preserves independently authorised payment attempts without implying a second local capture', async () => {
    const config = {
      environment: 'sandbox' as const,
      merchantCode: REDSYS_OFFICIAL_CONTRACT.sandbox.merchantCode,
      terminal: REDSYS_OFFICIAL_CONTRACT.sandbox.terminal,
      secretKey: REDSYS_OFFICIAL_CONTRACT.sandbox.secretKey,
      merchantName: 'NETECO',
      bizumEnabled: false,
      publicBaseUrl: 'https://timeline.neteco.test'
    }
    const input = {
      orderId,
      orderToken,
      method: 'card' as const,
      now: utc(),
      correlationId: 'timeline-payment',
      idempotencyKey: 'timeline-first'
    }
    const first = await initiateRedsysPayment(f.database, input, config)
    async function notification(intentId: string, response: string) {
      const intent = f.sqlite
        .prepare('SELECT merchant_order,amount_gross_cents FROM payment_intents WHERE id=?')
        .get(intentId) as { merchant_order: string; amount_gross_cents: number }
      const parameters = encodeMerchantParameters({
        Ds_Order: intent.merchant_order,
        Ds_Amount: String(intent.amount_gross_cents),
        Ds_Currency: '978',
        Ds_MerchantCode: config.merchantCode,
        Ds_Terminal: config.terminal,
        Ds_TransactionType: '0',
        Ds_Response: response
      })
      return {
        Ds_MerchantParameters: parameters,
        Ds_SignatureVersion: 'HMAC_SHA512_V2',
        Ds_Signature: await signMerchantParameters(parameters, config.secretKey)
      }
    }
    await processRedsysNotification(
      f.database,
      await notification(String(first.body.paymentIntentId), '0101'),
      config,
      { now: utc(), correlationId: 'declined' }
    )
    const second = await initiateRedsysPayment(f.database, { ...input, idempotencyKey: 'timeline-second' }, config)
    await processRedsysNotification(
      f.database,
      await notification(String(first.body.paymentIntentId), '0000'),
      config,
      { now: utc(), correlationId: 'first-authorised' }
    )
    await processRedsysNotification(
      f.database,
      await notification(String(second.body.paymentIntentId), '0000'),
      config,
      { now: utc(), correlationId: 'second-authorised' }
    )
    const timeline = await read('customer', { limit: 20 })
    expect(
      timeline.items.filter((item) => item.kind === 'payment' && item.state === 'provider_authorised')
    ).toHaveLength(2)
    expect(timeline.items.filter((item) => item.kind === 'payment' && item.state === 'captured')).toHaveLength(1)
  })
  it('reads actual checkout for active owner without MFA and safe matching admin DTO, without writes', async () => {
    const before = f.sqlite.prepare('SELECT total_changes() n').get()
    const customer = await read(),
      admin = await read('admin')
    expect(customer).toMatchObject({
      source: 'cloudflare',
      orderId,
      audience: 'customer',
      items: [{ kind: 'checkout', state: 'created', createdAt: utc(), validationOnly: null }],
      nextCursor: null
    })
    expect(customer.items).toEqual(admin.items)
    expect(Object.keys(customer.items[0]!).sort()).toEqual(['createdAt', 'id', 'kind', 'state', 'validationOnly'])
    expect(JSON.stringify(customer)).not.toMatch(/actor|reason|email|payload|hash|amount|address|correlation/)
    expect(f.sqlite.prepare('SELECT total_changes() n').get()).toEqual(before)
  })
  it('paginates stable timestamp ties with snapshot cutoff, strict scope and no duplicate events', async () => {
    // Immutable checkout events without a matching completed command are not facts.
    const completed = await financialFixture()
    const first = await readD1OrderTimeline(completed.database, BUYER_CLAIMS, completed.orderId, {
      audience: 'customer',
      appEnvironment: 'local',
      limit: 2,
      now: () => utc()
    })
    expect(first.items).toHaveLength(2)
    expect(first.nextCursor).not.toBeNull()
    const cursor = decodeOrderTimelineCursor(first.nextCursor!)
    vi.advanceTimersByTime(1000)
    await completed.completed()
    const rest = await readD1OrderTimeline(completed.database, BUYER_CLAIMS, completed.orderId, {
      audience: 'customer',
      appEnvironment: 'local',
      limit: 20,
      cursor: first.nextCursor!,
      now: () => utc(1000)
    })
    expect(new Set([...first.items, ...rest.items].map((item) => item.id)).size).toBe(
      first.items.length + rest.items.length
    )
    expect([...first.items, ...rest.items].map((item) => item.createdAt + '|' + item.id)).toEqual(
      [...first.items, ...rest.items]
        .map((item) => item.createdAt + '|' + item.id)
        .sort()
        .reverse()
    )
    expect(cursor.asOf).toBe(utc(-1000))
    expect(rest.items.some((item) => item.kind === 'refund')).toBe(false)
    await expect(
      readD1OrderTimeline(completed.database, CLAIMS, completed.orderId, {
        audience: 'admin',
        appEnvironment: 'local',
        cursor: first.nextCursor!,
        now: () => utc()
      })
    ).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(read('customer', { cursor: first.nextCursor! })).rejects.toMatchObject({ code: 'invalid_input' })
  })
  it('merges real governed payment/fulfillment/return/refund/fiscal/credit and distinguishes local validation', async () => {
    const completed = await financialFixture()
    const refund = await completed.completed()
    await queueD1CreditNote(completed.database, CLAIMS, refund.id, {
      idempotencyKey: data.uuid(),
      policyId: completed.creditPolicy.id,
      reason: REASON,
      evidenceRef: 'synthetic-explicit-local-case'
    })
    await dispatchD1CreditNotes(completed.database, completed.creditProvider, completed.storage, {
      now: utc(),
      appEnvironment: 'local',
      policyId: completed.creditPolicy.id,
      enabled: true,
      localValidationEnabled: true
    })
    const result = await readD1OrderTimeline(completed.database, BUYER_CLAIMS, completed.orderId, {
      audience: 'customer',
      appEnvironment: 'local',
      limit: 20,
      now: () => utc()
    })
    expect([...new Set(result.items.map((item) => item.kind))].sort()).toEqual([
      'checkout',
      'credit',
      'fiscal',
      'fulfillment',
      'payment',
      'refund',
      'return'
    ])
    expect(
      result.items
        .filter((item) => ['refund', 'fiscal', 'credit'].includes(item.kind))
        .every((item) => item.validationOnly === true)
    ).toBe(true)
    const production = await readD1OrderTimeline(completed.database, CLAIMS, completed.orderId, {
      audience: 'admin',
      appEnvironment: 'production',
      limit: 20,
      now: () => utc()
    })
    expect(production.items.some((item) => item.validationOnly === true)).toBe(false)
    expect(JSON.stringify(result)).not.toMatch(/actorId|reason|buyer@|amount|payload|storage|provider_reference/)
  })
  it('ignores forged unsupported events and unconfirmed source receipts, rather than inferring status', async () => {
    f.sqlite
      .prepare("INSERT INTO order_events VALUES(?,?,'made_up_paid','{}','synthetic',?)")
      .run(data.uuid(), orderId, utc())
    f.sqlite
      .prepare("INSERT INTO order_events VALUES(?,?,'invoice.issued','{}','synthetic',?)")
      .run(data.uuid(), orderId, utc())
    expect((await read()).items.map((item) => item.kind)).toEqual(['checkout'])
  })
  it('excludes future events regardless of supplied cursor cutoff', async () => {
    const cursor = encodeOrderTimelineCursor({
      v: 1,
      orderId,
      audience: 'customer',
      asOf: utc(1000),
      at: utc(),
      id: 'checkout:zzz'
    })
    await expect(read('customer', { cursor })).rejects.toMatchObject({ code: 'invalid_input' })
  })
  it('enforces active owner and gives foreign/unknown orders the same not-found result', async () => {
    const foreignOrder = await f.order({ owned: false, paid: false, delivered: false })
    await expect(
      readD1OrderTimeline(f.database, BUYER_CLAIMS, foreignOrder, {
        audience: 'customer',
        appEnvironment: 'local',
        now: () => utc()
      })
    ).rejects.toMatchObject({ code: 'not_found' })
    await expect(
      readD1OrderTimeline(f.database, BUYER_CLAIMS, data.uuid(), {
        audience: 'customer',
        appEnvironment: 'local',
        now: () => utc()
      })
    ).rejects.toMatchObject({ code: 'not_found' })
    f.sqlite.exec("UPDATE customers SET status='blocked'")
    await expect(read()).rejects.toMatchObject({ code: 'unauthenticated' })
  })
  it.each([
    ["UPDATE auth_sessions SET revoked_at='2026-10-08T12:00:00Z'", 'unauthenticated'],
    ['UPDATE identities SET email_verified_at=NULL', 'unauthenticated'],
    ['UPDATE identities SET session_version=2', 'unauthenticated'],
    ["UPDATE customers SET status='blocked'", 'unauthenticated']
  ])('rechecks live customer authority after awaited timeline %s', async (sql, code) => {
    await expect(
      readD1OrderTimeline(
        afterEvents(() => f.sqlite.exec(sql)),
        BUYER_CLAIMS,
        orderId,
        { audience: 'customer', appEnvironment: 'local', now: () => utc() }
      )
    ).rejects.toMatchObject({ code })
  })
  it.each([
    ["UPDATE auth_sessions SET revoked_at='2026-10-08T12:00:00Z'", 'unauthenticated'],
    ['UPDATE identities SET email_verified_at=NULL', 'email_unverified'],
    ['UPDATE auth_sessions SET mfa_verified=0', 'mfa_required'],
    ['DELETE FROM identity_roles', 'forbidden']
  ])('rechecks admin email/MFA/grant/session after await %s', async (sql, code) => {
    await expect(
      readD1OrderTimeline(
        afterEvents(() => f.sqlite.exec(sql)),
        CLAIMS,
        orderId,
        { audience: 'admin', appEnvironment: 'local', now: () => utc() }
      )
    ).rejects.toMatchObject({ code })
  })
  it('uses a fresh final clock and refuses elapsed session expiry', async () => {
    await expect(
      readD1OrderTimeline(
        afterEvents(() => vi.advanceTimersByTime(3600001)),
        BUYER_CLAIMS,
        orderId,
        { audience: 'customer', appEnvironment: 'local' }
      )
    ).rejects.toMatchObject({ code: 'unauthenticated' })
  })
  it.each([0, 21, 1.5, NaN])('rejects invalid page bound %s', async (limit) => {
    await expect(read('customer', { limit })).rejects.toMatchObject({ code: 'invalid_input' })
  })
  it.each(['bad', 'x'.repeat(769), 'eyJ2IjoxfQ'])('rejects invalid cursor %#', async (cursor) => {
    await expect(read('customer', { cursor })).rejects.toMatchObject({ code: 'invalid_input' })
  })
  it('rejects wrong-scope cursor, extra private metadata and unknown financial validation', () => {
    const item = { id: 'checkout:abc', kind: 'checkout', state: 'created', createdAt: utc(), validationOnly: null }
    const response = { source: 'cloudflare', orderId, audience: 'customer', items: [item], nextCursor: null }
    expect(
      orderTimelineResponseSchema.safeParse({ ...response, items: [{ ...item, actorId: 'private' }] }).success
    ).toBe(false)
    expect(
      orderTimelineResponseSchema.safeParse({ ...response, items: [{ ...item, kind: 'refund', state: 'succeeded' }] })
        .success
    ).toBe(false)
    expect(
      orderTimelineResponseSchema.safeParse({
        ...response,
        nextCursor: encodeOrderTimelineCursor({
          v: 1,
          orderId: data.uuid(),
          audience: 'customer',
          asOf: utc(),
          at: utc(),
          id: item.id
        })
      }).success
    ).toBe(false)
  })
})

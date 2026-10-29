import { afterEach, beforeEach, expect, it } from 'vitest'
import { packingFixture, createPackingOrder, CLAIMS, REASON, utc } from './d1-order-packing-fixture'
import { deterministicTestData } from '../fixtures/deterministic'
import { executeD1AdminPackingCommand } from '../../workers/fulfillment/packing'
import { executeD1AdminFulfillmentCommand } from '../../workers/fulfillment/admin'
import { readD1OrderTracking } from '../../workers/fulfillment/tracking'
import { orderTrackingSchema } from '../../shared/order-tracking'
import { issueD1GuestOrderLinkClaim, exchangeD1GuestOrderAccess } from '../../workers/catalog/guest-order-access'

let f: Awaited<ReturnType<typeof packingFixture>>
let originalToken: string
const data = deterministicTestData('order-tracking')
const admin = { kind: 'admin' as const, claims: CLAIMS }
beforeEach(async () => {
  f = await packingFixture({
    onOrderCreated: (order) => {
      originalToken = order.orderToken
    }
  })
})
afterEach(() => f?.sqlite.close())
async function pack() {
  await executeD1AdminPackingCommand(
    f.database,
    CLAIMS,
    f.orderId,
    {
      action: 'pack',
      expectedVersion: 0,
      expectedFulfillmentVersion: 1,
      reason: REASON,
      parcels: [
        { weightGrams: 1000, widthMm: 100, heightMm: 100, depthMm: 100, contents: [{ lineIndex: 0, quantity: 4 }] }
      ]
    },
    { idempotencyKey: data.uuid() }
  )
}
it('reads actual fulfillment and honest absent packing readonly, without a fictitious carrier', async () => {
  const before = f.economic()
  const result = await readD1OrderTracking(f.database, admin, f.orderId)
  expect(orderTrackingSchema.safeParse(result).success).toBe(true)
  expect(result).toMatchObject({
    source: 'cloudflare',
    audience: 'admin',
    fulfillment: { state: 'picking', version: 1 },
    packing: { parcelCount: 0, recordedAt: null },
    shipments: [],
    carrierEvents: [],
    carrierStatus: 'not_connected'
  })
  expect(f.economic()).toEqual(before)
})
it('projects a real manual shipment without economic, private reason, label or provider fields', async () => {
  await pack()
  await executeD1AdminFulfillmentCommand(
    f.database,
    CLAIMS,
    f.orderId,
    { action: 'packed', expectedVersion: 1, reason: REASON },
    { idempotencyKey: data.uuid() }
  )
  await executeD1AdminPackingCommand(
    f.database,
    CLAIMS,
    f.orderId,
    {
      action: 'manual_dispatch',
      expectedVersion: 1,
      expectedFulfillmentVersion: 2,
      reason: REASON,
      actualNetCents: 999,
      taxBps: 2100,
      shipments: [
        {
          parcelIndex: 0,
          carrier: 'Synthetic carrier',
          shipmentNumber: 'PRIVATE-SHIP',
          trackingNumber: 'TRACK-1',
          externalLabelReference: 'PRIVATE-LABEL'
        }
      ]
    },
    { idempotencyKey: data.uuid() }
  )
  const before = f.economic(),
    result = await readD1OrderTracking(f.database, admin, f.orderId)
  expect(result.shipments).toEqual([
    {
      parcelIndex: 0,
      carrier: 'Synthetic carrier',
      trackingNumber: 'TRACK-1',
      recordedAt: expect.any(String),
      verification: 'manual_unverified'
    }
  ])
  for (const secret of ['PRIVATE-SHIP', 'PRIVATE-LABEL', REASON, 'actualNetCents', 'token'])
    expect(JSON.stringify(result)).not.toContain(secret)
  expect(f.economic()).toEqual(before)
})
it('authorizes the real active checkout customer and uniformly hides a foreign order', async () => {
  const customer = data.uuid(),
    identity = data.uuid(),
    session = data.uuid(),
    now = utc(-60000)
  f.sqlite.prepare('INSERT INTO customers(id,created_at,updated_at) VALUES(?,?,?)').run(customer, now, now)
  f.sqlite
    .prepare(
      "INSERT INTO identities(id,email,password_hash,status,email_verified_at,customer_id,created_at,updated_at) VALUES(?,'tracking@example.invalid','synthetic','active',?,?,?,?)"
    )
    .run(identity, now, customer, now, now)
  f.sqlite
    .prepare('INSERT INTO auth_sessions(id,identity_id,session_version,created_at,expires_at) VALUES(?,?,1,?,?)')
    .run(session, identity, now, utc(3600000))
  const claims = { identityId: identity, sessionId: session, sessionVersion: 1 }
  const id = await createPackingOrder(f.database, { ownerSession: claims })
  expect(await readD1OrderTracking(f.database, { kind: 'customer', claims }, id)).toMatchObject({
    audience: 'customer',
    orderId: id
  })
  await expect(readD1OrderTracking(f.database, { kind: 'customer', claims }, f.orderId)).rejects.toMatchObject({
    code: 'not_found'
  })
})
it('accepts only the separate live sealed guest grant and rechecks order revocation', async () => {
  const configuration = { password: 'synthetic-tracking-guest-password-over32', maxAgeSeconds: 3600 }
  const link = await issueD1GuestOrderLinkClaim(f.database, f.orderId, originalToken, configuration)
  const cookie = await exchangeD1GuestOrderAccess(
    f.database,
    new Request('https://tracking.neteco.test'),
    f.orderId,
    link,
    configuration
  )
  if (!cookie) throw new Error('tracking_fixture_guest_cookie_missing')
  const request = new Request('https://tracking.neteco.test', { headers: { cookie: cookie.split(';')[0]! } })
  expect(await readD1OrderTracking(f.database, { kind: 'guest', request, configuration }, f.orderId)).toMatchObject({
    audience: 'guest'
  })
  f.sqlite.prepare('UPDATE orders SET access_revoked_at=? WHERE id=?').run(utc(), f.orderId)
  await expect(
    readD1OrderTracking(f.database, { kind: 'guest', request, configuration }, f.orderId)
  ).rejects.toMatchObject({ code: 'not_found' })
})
it('fails closed on historical packing corruption even when version counts still match', async () => {
  await pack()
  f.sqlite.exec('DROP TRIGGER order_packing_audit_no_update')
  f.sqlite.prepare('UPDATE order_packing_audit SET payload_hash=? WHERE order_id=?').run('0'.repeat(64), f.orderId)
  await expect(readD1OrderTracking(f.database, admin, f.orderId)).rejects.toMatchObject({ code: 'history_unconfirmed' })
})
it('fails closed on older fulfillment corruption, not merely the latest projection', async () => {
  await executeD1AdminFulfillmentCommand(
    f.database,
    CLAIMS,
    f.orderId,
    { action: 'packed', expectedVersion: 1, reason: REASON },
    { idempotencyKey: data.uuid() }
  )
  f.sqlite.exec('DROP TRIGGER order_fulfillment_audit_no_update')
  f.sqlite
    .prepare("UPDATE order_fulfillment_audit SET reason='Corrupted historical reason' WHERE result_version=1")
    .run()
  await expect(readD1OrderTracking(f.database, admin, f.orderId)).rejects.toMatchObject({ code: 'history_unconfirmed' })
})
it('rechecks session and grants at the final authoritative read', async () => {
  let reads = 0
  const database = new Proxy(f.database, {
    get(db, key) {
      if (key === 'prepare')
        return (sql: string) => {
          if (sql.includes('gate_clock') && ++reads === 2)
            f.sqlite.prepare('UPDATE auth_sessions SET revoked_at=? WHERE id=?').run(utc(), CLAIMS.sessionId)
          return db.prepare(sql)
        }
      const value = Reflect.get(db, key)
      return typeof value === 'function' ? value.bind(db) : value
    }
  })
  await expect(readD1OrderTracking(database, admin, f.orderId)).rejects.toMatchObject({ code: 'unauthenticated' })
})
it.each(['revoked_session', 'changed_owner'] as const)(
  'rechecks customer %s in the final atomic read',
  async (change) => {
    const customer = data.uuid(),
      identity = data.uuid(),
      session = data.uuid(),
      foreignCustomer = data.uuid(),
      now = utc(-60000)
    f.sqlite.prepare('INSERT INTO customers(id,created_at,updated_at) VALUES(?,?,?)').run(customer, now, now)
    f.sqlite.prepare('INSERT INTO customers(id,created_at,updated_at) VALUES(?,?,?)').run(foreignCustomer, now, now)
    f.sqlite
      .prepare(
        "INSERT INTO identities(id,email,password_hash,status,email_verified_at,customer_id,created_at,updated_at) VALUES(?,'tracking-race@example.invalid','synthetic','active',?,?,?,?)"
      )
      .run(identity, now, customer, now, now)
    f.sqlite
      .prepare('INSERT INTO auth_sessions(id,identity_id,session_version,created_at,expires_at) VALUES(?,?,1,?,?)')
      .run(session, identity, now, utc(3600000))
    const claims = { identityId: identity, sessionId: session, sessionVersion: 1 }
    const id = await createPackingOrder(f.database, { ownerSession: claims })
    let reads = 0
    const database = new Proxy(f.database, {
      get(db, key) {
        if (key === 'prepare')
          return (sql: string) => {
            if (sql.includes('gate_clock') && ++reads === 2) {
              if (change === 'revoked_session')
                f.sqlite.prepare('UPDATE auth_sessions SET revoked_at=? WHERE id=?').run(utc(), session)
              else f.sqlite.prepare('UPDATE identities SET customer_id=? WHERE id=?').run(foreignCustomer, identity)
            }
            return db.prepare(sql)
          }
        const value = Reflect.get(db, key)
        return typeof value === 'function' ? value.bind(db) : value
      }
    })
    await expect(readD1OrderTracking(database, { kind: 'customer', claims }, id)).rejects.toMatchObject({
      code: change === 'revoked_session' ? 'unauthenticated' : 'not_found'
    })
  }
)
it('does not accept expired, foreign or original checkout guest credentials', async () => {
  const configuration = { password: 'synthetic-tracking-guest-password-over32', maxAgeSeconds: 3600 }
  const link = await issueD1GuestOrderLinkClaim(f.database, f.orderId, originalToken, configuration)
  const cookie = await exchangeD1GuestOrderAccess(
    f.database,
    new Request('https://tracking.neteco.test'),
    f.orderId,
    link,
    configuration
  )
  if (!cookie) throw new Error('tracking_fixture_guest_cookie_missing')
  const request = new Request('https://tracking.neteco.test', { headers: { cookie: cookie.split(';')[0]! } })
  const access = { kind: 'guest' as const, request, configuration }
  await expect(readD1OrderTracking(f.database, access, data.uuid())).rejects.toMatchObject({ code: 'not_found' })
  await expect(readD1OrderTracking(f.database, access, f.orderId, { now: utc(31 * 60000) })).rejects.toMatchObject({
    code: 'not_found'
  })
  const legacy = new Request('https://tracking.neteco.test', {
    headers: { cookie: `neteco-order-access-v2=v1.${f.orderId}.${originalToken}` }
  })
  await expect(readD1OrderTracking(f.database, { ...access, request: legacy }, f.orderId)).rejects.toMatchObject({
    code: 'not_found'
  })
})
it('reads genuine pending fulfillment with no packing, without manufacturing an event or timestamp', async () => {
  const id = await createPackingOrder(f.database, { paid: false })
  const result = await readD1OrderTracking(f.database, admin, id)
  expect(result.fulfillment).toEqual({ state: 'pending', version: 0, updatedAt: null })
  expect(result.packing).toEqual({ parcelCount: 0, recordedAt: null })
})
it('rejects revoked grants and unavailable D1 without substituting empty tracking', async () => {
  f.sqlite.prepare('DELETE FROM identity_roles WHERE identity_id=?').run(CLAIMS.identityId)
  await expect(readD1OrderTracking(f.database, admin, f.orderId)).rejects.toMatchObject({ code: 'forbidden' })
  const broken = new Proxy(f.database, {
    get(db, key) {
      if (key === 'prepare')
        return () => {
          throw new Error('synthetic_database_unavailable')
        }
      const value = Reflect.get(db, key)
      return typeof value === 'function' ? value.bind(db) : value
    }
  })
  await expect(readD1OrderTracking(broken, admin, f.orderId)).rejects.toMatchObject({ code: 'service_unavailable' })
})

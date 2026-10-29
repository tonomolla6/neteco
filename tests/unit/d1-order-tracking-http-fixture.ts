import { packingFixture, createPackingOrder, CLAIMS, REASON, utc } from './d1-order-packing-fixture'
import { executeD1AdminPackingCommand } from '../../workers/fulfillment/packing'
import { issueD1SessionCookie, type SessionCookieConfiguration } from '../../workers/auth/session-cookie'
import { issueD1GuestOrderEmailLink, exchangeD1GuestOrderAccess } from '../../workers/catalog/guest-order-access'

export { CLAIMS, utc }
export const BUYER = {
  identityId: '10000000-0000-4000-8000-000000000070',
  sessionId: '20000000-0000-4000-8000-000000000070',
  sessionVersion: 1
}
export const FOREIGN = {
  identityId: '10000000-0000-4000-8000-000000000071',
  sessionId: '20000000-0000-4000-8000-000000000071',
  sessionVersion: 1
}
export const configuration = { password: 'synthetic-tracking-password-more-than-32', maxAgeSeconds: 3600 }
export const origin = 'https://tracking.neteco.test'
export async function seedTrackingBuyers(database: D1Database, now = utc(-60000)) {
  for (const [index, claims] of [BUYER, FOREIGN].entries()) {
    const customer = `30000000-0000-4000-8000-00000000007${index}`
    await database.batch([
      database
        .prepare("INSERT INTO customers(id,name,created_at,updated_at) VALUES(?,'Synthetic buyer',?,?)")
        .bind(customer, now, now),
      database
        .prepare(
          "INSERT INTO identities(id,email,password_hash,email_verified_at,status,customer_id,created_at,updated_at) VALUES(?,?,'synthetic',?,'active',?,?,?)"
        )
        .bind(claims.identityId, `tracking-${index}@example.invalid`, now, customer, now, now),
      database
        .prepare(
          "INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at) VALUES(?,?,1,0,?,'2099-01-01T00:00:00Z')"
        )
        .bind(claims.sessionId, claims.identityId, now)
    ])
  }
}

/** Packing commands are the only way the fixture records these declarations. */
export async function recordTrackingPacking(database: D1Database, orderId: string) {
  await executeD1AdminPackingCommand(
    database,
    CLAIMS,
    orderId,
    {
      action: 'pack',
      expectedVersion: 0,
      expectedFulfillmentVersion: 2,
      reason: REASON,
      parcels: [0, 1].map(() => ({
        weightGrams: 1000,
        widthMm: 200,
        heightMm: 100,
        depthMm: 100,
        contents: [{ lineIndex: 0, quantity: 2 }]
      }))
    },
    { idempotencyKey: crypto.randomUUID() }
  )
  await executeD1AdminPackingCommand(
    database,
    CLAIMS,
    orderId,
    {
      action: 'manual_dispatch',
      expectedVersion: 1,
      expectedFulfillmentVersion: 2,
      reason: REASON,
      shipments: [0, 1].map((parcelIndex) => ({
        parcelIndex,
        carrier: 'Synthetic manual carrier',
        shipmentNumber: `SHIPMENT-${parcelIndex}`,
        trackingNumber: `TRACK-${parcelIndex}`,
        externalLabelReference: `DOCUMENT-${parcelIndex}`
      })),
      actualNetCents: 700,
      taxBps: 2100
    },
    { idempotencyKey: crypto.randomUUID() }
  )
}
export async function trackingGuestCookie(
  database: D1Database,
  orderId: string,
  config: SessionCookieConfiguration = configuration
) {
  const event = await database
    .prepare(
      "SELECT id FROM email_outbox_events WHERE source_kind='order' AND source_id=? AND event_type='order.created'"
    )
    .bind(orderId)
    .first<{ id: string }>()
  if (!event) throw new Error('tracking_guest_checkout_occurrence_missing')
  const link = await issueD1GuestOrderEmailLink(database, event.id, {
    publicOrigin: origin,
    sessionCookieConfiguration: config
  })
  if (!link) throw new Error('tracking_guest_link_missing')
  const claim = new URL(link.url).searchParams.get('token')
  if (!claim) throw new Error('tracking_guest_claim_missing')
  const cookie = await exchangeD1GuestOrderAccess(database, new Request(origin), orderId, claim, config)
  if (!cookie) throw new Error('tracking_guest_cookie_missing')
  return cookie.split(';')[0]!
}
export async function trackingFixture() {
  const fixture = await packingFixture({ stage: 'packed' })
  try {
    await seedTrackingBuyers(fixture.database)
    const guestOrderId = fixture.orderId
    await recordTrackingPacking(fixture.database, guestOrderId)
    const ownedOrderId = await createPackingOrder(fixture.database, { stage: 'packed', ownerSession: BUYER })
    await recordTrackingPacking(fixture.database, ownedOrderId)
    const cookie = async (claims: typeof CLAIMS) =>
      (await issueD1SessionCookie(fixture.database, claims, configuration))!.split(';')[0]!
    return {
      ...fixture,
      guestOrderId,
      ownedOrderId,
      adminCookie: await cookie(CLAIMS),
      buyerCookie: await cookie(BUYER),
      foreignCookie: await cookie(FOREIGN),
      guestCookie: await trackingGuestCookie(fixture.database, guestOrderId)
    }
  } catch (error) {
    fixture.sqlite.close()
    throw error
  }
}

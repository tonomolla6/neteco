import type { VerifiedSessionClaims } from '../catalog/authorization'
import type { SessionCookieConfiguration } from '../auth/session-cookie'
import type { OrderTracking } from '../../shared/order-tracking'
import { z } from 'zod'
import {
  catalogPolicyInstantSchema as instant,
  catalogPolicyUuidSchema as uuid,
  catalogPolicyOwnJson
} from '../../shared/catalog-publication-policy'
import { orderTrackingSchema } from '../../shared/order-tracking'
import { adminOrderPackingSchema } from '../../shared/order-packing'
import { orderTimelineAuthoritySql } from '../catalog/order-timeline'
import { readD1GuestOrderView } from '../catalog/guest-order-access'
import {
  fulfillmentFactsSql,
  fulfillmentSourceSchema,
  fulfillmentSourceBlockers,
  fulfillmentAuditProofSql,
  fulfillmentFreshClock
} from './admin'
import { packingHistoryProofSql } from './packing'

export type OrderTrackingAccess =
  | { kind: 'customer' | 'admin'; claims: VerifiedSessionClaims }
  | { kind: 'guest'; request: Request; configuration: SessionCookieConfiguration }
export class OrderTrackingError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'OrderTrackingError'
  }
}
function fail(code: string): never {
  throw new OrderTrackingError(code)
}
const claimsSchema = z
  .object({ identityId: uuid, sessionId: uuid, sessionVersion: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER) })
  .strict()
const clock = "COALESCE(?1,strftime('%Y-%m-%dT%H:%M:%SZ','now'))"
// Reuse the exact operational sources and immutable history proof. No financial
// or warehouse readiness is inferred as carrier acceptance or external events.
const sql = `WITH ${fulfillmentFactsSql}
 SELECT s.*,p.version packingVersion,p.state packingState,p.parcels,p.dispatch,p.updated_at packingAt,
 ${packingHistoryProofSql} packingConfirmed,
 NOT EXISTS(SELECT 1 FROM order_fulfillment_commands c WHERE c.order_id=s.order_id
   AND (c.created_at>${clock} OR c.result_version>s.version OR NOT (${fulfillmentAuditProofSql}))) fullHistory,
 (SELECT updated_at FROM order_fulfillments WHERE order_id=s.order_id) fulfillmentAt,
 (SELECT shipping_gross_cents FROM orders WHERE id=s.order_id) quote,${clock} evaluatedAt
 FROM facts s LEFT JOIN order_packings p ON p.order_id=s.order_id`
export async function readD1OrderTracking(
  db: D1Database,
  access: OrderTrackingAccess,
  orderId: string,
  options: { now?: string } = {}
): Promise<OrderTracking> {
  try {
    if (
      !uuid.safeParse(orderId).success ||
      !z.object({ now: instant.optional() }).strict().safeParse(catalogPolicyOwnJson(options)).success
    )
      fail('invalid_input')
    if (!access || !['customer', 'admin', 'guest'].includes(access.kind)) fail('unauthenticated')
    const fresh = fulfillmentFreshClock(options.now)
    async function authorize() {
      if (access.kind === 'guest') {
        if (
          !(await readD1GuestOrderView(db, access.request, orderId, access.configuration, {
            now: () => fresh() ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
          }))
        )
          fail('not_found')
        return
      }
      if (!claimsSchema.safeParse(access.claims).success) fail('unauthenticated')
      const row = await db
        .prepare(orderTimelineAuthoritySql)
        .bind(
          fresh() ?? null,
          access.claims.sessionId,
          access.claims.identityId,
          access.claims.sessionVersion,
          orderId,
          access.kind
        )
        .first<{
          identityStatus: string
          email_verified: number
          mfa_verified: number
          customerId: string | null
          orderId: string | null
          permitted: number
        }>()
      if (!row) fail('unauthenticated')
      if (access.kind === 'customer') {
        if (row.identityStatus !== 'active' || row.email_verified !== 1 || !row.customerId) fail('unauthenticated')
      } else {
        if (row.email_verified !== 1) fail('email_unverified')
        if (row.mfa_verified !== 1) fail('mfa_required')
        if (row.permitted !== 1) fail('forbidden')
      }
      if (row.orderId !== orderId) fail('not_found')
    }
    await authorize()
    const raw = await db
      .prepare(sql)
      .bind(fresh() ?? null, null, null, null, orderId)
      .first<Record<string, unknown>>()
    if (!raw) fail('not_found')
    const {
      packingVersion,
      packingState,
      parcels,
      dispatch,
      packingAt,
      packingConfirmed,
      fullHistory,
      fulfillmentAt,
      quote,
      evaluatedAt,
      ...sourceRaw
    } = raw
    const source = fulfillmentSourceSchema.safeParse(catalogPolicyOwnJson(sourceRaw))
    if (!source.success || source.data.history_confirmed !== 1 || packingConfirmed !== 1 || fullHistory !== 1)
      fail('history_unconfirmed')
    const snapshot = z
      .object({
        lines: z.array(
          z.object({ index: z.number(), sku: z.string(), name: z.string(), quantity: z.number() }).passthrough()
        )
      })
      .passthrough()
      .parse(JSON.parse(source.data.snapshot))
    const blockers = fulfillmentSourceBlockers(source.data)
    const packing = adminOrderPackingSchema.safeParse({
      source: 'cloudflare',
      orderId,
      version: packingVersion ?? 0,
      state: packingState ?? 'unpacked',
      fulfillmentVersion: source.data.version,
      fulfillmentState: source.data.state,
      shippingMethod: ['pickup', 'own_delivery', 'parcel'].includes(source.data.shipping_method)
        ? source.data.shipping_method
        : null,
      lines: snapshot.lines.map((line) => ({
        lineIndex: line.index,
        sku: line.sku,
        name: line.name,
        quantity: line.quantity
      })),
      parcels: parcels === null ? [] : JSON.parse(String(parcels)),
      dispatch: dispatch === null ? null : JSON.parse(String(dispatch)),
      quotedGrossCents: quote,
      readiness: { ready: blockers.length === 0, blockers },
      capabilities: { packingWrite: false, manualDispatch: false },
      evaluatedAt
    })
    if (!packing.success) fail('history_unconfirmed')
    const value = packing.data
    const parsed = orderTrackingSchema.safeParse({
      source: 'cloudflare',
      orderId,
      audience: access.kind,
      shippingMethod: value.shippingMethod,
      fulfillment: { state: value.fulfillmentState, version: value.fulfillmentVersion, updatedAt: fulfillmentAt },
      packing: { parcelCount: value.parcels.length, recordedAt: packingAt },
      shipments:
        value.dispatch?.shipments.map((shipment) => ({
          parcelIndex: shipment.parcelIndex,
          carrier: shipment.carrier,
          trackingNumber: shipment.trackingNumber,
          recordedAt: value.dispatch!.recordedAt,
          verification: 'manual_unverified'
        })) ?? [],
      carrierEvents: [],
      carrierStatus: 'not_connected',
      fallback: { kind: 'contact_neteco', contactPath: '/contacto' },
      evaluatedAt
    })
    if (!parsed.success) fail('history_unconfirmed')
    // No awaits after the final live order + session/grant (or sealed guest)
    // authority check. EvaluatedAt is data time, never a revocation snapshot.
    await authorize()
    return parsed.data
  } catch (cause) {
    if (cause instanceof OrderTrackingError) throw cause
    if (cause && typeof cause === 'object' && 'code' in cause && cause.code === 'configuration_unavailable')
      fail('service_unavailable')
    if (cause instanceof z.ZodError || cause instanceof SyntaxError) fail('history_unconfirmed')
    return fail('service_unavailable')
  }
}

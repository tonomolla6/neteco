import { z } from 'zod'
import {
  beplyOrderSnapshotSchema,
  beplyErpStateSchema,
  beplyOrderStateLabels,
  beplyRemoteId,
  beplyOrderViewSchema,
  beplyStateFromFacts,
  type BeplyOrderAdapter,
  type BeplyOrderSnapshot
} from '../../shared/beply-orders'
import { fiscalInstant, fiscalUuid } from '../../shared/fiscal-issuance'
import { canonicalJson, sha256Hex } from '../catalog/inventory'
import { catalogPolicyOwnJson } from '../../shared/catalog-publication-policy'
import { authorizeFiscalOrder, type FiscalOrderAccess } from '../fiscal/access'
import { fiscalClock } from '../fiscal/issuance'
import { authorizeD1Session, type VerifiedSessionClaims } from '../catalog/authorization'
import { BeplyOrdersProviderError } from './beply-orders-provider'

export class BeplyOrderSyncError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'BeplyOrderSyncError'
  }
}
const clock = (now: string) => fiscalInstant.parse(now)
const after = (now: string, seconds: number) =>
  new Date(Date.parse(now) + seconds * 1000).toISOString().replace('.000Z', 'Z')
const limitOf = (limit: number | undefined) =>
  z
    .number()
    .int()
    .min(1)
    .max(25)
    .parse(limit ?? 10)
export const beplyQueueMessageSchema = z
  .object({ type: z.literal('beply.order.sync'), schemaVersion: z.literal(1), orderId: fiscalUuid })
  .strict()
export type BeplyOrderQueueMessage = z.infer<typeof beplyQueueMessageSchema>
export interface BeplyOrderQueue {
  send(message: BeplyOrderQueueMessage): Promise<void>
}
const jobSchema = z
  .object({
    order_id: fiscalUuid,
    version: z.number().int().positive(),
    synced_version: z.number().int().nonnegative(),
    status: z.enum(['pending', 'leased', 'synced', 'manual_review']),
    create_state: z.enum(['none', 'started', 'known']),
    create_payload: z.string().nullable(),
    create_hash: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
    provider_order_id: beplyRemoteId.nullable(),
    provider_code: z.string().nullable(),
    attempts: z.number().int().min(0).max(10),
    confirmed_at: fiscalInstant,
    erp_json: z.string().nullable(),
    erp_checked_at: fiscalInstant.nullable(),
    last_error_code: z.string().nullable()
  })
  .passthrough()

/** Bounded serial publication. Messages carry no PII. Queue loss is recoverable:
 * unsynchronized work is republished and the scheduled dispatcher also scans D1. */
export async function publishBeplyOrders(
  db: D1Database,
  queue: BeplyOrderQueue,
  input: { now: string; limit?: number }
) {
  const now = clock(input.now),
    limit = limitOf(input.limit),
    report = { published: 0, retryable: 0 }
  const rows = (
    await db
      .prepare(
        `SELECT order_id,queue_attempts FROM beply_order_sync
    WHERE status='pending' AND due_at<=?1 AND queue_due_at<=?1 ORDER BY queue_due_at,order_id LIMIT ?2`
      )
      .bind(now, limit)
      .all<{ order_id: string; queue_attempts: number }>()
  ).results
  for (const row of rows) {
    try {
      await queue.send({ type: 'beply.order.sync', schemaVersion: 1, orderId: row.order_id })
      await db
        .prepare('UPDATE beply_order_sync SET queue_due_at=?2,queue_attempts=0 WHERE order_id=?1 AND queue_due_at<=?3')
        .bind(row.order_id, after(now, 300), now)
        .run()
      report.published++
    } catch {
      const attempts = row.queue_attempts + 1
      await db.batch([
        db
          .prepare(
            'UPDATE beply_order_sync SET queue_attempts=queue_attempts+1,queue_due_at=?2 WHERE order_id=?1 AND queue_due_at<=?3'
          )
          .bind(row.order_id, after(now, Math.min(3600, 30 * 2 ** Math.min(attempts - 1, 7))), now),
        db
          .prepare(
            `INSERT OR IGNORE INTO beply_order_alerts(order_id,version,code,created_at)
          SELECT order_id,version,'queue_send_failed',?2 FROM beply_order_sync WHERE order_id=?1`
          )
          .bind(row.order_id, now)
      ])
      report.retryable++
    }
  }
  return report
}

async function snapshot(
  db: D1Database,
  orderId: string,
  version: number,
  confirmedAt: string
): Promise<BeplyOrderSnapshot> {
  // Four bounded set reads per order; never per-line or per-shipment queries.
  const row = await db
    .prepare(
      `SELECT o.*,b.recipient_name AS billing_name,b.line1 AS billing_line1,b.line2 AS billing_line2,
    b.city AS billing_city,b.province AS billing_region,b.postal_code AS billing_postal,b.nif,
    a.recipient_name,a.line1,a.line2,a.city,a.province,a.postal_code,a.country_code,a.phone,
    q.options_json,f.status AS fulfillment_status,p.dispatch,
    EXISTS(SELECT 1 FROM b2b_credit_reservations c JOIN checkout_attempts attempt ON attempt.id=c.attempt_id
      WHERE c.attempt_id=o.attempt_id AND attempt.state='completed' AND attempt.order_id=o.id) AS credit,
    (SELECT r.state FROM order_returns r WHERE r.order_id=o.id AND r.state<>'rejected'
      ORDER BY CASE WHEN r.state IN('received','inspected','resolution_ready') THEN 0 ELSE 1 END,r.updated_at DESC,r.id LIMIT 1) AS return_state
    FROM orders o JOIN order_shipping_address a ON a.order_id=o.id JOIN order_billing_address b ON b.order_id=o.id
    JOIN shipping_quotes q ON q.id=o.shipping_quote_id LEFT JOIN order_fulfillments f ON f.order_id=o.id
    LEFT JOIN order_packings p ON p.order_id=o.id WHERE o.id=?1`
    )
    .bind(orderId)
    .first<Record<string, unknown>>()
  if (!row) throw new BeplyOrderSyncError('snapshot_not_ready')
  const lineRows = (
    await db
      .prepare(
        `SELECT line_index AS lineIndex,variant_id AS variantId,sku,name AS description,
    quantity,net_cents AS netCents,tax_cents AS taxCents,gross_cents AS grossCents,tax_rate_basis_points AS taxRateBasisPoints
    FROM order_lines WHERE order_id=?1 ORDER BY line_index LIMIT 101`
      )
      .bind(orderId)
      .all()
  ).results
  const options = z
    .array(
      z
        .object({
          methodCode: z.string(),
          rateVersion: z.number(),
          netCents: z.number(),
          taxCents: z.number(),
          grossCents: z.number(),
          taxRateBasisPoints: z.number(),
          etaMinDays: z.number(),
          etaMaxDays: z.number()
        })
        .passthrough()
    )
    .max(100)
    .parse(JSON.parse(String(row.options_json)))
    .filter(
      (item) =>
        item.methodCode === row.shipping_method_code &&
        item.rateVersion === row.shipping_rate_version &&
        item.netCents === row.shipping_net_cents &&
        item.taxCents === row.shipping_tax_cents &&
        item.grossCents === row.shipping_gross_cents
    )
  const rates = [...new Set(options.map((item) => item.taxRateBasisPoints))]
  if (rates.length !== 1) throw new BeplyOrderSyncError('shipping_snapshot_ambiguous')
  const dispatch =
    row.dispatch === null
      ? null
      : z
          .object({
            shipments: z
              .array(
                z
                  .object({
                    parcelIndex: z.number(),
                    carrier: z.string(),
                    trackingNumber: z.string(),
                    shipmentNumber: z.string()
                  })
                  .passthrough()
              )
              .max(20)
          })
          .passthrough()
          .parse(JSON.parse(String(row.dispatch)))
  const shipments =
    dispatch?.shipments.map(({ parcelIndex, carrier, trackingNumber, shipmentNumber }) => ({
      parcelIndex,
      carrier,
      trackingNumber,
      shipmentNumber
    })) ?? []
  const state = beplyStateFromFacts({
    cancelled: row.status === 'cancelled',
    returnState: row.return_state === null ? null : String(row.return_state),
    fulfillment: row.fulfillment_status === null ? null : String(row.fulfillment_status),
    hasShipments: shipments.length > 0
  })
  return beplyOrderSnapshotSchema.parse({
    orderId,
    orderNumber: orderId,
    version,
    confirmedAt,
    paymentMethod: Number(row.credit) === 1 ? 'credit' : 'redsys',
    currency: row.currency,
    customer: {
      externalKey: row.customer_id ?? orderId,
      legalName: row.buyer_company_name || row.billing_name,
      email: row.contact_email,
      ...(row.nif ? { taxId: row.nif } : {}),
      phone: row.phone,
      address: {
        line1: row.billing_line1,
        ...(row.billing_line2 ? { line2: row.billing_line2 } : {}),
        city: row.billing_city,
        region: row.billing_region,
        postalCode: row.billing_postal,
        countryCode: row.country_code
      }
    },
    shippingAddress: {
      recipientName: row.recipient_name,
      line1: row.line1,
      line2: row.line2,
      city: row.city,
      region: row.province,
      postalCode: row.postal_code,
      countryCode: row.country_code,
      phone: row.phone
    },
    lines: lineRows,
    shippingNetCents: row.shipping_net_cents,
    shippingTaxCents: row.shipping_tax_cents,
    shippingGrossCents: row.shipping_gross_cents,
    shippingTaxRateBasisPoints: rates[0],
    totalNetCents: row.total_net_cents,
    totalTaxCents: row.total_tax_cents,
    totalGrossCents: row.total_gross_cents,
    state,
    // ETA is explicitly an estimate from the accepted quote, never carrier proof.
    expectedDeliveryAt: after(confirmedAt, Number(row.shipping_eta_max_days) * 86400),
    shipments
  })
}

/** At most one remote mutation per claimed order at a time. A durable started
 * marker is written BEFORE create; an expired/ambiguous POST only permits lookup,
 * never another create, even if eventually-consistent lookup returns no result. */
export async function dispatchBeplyOrders(
  db: D1Database,
  provider: BeplyOrderAdapter,
  input: { enabled?: boolean; now: string; limit?: number; orderId?: string }
) {
  const now = clock(input.now),
    limit = limitOf(input.limit)
  const report = { disabled: input.enabled !== true, completed: 0, retryable: 0, manualReview: 0, lostLease: 0 }
  if (input.orderId !== undefined) fiscalUuid.parse(input.orderId)
  if (report.disabled) return report
  const exhausted = await db.batch([
    db
      .prepare(
        `INSERT OR IGNORE INTO beply_order_alerts(order_id,version,code,created_at)
      SELECT order_id,version,'attempts_exhausted',?1 FROM beply_order_sync
      WHERE attempts>=10 AND (status='pending' OR (status='leased' AND lease_until<=?1))
      AND (?2 IS NULL OR order_id=?2)`
      )
      .bind(now, input.orderId ?? null),
    db
      .prepare(
        `UPDATE beply_order_sync SET status='manual_review',lease_token=NULL,lease_until=NULL,last_error_code='attempts_exhausted'
      WHERE attempts>=10 AND (status='pending' OR (status='leased' AND lease_until<=?1))
      AND (?2 IS NULL OR order_id=?2) RETURNING order_id`
      )
      .bind(now, input.orderId ?? null)
  ])
  report.manualReview += exhausted[1]!.results.length
  const candidates = (
    await db
      .prepare(
        `SELECT order_id FROM beply_order_sync WHERE (?3 IS NULL OR order_id=?3)
    AND ((status IN('pending','synced') AND due_at<=?1) OR (status='leased' AND lease_until<=?1))
    ORDER BY due_at,order_id LIMIT ?2`
      )
      .bind(now, limit, input.orderId ?? null)
      .all<{ order_id: string }>()
  ).results
  for (const candidate of candidates) {
    const token = crypto.randomUUID()
    const claim = await db
      .prepare(
        `UPDATE beply_order_sync SET status='leased',lease_token=?2,lease_until=?3,
      attempts=CASE WHEN status='synced' THEN 1 ELSE min(10,attempts+1) END
      WHERE order_id=?1 AND ((status IN('pending','synced') AND due_at<=?4) OR (status='leased' AND lease_until<=?4)) RETURNING *`
      )
      .bind(candidate.order_id, token, after(now, 300), now)
      .first()
    if (!claim) continue
    const job = jobSchema.parse(catalogPolicyOwnJson(claim)),
      orderId = job.order_id
    let createAttempted = false
    try {
      const value = await snapshot(db, orderId, job.version, job.confirmed_at)
      let createValue = job.create_payload ? beplyOrderSnapshotSchema.parse(JSON.parse(job.create_payload)) : value
      const hash = job.create_hash ?? (await sha256Hex(canonicalJson(createValue)))
      const identity = { key: `neteco-order:${orderId}`, hash }
      let providerId = job.provider_order_id,
        providerCode = job.provider_code
      if (!providerId) {
        const found = await provider.lookupOrder(createValue, identity)
        if (found) {
          providerId = found.providerOrderId
          providerCode = found.code
        } else {
          if (job.create_state === 'started') throw new BeplyOrderSyncError('create_outcome_unknown')
          const started = await db
            .prepare(
              `UPDATE beply_order_sync SET create_state='started',create_payload=?3,create_hash=?4
            WHERE order_id=?1 AND lease_token=?2 AND status='leased' AND create_state='none' RETURNING order_id`
            )
            .bind(orderId, token, canonicalJson(createValue), hash)
            .first()
          if (!started) {
            report.lostLease++
            continue
          }
          createAttempted = true
          const receipt = await provider.createOrder(createValue, identity)
          providerId = receipt.providerOrderId
          providerCode = receipt.code
        }
        const known = await db
          .prepare(
            `UPDATE beply_order_sync SET create_state='known',provider_order_id=?3,provider_code=?4,
          create_payload=COALESCE(create_payload,?5),create_hash=COALESCE(create_hash,?6)
          WHERE order_id=?1 AND lease_token=?2 AND status='leased' RETURNING order_id`
          )
          .bind(
            orderId,
            token,
            beplyRemoteId.parse(providerId),
            z.string().min(1).max(100).parse(providerCode),
            canonicalJson(createValue),
            hash
          )
          .first()
        if (!known) {
          report.lostLease++
          continue
        }
        // Recovered creates may predate the current operational snapshot.
        if (job.create_state === 'started' || createValue.version !== value.version)
          await provider.updateOrder(providerId, value, identity)
      } else {
        createValue = beplyOrderSnapshotSchema.parse(JSON.parse(job.create_payload!))
        if (job.synced_version < job.version) await provider.updateOrder(providerId, value, identity)
      }
      const erp = beplyErpStateSchema.parse(await provider.readOrder(providerId, value.orderNumber))
      const completed = await db
        .prepare(
          `UPDATE beply_order_sync SET synced_version=max(synced_version,?3),
        status=CASE WHEN version=?3 THEN 'synced' ELSE 'pending' END,lease_token=NULL,lease_until=NULL,
        erp_json=?4,erp_checked_at=?5,last_error_code=NULL,due_at=CASE WHEN version=?3 THEN ?6 ELSE due_at END,updated_at=?5
        WHERE order_id=?1 AND status='leased' AND lease_token=?2 RETURNING order_id`
        )
        .bind(orderId, token, job.version, canonicalJson(erp), now, after(now, 900))
        .first()
      if (completed) report.completed++
      else report.lostLease++
    } catch (error) {
      const code =
        error instanceof BeplyOrdersProviderError || error instanceof BeplyOrderSyncError ? error.code : 'sync_failed'
      const safeCode = /^[a-z_]{1,80}$/.test(code) ? code : 'sync_failed'
      const retryable = error instanceof BeplyOrdersProviderError && error.retryable && job.attempts < 10
      const releaseStarted = createAttempted && error instanceof BeplyOrdersProviderError && !error.ambiguous
      const result = await db.batch([
        db
          .prepare(
            `INSERT OR IGNORE INTO beply_order_alerts(order_id,version,code,created_at)
          SELECT order_id,version,?3,?4 FROM beply_order_sync WHERE order_id=?1 AND status='leased' AND lease_token=?2`
          )
          .bind(orderId, token, safeCode, now),
        db
          .prepare(
            `UPDATE beply_order_sync SET status=?3,lease_token=NULL,lease_until=NULL,last_error_code=?4,due_at=?5,updated_at=?6,
          create_state=CASE WHEN ?7=1 AND create_state='started' THEN 'none' ELSE create_state END
          WHERE order_id=?1 AND status='leased' AND lease_token=?2 RETURNING order_id`
          )
          .bind(
            orderId,
            token,
            retryable ? 'pending' : 'manual_review',
            safeCode,
            after(now, Math.min(3600, 30 * 2 ** (job.attempts - 1))),
            now,
            releaseStarted ? 1 : 0
          )
      ])
      if (result[1]!.results.length === 0) report.lostLease++
      else if (retryable) report.retryable++
      else report.manualReview++
    }
  }
  return report
}

export async function readBeplyOrder(db: D1Database, access: FiscalOrderAccess, orderId: string, now: string) {
  const fresh = fiscalClock(now)
  await authorizeFiscalOrder(db, access, orderId, fresh())
  const raw = await db.prepare('SELECT * FROM beply_order_sync WHERE order_id=?1').bind(orderId).first()
  const job = raw ? jobSchema.parse(catalogPolicyOwnJson(raw)) : null
  const value = job ? await snapshot(db, orderId, job.version, job.confirmed_at) : null
  await authorizeFiscalOrder(db, access, orderId, fresh())
  return beplyOrderViewSchema.parse({
    audience: access.kind,
    orderId,
    status: job?.status ?? 'not_confirmed',
    version: job?.version ?? 0,
    syncedVersion: job?.synced_version ?? 0,
    state: value?.state ?? null,
    stateLabel: value ? beplyOrderStateLabels[value.state] : null,
    providerOrderId: job?.provider_order_id ?? null,
    providerCode: job?.provider_code ?? null,
    erp: job?.erp_json ? beplyErpStateSchema.parse(JSON.parse(job.erp_json)) : null,
    erpCheckedAt: job?.erp_checked_at ?? null,
    expectedDeliveryAt: value?.expectedDeliveryAt ?? null,
    shipments: value?.shipments ?? [],
    lastErrorCode: access.kind === 'admin' ? (job?.last_error_code ?? null) : null
  })
}

export const beplyRetrySchema = z
  .object({
    commandId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/),
    expectedVersion: z
      .number()
      .int()
      .min(1)
      .max(Number.MAX_SAFE_INTEGER - 1),
    reason: z.string().trim().min(10).max(500)
  })
  .strict()
export async function retryBeplyOrder(
  db: D1Database,
  claims: VerifiedSessionClaims,
  orderId: string,
  raw: z.infer<typeof beplyRetrySchema>,
  now: string
) {
  clock(now)
  fiscalUuid.parse(orderId)
  const input = beplyRetrySchema.parse(catalogPolicyOwnJson(raw))
  const auth = await authorizeD1Session(db, claims, 'administration.manage', { now, requireMfa: true })
  if (!auth.allowed) throw new BeplyOrderSyncError(auth.code)
  const hash = await sha256Hex(canonicalJson({ ...input, orderId }))
  const prior = await db
    .prepare('SELECT payload_hash,expected_version FROM beply_order_commands WHERE actor_id=?1 AND command_id=?2')
    .bind(claims.identityId, input.commandId)
    .first<{ payload_hash: string; expected_version: number }>()
  if (prior) {
    if (prior.payload_hash !== hash) throw new BeplyOrderSyncError('idempotency_conflict')
    return { version: prior.expected_version + 1 }
  }
  const state = await db
    .prepare('SELECT version,status FROM beply_order_sync WHERE order_id=?1')
    .bind(orderId)
    .first<{ version: number; status: string }>()
  if (!state || state.version !== input.expectedVersion || state.status !== 'manual_review')
    throw new BeplyOrderSyncError('version_conflict')
  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO beply_order_commands(actor_id,command_id,session_id,session_version,order_id,expected_version,payload_hash,reason,created_at)
        VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)`
        )
        .bind(
          claims.identityId,
          input.commandId,
          claims.sessionId,
          claims.sessionVersion,
          orderId,
          input.expectedVersion,
          hash,
          input.reason,
          now
        ),
      db
        .prepare(
          `UPDATE beply_order_sync SET version=version+1,status='pending',attempts=0,due_at=?3,queue_due_at=?3,updated_at=?3
        WHERE order_id=?1 AND version=?2 AND status='manual_review'`
        )
        .bind(orderId, input.expectedVersion, now)
    ])
  } catch {
    const authority = await authorizeD1Session(db, claims, 'administration.manage', { now, requireMfa: true })
    if (!authority.allowed) throw new BeplyOrderSyncError(authority.code)
    const command = await db
      .prepare('SELECT payload_hash,expected_version FROM beply_order_commands WHERE actor_id=?1 AND command_id=?2')
      .bind(claims.identityId, input.commandId)
      .first<{ payload_hash: string; expected_version: number }>()
    if (command?.payload_hash === hash) return { version: command.expected_version + 1 }
    throw new BeplyOrderSyncError(command ? 'idempotency_conflict' : 'version_conflict')
  }
  return { version: input.expectedVersion + 1 }
}

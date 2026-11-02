/** PAY-021: Redsys pre-authorisation, only for an explicit and justified administrator request.
 *
 * A hold is never created by checkout. State changes use compare-and-swap on `version`, every
 * provider side effect is preceded by a durable claim (capture_pending / cancel_pending) and uses
 * a stable provider idempotency key, so an interrupted request is resumable and never repeated.
 */
import { z } from 'zod'
import { authorizeD1Session, type VerifiedSessionClaims } from '../catalog/authorization'
import { canonicalPayloadHash } from '../catalog/cart'
import type { AssignResult, OperationInput, SimpleResult } from '../catalog/inventory'
import type { PaymentRuntimeConfiguration } from '../catalog/payments'
import {
  createRedsysRedirect,
  decodeMerchantParameters,
  encodeMerchantParameters,
  sha256Hex,
  signMerchantParameters,
  verifyMerchantSignature
} from './redsys'
import { orderStoreCreditSql } from '../pricing/order-store-credit-sql'

export const PREAUTH_REASONS = ['made_to_order', 'stock_confirmation', 'assisted_sale', 'credit_review'] as const
export const PREAUTH_NOTIFICATION_PATH = '/api/payments/redsys/preauth-notification'
const DEFAULT_HOLD_SECONDS = 7 * 24 * 3600
const RESUME_AFTER_SECONDS = 60

export class PreauthError extends Error {
  constructor(
    readonly code:
      'invalid_input' | 'unauthenticated' | 'forbidden' | 'not_found' | 'conflict' | 'not_payable' | 'unavailable'
  ) {
    super(code)
  }
}

export interface PreauthProvider {
  capture(input: { preauthId: string; merchantOrder: string; amountCents: number; idempotencyKey: string }): Promise<{
    outcome: 'captured' | 'rejected'
    providerReference?: string
    responseCode?: string
  }>
  cancel(input: { preauthId: string; merchantOrder: string; amountCents: number; idempotencyKey: string }): Promise<{
    outcome: 'cancelled' | 'rejected'
  }>
}
export interface PreauthInventory {
  assign(input: OperationInput): Promise<AssignResult>
  renew(input: OperationInput & { expiresAt: string }): Promise<SimpleResult>
  release(input: OperationInput): Promise<SimpleResult>
}
export interface PreauthDependencies {
  database: D1Database
  configuration: PaymentRuntimeConfiguration
  provider: PreauthProvider
  inventory: PreauthInventory
  now: () => string
  holdSeconds?: number
}

const uuid = z.string().uuid()
const requestSchema = z
  .object({
    orderId: uuid,
    commandId: uuid,
    reasonCode: z.enum(PREAUTH_REASONS),
    justification: z.string().trim().min(20).max(500),
    expectedAmountCents: z.number().int().safe().positive()
  })
  .strict()
const operationSchema = z.object({ commandId: uuid, expectedVersion: z.number().int().safe().min(1) }).strict()

type Status =
  | 'requested'
  | 'authorized'
  | 'capture_pending'
  | 'cancel_pending'
  | 'captured'
  | 'cancelled'
  | 'expired'
  | 'failed'
  | 'stock_exception'
interface Row {
  id: string
  order_id: string
  merchant_order: string
  amount_cents: number
  reason_code: string
  status: Status
  version: number
  provider_reference: string | null
  redirect_expires_at: string
  authorized_until: string | null
  updated_at: string
  reservation_id: string
}

export interface PreauthView {
  id: string
  orderId: string
  amountCents: number
  reasonCode: string
  status: Status
  version: number
  authorizedUntil: string | null
  redirect?: { actionUrl: string; method: 'POST'; fields: Record<string, string> }
}

const instantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/
function clock(deps: PreauthDependencies): string {
  const now = deps.now()
  if (!instantPattern.test(now) || new Date(Date.parse(now)).toISOString().replace('.000Z', 'Z') !== now)
    throw new PreauthError('unavailable')
  return now
}
function plus(instant: string, seconds: number): string {
  return new Date(Date.parse(instant) + seconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
}
function hold(deps: PreauthDependencies): number {
  const value = deps.holdSeconds ?? DEFAULT_HOLD_SECONDS
  if (!Number.isInteger(value) || value < 3600 || value > 30 * 86400) throw new PreauthError('unavailable')
  return value
}

const SELECT_ROW = `SELECT p.id,p.order_id,p.merchant_order,p.amount_cents,p.reason_code,p.status,p.version,p.provider_reference,
  p.redirect_expires_at,p.authorized_until,p.updated_at,o.reservation_id
  FROM payment_preauths p JOIN orders o ON o.id=p.order_id`
async function load(db: D1Database, id: string): Promise<Row | null> {
  return db.prepare(`${SELECT_ROW} WHERE p.id=?`).bind(id).first<Row>()
}

/** Live administrator authority in SQL so it can gate the same atomic statement that changes state. */
const AUTHORITY = (now: string, session: string, identity: string, version: string) => `EXISTS(
  SELECT 1 FROM auth_sessions s JOIN identities i ON i.id=s.identity_id
  WHERE s.id=${session} AND s.identity_id=${identity} AND s.session_version=${version}
    AND i.session_version=s.session_version AND s.revoked_at IS NULL AND s.mfa_verified=1
    AND s.created_at<=max(${now},strftime('%Y-%m-%dT%H:%M:%SZ','now')) AND s.expires_at>max(${now},strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    AND i.status IN ('pending','active') AND i.email_verified_at IS NOT NULL
    AND i.email_verified_at<=max(${now},strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    AND EXISTS(SELECT 1 FROM identity_roles a JOIN role_permissions g ON g.role_code=a.role_code
      WHERE a.identity_id=i.id AND g.permission_code='administration.manage'
        AND a.granted_at<=max(${now},strftime('%Y-%m-%dT%H:%M:%SZ','now'))
        AND (a.expires_at IS NULL OR a.expires_at>max(${now},strftime('%Y-%m-%dT%H:%M:%SZ','now')))))`

async function admin(db: D1Database, claims: VerifiedSessionClaims | null, now: string): Promise<string> {
  if (!claims) throw new PreauthError('unauthenticated')
  const result = await authorizeD1Session(db, claims, 'administration.manage', { now, requireMfa: true })
  if (!result.allowed) throw new PreauthError(result.code === 'unauthenticated' ? 'unauthenticated' : 'forbidden')
  return result.identityId
}

interface TransitionOptions {
  now: string
  from: Status
  to: Status
  expectedVersion: number
  event: string
  responseCode?: string | null
  providerReference?: string | null
  authorizedUntil?: string | null
  actor?: { claims: VerifiedSessionClaims; identityId: string } | null
  command?: { id: string; action: 'request' | 'capture' | 'cancel'; payloadHash: string } | null
  extra?: (db: D1Database, next: number) => D1PreparedStatement[]
}

/** One atomic compare-and-swap step: row, immutable event, optional command and side effects commit together. */
async function transition(db: D1Database, row: Row, options: TransitionOptions): Promise<boolean> {
  const next = options.expectedVersion + 1
  const guard = crypto.randomUUID()
  const authority = options.actor ? ` AND ${AUTHORITY('?5', '?9', '?10', '?11')}` : ''
  const update = db
    .prepare(
      `UPDATE payment_preauths SET status=?4,version=version+1,updated_at=?5,
         provider_reference=COALESCE(?6,provider_reference),authorized_until=COALESCE(?7,authorized_until)
       WHERE id=?1 AND version=?2 AND status=?3${authority}`
    )
    .bind(
      row.id,
      options.expectedVersion,
      options.from,
      options.to,
      options.now,
      options.providerReference ?? null,
      options.authorizedUntil ?? null,
      ...(options.actor
        ? [null, options.actor.claims.sessionId, options.actor.claims.identityId, options.actor.claims.sessionVersion]
        : [])
    )
  const statements: D1PreparedStatement[] = [
    update,
    db
      .prepare(
        `INSERT INTO payment_preauth_events(preauth_id,version,event,from_status,to_status,actor_id,command_id,response_code,created_at)
         SELECT id,version,?3,?4,status,?5,?6,?7,updated_at FROM payment_preauths WHERE id=?1 AND version=?2 AND status=?8`
      )
      .bind(
        row.id,
        next,
        options.event,
        options.from,
        options.actor?.identityId ?? null,
        options.command?.id ?? null,
        options.responseCode ?? null,
        options.to
      )
  ]
  if (options.command)
    statements.push(
      db
        .prepare(
          `INSERT INTO payment_preauth_commands(command_id,action,preauth_id,actor_id,payload_hash,result_version,created_at)
           SELECT ?3,?4,id,?5,?6,version,updated_at FROM payment_preauths WHERE id=?1 AND version=?2 AND status=?7`
        )
        .bind(
          row.id,
          next,
          options.command.id,
          options.command.action,
          options.actor?.identityId ?? '',
          options.command.payloadHash,
          options.to
        )
    )
  statements.push(...(options.extra?.(db, next) ?? []))
  statements.push(
    db
      .prepare(
        `INSERT INTO payment_preauth_guards(id,valid) SELECT ?1,CASE WHEN EXISTS(
           SELECT 1 FROM payment_preauths p JOIN payment_preauth_events e ON e.preauth_id=p.id AND e.version=p.version
           WHERE p.id=?2 AND p.version=?3 AND p.status=?4 AND e.to_status=?4)${
             options.command
               ? ` AND EXISTS(
           SELECT 1 FROM payment_preauth_commands WHERE command_id=?5 AND preauth_id=?2 AND result_version=?3)`
               : ''
           }
         THEN 1 ELSE 0 END`
      )
      .bind(guard, row.id, next, options.to, ...(options.command ? [options.command.id] : [])),
    db.prepare('DELETE FROM payment_preauth_guards WHERE id=?').bind(guard)
  )
  try {
    await db.batch(statements)
    return true
  } catch {
    return false
  }
}

function view(row: Row, redirect?: PreauthView['redirect']): PreauthView {
  return {
    id: row.id,
    orderId: row.order_id,
    amountCents: row.amount_cents,
    reasonCode: row.reason_code,
    status: row.status,
    version: row.version,
    authorizedUntil: row.authorized_until,
    ...(redirect ? { redirect } : {})
  }
}

async function merchantOrderFor(id: string): Promise<string> {
  const digest = await sha256Hex(`neteco:redsys-preauth-order:v1\u0000${id}`)
  const numeric = [...digest.slice(0, 4)].map((c) => (Number.parseInt(c, 16) % 10).toString()).join('')
  return `${numeric}${digest.slice(4, 12).toUpperCase()}`
}

/** Builds the type-1 (pre-authorisation) Redirect for an existing row; never reusable after its expiry. */
async function buildRedirect(deps: PreauthDependencies, row: Row) {
  const base = new URL(deps.configuration.publicBaseUrl)
  if (base.protocol !== 'https:') throw new PreauthError('unavailable')
  const returnUrl = new URL('/pago/retorno', base)
  returnUrl.searchParams.set('order', row.order_id)
  const redirect = await createRedsysRedirect(deps.configuration, {
    amountCents: row.amount_cents,
    expiresAt: row.redirect_expires_at,
    merchantOrder: row.merchant_order,
    method: 'card',
    notificationUrl: new URL(PREAUTH_NOTIFICATION_PATH, base).toString(),
    returnUrl: returnUrl.toString()
  })
  const parameters = decodeMerchantParameters(redirect.fields.Ds_MerchantParameters)
  parameters.DS_MERCHANT_TRANSACTIONTYPE = '1'
  const encoded = encodeMerchantParameters(parameters)
  return {
    actionUrl: redirect.actionUrl,
    method: redirect.method,
    fields: {
      Ds_MerchantParameters: encoded,
      Ds_Signature: await signMerchantParameters(encoded, deps.configuration.secretKey, row.merchant_order),
      Ds_SignatureVersion: redirect.fields.Ds_SignatureVersion
    }
  }
}

async function commandFor(db: D1Database, id: string) {
  return db
    .prepare('SELECT action,preauth_id,payload_hash,result_version FROM payment_preauth_commands WHERE command_id=?')
    .bind(id)
    .first<{ action: string; preauth_id: string; payload_hash: string; result_version: number }>()
}

const AMOUNT_DUE = `(o.total_gross_cents-${orderStoreCreditSql('o.id')})`
const LIVE_ORDER = `o.status='awaiting_payment' AND o.currency='EUR' AND o.access_revoked_at IS NULL
  AND EXISTS(SELECT 1 FROM inventory_reservations r WHERE r.id=o.reservation_id AND r.status='reserved' AND r.expires_at>?2)
  AND NOT EXISTS(SELECT 1 FROM payment_fulfilment_claims WHERE order_id=o.id)
  AND NOT EXISTS(SELECT 1 FROM payment_intents WHERE order_id=o.id AND status IN ('redirect_ready','processing','provider_authorised','captured','stock_exception'))
  AND NOT EXISTS(SELECT 1 FROM order_payment_states WHERE order_id=o.id AND status IN ('paid','provider_authorised','stock_exception','processing'))`

/** Admin command: ask for a hold on one order, for a documented reason. Amount comes from the order. */
export async function requestPreauthorization(
  claims: VerifiedSessionClaims | null,
  raw: unknown,
  deps: PreauthDependencies
): Promise<PreauthView> {
  const parsed = requestSchema.safeParse(raw)
  if (!parsed.success) throw new PreauthError('invalid_input')
  const input = parsed.data
  const now = clock(deps)
  const identityId = await admin(deps.database, claims, now)
  const payloadHash = await canonicalPayloadHash({ kind: 'preauth-request', ...input })
  const existing = await commandFor(deps.database, input.commandId)
  if (existing) {
    if (existing.action !== 'request' || existing.payload_hash !== payloadHash) throw new PreauthError('conflict')
    const row = await load(deps.database, existing.preauth_id)
    if (!row) throw new PreauthError('unavailable')
    await admin(deps.database, claims, clock(deps))
    return view(
      row,
      row.status === 'requested' && row.redirect_expires_at > clock(deps) ? await buildRedirect(deps, row) : undefined
    )
  }
  const order = await deps.database
    // PRI-018: only the amount due (total - store credit applied) is held on the card.
    .prepare(`SELECT ${AMOUNT_DUE} AS total FROM orders o WHERE o.id=?1 AND ${LIVE_ORDER.replaceAll('?2', '?2')}`)
    .bind(input.orderId, now)
    .first<{ total: number }>()
  if (!order) throw new PreauthError('not_payable')
  if (order.total !== input.expectedAmountCents) throw new PreauthError('conflict')
  const id = crypto.randomUUID()
  const merchantOrder = await merchantOrderFor(id)
  const guard = crypto.randomUUID()
  const authority = AUTHORITY('?4', '?9', '?10', '?11')
  try {
    await deps.database.batch([
      deps.database
        .prepare(
          `INSERT INTO payment_preauths(id,order_id,merchant_order,amount_cents,reason_code,justification,requested_by,status,version,
             redirect_expires_at,created_at,updated_at)
           SELECT ?1,o.id,?3,${AMOUNT_DUE},?5,?6,?7,'requested',1,r.expires_at,?4,?4
           FROM orders o JOIN inventory_reservations r ON r.id=o.reservation_id
           WHERE o.id=?8 AND ${LIVE_ORDER.replaceAll('?2', '?4')} AND ${AMOUNT_DUE}=?12 AND ${authority}
             AND NOT EXISTS(SELECT 1 FROM payment_intents WHERE merchant_order=?3)`
        )
        .bind(
          id,
          null,
          merchantOrder,
          now,
          input.reasonCode,
          input.justification,
          identityId,
          input.orderId,
          claims!.sessionId,
          claims!.identityId,
          claims!.sessionVersion,
          input.expectedAmountCents
        ),
      deps.database
        .prepare(
          `INSERT INTO payment_preauth_events(preauth_id,version,event,from_status,to_status,actor_id,command_id,created_at)
           SELECT id,1,'requested',NULL,'requested',?2,?3,created_at FROM payment_preauths WHERE id=?1`
        )
        .bind(id, identityId, input.commandId),
      deps.database
        .prepare(
          `INSERT INTO payment_preauth_commands(command_id,action,preauth_id,actor_id,payload_hash,result_version,created_at)
           SELECT ?2,'request',id,?3,?4,1,created_at FROM payment_preauths WHERE id=?1`
        )
        .bind(id, input.commandId, identityId, payloadHash),
      deps.database
        .prepare(
          `INSERT INTO payment_preauth_guards(id,valid) SELECT ?1,CASE WHEN EXISTS(
             SELECT 1 FROM payment_preauths p JOIN payment_preauth_commands c ON c.preauth_id=p.id AND c.command_id=?3
             JOIN payment_preauth_events e ON e.preauth_id=p.id AND e.version=1 WHERE p.id=?2) THEN 1 ELSE 0 END`
        )
        .bind(guard, id, input.commandId),
      deps.database.prepare('DELETE FROM payment_preauth_guards WHERE id=?').bind(guard)
    ])
  } catch {
    const raced = await commandFor(deps.database, input.commandId)
    if (raced && raced.payload_hash === payloadHash && raced.action === 'request') {
      return requestPreauthorization(claims, raw, deps)
    }
    if (raced) throw new PreauthError('conflict')
    const live = await deps.database
      .prepare(
        `SELECT 1 AS ok FROM payment_preauths WHERE order_id=? AND status IN
         ('requested','authorized','capture_pending','cancel_pending','captured','stock_exception')`
      )
      .bind(input.orderId)
      .first()
    if (live) throw new PreauthError('conflict')
    await admin(deps.database, claims, clock(deps))
    throw new PreauthError('not_payable')
  }
  const row = (await load(deps.database, id))!
  await admin(deps.database, claims, clock(deps))
  return view(row, await buildRedirect(deps, row))
}

/** Admin read. */
export async function readPreauthorization(
  claims: VerifiedSessionClaims | null,
  id: string,
  deps: PreauthDependencies
): Promise<PreauthView> {
  if (!uuid.safeParse(id).success) throw new PreauthError('invalid_input')
  await admin(deps.database, claims, clock(deps))
  const row = await load(deps.database, id)
  if (!row) throw new PreauthError('not_found')
  return view(row)
}

export async function listOrderPreauthorizations(
  claims: VerifiedSessionClaims | null,
  orderId: string,
  deps: PreauthDependencies
): Promise<{ preauthorizations: PreauthView[] }> {
  if (!uuid.safeParse(orderId).success) throw new PreauthError('invalid_input')
  await admin(deps.database, claims, clock(deps))
  const rows = await deps.database
    .prepare(`${SELECT_ROW} WHERE p.order_id=? ORDER BY p.created_at,p.id LIMIT 20`)
    .bind(orderId)
    .all<Row>()
  return { preauthorizations: rows.results.map((row) => view(row)) }
}

/** An order's reservation is released only when no other payment can still use it. */
const ORDER_UNUSED_BY_OTHER_PAYMENT = `NOT EXISTS(SELECT 1 FROM payment_intents WHERE order_id=?1 AND status IN ('redirect_ready','processing','provider_authorised','captured','stock_exception'))
  AND NOT EXISTS(SELECT 1 FROM payment_fulfilment_claims WHERE order_id=?1)
  AND NOT EXISTS(SELECT 1 FROM order_payment_states WHERE order_id=?1 AND status IN ('paid','provider_authorised','stock_exception','processing'))`

async function releaseStockIfUnused(deps: PreauthDependencies, row: Row, now: string) {
  const free = await deps.database
    .prepare(`SELECT CASE WHEN ${ORDER_UNUSED_BY_OTHER_PAYMENT} THEN 1 ELSE 0 END AS free`)
    .bind(row.order_id)
    .first<{ free: number }>()
  if (free?.free !== 1) return false
  await deps.inventory.release({
    idempotencyKey: row.reservation_id,
    correlationId: `preauth:${row.id}`,
    now,
    reason: `Pre-authorisation ${row.id} ended without capture`
  })
  return true
}

function orderStateStatements(
  db: D1Database,
  row: Row,
  status: 'paid' | 'cancelled' | 'stock_exception',
  now: string,
  eventType: string
) {
  const unusedGuard = status === 'paid' || status === 'stock_exception' ? '1' : ORDER_UNUSED_BY_OTHER_PAYMENT
  return (_: D1Database, next: number) => [
    db
      .prepare(
        `INSERT INTO order_payment_states(order_id,status,active_intent_id,paid_gross_cents,provider_reference,updated_at)
         SELECT p.order_id,?2,NULL,CASE WHEN ?2='paid' THEN p.amount_cents ELSE 0 END,p.provider_reference,?3
         FROM payment_preauths p WHERE p.id=?4 AND p.version=?5 AND (${unusedGuard.replaceAll('?1', 'p.order_id')})
         ON CONFLICT(order_id) DO UPDATE SET status=excluded.status,active_intent_id=NULL,paid_gross_cents=excluded.paid_gross_cents,
           provider_reference=COALESCE(excluded.provider_reference,order_payment_states.provider_reference),updated_at=excluded.updated_at
         WHERE order_payment_states.status NOT IN ('paid','provider_authorised','stock_exception') OR ?2 IN ('paid','stock_exception')`
      )
      .bind(row.order_id, status, now, row.id, next),
    db
      .prepare(
        `INSERT OR IGNORE INTO order_events(id,order_id,event_type,payload_json,correlation_id,created_at)
         SELECT 'order-event:preauth:'||p.id||':'||?2,p.order_id,?3,json_object('preauthId',p.id,'amountGrossCents',p.amount_cents,'provider','redsys'),
           'preauth:'||p.id,?4 FROM payment_preauths p WHERE p.id=?1 AND p.version=?5`
      )
      .bind(row.id, status, eventType, now, next)
  ]
}

async function reread(deps: PreauthDependencies, id: string): Promise<Row> {
  const row = await load(deps.database, id)
  if (!row) throw new PreauthError('unavailable')
  return row
}

/** Applies the provider capture for a row already claimed as capture_pending. Safe to repeat. */
async function finishCapture(
  deps: PreauthDependencies,
  row: Row
): Promise<{ row: Row; outcome: 'captured' | 'rejected' | 'stock_exception' }> {
  if (row.status !== 'capture_pending') throw new PreauthError('conflict')
  let result: Awaited<ReturnType<PreauthProvider['capture']>>
  try {
    result = await deps.provider.capture({
      preauthId: row.id,
      merchantOrder: row.merchant_order,
      amountCents: row.amount_cents,
      idempotencyKey: `preauth:${row.id}:capture`
    })
  } catch {
    throw new PreauthError('unavailable')
  }
  const now = clock(deps)
  if (result.outcome === 'rejected') {
    const ok = await transition(deps.database, row, {
      now,
      from: 'capture_pending',
      to: 'authorized',
      expectedVersion: row.version,
      event: 'capture_rejected',
      responseCode: result.responseCode ?? null
    })
    const current = await reread(deps, row.id)
    if (!ok && current.status === 'capture_pending') throw new PreauthError('unavailable')
    return { row: current, outcome: 'rejected' }
  }
  let assignment: AssignResult
  try {
    assignment = await deps.inventory.assign({
      idempotencyKey: row.reservation_id,
      correlationId: `preauth:${row.id}`,
      now,
      reason: `Pre-authorisation ${row.id} captured`
    })
  } catch {
    throw new PreauthError('unavailable')
  }
  const assigned =
    assignment.outcome === 'assigned' || (assignment.outcome === 'replayed' && assignment.status === 'assigned')
  const to = assigned ? 'captured' : 'stock_exception'
  const ok = await transition(deps.database, row, {
    now,
    from: 'capture_pending',
    to,
    expectedVersion: row.version,
    event: assigned ? 'captured' : 'stock_exception',
    responseCode: result.responseCode && /^\d{4}$/.test(result.responseCode) ? result.responseCode : null,
    providerReference: result.providerReference?.slice(0, 100) ?? null,
    extra: orderStateStatements(
      deps.database,
      row,
      assigned ? 'paid' : 'stock_exception',
      now,
      assigned ? 'payment_captured' : 'payment_stock_exception'
    )
  })
  const current = await reread(deps, row.id)
  if (!ok && current.status === 'capture_pending') throw new PreauthError('unavailable')
  return { row: current, outcome: current.status === 'captured' ? 'captured' : 'stock_exception' }
}

async function finishCancel(deps: PreauthDependencies, row: Row): Promise<Row> {
  if (row.status !== 'cancel_pending') throw new PreauthError('conflict')
  let result: Awaited<ReturnType<PreauthProvider['cancel']>>
  try {
    result = await deps.provider.cancel({
      preauthId: row.id,
      merchantOrder: row.merchant_order,
      amountCents: row.amount_cents,
      idempotencyKey: `preauth:${row.id}:cancel`
    })
  } catch {
    throw new PreauthError('unavailable')
  }
  // A refused void leaves the claim in place: the hold is still the bank's, so retry rather than free the stock.
  if (result.outcome !== 'cancelled') throw new PreauthError('unavailable')
  const now = clock(deps)
  try {
    await releaseStockIfUnused(deps, row, now)
  } catch {
    throw new PreauthError('unavailable')
  }
  const ok = await transition(deps.database, row, {
    now,
    from: 'cancel_pending',
    to: 'cancelled',
    expectedVersion: row.version,
    event: 'cancelled',
    extra: orderStateStatements(deps.database, row, 'cancelled', now, 'payment_preauth_cancelled')
  })
  const current = await reread(deps, row.id)
  if (!ok && current.status === 'cancel_pending') throw new PreauthError('unavailable')
  return current
}

async function claim(
  claims: VerifiedSessionClaims | null,
  raw: unknown,
  id: string,
  action: 'capture' | 'cancel',
  deps: PreauthDependencies
): Promise<PreauthView & { outcome: string }> {
  if (!uuid.safeParse(id).success) throw new PreauthError('invalid_input')
  const parsed = operationSchema.safeParse(raw)
  if (!parsed.success) throw new PreauthError('invalid_input')
  const input = parsed.data
  const now = clock(deps)
  const identityId = await admin(deps.database, claims, now)
  const payloadHash = await canonicalPayloadHash({
    kind: `preauth-${action}`,
    id,
    expectedVersion: input.expectedVersion
  })
  const pending: Status = action === 'capture' ? 'capture_pending' : 'cancel_pending'
  const resume = async (): Promise<PreauthView & { outcome: string }> => {
    let row = await reread(deps, id)
    if (row.status === 'capture_pending' && action === 'capture') {
      const done = await finishCapture(deps, row)
      return { ...view(done.row), outcome: done.outcome }
    }
    if (row.status === 'cancel_pending' && action === 'cancel') {
      row = await finishCancel(deps, row)
    }
    return { ...view(row), outcome: row.status }
  }
  const existing = await commandFor(deps.database, input.commandId)
  if (existing) {
    if (existing.action !== action || existing.preauth_id !== id || existing.payload_hash !== payloadHash)
      throw new PreauthError('conflict')
    return resume()
  }
  const row = await load(deps.database, id)
  if (!row) throw new PreauthError('not_found')
  if (row.version !== input.expectedVersion || row.status !== 'authorized') throw new PreauthError('conflict')
  if (!row.authorized_until || row.authorized_until <= now) throw new PreauthError('conflict')
  const won = await transition(deps.database, row, {
    now,
    from: 'authorized',
    to: pending,
    expectedVersion: row.version,
    event: action === 'capture' ? 'capture_requested' : 'cancel_requested',
    actor: { claims: claims!, identityId },
    command: { id: input.commandId, action, payloadHash }
  })
  if (!won) {
    const raced = await commandFor(deps.database, input.commandId)
    if (raced && raced.preauth_id === id && raced.payload_hash === payloadHash && raced.action === action)
      return resume()
    await admin(deps.database, claims, clock(deps))
    throw new PreauthError('conflict')
  }
  return resume()
}

export const capturePreauthorization = (
  claims: VerifiedSessionClaims | null,
  id: string,
  raw: unknown,
  deps: PreauthDependencies
) => claim(claims, raw, id, 'capture', deps)
export const cancelPreauthorization = (
  claims: VerifiedSessionClaims | null,
  id: string,
  raw: unknown,
  deps: PreauthDependencies
) => claim(claims, raw, id, 'cancel', deps)

/* ------------------------------------------------------------------ notifications */

const ORDER_PATTERN = /^[A-Za-z0-9]{4,12}$/
export async function processPreauthNotification(
  envelope: { Ds_MerchantParameters: string; Ds_SignatureVersion: string; Ds_Signature: string },
  deps: PreauthDependencies
): Promise<{ outcome: 'authorized' | 'failed' | 'mismatch' | 'replayed' | 'cancelled' | 'unavailable' }> {
  const config = deps.configuration
  if (
    envelope.Ds_SignatureVersion !== 'HMAC_SHA512_V2' ||
    !envelope.Ds_MerchantParameters ||
    !envelope.Ds_Signature ||
    envelope.Ds_MerchantParameters.length > 16384 ||
    envelope.Ds_Signature.length > 16384 ||
    !(await verifyMerchantSignature(envelope.Ds_MerchantParameters, envelope.Ds_Signature, config.secretKey))
  )
    throw new PreauthError('invalid_input')
  let p: Record<string, string>
  try {
    p = decodeMerchantParameters(envelope.Ds_MerchantParameters)
  } catch {
    throw new PreauthError('invalid_input')
  }
  const merchantOrder = p.DS_ORDER
  const amount = p.DS_AMOUNT
  if (
    !merchantOrder ||
    !ORDER_PATTERN.test(merchantOrder) ||
    !amount ||
    !/^\d{1,12}$/.test(amount) ||
    !/^\d{1,4}$/.test(p.DS_RESPONSE ?? '') ||
    p.DS_MERCHANTCODE !== config.merchantCode ||
    (p.DS_TERMINAL ?? '').padStart(3, '0') !== config.terminal.padStart(3, '0') ||
    p.DS_CURRENCY !== '978' ||
    // Ordinary payments are transaction type 0 and use their own route: never cross the two.
    p.DS_TRANSACTIONTYPE !== '1'
  )
    throw new PreauthError('invalid_input')
  const row = await deps.database.prepare(`${SELECT_ROW} WHERE p.merchant_order=?`).bind(merchantOrder).first<Row>()
  if (!row) throw new PreauthError('not_found')
  if (Number(amount) !== row.amount_cents) return { outcome: 'mismatch' }
  const response = p.DS_RESPONSE!.padStart(4, '0')
  const approved = Number(response) >= 0 && Number(response) <= 99
  const now = clock(deps)
  const reference = p.DS_AUTHORISATIONCODE ? `${merchantOrder}:${p.DS_AUTHORISATIONCODE}`.slice(0, 100) : null
  if (!approved) {
    if (row.status !== 'requested') return { outcome: 'replayed' }
    await transition(deps.database, row, {
      now,
      from: 'requested',
      to: 'failed',
      expectedVersion: row.version,
      event: 'authorization_failed',
      responseCode: response
    })
    return { outcome: 'failed' }
  }
  if (row.status === 'expired') {
    // The bank placed a hold after the local window closed: it has no owner, so void it.
    const ok = await transition(deps.database, row, {
      now,
      from: 'expired',
      to: 'cancel_pending',
      expectedVersion: row.version,
      event: 'late_authorization',
      responseCode: response,
      providerReference: reference
    })
    const current = await reread(deps, row.id)
    if (ok || current.status === 'cancel_pending') {
      try {
        await finishCancel(deps, current)
      } catch {
        return { outcome: 'unavailable' }
      }
    }
    return { outcome: (await reread(deps, row.id)).status === 'cancelled' ? 'cancelled' : 'unavailable' }
  }
  let current = row
  if (row.status === 'requested') {
    const authorized = await transition(deps.database, row, {
      now,
      from: 'requested',
      to: 'authorized',
      expectedVersion: row.version,
      event: 'authorized',
      responseCode: response,
      providerReference: reference,
      authorizedUntil: plus(now, hold(deps))
    })
    current = await reread(deps, row.id)
    if (!authorized && current.status === 'requested') return { outcome: 'unavailable' }
  } else if (row.status === 'cancel_pending') {
    // An earlier delivery claimed the void but did not finish it: finish it now.
    try {
      await finishCancel(deps, row)
    } catch {
      return { outcome: 'unavailable' }
    }
    return { outcome: 'replayed' }
  }
  if (current.status !== 'authorized' || !current.authorized_until) return { outcome: 'replayed' }
  // Stock must outlive the hold. Re-attempted on every delivery, so a failure here can never leave an
  // authorised hold over a reservation that will lapse. If stock is gone the hold is voided instead.
  let renewal: SimpleResult
  try {
    renewal = await deps.inventory.renew({
      idempotencyKey: current.reservation_id,
      correlationId: `preauth:${current.id}`,
      now,
      expiresAt: current.authorized_until,
      reason: `Pre-authorisation ${current.id} authorised`
    })
  } catch {
    return { outcome: 'unavailable' }
  }
  if (renewal.outcome === 'applied' || renewal.outcome === 'replayed')
    return { outcome: row.status === 'requested' ? 'authorized' : 'replayed' }
  const ok = await transition(deps.database, current, {
    now,
    from: 'authorized',
    to: 'cancel_pending',
    expectedVersion: current.version,
    event: 'stock_unavailable'
  })
  const claimed = ok ? await reread(deps, row.id) : current
  if (claimed.status === 'cancel_pending') {
    try {
      await finishCancel(deps, claimed)
    } catch {
      return { outcome: 'unavailable' }
    }
  }
  return { outcome: (await reread(deps, row.id)).status === 'cancelled' ? 'cancelled' : 'unavailable' }
}

/* ------------------------------------------------------------------ scheduled sweep */

/** Expires unfinished requests/holds and resumes interrupted claims. Bounded and idempotent. */
export async function sweepPreauthorizations(
  deps: PreauthDependencies,
  limit = 25
): Promise<{ expired: number; resumed: number; failed: number }> {
  const now = clock(deps)
  const max = Math.min(Math.max(limit, 1), 100)
  const report = { expired: 0, resumed: 0, failed: 0 }
  const due = await deps.database
    .prepare(
      `${SELECT_ROW} WHERE (p.status='requested' AND p.redirect_expires_at<=?1)
         OR (p.status='authorized' AND p.authorized_until<=?1)
         OR (p.status IN ('capture_pending','cancel_pending') AND p.updated_at<=?2)
       ORDER BY p.updated_at,p.id LIMIT ?3`
    )
    .bind(now, plus(now, -RESUME_AFTER_SECONDS), max)
    .all<Row>()
  for (const row of due.results) {
    try {
      if (row.status === 'requested' || row.status === 'authorized') {
        const ok = await transition(deps.database, row, {
          now,
          from: row.status,
          to: 'expired',
          expectedVersion: row.version,
          event: row.status === 'requested' ? 'request_expired' : 'hold_expired',
          // An unanswered request leaves the order payable; only an expired hold ends the order's payment.
          ...(row.status === 'authorized'
            ? { extra: orderStateStatements(deps.database, row, 'cancelled', now, 'payment_preauth_expired') }
            : {})
        })
        if (!ok) continue
        report.expired += 1
        if (row.status === 'authorized') {
          // The bank hold lapses by itself; a best-effort void only shortens it. Stock is freed first.
          await releaseStockIfUnused(deps, row, now).catch(() => false)
          await deps.provider
            .cancel({
              preauthId: row.id,
              merchantOrder: row.merchant_order,
              amountCents: row.amount_cents,
              idempotencyKey: `preauth:${row.id}:void-expired`
            })
            .catch(() => undefined)
        }
      } else if (row.status === 'capture_pending') {
        await finishCapture(deps, row)
        report.resumed += 1
      } else {
        await finishCancel(deps, row)
        report.resumed += 1
      }
    } catch {
      report.failed += 1
    }
  }
  return report
}

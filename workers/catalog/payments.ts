/** Payment intent and provider-notification saga for D1/Workers. */

import { canonicalPayloadHash } from './cart'
import { redeemedStoreCreditCents } from '../pricing/checkout-store-credit'
import { prepareOrderPaymentEnqueue } from '../communications/order-payment-email'
import { publicationValidityExpression } from './publication-validity'
import { isD1CheckConstraintFailure } from '../runtime/d1-errors'
import { assignReservation, sha256Hex, type AssignResult, type OperationInput } from './inventory'
import {
  createRedsysRedirect,
  sha256Hex as redsysSha256Hex,
  verifyRedsysNotification,
  type RedsysConfiguration,
  type RedsysEnvelope,
  type RedsysNotification,
  type RedsysPaymentMethod
} from '../payments/redsys'

const MAX_KEY_LENGTH = 200

const invalidOrderPublication = `EXISTS (SELECT 1 FROM order_lines line
  JOIN variants v ON v.id = line.variant_id JOIN products p ON p.id = v.product_id
  JOIN categories c ON c.id = p.category_id
  WHERE line.order_id = ?1 AND (v.status <> 'published' OR p.status <> 'published'
    OR c.status <> 'published' OR NOT ${publicationValidityExpression('p')}))`

async function assertOrderPublicationsCurrent(database: D1Database, orderId: string): Promise<void> {
  const current = await database
    .prepare(`SELECT NOT ${invalidOrderPublication} AS valid`)
    .bind(orderId)
    .first<{ valid: number }>()
  if (!current) throw new PaymentError('infrastructure', 'Cannot validate order publication')
  if (current.valid !== 1) throw new PaymentError('not_payable', 'Order publication is no longer valid')
}

export class PaymentError extends Error {
  constructor(
    readonly code:
      | 'invalid_input'
      | 'unauthorized'
      | 'not_payable'
      | 'payment_in_progress'
      | 'stale_payment_attempt'
      | 'already_paid'
      | 'conflict'
      | 'invalid_notification'
      | 'infrastructure',
    message: string
  ) {
    super(message)
  }
}

export interface PaymentInventoryGateway {
  assign(input: OperationInput): Promise<AssignResult>
}

function directInventoryGateway(database: D1Database): PaymentInventoryGateway {
  return { assign: (input) => assignReservation(database, input) }
}

export interface PaymentRuntimeConfiguration extends RedsysConfiguration {
  publicBaseUrl: string
}

export interface InitiatePaymentInput {
  orderId: string
  orderToken: string
  idempotencyKey: string
  method: RedsysPaymentMethod
  correlationId: string
  now: string
  randomUUID?: () => string
}

interface OrderForPayment {
  id: string
  status: string
  total_gross_cents: number
  currency: string
  reservation_id: string
  reservation_expires_at: string
  reservation_status: string | null
}

interface PaymentCommandRow {
  payload_hash: string
  response_status: number
  response_body: string
}

interface PaymentIntentRow {
  id: string
  order_id: string
  merchant_order: string
  status: string
  amount_gross_cents: number
  currency: string
  reservation_id: string
  response_code: string | null
  provider_reference: string | null
}

function assertKey(value: string, name: string): void {
  if (
    !value ||
    value.length > MAX_KEY_LENGTH ||
    [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  )
    throw new PaymentError('invalid_input', `${name} is invalid`)
}

function assertInstant(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value))
    throw new PaymentError('invalid_input', 'now must be canonical ISO-8601 UTC')
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().replace('.000Z', 'Z') !== value)
    throw new PaymentError('invalid_input', 'now must be a real ISO-8601 UTC instant')
}

async function authorizeOrder(
  database: D1Database,
  orderId: string,
  orderToken: string,
  now: string
): Promise<OrderForPayment> {
  const tokenHash = await sha256Hex(orderToken)
  const cutoff = plusSeconds(now, -24 * 60 * 60)
  const order = await database
    .prepare(
      `SELECT o.id, o.status, o.total_gross_cents, o.currency, o.reservation_id,
              o.reservation_expires_at, r.status AS reservation_status
       FROM orders o
       LEFT JOIN inventory_reservations r ON r.id = o.reservation_id
       WHERE o.id = ?1 AND o.token_hash = ?2 AND o.access_revoked_at IS NULL
         AND o.created_at <= ?3 AND o.created_at > ?4`
    )
    .bind(orderId, tokenHash, now, cutoff)
    .first<OrderForPayment>()
  if (!order) throw new PaymentError('unauthorized', 'Order not found')
  return order
}

async function findCommand(database: D1Database, orderId: string, commandId: string) {
  return database
    .prepare(
      `SELECT payload_hash, response_status, response_body
       FROM payment_commands WHERE order_id = ?1 AND command_id = ?2`
    )
    .bind(orderId, commandId)
    .first<PaymentCommandRow>()
}

/** Both ordinary and lost-race replays must recheck the same live financial
 * and access facts. A historical redirect is not usable after payment capture.
 */
async function replayPaymentCommand(
  database: D1Database,
  input: InitiatePaymentInput,
  command: PaymentCommandRow,
  payloadHash: string
): Promise<{ status: number; body: Record<string, unknown> }> {
  if (command.payload_hash !== payloadHash)
    throw new PaymentError('conflict', 'Idempotency key reused with a different payload')
  const order = await authorizeOrder(database, input.orderId, input.orderToken, input.now)
  const paymentState = await database
    .prepare('SELECT status FROM order_payment_states WHERE order_id = ?1')
    .bind(order.id)
    .first<{ status: string }>()
  if (paymentState && ['paid', 'provider_authorised', 'stock_exception'].includes(paymentState.status))
    throw new PaymentError('already_paid', 'Provider payment has already been authorised')
  const body = JSON.parse(command.response_body) as Record<string, unknown>
  const intent =
    typeof body.paymentIntentId === 'string'
      ? await database
          .prepare('SELECT status, expires_at AS expiresAt FROM payment_intents WHERE id = ?1 AND order_id = ?2')
          .bind(body.paymentIntentId, order.id)
          .first<{ status: string; expiresAt: string }>()
      : null
  if (
    order.status !== 'awaiting_payment' ||
    order.reservation_status !== 'reserved' ||
    order.reservation_expires_at <= input.now ||
    !intent ||
    intent.status !== 'redirect_ready' ||
    intent.expiresAt <= input.now
  )
    throw new PaymentError('stale_payment_attempt', 'The saved payment redirect is no longer usable')
  await assertOrderPublicationsCurrent(database, order.id)
  return { body, status: command.response_status }
}

async function merchantOrderForIntent(intentId: string): Promise<string> {
  const digest = await redsysSha256Hex(`neteco:redsys-order:v1\u0000${intentId}`)
  const numericPrefix = [...digest.slice(0, 4)]
    .map((character) => (Number.parseInt(character, 16) % 10).toString())
    .join('')
  return `${numericPrefix}${digest.slice(4, 12).toUpperCase()}`
}

function plusSeconds(instant: string, seconds: number): string {
  return new Date(Date.parse(instant) + seconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

export async function initiateRedsysPayment(
  database: D1Database,
  input: InitiatePaymentInput,
  configuration: PaymentRuntimeConfiguration
): Promise<{ status: number; body: Record<string, unknown> }> {
  assertKey(input.idempotencyKey, 'idempotencyKey')
  assertKey(input.correlationId, 'correlationId')
  assertKey(input.orderToken, 'orderToken')
  assertInstant(input.now)
  if (input.method !== 'card' && input.method !== 'bizum')
    throw new PaymentError('invalid_input', 'Unsupported payment method')

  // Authentication always precedes replay lookup so a leaked command key does
  // not become an order-access credential.
  const order = await authorizeOrder(database, input.orderId, input.orderToken, input.now)
  const payloadHash = await canonicalPayloadHash({ kind: 'redsys-payment', method: input.method, orderId: order.id })
  const previous = await findCommand(database, order.id, input.idempotencyKey)
  if (previous) return replayPaymentCommand(database, input, previous, payloadHash)

  const paymentState = await database
    .prepare('SELECT status FROM order_payment_states WHERE order_id = ?1')
    .bind(order.id)
    .first<{ status: string }>()
  if (paymentState && ['paid', 'provider_authorised', 'stock_exception'].includes(paymentState.status))
    throw new PaymentError('already_paid', 'Provider payment has already been authorised')
  if (order.status !== 'awaiting_payment') throw new PaymentError('not_payable', 'Order is not payable')
  if (order.reservation_status !== 'reserved' || order.reservation_expires_at <= input.now)
    throw new PaymentError('not_payable', 'Order reservation is not active')
  await assertOrderPublicationsCurrent(database, order.id)
  const active = await database
    .prepare(
      `SELECT id FROM payment_intents
       WHERE order_id = ?1 AND status IN ('redirect_ready', 'processing', 'provider_authorised')`
    )
    .bind(order.id)
    .first<{ id: string }>()
  if (active) throw new PaymentError('payment_in_progress', 'A payment is already in progress')

  // PRI-018: store credit applied to the order is deducted from the amount charged (never from the order total).
  const amountDueCents = order.total_gross_cents - (await redeemedStoreCreditCents(database, order.id))
  if (!Number.isSafeInteger(amountDueCents) || amountDueCents < 1)
    throw new PaymentError('not_payable', 'Order has no amount to charge')
  const intentId = input.randomUUID ? input.randomUUID() : crypto.randomUUID()
  const merchantOrder = await merchantOrderForIntent(intentId)
  const baseUrl = new URL(configuration.publicBaseUrl)
  if (baseUrl.protocol !== 'https:') throw new PaymentError('infrastructure', 'Public payment URL must use HTTPS')
  const returnUrl = new URL('/pago/retorno', baseUrl)
  returnUrl.searchParams.set('order', order.id)
  const notificationUrl = new URL('/api/payments/redsys/notification', baseUrl)
  const redirect = await createRedsysRedirect(configuration, {
    amountCents: amountDueCents,
    expiresAt: order.reservation_expires_at,
    merchantOrder,
    method: input.method,
    notificationUrl: notificationUrl.toString(),
    returnUrl: returnUrl.toString()
  })
  const responseBody = {
    expiresAt: redirect.expiresAt,
    paymentIntentId: intentId,
    redirect: {
      actionUrl: redirect.actionUrl,
      fields: redirect.fields,
      method: redirect.method
    },
    status: 'redirect_ready'
  }
  const envelopeHash = await canonicalPayloadHash(redirect.fields)
  const eventId = `order-payment-started:${intentId}`
  try {
    await database.batch([
      database
        .prepare(
          `INSERT INTO payment_intents (
             id, order_id, provider, merchant_order, method, status, amount_gross_cents,
             currency, request_hash, redirect_envelope_hash, expires_at, correlation_id,
             created_at, updated_at
           ) VALUES (?1, ?2, 'redsys', ?3, ?4, 'redirect_ready', ?5, 'EUR', ?6, ?7, ?8, ?9, ?10, ?10)`
        )
        .bind(
          intentId,
          order.id,
          merchantOrder,
          input.method,
          amountDueCents,
          payloadHash,
          envelopeHash,
          order.reservation_expires_at,
          input.correlationId,
          input.now
        ),
      database
        .prepare(
          `INSERT INTO payment_commands (
             order_id, command_id, payload_hash, response_status, response_body,
             correlation_id, created_at
           ) VALUES (?1, ?2, ?3, 201, ?4, ?5, ?6)`
        )
        .bind(
          order.id,
          input.idempotencyKey,
          payloadHash,
          JSON.stringify(responseBody),
          input.correlationId,
          input.now
        ),
      database
        .prepare(
          `INSERT INTO order_payment_states (
             order_id, status, active_intent_id, paid_gross_cents, updated_at
           ) VALUES (?1, 'processing', ?2, 0, ?3)
           ON CONFLICT (order_id) DO UPDATE SET
             status = 'processing', active_intent_id = excluded.active_intent_id,
             paid_gross_cents = 0, provider_reference = NULL, response_code = NULL,
             updated_at = excluded.updated_at
           WHERE order_payment_states.status NOT IN ('paid', 'provider_authorised', 'stock_exception')`
        )
        .bind(order.id, intentId, input.now),
      database
        .prepare(
          `INSERT INTO order_events (
             id, order_id, event_type, payload_json, correlation_id, created_at
           ) VALUES (?1, ?2, 'payment_started', ?3, ?4, ?5)`
        )
        .bind(
          eventId,
          order.id,
          JSON.stringify({ intentId, merchantOrder, method: input.method, provider: 'redsys' }),
          input.correlationId,
          input.now
        ),
      // GUARD: request, intent and operational state must commit together.
      database
        .prepare(
          `INSERT INTO orders (
             id, cart_id, quote_id, shipping_quote_id, attempt_id, token_hash, status,
             reservation_id, reservation_expires_at, currency, total_net_cents,
             total_tax_cents, total_gross_cents, shipping_net_cents, shipping_tax_cents,
             shipping_gross_cents, shipping_method_code, shipping_rate_version,
             shipping_eta_min_days, shipping_eta_max_days, contact_email,
             contact_email_hash, consent_tos, consent_privacy, correlation_id,
             created_at, updated_at
           ) SELECT 'payment-guard:' || ?1, '', '', '', '', printf('%.0f', 0),
                    'guard-impossible', '', ?2, 'EUR', 0, 0, 0, 0, 0, 0, '', 1,
                    0, 0, 'x', printf('%.0f', 0), 1, 1, ?3, ?4, ?4
           WHERE EXISTS (
             SELECT 1 FROM payment_fulfilment_claims WHERE order_id = ?5
           ) OR NOT EXISTS (
             SELECT 1 FROM payment_commands WHERE order_id = ?5 AND command_id = ?6
           ) OR NOT EXISTS (
             SELECT 1 FROM payment_intents WHERE id = ?1 AND order_id = ?5 AND status = 'redirect_ready'
           ) OR NOT EXISTS (
             SELECT 1 FROM order_payment_states
             WHERE order_id = ?5 AND active_intent_id = ?1 AND status = 'processing'
           ) OR NOT EXISTS (
             SELECT 1 FROM orders payable JOIN inventory_reservations reservation ON reservation.id=payable.reservation_id
             WHERE payable.id=?5 AND payable.status='awaiting_payment' AND reservation.status='reserved'
               AND reservation.expires_at>max(?4,strftime('%Y-%m-%dT%H:%M:%SZ','now'))
               AND payable.reservation_expires_at>max(?4,strftime('%Y-%m-%dT%H:%M:%SZ','now'))
           ) OR ${invalidOrderPublication.replaceAll('?1', '?5')}`
        )
        .bind(intentId, order.reservation_expires_at, input.correlationId, input.now, order.id, input.idempotencyKey)
    ])
  } catch (error) {
    const raced = await findCommand(database, order.id, input.idempotencyKey)
    if (raced) return replayPaymentCommand(database, input, raced, payloadHash)
    const claimed = await database
      .prepare('SELECT 1 AS ok FROM payment_fulfilment_claims WHERE order_id = ?1')
      .bind(order.id)
      .first<{ ok: number }>()
    if (claimed) throw new PaymentError('already_paid', 'Provider payment has already been authorised')
    const live = await database
      .prepare(
        `SELECT 1 AS ok FROM payment_intents
         WHERE order_id = ?1 AND status IN ('redirect_ready', 'processing', 'provider_authorised')`
      )
      .bind(order.id)
      .first<{ ok: number }>()
    if (live) throw new PaymentError('payment_in_progress', 'A payment is already in progress')
    if (isD1CheckConstraintFailure(error)) {
      const clock = await database
        .prepare("SELECT strftime('%Y-%m-%dT%H:%M:%SZ','now') AS now")
        .first<{ now: string }>()
      if (!clock) throw new PaymentError('infrastructure', 'Cannot validate payment clock')
      const currentInstant = clock.now > input.now ? clock.now : input.now
      const current = await authorizeOrder(database, input.orderId, input.orderToken, currentInstant)
      if (
        current.status !== 'awaiting_payment' ||
        current.reservation_status !== 'reserved' ||
        current.reservation_expires_at <= currentInstant
      )
        throw new PaymentError('not_payable', 'Order reservation is not active')
      await assertOrderPublicationsCurrent(database, order.id)
    }
    throw new PaymentError('infrastructure', `Payment initiation failed: ${(error as Error).message}`)
  }
  await assertOrderPublicationsCurrent(database, order.id)
  return { body: responseBody, status: 201 }
}

async function loadIntent(database: D1Database, merchantOrder: string): Promise<PaymentIntentRow | null> {
  return database
    .prepare(
      `SELECT p.id, p.order_id, p.merchant_order, p.status, p.amount_gross_cents,
              p.currency, o.reservation_id, p.response_code, p.provider_reference
       FROM payment_intents p JOIN orders o ON o.id = p.order_id
       WHERE p.merchant_order = ?1`
    )
    .bind(merchantOrder)
    .first<PaymentIntentRow>()
}

function paymentEventInsert(
  database: D1Database,
  intent: PaymentIntentRow,
  notification: RedsysNotification,
  eventType: string,
  correlationId: string,
  now: string,
  providerEventId = notification.providerEventId
) {
  return database
    .prepare(
      `INSERT OR IGNORE INTO payment_events (
         id, payment_intent_id, order_id, provider_event_id, event_type, payload_hash,
         response_code, provider_reference, correlation_id, created_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`
    )
    .bind(
      `payment-event:${providerEventId}`,
      intent.id,
      intent.order_id,
      providerEventId,
      eventType,
      notification.payloadHash,
      notification.responseCode,
      notification.providerReference ?? null,
      correlationId,
      now
    )
}

function orderEventInsert(
  database: D1Database,
  intent: PaymentIntentRow,
  eventType: string,
  payload: Record<string, unknown>,
  correlationId: string,
  now: string,
  eventKey: string
) {
  return database
    .prepare(
      `INSERT OR IGNORE INTO order_events (
         id, order_id, event_type, payload_json, correlation_id, created_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
    )
    .bind(`order-event:${eventKey}`, intent.order_id, eventType, JSON.stringify(payload), correlationId, now)
}

async function persistNonCapturedNotification(
  database: D1Database,
  intent: PaymentIntentRow,
  notification: RedsysNotification,
  correlationId: string,
  now: string
) {
  const intentStatus = notification.status === 'pending' ? 'processing' : notification.status
  const orderStatus = notification.status === 'pending' ? 'processing' : notification.status
  const eventType = `notification_${notification.status}`
  await database.batch([
    paymentEventInsert(database, intent, notification, eventType, correlationId, now),
    database
      .prepare(
        `UPDATE payment_intents
         SET status = ?2, response_code = ?3, provider_reference = COALESCE(?4, provider_reference), updated_at = ?5
         WHERE id = ?1 AND status IN ('redirect_ready', 'processing')`
      )
      .bind(intent.id, intentStatus, notification.responseCode, notification.providerReference ?? null, now),
    database
      .prepare(
        `UPDATE order_payment_states
         SET status = ?2, response_code = ?3, provider_reference = COALESCE(?4, provider_reference), updated_at = ?5
         WHERE order_id = ?1 AND active_intent_id = ?6
           AND status IN ('awaiting_payment', 'processing')`
      )
      .bind(
        intent.order_id,
        orderStatus,
        notification.responseCode,
        notification.providerReference ?? null,
        now,
        intent.id
      ),
    orderEventInsert(
      database,
      intent,
      `payment_${notification.status}`,
      { intentId: intent.id, responseCode: notification.responseCode },
      correlationId,
      now,
      notification.providerEventId
    )
  ])
}

type VerifiedCaptureSource = {
  schemaVersion: 1
  provider: 'redsys'
  bankEnvironment: RedsysConfiguration['environment']
  payloadHash: string
  signatureFingerprint: string
  verifiedAt: string
}

async function persistProviderAuthorised(
  database: D1Database,
  intent: PaymentIntentRow,
  notification: RedsysNotification,
  correlationId: string,
  now: string,
  captureSource: VerifiedCaptureSource | undefined
) {
  const payload = JSON.stringify({ intentId: intent.id, responseCode: notification.responseCode, captureSource })
  await database.batch([
    paymentEventInsert(database, intent, notification, 'provider_authorised', correlationId, now),
    database
      .prepare(
        `INSERT INTO payment_fulfilment_claims (order_id, payment_intent_id, created_at)
         VALUES (?1, ?2, ?3) ON CONFLICT (order_id) DO NOTHING`
      )
      .bind(intent.order_id, intent.id, now),
    database
      .prepare(
        `UPDATE payment_intents
         SET status = 'provider_authorised', response_code = ?2,
             provider_reference = COALESCE(?3, provider_reference), updated_at = ?4
         WHERE id = ?1 AND status NOT IN ('captured', 'stock_exception')`
      )
      .bind(intent.id, notification.responseCode, notification.providerReference ?? null, now),
    database
      .prepare(
        `UPDATE order_payment_states
         SET status = 'provider_authorised', active_intent_id = ?6, paid_gross_cents = ?2, response_code = ?3,
             provider_reference = COALESCE(?4, provider_reference), updated_at = ?5
         WHERE order_id = ?1 AND status NOT IN ('paid', 'stock_exception')
           AND EXISTS (SELECT 1 FROM payment_fulfilment_claims
                       WHERE order_id = ?1 AND payment_intent_id = ?6)`
      )
      .bind(
        intent.order_id,
        intent.amount_gross_cents,
        notification.responseCode,
        notification.providerReference ?? null,
        now,
        intent.id
      ),
    database
      .prepare(
        `INSERT INTO payment_recovery_jobs (
           payment_intent_id, order_id, status, attempts, due_at, created_at, updated_at, last_error_code
         ) SELECT ?1, ?2,
             CASE WHEN payment_intent_id = ?1 THEN 'pending' ELSE 'manual_review' END,
             0, ?3, ?3, ?3,
             CASE WHEN payment_intent_id = ?1 THEN NULL ELSE 'duplicate_provider_capture' END
           FROM payment_fulfilment_claims WHERE order_id = ?2
         ON CONFLICT (payment_intent_id) DO UPDATE SET
           status = payment_recovery_jobs.status,
           due_at = CASE WHEN payment_recovery_jobs.status = 'pending' THEN excluded.due_at ELSE payment_recovery_jobs.due_at END,
           updated_at = excluded.updated_at`
      )
      .bind(intent.id, intent.order_id, now),
    database
      .prepare(
        `INSERT OR IGNORE INTO order_events (
           id, order_id, event_type, payload_json, correlation_id, created_at
         ) SELECT ?1, ?2, 'payment_provider_authorised',
           CASE WHEN EXISTS (
             SELECT 1 FROM order_events previous
             WHERE previous.order_id = ?2 AND previous.event_type = 'payment_provider_authorised'
               AND json_extract(previous.payload_json, '$.intentId') = ?6
           ) THEN json_remove(?3, '$.captureSource') ELSE ?3 END, ?4, ?5`
      )
      .bind(
        `order-event:${notification.providerEventId}:authorised`,
        intent.order_id,
        payload,
        correlationId,
        now,
        intent.id
      )
  ])
}

async function markStockException(
  database: D1Database,
  intent: PaymentIntentRow,
  notification: RedsysNotification,
  correlationId: string,
  now: string
) {
  const localEvent = `intent:${intent.id}:local:stock-exception`
  await database.batch([
    paymentEventInsert(database, intent, notification, 'stock_exception', correlationId, now, localEvent),
    database
      .prepare("UPDATE payment_intents SET status = 'stock_exception', updated_at = ?2 WHERE id = ?1")
      .bind(intent.id, now),
    database
      .prepare("UPDATE order_payment_states SET status = 'stock_exception', updated_at = ?2 WHERE order_id = ?1")
      .bind(intent.order_id, now),
    database
      .prepare(
        `UPDATE payment_recovery_jobs
         SET status = 'manual_review', attempts = attempts + 1,
             last_error_code = 'reservation_not_assignable', updated_at = ?2
         WHERE payment_intent_id = ?1`
      )
      .bind(intent.id, now),
    orderEventInsert(
      database,
      intent,
      'payment_stock_exception',
      { intentId: intent.id, reservationId: intent.reservation_id },
      correlationId,
      now,
      localEvent
    )
  ])
}

async function markCaptured(
  database: D1Database,
  intent: PaymentIntentRow,
  notification: RedsysNotification,
  correlationId: string,
  now: string
) {
  // Callback and recovery are competing executors of the same domain effect.
  // Provider delivery identifiers must not create multiple local capture events.
  const localEvent = `intent:${intent.id}:local:captured`
  const email = await prepareOrderPaymentEnqueue(database, { orderId: intent.order_id, intentId: intent.id, now })
  await database.batch([
    paymentEventInsert(database, intent, notification, 'captured', correlationId, now, localEvent),
    database
      .prepare(
        `UPDATE payment_intents
         SET status = 'captured', response_code = ?2,
             provider_reference = COALESCE(?3, provider_reference), updated_at = ?4
         WHERE id = ?1 AND status IN ('provider_authorised', 'captured')`
      )
      .bind(intent.id, notification.responseCode, notification.providerReference ?? null, now),
    database
      .prepare(
        `UPDATE order_payment_states
         SET status = 'paid', paid_gross_cents = ?2, response_code = ?3,
             provider_reference = COALESCE(?4, provider_reference), updated_at = ?5
         WHERE order_id = ?1 AND active_intent_id = ?6`
      )
      .bind(
        intent.order_id,
        intent.amount_gross_cents,
        notification.responseCode,
        notification.providerReference ?? null,
        now,
        intent.id
      ),
    database
      .prepare(
        `UPDATE payment_recovery_jobs
         SET status = 'completed', attempts = attempts + 1, last_error_code = NULL, updated_at = ?2
         WHERE payment_intent_id = ?1`
      )
      .bind(intent.id, now),
    orderEventInsert(
      database,
      intent,
      'payment_captured',
      { amountGrossCents: intent.amount_gross_cents, intentId: intent.id, provider: 'redsys' },
      correlationId,
      now,
      localEvent
    ),
    email
  ])
}

async function noteRecoveryFailure(database: D1Database, intentId: string, now: string, code: string) {
  await database
    .prepare(
      `UPDATE payment_recovery_jobs
       SET attempts = attempts + 1, due_at = ?2, last_error_code = ?3, updated_at = ?4
       WHERE payment_intent_id = ?1 AND status = 'pending'`
    )
    .bind(intentId, plusSeconds(now, 60), code.slice(0, 80), now)
    .run()
}

async function finalizeAuthorisedPayment(
  database: D1Database,
  intent: PaymentIntentRow,
  notification: RedsysNotification,
  correlationId: string,
  now: string,
  inventory: PaymentInventoryGateway
): Promise<'captured' | 'stock_exception' | 'manual_review'> {
  const claim = await database
    .prepare('SELECT payment_intent_id FROM payment_fulfilment_claims WHERE order_id = ?1')
    .bind(intent.order_id)
    .first<{ payment_intent_id: string }>()
  if (!claim) throw new PaymentError('infrastructure', 'Missing payment fulfilment claim')
  if (claim.payment_intent_id !== intent.id) return 'manual_review'
  if (intent.status === 'captured') return 'captured'
  if (intent.status === 'stock_exception') return 'stock_exception'
  let assignment: AssignResult
  try {
    assignment = await inventory.assign({
      correlationId,
      idempotencyKey: intent.reservation_id,
      now,
      reason: `Payment captured for intent ${intent.id}`
    })
  } catch (error) {
    await noteRecoveryFailure(database, intent.id, now, 'inventory_unavailable')
    throw new PaymentError('infrastructure', `Inventory assignment failed: ${(error as Error).message}`)
  }
  if (assignment.outcome === 'assigned' || (assignment.outcome === 'replayed' && assignment.status === 'assigned')) {
    await markCaptured(database, intent, notification, correlationId, now)
    return 'captured'
  }
  await markStockException(database, intent, notification, correlationId, now)
  return 'stock_exception'
}

export async function processRedsysNotification(
  database: D1Database,
  envelope: RedsysEnvelope,
  configuration: RedsysConfiguration,
  input: { correlationId: string; now: string },
  inventory: PaymentInventoryGateway = directInventoryGateway(database)
): Promise<{
  outcome: 'captured' | 'pending' | 'failed' | 'cancelled' | 'mismatch' | 'stock_exception' | 'manual_review'
}> {
  assertKey(input.correlationId, 'correlationId')
  assertInstant(input.now)
  // Freeze the server-owned bank configuration before asynchronous verification.
  // APP_ENV and browser telemetry cannot attest a payment's source environment.
  const verificationConfiguration = Object.freeze({ ...configuration })
  let notification: RedsysNotification
  try {
    notification = await verifyRedsysNotification(verificationConfiguration, envelope)
  } catch (error) {
    throw new PaymentError('invalid_notification', (error as Error).message)
  }
  const intent = await loadIntent(database, notification.merchantOrder)
  if (!intent) throw new PaymentError('invalid_notification', 'Unknown Redsys merchant order')
  if (notification.amountCents !== intent.amount_gross_cents || notification.currencyCode !== '978') {
    await database.batch([
      paymentEventInsert(database, intent, notification, 'notification_mismatch', input.correlationId, input.now),
      orderEventInsert(
        database,
        intent,
        'payment_notification_mismatch',
        { intentId: intent.id, payloadHash: notification.payloadHash },
        input.correlationId,
        input.now,
        `${notification.providerEventId}:mismatch`
      )
    ])
    return { outcome: 'mismatch' }
  }
  if (notification.status !== 'captured') {
    await persistNonCapturedNotification(database, intent, notification, input.correlationId, input.now)
    return { outcome: notification.status }
  }

  // The first immutable authorisation event owns this proof, before inventory
  // assignment/recovery. The atomic first-authorisation guard also covers two
  // different callbacks racing on the same intent. Legacy authorisations are
  // never backfilled from today's configuration, even on a different payload.
  const captureSource: VerifiedCaptureSource | undefined = [
    'provider_authorised',
    'captured',
    'stock_exception'
  ].includes(intent.status)
    ? undefined
    : {
        schemaVersion: 1,
        provider: 'redsys',
        bankEnvironment: verificationConfiguration.environment,
        payloadHash: notification.payloadHash,
        signatureFingerprint: await redsysSha256Hex(envelope.Ds_Signature),
        verifiedAt: input.now
      }
  await persistProviderAuthorised(database, intent, notification, input.correlationId, input.now, captureSource)
  const current = (await loadIntent(database, notification.merchantOrder)) ?? intent
  const outcome = await finalizeAuthorisedPayment(
    database,
    current,
    notification,
    input.correlationId,
    input.now,
    inventory
  )
  return { outcome }
}

/** Replays only the local half of already verified/captured provider events. */
export async function recoverAuthorisedPayments(
  database: D1Database,
  input: { now: string; limit?: number },
  inventory: PaymentInventoryGateway = directInventoryGateway(database)
): Promise<{ recovered: number; manualReview: number; retryable: number }> {
  assertInstant(input.now)
  const limit = Math.min(Math.max(input.limit ?? 25, 1), 100)
  const jobs = (
    await database
      .prepare(
        `SELECT p.id, p.order_id, p.merchant_order, p.status, p.amount_gross_cents,
                p.currency, o.reservation_id, p.response_code, p.provider_reference
         FROM payment_recovery_jobs j
         JOIN payment_intents p ON p.id = j.payment_intent_id
         JOIN orders o ON o.id = p.order_id
         WHERE j.status = 'pending' AND j.due_at <= ?1 AND p.status = 'provider_authorised'
         ORDER BY j.due_at, p.id LIMIT ?2`
      )
      .bind(input.now, limit)
      .all<PaymentIntentRow>()
  ).results
  let recovered = 0
  let manualReview = 0
  let retryable = 0
  for (const intent of jobs) {
    const notification: RedsysNotification = {
      amountCents: intent.amount_gross_cents,
      currencyCode: '978',
      merchantOrder: intent.merchant_order,
      payloadHash: await redsysSha256Hex(`recovery:${intent.id}:${intent.response_code ?? '0000'}`),
      providerEventId: `${intent.merchant_order}:recovery:${intent.id}`,
      providerReference: intent.provider_reference ?? undefined,
      responseCode: intent.response_code ?? '0000',
      status: 'captured'
    }
    try {
      const outcome = await finalizeAuthorisedPayment(
        database,
        intent,
        notification,
        `payment-recovery:${intent.id}`,
        input.now,
        inventory
      )
      if (outcome === 'captured') recovered += 1
      else manualReview += 1
    } catch {
      retryable += 1
    }
  }
  return { manualReview, recovered, retryable }
}

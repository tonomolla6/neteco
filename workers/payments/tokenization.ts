/** PAY-022: tokenisation / one-click with explicit, revocable, audited consent.
 *
 * Only a bank-issued token is ever stored: card numbers never reach this code. A token exists only when
 * the customer consented for one specific payment, and the consent is recorded before the bank is asked.
 * Revocation reuses the self-service removal flow (token-removal.ts). One-click charges settle through the
 * same signed-notification path as checkout, so amounts and stock are reconciled identically.
 */
import { z } from 'zod'
import type { VerifiedSessionClaims } from '../catalog/authorization'
import { canonicalPayloadHash } from '../catalog/cart'
import { activeOrderCustomerId } from '../catalog/customer-orders'
import {
  initiateRedsysPayment,
  PaymentError,
  processRedsysNotification,
  type PaymentInventoryGateway,
  type PaymentRuntimeConfiguration
} from '../catalog/payments'
import {
  decodeMerchantParameters,
  encodeMerchantParameters,
  signMerchantParameters,
  verifyMerchantSignature,
  type RedsysEnvelope
} from './redsys'

/** Bump when the consent wording changes: older consents then no longer match what is displayed. */
export const ONE_CLICK_CONSENT_VERSION = 'one-click-2026-10'
export const MAX_SAVED_TOKENS = 5

export class TokenizationError extends Error {
  constructor(
    readonly code: 'invalid_input' | 'unauthenticated' | 'not_found' | 'conflict' | 'not_payable' | 'unavailable'
  ) {
    super(code)
  }
}

export interface OneClickProvider {
  /** Returns the bank's signed answer in the same envelope as an ordinary notification. */
  charge(input: {
    idempotencyKey: string
    merchantOrder: string
    amountCents: number
    providerToken: string
  }): Promise<RedsysEnvelope>
}
export interface TokenizationDependencies {
  database: D1Database
  configuration: PaymentRuntimeConfiguration
  provider: OneClickProvider
  inventory: PaymentInventoryGateway
  now: () => string
}

const uuid = z.string().uuid()
export const consentPaymentSchema = z
  .object({
    orderId: uuid,
    commandId: uuid,
    consent: z.literal(true),
    consentVersion: z.literal(ONE_CLICK_CONSENT_VERSION)
  })
  .strict()
export const oneClickSchema = z
  .object({
    tokenId: uuid,
    orderId: uuid,
    commandId: uuid,
    expectedVersion: z.number().int().safe().min(1)
  })
  .strict()

const instantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/
function clock(deps: TokenizationDependencies) {
  const now = deps.now()
  if (!instantPattern.test(now) || new Date(Date.parse(now)).toISOString().replace('.000Z', 'Z') !== now)
    throw new TokenizationError('unavailable')
  return now
}
const LIVE = `EXISTS(SELECT 1 FROM auth_sessions s JOIN identities i ON i.id=s.identity_id
 JOIN customers c ON c.id=i.customer_id AND c.status='active'
 WHERE s.id=?1 AND s.identity_id=?2 AND s.session_version=?3 AND i.session_version=s.session_version AND i.status='active'
 AND i.email_verified_at IS NOT NULL AND i.email_verified_at<=max(?4,strftime('%Y-%m-%dT%H:%M:%SZ','now'))
 AND s.revoked_at IS NULL AND s.created_at<=max(?4,strftime('%Y-%m-%dT%H:%M:%SZ','now'))
 AND s.expires_at>max(?4,strftime('%Y-%m-%dT%H:%M:%SZ','now')) AND c.id=?5)`

async function customerFor(deps: TokenizationDependencies, claims: VerifiedSessionClaims | null, now: string) {
  const customer = await activeOrderCustomerId(deps.database, claims, now)
  if (!customer) throw new TokenizationError('unauthenticated')
  return customer
}
async function ownedOrder(deps: TokenizationDependencies, customer: string, orderId: string) {
  const row = await deps.database
    .prepare('SELECT customer_id FROM orders WHERE id=?')
    .bind(orderId)
    .first<{ customer_id: string | null }>()
  // Another customer's (or a guest's) order is indistinguishable from a missing one.
  if (!row || row.customer_id !== customer) throw new TokenizationError('not_found')
}
function mapPayment(error: unknown): never {
  if (error instanceof PaymentError) {
    if (error.code === 'unauthorized') throw new TokenizationError('not_found')
    if (error.code === 'invalid_input') throw new TokenizationError('invalid_input')
    if (error.code === 'infrastructure') throw new TokenizationError('unavailable')
    throw new TokenizationError(error.code === 'conflict' ? 'conflict' : 'not_payable')
  }
  throw error
}

/** Same checkout intent, with the bank asked to issue a token. Needs the customer's explicit consent. */
export async function startTokenizedPayment(
  claims: VerifiedSessionClaims | null,
  orderToken: string,
  raw: unknown,
  deps: TokenizationDependencies
) {
  const parsed = consentPaymentSchema.safeParse(raw)
  if (!parsed.success) throw new TokenizationError('invalid_input')
  const input = parsed.data
  const now = clock(deps)
  const customer = await customerFor(deps, claims, now)
  await ownedOrder(deps, customer, input.orderId)
  const prior = await deps.database
    .prepare(
      'SELECT o.order_id,o.consent_version FROM payment_token_consent_requests o WHERE o.customer_id=? AND o.command_id=?'
    )
    .bind(customer, input.commandId)
    .first<{ order_id: string; consent_version: string }>()
  if (prior && (prior.order_id !== input.orderId || prior.consent_version !== input.consentVersion))
    throw new TokenizationError('conflict')
  let started: { status: number; body: Record<string, unknown> }
  try {
    started = await initiateRedsysPayment(
      deps.database,
      {
        orderId: input.orderId,
        orderToken,
        method: 'card',
        now,
        correlationId: `tokenize:${input.commandId}`,
        idempotencyKey: `tokenize:${input.commandId}`
      },
      deps.configuration
    )
  } catch (error) {
    mapPayment(error)
  }
  const intentId = started.body.paymentIntentId
  const redirect = started.body.redirect as
    { actionUrl: string; method: 'POST'; fields: Record<string, string> } | undefined
  if (typeof intentId !== 'string' || !redirect) throw new TokenizationError('unavailable')
  const parameters = decodeMerchantParameters(redirect.fields.Ds_MerchantParameters!)
  parameters.DS_MERCHANT_IDENTIFIER = 'REQUIRED'
  parameters.DS_MERCHANT_COF_INI = 'S'
  const encoded = encodeMerchantParameters(parameters)
  const patched = {
    ...redirect,
    fields: {
      ...redirect.fields,
      Ds_MerchantParameters: encoded,
      Ds_Signature: await signMerchantParameters(encoded, deps.configuration.secretKey, parameters.DS_MERCHANT_ORDER)
    }
  }
  // Consent is persisted before the shopper can reach the bank page; if this fails nothing is tokenised.
  await deps.database
    .prepare(
      `INSERT OR IGNORE INTO payment_token_consent_requests(payment_intent_id,customer_id,order_id,command_id,consent_version,created_at)
       SELECT i.id,?5,i.order_id,?6,?7,?4 FROM payment_intents i JOIN orders o ON o.id=i.order_id
       WHERE i.id=?8 AND i.order_id=?9 AND o.customer_id=?5 AND ${LIVE}`
    )
    .bind(
      claims!.sessionId,
      claims!.identityId,
      claims!.sessionVersion,
      now,
      customer,
      input.commandId,
      input.consentVersion,
      intentId,
      input.orderId
    )
    .run()
  const stored = await deps.database
    .prepare(
      'SELECT payment_intent_id,order_id,consent_version FROM payment_token_consent_requests WHERE customer_id=? AND command_id=?'
    )
    .bind(customer, input.commandId)
    .first<{ payment_intent_id: string; order_id: string; consent_version: string }>()
  if (!stored || stored.payment_intent_id !== intentId) throw new TokenizationError('unavailable')
  if ((await activeOrderCustomerId(deps.database, claims, clock(deps))) !== customer)
    throw new TokenizationError('unauthenticated')
  return {
    paymentIntentId: intentId,
    status: started.body.status,
    expiresAt: started.body.expiresAt,
    consentVersion: stored.consent_version,
    redirect: patched
  }
}

const TOKEN_FORMAT = /^[A-Za-z0-9]{10,100}$/
/** A card number must never be mistaken for a token, even if a misbehaving integration sent one. */
export function looksLikeCardNumber(value: string): boolean {
  return /^\d{13,19}$/.test(value.replace(/[ -]/g, ''))
}

/**
 * Called after a verified, captured checkout notification. Stores the bank token only when the same
 * payment carries a recorded consent. Safe to repeat (redelivery, recovery).
 */
export async function captureTokenAfterPayment(
  envelope: RedsysEnvelope,
  deps: TokenizationDependencies
): Promise<'created' | 'skipped' | 'duplicate'> {
  if (
    !(await verifyMerchantSignature(
      envelope.Ds_MerchantParameters,
      envelope.Ds_Signature,
      deps.configuration.secretKey
    ))
  )
    return 'skipped'
  const p = decodeMerchantParameters(envelope.Ds_MerchantParameters)
  const identifier = p.DS_MERCHANT_IDENTIFIER
  if (!identifier) return 'skipped'
  if (!TOKEN_FORMAT.test(identifier) || looksLikeCardNumber(identifier)) return 'skipped'
  if (
    p.DS_TRANSACTIONTYPE !== '0' ||
    !/^\d{1,4}$/.test(p.DS_RESPONSE ?? '') ||
    Number(p.DS_RESPONSE) > 99 ||
    !p.DS_ORDER
  )
    return 'skipped'
  const now = clock(deps)
  const intent = await deps.database
    .prepare('SELECT id,amount_gross_cents,status FROM payment_intents WHERE merchant_order=?')
    .bind(p.DS_ORDER)
    .first<{ id: string; amount_gross_cents: number; status: string }>()
  if (!intent || intent.status !== 'captured' || Number(p.DS_AMOUNT) !== intent.amount_gross_cents) return 'skipped'
  const id = crypto.randomUUID()
  const live = `r.payment_intent_id=?1 AND i.status='captured'
    AND NOT EXISTS(SELECT 1 FROM payment_saved_tokens WHERE source_intent_id=r.payment_intent_id)
    AND NOT EXISTS(SELECT 1 FROM payment_saved_tokens WHERE customer_id=r.customer_id AND provider_token=?3 AND status IN ('active','removal_pending'))
    AND (SELECT count(*) FROM payment_saved_tokens WHERE customer_id=r.customer_id AND status IN ('active','removal_pending'))<${MAX_SAVED_TOKENS}`
  await deps.database.batch([
    deps.database
      .prepare(
        `INSERT INTO payment_saved_tokens(id,customer_id,provider_token,status,version,consent_version,source_intent_id,consented_at,created_at,updated_at)
         SELECT ?2,r.customer_id,?3,'active',1,r.consent_version,r.payment_intent_id,r.created_at,?4,?4
         FROM payment_token_consent_requests r JOIN payment_intents i ON i.id=r.payment_intent_id
         JOIN customers c ON c.id=r.customer_id AND c.status='active' WHERE ${live}`
      )
      .bind(intent.id, id, identifier, now),
    deps.database
      .prepare(
        `INSERT INTO payment_token_consent_events(token_id,event,customer_id,consent_version,created_at)
         SELECT id,'granted',customer_id,consent_version,?2 FROM payment_saved_tokens WHERE id=?1 AND source_intent_id=?3`
      )
      .bind(id, now, intent.id)
  ])
  const created = await deps.database
    .prepare('SELECT id FROM payment_saved_tokens WHERE source_intent_id=?')
    .bind(intent.id)
    .first<{ id: string }>()
  if (!created) return 'skipped'
  return created.id === id ? 'created' : 'duplicate'
}

interface CommandRow {
  payload_hash: string
  token_id: string
  order_id: string
  payment_intent_id: string
  amount_cents: number
  status: 'started' | 'settled' | 'declined'
}
export type OneClickOutcome = 'paid' | 'declined' | 'pending' | 'review'
const result = (command: CommandRow, outcome: OneClickOutcome) => ({
  orderId: command.order_id,
  paymentIntentId: command.payment_intent_id,
  amountCents: command.amount_cents,
  outcome
})

/** One-click: the customer's own token, the order's own amount, the checkout's own reconciliation. */
export async function payWithSavedToken(
  claims: VerifiedSessionClaims | null,
  orderToken: string,
  raw: unknown,
  deps: TokenizationDependencies
) {
  const parsed = oneClickSchema.safeParse(raw)
  if (!parsed.success) throw new TokenizationError('invalid_input')
  const input = parsed.data
  const now = clock(deps)
  const customer = await customerFor(deps, claims, now)
  await ownedOrder(deps, customer, input.orderId)
  const hash = await canonicalPayloadHash({
    kind: 'one-click-v1',
    customerId: customer,
    tokenId: input.tokenId,
    orderId: input.orderId,
    expectedVersion: input.expectedVersion
  })
  const load = () =>
    deps.database
      .prepare(
        'SELECT payload_hash,token_id,order_id,payment_intent_id,amount_cents,status FROM payment_one_click_commands WHERE customer_id=? AND command_id=?'
      )
      .bind(customer, input.commandId)
      .first<CommandRow>()
  let command = await load()
  if (command && command.payload_hash !== hash) throw new TokenizationError('conflict')
  if (command?.status === 'settled') return result(command, 'paid')
  if (command?.status === 'declined') return result(command, 'declined')

  // The token is read server-side, only after proving ownership, an active state, the version and a live consent.
  const token = await deps.database
    .prepare(
      `SELECT t.provider_token AS token FROM payment_saved_tokens t
       WHERE t.id=?1 AND t.customer_id=?2 AND t.status='active' AND t.version=?3 AND t.provider_token IS NOT NULL
         AND EXISTS(SELECT 1 FROM payment_token_consent_events e WHERE e.token_id=t.id AND e.event='granted' AND e.consent_version=t.consent_version)
         AND NOT EXISTS(SELECT 1 FROM payment_token_consent_events e WHERE e.token_id=t.id AND e.event='revoked')`
    )
    .bind(input.tokenId, customer, input.expectedVersion)
    .first<{ token: string }>()
  if (!token) {
    const exists = await deps.database
      .prepare('SELECT 1 AS ok FROM payment_saved_tokens WHERE id=? AND customer_id=?')
      .bind(input.tokenId, customer)
      .first()
    throw new TokenizationError(exists ? 'conflict' : 'not_found')
  }
  if (!command) {
    let started: { status: number; body: Record<string, unknown> }
    try {
      started = await initiateRedsysPayment(
        deps.database,
        {
          orderId: input.orderId,
          orderToken,
          method: 'card',
          now,
          correlationId: `oneclick:${input.commandId}`,
          idempotencyKey: `oneclick:${input.commandId}`
        },
        deps.configuration
      )
    } catch (error) {
      mapPayment(error)
    }
    const intentId = started.body.paymentIntentId
    if (typeof intentId !== 'string') throw new TokenizationError('unavailable')
    const guard = crypto.randomUUID()
    const args = [claims!.sessionId, claims!.identityId, claims!.sessionVersion, now, customer]
    try {
      await deps.database.batch([
        deps.database
          .prepare(
            `INSERT INTO payment_one_click_commands(customer_id,command_id,payload_hash,token_id,order_id,payment_intent_id,amount_cents,status,created_at)
             SELECT ?5,?6,?7,t.id,i.order_id,i.id,i.amount_gross_cents,'started',?4
             FROM payment_saved_tokens t, payment_intents i JOIN orders o ON o.id=i.order_id
             WHERE t.id=?8 AND t.customer_id=?5 AND t.status='active' AND t.version=?9
               AND i.id=?10 AND i.order_id=?11 AND i.status='redirect_ready' AND o.customer_id=?5 AND o.status='awaiting_payment' AND ${LIVE}`
          )
          .bind(...args, input.commandId, hash, input.tokenId, input.expectedVersion, intentId, input.orderId),
        deps.database
          .prepare(
            `INSERT INTO payment_one_click_guards(id,valid) SELECT ?1,CASE WHEN EXISTS(
               SELECT 1 FROM payment_one_click_commands WHERE customer_id=?2 AND command_id=?3 AND payload_hash=?4) THEN 1 ELSE 0 END`
          )
          .bind(guard, customer, input.commandId, hash),
        deps.database.prepare('DELETE FROM payment_one_click_guards WHERE id=?').bind(guard)
      ])
    } catch {
      command = await load()
      if (!command || command.payload_hash !== hash) throw new TokenizationError('conflict')
    }
    command = await load()
    if (!command) throw new TokenizationError('not_payable')
    if (command.status !== 'started') return result(command, command.status === 'settled' ? 'paid' : 'declined')
  }
  const intent = await deps.database
    .prepare('SELECT merchant_order FROM payment_intents WHERE id=? AND order_id=? AND amount_gross_cents=?')
    .bind(command.payment_intent_id, command.order_id, command.amount_cents)
    .first<{ merchant_order: string }>()
  if (!intent) throw new TokenizationError('unavailable')
  let envelope: RedsysEnvelope
  try {
    envelope = await deps.provider.charge({
      idempotencyKey: `oneclick:${input.commandId}`,
      merchantOrder: intent.merchant_order,
      amountCents: command.amount_cents,
      providerToken: token.token
    })
    if (decodeMerchantParameters(envelope.Ds_MerchantParameters).DS_ORDER !== intent.merchant_order)
      throw new Error('order_mismatch')
  } catch {
    throw new TokenizationError('unavailable')
  }
  let outcome: Awaited<ReturnType<typeof processRedsysNotification>>['outcome']
  try {
    outcome = (
      await processRedsysNotification(
        deps.database,
        envelope,
        deps.configuration,
        { correlationId: `oneclick:${input.commandId}`, now: clock(deps) },
        deps.inventory
      )
    ).outcome
  } catch {
    throw new TokenizationError('unavailable')
  }
  if (outcome === 'pending') return result(command, 'pending')
  if (outcome === 'mismatch') throw new TokenizationError('unavailable')
  const final: CommandRow['status'] = outcome === 'failed' || outcome === 'cancelled' ? 'declined' : 'settled'
  await deps.database
    .prepare(
      "UPDATE payment_one_click_commands SET status=?3 WHERE customer_id=?1 AND command_id=?2 AND status='started'"
    )
    .bind(customer, input.commandId, final)
    .run()
  const stored = (await load()) ?? command
  if (stored.status === 'started') throw new TokenizationError('unavailable')
  return result(stored, stored.status === 'declined' ? 'declined' : outcome === 'captured' ? 'paid' : 'review')
}

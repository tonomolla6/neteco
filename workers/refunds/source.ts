import { z } from 'zod'
import { refundCents, refundMappingsSchema, type RefundContract, type RefundPolicy } from '../../shared/order-refunds'
import { fiscalUuid, fiscalHash } from '../../shared/fiscal-issuance'
import { REDSYS_REDIRECT_URLS, decodeMerchantParameters } from '../payments/redsys'
import { guardedFiscalDatabase } from '../fiscal/d1-boundary'
import { checked, hash, RefundError, parsedJson } from './authority'
import { orderStoreCreditSql } from '../pricing/order-store-credit-sql'

const rowSchema = z
  .object({
    order_id: fiscalUuid,
    payment_intent_id: fiscalUuid,
    merchant_order: z.string(),
    amount_gross_cents: refundCents.min(1),
    currency: z.literal('EUR'),
    provider_reference: z.string().nullable(),
    redirect_envelope_hash: fiscalHash,
    contact_email: z.string().email().max(254),
    contact_name: z.string().min(1).max(160),
    shipping_net_cents: refundCents,
    shipping_tax_cents: refundCents,
    shipping_gross_cents: refundCents,
    shipping_method_code: z.string(),
    shipping_rate_version: z.number().int(),
    shipping_eta_min_days: z.number().int(),
    shipping_eta_max_days: z.number().int(),
    options_json: z.string().max(131072)
  })
  .strict()
const lineSchema = z
  .object({
    line_index: z.number().int().min(0).max(99),
    sku: z.string().min(1).max(160),
    name: z.string().min(1).max(500),
    quantity: z.number().int().min(1).max(999),
    net_cents: refundCents,
    tax_cents: refundCents,
    // A fully discounted merchandise line is valid capture evidence. Refund
    // allocations still require a positive amount and cannot pay this line.
    gross_cents: refundCents,
    tax_rate_basis_points: z.number().int().min(0).max(10000)
  })
  .strict()
export async function capturedSource(database: D1Database, orderId: string) {
  database = guardedFiscalDatabase(database)
  // PRI-018: the card captured total - store credit; the credit share is refundable as store credit.
  const storeCreditCents = checked(
    z.object({ cents: refundCents }).strict(),
    await database
      .prepare(`SELECT ${orderStoreCreditSql('?1')} AS cents`)
      .bind(orderId)
      .first(),
    'read_unconfirmed'
  ).cents
  const raw = await database
    .prepare(
      `SELECT o.id AS order_id,p.id AS payment_intent_id,p.merchant_order,p.amount_gross_cents,p.currency,p.provider_reference,p.redirect_envelope_hash,
    o.contact_email,o.contact_name,o.shipping_net_cents,o.shipping_tax_cents,o.shipping_gross_cents,o.shipping_method_code,o.shipping_rate_version,o.shipping_eta_min_days,o.shipping_eta_max_days,q.options_json
    FROM orders o JOIN order_payment_states state ON state.order_id=o.id AND state.status='paid' AND state.paid_gross_cents=o.total_gross_cents-?2
    JOIN payment_intents p ON p.id=state.active_intent_id AND p.order_id=o.id AND p.status='captured' AND p.amount_gross_cents=state.paid_gross_cents AND p.currency=o.currency
    JOIN payment_fulfilment_claims claim ON claim.order_id=o.id AND claim.payment_intent_id=p.id
    JOIN payment_recovery_jobs job ON job.payment_intent_id=p.id AND job.status='completed'
    JOIN shipping_quotes q ON q.id=o.shipping_quote_id
    WHERE o.id=?1 AND EXISTS(SELECT 1 FROM payment_events WHERE payment_intent_id=p.id AND order_id=o.id AND event_type='captured')`
    )
    .bind(orderId, storeCreditCents)
    .first()
  if (raw === null) throw new RefundError('capture_unconfirmed')
  const row = checked(rowSchema, raw, 'read_unconfirmed')
  const lines = checked(
    z.array(lineSchema).min(1).max(100),
    (
      await database
        .prepare(
          'SELECT line_index,sku,name,quantity,net_cents,tax_cents,gross_cents,tax_rate_basis_points FROM order_lines WHERE order_id=?1 ORDER BY line_index LIMIT 101'
        )
        .bind(orderId)
        .all()
    ).results,
    'read_unconfirmed'
  )
  if (
    lines.some((line) => line.gross_cents !== line.net_cents + line.tax_cents) ||
    lines.reduce((sum, line) => sum + line.gross_cents, row.shipping_gross_cents) !==
      row.amount_gross_cents + storeCreditCents
  )
    throw new RefundError('source_unbalanced')
  const commands = (
    await database
      .prepare('SELECT response_body FROM payment_commands WHERE order_id=?1 ORDER BY command_id LIMIT 101')
      .bind(orderId)
      .all()
  ).results
  const matches: {
    body: { redirect: { actionUrl: string; fields: Record<string, string> } }
    mapping: z.infer<typeof refundMappingsSchema>
    environment: 'sandbox' | 'production'
  }[] = []
  for (const rawCommand of commands) {
    const command = checked(z.object({ response_body: z.string().max(65536) }).strict(), rawCommand, 'read_unconfirmed')
    const body = checked(
      z
        .object({
          paymentIntentId: fiscalUuid,
          redirect: z
            .object({ actionUrl: z.string().url(), fields: z.record(z.string()), method: z.literal('POST') })
            .strict(),
          status: z.literal('redirect_ready'),
          expiresAt: z.string()
        })
        .strict(),
      parsedJson(command.response_body),
      'read_unconfirmed'
    )
    if (body.paymentIntentId !== row.payment_intent_id) continue
    if ((await hash(body.redirect.fields)) !== row.redirect_envelope_hash)
      throw new RefundError('capture_configuration_unconfirmed')
    const params = decodeMerchantParameters(body.redirect.fields.Ds_MerchantParameters ?? '')
    const mapping = checked(
      refundMappingsSchema,
      {
        merchantCode: params.DS_MERCHANT_MERCHANTCODE,
        terminal: params.DS_MERCHANT_TERMINAL,
        currencyCode: params.DS_MERCHANT_CURRENCY
      },
      'capture_configuration_unconfirmed'
    )
    if (params.DS_MERCHANT_ORDER !== row.merchant_order || params.DS_MERCHANT_AMOUNT !== String(row.amount_gross_cents))
      throw new RefundError('capture_configuration_unconfirmed')
    const environment =
      body.redirect.actionUrl === REDSYS_REDIRECT_URLS.sandbox
        ? 'sandbox'
        : body.redirect.actionUrl === REDSYS_REDIRECT_URLS.production
          ? 'production'
          : null
    if (!environment) throw new RefundError('capture_configuration_unconfirmed')
    matches.push({ body, mapping, environment })
  }
  if (matches.length !== 1) throw new RefundError('capture_configuration_unconfirmed')
  const options = checked(
    z.array(z.record(z.unknown())).max(100),
    parsedJson(row.options_json, 'shipping_snapshot_unconfirmed'),
    'shipping_snapshot_unconfirmed'
  )
  const matching = options.filter(
    (option) =>
      option.methodCode === row.shipping_method_code &&
      option.rateVersion === row.shipping_rate_version &&
      option.netCents === row.shipping_net_cents &&
      option.taxCents === row.shipping_tax_cents &&
      option.grossCents === row.shipping_gross_cents &&
      option.etaMinDays === row.shipping_eta_min_days &&
      option.etaMaxDays === row.shipping_eta_max_days &&
      option.currency === 'EUR'
  )
  const rates = [...new Set(matching.map((option) => option.taxRateBasisPoints))]
  if (rates.length !== 1) throw new RefundError('shipping_snapshot_unconfirmed')
  const shippingRate = checked(z.number().int().min(0).max(10000), rates[0], 'shipping_snapshot_unconfirmed')
  const capture: RefundContract['capture'] = {
    paymentIntentId: row.payment_intent_id,
    merchantOrder: row.merchant_order,
    providerReference: row.provider_reference,
    capturedCents: row.amount_gross_cents,
    currency: 'EUR',
    environment: matches[0]!.environment,
    mappings: matches[0]!.mapping,
    envelopeHash: row.redirect_envelope_hash
  }
  // Orders without credit keep their historical source hash (in-flight refunds stay valid).
  const evidence =
    storeCreditCents > 0
      ? { row, lines, capture, shippingRate, storeCreditCents }
      : { row, lines, capture, shippingRate }
  return { row, lines, capture, shippingRate, storeCreditCents, sourceHash: await hash(evidence) }
}
export function captureMatchesPolicy(capture: RefundContract['capture'], policy: RefundPolicy) {
  if (policy.provider !== 'local_fake' && capture.environment !== policy.environment)
    throw new RefundError('capture_configuration_unconfirmed')
  if (
    capture.mappings.merchantCode !== policy.mappings.merchantCode ||
    Number(capture.mappings.terminal) !== Number(policy.mappings.terminal) ||
    capture.mappings.currencyCode !== policy.mappings.currencyCode
  )
    throw new RefundError('capture_configuration_unconfirmed')
}

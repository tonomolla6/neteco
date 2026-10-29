import { z } from 'zod'
import { catalogPolicyOwnJson } from './catalog-publication-policy'
import { fiscalUuid, fiscalHash, fiscalInstant, fiscalReason, fiscalEvidenceRef } from './fiscal-issuance'
import { returnPublicRefSchema } from './order-returns'
import type { RefundRequest, RefundResult } from '../server/integrations/payment-provider'

export const refundCents = z.number().int().min(0).max(1_000_000_000)
export const refundKey = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/)
export const refundVersion = z
  .number()
  .int()
  .min(1)
  .max(Number.MAX_SAFE_INTEGER - 1)
export const refundEnvironment = z.enum(['local_validation', 'sandbox', 'production'])
export function refundOwnJson(value: unknown) {
  try {
    return catalogPolicyOwnJson(value)
  } catch {
    return undefined
  }
}
const text = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine(
      (value) =>
        value.trim() === value &&
        Array.from(value).every((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127)
    )
export const refundMappingsSchema = z
  .object({
    merchantCode: z.string().regex(/^\d{9}$/),
    terminal: z
      .string()
      .regex(/^\d{1,3}$/)
      .refine((value) => Number(value) > 0)
      .transform((value) => String(Number(value))),
    currencyCode: z.literal('978')
  })
  .strict()
export const refundPolicyInputSchema = z.preprocess(
  refundOwnJson,
  z
    .object({
      idempotencyKey: refundKey,
      provider: z.enum(['local_fake', 'redsys']),
      environment: refundEnvironment,
      mappings: refundMappingsSchema,
      shipping: z.enum(['excluded', 'explicit_amount']),
      approvalMode: z.enum(['same_actor_confirmation', 'distinct_actor']),
      maximumRefundCents: refundCents.min(1),
      evidenceRef: fiscalEvidenceRef,
      reason: fiscalReason
    })
    .strict()
    .refine((value) => (value.provider === 'local_fake') === (value.environment === 'local_validation'))
)
export type RefundPolicyInput = z.infer<typeof refundPolicyInputSchema>
export type RefundPolicy = RefundPolicyInput & { id: string; fingerprint: string; approvedAt: string }
const selection = z
  .object({
    lineIndex: z.number().int().min(0).max(99),
    quantity: z.number().int().min(1).max(999),
    amountCents: refundCents.min(1).optional()
  })
  .strict()
export const refundPlanInputSchema = z.preprocess(
  refundOwnJson,
  z
    .object({
      idempotencyKey: refundKey,
      policyId: fiscalUuid,
      returnPublicRef: returnPublicRefSchema,
      expectedReturnVersion: refundVersion,
      reason: fiscalReason,
      evidenceRef: fiscalEvidenceRef,
      lines: z
        .array(selection)
        .min(1)
        .max(100)
        .refine((items) => new Set(items.map((item) => item.lineIndex)).size === items.length),
      shippingCents: refundCents.min(1).optional()
    })
    .strict()
)
export type RefundPlanInput = z.infer<typeof refundPlanInputSchema>
export const refundConfirmInputSchema = z.preprocess(
  refundOwnJson,
  z
    .object({
      idempotencyKey: refundKey,
      expectedGeneration: refundVersion,
      contractFingerprint: fiscalHash,
      reason: fiscalReason,
      evidenceRef: fiscalEvidenceRef
    })
    .strict()
)
export type RefundConfirmInput = z.infer<typeof refundConfirmInputSchema>
export const refundReconcileInputSchema = z.preprocess(
  refundOwnJson,
  z
    .object({
      idempotencyKey: refundKey,
      expectedGeneration: refundVersion,
      reason: fiscalReason,
      evidenceRef: fiscalEvidenceRef
    })
    .strict()
)
export type RefundReconcileInput = z.infer<typeof refundReconcileInputSchema>
export const refundComponentSchema = z
  .object({
    component: z.enum(['line', 'shipping']),
    lineIndex: z.number().int().min(0).max(99).nullable(),
    quantity: z.number().int().min(1).max(999),
    unitOffset: z.number().int().min(0).max(999),
    sku: text(160),
    description: text(500),
    grossCents: refundCents.min(1),
    netCents: refundCents,
    taxCents: refundCents,
    taxRateBasisPoints: z.number().int().min(0).max(10000)
  })
  .strict()
  .refine(
    (value) =>
      value.grossCents === value.netCents + value.taxCents &&
      (value.component === 'line') === (value.lineIndex !== null)
  )
export const refundContractSchema = z.preprocess(
  refundOwnJson,
  z
    .object({
      schemaVersion: z.literal(1),
      refundId: fiscalUuid,
      orderId: fiscalUuid,
      returnId: fiscalUuid,
      returnPublicRef: returnPublicRefSchema,
      returnVersion: refundVersion,
      policyId: fiscalUuid,
      policyFingerprint: fiscalHash,
      provider: z.enum(['local_fake', 'redsys']),
      environment: refundEnvironment,
      validationOnly: z.boolean(),
      idempotencyKey: refundKey,
      reason: fiscalReason,
      evidenceRef: fiscalEvidenceRef,
      createdAt: fiscalInstant,
      capture: z
        .object({
          paymentIntentId: fiscalUuid,
          merchantOrder: z.string().regex(/^\d{4}[A-Za-z0-9]{0,8}$/),
          providerReference: refundKey.nullable(),
          capturedCents: refundCents.min(1),
          currency: z.literal('EUR'),
          environment: z.enum(['sandbox', 'production']),
          mappings: refundMappingsSchema,
          envelopeHash: fiscalHash
        })
        .strict(),
      contact: z.object({ email: z.string().email().max(254), name: text(160) }).strict(),
      sourceHash: fiscalHash,
      components: z.array(refundComponentSchema).min(1).max(101),
      amountCents: refundCents.min(1),
      currency: z.literal('EUR'),
      inventoryEffect: z.literal('none'),
      custody: z.literal('non_sellable')
    })
    .strict()
    .refine(
      (value) =>
        value.validationOnly === (value.provider === 'local_fake') &&
        (value.provider === 'local_fake') === (value.environment === 'local_validation') &&
        value.components.reduce((sum, item) => sum + item.grossCents, 0) === value.amountCents &&
        value.amountCents <= value.capture.capturedCents &&
        new Set(value.components.map((item) => `${item.component}:${item.lineIndex}`)).size === value.components.length
    )
)
export type RefundContract = z.infer<typeof refundContractSchema>
export const refundReceiptSchema = z.preprocess(
  refundOwnJson,
  z
    .object({
      providerReference: refundKey,
      status: z.enum(['pending', 'succeeded']),
      amountCents: refundCents.min(1),
      currency: z.literal('EUR'),
      merchantOrder: z.string().regex(/^\d{4}[A-Za-z0-9]{0,8}$/),
      contractFingerprint: fiscalHash,
      validationOnly: z.boolean()
    })
    .strict()
)
export type RefundReceipt = z.infer<typeof refundReceiptSchema> & RefundResult
export interface RefundLookupEvidence {
  authoritative: true
  externalKey: string
  contractFingerprint: string
  receipts: RefundReceipt[]
}
/** Kept compatible with the existing provider boundary, with explicit proof
 * added because its legacy RefundResult cannot attest amount/currency/source. */
export interface GovernedRefundProvider {
  readonly name: 'local_fake' | 'redsys'
  readonly environment: RefundPolicyInput['environment']
  readonly mappingFingerprint: string
  refund(request: RefundContract): Promise<RefundReceipt>
  lookupByExternalKey?(externalKey: string, fingerprint: string): Promise<RefundLookupEvidence>
}
export function refundProviderRequest(contract: RefundContract): RefundRequest {
  return {
    paymentReference: contract.capture.providerReference ?? contract.capture.merchantOrder,
    orderReference: contract.capture.merchantOrder,
    amountCents: contract.amountCents,
    reason: contract.reason,
    idempotencyKey: contract.idempotencyKey
  }
}
export const refundWorkflowSchema = z.enum([
  'awaiting_confirmation',
  'queued',
  'leased',
  'submitting',
  'pending_provider',
  'uncertain',
  'reconciling',
  'completed',
  'cancelled',
  'manual_review'
])
export type RefundWorkflow = z.infer<typeof refundWorkflowSchema>
export const refundCommandReceiptSchema = z.preprocess(
  refundOwnJson,
  z
    .object({
      source: z.literal('cloudflare'),
      id: fiscalUuid,
      action: z.enum(['planned', 'confirmed', 'cancelled', 'reconciled', 'blocked']),
      generation: refundVersion,
      contractFingerprint: fiscalHash,
      validationOnly: z.boolean(),
      inventoryEffect: z.literal('none')
    })
    .strict()
)
export type RefundCommandReceipt = z.infer<typeof refundCommandReceiptSchema>
export const refundViewSchema = z.preprocess(
  refundOwnJson,
  z
    .object({
      source: z.literal('cloudflare'),
      id: fiscalUuid,
      orderId: fiscalUuid,
      returnPublicRef: returnPublicRefSchema,
      workflow: refundWorkflowSchema,
      generation: refundVersion,
      contractFingerprint: fiscalHash,
      amountCents: refundCents.min(1),
      components: z.array(refundComponentSchema).min(1).max(101),
      creditId: fiscalUuid.nullable(),
      currency: z.literal('EUR'),
      validationOnly: z.boolean(),
      financialStatus: z.enum([
        'not_submitted',
        'pending',
        'uncertain',
        'succeeded',
        'validation_completed',
        'cancelled'
      ]),
      correctiveStatus: z.enum([
        'not_due',
        'blocked_policy',
        'blocked_source',
        'queued',
        'issuing',
        'uncertain',
        'completed',
        'manual_review'
      ]),
      lastErrorCode: refundKey.nullable(),
      inventoryEffect: z.literal('none'),
      custody: z.literal('non_sellable'),
      capabilities: z
        .object({ confirm: z.boolean(), cancel: z.boolean(), reconcile: z.boolean(), resend: z.literal(false) })
        .strict()
    })
    .strict()
)
export type RefundView = z.infer<typeof refundViewSchema>
export const orderRefundsViewSchema = z.preprocess(
  refundOwnJson,
  z
    .object({
      source: z.literal('cloudflare'),
      orderId: fiscalUuid,
      capturedCents: refundCents.min(1),
      reservedCents: refundCents,
      confirmedCents: refundCents,
      simulatedConfirmedCents: refundCents,
      currency: z.literal('EUR'),
      items: z.array(refundViewSchema).max(100),
      inventoryEffect: z.literal('none')
    })
    .strict()
    .refine(
      (value) =>
        value.reservedCents <= value.capturedCents &&
        value.confirmedCents + value.simulatedConfirmedCents <= value.reservedCents
    )
)
export type OrderRefundsView = z.infer<typeof orderRefundsViewSchema>

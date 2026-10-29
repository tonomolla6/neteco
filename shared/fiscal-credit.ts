import { z } from 'zod'
import type { InvoiceProvider, IssueInvoiceRequest } from '../server/integrations/invoice-provider'
import {
  fiscalUuid,
  fiscalHash,
  fiscalInstant,
  fiscalMappingsSchema,
  fiscalReason,
  fiscalEvidenceRef,
  fiscalContractSchema,
  fiscalReceiptSchema
} from './fiscal-issuance'
import {
  refundOwnJson,
  refundKey,
  refundCents,
  refundComponentSchema,
  refundEnvironment,
  refundVersion
} from './order-refunds'

export const creditPolicyInputSchema = z.preprocess(
  refundOwnJson,
  z
    .object({
      idempotencyKey: refundKey,
      provider: z.enum(['local_fake', 'beply']),
      environment: refundEnvironment,
      series: z.string().regex(/^[A-Za-z0-9_-]{1,10}$/),
      trigger: z.literal('after_confirmed_refund'),
      mappings: fiscalMappingsSchema,
      evidenceRef: fiscalEvidenceRef,
      reason: fiscalReason
    })
    .strict()
    .refine((value) => (value.provider === 'local_fake') === (value.environment === 'local_validation'))
)
export type CreditPolicyInput = z.infer<typeof creditPolicyInputSchema>
export type CreditPolicy = CreditPolicyInput & { id: string; fingerprint: string; approvedAt: string }
export const creditContractSchema = z.preprocess(
  refundOwnJson,
  z
    .object({
      schemaVersion: z.literal(1),
      kind: z.literal('credit_note'),
      creditId: fiscalUuid,
      refundId: fiscalUuid,
      returnId: fiscalUuid,
      orderId: fiscalUuid,
      policyId: fiscalUuid,
      policyFingerprint: fiscalHash,
      provider: z.enum(['local_fake', 'beply']),
      environment: refundEnvironment,
      validationOnly: z.boolean(),
      series: z.string().regex(/^[A-Za-z0-9_-]{1,10}$/),
      idempotencyKey: refundKey,
      issuedOn: fiscalInstant,
      reason: fiscalReason,
      sourceInvoiceId: fiscalUuid,
      sourceProviderInvoiceId: fiscalReceiptSchema.shape.providerId,
      sourceContractFingerprint: fiscalHash,
      sourcePdfChecksum: fiscalHash,
      sourceContract: fiscalContractSchema,
      components: z.array(refundComponentSchema).min(1).max(101),
      amountCents: refundCents.min(1),
      currency: z.literal('EUR')
    })
    .strict()
    .refine(
      (value) =>
        value.validationOnly === (value.provider === 'local_fake') &&
        value.sourceContract.orderId === value.orderId &&
        value.sourceContract.provider === value.provider &&
        value.sourceContract.environment === value.environment &&
        value.sourceContract.validationOnly === value.validationOnly &&
        value.components.reduce((sum, line) => sum + line.grossCents, 0) === value.amountCents
    )
)
export type CreditContract = z.infer<typeof creditContractSchema>
export const creditReceiptSchema = z.preprocess(
  refundOwnJson,
  z
    .object({
      providerId: fiscalReceiptSchema.shape.providerId,
      code: fiscalReceiptSchema.shape.code,
      status: fiscalReceiptSchema.shape.status,
      amountCents: refundCents.min(1),
      currency: z.literal('EUR'),
      sourceProviderInvoiceId: fiscalReceiptSchema.shape.providerId,
      documentKind: z.literal('credit_note'),
      contractFingerprint: fiscalHash,
      validationOnly: z.boolean()
    })
    .strict()
)
export type CreditReceipt = z.infer<typeof creditReceiptSchema>
export const creditQueueInputSchema = z.preprocess(
  refundOwnJson,
  z
    .object({ idempotencyKey: refundKey, policyId: fiscalUuid, reason: fiscalReason, evidenceRef: fiscalEvidenceRef })
    .strict()
)
export type CreditQueueInput = z.infer<typeof creditQueueInputSchema>
export const creditWorkflowSchema = z.enum([
  'queued',
  'leased',
  'issuing',
  'uncertain',
  'reconciling',
  'completed',
  'manual_review'
])
export const creditCommandReceiptSchema = z.preprocess(
  refundOwnJson,
  z
    .object({
      source: z.literal('cloudflare'),
      id: fiscalUuid,
      refundId: fiscalUuid,
      action: z.enum(['queued', 'reconciled']),
      generation: refundVersion,
      contractFingerprint: fiscalHash,
      validationOnly: z.boolean()
    })
    .strict()
)
export type CreditCommandReceipt = z.infer<typeof creditCommandReceiptSchema>
export const creditViewSchema = z.preprocess(
  refundOwnJson,
  z
    .object({
      source: z.literal('cloudflare'),
      id: fiscalUuid,
      refundId: fiscalUuid,
      orderId: fiscalUuid,
      sourceInvoiceId: fiscalUuid,
      workflow: creditWorkflowSchema,
      generation: refundVersion,
      amountCents: refundCents.min(1),
      currency: z.literal('EUR'),
      validationOnly: z.boolean(),
      code: fiscalReceiptSchema.shape.code.nullable(),
      fiscalStatus: fiscalReceiptSchema.shape.status.nullable(),
      pdfAvailable: z.boolean(),
      lastErrorCode: refundKey.nullable(),
      capabilities: z
        .object({ reconcile: z.boolean(), resend: z.literal(false), editOriginal: z.literal(false) })
        .strict()
    })
    .strict()
    .refine(
      (value) =>
        (value.code === null) === (value.fiscalStatus === null) &&
        (!value.pdfAvailable || value.workflow === 'completed') &&
        (value.workflow !== 'completed' || value.code !== null)
    )
)
export type CreditView = z.infer<typeof creditViewSchema>
export interface CreditLookupEvidence {
  authoritative: true
  externalKey: string
  contractFingerprint: string
  receipts: CreditReceipt[]
}
export interface CreditFiscalProvider extends Pick<InvoiceProvider, 'name' | 'downloadPdf'> {
  readonly name: 'local_fake' | 'beply'
  readonly environment: CreditPolicyInput['environment']
  readonly mappingFingerprint: string
  issueCreditNote(request: CreditContract): Promise<CreditReceipt>
  lookupByExternalKey?(externalKey: string, fingerprint: string): Promise<CreditLookupEvidence>
}
/** Existing wire request, not permission to call a provider. Amount/source/kind
 * evidence is still required from its response; positive or absolute totals
 * alone never demonstrate that the remote document is corrective. */
export function creditProviderRequest(
  contract: CreditContract
): IssueInvoiceRequest & { sourceProviderInvoiceId: string; reason: string } {
  return {
    orderId: contract.orderId,
    orderNumber: `${contract.orderId}-${contract.refundId}`,
    series: contract.series,
    issuedOn: contract.issuedOn,
    customer: contract.sourceContract.customer,
    lines: contract.components.map((line) => ({
      sku: line.sku,
      description: line.description,
      quantity: line.quantity,
      unitNetCents: line.netCents / line.quantity,
      lineNetCents: line.netCents,
      discountNetCents: 0,
      taxRateBasisPoints: line.taxRateBasisPoints
    })),
    shippingNetCents: 0,
    currency: 'EUR',
    paymentMethod: 'redsys',
    idempotencyKey: contract.idempotencyKey,
    sourceProviderInvoiceId: contract.sourceProviderInvoiceId,
    reason: contract.reason
  }
}

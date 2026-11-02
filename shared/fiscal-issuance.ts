import { z } from 'zod'
import { catalogPolicyUuidSchema } from './catalog-publication-policy'
import type { InvoiceProvider, IssueInvoiceRequest, ProviderInvoice } from '../server/integrations/invoice-provider'

/** Ordinary invoices only. Rectification and real-provider acceptance are separate gates. */
export const FISCAL_MAX_PDF_BYTES = 5 * 1024 * 1024
export const fiscalUuid = catalogPolicyUuidSchema
export const fiscalHash = z.string().regex(/^[0-9a-f]{64}$/)
export const fiscalInstant = z.string().refine((value) => {
  const parsed = Date.parse(value)
  return (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value) &&
    Number.isFinite(parsed) &&
    new Date(parsed).toISOString().replace('.000Z', 'Z') === value
  )
})
const boundedText = (max: number, min = 1) =>
  z
    .string()
    .min(min)
    .max(max)
    .refine(
      (value) =>
        [...value].every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127) &&
        value.trim() === value &&
        value.length > 0
    )
const cents = z.number().int().min(0).max(1_000_000_000)
const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/)
export const fiscalReason = boundedText(500, 10)
export const fiscalEvidenceRef = identifier
export const fiscalMappingsSchema = z
  .object({
    companyId: identifier,
    taxes: z.record(z.string().regex(/^(?:0|[1-9]\d{0,3}|10000)$/), identifier),
    paymentCode: identifier
  })
  .strict()
  .refine((value) => Object.keys(value.taxes).length > 0 && Object.keys(value.taxes).length <= 20)
export const fiscalPolicyInputSchema = z
  .object({
    idempotencyKey: identifier,
    environment: z.enum(['local_validation', 'sandbox', 'production']),
    provider: z.enum(['local_fake', 'beply']),
    series: z.string().regex(/^[A-Za-z0-9_-]{1,10}$/),
    trigger: z.literal('after_payment_capture'),
    mappings: fiscalMappingsSchema,
    evidenceRef: fiscalEvidenceRef,
    reason: fiscalReason
  })
  .strict()
  .refine((value) => (value.provider === 'local_fake') === (value.environment === 'local_validation'))
export type FiscalPolicyInput = z.infer<typeof fiscalPolicyInputSchema>
export type FiscalPolicy = FiscalPolicyInput & { id: string; approvedAt: string; fingerprint: string }
export const fiscalContractLineSchema = z
  .object({
    lineIndex: z.number().int().min(0).max(99),
    sku: boundedText(160),
    description: boundedText(500),
    quantity: z.number().int().min(1).max(999),
    unitGrossCents: cents,
    unitNetCents: cents,
    lineNetCents: cents,
    discountNetCents: cents,
    netCents: cents,
    taxCents: cents,
    grossCents: cents,
    taxRateBasisPoints: z.number().int().min(0).max(10000)
  })
  .strict()
export const fiscalContractSchema = z
  .object({
    schemaVersion: z.literal(1),
    fiscalVersion: z.literal(1),
    kind: z.literal('ordinary'),
    orderId: fiscalUuid,
    orderNumber: fiscalUuid,
    series: z.string().regex(/^[A-Za-z0-9_-]{1,10}$/),
    issuedOn: fiscalInstant,
    currency: z.literal('EUR'),
    paymentMethod: z.literal('redsys'),
    idempotencyKey: identifier,
    policyId: fiscalUuid,
    policyFingerprint: fiscalHash,
    provider: z.enum(['local_fake', 'beply']),
    environment: z.enum(['local_validation', 'sandbox', 'production']),
    validationOnly: z.boolean(),
    customer: z
      .object({
        externalKey: fiscalUuid,
        legalName: boundedText(160, 2),
        taxId: boundedText(20, 6).optional(),
        email: z.string().email().max(254),
        phone: boundedText(24, 6).optional(),
        address: z
          .object({
            line1: boundedText(160, 3),
            line2: boundedText(160).optional(),
            postalCode: z.string().regex(/^\d{5}$/),
            city: boundedText(80),
            region: boundedText(80),
            countryCode: z.literal('ES')
          })
          .strict()
      })
      .strict(),
    lines: z.array(fiscalContractLineSchema).min(1).max(100),
    shippingNetCents: cents,
    shippingTaxCents: cents,
    shippingGrossCents: cents,
    shippingTaxRateBasisPoints: z.number().int().min(0).max(10000),
    totalNetCents: cents,
    totalTaxCents: cents,
    totalGrossCents: cents.min(1),
    /** PRI-018: part of the total paid with store credit (a means of payment, not a discount). */
    storeCreditCents: cents.min(1).optional()
  })
  .strict()
export type FiscalContract = z.infer<typeof fiscalContractSchema> & IssueInvoiceRequest
export const fiscalReceiptSchema = z
  .object({
    providerId: identifier,
    code: boundedText(100),
    status: z.enum(['issued', 'fiscal_pending']),
    amountCents: cents.min(1),
    currency: z.literal('EUR')
  })
  .strict()
export type FiscalReceipt = ProviderInvoice & { currency: 'EUR' }
export interface FiscalLookupEvidence {
  /** This capability is not provided by the existing Beply adapter. */
  authoritative: true
  externalKey: string
  contractFingerprint: string
  receipts: FiscalReceipt[]
}
export interface OrdinaryFiscalProvider extends Pick<InvoiceProvider, 'name' | 'downloadPdf'> {
  readonly name: 'local_fake' | 'beply'
  readonly environment: FiscalPolicyInput['environment']
  readonly mappingFingerprint: string
  issueInvoice(request: FiscalContract): Promise<FiscalReceipt>
  lookupByExternalKey?(externalKey: string, fingerprint: string): Promise<FiscalLookupEvidence>
}
export interface PrivateFiscalStorage {
  put(key: string, bytes: Uint8Array): Promise<void>
  get(key: string): Promise<Uint8Array | null>
}
export const fiscalReconcileInputSchema = z
  .object({
    expectedGeneration: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    idempotencyKey: identifier,
    reason: fiscalReason,
    evidenceRef: fiscalEvidenceRef
  })
  .strict()
export type FiscalReconcileInput = z.infer<typeof fiscalReconcileInputSchema>
export type FiscalIssuanceStatus =
  'queued' | 'leased' | 'issuing' | 'uncertain' | 'reconciling' | 'completed' | 'manual_review'
export interface FiscalOrderView {
  orderId: string
  status: FiscalIssuanceStatus | 'blocked_policy'
  intentId: string | null
  generation: number | null
  provider: 'local_fake' | 'beply' | null
  validationOnly: boolean
  code: string | null
  fiscalStatus: 'issued' | 'fiscal_pending' | null
  amountCents: number | null
  currency: 'EUR'
  pdfAvailable: boolean
  lastErrorCode: string | null
  capabilities: { reconcile: boolean; edit: false; issueRetry: false; creditNote: false }
}

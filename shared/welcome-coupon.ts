import { z } from 'zod'
import { catalogPolicyInstantSchema as instant, catalogPolicyUuidSchema as uuid } from './catalog-publication-policy'

export function normalizeEmailCanonical(email: string): string {
  const trimmed = email.trim().toLowerCase()
  const parts = trimmed.split('@')
  if (parts.length !== 2) throw new Error('invalid_email_format')
  const localPart = parts[0]
  const domainPart = parts[1]
  if (!localPart || !domainPart) throw new Error('invalid_email_format')
  let local = localPart
  const domain = domainPart === 'googlemail.com' ? 'gmail.com' : domainPart
  const plusIndex = local.indexOf('+')
  if (plusIndex !== -1) {
    local = local.substring(0, plusIndex)
  }
  if (domain === 'gmail.com') {
    local = local.replace(/\./g, '')
  }
  return `${local}@${domain}`
}

export function normalizePhoneCanonical(phone: string): string {
  const trimmed = phone.trim()
  const hasPlus = trimmed.startsWith('+')
  let digits = trimmed.replace(/\D/g, '')
  if (digits.length < 6 || digits.length > 15) throw new Error('invalid_phone_format')
  if (!hasPlus && digits.length === 9) {
    digits = `34${digits}`
  }
  return `+${digits}`
}

export function normalizeTaxIdCanonical(taxId: string): string {
  const normalized = taxId
    .trim()
    .toUpperCase()
    .replace(/[\s.-]/g, '')
  if (normalized.length < 3 || normalized.length > 20) throw new Error('invalid_tax_id_format')
  return normalized
}

export const welcomeCouponPolicySchema = z
  .object({
    id: z.literal('global'),
    version: z.number().int().min(1),
    status: z.enum(['active', 'paused']),
    codePrefix: z
      .string()
      .min(2)
      .max(16)
      .regex(/^[A-Z0-9_-]+$/),
    discountPercent: z.number().int().min(1).max(50),
    maxDiscountCents: z.number().int().min(100).max(50000),
    minOrderCents: z.number().int().min(0).max(100000),
    validityDays: z.number().int().min(1).max(90),
    excludedCategoryIds: z.array(z.string().min(1).max(100)).max(50),
    excludedProductIds: z.array(z.string().min(1).max(100)).max(100),
    excludeAlreadyDiscounted: z.boolean(),
    marginFloorBasisPoints: z.number().int().min(1000).max(5000),
    updatedAt: instant,
    updatedBy: uuid
  })
  .strict()

export const welcomeCouponPolicyInputSchema = z
  .object({
    expectedVersion: z.number().int().min(0),
    status: z.enum(['active', 'paused']),
    codePrefix: z
      .string()
      .min(2)
      .max(16)
      .regex(/^[A-Z0-9_-]+$/)
      .default('BIENVENIDA'),
    discountPercent: z.number().int().min(1).max(50).default(10),
    maxDiscountCents: z.number().int().min(100).max(50000).default(1500),
    minOrderCents: z.number().int().min(0).max(100000).default(5000),
    validityDays: z.number().int().min(1).max(90).default(14),
    excludedCategoryIds: z.array(z.string().min(1).max(100)).max(50).default([]),
    excludedProductIds: z.array(z.string().min(1).max(100)).max(100).default([]),
    excludeAlreadyDiscounted: z.boolean().default(true),
    marginFloorBasisPoints: z.number().int().min(1000).max(5000).default(2000)
  })
  .strict()

export const welcomeCouponGrantSchema = z
  .object({
    id: uuid,
    couponCode: z
      .string()
      .min(3)
      .max(32)
      .regex(/^[A-Z0-9_-]+$/),
    customerId: uuid,
    identityId: z.string().min(1).max(100),
    canonicalEmailHash: z.string().regex(/^[0-9a-f]{64}$/),
    canonicalPhoneHash: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
    taxIdHash: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
    discountPercent: z.number().int().min(1).max(50),
    maxDiscountCents: z.number().int().min(100),
    minOrderCents: z.number().int().min(0),
    expiresAt: instant,
    status: z.enum(['active', 'redeemed', 'expired', 'revoked']),
    createdAt: instant
  })
  .strict()

export const welcomeCouponRedemptionSchema = z
  .object({
    id: uuid,
    grantId: uuid,
    couponCode: z.string().min(3).max(32),
    customerId: uuid,
    orderId: uuid,
    identityId: z.string().min(1).max(100),
    canonicalEmailHash: z.string().regex(/^[0-9a-f]{64}$/),
    canonicalPhoneHash: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
    taxIdHash: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
    deviceFingerprintHash: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
    discountAppliedCents: z.number().int().positive(),
    grossOrderCents: z.number().int().nonnegative(),
    referencePriceGrossCents: z.number().int().nonnegative(),
    redeemedAt: instant,
    createdAt: instant
  })
  .strict()

export const welcomeCouponContextLineSchema = z
  .object({
    lineIndex: z.number().int().min(0).max(99),
    productId: z.string().min(1).max(100),
    categoryId: z.string().min(1).max(100),
    quantity: z.number().int().min(1),
    unitGrossCents: z.number().int().nonnegative(),
    referencePriceUnitGrossCents: z.number().int().nonnegative(), // 30-day reference price for Omnibus
    hasVolumeDiscount: z.boolean().default(false)
  })
  .strict()

export const welcomeCouponEvaluationRequestSchema = z
  .object({
    couponCode: z.string().min(3).max(32),
    customerId: uuid,
    identityId: z.string().min(1).max(100),
    email: z.string().email(),
    phone: z.string().optional(),
    taxId: z.string().optional(),
    deviceFingerprint: z.string().optional(),
    lines: z.array(welcomeCouponContextLineSchema).min(1).max(100),
    now: instant.optional()
  })
  .strict()

export const welcomeCouponEvaluationResultSchema = z
  .object({
    eligible: z.boolean(),
    reason: z
      .enum([
        'coupon_not_found',
        'policy_paused',
        'coupon_expired',
        'ineligible_existing_customer',
        'anti_fraud_duplicate_email',
        'anti_fraud_duplicate_phone',
        'anti_fraud_duplicate_tax_id',
        'anti_fraud_duplicate_fingerprint',
        'already_redeemed',
        'min_order_unmet',
        'no_eligible_lines'
      ])
      .nullable(),
    couponCode: z.string(),
    discountPercent: z.number(),
    maxDiscountCents: z.number(),
    minOrderCents: z.number(),
    totalDiscountCents: z.number().int().nonnegative(),
    totalOrderGrossCents: z.number().int().nonnegative(),
    totalReferencePriceGrossCents: z.number().int().nonnegative(),
    lineAllocations: z.array(
      z
        .object({
          lineIndex: z.number(),
          productId: z.string(),
          eligible: z.boolean(),
          exclusionReason: z.string().nullable(),
          unitGrossCents: z.number(),
          referencePriceUnitGrossCents: z.number(),
          discountGrossCents: z.number()
        })
        .strict()
    )
  })
  .strict()

export type WelcomeCouponPolicy = z.infer<typeof welcomeCouponPolicySchema>
export type WelcomeCouponPolicyInput = z.infer<typeof welcomeCouponPolicyInputSchema>
export type WelcomeCouponGrant = z.infer<typeof welcomeCouponGrantSchema>
export type WelcomeCouponRedemption = z.infer<typeof welcomeCouponRedemptionSchema>
export type WelcomeCouponContextLine = z.infer<typeof welcomeCouponContextLineSchema>
export type WelcomeCouponEvaluationRequest = z.infer<typeof welcomeCouponEvaluationRequestSchema>
export type WelcomeCouponEvaluationResult = z.infer<typeof welcomeCouponEvaluationResultSchema>

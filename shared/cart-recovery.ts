import { z } from 'zod'
import { catalogPolicyInstantSchema as instant, catalogPolicyUuidSchema as uuid } from './catalog-publication-policy'

export const CART_RECOVERY_POLICY_VERSION = 'cart-recovery-2026-10-10' as const
export const CART_RECOVERY_NOTICE_TEXT =
  'Solicito por email recordatorios para recuperar mi carrito o checkout pendiente. Puedo desactivarlos en cualquier momento. No activa la newsletter, no reserva stock ni garantiza precios o disponibilidad.' as const
const version = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER - 1)
const hash = z.string().regex(/^[a-f0-9]{64}$/)
export const cartRecoveryPreferenceInputSchema = z
  .object({
    expectedVersion: version,
    recoveryEnabled: z.boolean(),
    policyVersion: z.literal(CART_RECOVERY_POLICY_VERSION)
  })
  .strict()
export const cartRecoveryAssociationInputSchema = z
  .object({
    expectedCartVersion: version.min(1),
    stage: z.enum(['cart', 'checkout']),
    policyVersion: z.literal(CART_RECOVERY_POLICY_VERSION)
  })
  .strict()
export const cartRecoveryResolveInputSchema = z
  .object({ id: uuid, token: z.string().regex(/^cr1\.[a-f0-9]{64}$/) })
  .strict()
export const cartRecoveryResumeInputSchema = cartRecoveryResolveInputSchema
  .extend({ expectedCartVersion: version.min(1) })
  .strict()
export const cartRecoveryPreferenceSchema = z
  .object({
    source: z.literal('cloudflare'),
    version,
    recoveryEnabled: z.boolean(),
    policyVersion: z.literal(CART_RECOVERY_POLICY_VERSION),
    noticeText: z.literal(CART_RECOVERY_NOTICE_TEXT),
    updatedAt: instant.nullable()
  })
  .strict()
export const cartRecoveryReceiptSchema = z
  .object({
    source: z.literal('cloudflare'),
    commandId: uuid,
    action: z.enum(['preferences', 'associate', 'resume']),
    payloadHash: hash,
    version: version.min(1),
    associationId: uuid.nullable(),
    cartVersion: version.min(1).nullable(),
    recoveryEnabled: z.boolean(),
    recordedAt: instant,
    inventoryEffect: z.literal('none'),
    economicEffect: z.literal('none')
  })
  .strict()
export const cartRecoveryCommandSchema = z.discriminatedUnion('outcome', [
  z
    .object({ source: z.literal('cloudflare'), outcome: z.literal('applied'), receipt: cartRecoveryReceiptSchema })
    .strict(),
  z.object({ source: z.literal('cloudflare'), outcome: z.literal('unknown'), receipt: z.null() }).strict()
])
export const cartRecoveryResolvedSchema = z
  .object({
    source: z.literal('cloudflare'),
    associationId: uuid,
    cartId: uuid,
    stage: z.enum(['cart', 'checkout']),
    cartVersion: version.min(1),
    expiresAt: instant,
    lines: z
      .array(
        z
          .object({
            variantId: z.number().int().positive(),
            quantity: z.number().int().positive(),
            name: z.string().min(1).max(300),
            sku: z.string().min(1).max(200),
            unitGrossCents: z.number().int().nonnegative(),
            netCents: z.number().int().nonnegative(),
            taxCents: z.number().int().nonnegative(),
            grossCents: z.number().int().nonnegative()
          })
          .strict()
      )
      .min(1)
      .max(100),
    inventoryEffect: z.literal('none'),
    economicEffect: z.literal('none'),
    evaluatedAt: instant
  })
  .strict()
export type CartRecoveryPreferenceInput = z.infer<typeof cartRecoveryPreferenceInputSchema>
export type CartRecoveryAssociationInput = z.infer<typeof cartRecoveryAssociationInputSchema>
export type CartRecoveryPreference = z.infer<typeof cartRecoveryPreferenceSchema>
export type CartRecoveryReceipt = z.infer<typeof cartRecoveryReceiptSchema>
export type CartRecoveryCommand = z.infer<typeof cartRecoveryCommandSchema>
export type CartRecoveryResolved = z.infer<typeof cartRecoveryResolvedSchema>
export type CartRecoveryResumeInput = z.infer<typeof cartRecoveryResumeInputSchema>
export async function cartRecoveryIntentHash(
  action: 'preferences' | 'associate' | 'resume',
  raw: unknown
): Promise<string> {
  const input = (
    action === 'preferences'
      ? cartRecoveryPreferenceInputSchema
      : action === 'associate'
        ? cartRecoveryAssociationInputSchema
        : cartRecoveryResumeInputSchema
  ).parse(raw)
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify({ action, input })))
  return Array.from(new Uint8Array(bytes), (value) => value.toString(16).padStart(2, '0')).join('')
}

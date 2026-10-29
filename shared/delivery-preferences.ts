import { z } from 'zod'
import { catalogPolicyInstantSchema } from './catalog-publication-policy'

export const DELIVERY_PREFERENCES_POLICY_VERSION = 'delivery-notices-2026-10-09' as const
export const DELIVERY_PREFERENCES_NOTICE_TEXT =
  'Elijo si recibir por email avisos operativos de preparación y entrega. No cambia los mensajes de pago, factura, reembolso, seguridad o soporte ni los consentimientos comerciales o de newsletter. Desactivar no garantiza cancelar mensajes ya en vuelo. Reactivar no reenvía avisos anteriores.' as const
const version = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER - 1)
export const deliveryPreferencesInputSchema = z
  .object({
    expectedVersion: version.max(Number.MAX_SAFE_INTEGER - 2),
    deliveryUpdates: z.boolean(),
    policyVersion: z.literal(DELIVERY_PREFERENCES_POLICY_VERSION)
  })
  .strict()
export const deliveryPreferencesSnapshotSchema = z
  .object({
    source: z.literal('cloudflare'),
    version,
    deliveryUpdates: z.boolean(),
    policyVersion: z.literal(DELIVERY_PREFERENCES_POLICY_VERSION),
    noticeText: z.literal(DELIVERY_PREFERENCES_NOTICE_TEXT),
    updatedAt: catalogPolicyInstantSchema.nullable()
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.version === 0) !== (value.updatedAt === null) || (value.version === 0 && !value.deliveryUpdates))
      ctx.addIssue({ code: 'custom', message: 'Unconfirmed delivery preference' })
  })
export const deliveryPreferencesReceiptSchema = z
  .object({
    source: z.literal('cloudflare'),
    commandId: z.string().uuid(),
    expectedVersion: version.max(Number.MAX_SAFE_INTEGER - 2),
    version: z
      .number()
      .int()
      .min(1)
      .max(Number.MAX_SAFE_INTEGER - 1),
    deliveryUpdates: z.boolean(),
    policyVersion: z.literal(DELIVERY_PREFERENCES_POLICY_VERSION),
    textHash: z.string().regex(/^[a-f0-9]{64}$/),
    recordedAt: catalogPolicyInstantSchema
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.version !== value.expectedVersion + 1)
      ctx.addIssue({ code: 'custom', message: 'Unconfirmed delivery preference version' })
  })
export const deliveryPreferencesCommandSchema = z
  .object({
    source: z.literal('cloudflare'),
    commandId: z.string().uuid(),
    outcome: z.enum(['applied', 'unknown']),
    receipt: deliveryPreferencesReceiptSchema.nullable()
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      (value.outcome === 'applied') !== (value.receipt !== null) ||
      (value.receipt && value.receipt.commandId !== value.commandId)
    )
      ctx.addIssue({ code: 'custom', message: 'Unconfirmed delivery preference command' })
  })
export type DeliveryPreferencesInput = z.infer<typeof deliveryPreferencesInputSchema>
export type DeliveryPreferencesSnapshot = z.infer<typeof deliveryPreferencesSnapshotSchema>
export type DeliveryPreferencesReceipt = z.infer<typeof deliveryPreferencesReceiptSchema>
export type DeliveryPreferencesCommand = z.infer<typeof deliveryPreferencesCommandSchema>

export async function deliveryPreferenceIntentHash(input: unknown): Promise<string> {
  const normalized = deliveryPreferencesInputSchema.parse(input)
  const bytes = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(normalized)))
  return Array.from(new Uint8Array(bytes), (value) => value.toString(16).padStart(2, '0')).join('')
}

import { z } from 'zod'
import { catalogPolicyInstantSchema } from './catalog-publication-policy'

export const ACCOUNT_PREFERENCES_POLICY_VERSION = 'communications-2026-10-08' as const
export const ACCOUNT_PREFERENCES_CONSENT_TEXT =
  'Elijo si quiero recibir por email novedades de producto y avisos comerciales de reposición de NETECO. Puedo retirar cada preferencia en cualquier momento. Guardar estas preferencias no envía mensajes ni activa la newsletter.' as const
export const accountPreferenceValuesSchema = z
  .object({ product_updates: z.boolean(), replenishment: z.boolean() })
  .strict()
const version = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER - 1)
export const accountPreferencesInputSchema = z
  .object({
    expectedVersion: version,
    preferences: accountPreferenceValuesSchema,
    policyVersion: z.literal(ACCOUNT_PREFERENCES_POLICY_VERSION)
  })
  .strict()
export const accountPreferencesSnapshotSchema = z
  .object({
    source: z.literal('cloudflare'),
    version,
    preferences: accountPreferenceValuesSchema,
    policyVersion: z.literal(ACCOUNT_PREFERENCES_POLICY_VERSION),
    consentText: z.literal(ACCOUNT_PREFERENCES_CONSENT_TEXT),
    updatedAt: catalogPolicyInstantSchema.nullable()
  })
  .strict()
  .superRefine((v, ctx) => {
    if (
      (v.version === 0) !== (v.updatedAt === null) ||
      (v.version === 0 && (v.preferences.product_updates || v.preferences.replenishment))
    )
      ctx.addIssue({ code: 'custom', message: 'Unconfirmed preference snapshot' })
  })
export const accountPreferencesReceiptSchema = z
  .object({
    source: z.literal('cloudflare'),
    commandId: z.string().uuid(),
    expectedVersion: version,
    version: z
      .number()
      .int()
      .min(1)
      .max(Number.MAX_SAFE_INTEGER - 1),
    preferences: accountPreferenceValuesSchema,
    policyVersion: z.literal(ACCOUNT_PREFERENCES_POLICY_VERSION),
    textHash: z.string().regex(/^[a-f0-9]{64}$/),
    recordedAt: catalogPolicyInstantSchema
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.version !== v.expectedVersion + 1) ctx.addIssue({ code: 'custom', message: 'Unconfirmed preference version' })
  })
export const accountPreferencesCommandSchema = z
  .object({
    source: z.literal('cloudflare'),
    commandId: z.string().uuid(),
    outcome: z.enum(['applied', 'unknown']),
    receipt: accountPreferencesReceiptSchema.nullable()
  })
  .strict()
  .superRefine((v, ctx) => {
    if ((v.outcome === 'applied') !== (v.receipt !== null) || (v.receipt && v.receipt.commandId !== v.commandId))
      ctx.addIssue({ code: 'custom', message: 'Unconfirmed preference command' })
  })
export type AccountPreferencesInput = z.infer<typeof accountPreferencesInputSchema>
export type AccountPreferencesSnapshot = z.infer<typeof accountPreferencesSnapshotSchema>
export type AccountPreferencesReceipt = z.infer<typeof accountPreferencesReceiptSchema>

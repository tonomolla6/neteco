import { z } from 'zod'
import { catalogPolicyInstantSchema, catalogPolicyUuidSchema } from './catalog-publication-policy'

export const PREFERENCE_CENTER_POLICY_VERSION = 'preference-center-2026-10-29' as const
export const PREFERENCE_CENTER_CONSENT_TEXT =
  'Elijo qué comunicaciones comerciales quiero recibir de NETECO, con qué frecuencia y por qué canal. Todas las opciones empiezan desactivadas, puedo cambiarlas o retirarlas en cualquier momento y retirar una opción no requiere ninguna confirmación adicional.' as const
export const PREFERENCE_FREQUENCIES = ['weekly', 'biweekly', 'monthly', 'quarterly', 'never'] as const
export const PREFERENCE_TOPICS = ['product_news', 'offers', 'usage_tips', 'safety_regulation', 'replenishment'] as const
export const PREFERENCE_SECTORS = [
  'hospitality',
  'healthcare',
  'industrial',
  'cleaning_services',
  'food_industry',
  'education',
  'home',
  'other'
] as const
export const PREFERENCE_CHANNELS = ['email', 'sms', 'push'] as const
export const PREFERENCE_SYNC_TARGETS = ['esp', 'cmp'] as const

const unique = <T extends z.ZodTypeAny>(item: T, max: number) =>
  z
    .array(item)
    .max(max)
    .refine((values) => new Set(values).size === values.length, 'duplicate')
    .transform((values) => [...values].sort() as z.infer<T>[])
const channels = z.object({ email: z.boolean(), sms: z.boolean(), push: z.boolean() }).strict()

/** Consistency rules shared by input, snapshots and receipts: no hidden defaults. */
function consistent(
  v: {
    frequency: string
    topics: unknown[]
    sectors: unknown[]
    channels: Record<string, boolean>
    unsubscribeAll: boolean
  },
  ctx: z.RefinementCtx
) {
  const any = v.channels.email || v.channels.sms || v.channels.push
  if (v.unsubscribeAll && (v.frequency !== 'never' || v.topics.length || v.sectors.length || any))
    ctx.addIssue({ code: 'custom', message: 'unsubscribe_all_must_clear_everything' })
  if (v.topics.length && (v.frequency === 'never' || !any))
    ctx.addIssue({ code: 'custom', message: 'topics_need_frequency_and_channel' })
}
export const preferenceCenterValuesSchema = z
  .object({
    frequency: z.enum(PREFERENCE_FREQUENCIES),
    topics: unique(z.enum(PREFERENCE_TOPICS), PREFERENCE_TOPICS.length),
    sectors: unique(z.enum(PREFERENCE_SECTORS), PREFERENCE_SECTORS.length),
    channels,
    unsubscribeAll: z.boolean()
  })
  .strict()
  .superRefine(consistent)
const version = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER - 1)
export const preferenceCenterInputSchema = z
  .object({
    expectedVersion: version,
    policyVersion: z.literal(PREFERENCE_CENTER_POLICY_VERSION),
    preferences: preferenceCenterValuesSchema,
    /** Required only when a channel/topic is newly switched on; never to withdraw. */
    acknowledged: z.boolean().default(false)
  })
  .strict()
const syncStatus = z.enum(['pending', 'synced', 'failed', 'superseded'])
const sync = z.object({ esp: syncStatus.nullable(), cmp: syncStatus.nullable() }).strict()
export const preferenceCenterSnapshotSchema = z
  .object({
    source: z.literal('cloudflare'),
    version,
    preferences: preferenceCenterValuesSchema,
    policyVersion: z.literal(PREFERENCE_CENTER_POLICY_VERSION),
    consentText: z.literal(PREFERENCE_CENTER_CONSENT_TEXT),
    updatedAt: catalogPolicyInstantSchema.nullable(),
    sync
  })
  .strict()
  .superRefine((v, ctx) => {
    if ((v.version === 0) !== (v.updatedAt === null)) ctx.addIssue({ code: 'custom', message: 'unconfirmed_snapshot' })
  })
export const preferenceCenterReceiptSchema = z
  .object({
    source: z.literal('cloudflare'),
    commandId: catalogPolicyUuidSchema,
    expectedVersion: version,
    version: z
      .number()
      .int()
      .min(1)
      .max(Number.MAX_SAFE_INTEGER - 1),
    preferences: preferenceCenterValuesSchema,
    policyVersion: z.literal(PREFERENCE_CENTER_POLICY_VERSION),
    recordedAt: catalogPolicyInstantSchema,
    sync
  })
  .strict()
  .refine((v) => v.version === v.expectedVersion + 1, 'unconfirmed_version')
export type PreferenceCenterValues = z.infer<typeof preferenceCenterValuesSchema>
export type PreferenceCenterInput = z.input<typeof preferenceCenterInputSchema>
export type PreferenceCenterSnapshot = z.infer<typeof preferenceCenterSnapshotSchema>
export type PreferenceCenterReceipt = z.infer<typeof preferenceCenterReceiptSchema>

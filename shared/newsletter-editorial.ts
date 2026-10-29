import { z } from 'zod'
import {
  catalogPolicyOwnJson,
  catalogPolicyUuidSchema as uuid,
  catalogPolicyInstantSchema as instant
} from './catalog-publication-policy'

const own = (value: unknown) => {
  try {
    return catalogPolicyOwnJson(value)
  } catch {
    return undefined
  }
}
export const newsletterRevisionSchema = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER - 2)
export const newsletterReasonSchema = z.string().trim().min(3).max(500)
export const newsletterTopicCodeSchema = z.string().regex(/^[a-z][a-z0-9-]{0,59}$/)
export const newsletterFrequencySchema = z.enum(['immediate', 'weekly', 'monthly'])
const minute = z.number().int().min(0).max(1439)
export const newsletterQuietHoursSchema = z
  .object({ startMinute: minute, endMinute: minute, timezone: z.literal('Europe/Madrid') })
  .strict()
  .refine((value) => value.startMinute !== value.endMinute, 'El horario debe tener inicio y final distintos.')
const topicList = z
  .array(newsletterTopicCodeSchema)
  .max(20)
  .refine((values) => new Set(values).size === values.length, 'Tema duplicado')
export const newsletterPreferenceSchema = z
  .object({
    frequency: newsletterFrequencySchema,
    topics: topicList,
    locale: z.literal('es'),
    quietHours: newsletterQuietHoursSchema.nullable()
  })
  .strict()
export type NewsletterPreference = z.infer<typeof newsletterPreferenceSchema>
export const newsletterPreferenceAccessInputSchema = z.preprocess(
  own,
  z
    .object({
      confirmationToken: z
        .string()
        .regex(/^n1\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[0-9a-f]{64}$/)
    })
    .strict()
)
export const newsletterPreferenceAccessSchema = z
  .object({
    source: z.literal('cloudflare'),
    token: z.string().regex(/^np1\.[0-9a-f-]{36}\.[1-9]\d{9}\.[0-9a-f]{64}$/),
    expiresInSeconds: z.literal(1800)
  })
  .strict()
/** Only these service errors are conclusively returned before a successful
 * command commit (CAS guards roll back atomically). Do not include identity
 * failures, idempotency mismatch, corrupt receipts or unknown outcomes. */
const rejection = (status: 409 | 422, codes: readonly [string, ...string[]]) =>
  z
    .object({
      statusCode: z.literal(status),
      data: z.object({ error: z.object({ code: z.enum(codes) }).strict() }).strict()
    })
    .passthrough()
export const newsletterPrecommitRejectionSchema = z.union([
  rejection(409, [
    'version_conflict',
    'not_editable',
    'topic_unavailable',
    'source_unavailable',
    'policy_unavailable',
    'consent_unavailable'
  ]),
  rejection(422, ['invalid_input', 'invalid_window', 'editorial_ratio'])
])
export const newsletterHttpAuthorityLossSchema = z
  .object({ statusCode: z.union([z.literal(401), z.literal(403)]) })
  .passthrough()
export const newsletterPreferenceInputSchema = z.preprocess(
  own,
  z.discriminatedUnion('action', [
    z
      .object({
        action: z.literal('save'),
        expectedRevision: newsletterRevisionSchema,
        preference: newsletterPreferenceSchema
      })
      .strict(),
    z.object({ action: z.literal('unsubscribe'), expectedRevision: newsletterRevisionSchema }).strict()
  ])
)
export const newsletterPolicyDocumentSchema = z
  .object({
    name: z.string().trim().min(3).max(160),
    reason: newsletterReasonSchema,
    intervalHours: z
      .object({
        immediate: z.number().int().min(1).max(8760),
        weekly: z.number().int().min(168).max(8760),
        monthly: z.number().int().min(744).max(8760)
      })
      .strict(),
    quietHours: newsletterQuietHoursSchema.nullable(),
    minEditorialPercent: z.number().int().min(0).max(100),
    locale: z.literal('es')
  })
  .strict()
  .refine(
    (p) => p.intervalHours.immediate <= p.intervalHours.weekly && p.intervalHours.weekly <= p.intervalHours.monthly,
    'Los intervalos deben ser crecientes.'
  )
export type NewsletterPolicyDocument = z.infer<typeof newsletterPolicyDocumentSchema>
const blockBase = { id: uuid, kind: z.enum(['editorial', 'commercial']) }
export const newsletterBlockSchema = z.discriminatedUnion('type', [
  z.object({ ...blockBase, type: z.literal('heading'), text: z.string().trim().min(1).max(200) }).strict(),
  z.object({ ...blockBase, type: z.literal('paragraph'), text: z.string().trim().min(1).max(12000) }).strict(),
  z
    .object({
      ...blockBase,
      type: z.literal('link'),
      label: z.string().trim().min(3).max(160),
      target: z.discriminatedUnion('type', [
        z
          .object({
            type: z.literal('static'),
            path: z.enum([
              '/catalogo',
              '/ayuda',
              '/contacto',
              '/envios',
              '/devoluciones',
              '/formas-de-pago',
              '/accesibilidad'
            ])
          })
          .strict(),
        z.object({ type: z.literal('cms'), slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,159}$/) }).strict(),
        z.object({ type: z.literal('product'), slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,179}$/) }).strict()
      ])
    })
    .strict()
])
export const newsletterCampaignDocumentSchema = z
  .object({
    name: z.string().trim().min(3).max(160),
    subject: z
      .string()
      .trim()
      .min(3)
      .max(160)
      .refine((s) => Array.from(s).every((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127)),
    locale: z.literal('es'),
    topics: topicList,
    topicMatch: z.enum(['any', 'all']),
    frequencies: z
      .array(newsletterFrequencySchema)
      .min(1)
      .max(3)
      .refine((v) => new Set(v).size === v.length),
    blocks: z
      .array(newsletterBlockSchema)
      .min(1)
      .max(50)
      .refine((v) => new Set(v.map((b) => b.id)).size === v.length),
    changeSummary: newsletterReasonSchema
  })
  .strict()
  .refine(
    (value) => new TextEncoder().encode(JSON.stringify(value)).byteLength <= 262144,
    'La campaña excede el máximo de 256 KiB.'
  )
export type NewsletterCampaignDocument = z.infer<typeof newsletterCampaignDocumentSchema>
const common = { expectedRevision: newsletterRevisionSchema, reason: newsletterReasonSchema }
export const newsletterAdminInputSchema = z.preprocess(
  own,
  z.discriminatedUnion('action', [
    z.object({ action: z.literal('set_policy'), ...common, policy: newsletterPolicyDocumentSchema }).strict(),
    z.object({ action: z.literal('retire_policy'), ...common }).strict(),
    z
      .object({
        action: z.literal('create_topic'),
        ...common,
        code: newsletterTopicCodeSchema,
        label: z.string().trim().min(3).max(120)
      })
      .strict(),
    z
      .object({
        action: z.literal('update_topic'),
        ...common,
        label: z.string().trim().min(3).max(120),
        active: z.boolean()
      })
      .strict(),
    z.object({ action: z.literal('create_campaign'), ...common, document: newsletterCampaignDocumentSchema }).strict(),
    z.object({ action: z.literal('update_campaign'), ...common, document: newsletterCampaignDocumentSchema }).strict(),
    z
      .object({
        action: z.literal('approve_campaign'),
        ...common,
        versionId: uuid,
        policyId: uuid,
        startsAtLocal: z.string().min(16).max(19),
        endsAtLocal: z.string().min(16).max(19),
        repeatedHour: z.enum(['earlier', 'later'])
      })
      .strict(),
    z.object({ action: z.literal('cancel_campaign'), ...common }).strict()
  ])
)
export type NewsletterAdminInput = z.infer<typeof newsletterAdminInputSchema>
export const newsletterCommandReceiptSchema = z
  .object({
    source: z.literal('cloudflare'),
    resourceId: uuid,
    revision: newsletterRevisionSchema.min(1),
    action: z.enum([
      'set_policy',
      'retire_policy',
      'create_topic',
      'update_topic',
      'create_campaign',
      'update_campaign',
      'approve_campaign',
      'cancel_campaign',
      'save',
      'unsubscribe'
    ]),
    updated: z.literal(true)
  })
  .strict()
export type NewsletterCommandReceipt = z.infer<typeof newsletterCommandReceiptSchema>
export const newsletterTopicSchema = z
  .object({
    id: uuid,
    code: newsletterTopicCodeSchema,
    label: z.string().min(3).max(120),
    active: z.boolean(),
    revision: newsletterRevisionSchema.min(1)
  })
  .strict()
export const newsletterPreferenceSnapshotSchema = z
  .object({
    source: z.literal('cloudflare'),
    subscriptionId: uuid.nullable(),
    status: z.enum(['not_subscribed', 'pending', 'confirmed', 'unsubscribed', 'suppressed']),
    revision: newsletterRevisionSchema,
    preference: newsletterPreferenceSchema.nullable(),
    topics: z.array(newsletterTopicSchema),
    canSave: z.boolean(),
    canUnsubscribe: z.boolean(),
    externalDelivery: z.boolean()
  })
  .strict()
export const newsletterCampaignSchema = z
  .object({
    id: uuid,
    revision: newsletterRevisionSchema.min(1),
    status: z.enum(['draft', 'approved', 'cancelled', 'completed']),
    versionId: uuid,
    document: newsletterCampaignDocumentSchema,
    approvedVersionId: uuid.nullable(),
    policyId: uuid.nullable(),
    startsAt: instant.nullable(),
    endsAt: instant.nullable(),
    fanoutComplete: z.boolean(),
    totals: z
      .object({
        pending: z.number().int().min(0),
        leased: z.number().int().min(0),
        sending: z.number().int().min(0),
        accepted: z.number().int().min(0),
        skipped: z.number().int().min(0),
        manualReview: z.number().int().min(0),
        delivered: z.number().int().min(0),
        bounced: z.number().int().min(0),
        complained: z.number().int().min(0)
      })
      .strict()
  })
  .strict()
export const newsletterAdminSnapshotSchema = z
  .object({
    source: z.literal('cloudflare'),
    policyRevision: newsletterRevisionSchema,
    policy: z.object({ id: uuid, document: newsletterPolicyDocumentSchema }).strict().nullable(),
    topics: z.array(newsletterTopicSchema),
    campaigns: z.array(newsletterCampaignSchema).max(100),
    nextCursor: uuid.nullable(),
    capabilities: z
      .object({
        manage: z.literal(true),
        preview: z.literal(true),
        localDispatch: z.boolean(),
        externalDelivery: z.boolean()
      })
      .strict()
  })
  .strict()
export const newsletterPreviewSchema = z
  .object({
    source: z.literal('cloudflare'),
    campaignId: uuid,
    versionId: uuid,
    synthetic: z.literal(true),
    externalDelivery: z.literal(false),
    subject: z.string(),
    html: z.string().max(300000),
    text: z.string().max(300000),
    editorialPercent: z.number().min(0).max(100),
    actionsEnabled: z.literal(false)
  })
  .strict()
export const newsletterDispatchReportSchema = z
  .object({
    source: z.literal('cloudflare'),
    externalDelivery: z.boolean(),
    disabled: z.boolean(),
    expanded: z.number().int().min(0),
    acceptedLocal: z.number().int().min(0),
    acceptedProvider: z.number().int().min(0),
    skipped: z.number().int().min(0),
    deferred: z.number().int().min(0),
    manualReview: z.number().int().min(0)
  })
  .strict()

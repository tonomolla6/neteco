import { z } from 'zod'
import { supportInstant, supportText, supportUuid } from './support-operations'

export const ADMIN_AUDIT_FAMILIES = [
  'catalog_metadata',
  'catalog_status',
  'catalog_policy',
  'catalog_authoring',
  'catalog_price',
  'catalog_category',
  'catalog_editorial',
  'catalog_native',
  'catalog_import',
  'catalog_attributes',
  'search_synonym',
  'catalog_relation',
  'media_rights',
  'media_publication',
  'media_withdrawal',
  'cms_draft',
  'cms_publication',
  'inventory',
  'fulfillment',
  'returns',
  'cancellation',
  'order_annotation',
  'order_packing',
  'inventory_alert',
  'inventory_count_import',
  'shipping_calendar',
  'fiscal',
  'financial',
  'support',
  'support_macro',
  'support_escalation',
  'newsletter_editorial',
  'company_review',
  'promotion',
  'communication_history',
  'admin_invitation',
  'admin_bootstrap',
  'admin_audit'
] as const
export const adminAuditFamilySchema = z.enum(ADMIN_AUDIT_FAMILIES)
export const adminAuditHashSchema = z.string().regex(/^[a-f0-9]{64}$/)
export const adminAuditIdSchema = z
  .string()
  .max(160)
  .regex(/^[a-z_]+:[a-f0-9-]{36}(?::[a-f0-9-]{36})?$/)
const resource = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9_.:-]+$/)
const filters = {
  family: adminAuditFamilySchema.optional(),
  actorId: supportUuid.optional(),
  resourceId: resource.optional(),
  from: supportInstant.optional(),
  to: supportInstant.optional()
}
export const adminAuditFiltersSchema = z.object(filters).strict()
export const adminAuditQuerySchema = z
  .object({
    ...filters,
    limit: z.coerce.number().int().min(1).max(25).default(25),
    cursor: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,1024}$/)
      .optional()
  })
  .strict()
const redaction = z.enum(['redacted', 'unknown'])
export const adminAuditItemSchema = z
  .object({
    id: adminAuditIdSchema,
    family: adminAuditFamilySchema,
    action: z.string().min(1).max(80),
    createdAt: z.string().datetime(),
    actorId: supportUuid.nullable(),
    resourceId: resource,
    commandId: supportUuid.nullable(),
    sessionId: supportUuid.nullable(),
    ipHash: adminAuditHashSchema.nullable(),
    reason: redaction,
    before: redaction,
    after: redaction,
    reviewVersion: z.number().int().min(0),
    disposition: z.enum(['reviewed', 'follow_up']).nullable()
  })
  .strict()
export const adminAuditCoverageSchema = z
  .object({
    families: z.array(adminAuditFamilySchema).max(50),
    historicalNetworkMetadata: z.literal('only_when_recorded'),
    excluded: z
      .array(
        z.enum([
          'customer_self_service',
          'automated_provider_events',
          'application_logs',
          'historical_unclassified_cancellation'
        ])
      )
      .max(4)
  })
  .strict()
export const adminAuditListSchema = z
  .object({
    source: z.literal('cloudflare'),
    items: z.array(adminAuditItemSchema).max(25),
    nextCursor: z.string().max(1024).nullable(),
    evaluatedAt: supportInstant,
    coverage: adminAuditCoverageSchema
  })
  .strict()
export const adminAuditReviewSchema = z
  .object({
    commandId: supportUuid,
    actorId: supportUuid,
    version: z.number().int().min(1),
    disposition: z.enum(['reviewed', 'follow_up']),
    recordedAt: supportInstant,
    reason: z.literal('redacted')
  })
  .strict()
const numericChange = z
  .object({
    field: z.enum([
      'version',
      'quantity',
      'physicalQuantity',
      'threshold',
      'grossCents',
      'netCents',
      'labelCount',
      'noteCount',
      'permissionCount'
    ]),
    before: z.number().int().safe().nullable(),
    after: z.number().int().safe().nullable()
  })
  .strict()
const stateChange = z
  .object({
    field: z.enum(['state', 'status', 'roleCode']),
    before: z
      .enum([
        'draft',
        'active',
        'paused',
        'published',
        'withdrawn',
        'pending',
        'awaiting_payment',
        'approved',
        'rejected',
        'accepted',
        'revoked',
        'open',
        'acknowledged',
        'resolved',
        'requested',
        'received',
        'picking',
        'packed',
        'ready_for_pickup',
        'in_transit',
        'delivered',
        'cancelled',
        'support',
        'warehouse',
        'catalog_editor',
        'publisher',
        'finance',
        'admin'
      ])
      .nullable(),
    after: z
      .enum([
        'draft',
        'active',
        'paused',
        'published',
        'withdrawn',
        'pending',
        'awaiting_payment',
        'approved',
        'rejected',
        'accepted',
        'revoked',
        'open',
        'acknowledged',
        'resolved',
        'requested',
        'received',
        'picking',
        'packed',
        'ready_for_pickup',
        'in_transit',
        'delivered',
        'cancelled',
        'support',
        'warehouse',
        'catalog_editor',
        'publisher',
        'finance',
        'admin'
      ])
      .nullable()
  })
  .strict()
export const adminAuditChangeSchema = z.union([
  numericChange,
  stateChange,
  z.object({ field: z.literal('active'), before: z.boolean().nullable(), after: z.boolean().nullable() }).strict()
])
export const adminAuditDetailSchema = z
  .object({
    source: z.literal('cloudflare'),
    item: adminAuditItemSchema,
    changes: z.array(adminAuditChangeSchema).max(20),
    changesAvailability: z.enum(['recorded', 'redacted', 'unknown']),
    reviews: z.array(adminAuditReviewSchema).max(100),
    evaluatedAt: supportInstant
  })
  .strict()
export const adminAuditReviewInputSchema = z
  .object({
    expectedVersion: z
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER - 1),
    disposition: z.enum(['reviewed', 'follow_up']),
    reason: supportText(10, 500)
  })
  .strict()
export const adminAuditExportInputSchema = z
  .object({
    filters: adminAuditFiltersSchema,
    reason: supportText(10, 500)
  })
  .strict()
const receipt = {
  source: z.literal('cloudflare'),
  commandId: supportUuid,
  payloadHash: adminAuditHashSchema,
  recordedAt: supportInstant
}
export const adminAuditReceiptSchema = z.discriminatedUnion('action', [
  z
    .object({
      ...receipt,
      action: z.literal('review'),
      eventId: adminAuditIdSchema,
      version: z.number().int().min(1),
      disposition: z.enum(['reviewed', 'follow_up'])
    })
    .strict(),
  z
    .object({
      ...receipt,
      action: z.literal('export'),
      rows: z.number().int().min(0).max(1000),
      bytes: z.number().int().min(1).max(2_000_000),
      digest: adminAuditHashSchema,
      filterHash: adminAuditHashSchema,
      expiresAt: supportInstant
    })
    .strict()
])
export const adminAuditCommandSchema = z.discriminatedUnion('outcome', [
  z
    .object({ source: z.literal('cloudflare'), outcome: z.literal('applied'), receipt: adminAuditReceiptSchema })
    .strict(),
  z.object({ source: z.literal('cloudflare'), outcome: z.literal('unknown'), receipt: z.null() }).strict()
])
export type AdminAuditFamily = z.infer<typeof adminAuditFamilySchema>
export type AdminAuditItem = z.infer<typeof adminAuditItemSchema>
export type AdminAuditList = z.infer<typeof adminAuditListSchema>
export type AdminAuditDetail = z.infer<typeof adminAuditDetailSchema>
export type AdminAuditReceipt = z.infer<typeof adminAuditReceiptSchema>
export type AdminAuditCommand = z.infer<typeof adminAuditCommandSchema>
export type AdminAuditReviewInput = z.infer<typeof adminAuditReviewInputSchema>
export type AdminAuditExportInput = z.infer<typeof adminAuditExportInputSchema>
export const ADMIN_AUDIT_EXPORT_FILENAME = 'neteco-admin-audit.csv'
export const ADMIN_AUDIT_EXPORT_CONTENT_TYPE = 'text/csv; charset=utf-8'
export const ADMIN_AUDIT_EXPORT_MAX_BYTES = 2_000_000
export const ADMIN_AUDIT_EXPORT_COLUMNS = [
  'id',
  'family',
  'action',
  'createdAt',
  'actorId',
  'resourceId',
  'commandId',
  'sessionId',
  'ipHash',
  'reason',
  'before',
  'after',
  'reviewVersion',
  'disposition'
] as const
export const ADMIN_AUDIT_EXPORT_HEADERS = {
  source: 'X-Neteco-Export-Source',
  rows: 'X-Neteco-Export-Rows',
  bytes: 'X-Neteco-Export-Bytes',
  digest: 'X-Neteco-Export-Digest'
} as const
export async function adminAuditHash(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}
export async function adminAuditIntentHash(action: 'review' | 'export', targetId: string | null, raw: unknown) {
  const input = action === 'review' ? adminAuditReviewInputSchema.parse(raw) : adminAuditExportInputSchema.parse(raw)
  if (
    (action === 'review' && !adminAuditIdSchema.safeParse(targetId).success) ||
    (action === 'export' && targetId !== null)
  )
    throw new Error('invalid_input')
  return adminAuditHash(JSON.stringify({ purpose: 'admin-audit-v1', action, targetId, input }))
}
export function adminAuditFilterHash(raw: unknown) {
  return adminAuditHash(JSON.stringify(adminAuditFiltersSchema.parse(raw)))
}

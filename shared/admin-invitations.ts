import { z } from 'zod'
import { supportInstant, supportText, supportUuid } from './support-operations'

export const adminInvitationRoleSchema = z.enum([
  'support',
  'warehouse',
  'catalog_editor',
  'publisher',
  'finance',
  'admin'
])
export const adminInvitationHashSchema = z.string().regex(/^[a-f0-9]{64}$/)
export const adminInvitationCreateInputSchema = z
  .object({
    recipientEmail: z.string().trim().toLowerCase().email().max(254),
    roleCode: adminInvitationRoleSchema,
    tokenHash: adminInvitationHashSchema,
    expiresInHours: z.number().int().min(1).max(168),
    reason: supportText(10, 500)
  })
  .strict()
export const adminInvitationRevokeInputSchema = z
  .object({
    expectedVersion: z
      .number()
      .int()
      .min(1)
      .max(Number.MAX_SAFE_INTEGER - 1),
    reason: supportText(10, 500)
  })
  .strict()
export const adminInvitationAcceptInputSchema = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict()
export const adminInvitationQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).max(10000).default(1),
    perPage: z.coerce.number().int().min(1).max(25).default(25)
  })
  .strict()
export const adminInvitationSchema = z
  .object({
    id: supportUuid,
    recipientEmail: z.string().email().max(254),
    roleCode: adminInvitationRoleSchema,
    version: z.number().int().min(1),
    status: z.enum(['pending', 'accepted', 'revoked', 'expired']),
    createdAt: supportInstant,
    expiresAt: supportInstant,
    acceptedAt: supportInstant.nullable(),
    revokedAt: supportInstant.nullable()
  })
  .strict()
export const adminInvitationListSchema = z
  .object({
    source: z.literal('cloudflare'),
    page: z.number().int().min(1),
    perPage: z.number().int().min(1).max(25),
    total: z.number().int().min(0),
    roles: z
      .array(
        z
          .object({ code: adminInvitationRoleSchema, permissions: z.array(z.string().min(1).max(100)).min(1).max(100) })
          .strict()
      )
      .max(6),
    items: z.array(adminInvitationSchema).max(25)
  })
  .strict()
export const adminInvitationPreviewSchema = z
  .object({
    source: z.literal('cloudflare'),
    invitationId: supportUuid,
    roleCode: adminInvitationRoleSchema,
    permissions: z.array(z.string().min(1).max(100)).min(1).max(100),
    expiresAt: supportInstant
  })
  .strict()
export const adminInvitationReceiptSchema = z
  .object({
    source: z.literal('cloudflare'),
    commandId: supportUuid,
    action: z.enum(['create', 'revoke', 'accept']),
    invitationId: supportUuid,
    version: z.number().int().min(1),
    payloadHash: adminInvitationHashSchema,
    recordedAt: supportInstant,
    roleCode: adminInvitationRoleSchema,
    sessionRevoked: z.boolean()
  })
  .strict()
export const adminInvitationCommandSchema = z.discriminatedUnion('outcome', [
  z
    .object({ source: z.literal('cloudflare'), outcome: z.literal('applied'), receipt: adminInvitationReceiptSchema })
    .strict(),
  z.object({ source: z.literal('cloudflare'), outcome: z.literal('unknown'), receipt: z.null() }).strict()
])
export type AdminInvitationCreateInput = z.infer<typeof adminInvitationCreateInputSchema>
export type AdminInvitationRevokeInput = z.infer<typeof adminInvitationRevokeInputSchema>
export type AdminInvitation = z.infer<typeof adminInvitationSchema>
export type AdminInvitationList = z.infer<typeof adminInvitationListSchema>
export type AdminInvitationPreview = z.infer<typeof adminInvitationPreviewSchema>
export type AdminInvitationReceipt = z.infer<typeof adminInvitationReceiptSchema>
export type AdminInvitationCommand = z.infer<typeof adminInvitationCommandSchema>
export async function adminInvitationTokenHash(token: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}
/** Never serialize an acceptance secret into a durable command or receipt. */
export async function adminInvitationIntentHash(
  action: 'create' | 'revoke' | 'accept',
  targetId: string | null,
  raw: unknown
) {
  const input =
    action === 'create'
      ? adminInvitationCreateInputSchema.parse(raw)
      : action === 'revoke'
        ? adminInvitationRevokeInputSchema.parse(raw)
        : { tokenHash: await adminInvitationTokenHash(adminInvitationAcceptInputSchema.parse(raw).token) }
  return adminInvitationTokenHash(JSON.stringify({ purpose: 'admin-invitation-v1', action, targetId, input }))
}

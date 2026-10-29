import { z } from 'zod'
import { catalogPolicyUuidSchema, catalogPolicyInstantSchema } from './catalog-publication-policy'

const text = (min: number, max: number) =>
  z
    .string()
    .min(min)
    .max(max)
    .refine(
      (v) =>
        v === v.trim() &&
        [...v].every((c) => (c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127) || c === '\n' || c === '\t')
    )
const slot = z
  .object({
    key: z
      .string()
      .regex(/^[a-z][a-zA-Z0-9]{0,31}$/)
      .refine((v) => !['constructor', 'prototype', '__proto__'].includes(v)),
    label: text(3, 100),
    required: z.boolean()
  })
  .strict()
export const supportMacroContentSchema = z
  .object({ title: text(3, 120), body: text(10, 4000), tone: text(10, 300), personalizations: z.array(slot).max(10) })
  .strict()
  .superRefine((v, ctx) => {
    const keys = v.personalizations.map((s) => s.key)
    const tokens = [...v.body.matchAll(/\{\{([^{}]+)\}\}/g)].map((m) => m[1]!)
    const leftover = v.body.replace(/\{\{([^{}]+)\}\}/g, '')
    if (
      new Set(keys).size !== keys.length ||
      /[{}]/.test(leftover) ||
      tokens.some(
        (t) =>
          !['ticket.reference', 'ticket.category', 'ticket.state'].includes(t) &&
          !(t.startsWith('personal.') && keys.includes(t.slice(9)))
      ) ||
      keys.some((k) => !tokens.includes('personal.' + k))
    )
      ctx.addIssue({ code: 'custom', message: 'Variables no permitidas o campos de personalización no usados' })
  })
const base = {
  expectedVersion: z
    .number()
    .int()
    .min(0)
    .max(Number.MAX_SAFE_INTEGER - 1),
  reason: text(3, 500)
}
export const supportMacroCommandSchema = z.discriminatedUnion('action', [
  z
    .object({
      ...base,
      action: z.literal('draft'),
      title: text(3, 120),
      body: text(10, 4000),
      tone: text(10, 300),
      personalizations: z.array(slot).max(10)
    })
    .strict(),
  z
    .object({
      ...base,
      action: z.literal('approve'),
      operationalReference: text(3, 300),
      legalReference: text(3, 300),
      reviewedAt: catalogPolicyInstantSchema,
      expiresAt: catalogPolicyInstantSchema
    })
    .strict(),
  z.object({ ...base, action: z.literal('withdraw') }).strict()
])
export const supportMacroSelectionSchema = z
  .object({
    macroId: catalogPolicyUuidSchema,
    revisionId: catalogPolicyUuidSchema,
    personalizations: z.record(z.string().max(300)).refine((v) => Object.keys(v).length <= 10)
  })
  .strict()
export const supportMacroReplySchema = supportMacroSelectionSchema.extend({ confirmed: z.literal(true) })
export const supportMacroReviewSchema = z
  .object({
    operationalReference: text(3, 300),
    legalReference: text(3, 300),
    reviewedAt: catalogPolicyInstantSchema,
    expiresAt: catalogPolicyInstantSchema
  })
  .strict()
export const supportMacroSnapshotSchema = z
  .object({ content: supportMacroContentSchema, review: supportMacroReviewSchema.nullable() })
  .strict()
export const supportMacroReceiptSchema = z
  .object({
    source: z.literal('cloudflare'),
    commandId: catalogPolicyUuidSchema,
    macroId: catalogPolicyUuidSchema,
    version: z.number().int().min(1),
    state: z.enum(['draft', 'approved', 'withdrawn']),
    updated: z.literal(true)
  })
  .strict()
export const supportMacroHistorySchema = z
  .object({
    commandId: catalogPolicyUuidSchema,
    version: z.number().int().min(1),
    state: z.enum(['draft', 'approved', 'withdrawn']),
    actorId: catalogPolicyUuidSchema,
    reason: text(3, 500),
    createdAt: catalogPolicyInstantSchema,
    snapshot: supportMacroSnapshotSchema
  })
  .strict()
export const supportMacroLibrarySchema = z
  .object({
    source: z.literal('cloudflare'),
    macros: z
      .array(
        z
          .object({
            macroId: catalogPolicyUuidSchema,
            version: z.number().int().min(1),
            state: z.enum(['draft', 'approved', 'withdrawn', 'expired']),
            revisionId: catalogPolicyUuidSchema,
            snapshot: supportMacroSnapshotSchema,
            history: z.array(supportMacroHistorySchema).max(100),
            historyTruncated: z.boolean(),
            historyNextBefore: z.number().int().min(2).nullable().default(null)
          })
          .strict()
      )
      .max(50),
    truncated: z.boolean(),
    nextMacroId: catalogPolicyUuidSchema.nullable().default(null)
  })
  .strict()
export const supportMacroPreviewSchema = z
  .object({
    source: z.literal('cloudflare'),
    publicRef: z.string().regex(/^SOP-[0-9A-F]{24}$/),
    ticketVersion: z.number().int().min(1),
    message: text(1, 5000),
    selection: supportMacroSelectionSchema,
    review: supportMacroReviewSchema
  })
  .strict()
export type SupportMacroSelection = z.infer<typeof supportMacroSelectionSchema>
export type SupportMacroLibrary = z.infer<typeof supportMacroLibrarySchema>
export type SupportMacroReceipt = z.infer<typeof supportMacroReceiptSchema>

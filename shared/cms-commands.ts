import { z } from 'zod'
import { contentDocumentSchema, contentBlockSchema } from '../server/utils/content-schema'
import { catalogPolicyOwnJson, catalogPolicyUuidSchema, catalogPolicyInstantSchema } from './catalog-publication-policy'
import { supportKnowledgeMetadataSchema } from './support-knowledge'
import { promotionalMetadataSchema } from './promotional-content'
import { cmsCtaHrefIsSafe } from './cms-safe-links'
import { resourceHubMetadataSchema } from './resource-hub'

export const CMS_DOCUMENT_BYTES = 256 * 1024
export const CMS_BODY_BYTES = CMS_DOCUMENT_BYTES + 4096
const own = (value: unknown) => {
  try {
    return catalogPolicyOwnJson(value)
  } catch {
    return undefined
  }
}
const version = z
  .number()
  .int()
  .min(1)
  .max(Number.MAX_SAFE_INTEGER - 1)
const expectedVersion = version.max(Number.MAX_SAFE_INTEGER - 2)
const reason = z.string().trim().min(3).max(500)
export const cmsIdempotencyKeySchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9._:-]+$/)
export const cmsActionSchema = z.enum(['create_draft', 'update_draft', 'restore_draft', 'archive_draft'])
export type CmsAction = z.infer<typeof cmsActionSchema>
/** Reuse the existing typed CMS, adding canonical link/identity/byte checks at
 * the new own-data boundary. Text remains text; no HTML renderer is introduced. */
const cmsDocumentBaseSchema = contentDocumentSchema.extend({
  supportKnowledge: supportKnowledgeMetadataSchema.optional(),
  promotional: promotionalMetadataSchema.optional(),
  resourceHub: resourceHubMetadataSchema.nullable().optional()
})
export const cmsDocumentSchema = cmsDocumentBaseSchema.superRefine((document, context) => {
  if (document.promotional && document.blocks.length > 10)
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Promotional content block limit exceeded' })
  if (new Set(document.blocks.map((block) => block.id)).size !== document.blocks.length)
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Duplicate block identity' })
  if (document.changeSummary.length < 3)
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'A meaningful change summary is required' })
  for (const block of document.blocks) {
    if (
      !catalogPolicyUuidSchema.safeParse(block.id).success ||
      (block.type === 'image' && !catalogPolicyUuidSchema.safeParse(block.assetId).success)
    )
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Noncanonical block or asset identity' })
    if (block.type !== 'cta') continue
    if (!cmsCtaHrefIsSafe(block.href)) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Unsafe CTA link' })
  }
  if (new TextEncoder().encode(JSON.stringify(document)).byteLength > CMS_DOCUMENT_BYTES)
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Document byte limit exceeded' })
})
const documentShape = cmsDocumentBaseSchema.shape
export const cmsCreateInputSchema = z.preprocess(
  own,
  z
    .object({ ...documentShape, expectedVersion: z.literal(0) })
    .strict()
    .superRefine((value, context) => {
      const { expectedVersion: _expectedVersion, ...document } = value
      const result = cmsDocumentSchema.safeParse(document)
      if (!result.success) result.error.issues.forEach((issue) => context.addIssue(issue))
    })
)
export const cmsUpdateInputSchema = z.preprocess(
  own,
  z
    .object({ ...documentShape, expectedVersion })
    .strict()
    .superRefine((value, context) => {
      const { expectedVersion: _expectedVersion, ...document } = value
      const result = cmsDocumentSchema.safeParse(document)
      if (!result.success) result.error.issues.forEach((issue) => context.addIssue(issue))
    })
)
export const cmsRestoreInputSchema = z.preprocess(
  own,
  z.object({ expectedVersion, versionId: catalogPolicyUuidSchema, reason }).strict()
)
export const cmsArchiveInputSchema = z.preprocess(own, z.object({ expectedVersion, reason }).strict())
export type CmsCreateInput = z.infer<typeof cmsCreateInputSchema>
export type CmsUpdateInput = z.infer<typeof cmsUpdateInputSchema>
export type CmsRestoreInput = z.infer<typeof cmsRestoreInputSchema>
export type CmsArchiveInput = z.infer<typeof cmsArchiveInputSchema>
export const cmsCapabilitiesSchema = z
  .object({
    contentRead: z.literal(true),
    contentCreate: z.boolean(),
    contentUpdate: z.boolean(),
    contentRestore: z.boolean(),
    contentArchive: z.boolean(),
    contentPublish: z.boolean(),
    contentPreview: z.boolean(),
    contentSchedule: z.boolean()
  })
  .strict()
export const cmsPageSchema = z
  .object({
    id: catalogPolicyUuidSchema,
    title: documentShape.title,
    slug: documentShape.slug,
    status: z.enum(['draft', 'hidden']),
    pageVersion: version,
    draftVersion: version,
    draftVersionId: catalogPolicyUuidSchema,
    createdBy: catalogPolicyUuidSchema,
    createdAt: catalogPolicyInstantSchema,
    updatedAt: catalogPolicyInstantSchema,
    archivedAt: catalogPolicyInstantSchema.nullable()
  })
  .strict()
  .superRefine((page, context) => {
    if (
      (page.status === 'hidden') !== (page.archivedAt !== null) ||
      page.updatedAt < page.createdAt ||
      (page.archivedAt !== null && page.archivedAt !== page.updatedAt) ||
      page.draftVersion > page.pageVersion
    )
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Incoherent page state' })
  })
export type CmsPage = z.infer<typeof cmsPageSchema>
export const cmsVersionSchema = z
  .object({
    id: catalogPolicyUuidSchema,
    pageId: catalogPolicyUuidSchema,
    version,
    document: cmsDocumentSchema,
    basedOnId: catalogPolicyUuidSchema.nullable(),
    createdBy: catalogPolicyUuidSchema,
    createdAt: catalogPolicyInstantSchema
  })
  .strict()
export type CmsVersion = z.infer<typeof cmsVersionSchema>
export const cmsPaginationSchema = z
  .object({
    page: z.number().int().min(1).max(1_000_000),
    perPage: z.number().int().min(1).max(100),
    total: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    hasMore: z.boolean()
  })
  .strict()
export const cmsPageListSchema = z.preprocess(
  own,
  z
    .object({
      source: z.literal('cloudflare'),
      capabilities: cmsCapabilitiesSchema,
      pages: z.array(cmsPageSchema).max(100),
      pagination: cmsPaginationSchema
    })
    .strict()
    .superRefine((data, context) => {
      const { page, perPage, total, hasMore } = data.pagination
      if (
        new Set(data.pages.map((item) => item.id)).size !== data.pages.length ||
        new Set(data.pages.map((item) => item.slug)).size !== data.pages.length ||
        data.pages.length !== Math.min(perPage, Math.max(0, total - (page - 1) * perPage)) ||
        hasMore !== page * perPage < total
      )
        context.addIssue({ code: z.ZodIssueCode.custom, message: 'Unconfirmed list pagination' })
    })
)
export type CmsPageList = z.infer<typeof cmsPageListSchema>
export const cmsPageDetailSchema = z.preprocess(
  own,
  z
    .object({
      source: z.literal('cloudflare'),
      capabilities: cmsCapabilitiesSchema,
      page: cmsPageSchema,
      draft: cmsVersionSchema,
      history: z.object({ versions: z.array(cmsVersionSchema).max(10), pagination: cmsPaginationSchema }).strict()
    })
    .strict()
    .superRefine((data, context) => {
      const { page, draft, history } = data,
        { page: index, perPage, total, hasMore } = history.pagination
      if (
        draft.pageId !== page.id ||
        draft.id !== page.draftVersionId ||
        draft.version !== page.draftVersion ||
        draft.document.title !== page.title ||
        draft.document.slug !== page.slug ||
        total !== page.draftVersion ||
        perPage > 10 ||
        history.versions.length !== Math.min(perPage, Math.max(0, total - (index - 1) * perPage)) ||
        hasMore !== index * perPage < total ||
        history.versions.some(
          (item, offset) => item.pageId !== page.id || item.version !== total - (index - 1) * perPage - offset
        ) ||
        new Set(history.versions.map((item) => item.id)).size !== history.versions.length
      )
        context.addIssue({ code: z.ZodIssueCode.custom, message: 'Unconfirmed version history' })
    })
)
export type CmsPageDetail = z.infer<typeof cmsPageDetailSchema>
export const cmsCommandReceiptSchema = z.preprocess(
  own,
  z
    .object({
      source: z.literal('cloudflare'),
      action: cmsActionSchema,
      pageId: catalogPolicyUuidSchema,
      pageVersion: version,
      versionId: catalogPolicyUuidSchema,
      draftVersion: version,
      slug: documentShape.slug,
      status: z.enum(['draft', 'hidden']),
      updated: z.literal(true)
    })
    .strict()
    .refine((value) => (value.action === 'archive_draft') === (value.status === 'hidden'))
)
export type CmsCommandReceipt = z.infer<typeof cmsCommandReceiptSchema>
export { contentBlockSchema }

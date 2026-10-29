import { z } from 'zod'
import { cmsDocumentSchema, contentBlockSchema } from './cms-commands'
import { promotionalMetadataSchema } from './promotional-content'
import { resourceHubMetadataSchema } from './resource-hub'
import {
  catalogPolicyOwnJson,
  catalogPolicyUuidSchema as uuid,
  catalogPolicyInstantSchema as instant
} from './catalog-publication-policy'
const revision = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER - 2)
const reason = z.string().trim().min(3).max(500)
const own = (value: unknown) => {
  try {
    return catalogPolicyOwnJson(value)
  } catch {
    return undefined
  }
}
const common = { expectedRevision: revision, expectedVersion: revision.min(1), reason }
export const cmsPublicationActionSchema = z.enum([
  'publish',
  'withdraw',
  'schedule',
  'cancel_schedule',
  'preview',
  'revoke_preview'
])
export type CmsPublicationAction = z.infer<typeof cmsPublicationActionSchema>
export const cmsPublicationInputSchema = z.preprocess(
  own,
  z.discriminatedUnion('action', [
    z.object({ action: z.literal('publish'), ...common, versionId: uuid }).strict(),
    z.object({ action: z.literal('withdraw'), ...common }).strict(),
    z
      .object({
        action: z.literal('schedule'),
        ...common,
        versionId: uuid,
        publishAtLocal: z.string().nullable(),
        unpublishAtLocal: z.string().nullable(),
        repeatedHour: z.enum(['earlier', 'later']).default('later')
      })
      .strict(),
    z.object({ action: z.literal('cancel_schedule'), ...common }).strict(),
    z
      .object({
        action: z.literal('preview'),
        ...common,
        versionId: uuid,
        segment: z.literal('default').default('default'),
        device: z.enum(['responsive', 'desktop', 'mobile'])
      })
      .strict(),
    z.object({ action: z.literal('revoke_preview'), ...common, previewId: uuid }).strict()
  ])
)
export type CmsPublicationInput = z.infer<typeof cmsPublicationInputSchema>
export const cmsReleaseSchema = z
  .object({ id: uuid, versionId: uuid, slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,159}$/), publishedAt: instant })
  .strict()
export const cmsScheduleSchema = z
  .object({
    id: uuid,
    versionId: uuid,
    publishAt: instant.nullable(),
    unpublishAt: instant.nullable(),
    publishOutcome: z.enum(['applied', 'blocked']).nullable(),
    unpublishOutcome: z.enum(['applied', 'blocked']).nullable(),
    lastError: z.string().nullable()
  })
  .strict()
export const cmsPublicationStateSchema = z.preprocess(
  own,
  z
    .object({
      source: z.literal('cloudflare'),
      pageId: uuid,
      pageVersion: revision.min(1),
      draftVersionId: uuid,
      revision,
      publication: cmsReleaseSchema.nullable(),
      schedule: cmsScheduleSchema.nullable(),
      capabilities: z
        .object({
          publish: z.boolean(),
          withdraw: z.boolean(),
          schedule: z.boolean(),
          preview: z.boolean(),
          revokePreview: z.boolean()
        })
        .strict(),
      previews: z
        .array(
          z
            .object({
              id: uuid,
              versionId: uuid,
              device: z.enum(['responsive', 'desktop', 'mobile']),
              expiresAt: instant,
              revoked: z.boolean()
            })
            .strict()
        )
        .max(20)
    })
    .strict()
)
export type CmsPublicationState = z.infer<typeof cmsPublicationStateSchema>
export const cmsPublicationReceiptSchema = z.preprocess(
  own,
  z
    .object({
      source: z.literal('cloudflare'),
      action: cmsPublicationActionSchema,
      pageId: uuid,
      revision: revision.min(1),
      publicationId: uuid.nullable(),
      scheduleId: uuid.nullable(),
      previewId: uuid.nullable(),
      url: z.string().max(8192).nullable(),
      expiresInSeconds: z.union([z.literal(1800), z.null()]),
      updated: z.literal(true)
    })
    .strict()
    .superRefine((value, ctx) => {
      if (
        (value.action === 'preview') !==
        (value.url !== null && value.previewId !== null && value.expiresInSeconds === 1800)
      )
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Unconfirmed preview receipt' })
    })
)
export type CmsPublicationReceipt = z.infer<typeof cmsPublicationReceiptSchema>
export const cmsPublicPageSchema = z.preprocess(
  own,
  z
    .object({
      source: z.literal('cloudflare'),
      pageId: uuid,
      title: z.string(),
      slug: z.string(),
      status: z.enum(['published', 'preview']),
      blocks: z.array(contentBlockSchema).max(200),
      promotional: promotionalMetadataSchema.optional(),
      resourceHub: resourceHubMetadataSchema.nullable().optional(),
      seo: z.object({ title: z.string(), description: z.string(), noindex: z.boolean() }).strict(),
      version: z.number().int().min(1),
      preview: z.boolean(),
      previewDevice: z.enum(['responsive', 'desktop', 'mobile']).nullable(),
      previewSegment: z.literal('default').nullable(),
      media: z.record(
        uuid,
        z
          .string()
          .max(8192)
          .refine((value) =>
            /^\/api\/content-media\/[0-9a-f-]{36}\/image\?w=(64|128|256|400|640|800|1200|1600)&format=(avif|webp|jpeg)(?:&preview=[A-Za-z0-9%._~*-]+)?$/.test(
              value
            )
          )
      )
    })
    .strict()
    .superRefine((value, ctx) => {
      const document = cmsDocumentSchema.safeParse({
        title: value.title,
        slug: value.slug,
        blocks: value.blocks,
        ...(value.promotional ? { promotional: value.promotional } : {}),
        ...(value.resourceHub ? { resourceHub: value.resourceHub } : {}),
        seo: value.seo,
        changeSummary: 'Published snapshot'
      })
      if (
        !document.success ||
        value.preview !== (value.status === 'preview') ||
        value.preview !== (value.previewDevice !== null && value.previewSegment !== null) ||
        Object.keys(value.media).length !== value.blocks.filter((b) => b.type === 'image').length ||
        value.blocks.some((b) => b.type === 'image' && !value.media[b.id])
      )
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Unconfirmed public content snapshot' })
    })
)
export type CmsPublicPage = z.infer<typeof cmsPublicPageSchema>

import { z } from 'zod'
import { contentBlockSchema } from '../server/utils/content-schema'
import { catalogPolicyUuidSchema, catalogPolicyInstantSchema } from './catalog-publication-policy'
import { cmsCtaHrefIsSafe } from './cms-safe-links'

export const PROMOTIONAL_ITEM_LIMIT = 6
export const PROMOTIONAL_CANDIDATE_LIMIT = 100
const slug = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  .max(160)
const publicPath = z
  .string()
  .max(200)
  .regex(/^\/(?:catalogo|categoria\/[a-z0-9]+(?:-[a-z0-9]+)*|producto\/[a-z0-9]+(?:-[a-z0-9]+)*)?$/)
export const promotionalPlacementSchema = z.enum(['home', 'catalog', 'category', 'product'])
const unique = <T extends z.ZodTypeAny>(item: T, maximum: number) =>
  z
    .array(item)
    .max(maximum)
    .refine((values) => new Set(values).size === values.length, 'Duplicate selector')
export const promotionalMetadataSchema = z
  .object({
    format: z.enum(['banner', 'bar', 'card']),
    placements: unique(promotionalPlacementSchema, 4).refine((values) => values.length > 0, 'Placement required'),
    priority: z.number().int().min(0).max(1000),
    paths: unique(publicPath, 20),
    categorySlugs: unique(slug, 20),
    productSlugs: unique(slug, 20)
  })
  .strict()
export type PromotionalMetadata = z.infer<typeof promotionalMetadataSchema>
export const promotionalContextSchema = z
  .object({
    placement: promotionalPlacementSchema,
    path: publicPath,
    categorySlug: slug.optional(),
    productSlug: slug.optional()
  })
  .strict()
  .superRefine((value, context) => {
    const expectedPath =
      value.placement === 'home'
        ? '/'
        : value.placement === 'catalog'
          ? '/catalogo'
          : value.placement === 'category' && value.categorySlug
            ? `/categoria/${value.categorySlug}`
            : value.placement === 'product' && value.productSlug
              ? `/producto/${value.productSlug}`
              : null
    if (
      value.path !== expectedPath ||
      (value.placement !== 'product' && value.productSlug !== undefined) ||
      (['home', 'catalog'].includes(value.placement) && value.categorySlug !== undefined)
    )
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Unconfirmed public context' })
  })
export type PromotionalContext = z.infer<typeof promotionalContextSchema>
export const promotionalItemSchema = z
  .object({
    pageId: catalogPolicyUuidSchema,
    publicationId: catalogPolicyUuidSchema,
    version: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    title: z.string().trim().min(1).max(160),
    format: promotionalMetadataSchema.shape.format,
    blocks: z.array(contentBlockSchema).min(1).max(10),
    media: z.record(
      catalogPolicyUuidSchema,
      z.string().regex(/^\/api\/content-media\/[0-9a-f-]{36}\/image\?w=1200&format=webp$/)
    )
  })
  .strict()
  .superRefine((item, context) => {
    if (item.blocks.some((block) => block.type === 'cta' && !cmsCtaHrefIsSafe(block.href)))
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Unsafe CTA link' })
    const images = item.blocks.filter((block) => block.type === 'image')
    if (Object.keys(item.media).length !== images.length || images.some((block) => !item.media[block.id]))
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Unconfirmed promotional media' })
  })
export type PromotionalItem = z.infer<typeof promotionalItemSchema>
export const promotionalContentSchema = z
  .object({
    source: z.literal('cloudflare'),
    placement: promotionalPlacementSchema,
    items: z.array(promotionalItemSchema).max(PROMOTIONAL_ITEM_LIMIT),
    evaluatedAt: catalogPolicyInstantSchema
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.items.map((item) => item.pageId)).size !== value.items.length)
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Duplicate promotional page' })
  })
export type PromotionalContent = z.infer<typeof promotionalContentSchema>

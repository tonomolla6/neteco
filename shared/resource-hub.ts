import { z } from 'zod'
import { catalogPolicyInstantSchema as instant } from './catalog-publication-policy'
import { contentBlockSchema } from '../server/utils/content-schema'
const slug = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  .max(160)
const slugs = z
  .array(slug)
  .max(12)
  .refine((value) => new Set(value).size === value.length)
export const resourceHubMetadataSchema = z
  .object({
    kind: z.enum(['article', 'pillar', 'landing']),
    category: z.object({ slug, label: z.string().trim().min(1).max(100) }).strict(),
    author: z
      .object({ name: z.string().trim().min(1).max(120), experience: z.string().trim().min(10).max(1000) })
      .strict(),
    reviewedAt: instant,
    reviewDueAt: instant,
    pillarSlug: slug.nullable(),
    relatedProducts: z
      .array(z.number().int().positive())
      .max(12)
      .refine((value) => new Set(value).size === value.length),
    relatedCategories: slugs,
    relatedResources: slugs
  })
  .strict()
  .refine((value) => value.reviewDueAt > value.reviewedAt, 'Invalid editorial review interval')
export const resourceHubQuerySchema = z
  .object({
    q: z.string().trim().max(80).default(''),
    category: slug.optional(),
    kind: z.enum(['article', 'pillar', 'landing']).optional(),
    page: z.coerce.number().int().min(1).max(10000).default(1),
    perPage: z.coerce.number().int().min(1).max(20).default(20)
  })
  .strict()
export const resourceHubSummarySchema = z
  .object({
    slug,
    title: z.string().min(1).max(160),
    description: z.string().max(180),
    editorial: resourceHubMetadataSchema,
    publishedAt: instant,
    canonicalPath: z.string().regex(/^\/recursos\/[a-z0-9-]+$/),
    noindex: z.boolean()
  })
  .strict()
export const resourceHubListSchema = z
  .object({
    source: z.literal('cloudflare'),
    items: z.array(resourceHubSummarySchema).max(20),
    categories: z.array(z.object({ slug, label: z.string().max(100) }).strict()).max(100),
    page: z.number().int().positive(),
    perPage: z.number().int().min(1).max(20),
    total: z.number().int().nonnegative(),
    pages: z.number().int().nonnegative(),
    noindex: z.boolean(),
    canonicalPath: z.literal('/recursos')
  })
  .strict()
export type ResourceHubMetadata = z.infer<typeof resourceHubMetadataSchema>
export type ResourceHubList = z.infer<typeof resourceHubListSchema>
export const resourceHubDetailSchema = resourceHubSummarySchema
  .extend({
    source: z.literal('cloudflare'),
    version: z.number().int().positive(),
    preview: z.literal(false),
    blocks: z.array(contentBlockSchema).max(80),
    media: z.record(
      z.string().uuid(),
      z
        .string()
        .regex(
          /^\/api\/content-media\/[0-9a-f-]{36}\/image\?w=(64|128|256|400|640|800|1200|1600)&format=(avif|webp|jpeg)$/
        )
    ),
    relatedProducts: z
      .array(z.object({ id: z.number().int().positive(), name: z.string().max(300), slug }).strict())
      .max(12),
    relatedCategories: z.array(z.object({ slug, name: z.string().max(300) }).strict()).max(12),
    relatedResources: z.array(resourceHubSummarySchema).max(13)
  })
  .strict()
export type ResourceHubDetail = z.infer<typeof resourceHubDetailSchema>

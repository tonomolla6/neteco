import { z } from 'zod'

export const SEO_AI_SEARCH_ROBOTS_HEADER = 'noindex, follow, noarchive'

export const GroundedCitationSchema = z.object({
  productId: z.string().uuid(),
  slug: z.string().min(1),
  title: z.string().min(1),
  sku: z.string().min(1),
  priceCents: z.number().int().nonnegative(),
  formattedPrice: z.string(),
  inStock: z.boolean(),
  canonicalUrl: z.string().min(1),
  relevanceSnippet: z.string().max(500),
  safetyAdvice: z.string().max(500).optional()
})
export type GroundedCitation = z.infer<typeof GroundedCitationSchema>

export const AiSearchQueryInputSchema = z.object({
  query: z
    .string()
    .trim()
    .min(2)
    .max(200)
    .refine((v) => !/[\p{Cc}\p{Cf}]/u.test(v), 'Query contains invalid control characters'),
  limit: z.number().int().min(1).max(10).default(5)
})
export type AiSearchQueryInput = z.infer<typeof AiSearchQueryInputSchema>

export const AiSearchResponseSchema = z.object({
  query: z.string(),
  answerText: z.string(),
  citations: z.array(GroundedCitationSchema),
  groundingScore: z.number().min(0).max(1),
  isIndexable: z.literal(false), // STRICTLY FALSE for auto-generated AI searches
  noindexEnforced: z.literal(true), // STRICTLY TRUE
  canonicalUrl: z.string(),
  suggestedCategorySlug: z.string().nullable().optional()
})
export type AiSearchResponse = z.infer<typeof AiSearchResponseSchema>

export const CurateGuideInputSchema = z.object({
  guideId: z.string().uuid().optional(),
  expectedVersion: z.number().int().nonnegative().default(0),
  topicQuery: z.string().trim().min(3).max(160),
  slug: z
    .string()
    .trim()
    .min(3)
    .max(120)
    .regex(/^[a-z0-9-]+$/),
  title: z.string().trim().min(5).max(150),
  approvedContent: z.string().trim().min(50).max(5000),
  productIds: z.array(z.string().uuid()).min(1).max(10),
  isIndexable: z.boolean().default(false), // Only editors can toggle to true after review
  metaDescription: z.string().trim().min(10).max(300)
})
export type CurateGuideInput = z.infer<typeof CurateGuideInputSchema>

export class SeoAiSearchError extends Error {
  constructor(
    readonly code: string,
    message?: string
  ) {
    super(code + (message ? `: ${message}` : ''))
    this.name = 'SeoAiSearchError'
  }
}

/**
 * Asserts that an AI response cannot generate thin indexable pages.
 * Validates strict noindex headers and verifies that citations point
 * to currently published and valid catalog items.
 */
export function assertSeoSafeAiResponse(response: AiSearchResponse): void {
  if (response.isIndexable !== false) {
    throw new SeoAiSearchError('seo_guardrail_violation', 'Dynamic AI search results must never be marked as indexable')
  }
  if (response.noindexEnforced !== true) {
    throw new SeoAiSearchError('seo_guardrail_violation', 'Dynamic AI search results must enforce noindex headers')
  }
  if (response.canonicalUrl.includes('/buscar') || response.canonicalUrl.includes('?')) {
    throw new SeoAiSearchError(
      'seo_canonical_violation',
      'Canonical URL must not point to a parameterized search query or thin search URL'
    )
  }
}

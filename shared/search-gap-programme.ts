import { z } from 'zod'

/** SEO-025: closed loop from zero-result internal queries to measured synonym/content/assortment/redirect actions. */
export const SEARCH_GAP_MIN_SEARCHES = 20 // same k-anonymity floor as MIN_SEARCH_SAMPLE_THRESHOLD in search analytics
export const SEARCH_GAP_BASELINE_DAYS = 28
export const SEARCH_GAP_MEASURE_MIN_DAYS = 7
export const SEARCH_GAP_MIN_IMPROVEMENT = 0.2
export const SEARCH_GAP_WORSE_FACTOR = 1.1

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
const environment = z.enum(['local', 'preview', 'production'])
const term = z
  .string()
  .trim()
  .min(2)
  .max(160)
  .refine((value) => !value.includes('@') && !/[\p{Cc}\p{Cf}]/u.test(value))
const version = z.number().int().min(1).max(1_000_000)
export const searchGapActionTypeSchema = z.enum(['synonym', 'content', 'assortment', 'redirect'])
export type SearchGapActionType = z.infer<typeof searchGapActionTypeSchema>

export const searchGapBacklogQuerySchema = z
  .object({
    environment: environment.default('production'),
    days: z.coerce.number().int().min(1).max(90).default(SEARCH_GAP_BASELINE_DAYS),
    minSearches: z.coerce.number().int().min(SEARCH_GAP_MIN_SEARCHES).max(100000).default(SEARCH_GAP_MIN_SEARCHES),
    limit: z.coerce.number().int().min(1).max(100).default(25)
  })
  .strict()

export const searchGapCommandSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('open'), environment: environment.default('production'), term }).strict(),
  z
    .object({
      action: z.literal('record_action'),
      id: uuid,
      expectedVersion: version,
      actionType: searchGapActionTypeSchema,
      referenceId: z.string().trim().min(1).max(160),
      note: z.string().trim().min(3).max(500).optional()
    })
    .strict(),
  z
    .object({
      action: z.literal('dismiss'),
      id: uuid,
      expectedVersion: version,
      note: z.string().trim().min(3).max(500)
    })
    .strict()
])
export type SearchGapCommand = z.infer<typeof searchGapCommandSchema>

export const searchGapCaseSchema = z
  .object({
    id: uuid,
    environment,
    term: z.string(),
    status: z.enum(['open', 'actioned', 'dismissed']),
    actionType: searchGapActionTypeSchema.nullable(),
    referenceId: z.string().nullable(),
    note: z.string().nullable(),
    baseline: z
      .object({
        from: z.string(),
        to: z.string(),
        searches: z.number().int().nonnegative(),
        zeroResults: z.number().int().nonnegative()
      })
      .strict(),
    actionedAt: z.string().nullable(),
    version: version,
    createdAt: z.string(),
    updatedAt: z.string()
  })
  .strict()
export type SearchGapCase = z.infer<typeof searchGapCaseSchema>

export type SearchGapVerdict = 'not_actioned' | 'insufficient_data' | 'improved' | 'no_change' | 'worse'

/** Pure verdict: compares zero-result rates; refuses to conclude with too little data. */
export function judgeSearchGap(input: {
  actioned: boolean
  baselineSearches: number
  baselineZero: number
  afterSearches: number
  afterZero: number
  afterDays: number
}): SearchGapVerdict {
  if (!input.actioned) return 'not_actioned'
  if (
    input.afterDays < SEARCH_GAP_MEASURE_MIN_DAYS ||
    input.afterSearches < SEARCH_GAP_MIN_SEARCHES ||
    input.baselineSearches < SEARCH_GAP_MIN_SEARCHES
  )
    return 'insufficient_data'
  const before = input.baselineZero / input.baselineSearches,
    after = input.afterZero / input.afterSearches
  if (after <= before * (1 - SEARCH_GAP_MIN_IMPROVEMENT)) return 'improved'
  if (after >= before * SEARCH_GAP_WORSE_FACTOR) return 'worse'
  return 'no_change'
}

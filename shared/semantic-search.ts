import { z } from 'zod'
import { catalogPolicyUuidSchema } from './catalog-publication-policy'
import type { SearchSuggestion } from './types/catalog'

export const HUMAN_EVALUATION_MAX_QUERY_LENGTH = 160
export const HUMAN_EVALUATION_MAX_NOTES_LENGTH = 500

export const humanEvaluationScoreSchema = z.number().int().min(0).max(4)

const saveObjectSchema = z
  .object({
    action: z.literal('save'),
    id: catalogPolicyUuidSchema.nullable(),
    expectedVersion: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    query: z
      .string()
      .trim()
      .min(1)
      .max(HUMAN_EVALUATION_MAX_QUERY_LENGTH)
      .refine((v) => !/[\p{Cc}\p{Cf}]/u.test(v), 'Query contains invalid control characters'),
    productId: catalogPolicyUuidSchema,
    relevanceScore: humanEvaluationScoreSchema,
    notes: z
      .string()
      .trim()
      .max(HUMAN_EVALUATION_MAX_NOTES_LENGTH)
      .refine((v) => !/[\p{Cc}\p{Cf}]/u.test(v), 'Notes contain invalid control characters')
      .nullable()
      .optional()
  })
  .strict()

export const humanEvaluationSaveInputSchema = saveObjectSchema.superRefine((val, ctx) => {
  if ((val.id === null) !== (val.expectedVersion === 0)) {
    ctx.addIssue({ code: 'custom', message: 'Identity and expectedVersion mismatch' })
  }
})

export const humanEvaluationRetireInputSchema = z
  .object({
    action: z.literal('retire'),
    id: catalogPolicyUuidSchema,
    expectedVersion: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    reason: z.string().trim().min(3).max(500).optional()
  })
  .strict()

export const humanEvaluationCommandInputSchema = z
  .discriminatedUnion('action', [saveObjectSchema, humanEvaluationRetireInputSchema])
  .superRefine((val, ctx) => {
    if (val.action === 'save') {
      if ((val.id === null) !== (val.expectedVersion === 0)) {
        ctx.addIssue({ code: 'custom', message: 'Identity and expectedVersion mismatch' })
      }
    }
  })

export type HumanEvaluationCommandInput = z.infer<typeof humanEvaluationCommandInputSchema>

export interface HumanEvaluationItem {
  id: string
  version: number
  queryNormalized: string
  productId: string
  relevanceScore: number
  notes: string | null
  evaluatorId: string
  status: 'active' | 'retired'
  createdAt: string
  updatedAt: string
}

export interface SemanticSearchSuggestion extends SearchSuggestion {
  uuid?: string
  semanticScore?: number
  isSemanticMatch: boolean
  lexicalFallback: boolean
  inStock: boolean
}

export interface EvaluationBenchmarkResult {
  totalQueries: number
  totalJudgments: number
  ndcgAt5: number
  ndcgAt10: number
  precisionAt5: number
  mrr: number
  semanticCoverage: number
}

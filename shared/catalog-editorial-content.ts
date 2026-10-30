import { z } from 'zod'

export const editorialTargetTypeSchema = z.enum(['product', 'category'])
export type EditorialTargetType = z.infer<typeof editorialTargetTypeSchema>

export const editorialArticleStatusSchema = z.enum(['draft', 'in_review', 'approved', 'published', 'archived'])
export type EditorialArticleStatus = z.infer<typeof editorialArticleStatusSchema>

export const surfaceCompatibilitySchema = z.object({
  compatible: z.array(z.string().min(1)).min(1),
  incompatible: z.array(z.string().min(1)).default([])
})
export type SurfaceCompatibility = z.infer<typeof surfaceCompatibilitySchema>

export const safetyAndPpeSchema = z.object({
  requiredPpe: z.array(z.string().min(1)).min(1),
  hazardWarnings: z.array(z.string().min(1)).min(1),
  firstAidMeasures: z.string().optional()
})
export type SafetyAndPpe = z.infer<typeof safetyAndPpeSchema>

export const catalogEditorialArticleSchema = z.object({
  id: z.string().uuid(),
  targetType: editorialTargetTypeSchema,
  targetId: z.string().min(2).max(64),
  title: z.string().min(3).max(200),
  summary: z.string().min(10).max(500),
  bodyMarkdown: z.string().min(20).max(20000),
  applicationScope: z.string().min(3).max(200),
  surfaceCompatibility: surfaceCompatibilitySchema,
  dilutionDosageGuide: z.string().min(5).max(1000),
  safetyAndPpe: safetyAndPpeSchema,
  technicalStandards: z.array(z.string().min(1)).default([]),
  supplierReferenceText: z.string().max(20000).nullable().optional(),
  supplierSimilarityScore: z.number().min(0.0).max(1.0),
  status: editorialArticleStatusSchema,
  authorIdentityId: z.string().uuid(),
  reviewerIdentityId: z.string().uuid().nullable().optional(),
  version: z.number().int().min(1),
  createdAt: z.string(),
  updatedAt: z.string()
})
export type CatalogEditorialArticle = z.infer<typeof catalogEditorialArticleSchema>

export const upsertEditorialArticleInputSchema = z.object({
  targetType: editorialTargetTypeSchema,
  targetId: z.string().min(2).max(64),
  title: z.string().min(3).max(200),
  summary: z.string().min(10).max(500),
  bodyMarkdown: z.string().min(20).max(20000),
  applicationScope: z.string().min(3).max(200),
  surfaceCompatibility: surfaceCompatibilitySchema,
  dilutionDosageGuide: z.string().min(5).max(1000),
  safetyAndPpe: safetyAndPpeSchema,
  technicalStandards: z.array(z.string().min(1)).default([]),
  supplierReferenceText: z.string().max(20000).nullable().optional(),
  expectedVersion: z.number().int().min(0).optional() // 0 for new, >=1 for update
})
export type UpsertEditorialArticleInput = z.infer<typeof upsertEditorialArticleInputSchema>

export const reviewEditorialArticleInputSchema = z.object({
  articleId: z.string().uuid(),
  decision: z.enum(['approved', 'rejected', 'published', 'archived']),
  reviewNotes: z.string().max(500).optional(),
  expectedVersion: z.number().int().min(1)
})
export type ReviewEditorialArticleInput = z.infer<typeof reviewEditorialArticleInputSchema>

/**
 * Tokenize string into lowercase normalized words (ignoring punctuation).
 */
export function tokenizeWords(text: string): Set<string> {
  const matches = text.toLowerCase().match(/\b[\p{L}\p{N}]{3,}\b/gu) || []
  return new Set(matches)
}

/**
 * Computes Jaccard token similarity between editorial body and supplier reference text.
 * Returns score between 0.0 (completely distinct) and 1.0 (identical tokens).
 */
export function calculateSupplierContentSimilarity(
  editorialText: string,
  supplierText: string | null | undefined
): number {
  if (!supplierText || supplierText.trim().length === 0) {
    return 0.0
  }
  const editorialTokens = tokenizeWords(editorialText)
  const supplierTokens = tokenizeWords(supplierText)

  if (editorialTokens.size === 0 || supplierTokens.size === 0) {
    return 0.0
  }

  let intersection = 0
  for (const token of supplierTokens) {
    if (editorialTokens.has(token)) {
      intersection++
    }
  }

  const union = editorialTokens.size + supplierTokens.size - intersection
  return union === 0 ? 0.0 : Math.round((intersection / union) * 1000) / 1000
}

export const MAX_SUPPLIER_SIMILARITY_THRESHOLD = 0.35 // Max 35% token overlap with raw supplier text

export interface EditorialQualityAssessment {
  isValid: boolean
  similarityScore: number
  reasons: string[]
  surpassesSupplier: boolean
}

/**
 * Validates editorial content against professional intent and supplier duplication rules:
 * Acceptance CAT-019: "Texto responde intención profesional y supera contenido de proveedor sin duplicarlo."
 */
export function evaluateEditorialQuality(input: {
  bodyMarkdown: string
  applicationScope: string
  surfaceCompatibility: SurfaceCompatibility
  dilutionDosageGuide: string
  safetyAndPpe: SafetyAndPpe
  supplierReferenceText?: string | null
}): EditorialQualityAssessment {
  const reasons: string[] = []

  // 1. Check professional intent presence
  if (input.surfaceCompatibility.compatible.length === 0) {
    reasons.push('Falta indicar superficies compatibles para el uso profesional.')
  }
  if (!input.dilutionDosageGuide || input.dilutionDosageGuide.trim().length < 5) {
    reasons.push('Falta una guía precisa de dosificación y dilución técnica.')
  }
  if (input.safetyAndPpe.requiredPpe.length === 0) {
    reasons.push('Falta declarar los EPIs requeridos de protección química.')
  }
  if (input.safetyAndPpe.hazardWarnings.length === 0) {
    reasons.push('Faltan advertencias de peligro y precauciones técnicas.')
  }

  // 2. Similarity and Duplication Check against Supplier
  const similarityScore = calculateSupplierContentSimilarity(input.bodyMarkdown, input.supplierReferenceText)
  if (similarityScore > MAX_SUPPLIER_SIMILARITY_THRESHOLD) {
    reasons.push(
      `El contenido editorial duplica el texto del proveedor (similitud ${(similarityScore * 100).toFixed(1)}% > ${MAX_SUPPLIER_SIMILARITY_THRESHOLD * 100}%). Debe redactarse contenido original con valor técnico.`
    )
  }

  // 3. Supera contenido del proveedor (depth, guidance and professional specificity)
  const supplierLength = (input.supplierReferenceText ?? '').trim().length
  const editorialLength = input.bodyMarkdown.trim().length
  let surpassesSupplier = true

  if (supplierLength > 0 && editorialLength < supplierLength) {
    surpassesSupplier = false
    reasons.push('El contenido editorial debe superar en profundidad técnica y detalle la descripción del proveedor.')
  }

  return {
    isValid: reasons.length === 0,
    similarityScore,
    reasons,
    surpassesSupplier
  }
}

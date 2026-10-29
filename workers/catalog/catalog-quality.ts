import { z } from 'zod'
import {
  catalogTypedAttributeDefinitionSchema,
  catalogTypedAttributeValuesSchema,
  validateTypedAttributeValues,
  type CatalogTypedAttributeDefinition
} from '../../shared/catalog-typed-attributes'
import { eligibleMediaEvidenceSql } from '../media/governance'
import { ADMIN_CATALOG_STATUSES, type AdminCatalogStatus } from './admin-catalog'
import { authorizeD1Session, type VerifiedSessionClaims } from './authorization'
import { catalogReadinessIssues, publicationVariantSchema } from './catalog-publication-readiness'
import { sellableExpression } from './inventory'
import { effectiveGrossCentsExpression, parameterizeEffectivePricingSql, resolvePricingInstant } from './pricing'

export const CATALOG_QUALITY_REASON_GROUPS = [
  'mandatory_fields',
  'recommended_fields',
  'typed_attributes',
  'images',
  'documents',
  'review'
] as const

export type CatalogQualityReasonGroup = (typeof CATALOG_QUALITY_REASON_GROUPS)[number]

export type CatalogQualityErrorCode =
  | 'invalid_input'
  | 'unauthenticated'
  | 'email_unverified'
  | 'mfa_required'
  | 'forbidden'
  | 'not_found'
  | 'version_conflict'
  | 'idempotency_conflict'
  | 'service_unavailable'

export class CatalogQualityError extends Error {
  constructor(
    readonly code: CatalogQualityErrorCode,
    readonly status: number,
    message = code
  ) {
    super(message)
  }
}

export interface CatalogQualityPenalty {
  code: string
  group: CatalogQualityReasonGroup
  weight: number
  blocking: boolean
  message: string
}

export interface CatalogQualityMissingSummary {
  mandatoryFields: number
  recommendedFields: number
  typedAttributes: number
  images: number
  documents: number
  reviewIssues: number
}

export interface CatalogQualityReviewState {
  reviewVersion: number
  reviewedCatalogVersion: number
  reviewedScore: number
  penaltyCodes: string[]
  note: string | null
  reviewedBy: string
  reviewedAt: string
  commandId: string
}

export interface CatalogQualityQueueItem {
  productId: number
  productUuid: string
  sku: string | null
  slug: string
  name: string
  status: AdminCatalogStatus
  categoryId: number | null
  categoryName: string
  categorySlug: string
  catalogVersion: number
  score: number
  publishable: boolean
  missingSummary: CatalogQualityMissingSummary
  penalties: CatalogQualityPenalty[]
  review: CatalogQualityReviewState | null
}

export interface CatalogQualityQueueSummary {
  totalEvaluated: number
  matchingTotal: number
  averageScore: number
  unreviewedCount: number
  needsAttentionCount: number
  byGroup: Record<CatalogQualityReasonGroup, number>
}

export interface CatalogQualityQueuePagination {
  page: number
  perPage: number
  total: number
  pages: number
  nextCursor: string | null
}

export interface CatalogQualityQueueResponse {
  source: 'cloudflare'
  evaluatedAt: string
  summary: CatalogQualityQueueSummary
  items: CatalogQualityQueueItem[]
  pagination: CatalogQualityQueuePagination
}

export interface CatalogQualityReviewReceipt {
  source: 'cloudflare'
  commandId: string
  productId: number
  expectedReviewVersion: number
  reviewVersion: number
  reviewedCatalogVersion: number
  score: number
  penaltyCodes: string[]
  note: string | null
  reviewedBy: string
  reviewedAt: string
  payloadHash: string
}

export interface CatalogQualityReviewMutationResult {
  status: 'recorded' | 'replayed'
  review: CatalogQualityReviewReceipt
}

const MAX_QUALITY_PRODUCTS = 2000
const MAX_ANCESTORS = 128
const STALE_REVIEW_MS = 90 * 24 * 60 * 60 * 1000

const positiveIntSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const nonNegativeIntSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)

function hasControlCharacters(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i)
    if (code < 32 || code === 127) return true
  }
  return false
}

export const catalogQualityQueueQuerySchema = z
  .object({
    page: z.number().int().min(1).max(100_000).optional(),
    perPage: z.number().int().min(1).max(100).optional(),
    cursor: z
      .string()
      .trim()
      .min(3)
      .max(200)
      .refine((val) => !hasControlCharacters(val))
      .optional(),
    reason: z
      .string()
      .trim()
      .min(2)
      .max(80)
      .regex(/^[a-z0-9._-]+$/)
      .optional(),
    category: z.union([positiveIntSchema, z.string().trim().min(1).max(120)]).optional(),
    status: z.enum(ADMIN_CATALOG_STATUSES).optional(),
    q: z
      .string()
      .trim()
      .max(120)
      .refine((val) => !hasControlCharacters(val))
      .optional()
  })
  .strict()

export type CatalogQualityQueueQueryInput = z.input<typeof catalogQualityQueueQuerySchema>

export const catalogQualityReviewCommandInputSchema = z
  .object({
    commandId: z
      .string()
      .trim()
      .min(8)
      .max(128)
      .regex(/^[A-Za-z0-9._:-]+$/),
    productId: positiveIntSchema,
    expectedCatalogVersion: positiveIntSchema,
    expectedReviewVersion: nonNegativeIntSchema,
    note: z
      .string()
      .max(500)
      .refine((val) => !hasControlCharacters(val))
      .transform((val) => {
        const trimmed = val.trim()
        return trimmed.length === 0 ? null : trimmed
      })
      .refine((val) => val === null || (val.length >= 3 && val.length <= 500))
      .nullable()
      .optional(),
    now: z.union([z.string(), z.date()]).optional()
  })
  .strict()

export type CatalogQualityReviewCommandInput = z.input<typeof catalogQualityReviewCommandInputSchema>

function fail(code: CatalogQualityErrorCode): never {
  switch (code) {
    case 'invalid_input':
      throw new CatalogQualityError(code, 400)
    case 'unauthenticated':
      throw new CatalogQualityError(code, 401)
    case 'email_unverified':
    case 'mfa_required':
    case 'forbidden':
      throw new CatalogQualityError(code, 403)
    case 'not_found':
      throw new CatalogQualityError(code, 404)
    case 'version_conflict':
    case 'idempotency_conflict':
      throw new CatalogQualityError(code, 409)
    default:
      throw new CatalogQualityError('service_unavailable', 503)
  }
}

function resolveInstantIso(rawNow?: string | Date): string {
  try {
    if (rawNow instanceof Date) {
      if (Number.isNaN(rawNow.getTime())) fail('invalid_input')
      return rawNow.toISOString().replace(/\.\d{3}Z$/, 'Z')
    }
    const resolved = resolvePricingInstant({ instant: rawNow })
    return new Date(resolved).toISOString().replace(/\.\d{3}Z$/, 'Z')
  } catch (err) {
    if (err instanceof CatalogQualityError) throw err
    fail('invalid_input')
  }
}

async function authorizeRead(database: D1Database, claims: VerifiedSessionClaims, nowIso: string): Promise<void> {
  try {
    const reader = await authorizeD1Session(database, claims, 'catalog.read', {
      now: nowIso,
      requireMfa: true
    })
    if (reader.allowed) return
    if (reader.code !== 'forbidden') fail(reader.code)
    const writer = await authorizeD1Session(database, claims, 'catalog.write', {
      now: nowIso,
      requireMfa: true
    })
    if (!writer.allowed) fail(writer.code)
  } catch (err) {
    if (err instanceof CatalogQualityError) throw err
    fail('service_unavailable')
  }
}

async function authorizeWrite(database: D1Database, claims: VerifiedSessionClaims, nowIso: string): Promise<void> {
  try {
    const writer = await authorizeD1Session(database, claims, 'catalog.write', {
      now: nowIso,
      requireMfa: true
    })
    if (!writer.allowed) fail(writer.code)
  } catch (err) {
    if (err instanceof CatalogQualityError) throw err
    fail('service_unavailable')
  }
}

interface RawProductRow {
  uuid: string
  id: number
  slug: string
  name: string
  status: AdminCatalogStatus
  categoryUuid: string
  categoryId: number | null
  categoryName: string
  categorySlug: string
  catalogVersion: number
  shortDescription: string | null
  description: string | null
  usage: string | null
  series: string | null
  brandStatus: string | null
  regulatory: string
  attributesValid: number
  rawTyped: string | null
  reviewVersion: number | null
  reviewedCatalogVersion: number | null
  reviewedScore: number | null
  penaltyCodesJson: string | null
  reviewNote: string | null
  reviewedBy: string | null
  reviewedAt: string | null
  reviewCommandId: string | null
}

interface RawCategoryRow {
  id: string
  legacyId: number | null
  parentId: string | null
  status: string
}

const rawVariantWithProductSchema = publicationVariantSchema.extend({
  productUuid: z.string()
})
type RawVariantWithProduct = z.infer<typeof rawVariantWithProductSchema>

interface RawMediaRow {
  productUuid: string
  mainAlt: string | null
  mainAuthorizedAt: string | null
  hasSds: 0 | 1
  hasDatasheet: 0 | 1
}

interface RawTypedDefRow {
  id: string
  categoryId: number
  categoryUuid: string
  code: string
  label: string
  kind: string
  definitionStatus: string
  currentRevision: number
  revision: number
  status: string
  config: string
  createdAt: string
  updatedAt: string
}

function buildCategoryAncestry(startCategoryUuid: string, categoriesById: Map<string, RawCategoryRow>) {
  const result: Array<{
    id: string
    legacyId: number | null
    parentId: string | null
    status: string
    depth: number
    cycle: number
  }> = []
  const visited = new Set<string>()
  let current = categoriesById.get(startCategoryUuid)
  let depth = 0
  while (current && depth < MAX_ANCESTORS) {
    const cycle = visited.has(current.id) ? 1 : 0
    result.push({
      id: current.id,
      legacyId: current.legacyId,
      parentId: current.parentId,
      status: current.status,
      depth,
      cycle
    })
    if (cycle === 1 || current.parentId === null) break
    visited.add(current.id)
    current = categoriesById.get(current.parentId)
    depth += 1
  }
  return result
}

function evaluateTypedAttributesForProduct(
  product: RawProductRow,
  categoryDefinitions: CatalogTypedAttributeDefinition[],
  activeCategoryDefinitionIds: Set<string>
): {
  typedValid: 0 | 1
  activeTypedDefinitions: number
  populatedTypedDefinitions: number
} {
  const activeCount = activeCategoryDefinitionIds.size
  if (product.attributesValid !== 1) {
    return { typedValid: 0, activeTypedDefinitions: activeCount, populatedTypedDefinitions: 0 }
  }
  if (product.rawTyped === null) {
    return { typedValid: 1, activeTypedDefinitions: activeCount, populatedTypedDefinitions: 0 }
  }
  let parsedRaw: unknown
  try {
    parsedRaw = JSON.parse(product.rawTyped)
  } catch {
    return { typedValid: 0, activeTypedDefinitions: activeCount, populatedTypedDefinitions: 0 }
  }
  if (product.categoryId === null || product.categoryId <= 0) {
    return { typedValid: 0, activeTypedDefinitions: activeCount, populatedTypedDefinitions: 0 }
  }
  const parsedValues = catalogTypedAttributeValuesSchema.safeParse(parsedRaw)
  if (!parsedValues.success) {
    return { typedValid: 0, activeTypedDefinitions: activeCount, populatedTypedDefinitions: 0 }
  }
  const isUuidProductId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(product.uuid)
  const validation = validateTypedAttributeValues(parsedValues.data, categoryDefinitions, {
    categoryId: product.categoryId,
    mode: 'historical',
    ...(isUuidProductId ? { productId: product.uuid } : {})
  })
  if (!validation.success) {
    return { typedValid: 0, activeTypedDefinitions: activeCount, populatedTypedDefinitions: 0 }
  }
  const defsById = new Map(categoryDefinitions.map((d) => [d.id, d]))
  let populated = 0
  for (const entry of validation.data.values) {
    const def = defsById.get(entry.definitionId)
    if (def?.kind === 'reference' && entry.value === product.uuid) {
      return { typedValid: 0, activeTypedDefinitions: activeCount, populatedTypedDefinitions: 0 }
    }
    if (activeCategoryDefinitionIds.has(entry.definitionId)) {
      populated += 1
    }
  }
  return {
    typedValid: 1,
    activeTypedDefinitions: activeCount,
    populatedTypedDefinitions: populated
  }
}

function classifyReadinessPenalty(issue: { code: string; message: string }): CatalogQualityPenalty {
  const { code, message } = issue
  if (code === 'product.typed') {
    return { code, group: 'typed_attributes', weight: 15, blocking: true, message }
  }
  if (code === 'media.primary') {
    return { code, group: 'images', weight: 20, blocking: true, message }
  }
  if (code.startsWith('media.')) {
    return { code, group: 'images', weight: 5, blocking: true, message }
  }
  if (code === 'regulatory.sds') {
    return { code, group: 'documents', weight: 20, blocking: true, message }
  }
  if (code.startsWith('regulatory.')) {
    return { code, group: 'documents', weight: 15, blocking: true, message }
  }
  if (code === 'product.short_description' || code === 'brand.status') {
    return { code, group: 'mandatory_fields', weight: 10, blocking: true, message }
  }
  if (code === 'variant.missing' || code === 'variant.price') {
    return { code, group: 'mandatory_fields', weight: 20, blocking: true, message }
  }
  return { code, group: 'mandatory_fields', weight: 15, blocking: true, message }
}

function evaluateProductQualityItem(
  product: RawProductRow,
  categoriesById: Map<string, RawCategoryRow>,
  variants: RawVariantWithProduct[],
  media: RawMediaRow | undefined,
  categoryDefinitions: CatalogTypedAttributeDefinition[],
  activeCategoryDefinitionIds: Set<string>,
  instantIso: string
): CatalogQualityQueueItem {
  const typedEval = evaluateTypedAttributesForProduct(product, categoryDefinitions, activeCategoryDefinitionIds)
  const ancestry = buildCategoryAncestry(product.categoryUuid, categoriesById)
  const effectiveMedia: RawMediaRow = media ?? {
    productUuid: product.uuid,
    mainAlt: null,
    mainAuthorizedAt: null,
    hasSds: 0,
    hasDatasheet: 0
  }

  const readinessIssues = catalogReadinessIssues(
    {
      uuid: product.uuid,
      id: product.id,
      catalogVersion: product.catalogVersion,
      name: product.name,
      shortDescription: product.shortDescription,
      description: product.description,
      brandStatus: product.brandStatus,
      regulatory: product.regulatory,
      typedValid: typedEval.typedValid
    },
    ancestry,
    variants,
    {
      mainAlt: effectiveMedia.mainAlt,
      mainAuthorizedAt: effectiveMedia.mainAuthorizedAt,
      hasSds: effectiveMedia.hasSds
    },
    instantIso
  )

  const hasMissingPrimaryMedia = readinessIssues.some((issue) => issue.code === 'media.primary')
  const penalties: CatalogQualityPenalty[] = []
  const seenCodes = new Set<string>()

  const pushPenalty = (penalty: CatalogQualityPenalty) => {
    if (seenCodes.has(penalty.code)) return
    seenCodes.add(penalty.code)
    penalties.push(penalty)
  }

  for (const issue of readinessIssues) {
    if (
      hasMissingPrimaryMedia &&
      (issue.code === 'media.alt' ||
        issue.code === 'media.owner' ||
        issue.code === 'media.license' ||
        issue.code === 'media.authorization')
    ) {
      continue
    }
    pushPenalty(classifyReadinessPenalty(issue))
  }

  if ((product.usage?.trim().length ?? 0) < 10) {
    pushPenalty({
      code: 'recommended.usage',
      group: 'recommended_fields',
      weight: 5,
      blocking: false,
      message: 'Falta modo de empleo recomendado (al menos 10 caracteres).'
    })
  }

  if ((product.series?.trim().length ?? 0) < 2) {
    pushPenalty({
      code: 'recommended.series',
      group: 'recommended_fields',
      weight: 5,
      blocking: false,
      message: 'Falta gama o serie editorial del producto.'
    })
  }

  if (
    typedEval.typedValid === 1 &&
    typedEval.activeTypedDefinitions > 0 &&
    typedEval.populatedTypedDefinitions < typedEval.activeTypedDefinitions
  ) {
    pushPenalty({
      code: 'typed.missing',
      group: 'typed_attributes',
      weight: 12,
      blocking: false,
      message: 'Faltan atributos técnicos tipados definidos en la categoría.'
    })
  }

  if (effectiveMedia.hasDatasheet !== 1) {
    pushPenalty({
      code: 'document.datasheet',
      group: 'documents',
      weight: 15,
      blocking: false,
      message: 'Falta ficha técnica aprobada y vigente.'
    })
  }

  let reviewState: CatalogQualityReviewState | null = null
  if (
    product.reviewVersion !== null &&
    product.reviewedCatalogVersion !== null &&
    product.reviewedScore !== null &&
    product.reviewedBy !== null &&
    product.reviewedAt !== null &&
    product.reviewCommandId !== null
  ) {
    let parsedCodes: string[] = []
    try {
      const candidate = JSON.parse(product.penaltyCodesJson ?? '[]')
      if (Array.isArray(candidate) && candidate.every((item) => typeof item === 'string')) {
        parsedCodes = candidate
      }
    } catch {
      parsedCodes = []
    }
    reviewState = {
      reviewVersion: product.reviewVersion,
      reviewedCatalogVersion: product.reviewedCatalogVersion,
      reviewedScore: product.reviewedScore,
      penaltyCodes: parsedCodes,
      note: product.reviewNote,
      reviewedBy: product.reviewedBy,
      reviewedAt: product.reviewedAt,
      commandId: product.reviewCommandId
    }
  }

  if (reviewState === null) {
    pushPenalty({
      code: 'review.missing',
      group: 'review',
      weight: 10,
      blocking: false,
      message: 'El producto nunca ha sido revisado por el equipo de calidad.'
    })
  } else {
    const reviewedTime = Date.parse(reviewState.reviewedAt)
    const nowTime = Date.parse(instantIso)
    if (Number.isFinite(reviewedTime) && nowTime - reviewedTime > STALE_REVIEW_MS) {
      pushPenalty({
        code: 'review.stale',
        group: 'review',
        weight: 10,
        blocking: false,
        message: 'La última revisión de calidad tiene más de 90 días.'
      })
    }
    if (reviewState.reviewedCatalogVersion < product.catalogVersion) {
      pushPenalty({
        code: 'review.outdated',
        group: 'review',
        weight: 8,
        blocking: false,
        message: 'El producto ha sido modificado desde su última revisión de calidad.'
      })
    }
  }

  const totalPenalty = penalties.reduce((sum, item) => sum + item.weight, 0)
  const score = Math.max(0, Math.min(100, 100 - totalPenalty))
  const publishable = penalties.every((item) => !item.blocking)

  const missingSummary: CatalogQualityMissingSummary = {
    mandatoryFields: penalties.filter((p) => p.group === 'mandatory_fields').length,
    recommendedFields: penalties.filter((p) => p.group === 'recommended_fields').length,
    typedAttributes: penalties.filter((p) => p.group === 'typed_attributes').length,
    images: penalties.filter((p) => p.group === 'images').length,
    documents: penalties.filter((p) => p.group === 'documents').length,
    reviewIssues: penalties.filter((p) => p.group === 'review').length
  }

  return {
    productId: product.id,
    productUuid: product.uuid,
    sku: variants[0]?.sku ?? null,
    slug: product.slug,
    name: product.name,
    status: product.status,
    categoryId: product.categoryId,
    categoryName: product.categoryName,
    categorySlug: product.categorySlug,
    catalogVersion: product.catalogVersion,
    score,
    publishable,
    missingSummary,
    penalties,
    review: reviewState
  }
}

export function compareCatalogQualityQueueItems(a: CatalogQualityQueueItem, b: CatalogQualityQueueItem): number {
  if (a.score !== b.score) return a.score - b.score
  const aReviewed = a.review?.reviewedAt ?? null
  const bReviewed = b.review?.reviewedAt ?? null
  if (aReviewed !== bReviewed) {
    if (aReviewed === null) return -1
    if (bReviewed === null) return 1
    return aReviewed < bReviewed ? -1 : 1
  }
  return a.productId - b.productId
}

function encodeQualityCursor(item: CatalogQualityQueueItem): string {
  return `${item.score}:${item.review?.reviewedAt ?? ''}:${item.productId}`
}

function decodeQualityCursor(cursor: string): {
  score: number
  reviewedAt: string | null
  productId: number
} {
  const firstColon = cursor.indexOf(':')
  const lastColon = cursor.lastIndexOf(':')
  if (firstColon <= 0 || lastColon <= firstColon) fail('invalid_input')
  const scoreRaw = cursor.slice(0, firstColon)
  const reviewedAtRaw = cursor.slice(firstColon + 1, lastColon)
  const productIdRaw = cursor.slice(lastColon + 1)
  if (!/^(?:0|[1-9]\d{0,2})$/.test(scoreRaw) || !/^[1-9]\d{0,15}$/.test(productIdRaw)) {
    fail('invalid_input')
  }
  const score = Number(scoreRaw)
  const productId = Number(productIdRaw)
  if (score < 0 || score > 100 || !Number.isSafeInteger(productId)) fail('invalid_input')
  if (reviewedAtRaw !== '' && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(reviewedAtRaw)) {
    fail('invalid_input')
  }
  return {
    score,
    reviewedAt: reviewedAtRaw === '' ? null : reviewedAtRaw,
    productId
  }
}

function extractBatchRows<T>(result: D1Result<unknown> | undefined): T[] {
  if (!result || typeof result !== 'object' || result.success === false) {
    fail('service_unavailable')
  }
  const rows = (result as { results?: unknown }).results
  if (!Array.isArray(rows)) fail('service_unavailable')
  return rows as T[]
}

async function fetchAndEvaluateCatalogQuality(
  database: D1Database,
  instantIso: string,
  filter: {
    productId?: number
    category?: number | string
    status?: AdminCatalogStatus
    q?: string
  }
): Promise<CatalogQualityQueueItem[]> {
  const whereClauses = ['p.legacy_id BETWEEN 1 AND 9007199254740991']
  const filterParams: Array<string | number> = []

  if (filter.productId !== undefined) {
    filterParams.push(filter.productId)
    whereClauses.push(`p.legacy_id = ?${filterParams.length}`)
  }
  if (filter.status !== undefined) {
    filterParams.push(filter.status)
    whereClauses.push(`p.status = ?${filterParams.length}`)
  }
  if (filter.category !== undefined) {
    if (typeof filter.category === 'number') {
      filterParams.push(filter.category)
      whereClauses.push(`c.legacy_id = ?${filterParams.length}`)
    } else {
      const numericCat = /^[1-9]\d{0,14}$/.test(filter.category) ? Number(filter.category) : null
      if (numericCat !== null && Number.isSafeInteger(numericCat)) {
        filterParams.push(numericCat)
        whereClauses.push(`c.legacy_id = ?${filterParams.length}`)
      } else {
        filterParams.push(filter.category)
        whereClauses.push(`c.slug = ?${filterParams.length}`)
      }
    }
  }
  if (filter.q && filter.q.length > 0) {
    const pattern = `%${filter.q.toLowerCase()}%`
    filterParams.push(pattern)
    const pIdx = filterParams.length
    whereClauses.push(
      `(lower(p.name) LIKE ?${pIdx} OR lower(p.slug) LIKE ?${pIdx} OR EXISTS (SELECT 1 FROM variants vq WHERE vq.product_id = p.id AND lower(vq.sku) LIKE ?${pIdx}))`
    )
  }

  const whereSql = whereClauses.join(' AND ')
  const price = parameterizeEffectivePricingSql(effectiveGrossCentsExpression('v'), instantIso)
  const variantFilterOffset = price.instantParameters.length
  const variantWhereSql = whereSql.replace(/\?(\d+)/g, (_, n) => `?${Number(n) + variantFilterOffset}`)
  const mediaWhereSql = whereSql.replace(/\?(\d+)/g, (_, n) => `?${Number(n) + 1}`)

  let batchResults: D1Result<unknown>[]
  try {
    batchResults = await database.batch([
      database
        .prepare(
          `SELECT
             p.id AS uuid,
             p.legacy_id AS id,
             p.slug,
             p.name,
             p.status,
             p.category_id AS categoryUuid,
             c.legacy_id AS categoryId,
             c.name AS categoryName,
             c.slug AS categorySlug,
             p.catalog_version AS catalogVersion,
             p.short_description AS shortDescription,
             p.description,
             p.usage,
             p.series,
             b.status AS brandStatus,
             p.regulatory,
             json_valid(p.attributes) AS attributesValid,
             CASE WHEN json_valid(p.attributes) THEN p.attributes -> '$.typed' ELSE NULL END AS rawTyped,
             qr.review_version AS reviewVersion,
             qr.reviewed_catalog_version AS reviewedCatalogVersion,
             qr.reviewed_score AS reviewedScore,
             qr.penalty_codes_json AS penaltyCodesJson,
             qr.note AS reviewNote,
             qr.reviewed_by AS reviewedBy,
             qr.reviewed_at AS reviewedAt,
             qr.command_id AS reviewCommandId
           FROM products p
           JOIN categories c ON c.id = p.category_id
           LEFT JOIN brands b ON b.id = p.brand_id
           LEFT JOIN catalog_quality_reviews qr ON qr.product_id = p.id
           WHERE ${whereSql}
           ORDER BY p.legacy_id ASC
           LIMIT ${MAX_QUALITY_PRODUCTS}`
        )
        .bind(...filterParams),
      database.prepare(`SELECT id, legacy_id AS legacyId, parent_id AS parentId, status FROM categories`),
      database
        .prepare(
          `WITH scope_locations AS (
             SELECT id FROM inventory_locations WHERE active = 1
             UNION SELECT location_id FROM inventory_balances
             UNION SELECT location_id FROM inventory_movements
             UNION SELECT location_id FROM inventory_reservation_lines
           ), inventory_scope AS (
             SELECT CASE WHEN count(*) = 1 AND sum(CASE WHEN l.active = 1 AND l.kind = 'warehouse' THEN 1 ELSE 0 END) = 1
               THEN 1 ELSE 0 END AS available, min(l.id) AS locationId
             FROM scope_locations scope LEFT JOIN inventory_locations l ON l.id = scope.id
           )
           SELECT
             v.product_id AS productUuid,
             v.legacy_id AS legacyId,
             v.sku,
             v.ean,
             v.gtin,
             v.mpn,
             ${price.sql} AS priceCents,
             v.currency,
             v.unit_base AS unitBase,
             v.unit_label AS unitLabel,
             v.content_quantity AS contentQuantity,
             v.minimum_quantity AS minimumQuantity,
             v.quantity_increment AS quantityIncrement,
             v.maximum_quantity AS maximumQuantity,
             v.weight_grams AS weightGrams,
             v.width_mm AS widthMm,
             v.height_mm AS heightMm,
             v.depth_mm AS depthMm,
             v.backorder_allowed AS backorderAllowed,
             v.lead_time_days AS leadTimeDays,
             tax.rate_basis_points AS taxRate,
             tax.valid_from AS taxFrom,
             tax.valid_until AS taxUntil,
             COALESCE((SELECT ${sellableExpression()} FROM inventory_balances b
               WHERE b.variant_id = v.id AND b.location_id = scope.locationId), 0) AS stock,
             scope.available AS inventoryAvailable
           FROM variants v
           JOIN products p ON p.id = v.product_id
           JOIN categories c ON c.id = p.category_id
           LEFT JOIN tax_classes tax ON tax.id = v.tax_class_id
           CROSS JOIN inventory_scope scope
           WHERE ${variantWhereSql} AND v.status <> 'discontinued'
           ORDER BY v.product_id ASC, v.legacy_id ASC, v.id ASC`
        )
        .bind(...price.instantParameters, ...filterParams),
      database
        .prepare(
          `WITH evidence AS (${eligibleMediaEvidenceSql()}),
           ranked_main AS (
             SELECT e.product_id, e.alt, e.authorized_at,
               ROW_NUMBER() OVER (PARTITION BY e.product_id ORDER BY e.valid_from DESC, e.created_at DESC, e.id DESC) AS rn
             FROM evidence e
             WHERE e.role = 'main' AND e.variant_id IS NULL
           ),
           sds_products AS (
             SELECT DISTINCT e.product_id
             FROM evidence e
             WHERE e.role = 'sds' AND (
               e.variant_id IS NULL OR EXISTS (
                 SELECT 1 FROM variants v WHERE v.id = e.variant_id AND v.product_id = e.product_id AND v.status <> 'discontinued'
               )
             )
           ),
           datasheet_products AS (
             SELECT DISTINCT e.product_id
             FROM evidence e
             WHERE e.role = 'datasheet' AND (
               e.variant_id IS NULL OR EXISTS (
                 SELECT 1 FROM variants v WHERE v.id = e.variant_id AND v.product_id = e.product_id AND v.status <> 'discontinued'
               )
             )
           )
           SELECT
             p.id AS productUuid,
             m.alt AS mainAlt,
             m.authorized_at AS mainAuthorizedAt,
             CASE WHEN s.product_id IS NOT NULL THEN 1 ELSE 0 END AS hasSds,
             CASE WHEN d.product_id IS NOT NULL THEN 1 ELSE 0 END AS hasDatasheet
           FROM products p
           JOIN categories c ON c.id = p.category_id
           LEFT JOIN ranked_main m ON m.product_id = p.id AND m.rn = 1
           LEFT JOIN sds_products s ON s.product_id = p.id
           LEFT JOIN datasheet_products d ON d.product_id = p.id
           WHERE ${mediaWhereSql}`
        )
        .bind(instantIso, ...filterParams),
      database.prepare(
        `SELECT
           d.id,
           c.legacy_id AS categoryId,
           d.category_id AS categoryUuid,
           d.code,
           r.label,
           d.kind,
           d.status AS definitionStatus,
           d.current_revision AS currentRevision,
           r.revision,
           r.status,
           r.config,
           d.created_at AS createdAt,
           d.updated_at AS updatedAt
         FROM catalog_typed_attribute_definitions d
         JOIN categories c ON c.id = d.category_id
         JOIN catalog_typed_attribute_revisions r ON r.definition_id = d.id
         WHERE c.legacy_id BETWEEN 1 AND 9007199254740991`
      )
    ])
  } catch (err) {
    if (err instanceof CatalogQualityError) throw err
    fail('service_unavailable')
  }

  if (!Array.isArray(batchResults) || batchResults.length !== 5) {
    fail('service_unavailable')
  }

  const productRows = extractBatchRows<RawProductRow>(batchResults[0])
  const categoryRows = extractBatchRows<RawCategoryRow>(batchResults[1])
  const variantRowsRaw = extractBatchRows<unknown>(batchResults[2])
  const mediaRows = extractBatchRows<RawMediaRow>(batchResults[3])
  const typedDefRows = extractBatchRows<RawTypedDefRow>(batchResults[4])

  const parsedVariants = z.array(rawVariantWithProductSchema).safeParse(variantRowsRaw)
  if (!parsedVariants.success) fail('service_unavailable')

  const categoriesById = new Map<string, RawCategoryRow>()
  for (const cat of categoryRows) {
    categoriesById.set(cat.id, cat)
  }

  const variantsByProductUuid = new Map<string, RawVariantWithProduct[]>()
  for (const variant of parsedVariants.data) {
    const list = variantsByProductUuid.get(variant.productUuid)
    if (list) list.push(variant)
    else variantsByProductUuid.set(variant.productUuid, [variant])
  }

  const mediaByProductUuid = new Map<string, RawMediaRow>()
  for (const media of mediaRows) {
    mediaByProductUuid.set(media.productUuid, media)
  }

  const definitionsByCategoryUuid = new Map<string, CatalogTypedAttributeDefinition[]>()
  const activeDefinitionIdsByCategoryUuid = new Map<string, Set<string>>()

  for (const rawDef of typedDefRows) {
    let parsedConfig: unknown
    try {
      parsedConfig = JSON.parse(rawDef.config)
    } catch {
      continue
    }
    const parsedDef = catalogTypedAttributeDefinitionSchema.safeParse({
      id: rawDef.id,
      categoryId: rawDef.categoryId,
      categoryUuid: rawDef.categoryUuid,
      code: rawDef.code,
      label: rawDef.label,
      kind: rawDef.kind,
      status: rawDef.status,
      revision: rawDef.revision,
      config: parsedConfig
    })
    if (!parsedDef.success) continue
    const list = definitionsByCategoryUuid.get(rawDef.categoryUuid) ?? []
    list.push(parsedDef.data)
    definitionsByCategoryUuid.set(rawDef.categoryUuid, list)

    if (
      rawDef.definitionStatus === 'active' &&
      rawDef.status === 'active' &&
      rawDef.revision === rawDef.currentRevision
    ) {
      const activeSet = activeDefinitionIdsByCategoryUuid.get(rawDef.categoryUuid) ?? new Set()
      activeSet.add(rawDef.id)
      activeDefinitionIdsByCategoryUuid.set(rawDef.categoryUuid, activeSet)
    }
  }

  return productRows.map((product) =>
    evaluateProductQualityItem(
      product,
      categoriesById,
      variantsByProductUuid.get(product.uuid) ?? [],
      mediaByProductUuid.get(product.uuid),
      definitionsByCategoryUuid.get(product.categoryUuid) ?? [],
      activeDefinitionIdsByCategoryUuid.get(product.categoryUuid) ?? new Set(),
      instantIso
    )
  )
}

export async function listD1CatalogQualityQueue(
  database: D1Database,
  claims: VerifiedSessionClaims,
  rawQuery: CatalogQualityQueueQueryInput = {},
  options: { now?: string | Date } = {}
): Promise<CatalogQualityQueueResponse> {
  const nowIso = resolveInstantIso(options.now)
  const parsedQuery = catalogQualityQueueQuerySchema.safeParse(rawQuery)
  if (!parsedQuery.success) fail('invalid_input')
  const query = parsedQuery.data

  await authorizeRead(database, claims, nowIso)

  const allEvaluated = await fetchAndEvaluateCatalogQuality(database, nowIso, {
    category: query.category,
    status: query.status,
    q: query.q
  })

  const filtered = query.reason
    ? allEvaluated.filter((item) => {
        if (query.reason === 'unreviewed') return item.review === null
        if (query.reason === 'needs_attention') return item.score < 100
        return item.penalties.some((penalty) => penalty.code === query.reason || penalty.group === query.reason)
      })
    : allEvaluated

  filtered.sort(compareCatalogQualityQueueItems)

  const byGroup: Record<CatalogQualityReasonGroup, number> = {
    mandatory_fields: 0,
    recommended_fields: 0,
    typed_attributes: 0,
    images: 0,
    documents: 0,
    review: 0
  }

  let totalScore = 0
  let unreviewedCount = 0
  let needsAttentionCount = 0

  for (const item of allEvaluated) {
    totalScore += item.score
    if (item.review === null) unreviewedCount += 1
    if (item.score < 100 || !item.publishable) needsAttentionCount += 1
    const groupsPresent = new Set(item.penalties.map((p) => p.group))
    for (const grp of groupsPresent) {
      byGroup[grp] += 1
    }
  }

  const perPage = query.perPage ?? 25
  const page = query.page ?? 1
  const total = filtered.length
  const pages = Math.max(1, Math.ceil(total / perPage))

  let pageItems: CatalogQualityQueueItem[]
  if (query.cursor) {
    const cursorObj = decodeQualityCursor(query.cursor)
    const startIdx = filtered.findIndex((item) => {
      if (item.score !== cursorObj.score) return item.score > cursorObj.score
      const itemReviewed = item.review?.reviewedAt ?? null
      if (itemReviewed !== cursorObj.reviewedAt) {
        if (cursorObj.reviewedAt === null) return true
        if (itemReviewed === null) return false
        return itemReviewed > cursorObj.reviewedAt
      }
      return item.productId > cursorObj.productId
    })
    pageItems = startIdx === -1 ? [] : filtered.slice(startIdx, startIdx + perPage)
  } else {
    const offset = (page - 1) * perPage
    pageItems = filtered.slice(offset, offset + perPage)
  }

  const lastItem = pageItems.length === perPage ? pageItems[pageItems.length - 1] : undefined
  const hasMoreAfterLast = lastItem !== undefined && filtered[filtered.length - 1]?.productId !== lastItem.productId

  return {
    source: 'cloudflare',
    evaluatedAt: nowIso,
    summary: {
      totalEvaluated: allEvaluated.length,
      matchingTotal: total,
      averageScore: allEvaluated.length > 0 ? Math.round(totalScore / allEvaluated.length) : 100,
      unreviewedCount,
      needsAttentionCount,
      byGroup
    },
    items: pageItems,
    pagination: {
      page,
      perPage,
      total,
      pages,
      nextCursor: lastItem && hasMoreAfterLast ? encodeQualityCursor(lastItem) : null
    }
  }
}

export async function getD1CatalogProductQuality(
  database: D1Database,
  claims: VerifiedSessionClaims,
  productId: number,
  options: { now?: string | Date } = {}
): Promise<CatalogQualityQueueItem | null> {
  const nowIso = resolveInstantIso(options.now)
  if (!positiveIntSchema.safeParse(productId).success) fail('invalid_input')
  await authorizeRead(database, claims, nowIso)

  const items = await fetchAndEvaluateCatalogQuality(database, nowIso, { productId })
  return items[0] ?? null
}

async function computeReviewPayloadHash(payload: {
  productId: number
  expectedCatalogVersion: number
  expectedReviewVersion: number
  note: string | null
}): Promise<string> {
  const canonical = JSON.stringify({
    productId: payload.productId,
    expectedCatalogVersion: payload.expectedCatalogVersion,
    expectedReviewVersion: payload.expectedReviewVersion,
    note: payload.note
  })
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical))
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

const receiptSchema = z
  .object({
    source: z.literal('cloudflare'),
    commandId: z.string(),
    productId: positiveIntSchema,
    expectedReviewVersion: nonNegativeIntSchema,
    reviewVersion: positiveIntSchema,
    reviewedCatalogVersion: positiveIntSchema,
    score: z.number().int().min(0).max(100),
    penaltyCodes: z.array(z.string()),
    note: z.string().nullable(),
    reviewedBy: z.string(),
    reviewedAt: z.string(),
    payloadHash: z.string().regex(/^[0-9a-f]{64}$/)
  })
  .strict()

export async function getD1CatalogQualityReviewCommand(
  database: D1Database,
  claims: VerifiedSessionClaims,
  productId: number,
  commandId: string,
  options: { now?: string | Date } = {}
): Promise<CatalogQualityReviewMutationResult | null> {
  const nowIso = resolveInstantIso(options.now)
  if (!positiveIntSchema.safeParse(productId).success || !/^[A-Za-z0-9._:-]{8,128}$/.test(commandId)) {
    fail('invalid_input')
  }
  await authorizeWrite(database, claims, nowIso)

  let row: { product_legacy_id: number; receipt_json: string } | null
  try {
    row = await database
      .prepare(
        `SELECT product_legacy_id, receipt_json
         FROM catalog_quality_review_commands
         WHERE actor_id = ?1 AND command_id = ?2`
      )
      .bind(claims.identityId, commandId)
      .first<{ product_legacy_id: number; receipt_json: string }>()
  } catch {
    fail('service_unavailable')
  }

  if (!row) return null
  if (row.product_legacy_id !== productId) fail('idempotency_conflict')

  let parsedReceipt: CatalogQualityReviewReceipt
  try {
    parsedReceipt = receiptSchema.parse(JSON.parse(row.receipt_json))
  } catch {
    fail('service_unavailable')
  }
  return {
    status: 'replayed',
    review: parsedReceipt
  }
}

export async function recordD1CatalogQualityReview(
  database: D1Database,
  claims: VerifiedSessionClaims,
  rawInput: CatalogQualityReviewCommandInput
): Promise<CatalogQualityReviewMutationResult> {
  const parsed = catalogQualityReviewCommandInputSchema.safeParse(rawInput)
  if (!parsed.success) fail('invalid_input')
  const input = parsed.data
  const nowIso = resolveInstantIso(input.now)
  const note = input.note ?? null

  await authorizeWrite(database, claims, nowIso)

  const payloadHash = await computeReviewPayloadHash({
    productId: input.productId,
    expectedCatalogVersion: input.expectedCatalogVersion,
    expectedReviewVersion: input.expectedReviewVersion,
    note
  })

  // Check existing command for idempotent replay or conflict before mutating
  let existingCommand: {
    product_legacy_id: number
    payload_hash: string
    receipt_json: string
  } | null
  try {
    existingCommand = await database
      .prepare(
        `SELECT product_legacy_id, payload_hash, receipt_json
         FROM catalog_quality_review_commands
         WHERE actor_id = ?1 AND command_id = ?2`
      )
      .bind(claims.identityId, input.commandId)
      .first<{
        product_legacy_id: number
        payload_hash: string
        receipt_json: string
      }>()
  } catch {
    fail('service_unavailable')
  }

  if (existingCommand) {
    if (existingCommand.product_legacy_id !== input.productId || existingCommand.payload_hash !== payloadHash) {
      fail('idempotency_conflict')
    }
    try {
      const receipt = receiptSchema.parse(JSON.parse(existingCommand.receipt_json))
      return { status: 'replayed', review: receipt }
    } catch {
      fail('service_unavailable')
    }
  }

  const productItems = await fetchAndEvaluateCatalogQuality(database, nowIso, {
    productId: input.productId
  })
  const currentItem = productItems[0]
  if (!currentItem) fail('not_found')

  const currentReviewVersion = currentItem.review?.reviewVersion ?? 0
  if (
    currentItem.catalogVersion !== input.expectedCatalogVersion ||
    currentReviewVersion !== input.expectedReviewVersion
  ) {
    fail('version_conflict')
  }

  const resultReviewVersion = input.expectedReviewVersion + 1
  const postReviewPenalties = currentItem.penalties.filter((p) => p.group !== 'review')
  const postReviewScore = Math.max(
    0,
    Math.min(100, 100 - postReviewPenalties.reduce((sum, penalty) => sum + penalty.weight, 0))
  )
  const penaltyCodes = postReviewPenalties.map((p) => p.code)
  const penaltyCodesJson = JSON.stringify(penaltyCodes)

  const receipt: CatalogQualityReviewReceipt = {
    source: 'cloudflare',
    commandId: input.commandId,
    productId: input.productId,
    expectedReviewVersion: input.expectedReviewVersion,
    reviewVersion: resultReviewVersion,
    reviewedCatalogVersion: input.expectedCatalogVersion,
    score: postReviewScore,
    penaltyCodes,
    note,
    reviewedBy: claims.identityId,
    reviewedAt: nowIso,
    payloadHash
  }

  const inputJson = JSON.stringify({
    expectedCatalogVersion: input.expectedCatalogVersion,
    expectedReviewVersion: input.expectedReviewVersion,
    note
  })
  const receiptJson = JSON.stringify(receipt)
  const auditId = crypto.randomUUID()
  const guardId = crypto.randomUUID()

  try {
    await database.batch([
      database
        .prepare(
          `INSERT INTO catalog_quality_review_commands (
             actor_id, command_id, product_id, product_legacy_id,
             expected_catalog_version, expected_review_version, result_review_version,
             score, penalty_codes_json, note, input_json, payload_hash, receipt_json, recorded_at
           ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)`
        )
        .bind(
          claims.identityId,
          input.commandId,
          currentItem.productUuid,
          input.productId,
          input.expectedCatalogVersion,
          input.expectedReviewVersion,
          resultReviewVersion,
          postReviewScore,
          penaltyCodesJson,
          note,
          inputJson,
          payloadHash,
          receiptJson,
          nowIso
        ),
      input.expectedReviewVersion === 0
        ? database
            .prepare(
              `INSERT INTO catalog_quality_reviews (
                 product_id, product_legacy_id, review_version, reviewed_catalog_version,
                 reviewed_score, penalty_codes_json, note, reviewed_by, reviewed_at, command_id
               ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`
            )
            .bind(
              currentItem.productUuid,
              input.productId,
              resultReviewVersion,
              input.expectedCatalogVersion,
              postReviewScore,
              penaltyCodesJson,
              note,
              claims.identityId,
              nowIso,
              input.commandId
            )
        : database
            .prepare(
              `UPDATE catalog_quality_reviews
               SET review_version = ?3,
                   reviewed_catalog_version = ?4,
                   reviewed_score = ?5,
                   penalty_codes_json = ?6,
                   note = ?7,
                   reviewed_by = ?8,
                   reviewed_at = ?9,
                   command_id = ?10
               WHERE product_id = ?1 AND product_legacy_id = ?2 AND review_version = ?11`
            )
            .bind(
              currentItem.productUuid,
              input.productId,
              resultReviewVersion,
              input.expectedCatalogVersion,
              postReviewScore,
              penaltyCodesJson,
              note,
              claims.identityId,
              nowIso,
              input.commandId,
              input.expectedReviewVersion
            ),
      database
        .prepare(
          `INSERT INTO catalog_quality_review_audit (
             id, product_id, product_legacy_id, review_version, reviewed_catalog_version,
             reviewed_score, penalty_codes_json, note, actor_id, command_id, payload_hash, recorded_at
           ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`
        )
        .bind(
          auditId,
          currentItem.productUuid,
          input.productId,
          resultReviewVersion,
          input.expectedCatalogVersion,
          postReviewScore,
          penaltyCodesJson,
          note,
          claims.identityId,
          input.commandId,
          payloadHash,
          nowIso
        ),
      database
        .prepare(
          `INSERT INTO catalog_quality_review_guards (id, valid)
           SELECT ?1,
             CASE WHEN EXISTS (
               SELECT 1 FROM auth_sessions s
               JOIN identities i ON i.id = s.identity_id
               WHERE s.id = ?2 AND i.id = ?3 AND s.session_version = ?4
                 AND i.session_version = s.session_version AND s.revoked_at IS NULL
                 AND s.created_at <= ?5 AND s.expires_at > ?5
                 AND i.status IN ('pending', 'active')
                 AND i.email_verified_at IS NOT NULL AND i.email_verified_at <= ?5
                 AND s.mfa_verified = 1
                 AND EXISTS (
                   SELECT 1 FROM identity_roles ir
                   JOIN role_permissions rp ON rp.role_code = ir.role_code
                   WHERE ir.identity_id = i.id AND rp.permission_code = 'catalog.write'
                     AND ir.granted_at <= ?5 AND (ir.expires_at IS NULL OR ir.expires_at > ?5)
                 )
             )
             AND EXISTS (
               SELECT 1 FROM products p
               WHERE p.id = ?6 AND p.legacy_id = ?7 AND p.catalog_version = ?8
             )
             AND EXISTS (
               SELECT 1 FROM catalog_quality_reviews qr
               WHERE qr.product_id = ?6 AND qr.review_version = ?9 AND qr.command_id = ?10
             )
             AND EXISTS (
               SELECT 1 FROM catalog_quality_review_audit qa
               WHERE qa.id = ?11 AND qa.product_id = ?6 AND qa.review_version = ?9
             )
             THEN 1 ELSE 0 END`
        )
        .bind(
          guardId,
          claims.sessionId,
          claims.identityId,
          claims.sessionVersion,
          nowIso,
          currentItem.productUuid,
          input.productId,
          input.expectedCatalogVersion,
          resultReviewVersion,
          input.commandId,
          auditId
        ),
      database.prepare(`DELETE FROM catalog_quality_review_guards WHERE id = ?1`).bind(guardId)
    ])
  } catch (err) {
    const msg = err instanceof Error ? err.message : ''
    if (
      msg.includes('catalog_quality_review_command_invalid') ||
      msg.includes('catalog_quality_review_head_invalid') ||
      msg.includes('UNIQUE constraint failed: catalog_quality_review_commands.product_id')
    ) {
      fail('version_conflict')
    }
    fail('service_unavailable')
  }

  await authorizeWrite(database, claims, nowIso)

  return {
    status: 'recorded',
    review: receipt
  }
}

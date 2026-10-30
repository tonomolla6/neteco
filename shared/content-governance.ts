import { z } from 'zod'

/**
 * SEO-029 (content review calendar + retirement/redirect plan), SEO-030 (linkable assets with transparent
 * methodology) and SEO-031 (authorship, technical review and evidence for sensitive claims).
 * Author credentials, owners and sources are ALWAYS admin-entered data; nothing here fabricates them.
 * Schemas never read the clock: "now" is supplied by the server-side callers.
 */
const DAY = 86_400_000
export const isDay = (value: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString().slice(0, 10) === value
const day = z.string().refine(isDay, 'invalid_date')
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
const slug = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  .max(160)
const version = z.number().int().min(0).max(1_000_000)
const text = (min: number, max: number) =>
  z
    .string()
    .trim()
    .min(min)
    .max(max)
    .refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value.replace(/[\n\t]/g, '')), 'control_characters')

export function safeRedirectPath(value: string) {
  if (!/^\/[A-Za-z0-9\-._~/]*$/.test(value) || value.startsWith('//') || value.length > 200) return false
  return !value.split('/').some((segment) => segment === '..' || segment === '.')
}
const redirectPath = z.string().refine(safeRedirectPath, 'unsafe_redirect')

export const SENSITIVITIES = ['regulation', 'product', 'general'] as const
export const CLAIM_CATEGORIES = ['chemical', 'health', 'commercial'] as const
export const SOURCE_KINDS = ['regulation', 'safety_data_sheet', 'standard', 'study', 'manufacturer', 'other'] as const
export const ASSET_KINDS = ['calculator', 'comparison', 'guide', 'checklist', 'study'] as const

export const sourceSchema = z
  .object({
    label: text(3, 200),
    url: z
      .string()
      .max(500)
      .refine((value) => {
        try {
          const url = new URL(value)
          return url.protocol === 'https:' && !url.username && !url.password && url.hostname.includes('.')
        } catch {
          return false
        }
      }, 'invalid_source_url'),
    kind: z.enum(SOURCE_KINDS)
  })
  .strict()
export const claimSchema = z
  .object({
    text: text(10, 300),
    category: z.enum(CLAIM_CATEGORIES),
    sourceIndex: z.number().int().min(0).max(19).nullable()
  })
  .strict()
export type GovernanceSource = z.infer<typeof sourceSchema>
export type GovernanceClaim = z.infer<typeof claimSchema>

const retirementSchema = z.object({ retireAt: day, redirectTo: redirectPath.nullable() }).strict()

const authorCommand = z
  .object({
    action: z.literal('save_author'),
    id: uuid.optional(),
    expectedVersion: version,
    displayName: text(3, 120),
    bio: text(20, 1000),
    experience: text(20, 1000),
    credentials: text(3, 500).optional(),
    status: z.enum(['active', 'archived']).default('active')
  })
  .strict()
const governanceCommand = z
  .object({
    action: z.literal('save_governance'),
    slug,
    expectedVersion: version,
    ownerName: text(2, 120),
    sensitivity: z.enum(SENSITIVITIES),
    nextReviewAt: day,
    authorId: uuid.nullable(),
    reviewerId: uuid.nullable(),
    sources: z.array(sourceSchema).max(20),
    claims: z.array(claimSchema).max(40),
    retirement: retirementSchema.nullable()
  })
  .strict()
  .superRefine((value, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: 'custom', message })
    if (value.authorId && value.authorId === value.reviewerId) issue('author_is_reviewer')
    if (new Set(value.sources.map((source) => source.url)).size !== value.sources.length) issue('duplicate_source')
    if (value.claims.some((claim) => claim.sourceIndex !== null && claim.sourceIndex >= value.sources.length))
      issue('claim_source_out_of_range')
    if (value.retirement && value.retirement.redirectTo === `/recursos/${value.slug}`) issue('redirect_to_self')
  })
const signOffCommand = z
  .object({ action: z.literal('sign_off'), slug, expectedVersion: z.number().int().min(1).max(1_000_000) })
  .strict()

const checklistPayload = z.object({ items: z.array(text(2, 300)).min(1).max(30) }).strict()
const guidePayload = z
  .object({
    sections: z
      .array(z.object({ heading: text(2, 120), body: text(2, 2000) }).strict())
      .min(1)
      .max(20)
  })
  .strict()
const comparisonPayload = z
  .object({
    columns: z.array(text(1, 80)).min(2).max(6),
    rows: z
      .array(z.object({ label: text(1, 120), values: z.array(text(1, 160)).min(2).max(6) }).strict())
      .min(1)
      .max(20)
  })
  .strict()
  .refine((value) => value.rows.every((row) => row.values.length === value.columns.length), 'row_width')
const studyPayload = z
  .object({
    sampleSize: z.number().int().min(1).max(10_000_000),
    dataset: z
      .array(
        z.object({ label: text(1, 120), value: z.number().finite().min(-1e9).max(1e9), unit: text(1, 20) }).strict()
      )
      .min(1)
      .max(30)
  })
  .strict()
const calculatorPayload = z
  .object({
    type: z.literal('dilution'),
    presets: z
      .array(
        z
          .object({
            use: text(2, 120),
            concentrateParts: z.number().int().min(1).max(1000),
            waterParts: z.number().int().min(1).max(1000)
          })
          .strict()
      )
      .min(1)
      .max(12)
  })
  .strict()
const PAYLOADS = {
  checklist: checklistPayload,
  guide: guidePayload,
  comparison: comparisonPayload,
  study: studyPayload,
  calculator: calculatorPayload
} as const
const assetBase = {
  expectedVersion: version,
  slug,
  title: text(3, 160),
  summary: text(10, 300),
  methodology: text(30, 2000),
  dataAsOf: day
}
const assetCommand = z
  .object({ action: z.literal('save_asset'), ...assetBase, kind: z.enum(ASSET_KINDS), payload: z.unknown() })
  .strict()
  .superRefine((value, ctx) => {
    if (!PAYLOADS[value.kind].safeParse(value.payload).success)
      ctx.addIssue({ code: 'custom', message: 'invalid_payload', path: ['payload'] })
  })
const assetTransition = (action: 'publish_asset' | 'retire_asset') =>
  z.object({ action: z.literal(action), slug, expectedVersion: z.number().int().min(1).max(1_000_000) }).strict()

export const assetCommandSchema = assetCommand
export const authorCommandSchema = authorCommand
export const contentGovernanceCommandSchema = z.union([
  authorCommand,
  governanceCommand,
  signOffCommand,
  assetCommand,
  assetTransition('publish_asset'),
  assetTransition('retire_asset')
])
export type ContentGovernanceCommand = z.infer<typeof contentGovernanceCommandSchema>
export type AssetKind = (typeof ASSET_KINDS)[number]
export function parseAssetPayload(kind: AssetKind, payload: unknown) {
  const parsed = PAYLOADS[kind].safeParse(payload)
  return parsed.success ? (parsed.data as Record<string, unknown>) : null
}

export function computeDilution(input: { totalMl: number; concentrateParts: number; waterParts: number }) {
  const { totalMl, concentrateParts, waterParts } = input
  if (![totalMl, concentrateParts, waterParts].every(Number.isFinite)) return null
  if (totalMl <= 0 || totalMl > 1_000_000 || concentrateParts <= 0 || waterParts <= 0) return null
  const round = (value: number) => Math.round(value * 10) / 10
  const total = concentrateParts + waterParts
  return {
    concentrateMl: round((totalMl * concentrateParts) / total),
    waterMl: round((totalMl * waterParts) / total)
  }
}

export type TrustIssue =
  | 'no_author'
  | 'no_reviewer'
  | 'author_archived'
  | 'reviewer_archived'
  | 'not_signed_off'
  | 'no_sources'
  | 'claim_without_evidence'
  | 'review_overdue'
export interface TrustInput {
  ownerName: string
  sensitivity: (typeof SENSITIVITIES)[number]
  nextReviewAt: string
  hasAuthor: boolean
  hasReviewer: boolean
  authorStatus: 'active' | 'archived' | null
  reviewerStatus: 'active' | 'archived' | null
  signedOffAt: string | null
  sourceCount: number
  claims: GovernanceClaim[]
}
export function evaluateTrust(input: TrustInput, now: string) {
  const issues: TrustIssue[] = []
  if (!input.hasAuthor) issues.push('no_author')
  else if (input.authorStatus === 'archived') issues.push('author_archived')
  if (!input.hasReviewer) issues.push('no_reviewer')
  else if (input.reviewerStatus === 'archived') issues.push('reviewer_archived')
  if (!input.signedOffAt) issues.push('not_signed_off')
  if ((input.claims.length > 0 || input.sensitivity !== 'general') && input.sourceCount === 0) issues.push('no_sources')
  if (input.claims.some((claim) => claim.sourceIndex === null || claim.sourceIndex >= input.sourceCount))
    issues.push('claim_without_evidence')
  if (input.nextReviewAt <= now.slice(0, 10)) issues.push('review_overdue')
  const state = issues.includes('review_overdue') ? 'overdue' : issues.length ? 'incomplete' : 'verified'
  return { state: state as 'verified' | 'incomplete' | 'overdue', issues }
}

export function reviewBucket(nextReviewAt: string, now: string) {
  const today = now.slice(0, 10)
  if (nextReviewAt <= today) return 'overdue' as const
  const days = Math.round((Date.parse(nextReviewAt) - Date.parse(today)) / DAY)
  return days <= 30 ? ('due_30' as const) : ('scheduled' as const)
}

export interface TrustPerson {
  name: string
  experience: string
  credentials: string | null
}
export function buildTrustJsonLd(input: {
  url: string
  headline: string
  dateModified: string
  author: TrustPerson
  reviewer: TrustPerson
  sources: Array<{ label: string; url: string }>
}) {
  const person = (value: TrustPerson) => ({
    '@type': 'Person' as const,
    name: value.name,
    description: value.experience,
    ...(value.credentials ? { hasCredential: value.credentials } : {})
  })
  return {
    '@context': 'https://schema.org',
    '@type': 'Article' as const,
    url: input.url,
    headline: input.headline,
    dateModified: input.dateModified,
    author: person(input.author),
    reviewedBy: person(input.reviewer),
    citation: input.sources.map((source) => ({ '@type': 'CreativeWork' as const, name: source.label, url: source.url }))
  }
}
/** Safe to embed inside <script type="application/ld+json">. */
export const serializeJsonLd = (value: unknown) =>
  JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')

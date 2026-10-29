import { z } from 'zod'

export const SEO_ISSUE_TYPES = [
  'http_4xx',
  'http_5xx',
  'canonical_mismatch',
  'canonical_missing',
  'canonical_loop',
  'accidental_noindex',
  'missing_schema',
  'invalid_schema',
  'orphan_page',
  'excessive_depth',
  'status_regression',
  'accidental_canonical_change',
  'accidental_title_change'
] as const

export type SeoIssueType = (typeof SEO_ISSUE_TYPES)[number]

export const SEO_ISSUE_SEVERITIES = ['critical', 'warning', 'info'] as const
export type SeoIssueSeverity = (typeof SEO_ISSUE_SEVERITIES)[number]

export const CRAWL_RUN_STATUSES = ['pending', 'running', 'completed', 'failed'] as const
export type CrawlRunStatus = (typeof CRAWL_RUN_STATUSES)[number]

export const CRAWL_TRIGGER_TYPES = ['scheduled', 'manual', 'ci'] as const
export type CrawlTriggerType = (typeof CRAWL_TRIGGER_TYPES)[number]

export const CANONICAL_STATUSES = ['self', 'cross_domain', 'mismatch', 'missing', 'relative', 'invalid'] as const
export type CanonicalStatus = (typeof CANONICAL_STATUSES)[number]

export const SeoIssueSchema = z.object({
  id: z.string().uuid(),
  runId: z.string().uuid(),
  url: z.string().min(1).max(1000),
  issueType: z.enum(SEO_ISSUE_TYPES),
  severity: z.enum(SEO_ISSUE_SEVERITIES),
  details: z.record(z.string(), z.unknown()),
  createdAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
})
export type SeoIssue = z.infer<typeof SeoIssueSchema>

export const CrawlPageResultSchema = z.object({
  id: z.string().uuid(),
  runId: z.string().uuid(),
  url: z.string().min(1).max(1000),
  statusCode: z.number().int().min(0).max(599),
  depth: z.number().int().min(-1).max(50), // -1 indicates orphan not reached by crawl
  parentUrl: z.string().max(1000).nullable(),
  canonicalUrl: z.string().max(1000).nullable(),
  canonicalStatus: z.enum(CANONICAL_STATUSES),
  hasNoindex: z.boolean(),
  isOrphan: z.boolean(),
  schemaTypes: z.array(z.string()),
  title: z.string().nullable(),
  metaDescription: z.string().nullable(),
  h1: z.string().nullable(),
  inlinksCount: z.number().int().nonnegative(),
  outlinksCount: z.number().int().nonnegative(),
  crawledAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
})
export type CrawlPageResult = z.infer<typeof CrawlPageResultSchema>

export const CrawlRunRecordSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(CRAWL_RUN_STATUSES),
  triggerType: z.enum(CRAWL_TRIGGER_TYPES),
  totalUrlsScanned: z.number().int().nonnegative(),
  status2xxCount: z.number().int().nonnegative(),
  status4xxCount: z.number().int().nonnegative(),
  status5xxCount: z.number().int().nonnegative(),
  canonicalIssuesCount: z.number().int().nonnegative(),
  noindexCount: z.number().int().nonnegative(),
  missingSchemaCount: z.number().int().nonnegative(),
  orphanCount: z.number().int().nonnegative(),
  maxDepthReached: z.number().int().nonnegative(),
  accidentalChangesCount: z.number().int().nonnegative(),
  baselineRunId: z.string().uuid().nullable().optional(),
  startedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/),
  completedAt: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
    .nullable()
    .optional(),
  createdAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
})
export type CrawlRunRecord = z.infer<typeof CrawlRunRecordSchema>

export const TriggerCrawlInputSchema = z.object({
  triggerType: z.enum(CRAWL_TRIGGER_TYPES).default('manual'),
  seedUrls: z.array(z.string().min(1)).min(1).max(50).default(['/']),
  maxDepth: z.number().int().min(0).max(10).default(5),
  maxPages: z.number().int().min(1).max(500).default(100),
  baselineRunId: z.string().uuid().optional(),
  knownCatalogUrls: z.array(z.string()).optional()
})
export type TriggerCrawlInput = z.infer<typeof TriggerCrawlInputSchema>

export interface CrawlComparisonDiff {
  url: string
  issueType: SeoIssueType
  severity: SeoIssueSeverity
  previous: Record<string, unknown>
  current: Record<string, unknown>
  message: string
}

export class SeoCrawlerError extends Error {
  constructor(
    readonly code: string,
    message?: string
  ) {
    super(message ?? code)
    this.name = 'SeoCrawlerError'
  }
}

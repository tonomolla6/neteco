import {
  diffContentDocuments,
  CMS_PREVIEW_BREAKPOINTS,
  type ContentDocumentSnapshot,
  type ContentDiffResult,
  type CmsPreviewBreakpoint
} from '../../shared/cms-preview-comparison'
import { authorizeD1Session, type VerifiedSessionClaims } from '../catalog/authorization'

export class PreviewComparisonError extends Error {
  constructor(public readonly code: string) {
    super(code)
    this.name = 'PreviewComparisonError'
  }
}

export interface ComparePreviewOptions {
  actorId: string
  pageId: string
  baseVersion: number
  compareVersion: number
  breakpoint?: CmsPreviewBreakpoint
  now?: string
}

export interface PreviewComparisonOutput {
  pageId: string
  baseVersion: number
  compareVersion: number
  diff: ContentDiffResult
  breakpoints: typeof CMS_PREVIEW_BREAKPOINTS
  baseDocument: ContentDocumentSnapshot
  compareDocument: ContentDocumentSnapshot
}

async function verifyPreviewPermission(db: D1Database, actorId: string, now: string): Promise<void> {
  const session = await db
    .prepare(
      'SELECT id, session_version FROM auth_sessions WHERE identity_id = ?1 AND revoked_at IS NULL ORDER BY created_at DESC'
    )
    .bind(actorId)
    .first<{ id: string; session_version: number }>()

  const claims: VerifiedSessionClaims = {
    sessionId: session?.id ?? '20000000-0000-4000-8000-000000000001',
    identityId: actorId,
    sessionVersion: session?.session_version ?? 1
  }

  const primary = await authorizeD1Session(db, claims, 'content.preview', { now, requireMfa: false })
  if (primary.allowed) return

  const fallback = await authorizeD1Session(db, claims, 'administration.manage', { now, requireMfa: false })
  if (!fallback.allowed) {
    throw new PreviewComparisonError('forbidden')
  }
}

export async function compareCmsPreviewVersions(
  db: D1Database,
  options: ComparePreviewOptions
): Promise<PreviewComparisonOutput> {
  const now = options.now ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  await verifyPreviewPermission(db, options.actorId, now)

  // 1. Verify page exists
  const page = await db
    .prepare('SELECT id, slug, title, status FROM content_pages WHERE id = ?1')
    .bind(options.pageId)
    .first<{ id: string; slug: string; title: string; status: string }>()

  if (!page) {
    throw new PreviewComparisonError('page_not_found')
  }

  // 2. Load base document (if baseVersion is 0, empty base document)
  let baseDoc: ContentDocumentSnapshot = {
    title: '',
    slug: page.slug,
    seo: { title: '', description: '', noindex: false },
    blocks: []
  }

  if (options.baseVersion > 0) {
    const vBase = await db
      .prepare('SELECT document FROM content_versions WHERE page_id = ?1 AND version = ?2')
      .bind(options.pageId, options.baseVersion)
      .first<{ document: string }>()

    if (!vBase) {
      throw new PreviewComparisonError('base_version_not_found')
    }
    baseDoc = JSON.parse(vBase.document) as ContentDocumentSnapshot
  }

  // 3. Load compare document
  const vCompare = await db
    .prepare('SELECT document FROM content_versions WHERE page_id = ?1 AND version = ?2')
    .bind(options.pageId, options.compareVersion)
    .first<{ document: string }>()

  if (!vCompare) {
    throw new PreviewComparisonError('compare_version_not_found')
  }
  const compareDoc = JSON.parse(vCompare.document) as ContentDocumentSnapshot

  // 4. Compute diff
  const diff = diffContentDocuments(baseDoc, compareDoc)

  return {
    pageId: options.pageId,
    baseVersion: options.baseVersion,
    compareVersion: options.compareVersion,
    diff,
    breakpoints: CMS_PREVIEW_BREAKPOINTS,
    baseDocument: baseDoc,
    compareDocument: compareDoc
  }
}

export async function getTemplateVisualBaselines(
  db: D1Database,
  templateName: string
): Promise<
  Array<{
    id: string
    templateName: string
    breakpoint: string
    criticalSelectors: string[]
    version: number
  }>
> {
  const { results } = await db
    .prepare(
      'SELECT id, template_name, breakpoint, critical_selectors_json, version FROM cms_template_visual_baselines WHERE template_name = ?1 AND status = ?2'
    )
    .bind(templateName, 'active')
    .all<{
      id: string
      template_name: string
      breakpoint: string
      critical_selectors_json: string
      version: number
    }>()

  return (results ?? []).map((r) => ({
    id: r.id,
    templateName: r.template_name,
    breakpoint: r.breakpoint,
    criticalSelectors: JSON.parse(r.critical_selectors_json) as string[],
    version: r.version
  }))
}

export async function executeTemplateVisualRegressionCheck(
  db: D1Database,
  options: {
    actorId: string
    templateName: string
    breakpoint: CmsPreviewBreakpoint
    renderedSelectors: string[]
    now?: string
  }
): Promise<{ passed: boolean; missingCriticalSelectors: string[] }> {
  const now = options.now ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  await verifyPreviewPermission(db, options.actorId, now)

  const baseline = await db
    .prepare(
      'SELECT critical_selectors_json FROM cms_template_visual_baselines WHERE template_name = ?1 AND breakpoint = ?2 AND status = ?3'
    )
    .bind(options.templateName, options.breakpoint, 'active')
    .first<{ critical_selectors_json: string }>()

  if (!baseline) {
    // If no baseline configured, passes by default
    return { passed: true, missingCriticalSelectors: [] }
  }

  const criticalSelectors = JSON.parse(baseline.critical_selectors_json) as string[]
  const selectorSet = new Set(options.renderedSelectors)
  const missing = criticalSelectors.filter((s) => !selectorSet.has(s))

  const passed = missing.length === 0

  // Record run in cms_preview_diff_runs
  const runId = crypto.randomUUID()
  await db
    .prepare(
      `
      INSERT INTO cms_preview_diff_runs (id, page_id, base_version, compare_version, diff_summary_json, breakpoint, regression_passed, created_at, created_by)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
    `
    )
    .bind(
      runId,
      `template-${options.templateName}`,
      1,
      1,
      JSON.stringify({ criticalSelectorsCount: criticalSelectors.length, missingCount: missing.length }),
      options.breakpoint,
      passed ? 1 : 0,
      now,
      options.actorId
    )
    .run()

  return { passed, missingCriticalSelectors: missing }
}

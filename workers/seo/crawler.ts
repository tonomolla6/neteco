import type { CrawlRunRecord, CrawlPageResult, SeoIssue, CanonicalStatus } from '../../shared/seo-technical-crawler'

export type PageFetcher = (url: string) => Promise<{ status: number; headers: Record<string, string>; body: string }>

export interface CrawlExecutionOptions {
  triggerType?: 'scheduled' | 'manual' | 'ci'
  seedUrls?: string[]
  maxDepth?: number
  maxPages?: number
  baselineRunId?: string
  knownCatalogUrls?: string[]
  pageFetcher: PageFetcher
  now?: () => string
}

function getIsoNow(nowFn?: () => string): string {
  return nowFn ? nowFn() : new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
}

interface ParsedPageData {
  canonicalUrl: string | null
  canonicalStatus: CanonicalStatus
  hasNoindex: boolean
  schemaTypes: string[]
  title: string | null
  metaDescription: string | null
  h1: string | null
  links: string[]
}

export function parseHtmlPage(
  url: string,
  statusCode: number,
  headers: Record<string, string>,
  body: string
): ParsedPageData {
  const normHeaders: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) {
    normHeaders[k.toLowerCase()] = v
  }

  // 1. Header noindex
  const xRobots = normHeaders['x-robots-tag'] || ''
  const headerNoindex = /noindex/i.test(xRobots)

  // 2. Meta noindex
  const metaRobotsMatch =
    body.match(/<meta\s+[^>]*name=["']robots["'][^>]*content=["']([^"']+)["'][^>]*>/i) ||
    body.match(/<meta\s+[^>]*content=["']([^"']+)["'][^>]*name=["']robots["'][^>]*>/i)
  const metaNoindex = metaRobotsMatch ? /noindex/i.test(metaRobotsMatch[1] ?? '') : false
  const hasNoindex = headerNoindex || metaNoindex

  // 3. Canonical tag
  const canonicalMatch =
    body.match(/<link\s+[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)["'][^>]*>/i) ||
    body.match(/<link\s+[^>]*href=["']([^"']+)["'][^>]*rel=["']canonical["'][^>]*>/i)
  const canonicalHref = canonicalMatch ? (canonicalMatch[1] ?? '').trim() : null

  let canonicalStatus: CanonicalStatus = 'missing'
  let canonicalUrl: string | null = null

  if (canonicalHref) {
    canonicalUrl = canonicalHref
    if (!canonicalHref.startsWith('http://') && !canonicalHref.startsWith('https://')) {
      canonicalStatus = 'relative'
    } else {
      try {
        const parsedCanonical = new URL(canonicalHref)
        const parsedCurrent = new URL(url, 'https://neteco.beply.es')
        if (parsedCanonical.hostname !== 'neteco.beply.es') {
          canonicalStatus = 'cross_domain'
        } else if (parsedCanonical.pathname.replace(/\/$/, '') === parsedCurrent.pathname.replace(/\/$/, '')) {
          canonicalStatus = 'self'
        } else {
          canonicalStatus = 'mismatch'
        }
      } catch {
        canonicalStatus = 'invalid'
      }
    }
  }

  // 4. Title
  const titleMatch = body.match(/<title[^>]*>([^<]+)<\/title>/i)
  const title = titleMatch ? (titleMatch[1] ?? '').trim() : null

  // 5. Meta description
  const descMatch =
    body.match(/<meta\s+[^>]*name=["']description["'][^>]*content=["']([^"']+)["'][^>]*>/i) ||
    body.match(/<meta\s+[^>]*content=["']([^"']+)["'][^>]*name=["']description["'][^>]*>/i)
  const metaDescription = descMatch ? (descMatch[1] ?? '').trim() : null

  // 6. H1
  const h1Match = body.match(/<h1[^>]*>([^<]+)<\/h1>/i)
  const h1 = h1Match ? (h1Match[1] ?? '').trim() : null

  // 7. Schema.org JSON-LD
  const schemaTypes: string[] = []
  const ldJsonRegex = /<script\s+[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  let match: RegExpExecArray | null
  while ((match = ldJsonRegex.exec(body)) !== null) {
    try {
      const parsed = JSON.parse(match[1] ?? '{}')
      const extractTypes = (obj: unknown) => {
        if (!obj || typeof obj !== 'object') return
        const record = obj as Record<string, unknown>
        if (record['@type']) {
          if (Array.isArray(record['@type'])) {
            for (const t of record['@type']) schemaTypes.push(String(t))
          } else {
            schemaTypes.push(String(record['@type']))
          }
        }
        if (Array.isArray(record['@graph'])) {
          for (const item of record['@graph']) extractTypes(item)
        }
      }
      extractTypes(parsed)
    } catch {
      // invalid schema JSON will be recorded
    }
  }

  // 8. Extract internal href links
  const links: string[] = []
  const aRegex = /<a\s+[^>]*href=["']([^"']+)["'][^>]*>/gi
  while ((match = aRegex.exec(body)) !== null) {
    const rawHref = (match[1] ?? '').trim()
    if (
      !rawHref ||
      rawHref.startsWith('#') ||
      rawHref.startsWith('mailto:') ||
      rawHref.startsWith('tel:') ||
      rawHref.startsWith('javascript:')
    ) {
      continue
    }

    try {
      const parsed = new URL(rawHref, 'https://neteco.beply.es')
      if (parsed.hostname === 'neteco.beply.es') {
        const cleanPath = parsed.pathname
        if (cleanPath && !links.includes(cleanPath)) {
          links.push(cleanPath)
        }
      }
    } catch {
      // invalid URL
    }
  }

  return {
    canonicalUrl,
    canonicalStatus,
    hasNoindex,
    schemaTypes: Array.from(new Set(schemaTypes)),
    title,
    metaDescription,
    h1,
    links
  }
}

export async function executeSeoTechnicalCrawl(
  database: D1Database,
  options: CrawlExecutionOptions
): Promise<CrawlRunRecord> {
  const triggerType = options.triggerType ?? 'manual'
  const seedUrls = options.seedUrls && options.seedUrls.length > 0 ? options.seedUrls : ['/']
  const maxDepth = options.maxDepth ?? 5
  const maxPages = options.maxPages ?? 100
  const baselineRunId = options.baselineRunId
  const knownCatalogUrls = options.knownCatalogUrls ?? []
  const now = getIsoNow(options.now)
  const runId = crypto.randomUUID()

  const runRecord: CrawlRunRecord = {
    id: runId,
    status: 'running',
    triggerType,
    totalUrlsScanned: 0,
    status2xxCount: 0,
    status4xxCount: 0,
    status5xxCount: 0,
    canonicalIssuesCount: 0,
    noindexCount: 0,
    missingSchemaCount: 0,
    orphanCount: 0,
    maxDepthReached: 0,
    accidentalChangesCount: 0,
    baselineRunId: baselineRunId ?? null,
    startedAt: now,
    completedAt: null,
    createdAt: now
  }

  // Store initial run state
  await database
    .prepare(
      `INSERT INTO seo_crawl_runs (
        id, status, trigger_type, total_urls_scanned, status_2xx_count, status_4xx_count, status_5xx_count,
        canonical_issues_count, noindex_count, missing_schema_count, orphan_count, max_depth_reached,
        accidental_changes_count, baseline_run_id, started_at, completed_at, created_at
      ) VALUES (?1, ?2, ?3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, ?4, ?5, NULL, ?5)`
    )
    .bind(runId, 'running', triggerType, baselineRunId ?? null, now)
    .run()

  // BFS Queue
  const queue: Array<{ url: string; depth: number; parentUrl: string | null }> = seedUrls.map((s) => ({
    url: s,
    depth: 0,
    parentUrl: null
  }))

  const visitedPages = new Map<string, CrawlPageResult>()
  const inlinksMap = new Map<string, number>()
  const issues: SeoIssue[] = []

  let maxDepthReached = 0

  while (queue.length > 0 && visitedPages.size < maxPages) {
    const next = queue.shift()!
    const cleanUrl = next.url.startsWith('/') ? next.url : '/' + next.url

    // Count inlinks
    inlinksMap.set(cleanUrl, (inlinksMap.get(cleanUrl) ?? 0) + 1)

    if (visitedPages.has(cleanUrl)) {
      continue
    }

    if (next.depth > maxDepthReached) {
      maxDepthReached = next.depth
    }

    let fetchRes: { status: number; headers: Record<string, string>; body: string }
    try {
      fetchRes = await options.pageFetcher(cleanUrl)
    } catch (err: unknown) {
      fetchRes = { status: 500, headers: {}, body: String(err instanceof Error ? err.message : 'Network error') }
    }

    const parsed = parseHtmlPage(cleanUrl, fetchRes.status, fetchRes.headers, fetchRes.body)

    const pageResult: CrawlPageResult = {
      id: crypto.randomUUID(),
      runId,
      url: cleanUrl,
      statusCode: fetchRes.status,
      depth: next.depth,
      parentUrl: next.parentUrl,
      canonicalUrl: parsed.canonicalUrl,
      canonicalStatus: parsed.canonicalStatus,
      hasNoindex: parsed.hasNoindex,
      isOrphan: false,
      schemaTypes: parsed.schemaTypes,
      title: parsed.title,
      metaDescription: parsed.metaDescription,
      h1: parsed.h1,
      inlinksCount: 1,
      outlinksCount: parsed.links.length,
      crawledAt: now
    }

    visitedPages.set(cleanUrl, pageResult)

    // Evaluate issues for this page
    if (fetchRes.status >= 400 && fetchRes.status < 500) {
      runRecord.status4xxCount++
      issues.push({
        id: crypto.randomUUID(),
        runId,
        url: cleanUrl,
        issueType: 'http_4xx',
        severity: 'critical',
        details: { statusCode: fetchRes.status, parentUrl: next.parentUrl },
        createdAt: now
      })
    } else if (fetchRes.status >= 500) {
      runRecord.status5xxCount++
      issues.push({
        id: crypto.randomUUID(),
        runId,
        url: cleanUrl,
        issueType: 'http_5xx',
        severity: 'critical',
        details: { statusCode: fetchRes.status, parentUrl: next.parentUrl },
        createdAt: now
      })
    } else if (fetchRes.status >= 200 && fetchRes.status < 300) {
      runRecord.status2xxCount++
    }

    // Canonical issues
    if (fetchRes.status === 200) {
      if (parsed.canonicalStatus === 'missing') {
        runRecord.canonicalIssuesCount++
        issues.push({
          id: crypto.randomUUID(),
          runId,
          url: cleanUrl,
          issueType: 'canonical_missing',
          severity: 'warning',
          details: { message: 'Missing canonical link tag' },
          createdAt: now
        })
      } else if (parsed.canonicalStatus === 'mismatch') {
        runRecord.canonicalIssuesCount++
        issues.push({
          id: crypto.randomUUID(),
          runId,
          url: cleanUrl,
          issueType: 'canonical_mismatch',
          severity: 'warning',
          details: { canonicalUrl: parsed.canonicalUrl, currentUrl: cleanUrl },
          createdAt: now
        })
      }
    }

    // Noindex detection
    if (parsed.hasNoindex) {
      runRecord.noindexCount++
    }

    // Depth check
    if (next.depth > 3) {
      issues.push({
        id: crypto.randomUUID(),
        runId,
        url: cleanUrl,
        issueType: 'excessive_depth',
        severity: 'warning',
        details: { depth: next.depth, threshold: 3 },
        createdAt: now
      })
    }

    // Enqueue unvisited internal links if status 200 and depth < maxDepth
    if (fetchRes.status === 200 && next.depth < maxDepth) {
      for (const link of parsed.links) {
        if (!visitedPages.has(link)) {
          queue.push({
            url: link,
            depth: next.depth + 1,
            parentUrl: cleanUrl
          })
        }
      }
    }
  }

  // Orphan Detection: check known catalogue/sitemap URLs not visited
  for (const knownUrl of knownCatalogUrls) {
    const cleanKnown = knownUrl.startsWith('/') ? knownUrl : '/' + knownUrl
    if (!visitedPages.has(cleanKnown)) {
      runRecord.orphanCount++
      const orphanPage: CrawlPageResult = {
        id: crypto.randomUUID(),
        runId,
        url: cleanKnown,
        statusCode: 0,
        depth: -1,
        parentUrl: null,
        canonicalUrl: null,
        canonicalStatus: 'missing',
        hasNoindex: false,
        isOrphan: true,
        schemaTypes: [],
        title: null,
        metaDescription: null,
        h1: null,
        inlinksCount: 0,
        outlinksCount: 0,
        crawledAt: now
      }
      visitedPages.set(cleanKnown, orphanPage)

      issues.push({
        id: crypto.randomUUID(),
        runId,
        url: cleanKnown,
        issueType: 'orphan_page',
        severity: 'warning',
        details: { message: 'URL in sitemap/catalog has 0 internal inlinks' },
        createdAt: now
      })
    }
  }

  // Update inlinks counts for visited pages
  for (const [url, page] of visitedPages.entries()) {
    if (!page.isOrphan) {
      page.inlinksCount = inlinksMap.get(url) ?? 1
    }
  }

  // Baseline Comparison & Accidental Change Detection
  if (baselineRunId) {
    const baselineRows = await database
      .prepare(`SELECT * FROM seo_crawl_pages WHERE run_id = ?`)
      .bind(baselineRunId)
      .all<{
        url: string
        status_code: number
        canonical_url: string | null
        has_noindex: number
        schema_types: string
        title: string | null
      }>()

    const baselineMap = new Map(baselineRows.results.map((r) => [r.url, r]))

    for (const [url, curr] of visitedPages.entries()) {
      const base = baselineMap.get(url)
      if (!base) continue

      // Status regression (was 200, now 4xx or 5xx)
      if (base.status_code === 200 && curr.statusCode >= 400) {
        runRecord.accidentalChangesCount++
        issues.push({
          id: crypto.randomUUID(),
          runId,
          url,
          issueType: 'status_regression',
          severity: 'critical',
          details: { previousStatus: base.status_code, currentStatus: curr.statusCode },
          createdAt: now
        })
      }

      // Accidental noindex (previously indexed, now noindexed)
      if (base.has_noindex === 0 && curr.hasNoindex) {
        runRecord.accidentalChangesCount++
        issues.push({
          id: crypto.randomUUID(),
          runId,
          url,
          issueType: 'accidental_noindex',
          severity: 'critical',
          details: { message: 'Page was indexable in baseline, now has noindex' },
          createdAt: now
        })
      }

      // Accidental canonical change
      if (base.canonical_url && curr.canonicalUrl && base.canonical_url !== curr.canonicalUrl) {
        runRecord.accidentalChangesCount++
        issues.push({
          id: crypto.randomUUID(),
          runId,
          url,
          issueType: 'accidental_canonical_change',
          severity: 'warning',
          details: { previousCanonical: base.canonical_url, currentCanonical: curr.canonicalUrl },
          createdAt: now
        })
      }
    }
  }

  runRecord.totalUrlsScanned = visitedPages.size
  runRecord.maxDepthReached = maxDepthReached
  runRecord.status = 'completed'
  runRecord.completedAt = now

  // Persist Pages & Issues in batch
  const batchStatements: D1PreparedStatement[] = []

  // Update run record
  batchStatements.push(
    database
      .prepare(
        `UPDATE seo_crawl_runs SET
          status = 'completed',
          total_urls_scanned = ?1,
          status_2xx_count = ?2,
          status_4xx_count = ?3,
          status_5xx_count = ?4,
          canonical_issues_count = ?5,
          noindex_count = ?6,
          missing_schema_count = ?7,
          orphan_count = ?8,
          max_depth_reached = ?9,
          accidental_changes_count = ?10,
          completed_at = ?11
        WHERE id = ?12`
      )
      .bind(
        runRecord.totalUrlsScanned,
        runRecord.status2xxCount,
        runRecord.status4xxCount,
        runRecord.status5xxCount,
        runRecord.canonicalIssuesCount,
        runRecord.noindexCount,
        runRecord.missingSchemaCount,
        runRecord.orphanCount,
        runRecord.maxDepthReached,
        runRecord.accidentalChangesCount,
        now,
        runId
      )
  )

  for (const page of visitedPages.values()) {
    batchStatements.push(
      database
        .prepare(
          `INSERT INTO seo_crawl_pages (
            id, run_id, url, status_code, depth, parent_url, canonical_url,
            canonical_status, has_noindex, is_orphan, schema_types, title,
            meta_description, h1, inlinks_count, outlinks_count, crawled_at
          ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)`
        )
        .bind(
          page.id,
          page.runId,
          page.url,
          page.statusCode,
          page.depth,
          page.parentUrl,
          page.canonicalUrl,
          page.canonicalStatus,
          page.hasNoindex ? 1 : 0,
          page.isOrphan ? 1 : 0,
          JSON.stringify(page.schemaTypes),
          page.title,
          page.metaDescription,
          page.h1,
          page.inlinksCount,
          page.outlinksCount,
          page.crawledAt
        )
    )
  }

  for (const issue of issues) {
    batchStatements.push(
      database
        .prepare(
          `INSERT INTO seo_crawl_issues (
            id, run_id, url, issue_type, severity, details, created_at
          ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
        )
        .bind(
          issue.id,
          issue.runId,
          issue.url,
          issue.issueType,
          issue.severity,
          JSON.stringify(issue.details),
          issue.createdAt
        )
    )
  }

  // Execute in batches of 50
  for (let i = 0; i < batchStatements.length; i += 50) {
    await database.batch(batchStatements.slice(i, i + 50))
  }

  return runRecord
}

interface CrawlRunRow {
  id: string
  status: 'pending' | 'running' | 'completed' | 'failed'
  trigger_type: 'scheduled' | 'manual' | 'ci'
  total_urls_scanned: number
  status_2xx_count: number
  status_4xx_count: number
  status_5xx_count: number
  canonical_issues_count: number
  noindex_count: number
  missing_schema_count: number
  orphan_count: number
  max_depth_reached: number
  accidental_changes_count: number
  baseline_run_id: string | null
  started_at: string
  completed_at: string | null
  created_at: string
}

interface CrawlIssueRow {
  id: string
  run_id: string
  url: string
  issue_type: string
  severity: 'critical' | 'warning' | 'info'
  details: string
  created_at: string
}

interface CrawlPageRow {
  id: string
  run_id: string
  url: string
  status_code: number
  depth: number
  parent_url: string | null
  canonical_url: string | null
  canonical_status: CanonicalStatus
  has_noindex: number
  is_orphan: number
  schema_types: string
  title: string | null
  meta_description: string | null
  h1: string | null
  inlinks_count: number
  outlinks_count: number
  crawled_at: string
}

export async function getSeoCrawlRunDetail(database: D1Database, runId: string): Promise<CrawlRunRecord | null> {
  const row = await database.prepare(`SELECT * FROM seo_crawl_runs WHERE id = ?`).bind(runId).first<CrawlRunRow>()

  if (!row) return null

  return {
    id: row.id,
    status: row.status,
    triggerType: row.trigger_type,
    totalUrlsScanned: row.total_urls_scanned,
    status2xxCount: row.status_2xx_count,
    status4xxCount: row.status_4xx_count,
    status5xxCount: row.status_5xx_count,
    canonicalIssuesCount: row.canonical_issues_count,
    noindexCount: row.noindex_count,
    missingSchemaCount: row.missing_schema_count,
    orphanCount: row.orphan_count,
    maxDepthReached: row.max_depth_reached,
    accidentalChangesCount: row.accidental_changes_count,
    baselineRunId: row.baseline_run_id,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    createdAt: row.created_at
  }
}

export async function listSeoCrawlRuns(database: D1Database, limit = 20): Promise<CrawlRunRecord[]> {
  const { results } = await database
    .prepare(`SELECT * FROM seo_crawl_runs ORDER BY started_at DESC LIMIT ?`)
    .bind(limit)
    .all<CrawlRunRow>()

  return results.map((row) => ({
    id: row.id,
    status: row.status,
    triggerType: row.trigger_type,
    totalUrlsScanned: row.total_urls_scanned,
    status2xxCount: row.status_2xx_count,
    status4xxCount: row.status_4xx_count,
    status5xxCount: row.status_5xx_count,
    canonicalIssuesCount: row.canonical_issues_count,
    noindexCount: row.noindex_count,
    missingSchemaCount: row.missing_schema_count,
    orphanCount: row.orphan_count,
    maxDepthReached: row.max_depth_reached,
    accidentalChangesCount: row.accidental_changes_count,
    baselineRunId: row.baseline_run_id,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    createdAt: row.created_at
  }))
}

export async function listSeoCrawlIssues(database: D1Database, runId: string): Promise<SeoIssue[]> {
  const { results } = await database
    .prepare(`SELECT * FROM seo_crawl_issues WHERE run_id = ? ORDER BY severity ASC, created_at DESC`)
    .bind(runId)
    .all<CrawlIssueRow>()

  return results.map((row) => ({
    id: row.id,
    runId: row.run_id,
    url: row.url,
    issueType: row.issue_type as SeoIssue['issueType'],
    severity: row.severity,
    details: JSON.parse(row.details),
    createdAt: row.created_at
  }))
}

export async function listSeoCrawlPages(
  database: D1Database,
  runId: string,
  options?: { isOrphan?: boolean; hasIssues?: boolean; limit?: number; offset?: number }
): Promise<CrawlPageResult[]> {
  let query = `SELECT * FROM seo_crawl_pages WHERE run_id = ?1`
  const params: unknown[] = [runId]

  if (options?.isOrphan !== undefined) {
    query += ` AND is_orphan = ?${params.length + 1}`
    params.push(options.isOrphan ? 1 : 0)
  }

  query += ` ORDER BY depth ASC, url ASC LIMIT ?${params.length + 1} OFFSET ?${params.length + 2}`
  params.push(options?.limit ?? 50, options?.offset ?? 0)

  const { results } = await database
    .prepare(query)
    .bind(...params)
    .all<CrawlPageRow>()

  return results.map((row) => ({
    id: row.id,
    runId: row.run_id,
    url: row.url,
    statusCode: row.status_code,
    depth: row.depth,
    parentUrl: row.parent_url,
    canonicalUrl: row.canonical_url,
    canonicalStatus: row.canonical_status,
    hasNoindex: row.has_noindex === 1,
    isOrphan: row.is_orphan === 1,
    schemaTypes: JSON.parse(row.schema_types),
    title: row.title,
    metaDescription: row.meta_description,
    h1: row.h1,
    inlinksCount: row.inlinks_count,
    outlinksCount: row.outlinks_count,
    crawledAt: row.crawled_at
  }))
}

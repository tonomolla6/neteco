import {
  type BotLogRecord,
  type BotCrawlWasteSummary,
  type BotRetentionPolicy,
  type IngestBotLogInput,
  type CrawlWasteCategory,
  IngestBotLogInputSchema,
  BotRetentionPolicySchema,
  detectBotFamily,
  verifyBotIdentity,
  evaluateCrawlWaste,
  sanitizePath,
  SeoBotLogError
} from '../../shared/seo-bot-logs'

export async function sha256Hex(value: string): Promise<string> {
  const data = new TextEncoder().encode(value)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

export async function hashBotIp(ip: string, pepper: string): Promise<string> {
  const normalized = ip.trim().toLowerCase()
  return sha256Hex(`neteco-seo-bot-ip-v1:${pepper}:${normalized}`)
}

function getIsoNow(nowFn?: () => string): string {
  return nowFn ? nowFn() : new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
}

export interface RecordBotLogOptions {
  pepper: string
  now?: () => string
  verifiedIpPrefixes?: string[]
}

export async function recordBotAccessLog(
  database: D1Database,
  rawInput: IngestBotLogInput,
  options: RecordBotLogOptions
): Promise<BotLogRecord> {
  const parsed = IngestBotLogInputSchema.safeParse(rawInput)
  if (!parsed.success) {
    throw new SeoBotLogError('invalid_input', `Entrada de log de bot inválida: ${parsed.error.message}`)
  }
  const input = parsed.data
  const now = getIsoNow(options.now)

  // Pseudonymize IP with pepper (Zero PII stored)
  const ipHash = await hashBotIp(input.ip, options.pepper)

  // Detect bot family and name
  const { family: botFamily, botName } = detectBotFamily(input.userAgent)

  // Verify legitimate search crawler vs spoofed fake bot
  const verificationStatus = verifyBotIdentity(input.userAgent, input.ip, {
    isVerifiedBotHeader: input.isVerifiedBotHeader,
    verifiedIpPrefixes: options.verifiedIpPrefixes
  })

  // Sanitize path (strip query PII)
  const cleanPath = sanitizePath(input.path)

  // Evaluate crawl waste
  const wasteEvaluation = evaluateCrawlWaste(cleanPath, input.statusCode, input.pageRobotsNoindex)

  // If bot claims search engine but is a fake spoofed bot, flag as crawl waste
  let isWaste = wasteEvaluation.isWaste
  let wasteCategory = wasteEvaluation.category

  if (verificationStatus === 'fake') {
    isWaste = true
    if (wasteCategory === 'none') {
      wasteCategory = 'disallowed_url'
    }
  }

  const recordId = crypto.randomUUID()
  const userAgentTruncated = input.userAgent.slice(0, 300)

  await database
    .prepare(
      `INSERT INTO seo_bot_access_logs (
        id, bot_family, bot_name, verification_status, ip_hash, path,
        method, status_code, is_waste, waste_category, response_time_ms,
        user_agent_truncated, created_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`
    )
    .bind(
      recordId,
      botFamily,
      botName,
      verificationStatus,
      ipHash,
      cleanPath,
      input.method,
      input.statusCode,
      isWaste ? 1 : 0,
      wasteCategory,
      input.durationMs,
      userAgentTruncated,
      now
    )
    .run()

  return {
    id: recordId,
    botFamily,
    botName,
    verificationStatus,
    ipHash,
    path: cleanPath,
    method: input.method,
    statusCode: input.statusCode,
    isWaste,
    wasteCategory,
    responseTimeMs: input.durationMs,
    userAgentTruncated,
    createdAt: now
  }
}

export async function getBotCrawlWasteSummary(
  database: D1Database,
  options?: { since?: string; limit?: number }
): Promise<BotCrawlWasteSummary> {
  const sinceClause = options?.since ? `WHERE created_at >= ?1` : ''
  const params = options?.since ? [options.since] : []

  // Overall counts
  const counts = await database
    .prepare(
      `SELECT
        COUNT(*) as total,
        SUM(CASE WHEN verification_status = 'verified' THEN 1 ELSE 0 END) as verified_count,
        SUM(CASE WHEN verification_status = 'fake' THEN 1 ELSE 0 END) as fake_count,
        SUM(CASE WHEN verification_status = 'unverified' THEN 1 ELSE 0 END) as unverified_count,
        SUM(CASE WHEN is_waste = 1 THEN 1 ELSE 0 END) as waste_count,
        SUM(CASE WHEN status_code >= 400 AND status_code < 500 THEN 1 ELSE 0 END) as err_4xx,
        SUM(CASE WHEN status_code >= 500 THEN 1 ELSE 0 END) as err_5xx
      FROM seo_bot_access_logs ${sinceClause}`
    )
    .bind(...params)
    .first<{
      total: number
      verified_count: number
      fake_count: number
      unverified_count: number
      waste_count: number
      err_4xx: number
      err_5xx: number
    }>()

  const totalCrawls = counts?.total ?? 0
  const verifiedBotCrawls = counts?.verified_count ?? 0
  const fakeBotCrawls = counts?.fake_count ?? 0
  const unverifiedCrawls = counts?.unverified_count ?? 0
  const wasteCrawls = counts?.waste_count ?? 0
  const err4xx = counts?.err_4xx ?? 0
  const err5xx = counts?.err_5xx ?? 0

  const wastePercentage = totalCrawls > 0 ? Number(((wasteCrawls / totalCrawls) * 100).toFixed(2)) : 0
  const errorRate4xx = totalCrawls > 0 ? Number(((err4xx / totalCrawls) * 100).toFixed(2)) : 0
  const errorRate5xx = totalCrawls > 0 ? Number(((err5xx / totalCrawls) * 100).toFixed(2)) : 0

  // Category breakdown
  const categoryRows = await database
    .prepare(
      `SELECT waste_category, COUNT(*) as cat_count
       FROM seo_bot_access_logs
       ${sinceClause}
       GROUP BY waste_category`
    )
    .bind(...params)
    .all<{ waste_category: CrawlWasteCategory; cat_count: number }>()

  const wasteByCategory: Record<CrawlWasteCategory, number> = {
    none: 0,
    disallowed_url: 0,
    status_4xx: 0,
    status_5xx: 0,
    noindex_target: 0,
    parameter_duplicate: 0
  }

  for (const r of categoryRows.results) {
    if (r.waste_category in wasteByCategory) {
      wasteByCategory[r.waste_category] = r.cat_count
    }
  }

  // Top wasted URLs
  const topWastedRows = await database
    .prepare(
      `SELECT path, waste_category, status_code, COUNT(*) as hits
       FROM seo_bot_access_logs
       WHERE is_waste = 1 ${options?.since ? 'AND created_at >= ?1' : ''}
       GROUP BY path, waste_category, status_code
       ORDER BY hits DESC
       LIMIT ?${params.length + 1}`
    )
    .bind(...params, options?.limit ?? 10)
    .all<{ path: string; waste_category: CrawlWasteCategory; status_code: number; hits: number }>()

  const topWastedUrls = topWastedRows.results.map((r) => ({
    path: r.path,
    hits: r.hits,
    wasteCategory: r.waste_category,
    statusCode: r.status_code
  }))

  return {
    totalCrawls,
    verifiedBotCrawls,
    fakeBotCrawls,
    unverifiedCrawls,
    wasteCrawls,
    wastePercentage,
    wasteByCategory,
    topWastedUrls,
    errorRate4xx,
    errorRate5xx
  }
}

export async function getBotRetentionPolicy(database: D1Database): Promise<BotRetentionPolicy> {
  const row = await database
    .prepare(
      `SELECT retention_days, anonymize_ips, auto_prune_enabled FROM seo_bot_retention_policy WHERE id = 'active_policy'`
    )
    .first<{ retention_days: number; anonymize_ips: number; auto_prune_enabled: number }>()

  if (!row) {
    return { retentionDays: 30, anonymizeIps: true, autoPruneEnabled: true }
  }

  return {
    retentionDays: row.retention_days,
    anonymizeIps: row.anonymize_ips === 1,
    autoPruneEnabled: row.auto_prune_enabled === 1
  }
}

export async function updateBotRetentionPolicy(
  database: D1Database,
  input: Partial<BotRetentionPolicy>,
  now?: string
): Promise<BotRetentionPolicy> {
  const current = await getBotRetentionPolicy(database)
  const updated: BotRetentionPolicy = {
    retentionDays: input.retentionDays ?? current.retentionDays,
    anonymizeIps: input.anonymizeIps ?? current.anonymizeIps,
    autoPruneEnabled: input.autoPruneEnabled ?? current.autoPruneEnabled
  }

  const valid = BotRetentionPolicySchema.parse(updated)
  const isoNow = now ?? getIsoNow()

  await database
    .prepare(
      `UPDATE seo_bot_retention_policy SET
        retention_days = ?1,
        anonymize_ips = ?2,
        auto_prune_enabled = ?3,
        updated_at = ?4,
        version = version + 1
      WHERE id = 'active_policy'`
    )
    .bind(valid.retentionDays, valid.anonymizeIps ? 1 : 0, valid.autoPruneEnabled ? 1 : 0, isoNow)
    .run()

  return valid
}

export async function sweepBotLogsRetention(
  database: D1Database,
  options?: { referenceDate?: string; customRetentionDays?: number }
): Promise<number> {
  const policy = await getBotRetentionPolicy(database)
  const days = options?.customRetentionDays ?? policy.retentionDays
  const refDateStr = options?.referenceDate ?? getIsoNow()
  const refTime = new Date(refDateStr).getTime()
  const cutoffTime = refTime - days * 24 * 60 * 60 * 1000
  const cutoffIso = new Date(cutoffTime).toISOString().replace(/\.\d{3}Z$/, 'Z')

  // Find count of rows to prune
  const toDelete = await database
    .prepare(`SELECT count(*) as count FROM seo_bot_access_logs WHERE created_at < ?1`)
    .bind(cutoffIso)
    .first<{ count: number }>()

  const count = toDelete?.count ?? 0
  if (count > 0) {
    await database.prepare(`DELETE FROM seo_bot_access_logs WHERE created_at < ?1`).bind(cutoffIso).run()
  }

  // Update last_pruned_at
  await database
    .prepare(`UPDATE seo_bot_retention_policy SET last_pruned_at = ?1 WHERE id = 'active_policy'`)
    .bind(refDateStr)
    .run()

  return count
}

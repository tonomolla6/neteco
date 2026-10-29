import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import { type IngestBotLogInput, verifyBotIdentity, evaluateCrawlWaste } from '../../shared/seo-bot-logs'
import {
  recordBotAccessLog,
  getBotCrawlWasteSummary,
  sweepBotLogsRetention,
  getBotRetentionPolicy
} from '../../workers/seo/bot-logs'

const NOW = '2026-10-29T12:00:00Z'
const TEST_PEPPER = 'test_seo_pepper_secure_salt_9999'

async function setupBotLogsDatabase(): Promise<DatabaseSync> {
  const sqlite = await openMigratedDatabase()
  const migration = await readFile(
    new URL('../../db/d1/migrations/0117_seo_technical_bot_logs_ai_search.sql', import.meta.url),
    'utf8'
  )
  sqlite.exec(migration)
  return sqlite
}

describe('SEO-024: Análisis de logs de bots', () => {
  let sqlite: DatabaseSync
  let db: ReturnType<typeof d1OverSqlite>

  beforeEach(async () => {
    sqlite = await setupBotLogsDatabase()
    db = d1OverSqlite(sqlite)
  })

  afterEach(() => {
    sqlite.close()
  })

  it('correctly identifies legitimate verified search bots vs spoofed fake bots', async () => {
    // 1. Legitimate Googlebot
    const realGoogle = verifyBotIdentity(
      'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
      '66.249.66.1',
      { isVerifiedBotHeader: true }
    )
    expect(realGoogle).toBe('verified')

    // 2. Fake Googlebot spoofing User-Agent from suspicious IP / unverified header
    const fakeGoogle = verifyBotIdentity(
      'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
      '198.51.100.25',
      { isVerifiedBotHeader: false }
    )
    expect(fakeGoogle).toBe('fake')

    // 3. Legitimate Bingbot
    const realBing = verifyBotIdentity(
      'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
      '157.55.39.10',
      { isVerifiedBotHeader: true }
    )
    expect(realBing).toBe('verified')

    // 4. Commercial auditor (e.g. AhrefsBot) is unverified search bot, categorized accurately
    const ahrefs = verifyBotIdentity(
      'Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)',
      '54.36.148.1'
    )
    expect(ahrefs).toBe('unverified')
  })

  it('records bot access log with pseudonymized IP and no raw PII', async () => {
    const rawIp = '203.0.113.195'
    const result = await recordBotAccessLog(
      db,
      {
        userAgent: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
        ip: rawIp,
        path: '/producto/limpiador-alcalino-5l?session=abc123secret&ref=google',
        statusCode: 200,
        isVerifiedBotHeader: true
      },
      { pepper: TEST_PEPPER, now: () => NOW }
    )

    expect(result.id).toBeDefined()
    expect(result.verificationStatus).toBe('verified')
    expect(result.botFamily).toBe('googlebot')

    // Raw IP is NEVER stored, only sha256 hash
    expect(result.ipHash).not.toBe(rawIp)
    expect(result.ipHash).toHaveLength(64)
    expect(result.ipHash).toMatch(/^[0-9a-f]{64}$/)

    // Query parameters with sensitive tokens are sanitized
    expect(result.path).not.toContain('abc123secret')
    expect(result.path).toContain('[REDACTED]')

    // Verify row directly in sqlite
    const row = sqlite
      .prepare('SELECT ip_hash, path, bot_family FROM seo_bot_access_logs WHERE id = ?')
      .get(result.id) as { ip_hash: string; path: string; bot_family: string }

    expect(row).toBeDefined()
    expect(row.ip_hash).toBe(result.ipHash)
    expect(row.path).toBe(result.path)
    expect(row.bot_family).toBe('googlebot')
  })

  it('identifies crawl waste across disallowed URLs, 4xx, 5xx, and duplicate parameter pages', async () => {
    // 1. Disallowed path in robots.txt (/buscar)
    const wasteSearch = evaluateCrawlWaste('/buscar?q=lejia', 200)
    expect(wasteSearch.isWaste).toBe(true)
    expect(wasteSearch.category).toBe('disallowed_url')

    // 2. Disallowed path in robots.txt (/checkout)
    const wasteCheckout = evaluateCrawlWaste('/checkout/pago', 200)
    expect(wasteCheckout.isWaste).toBe(true)
    expect(wasteCheckout.category).toBe('disallowed_url')

    // 3. 4xx dead URL
    const waste404 = evaluateCrawlWaste('/antiguo-catalogo-2024', 404)
    expect(waste404.isWaste).toBe(true)
    expect(waste404.category).toBe('status_4xx')

    // 4. 5xx server crash
    const waste500 = evaluateCrawlWaste('/api/falla', 500)
    expect(waste500.isWaste).toBe(true)
    expect(waste500.category).toBe('status_5xx')

    // 5. Parameter duplicate (?sort=price_asc)
    const wasteParam = evaluateCrawlWaste('/categorias/desinfectantes?sort=price_asc', 200)
    expect(wasteParam.isWaste).toBe(true)
    expect(wasteParam.category).toBe('parameter_duplicate')

    // 6. Healthy normal page
    const healthyPage = evaluateCrawlWaste('/categorias/desinfectantes', 200)
    expect(healthyPage.isWaste).toBe(false)
    expect(healthyPage.category).toBe('none')
  })

  it('generates a crawl waste summary distinguishing verified vs fake bots and reporting waste breakdown', async () => {
    // Insert a batch of logs
    const entries: IngestBotLogInput[] = [
      // 3 verified Googlebot hits: 2 healthy, 1 waste (404)
      {
        userAgent: 'Googlebot/2.1',
        ip: '66.249.66.1',
        path: '/producto/a',
        statusCode: 200,
        isVerifiedBotHeader: true
      },
      {
        userAgent: 'Googlebot/2.1',
        ip: '66.249.66.2',
        path: '/producto/b',
        statusCode: 200,
        isVerifiedBotHeader: true
      },
      {
        userAgent: 'Googlebot/2.1',
        ip: '66.249.66.3',
        path: '/producto/inexistente',
        statusCode: 404,
        isVerifiedBotHeader: true
      },

      // 2 verified Bingbot hits: 1 healthy, 1 waste (disallowed /buscar)
      {
        userAgent: 'bingbot/2.0',
        ip: '157.55.39.1',
        path: '/quienes-somos',
        statusCode: 200,
        isVerifiedBotHeader: true
      },
      {
        userAgent: 'bingbot/2.0',
        ip: '157.55.39.2',
        path: '/buscar?q=cloro',
        statusCode: 200,
        isVerifiedBotHeader: true
      },

      // 2 Fake Googlebot hits (spoofed UA from unverified host): waste
      {
        userAgent: 'Googlebot/2.1',
        ip: '198.51.100.99',
        path: '/admin/login',
        statusCode: 403,
        isVerifiedBotHeader: false
      },
      {
        userAgent: 'Googlebot/2.1',
        ip: '198.51.100.99',
        path: '/cuenta/pedidos',
        statusCode: 403,
        isVerifiedBotHeader: false
      }
    ]

    for (const entry of entries) {
      await recordBotAccessLog(db, entry, { pepper: TEST_PEPPER, now: () => NOW })
    }

    const summary = await getBotCrawlWasteSummary(db)

    expect(summary.totalCrawls).toBe(7)
    expect(summary.verifiedBotCrawls).toBe(5)
    expect(summary.fakeBotCrawls).toBe(2)

    // Crawl waste calculation: 2 verified waste hits (404 and /buscar) out of 5 verified hits = 40% waste
    expect(summary.wasteCrawls).toBe(4) // 2 verified waste + 2 fake bot waste
    expect(summary.wasteByCategory.status_4xx).toBeGreaterThanOrEqual(1)
    expect(summary.wasteByCategory.disallowed_url).toBeGreaterThanOrEqual(1)

    // Top wasted URLs
    expect(summary.topWastedUrls.length).toBeGreaterThan(0)
    const wastedPaths = summary.topWastedUrls.map((u) => u.path)
    expect(wastedPaths).toContain('/buscar?q=cloro')
    expect(wastedPaths).toContain('/producto/inexistente')
  })

  it('enforces retention policy and prunes old bot logs safely', async () => {
    // Current policy: 30 days retention
    const policy = await getBotRetentionPolicy(db)
    expect(policy.retentionDays).toBe(30)

    // Insert an old log entry from 45 days ago
    const oldDate = '2026-09-10T12:00:00Z'
    await recordBotAccessLog(
      db,
      { userAgent: 'Googlebot/2.1', ip: '66.249.66.1', path: '/old-page', statusCode: 200, isVerifiedBotHeader: true },
      { pepper: TEST_PEPPER, now: () => oldDate }
    )

    // Insert a fresh log entry from today
    await recordBotAccessLog(
      db,
      {
        userAgent: 'Googlebot/2.1',
        ip: '66.249.66.1',
        path: '/fresh-page',
        statusCode: 200,
        isVerifiedBotHeader: true
      },
      { pepper: TEST_PEPPER, now: () => NOW }
    )

    // Verify both exist before retention sweep
    const countBefore = sqlite.prepare('SELECT count(*) as count FROM seo_bot_access_logs').get() as { count: number }
    expect(countBefore.count).toBe(2)

    // Execute retention sweep with reference date NOW
    const pruned = await sweepBotLogsRetention(db, { referenceDate: NOW })
    expect(pruned).toBe(1)

    // Old log pruned, fresh log kept
    const countAfter = sqlite.prepare('SELECT count(*) as count FROM seo_bot_access_logs').get() as { count: number }
    expect(countAfter.count).toBe(1)

    const remaining = sqlite.prepare('SELECT path FROM seo_bot_access_logs').get() as { path: string }
    expect(remaining.path).toBe('/fresh-page')
  })

  it('maintains log immutability via D1 triggers', async () => {
    const entry = await recordBotAccessLog(
      db,
      {
        userAgent: 'Googlebot/2.1',
        ip: '66.249.66.1',
        path: '/test-immutable',
        statusCode: 200,
        isVerifiedBotHeader: true
      },
      { pepper: TEST_PEPPER, now: () => NOW }
    )

    // Trigger should abort on UPDATE
    expect(() => {
      sqlite.prepare('UPDATE seo_bot_access_logs SET status_code = 500 WHERE id = ?').run(entry.id)
    }).toThrow(/bot_logs_immutable/)
  })
})

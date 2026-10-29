import {
  catalogCacheHitRate,
  CatalogQueryCache,
  type CatalogCacheOutcome,
  type CatalogCacheRecorder,
  type CatalogCacheStore
} from '../../shared/b2b-catalog-cache'

/** Aggregate counters per day/scope. Holds no company ids, keys or payloads. */
export class D1CatalogCacheRecorder implements CatalogCacheRecorder {
  constructor(
    private readonly database: D1Database,
    private readonly clock: () => string = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  ) {}

  async record(scope: 'public' | 'b2b', outcome: CatalogCacheOutcome): Promise<void> {
    const day = this.clock().slice(0, 10)
    const hits = outcome === 'hit' ? 1 : 0
    const misses = outcome === 'miss' ? 1 : 0
    const rejections = outcome === 'isolation_rejection' ? 1 : 0
    await this.database
      .prepare(
        `INSERT INTO b2b_catalog_cache_stats (day, scope, hits, misses, isolation_rejections)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(day, scope) DO UPDATE SET
           hits = hits + excluded.hits,
           misses = misses + excluded.misses,
           isolation_rejections = isolation_rejections + excluded.isolation_rejections`
      )
      .bind(day, scope, hits, misses, rejections)
      .run()
  }
}

/** Wiring helper for catalogue read paths: cache + D1 statistics. */
export function createStatsBackedCatalogCache(
  database: D1Database,
  store: CatalogCacheStore,
  pepper: string,
  clock?: () => string
): CatalogQueryCache {
  return new CatalogQueryCache(store, pepper, new D1CatalogCacheRecorder(database, clock))
}

export interface CatalogCacheStats {
  days: Array<{
    day: string
    scope: 'public' | 'b2b'
    hits: number
    misses: number
    isolationRejections: number
    hitRate: number | null
  }>
  totals: Array<{
    scope: 'public' | 'b2b'
    hits: number
    misses: number
    isolationRejections: number
    hitRate: number | null
  }>
}

export async function readD1CatalogCacheStats(
  database: D1Database,
  options: { now?: string; days?: number } = {}
): Promise<CatalogCacheStats> {
  const now = options.now ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  const days = Math.min(Math.max(1, Math.trunc(options.days ?? 7)), 90)
  const since = new Date(Date.parse(now) - (days - 1) * 86_400_000).toISOString().slice(0, 10)
  const rows = await database
    .prepare(
      `SELECT day, scope, hits, misses, isolation_rejections FROM b2b_catalog_cache_stats
       WHERE day >= ?1 AND day <= ?2 ORDER BY day DESC, scope`
    )
    .bind(since, now.slice(0, 10))
    .all<{ day: string; scope: 'public' | 'b2b'; hits: number; misses: number; isolation_rejections: number }>()
  const perDay = (rows.results ?? []).map((r) => ({
    day: r.day,
    scope: r.scope,
    hits: r.hits,
    misses: r.misses,
    isolationRejections: r.isolation_rejections,
    hitRate: catalogCacheHitRate(r.hits, r.misses)
  }))
  const totals = (['public', 'b2b'] as const).map((scope) => {
    const mine = perDay.filter((d) => d.scope === scope)
    const hits = mine.reduce((n, d) => n + d.hits, 0)
    const misses = mine.reduce((n, d) => n + d.misses, 0)
    return {
      scope,
      hits,
      misses,
      isolationRejections: mine.reduce((n, d) => n + d.isolationRejections, 0),
      hitRate: catalogCacheHitRate(hits, misses)
    }
  })
  return { days: perDay, totals }
}

import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NOW, setupPerformanceInsightsDb } from './performance-insights-fixture'
import { D1CatalogCacheRecorder, readD1CatalogCacheStats } from '../../workers/performance/b2b-catalog-cache'
import { CatalogQueryCache, type CatalogCacheStore } from '../../shared/b2b-catalog-cache'

let sqlite: DatabaseSync
let db: D1Database
beforeEach(async () => {
  ;({ sqlite, db } = await setupPerformanceInsightsDb())
})
afterEach(() => sqlite.close())

class MemoryStore implements CatalogCacheStore {
  data = new Map<string, string>()
  async get(k: string) {
    return this.data.get(k) ?? null
  }
  async put(k: string, v: string) {
    this.data.set(k, v)
  }
}
const COMPANY_A = '40000000-0000-4000-8000-00000000000a'
const COMPANY_B = '40000000-0000-4000-8000-00000000000b'
const LIST = '50000000-0000-4000-8000-000000000001'
const ctx = (company: string) => ({ kind: 'b2b', companyId: company, priceListId: LIST, priceListVersion: 1 }) as const

describe('D1 cache statistics', () => {
  it('accumulates hits/misses per day and scope and computes hit rate', async () => {
    const cache = new CatalogQueryCache(
      new MemoryStore(),
      'pepper-pepper-pepper-pepper',
      new D1CatalogCacheRecorder(db, () => NOW)
    )
    for (let i = 0; i < 4; i++) await cache.getOrLoad(ctx(COMPANY_A), { q: 'x' }, 'v1', async () => ({ i }))
    await cache.getOrLoad({ kind: 'public' }, { q: 'x' }, 'v1', async () => ({ i: 1 }))
    const stats = await readD1CatalogCacheStats(db, { now: NOW })
    const b2b = stats.totals.find((t) => t.scope === 'b2b')!
    expect(b2b).toMatchObject({ hits: 3, misses: 1, isolationRejections: 0 })
    expect(b2b.hitRate).toBeCloseTo(0.75, 6)
    expect(stats.totals.find((t) => t.scope === 'public')).toMatchObject({ hits: 0, misses: 1, hitRate: 0 })
    expect(stats.days[0]).toMatchObject({ day: '2026-10-29' })
  })

  it('counts isolation rejections without exposing keys or company ids', async () => {
    const store = new MemoryStore()
    const cache = new CatalogQueryCache(store, 'pepper-pepper-pepper-pepper', new D1CatalogCacheRecorder(db, () => NOW))
    await cache.getOrLoad(ctx(COMPANY_A), { q: 'x' }, 'v1', async () => 'A')
    const [keyA] = [...store.data.keys()]
    await cache.getOrLoad(ctx(COMPANY_B), { q: 'x' }, 'v1', async () => 'B')
    const keyB = [...store.data.keys()].find((k) => k !== keyA)!
    store.data.set(keyB, store.data.get(keyA!)!)
    const result = await cache.getOrLoad(ctx(COMPANY_B), { q: 'x' }, 'v1', async () => 'B2')
    expect(result.value).toBe('B2')
    const stats = await readD1CatalogCacheStats(db, { now: NOW })
    expect(stats.totals.find((t) => t.scope === 'b2b')!.isolationRejections).toBe(1)
    const dump = JSON.stringify(sqlite.prepare('SELECT * FROM b2b_catalog_cache_stats').all())
    expect(dump).not.toContain(COMPANY_A)
    expect(dump).not.toContain('catalog-cache')
  })

  it('returns null hit rate with no traffic and bounds the window', async () => {
    const stats = await readD1CatalogCacheStats(db, { now: NOW, days: 500 })
    expect(stats.totals.every((t) => t.hitRate === null)).toBe(true)
    expect(stats.days).toEqual([])
  })

  it('statistics failures do not break catalogue reads', async () => {
    sqlite.exec('DROP TABLE b2b_catalog_cache_stats')
    const cache = new CatalogQueryCache(
      new MemoryStore(),
      'pepper-pepper-pepper-pepper',
      new D1CatalogCacheRecorder(db, () => NOW)
    )
    expect((await cache.getOrLoad({ kind: 'public' }, {}, 'v1', async () => 5)).value).toBe(5)
  })
})

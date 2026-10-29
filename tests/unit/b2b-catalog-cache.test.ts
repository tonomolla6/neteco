import { describe, expect, it } from 'vitest'
import {
  CatalogQueryCache,
  catalogCacheHitRate,
  deriveCatalogCacheKey,
  resolveCatalogCacheContext,
  type CatalogCacheStore,
  type CatalogCacheRecorder
} from '../../shared/b2b-catalog-cache'

const PEPPER = 'pepper-pepper-pepper-pepper'
const COMPANY_A = '40000000-0000-4000-8000-00000000000a'
const COMPANY_B = '40000000-0000-4000-8000-00000000000b'
const LIST_1 = '50000000-0000-4000-8000-000000000001'
const LIST_2 = '50000000-0000-4000-8000-000000000002'
const ctx = (company = COMPANY_A, list = LIST_1, version = 1) =>
  ({ kind: 'b2b', companyId: company, priceListId: list, priceListVersion: version }) as const

class MemoryStore implements CatalogCacheStore {
  data = new Map<string, string>()
  puts: Array<{ key: string; ttl: number }> = []
  async get(key: string) {
    return this.data.get(key) ?? null
  }
  async put(key: string, value: string, ttlSeconds: number) {
    this.puts.push({ key, ttl: ttlSeconds })
    this.data.set(key, value)
  }
}
class Recorder implements CatalogCacheRecorder {
  events: string[] = []
  async record(scope: string, outcome: string) {
    this.events.push(`${scope}:${outcome}`)
  }
}
const query = { category: 'limpieza', page: 1 }

describe('catalog cache keys', () => {
  it('derives stable keys and never leaks raw identifiers', async () => {
    const a = await deriveCatalogCacheKey(ctx(), query, 'cv1', PEPPER)
    const again = await deriveCatalogCacheKey(ctx(), { page: 1, category: 'limpieza' }, 'cv1', PEPPER)
    expect(again.key).toBe(a.key)
    expect(a.key).not.toContain(COMPANY_A)
    expect(a.key).not.toContain(LIST_1)
    expect(a.key.startsWith('catalog-cache/v1/b2b/')).toBe(true)
  })

  it('separates companies, price lists, price list versions and catalogue versions', async () => {
    const base = (await deriveCatalogCacheKey(ctx(), query, 'cv1', PEPPER)).key
    const keys = await Promise.all([
      deriveCatalogCacheKey(ctx(COMPANY_B), query, 'cv1', PEPPER),
      deriveCatalogCacheKey(ctx(COMPANY_A, LIST_2), query, 'cv1', PEPPER),
      deriveCatalogCacheKey(ctx(COMPANY_A, LIST_1, 2), query, 'cv1', PEPPER),
      deriveCatalogCacheKey(ctx(), query, 'cv2', PEPPER),
      deriveCatalogCacheKey({ kind: 'public' }, query, 'cv1', PEPPER)
    ])
    expect(new Set([base, ...keys.map((k) => k.key)]).size).toBe(6)
  })

  it('keeps public and b2b scopes in distinct namespaces', async () => {
    const pub = await deriveCatalogCacheKey({ kind: 'public' }, query, 'cv1', PEPPER)
    expect(pub.scope).toBe('public')
    expect(pub.key.startsWith('catalog-cache/v1/public/')).toBe(true)
  })

  it('depends on the pepper so keys are not guessable', async () => {
    const a = await deriveCatalogCacheKey(ctx(), query, 'cv1', PEPPER)
    const b = await deriveCatalogCacheKey(ctx(), query, 'cv1', 'another-pepper-another-pepper')
    expect(a.key).not.toBe(b.key)
  })

  it('normalises query text and resists delimiter injection', async () => {
    const a = await deriveCatalogCacheKey({ kind: 'public' }, { q: ' Lejía ' }, 'cv1', PEPPER)
    const b = await deriveCatalogCacheKey({ kind: 'public' }, { q: 'lejía' }, 'cv1', PEPPER)
    expect(a.key).toBe(b.key)
    const inj1 = await deriveCatalogCacheKey({ kind: 'public' }, { q: 'a/../b', page: 1 }, 'cv1', PEPPER)
    const inj2 = await deriveCatalogCacheKey({ kind: 'public' }, { q: 'a', page: 1 }, 'cv1', PEPPER)
    expect(inj1.key).not.toBe(inj2.key)
    expect(inj1.key).toMatch(/^catalog-cache\/v1\/public\/public\/[a-z0-9-]+\/[0-9a-f]{64}$/)
  })

  it('rejects short peppers, bad ids, bad versions and oversized queries', async () => {
    await expect(deriveCatalogCacheKey(ctx(), query, 'cv1', 'short')).rejects.toThrow('invalid_cache_pepper')
    await expect(deriveCatalogCacheKey(ctx('not-a-uuid'), query, 'cv1', PEPPER)).rejects.toThrow(
      'invalid_cache_context'
    )
    await expect(deriveCatalogCacheKey(ctx(COMPANY_A, LIST_1, 0), query, 'cv1', PEPPER)).rejects.toThrow(
      'invalid_cache_context'
    )
    await expect(deriveCatalogCacheKey(ctx(), { q: 'x'.repeat(5000) }, 'cv1', PEPPER)).rejects.toThrow(
      'invalid_cache_query'
    )
    await expect(deriveCatalogCacheKey(ctx(), query, 'bad version!', PEPPER)).rejects.toThrow('invalid_cache_version')
  })
})

describe('catalog cache context resolution', () => {
  it('uses public scope without company data and b2b only with complete data', () => {
    expect(resolveCatalogCacheContext({})).toEqual({ kind: 'public' })
    expect(resolveCatalogCacheContext({ companyId: COMPANY_A, priceListId: LIST_1, priceListVersion: 3 })).toEqual(
      ctx(COMPANY_A, LIST_1, 3)
    )
  })
  it('fails closed on partial company context', () => {
    expect(resolveCatalogCacheContext({ companyId: COMPANY_A })).toEqual({ kind: 'bypass' })
    expect(resolveCatalogCacheContext({ priceListId: LIST_1, priceListVersion: 1 })).toEqual({ kind: 'bypass' })
  })
})

describe('CatalogQueryCache', () => {
  it('misses then hits, with correct TTLs per scope', async () => {
    const store = new MemoryStore()
    const rec = new Recorder()
    const cache = new CatalogQueryCache(store, PEPPER, rec)
    let loads = 0
    const loader = async () => ({ items: [++loads] })
    const first = await cache.getOrLoad(ctx(), query, 'cv1', loader)
    const second = await cache.getOrLoad(ctx(), query, 'cv1', loader)
    expect(first).toMatchObject({ hit: false, value: { items: [1] } })
    expect(second).toMatchObject({ hit: true, value: { items: [1] } })
    expect(loads).toBe(1)
    expect(store.puts[0]!.ttl).toBe(60)
    await cache.getOrLoad({ kind: 'public' }, query, 'cv1', loader)
    expect(store.puts[1]!.ttl).toBe(300)
    expect(rec.events).toEqual(['b2b:miss', 'b2b:hit', 'public:miss'])
  })

  it('isolates companies and price lists: B never receives A data', async () => {
    const cache = new CatalogQueryCache(new MemoryStore(), PEPPER)
    await cache.getOrLoad(ctx(COMPANY_A), query, 'cv1', async () => ({ price: 'A-secret-tariff' }))
    const b = await cache.getOrLoad(ctx(COMPANY_B), query, 'cv1', async () => ({ price: 'B-tariff' }))
    expect(b.hit).toBe(false)
    expect(b.value).toEqual({ price: 'B-tariff' })
    const otherList = await cache.getOrLoad(ctx(COMPANY_A, LIST_2), query, 'cv1', async () => ({ price: 'other' }))
    expect(otherList.hit).toBe(false)
    const pub = await cache.getOrLoad({ kind: 'public' }, query, 'cv1', async () => ({ price: 'public' }))
    expect(pub.value).toEqual({ price: 'public' })
  })

  it('rejects and replaces a poisoned entry whose fingerprint belongs to someone else', async () => {
    const store = new MemoryStore()
    const rec = new Recorder()
    const cache = new CatalogQueryCache(store, PEPPER, rec)
    await cache.getOrLoad(ctx(COMPANY_A), query, 'cv1', async () => ({ price: 'A' }))
    const keyA = (await deriveCatalogCacheKey(ctx(COMPANY_A), query, 'cv1', PEPPER)).key
    const keyB = (await deriveCatalogCacheKey(ctx(COMPANY_B), query, 'cv1', PEPPER)).key
    store.data.set(keyB, store.data.get(keyA)!) // simulated key collision / poisoning
    const b = await cache.getOrLoad(ctx(COMPANY_B), query, 'cv1', async () => ({ price: 'B' }))
    expect(b).toMatchObject({ hit: false, value: { price: 'B' } })
    expect(rec.events).toContain('b2b:isolation_rejection')
  })

  it('treats malformed or version-mismatched entries as misses', async () => {
    const store = new MemoryStore()
    const cache = new CatalogQueryCache(store, PEPPER)
    const { key } = await deriveCatalogCacheKey({ kind: 'public' }, query, 'cv1', PEPPER)
    store.data.set(key, '{not json')
    expect((await cache.getOrLoad({ kind: 'public' }, query, 'cv1', async () => 1)).hit).toBe(false)
    store.data.set(key, JSON.stringify({ v: 99 }))
    expect((await cache.getOrLoad({ kind: 'public' }, query, 'cv1', async () => 2)).value).toBe(2)
  })

  it('bypasses the store entirely on an incomplete b2b context', async () => {
    const store = new MemoryStore()
    const cache = new CatalogQueryCache(store, PEPPER)
    const r = await cache.getOrLoad({ kind: 'bypass' }, query, 'cv1', async () => 'fresh')
    expect(r).toMatchObject({ hit: false, bypassed: true, value: 'fresh' })
    expect(store.data.size).toBe(0)
  })

  it('does not cache null/undefined results nor errors, and survives store failures', async () => {
    const store = new MemoryStore()
    const cache = new CatalogQueryCache(store, PEPPER)
    await cache.getOrLoad(ctx(), query, 'cv1', async () => null)
    expect(store.data.size).toBe(0)
    await expect(
      cache.getOrLoad(ctx(), query, 'cv1', async () => {
        throw new Error('db down')
      })
    ).rejects.toThrow('db down')
    expect(store.data.size).toBe(0)
    const broken: CatalogCacheStore = {
      get: async () => {
        throw new Error('kv down')
      },
      put: async () => {
        throw new Error('kv down')
      }
    }
    const resilient = new CatalogQueryCache(broken, PEPPER)
    expect((await resilient.getOrLoad(ctx(), query, 'cv1', async () => 7)).value).toBe(7)
  })

  it('reaches a measurable hit rate on repeated traffic', async () => {
    const rec = new Recorder()
    const cache = new CatalogQueryCache(new MemoryStore(), PEPPER, rec)
    for (let i = 0; i < 10; i++) await cache.getOrLoad(ctx(), query, 'cv1', async () => ({ ok: true }))
    const hits = rec.events.filter((e) => e.endsWith(':hit')).length
    const misses = rec.events.filter((e) => e.endsWith(':miss')).length
    expect(catalogCacheHitRate(hits, misses)).toBeCloseTo(0.9, 6)
    expect(catalogCacheHitRate(0, 0)).toBeNull()
  })

  it('a price list version bump invalidates cached tariffs', async () => {
    const cache = new CatalogQueryCache(new MemoryStore(), PEPPER)
    await cache.getOrLoad(ctx(COMPANY_A, LIST_1, 1), query, 'cv1', async () => ({ price: 100 }))
    const bumped = await cache.getOrLoad(ctx(COMPANY_A, LIST_1, 2), query, 'cv1', async () => ({ price: 90 }))
    expect(bumped).toMatchObject({ hit: false, value: { price: 90 } })
  })
})

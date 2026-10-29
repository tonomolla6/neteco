/**
 * PER-023: catalogue query cache that cannot leak B2B tariffs.
 *
 * Isolation rules (defence in depth):
 *  1. The key is derived from the *owner scope* (company + price list + price list version)
 *     through HMAC-SHA256 with a secret pepper; raw ids never appear in keys.
 *  2. Public and B2B namespaces are disjoint; an incomplete B2B context fails closed
 *     (`bypass`: the store is never touched).
 *  3. Every stored envelope embeds the owner fingerprint and scope; a read whose envelope
 *     does not match the requester is discarded and counted as an isolation rejection.
 *  4. Price list versions and catalogue versions are part of the key, so a tariff change
 *     invalidates without purging.
 */
export type CatalogCacheContext =
  | { kind: 'public' }
  | { kind: 'b2b'; companyId: string; priceListId: string; priceListVersion: number }
  | { kind: 'bypass' }

export type CatalogCacheQueryValue = string | number | boolean | readonly string[] | null | undefined
export type CatalogCacheQuery = Readonly<Record<string, CatalogCacheQueryValue>>

export interface CatalogCacheStore {
  get(key: string): Promise<string | null>
  put(key: string, value: string, ttlSeconds: number): Promise<void>
}
export type CatalogCacheOutcome = 'hit' | 'miss' | 'isolation_rejection'
export interface CatalogCacheRecorder {
  record(scope: 'public' | 'b2b', outcome: CatalogCacheOutcome): Promise<void>
}

export const B2B_CACHE_TTL_SECONDS = 60
export const PUBLIC_CACHE_TTL_SECONDS = 300
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const VERSION = /^[A-Za-z0-9._-]{1,64}$/
const MAX_QUERY_BYTES = 2048

const encoder = new TextEncoder()
function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, '0')).join('')
}
async function sha256(text: string): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', encoder.encode(text)))
}
async function hmac(pepper: string, text: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(pepper), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign'
  ])
  return toHex(await crypto.subtle.sign('HMAC', key, encoder.encode(text)))
}

export function resolveCatalogCacheContext(input: {
  companyId?: string | null
  priceListId?: string | null
  priceListVersion?: number | null
}): CatalogCacheContext {
  const hasCompany = Boolean(input.companyId)
  const hasList = Boolean(input.priceListId)
  const hasVersion = input.priceListVersion !== undefined && input.priceListVersion !== null
  if (!hasCompany && !hasList && !hasVersion) return { kind: 'public' }
  if (hasCompany && hasList && hasVersion)
    return {
      kind: 'b2b',
      companyId: input.companyId!,
      priceListId: input.priceListId!,
      priceListVersion: input.priceListVersion!
    }
  return { kind: 'bypass' }
}

function canonicalQuery(query: CatalogCacheQuery): string {
  const entries: Array<[string, unknown]> = []
  for (const name of Object.keys(query).sort()) {
    let value = query[name]
    if (value === undefined || value === null || value === '') continue
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,31}$/.test(name)) throw new Error('invalid_cache_query')
    if (typeof value === 'string') value = value.trim().toLowerCase()
    else if (Array.isArray(value)) value = [...(value as string[])].map((v) => v.trim().toLowerCase()).sort()
    entries.push([name, value])
  }
  const text = JSON.stringify(entries)
  if (encoder.encode(text).length > MAX_QUERY_BYTES) throw new Error('invalid_cache_query')
  return text
}

export interface DerivedCatalogCacheKey {
  key: string
  scope: 'public' | 'b2b'
  fingerprint: string
}

export async function deriveCatalogCacheKey(
  context: Exclude<CatalogCacheContext, { kind: 'bypass' }>,
  query: CatalogCacheQuery,
  catalogVersion: string,
  pepper: string
): Promise<DerivedCatalogCacheKey> {
  if (typeof pepper !== 'string' || pepper.length < 16) throw new Error('invalid_cache_pepper')
  if (!VERSION.test(catalogVersion)) throw new Error('invalid_cache_version')
  let scope: 'public' | 'b2b'
  let fingerprint: string
  if (context.kind === 'public') {
    scope = 'public'
    fingerprint = 'public'
  } else {
    if (
      !UUID.test(context.companyId) ||
      !UUID.test(context.priceListId) ||
      !Number.isSafeInteger(context.priceListVersion) ||
      context.priceListVersion < 1
    )
      throw new Error('invalid_cache_context')
    scope = 'b2b'
    fingerprint = (
      await hmac(
        pepper,
        `owner\u0000${context.companyId.toLowerCase()}\u0000${context.priceListId.toLowerCase()}\u0000${context.priceListVersion}`
      )
    ).slice(0, 32)
  }
  const queryHash = await sha256(canonicalQuery(query))
  return {
    key: `catalog-cache/v1/${scope}/${fingerprint}/${catalogVersion.toLowerCase()}/${queryHash}`,
    scope,
    fingerprint
  }
}

interface Envelope<T> {
  v: 1
  scope: 'public' | 'b2b'
  fingerprint: string
  payload: T
}

export interface CatalogCacheResult<T> {
  value: T
  hit: boolean
  bypassed?: true
}

export function catalogCacheHitRate(hits: number, misses: number): number | null {
  const total = hits + misses
  return total === 0 ? null : hits / total
}

export class CatalogQueryCache {
  constructor(
    private readonly store: CatalogCacheStore,
    private readonly pepper: string,
    private readonly recorder?: CatalogCacheRecorder
  ) {}

  private async note(scope: 'public' | 'b2b', outcome: CatalogCacheOutcome): Promise<void> {
    try {
      await this.recorder?.record(scope, outcome)
    } catch {
      // Statistics must never break catalogue reads.
    }
  }

  async getOrLoad<T>(
    context: CatalogCacheContext,
    query: CatalogCacheQuery,
    catalogVersion: string,
    loader: () => Promise<T>
  ): Promise<CatalogCacheResult<T>> {
    if (context.kind === 'bypass') return { value: await loader(), hit: false, bypassed: true }
    const derived = await deriveCatalogCacheKey(context, query, catalogVersion, this.pepper)
    let rejected = false
    try {
      const raw = await this.store.get(derived.key)
      if (raw !== null) {
        const envelope = JSON.parse(raw) as Partial<Envelope<T>>
        if (
          envelope?.v === 1 &&
          envelope.scope === derived.scope &&
          envelope.fingerprint === derived.fingerprint &&
          envelope.payload !== undefined
        ) {
          await this.note(derived.scope, 'hit')
          return { value: envelope.payload, hit: true }
        }
        rejected = envelope?.v === 1
      }
    } catch {
      // Unreadable entry or store failure: behave as a miss.
    }
    if (rejected) await this.note(derived.scope, 'isolation_rejection')
    await this.note(derived.scope, 'miss')
    const value = await loader()
    if (value !== null && value !== undefined) {
      const envelope: Envelope<T> = { v: 1, scope: derived.scope, fingerprint: derived.fingerprint, payload: value }
      try {
        await this.store.put(
          derived.key,
          JSON.stringify(envelope),
          derived.scope === 'b2b' ? B2B_CACHE_TTL_SECONDS : PUBLIC_CACHE_TTL_SECONDS
        )
      } catch {
        // Cache write failures are non-fatal.
      }
    }
    return { value, hit: false }
  }
}

/** Adapter over the Workers Cache API. Keys live on a synthetic, non-routable origin. */
export function createCacheApiCatalogStore(cache: Cache): CatalogCacheStore {
  const request = (key: string) => new Request(`https://catalog-cache.invalid/${key}`)
  return {
    async get(key) {
      const response = await cache.match(request(key))
      return response ? await response.text() : null
    },
    async put(key, value, ttlSeconds) {
      await cache.put(
        request(key),
        new Response(value, { headers: { 'cache-control': `private, max-age=${ttlSeconds}` } })
      )
    }
  }
}

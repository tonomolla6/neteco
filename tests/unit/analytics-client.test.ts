import { describe, expect, it, vi } from 'vitest'
import {
  ANALYTICS_SEARCH_OMITTED,
  dispatchClientAnalytics,
  prepareClientAnalyticsEvent
} from '../../shared/analytics-client'

const base = {
  eventId: '10000000-0000-4000-8000-000000000052',
  taxonomyVersion: 'v1',
  occurredAt: '2026-10-03T12:00:00.000Z'
}
const event = (name = 'page_view', properties: unknown = { path: '/catalogo' }) => ({ ...base, name, properties })
async function dispatch(input: unknown, path = '/catalogo', consent = true) {
  const sender = vi.fn(async (_event: unknown) => ({ accepted: true })),
    layer: unknown[] = []
  await dispatchClientAnalytics({ consent, path, query: {}, event: input }, sender, layer)
  return { sender, layer }
}
describe('analytics browser own-data boundary before layer and transport', () => {
  it('sends a valid public event once and retains only immutable own schema fields', async () => {
    const input = event(),
      result = await dispatch(input)
    expect(result.sender).toHaveBeenCalledExactlyOnceWith(input)
    expect(result.layer).toEqual([{ event: 'page_view', path: '/catalogo' }])
    expect(Object.isFrozen(result.sender.mock.calls[0]![0])).toBe(true)
    expect(Object.isFrozen(result.layer[0])).toBe(true)
  })
  it.each([
    '/admin/analitica',
    '/cuenta/pedidos/10000000-0000-4000-8000-000000000052',
    '/pedido/10000000-0000-4000-8000-000000000052',
    '/AUTH/login',
    '/api/orders',
    '/checkout',
    '/carrito',
    '/Newsletter/Confirmar',
    '/%2561dmin/analitica'
  ])('never dispatches private %s, including events without a path property', async (path) => {
    const result = await dispatch(event('checkout_started', { itemCount: 1, totalCents: 100 }), path)
    expect(result.sender).not.toHaveBeenCalled()
    expect(result.layer).toEqual([])
  })
  it.each([
    event('page_view', { path: '/catalogo', email: 'private@example.test' }),
    event('page_view', { path: '/catalogo?token=synthetic-bearer' }),
    event('page_view', { path: '/admin/pedidos' }),
    event('web_vital', { path: '/api/orders', metric: 'LCP', value: 100, rating: 'good', navigationType: 'navigate' }),
    event('catalog_viewed', { category: 'private@example.test', page: 1, resultCount: 2 }),
    event('search_completed', { query: 'cliente@example.test', resultCount: 2 }),
    event('search_completed', { query: '600123456', resultCount: 2 }),
    event('search_completed', { query: '12345678Z', resultCount: 2 }),
    event('search_completed', { query: 'ordinary text', resultCount: 2, token: 'synthetic-secret' }),
    event('product_viewed', { productId: '1', variantId: null }),
    event('unknown', {}),
    { ...event(), taxonomyVersion: 'v2' }
  ])('rejects PII, unknown keys and malformed event %# before any sink', async (input) => {
    const result = await dispatch(input)
    expect(result.sender).not.toHaveBeenCalled()
    expect(result.layer).toEqual([])
  })
  it.each(['detergente', 'SYNTHETIC_PRIVATE_BEARER', 'Nombre Apellido'])(
    'omits all free search text %s but preserves the actual result count and Node input contract',
    async (query) => {
      const result = await dispatch(event('search_completed', { query, resultCount: 7 }), '/buscar')
      expect(result.sender).toHaveBeenCalledExactlyOnceWith({
        ...base,
        name: 'search_completed',
        properties: { query: ANALYTICS_SEARCH_OMITTED, resultCount: 7 }
      })
      expect(result.layer).toEqual([{ event: 'search_completed', resultCount: 7 }])
      expect(JSON.stringify(result.layer)).not.toContain(query)
      expect(JSON.stringify(result.sender.mock.calls)).not.toContain(query)
    }
  )
  it('does not execute getters, accept inherited fields or retain caller mutations', async () => {
    let reads = 0
    const input = event()
    Object.defineProperty(input, 'properties', {
      enumerable: true,
      get: () => {
        reads++
        return { path: '/catalogo' }
      }
    })
    const result = await dispatch(input)
    expect(reads).toBe(0)
    expect(result.sender).not.toHaveBeenCalled()
    expect(result.layer).toEqual([])
    expect(prepareClientAnalyticsEvent(Object.create(event()))).toBeNull()
    const normal = event(),
      prepared = prepareClientAnalyticsEvent(normal)!
    normal.properties = { path: '/admin' }
    expect(prepared.layer).toEqual({ event: 'page_view', path: '/catalogo' })
  })
  it('no consent means no getter inspection, layer or sender', async () => {
    const getter = vi.fn(() => {
        throw Error('No getter when consent OFF')
      }),
      input = Object.defineProperty({}, 'properties', { enumerable: true, get: getter }),
      result = await dispatch(input, '/catalogo', false)
    expect(getter).not.toHaveBeenCalled()
    expect(result.sender).not.toHaveBeenCalled()
    expect(result.layer).toEqual([])
  })
  it('transport failure never retries or calls a provider', async () => {
    const sender = vi.fn(async () => {
        throw Error('synthetic unavailable')
      }),
      layer: unknown[] = []
    await dispatchClientAnalytics({ consent: true, path: '/catalogo', query: {}, event: event() }, sender, layer)
    expect(sender).toHaveBeenCalledTimes(1)
    expect(layer).toHaveLength(1)
  })
  it('a frozen layer cannot reject the storefront or prevent the single validated transport', async () => {
    const sender = vi.fn(async () => ({ accepted: true })),
      layer: unknown[] = []
    Object.freeze(layer)
    const input = { consent: true, path: '/catalogo', query: {}, event: event() }
    await dispatchClientAnalytics({ ...input, consent: false }, sender, layer)
    await dispatchClientAnalytics({ ...input, path: '/cuenta/pedidos' }, sender, layer)
    expect(sender).not.toHaveBeenCalled()
    await expect(dispatchClientAnalytics(input, sender, layer)).resolves.toBeUndefined()
    expect(sender).toHaveBeenCalledExactlyOnceWith(input.event)
    expect(layer).toEqual([])
  })
  it('a throwing layer push remains consent/private-gated and does not block or retry transport', async () => {
    const sender = vi.fn(async () => ({ accepted: true })),
      layer: unknown[] = [],
      push = vi.spyOn(layer, 'push').mockImplementation(() => {
        throw Error('Synthetic compatibility sink unavailable')
      })
    const input = { consent: true, path: '/catalogo', query: {}, event: event() }
    await dispatchClientAnalytics({ ...input, consent: false }, sender, layer)
    await dispatchClientAnalytics({ ...input, path: '/admin/analitica' }, sender, layer)
    expect(push).not.toHaveBeenCalled()
    expect(sender).not.toHaveBeenCalled()
    await expect(dispatchClientAnalytics(input, sender, layer)).resolves.toBeUndefined()
    expect(push).toHaveBeenCalledExactlyOnceWith({ event: 'page_view', path: '/catalogo' })
    expect(sender).toHaveBeenCalledExactlyOnceWith(input.event)
    expect(layer).toHaveLength(0)
  })
})

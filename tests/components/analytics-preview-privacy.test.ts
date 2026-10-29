import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAnalytics } from '../../app/composables/useAnalytics'
import '#app/nuxt-vitest-app-entry'

const { transport, consent, route } = vi.hoisted(() => {
  const route: { path: string; query: Record<string, unknown>; params: object; fullPath: string } = {
    path: '/catalogo',
    query: {},
    params: {},
    fullPath: '/catalogo'
  }
  return {
    transport: vi.fn().mockResolvedValue(undefined),
    consent: { value: { analytics: false } },
    route
  }
})
mockNuxtImport('$fetch', () => transport)
mockNuxtImport('useConsent', () => () => ({
  preferences: consent,
  rejectOptional: () => {
    consent.value.analytics = false
    // Simulate the existing CMP's immediate DELETE; the composable must add a
    // second clear only after its already-in-flight POST settles.
    void transport('/api/analytics/session', { method: 'DELETE' }).catch(() => undefined)
  }
}))
mockNuxtImport('useRoute', () => () => route)

type EventName = Parameters<ReturnType<typeof useAnalytics>['track']>[0]
const rejectedSearchProperties: Array<Record<string, string | number | boolean | null>> = [
  { query: 'cliente@example.test', resultCount: 2 },
  { query: 'ordinary text', resultCount: 2, token: 'SYNTHETIC_PRIVATE_BEARER' }
]
let wrapper: Awaited<ReturnType<typeof mountSuspended>> | undefined
let previousDataLayer: unknown
let layer: unknown[]

function properties(event: EventName): Record<string, string | number | boolean | null> {
  if (event === 'web_vital')
    return { path: route.path, metric: 'LCP', value: 1234, rating: 'good', navigationType: 'navigate' }
  if (event === 'product_viewed') return { productId: 1, variantId: 2 }
  if (event === 'search_completed') return { query: 'detergente', resultCount: 3 }
  return { path: route.path }
}
async function render(event: EventName = 'page_view', supplied?: Record<string, string | number | boolean | null>) {
  wrapper = await mountSuspended(
    defineComponent({
      setup() {
        const { track } = useAnalytics()
        const { rejectOptional } = useConsent()
        return () =>
          h('div', [
            h('button', { onClick: () => track(event, supplied ?? properties(event)) }, 'Enviar'),
            h('button', { 'data-testid': 'reject-analytics', onClick: rejectOptional }, 'Rechazar')
          ])
      }
    }),
    { route: false }
  )
  // Enable consent only after the Nuxt harness has bootstrapped. The test
  // measures the real composable action, not unrelated initialization traffic.
  consent.value.analytics = true
  transport.mockClear()
  layer.splice(0)
  return wrapper
}

beforeEach(() => {
  consent.value.analytics = false
  Object.assign(route, { path: '/contenido/guia', query: {}, fullPath: '/contenido/guia' })
  transport.mockReset().mockResolvedValue(undefined)
  previousDataLayer = Reflect.get(window, 'dataLayer')
  layer = []
  Reflect.set(window, 'dataLayer', layer)
})
afterEach(() => {
  consent.value.analytics = false
  wrapper?.unmount()
  wrapper = undefined
  if (previousDataLayer === undefined) Reflect.deleteProperty(window, 'dataLayer')
  else Reflect.set(window, 'dataLayer', previousDataLayer)
})

describe('actual client analytics respects private CMS previews', () => {
  it.each(['/recursos', '/recursos/guia-publicada'])(
    'reports only the consented public resource path %s without its query or editorial/search text',
    async (path) => {
      Object.assign(route, {
        path,
        query: { q: 'SYNTHETIC_PRIVATE_SEARCH', category: 'SYNTHETIC_CATEGORY_QUERY' },
        fullPath: path + '?q=SYNTHETIC_PRIVATE_SEARCH&category=SYNTHETIC_CATEGORY_QUERY'
      })
      const view = await render()
      await view.get('button').trigger('click')
      await flushPromises()
      expect(transport).toHaveBeenCalledExactlyOnceWith('/api/analytics/events', {
        method: 'POST',
        retry: 0,
        credentials: 'same-origin',
        referrerPolicy: 'no-referrer',
        body: expect.objectContaining({ name: 'page_view', taxonomyVersion: 'v1', properties: { path } })
      })
      expect(layer).toEqual([{ event: 'page_view', path }])
      expect(JSON.stringify([transport.mock.calls, layer])).not.toContain('SYNTHETIC_PRIVATE_SEARCH')
      expect(JSON.stringify([transport.mock.calls, layer])).not.toContain('SYNTHETIC_CATEGORY_QUERY')
    }
  )
  it.each(['/recursos', '/recursos/guia-publicada'])(
    'does not measure resource path %s without explicit live analytics consent',
    async (path) => {
      Object.assign(route, { path, query: {}, fullPath: path })
      const view = await render()
      consent.value.analytics = false
      await view.get('button').trigger('click')
      await flushPromises()
      expect(transport).not.toHaveBeenCalled()
      expect(layer).toEqual([])
    }
  )
  it.each(['/newsletter/preferencias', '/newsletter/confirmar', '/newsletter/baja', '/%6eewsletter/preferencias'])(
    'does not dispatch private newsletter %s before or after token removal',
    async (path) => {
      route.path = path
      route.query = { token: 'synthetic-newsletter-purpose-bearer' }
      const view = await render('web_vital')
      await view.get('button').trigger('click')
      await flushPromises()
      expect(transport).not.toHaveBeenCalled()
      expect(layer).toEqual([])
      route.query = {}
      await view.get('button').trigger('click')
      await flushPromises()
      expect(transport).not.toHaveBeenCalled()
      expect(layer).toEqual([])
    }
  )
  it.each(['page_view', 'product_viewed', 'web_vital'] as const)(
    'does not send %s to the API or dataLayer despite analytics consent',
    async (event) => {
      route.query = { preview: 'synthetic-sealed-preview-bearer' }
      const view = await render(event)
      await view.get('button').trigger('click')
      await flushPromises()
      expect(transport).not.toHaveBeenCalled()
      expect(layer).toEqual([])
    }
  )
  it.each(['', null, undefined, ['first', 'second']])(
    'also suppresses malformed or empty own preview parameters %#',
    async (preview) => {
      route.query = { preview }
      const view = await render()
      await view.get('button').trigger('click')
      await flushPromises()
      expect(transport).not.toHaveBeenCalled()
      expect(layer).toEqual([])
    }
  )
  it.each(['/contenido/guia', '/catalogo', '/producto/limpiador'])(
    'still emits a consented public page %s without a preview',
    async (path) => {
      route.path = path
      const view = await render()
      await view.get('button').trigger('click')
      await flushPromises()
      expect(transport).toHaveBeenCalledOnce()
      expect(transport).toHaveBeenCalledWith('/api/analytics/events', {
        method: 'POST',
        retry: 0,
        credentials: 'same-origin',
        referrerPolicy: 'no-referrer',
        body: expect.objectContaining({
          name: 'page_view',
          taxonomyVersion: 'v1',
          properties: { path }
        })
      })
      expect(layer).toEqual([{ event: 'page_view', path }])
    }
  )
  it('checks the live route at invocation, not only at composable initialization', async () => {
    const view = await render()
    route.query = { preview: 'new-private-preview' }
    await view.get('button').trigger('click')
    await flushPromises()
    expect(transport).not.toHaveBeenCalled()
    expect(layer).toEqual([])
    route.query = {}
    await view.get('button').trigger('click')
    await flushPromises()
    expect(transport).toHaveBeenCalledOnce()
    expect(layer).toHaveLength(1)
  })
  it('never reads a preview getter or leaks its bearer into analytics', async () => {
    const getter = vi.fn(() => {
      throw new Error('private bearer accessor')
    })
    route.query = Object.defineProperty({}, 'preview', { enumerable: true, get: getter })
    const view = await render()
    await view.get('button').trigger('click')
    await flushPromises()
    expect(getter).not.toHaveBeenCalled()
    expect(transport).not.toHaveBeenCalled()
    expect(layer).toEqual([])
  })
  it('does not start public analytics without the existing explicit consent', async () => {
    const view = await render()
    consent.value.analytics = false
    await view.get('button').trigger('click')
    await flushPromises()
    expect(transport).not.toHaveBeenCalled()
    expect(layer).toEqual([])
  })
  it.each([
    '/admin/analitica',
    '/cuenta/pedidos/10000000-0000-4000-8000-000000000052',
    '/pedido/10000000-0000-4000-8000-000000000052',
    '/api/orders',
    '/checkout',
    '/carrito',
    '/AUTH/login',
    '/%2561dmin/pedidos'
  ])('never sends private %s to either client sink', async (path) => {
    route.path = path
    const view = await render('product_viewed')
    await view.get('button').trigger('click')
    await flushPromises()
    expect(transport).not.toHaveBeenCalled()
    expect(layer).toEqual([])
  })
  it.each(rejectedSearchProperties)(
    'rejects personal/expanded search payload %# before layer or transport',
    async (props) => {
      route.path = '/buscar'
      const view = await render('search_completed', props)
      await view.get('button').trigger('click')
      await flushPromises()
      expect(transport).not.toHaveBeenCalled()
      expect(layer).toEqual([])
    }
  )
  it('also rejects an explicit private event path when the current route is public', async () => {
    route.path = '/catalogo'
    const view = await render('page_view', { path: '/api/orders/10000000-0000-4000-8000-000000000052' })
    await view.get('button').trigger('click')
    await flushPromises()
    expect(transport).not.toHaveBeenCalled()
    expect(layer).toEqual([])
  })
  it('never transmits free search text or URL queries while retaining only the actual result count', async () => {
    route.path = '/buscar'
    route.query = { q: 'SYNTHETIC_PRIVATE_BEARER' }
    route.fullPath = '/buscar?q=SYNTHETIC_PRIVATE_BEARER'
    const view = await render('search_completed', { query: 'SYNTHETIC_PRIVATE_BEARER', resultCount: 9 })
    await view.get('button').trigger('click')
    await flushPromises()
    expect(transport).toHaveBeenCalledWith('/api/analytics/events', {
      method: 'POST',
      retry: 0,
      credentials: 'same-origin',
      referrerPolicy: 'no-referrer',
      body: expect.objectContaining({ name: 'search_completed', properties: { query: '[omitted]', resultCount: 9 } })
    })
    expect(layer).toEqual([{ event: 'search_completed', resultCount: 9 }])
    expect(JSON.stringify(transport.mock.calls)).not.toContain('SYNTHETIC_PRIVATE_BEARER')
  })
  it('clears a potential late acquisition cookie after a CMP withdrawal, without timer or POST retry', async () => {
    const view = await render()
    let settle!: () => void
    const pending = new Promise<void>((resolve) => {
      settle = resolve
    })
    transport.mockImplementation((path) => (path === '/api/analytics/events' ? pending : Promise.resolve(undefined)))
    await view.get('button').trigger('click')
    expect(transport.mock.calls.map((call) => call[0])).toEqual(['/api/analytics/events'])
    await view.get('[data-testid="reject-analytics"]').trigger('click')
    expect(transport.mock.calls.map((call) => call[0])).toEqual(['/api/analytics/events', '/api/analytics/session'])
    settle()
    await flushPromises()
    expect(transport.mock.calls.map((call) => call[0])).toEqual([
      '/api/analytics/events',
      '/api/analytics/session',
      '/api/analytics/session'
    ])
    expect(transport.mock.calls[2]![1]).toEqual({
      method: 'DELETE',
      retry: 0,
      credentials: 'same-origin',
      referrerPolicy: 'no-referrer'
    })
    await view.get('button').trigger('click')
    await flushPromises()
    expect(transport).toHaveBeenCalledTimes(3)
  })
})

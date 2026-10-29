import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { ref } from 'vue'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import Panel from '../../app/components/PromotionalBlocks.vue'
import { promotionalContentSchema } from '../../shared/promotional-content'
import type { PromotionalContext } from '../../shared/promotional-content'
import type { CmsPublicPage } from '../../shared/cms-publication'
import '#app/nuxt-vitest-app-entry'

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  track: vi.fn(),
  runtime: vi.fn(() => ({
    app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
    public: { serverRuntime: 'cloudflare' }
  }))
}))
const consent = ref({ analytics: false })
mockNuxtImport('useRequestFetch', () => () => mocks.request)
mockNuxtImport('useRuntimeConfig', () => mocks.runtime)
mockNuxtImport('useAnalytics', () => () => ({ track: mocks.track }))
mockNuxtImport('useConsent', () => () => ({ preferences: consent }))
const PAGE = '10000000-0000-4000-8000-000000000044',
  RELEASE = '20000000-0000-4000-8000-000000000044',
  CTA = '30000000-0000-4000-8000-000000000044'
const context = { placement: 'home' as const, path: '/' }
const result = () =>
  promotionalContentSchema.parse({
    source: 'cloudflare',
    placement: 'home',
    evaluatedAt: '2026-10-09T12:00:00Z',
    items: [
      {
        pageId: PAGE,
        publicationId: RELEASE,
        version: 1,
        title: 'Información revisada',
        format: 'bar',
        blocks: [{ id: CTA, type: 'cta', label: 'Condiciones de envío', href: '/envios' }],
        media: {}
      }
    ]
  })
let visibility: IntersectionObserverCallback | undefined
const mounted: Awaited<ReturnType<typeof mountSuspended>>[] = []
beforeEach(() => {
  consent.value = { analytics: false }
  mocks.request.mockReset().mockResolvedValue(result())
  mocks.track.mockReset()
  mocks.runtime.mockReturnValue({
    app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
    public: { serverRuntime: 'cloudflare' }
  })
  visibility = undefined
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(callback: IntersectionObserverCallback) {
        visibility = callback
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
})
afterEach(() => {
  mounted.splice(0).forEach((w) => w.unmount())
  vi.unstubAllGlobals()
})
async function render(props: { context?: PromotionalContext; previewPage?: CmsPublicPage } = {}) {
  const wrapper = await mountSuspended(Panel, { props: { context, ...props } })
  mounted.push(wrapper)
  await flushPromises()
  return wrapper
}
function visible(wrapper: Awaited<ReturnType<typeof render>>) {
  const target = wrapper.get('[data-promotional-item]').element
  visibility?.([{ target, isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver)
}
it('renders only confirmed current content with real accessible links and no metric on fetch', async () => {
  const w = await render()
  expect(mocks.request).toHaveBeenCalledWith(
    '/api/promotional-content',
    expect.objectContaining({ query: context, retry: 0, cache: 'no-store' })
  )
  expect(w.get('a[href="/envios"]').text()).toBe('Condiciones de envío')
  expect(w.get('[data-promotional-item]').attributes('data-format')).toBe('bar')
  expect(mocks.track).not.toHaveBeenCalled()
})
it('measures one visible consented impression per publication and a separate CTA click', async () => {
  const w = await render()
  visible(w)
  expect(mocks.track).not.toHaveBeenCalled()
  consent.value = { analytics: true }
  await flushPromises()
  visible(w)
  visible(w)
  expect(mocks.track).toHaveBeenCalledTimes(1)
  expect(mocks.track).toHaveBeenCalledWith('promotional_impression', {
    pageId: PAGE,
    publicationId: RELEASE,
    version: 1,
    placement: 'home',
    blockId: null
  })
  await w.get('a[href="/envios"]').trigger('click')
  expect(mocks.track).toHaveBeenLastCalledWith('promotional_click', {
    pageId: PAGE,
    publicationId: RELEASE,
    version: 1,
    placement: 'home',
    blockId: CTA
  })
  expect(JSON.stringify(mocks.track.mock.calls)).not.toContain('/envios')
  consent.value = { analytics: false }
  await w.get('a[href="/envios"]').trigger('click')
  expect(mocks.track).toHaveBeenCalledTimes(2)
})
it('does not fetch or measure on the preserved Node runtime', async () => {
  mocks.runtime.mockReturnValue({
    app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
    public: { serverRuntime: 'node' }
  })
  const w = await render()
  expect(mocks.request).not.toHaveBeenCalled()
  expect(w.find('[data-promotional-item]').exists()).toBe(false)
  expect(mocks.track).not.toHaveBeenCalled()
})
it('rejects mismatched placement or unsafe returned CTA rather than rendering it', async () => {
  mocks.request.mockResolvedValue({ ...result(), placement: 'product' })
  const w = await render()
  expect(w.find('[data-promotional-item]').exists()).toBe(false)
  expect(w.find('[data-promotional-unavailable]').exists()).toBe(true)
  expect(mocks.track).not.toHaveBeenCalled()
})

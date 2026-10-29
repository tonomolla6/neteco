import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { createHead } from '@unhead/vue/client'
import { flushPromises } from '@vue/test-utils'
import { defineComponent, h, reactive, ref } from 'vue'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import App from '../../app/app.vue'
import Search from '../../app/pages/buscar.vue'
import '#app/nuxt-vitest-app-entry'

const mocks = vi.hoisted(() => ({
  head: undefined as ReturnType<typeof createHead> | undefined,
  route: vi.fn(() => ({ path: '/', query: {}, params: {}, fullPath: '/' })),
  infinite: vi.fn(),
  runtime: vi.fn(() => ({
    app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
    public: { baseUrl: 'https://tienda-configurada.example.test/', serverRuntime: 'cloudflare' }
  }))
}))
const realHead = await vi.hoisted(() => vi.importActual<typeof import('@unhead/vue')>('@unhead/vue'))
mockNuxtImport('useRoute', () => mocks.route)
mockNuxtImport('useRuntimeConfig', () => mocks.runtime)
mockNuxtImport('useInfiniteProducts', () => mocks.infinite)
// Bind the real Unhead composables to this mount's manager, not Nuxt's bootstrap app.
mockNuxtImport(
  'useHead',
  () => (input: Parameters<typeof realHead.useHead>[0]) => realHead.useHead(input, { head: mocks.head })
)
mockNuxtImport(
  'useSeoMeta',
  () => (input: Parameters<typeof realHead.useSeoMeta>[0]) => realHead.useSeoMeta(input, { head: mocks.head })
)
mockNuxtImport('useRouter', () => () => ({
  replace: vi.fn(),
  resolve: () => ({ href: '/' }),
  afterEach: () => () => undefined,
  beforeResolve: () => () => undefined
}))
mockNuxtImport('useAnalytics', () => () => ({ track: async () => undefined }))
const mounted: Awaited<ReturnType<typeof mountSuspended>>[] = []
const origin = 'https://tienda-configurada.example.test'
const PassThrough = defineComponent({
  setup:
    (_, { slots }) =>
    () =>
      slots.default?.()
})
beforeEach(() => {
  mocks.runtime.mockReturnValue({
    app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
    public: { baseUrl: `${origin}/`, serverRuntime: 'cloudflare' }
  })
  mocks.infinite.mockReturnValue({
    items: ref([]),
    total: ref(0),
    facets: ref(null),
    status: ref('success'),
    loadingMore: ref(false),
    canLoadMore: ref(false),
    loadMore: vi.fn(),
    sentinel: ref(null)
  })
})
afterEach(() => mounted.splice(0).forEach((wrapper) => wrapper.unmount()))
async function headFor(path: string, query: Record<string, string>, search = false) {
  const route = reactive({ path, query, params: {}, fullPath: path })
  mocks.route.mockReturnValue(route)
  const head = createHead({ document: undefined })
  mocks.head = head
  const wrapper = await mountSuspended(App, {
    global: {
      stubs: {
        UApp: PassThrough,
        NuxtLayout: PassThrough,
        NuxtPage: search ? defineComponent({ setup: () => () => h(Search) }) : true,
        NuxtLoadingIndicator: true,
        UIcon: true,
        UButton: true,
        SearchBox: true,
        ProductFilters: true,
        ProductCard: true,
        ProductListRow: true,
        ViewToggle: true
      }
    }
  })
  mounted.push(wrapper)
  await flushPromises()
  return { head, route }
}
it.each(['/buscar', '/buscar/'])(
  'keeps real search %s noindex without canonical or language alternates targeting a noindex page',
  async (path) => {
    const { head } = await headFor(path, { q: 'lejia', utm_source: 'test', sort: 'price_asc' }, true)
    const tags = await head.resolveTags()
    expect(tags).toContainEqual(
      expect.objectContaining({
        tag: 'meta',
        props: expect.objectContaining({ name: 'robots', content: 'noindex, follow' })
      })
    )
    expect(
      tags.filter((tag) => tag.tag === 'link' && ['canonical', 'alternate'].includes(String(tag.props.rel)))
    ).toEqual([])
  }
)
it.each([
  ['/catalogo', { page: '2', sort: 'price_asc', utm_source: 'test' }, '/catalogo?page=2'],
  ['/categoria/higiene', { page: '3', sort: 'price_desc', utm_source: 'test' }, '/categoria/higiene?page=3'],
  ['/producto/jabon', { sku: 'SKU-2', utm_source: 'test' }, '/producto/jabon']
] as const)('preserves configured public origin and clean canonical for %s', async (path, query, expected) => {
  const { head } = await headFor(path, { ...query })
  const tags = await head.resolveTags()
  expect(tags.filter((tag) => tag.tag === 'link' && tag.props.rel === 'canonical')).toEqual([
    expect.objectContaining({ props: expect.objectContaining({ href: `${origin}${expected}` }) })
  ])
  expect(
    tags.filter((tag) => tag.tag === 'link' && tag.props.rel === 'alternate').map((tag) => tag.props.href)
  ).toEqual([`${origin}${expected}`, `${origin}${expected}`])
})
it('retracts and restores the existing head entry across reactive catalog/search route changes', async () => {
  const { head, route } = await headFor('/catalogo', { page: '2' })
  const links = async () => (await head.resolveTags()).filter((tag) => tag.tag === 'link')
  expect(await links()).toHaveLength(3)
  route.path = '/buscar'
  route.query = { q: 'lejia' }
  await flushPromises()
  expect(await links()).toEqual([])
  route.path = '/catalogo'
  route.query = { page: '3', utm_source: 'test' }
  await flushPromises()
  expect(await links()).toHaveLength(3)
  expect(await links()).toContainEqual(
    expect.objectContaining({ props: expect.objectContaining({ rel: 'canonical', href: `${origin}/catalogo?page=3` }) })
  )
})

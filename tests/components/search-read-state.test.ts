import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { defineComponent, h, reactive, ref } from 'vue'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Search from '../../app/pages/buscar.vue'
import '#app/nuxt-vitest-app-entry'

const { fetchMock, routeMock, seoMock, router } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  routeMock: vi.fn(),
  seoMock: vi.fn(),
  router: {
    replace: vi.fn(),
    resolve: vi.fn(() => ({ href: '/' })),
    afterEach: vi.fn(() => () => undefined),
    beforeResolve: vi.fn(() => () => undefined)
  }
}))
mockNuxtImport('useFetch', () => fetchMock)
mockNuxtImport('useRoute', () => routeMock)
mockNuxtImport('useRouter', () => () => router)
mockNuxtImport('useSeoMeta', () => seoMock)
mockNuxtImport('useRuntimeConfig', () => () => ({
  app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
  public: { serverRuntime: 'cloudflare', baseUrl: 'http://localhost:3000' }
}))
mockNuxtImport('useAnalytics', () => () => ({ track: async () => undefined }))
const Button = defineComponent({
  inheritAttrs: false,
  props: ['to'],
  setup:
    (props, { attrs, slots }) =>
    () =>
      props.to ? h(Link, { ...attrs, to: props.to }, slots) : h('button', attrs, slots.default?.())
})
const Grid = defineComponent({
  props: ['items'],
  setup: (props) => () => h('div', { 'data-grid': '' }, JSON.stringify(props.items))
})
const Link = defineComponent({
  props: ['to'],
  setup:
    (props, { slots }) =>
    () => {
      const target = new URL('/buscar', 'https://search.neteco.test')
      if (typeof props.to === 'string') return h('a', { href: props.to }, slots.default?.())
      for (const [key, value] of Object.entries(props.to?.query ?? {}))
        if (value !== undefined) target.searchParams.set(key, String(value))
      return h('a', { href: target.pathname + target.search }, slots.default?.())
    }
})
const mounted: Array<{ unmount(): void }> = []
let state: ReturnType<typeof ref<'pending' | 'success' | 'error'>>
let data: ReturnType<typeof ref<Record<string, unknown> | undefined>>
let refresh: ReturnType<typeof vi.fn>
let params: { value: Record<string, unknown> }
function empty() {
  return { items: [], total: 0, pages: 1, page: 1, facets: null }
}
async function mount() {
  const wrapper = await mountSuspended(Search, {
    global: {
      stubs: {
        UButton: Button,
        NuxtLink: Link,
        UIcon: true,
        SearchBox: true,
        ViewToggle: true,
        ProductGrid: Grid,
        ProductFilters: true,
        Teleport: true
      }
    }
  })
  mounted.push(wrapper)
  return wrapper
}
function retry(wrapper: Awaited<ReturnType<typeof mount>>) {
  return wrapper.findAll('button').find((button) => button.text() === 'Reintentar búsqueda')
}
beforeEach(() => {
  vi.clearAllMocks()
  setActivePinia(createPinia())
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
  routeMock.mockReturnValue(
    reactive({
      query: { q: 'jabón', brand: 'NETECO', min: '12', sort: 'price_asc' },
      params: {},
      fullPath: '/buscar?q=jabón&brand=NETECO&min=12&sort=price_asc'
    })
  )
  state = ref('error')
  data = ref(undefined)
  refresh = vi.fn(async () => {
    state.value = 'success'
    data.value = empty()
  })
  fetchMock.mockImplementation((_url, options) => {
    params = options.params
    return { data, status: state, error: ref(null), refresh }
  })
})
afterEach(() => {
  mounted.splice(0).forEach((wrapper) => wrapper.unmount())
  vi.unstubAllGlobals()
})
describe('search actual page read states and explicit GET retry', () => {
  it('offers real previous/next links from page two preserving search and brand, without mixing other page rows', async () => {
    routeMock.mockReturnValue(
      reactive({
        query: { q: 'guantes', brand: 'X', page: '2' },
        params: {},
        fullPath: '/buscar?q=guantes&brand=X&page=2'
      })
    )
    state.value = 'success'
    data.value = { items: [{ id: 22, name: 'Guantes sólo página dos' }], total: 30, pages: 3, page: 2, facets: null }
    const wrapper = await mount()
    expect(params.value).toMatchObject({ q: 'guantes', brand: 'X', page: 2 })
    expect(JSON.parse(wrapper.get('[data-grid]').text())).toEqual([{ id: 22, name: 'Guantes sólo página dos' }])
    const previous = wrapper.findAll('a').find((link) => link.text().trim() === 'Anterior')
    const next = wrapper.findAll('a').find((link) => link.text().trim() === 'Siguiente')
    expect(previous, 'page two needs a real previous-page anchor').toBeDefined()
    expect(next, 'page two needs a real next-page anchor').toBeDefined()
    const previousUrl = new URL(previous!.attributes('href')!, 'https://search.neteco.test')
    const nextUrl = new URL(next!.attributes('href')!, 'https://search.neteco.test')
    expect(previousUrl.pathname).toBe('/buscar')
    expect(Object.fromEntries(previousUrl.searchParams)).toEqual({ q: 'guantes', brand: 'X' })
    expect(nextUrl.pathname).toBe('/buscar')
    expect(Object.fromEntries(nextUrl.searchParams)).toEqual({ q: 'guantes', brand: 'X', page: '3' })
    expect(wrapper.text()).toContain('Página 2 de 3')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(refresh).not.toHaveBeenCalled()
    // Observe the real page's SEO boundary: pagination must not index search.
    expect(seoMock).toHaveBeenCalledWith(expect.objectContaining({ robots: 'noindex, follow' }))
  })
  it('resets the page when changing a filter while retaining search and brand', async () => {
    routeMock.mockReturnValue(
      reactive({
        query: { q: 'guantes', brand: 'X', page: '2' },
        params: {},
        fullPath: '/buscar?q=guantes&brand=X&page=2'
      })
    )
    state.value = 'success'
    data.value = { items: [{ id: 22, name: 'Guantes sólo página dos' }], total: 30, pages: 3, page: 2, facets: null }
    const wrapper = await mount()
    await flushPromises()
    router.replace.mockClear()
    await wrapper.get('select[aria-label="Ordenar por"]').setValue('price_desc')
    await flushPromises()
    expect(router.replace).toHaveBeenCalledTimes(1)
    expect(router.replace).toHaveBeenCalledWith({ query: { q: 'guantes', brand: 'X', sort: 'price_desc' } })
    expect(seoMock).toHaveBeenCalledWith(expect.objectContaining({ robots: 'noindex, follow' }))
  })
  it.each([1, 3])('only offers valid navigation at page %i of three', async (page) => {
    routeMock.mockReturnValue(
      reactive({
        query: { q: 'guantes', brand: 'X', ...(page > 1 ? { page: String(page) } : {}) },
        params: {},
        fullPath: `/buscar?q=guantes&brand=X&page=${page}`
      })
    )
    state.value = 'success'
    data.value = { items: [{ id: page, name: `Guantes página ${page}` }], total: 30, pages: 3, page, facets: null }
    const wrapper = await mount()
    const previous = wrapper.findAll('a').find((link) => link.text().trim() === 'Anterior')
    const next = wrapper.findAll('a').find((link) => link.text().trim() === 'Siguiente')
    expect(Boolean(previous)).toBe(page > 1)
    expect(Boolean(next)).toBe(page < 3)
    const target = new URL((previous ?? next)!.attributes('href')!, 'https://search.neteco.test')
    expect(Object.fromEntries(target.searchParams)).toEqual({ q: 'guantes', brand: 'X', page: '2' })
  })
  it('does not describe failed reads as empty or zero results', async () => {
    const wrapper = await mount()
    expect(wrapper.find('[role="alert"]').exists()).toBe(true)
    expect(wrapper.text()).not.toContain('No hemos encontrado nada')
    expect(wrapper.text()).not.toContain('0 productos encontrados')
    expect(retry(wrapper)?.exists()).toBe(true)
  })
  it('shows loading, not an empty or zero result', async () => {
    state.value = 'pending'
    const wrapper = await mount()
    expect(wrapper.text()).toContain('Buscando productos')
    expect(wrapper.text()).not.toContain('No hemos encontrado nada')
    expect(wrapper.text()).not.toContain('0 productos encontrados')
  })
  it('describes an empty result only after a successful read', async () => {
    state.value = 'success'
    data.value = empty()
    const wrapper = await mount()
    expect(wrapper.text()).toContain('No hemos encontrado nada')
    expect(wrapper.text()).toContain('0 productos encontrados')
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
  })
  it('retries the existing GET once, preserving query, filters and sort', async () => {
    const wrapper = await mount()
    // Nuxt's mount harness replaces its bootstrap route; only retry navigation is under test.
    router.replace.mockClear()
    let finish!: () => void
    refresh.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = () => {
            data.value = empty()
            state.value = 'success'
            resolve()
          }
        })
    )
    const button = retry(wrapper)
    expect(button).toBeDefined()
    await button!.trigger('click')
    await button!.trigger('click')
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(params.value).toMatchObject({
      q: 'jabón',
      brand: 'NETECO',
      price_min: 12,
      sort: 'price_asc',
      page: 1,
      limit: 12
    })
    expect(router.replace).not.toHaveBeenCalled()
    finish()
    await flushPromises()
    expect(wrapper.text()).toContain('No hemos encontrado nada')
  })
  it('keeps failure visible when retry also fails, without automatic retry', async () => {
    const wrapper = await mount()
    refresh.mockImplementation(async () => {
      state.value = 'error'
    })
    expect(retry(wrapper)).toBeDefined()
    await retry(wrapper)!.trigger('click')
    await flushPromises()
    expect(wrapper.find('[role="alert"]').exists()).toBe(true)
    expect(wrapper.text()).not.toContain('No hemos encontrado nada')
    expect(refresh).toHaveBeenCalledTimes(1)
  })
  it('does not present cached rows or their count as current after read failure', async () => {
    data.value = { ...empty(), items: [{ id: 1, name: 'Producto anterior' }], total: 30, pages: 3, page: 2 }
    const wrapper = await mount()
    expect(wrapper.find('[data-grid]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('1 producto encontrado')
    expect(wrapper.find('[role="alert"]').exists()).toBe(true)
    expect(wrapper.find('nav[aria-label="Páginas de resultados de búsqueda"]').exists()).toBe(false)
  })
})

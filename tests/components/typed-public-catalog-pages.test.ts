import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { defineComponent, h, reactive, ref } from 'vue'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Catalog from '../../app/pages/catalogo.vue'
import Search from '../../app/pages/buscar.vue'
import Category from '../../app/pages/categoria/[slug].vue'
import Product from '../../app/pages/producto/[slug].vue'
import '#app/nuxt-vitest-app-entry'

const { fetchMock, infiniteMock, routeMock, runtimeMock, routerMock } = vi.hoisted(() => ({
  runtimeMock: vi.fn(() => ({
    app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
    public: { serverRuntime: 'cloudflare', mediaGoverned: false, baseUrl: 'http://localhost:3000' }
  })),
  fetchMock: vi.fn(),
  infiniteMock: vi.fn(),
  routeMock: vi.fn(),
  routerMock: {
    replace: vi.fn(),
    resolve: vi.fn(() => ({ href: '/' })),
    afterEach: vi.fn(() => () => undefined),
    beforeResolve: vi.fn(() => () => undefined)
  }
}))
mockNuxtImport('useFetch', () => fetchMock)
mockNuxtImport('useRuntimeConfig', () => runtimeMock)
mockNuxtImport('useInfiniteProducts', () => infiniteMock)
mockNuxtImport('useRoute', () => routeMock)
mockNuxtImport('useRouter', () => () => routerMock)
mockNuxtImport('useAnalytics', () => () => ({ track: async () => undefined }))
mockNuxtImport('useImage', () => () => (source: string) => source)
mockNuxtImport('useToast', () => () => ({ add: () => undefined }))
mockNuxtImport('useUserSession', () => () => ({
  ready: ref(true),
  loggedIn: ref(false),
  user: ref(null),
  session: ref(null),
  fetch: async () => undefined,
  clear: async () => undefined
}))
const ID = 'c1000000-0000-4000-8000-000000000007'
const typed = [{ definitionId: ID, values: [false] }],
  encoded = JSON.stringify(typed)
const node = { id: 7, name: 'Higiene', slug: 'higiene', parentId: null, count: 1, children: [] }
let route: { query: Record<string, unknown>; params: { slug: string }; fullPath: string }
const Filters = defineComponent({
  name: 'ProductFilters',
  props: ['filters', 'facets'],
  emits: ['update:filters'],
  setup: () => () => h('div', { 'data-public-filters': '' })
})
const stubs = {
  ProductFilters: Filters,
  ProductCard: true,
  ProductListRow: true,
  ProductVisual: true,
  PublishedProductImage: true,
  NuxtImg: true,
  UIcon: true,
  SearchBox: true,
  ViewToggle: true,
  UButton: true,
  Teleport: true
}
const mounted: Array<{ unmount(): void }> = []
function product() {
  return {
    id: 1,
    name: 'Producto',
    slug: 'producto',
    brand: 'NETECO',
    shortDesc: null,
    description: null,
    usage: null,
    badges: [],
    visual: { type: 'garrafa', color: '#000000' },
    image: null,
    datasheet: null,
    attrs: [{ k: 'Legacy', v: 'Conservar' }],
    regulatory: {},
    siblings: [],
    breadcrumb: [],
    related: [],
    documents: [],
    typedAttrs: [
      {
        definitionId: ID,
        revision: 1,
        code: 'zero',
        kind: 'number',
        label: '<b>Número</b>',
        value: 0,
        displayValue: '0'
      },
      {
        definitionId: 'c2000000-0000-4000-8000-000000000007',
        revision: 1,
        code: 'boolean',
        kind: 'boolean',
        label: 'Booleano',
        value: false,
        displayValue: 'No'
      }
    ],
    variants: [
      {
        uuid: 'v1',
        id: 11,
        format: 'Botella 1 L',
        sku: 'SKU',
        ean: null,
        gtin: null,
        mpn: null,
        price: 500,
        compareAtPrice: null,
        referencePrice30d: null,
        priceTiers: [],
        pricingVersion: 'fixture',
        netPrice: 413,
        taxRateBasisPoints: 2100,
        stock: 25,
        units: 1,
        unitBase: 'volume',
        unitLabel: 'L',
        unitsPerCase: 1,
        casesPerPallet: null,
        minimumQuantity: 1,
        maximumQuantity: null,
        quantityIncrement: 1,
        backorderAllowed: false,
        leadTimeDays: null,
        color: null,
        image: null
      }
    ]
  }
}
// useFetch receives a string or a getter (reactive URL); normalise before inspecting it.
const fetchPath = (source: string | (() => string)) => (typeof source === 'function' ? source() : source)

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  route = reactive({
    query: { q: 'jabón', typed: encoded },
    params: { slug: 'higiene' },
    fullPath: '/catalogo?typed=initial'
  })
  routeMock.mockReturnValue(route)
  fetchMock.mockImplementation((source: string | (() => string)) => {
    const path = fetchPath(source)
    return {
      data: ref(
        path.endsWith('/reviews/summary')
          ? null
          : path.startsWith('/api/products/')
            ? product()
            : { roots: [node], flat: [node] }
      ),
      error: ref(null),
      status: ref('success')
    }
  })
  infiniteMock.mockImplementation(() => ({
    items: ref([]),
    total: ref(0),
    page: ref(1),
    pages: ref(1),
    facets: ref({
      brands: [],
      badges: [],
      envases: [],
      capacidades: [],
      tallas: [],
      colores: [],
      medidas: [],
      acabados: [],
      categories: [],
      price: null,
      typed: [
        {
          definitionId: ID,
          categoryId: 7,
          code: 'boolean',
          kind: 'boolean',
          label: 'Reutilizable',
          values: [{ value: false, label: 'No', n: 2 }]
        }
      ]
    }),
    status: ref('success'),
    loadingMore: ref(false),
    canLoadMore: ref(false),
    loadMore: vi.fn(),
    sentinel: ref(null)
  }))
})
afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount()
})
async function mount(page: typeof Catalog) {
  const wrapper = await mountSuspended(page, { global: { stubs } })
  mounted.push(wrapper)
  return wrapper
}

describe.each([
  ['catalogue', Catalog],
  ['search', Search],
  ['category', Category]
] as const)('public typed %s wiring', (_name, page) => {
  it('forwards initial and back/forward URL state to API, exposes dynamic-only filters and removable pills', async () => {
    const wrapper = await mount(page)
    expect(JSON.parse(infiniteMock.mock.calls[0]![0].value.typed)).toEqual(typed)
    expect(wrapper.find('[data-public-filters]').exists()).toBe(true)
    expect(wrapper.findAll('[data-typed-pill]').length).toBeGreaterThan(0)
    expect(wrapper.get('[data-typed-pill]').text()).toContain('No')
    route.query.typed = JSON.stringify([{ definitionId: ID, values: [true] }])
    route.fullPath = '/next'
    await flushPromises()
    expect(JSON.parse(infiniteMock.mock.calls[0]![0].value.typed)[0].values).toEqual([true])
    route.query.typed = encoded
    route.fullPath = '/back'
    await flushPromises()
    expect(JSON.parse(infiniteMock.mock.calls[0]![0].value.typed)).toEqual(typed)
    await wrapper.get('[data-typed-pill]').trigger('click')
    await flushPromises()
    expect(infiniteMock.mock.calls[0]![0].value.typed).toBeUndefined()
    expect(routerMock.replace.mock.calls.at(-1)![0].query.typed).toBeUndefined()
  })
  it('carries «Solo en stock» from the URL to the API, the URL and a removable pill', async () => {
    route.query.stock = '1'
    const wrapper = await mount(page)
    expect(infiniteMock.mock.calls[0]![0].value.stock).toBe('1')
    const pill = wrapper.findAll('button').find((button) => button.text().startsWith('Solo en stock'))
    expect(pill).toBeDefined()
    await pill!.trigger('click')
    await flushPromises()
    expect(infiniteMock.mock.calls[0]![0].value.stock).toBeUndefined()
    expect(routerMock.replace.mock.calls.at(-1)![0].query.stock).toBeUndefined()
    route.query.stock = '1'
    route.fullPath = '/stock-again'
    await flushPromises()
    expect(infiniteMock.mock.calls[0]![0].value.stock).toBe('1')
  })
  it.each(['{', [encoded, encoded], null])(
    'rejects malformed/repeated query %j with 400 before broad product API reads',
    async (raw) => {
      route.query.typed = raw
      let outcome: unknown = 'accepted'
      try {
        await mount(page)
      } catch (error) {
        outcome = (error as { statusCode?: number }).statusCode
      }
      expect(outcome).toBe(400)
      expect(infiniteMock).not.toHaveBeenCalled()
    }
  )
})
describe('public typed product details', () => {
  it('renders historical display values, including false/zero, as escaped text alongside legacy attributes', async () => {
    const wrapper = await mount(Product)
    expect(wrapper.get(`[data-typed-detail="${ID}"]`).text()).toContain('0')
    expect(wrapper.text()).toContain('Booleano')
    expect(wrapper.text()).toContain('No')
    expect(wrapper.text()).toContain('<b>Número</b>')
    expect(wrapper.find('[data-typed-detail] b').exists()).toBe(false)
    expect(wrapper.text()).toContain('Conservar')
  })
})

describe('catalogue contextual support navigation', () => {
  it('category offers its canonical context without starting a ticket', async () => {
    const wrapper = await mount(Category)
    const link = wrapper.findAll('a').find((item) => item.text() === 'Consultar sobre esta categoría')!
    expect(link?.attributes('href')).toBe('/contacto?categoria=higiene')
    expect(fetchMock.mock.calls.every(([path]) => !fetchPath(path).startsWith('/api/support'))).toBe(true)
  })
  it('product support uses the returned canonical slug, not a route alias', async () => {
    route.params.slug = 'alias-producto'
    const wrapper = await mount(Product)
    const link = wrapper.findAll('a').find((item) => item.text() === 'Consultar sobre este producto')!
    expect(link?.attributes('href')).toBe('/contacto?producto=producto')
    expect(
      wrapper
        .findAll('a')
        .find((item) => item.text() === 'Pídenosla')
        ?.attributes('href')
    ).toBe('/contacto?producto=producto')
    expect(fetchMock.mock.calls.every(([path]) => !fetchPath(path).startsWith('/api/support'))).toBe(true)
  })
  it('Node keeps its existing contact link without introducing native support', async () => {
    runtimeMock.mockReturnValueOnce({
      app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
      public: { serverRuntime: 'node', mediaGoverned: false, baseUrl: 'http://localhost:3000' }
    })
    const wrapper = await mount(Product)
    expect(
      wrapper
        .findAll('a')
        .find((item) => item.text() === 'Pídenosla')
        ?.attributes('href')
    ).toBe('/contacto')
    expect(wrapper.text()).not.toContain('Consultar sobre este producto')
  })
})

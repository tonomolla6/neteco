import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { defineComponent, h, ref, Suspense } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ProductEngagementPanel from '../../app/components/ProductEngagementPanel.vue'
import ProductContributionsPanel from '../../app/components/ProductContributionsPanel.vue'
import ProductDetailPage from '../../app/pages/producto/[slug].vue'
import '#app/nuxt-vitest-app-entry'
const { request, fetchData, runtime } = vi.hoisted(() => ({
  request: vi.fn(),
  fetchData: vi.fn(),
  runtime: {
    app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
    public: { mediaGoverned: true, serverRuntime: 'cloudflare', baseUrl: 'http://localhost:3000' }
  }
}))
const ready = ref(true),
  loggedIn = ref(false),
  user = ref<Record<string, unknown> | null>(null),
  session = ref<Record<string, unknown> | null>(null)
mockNuxtImport('useRequestFetch', () => () => request)
mockNuxtImport('useFetch', () => fetchData)
mockNuxtImport('useRuntimeConfig', () => () => runtime)
mockNuxtImport('useUserSession', () => () => ({ ready, loggedIn, user, session, clear: async () => undefined }))
mockNuxtImport('useAnalytics', () => () => ({ track: async () => undefined }))
mockNuxtImport('useToast', () => () => ({ add: () => undefined }))
const roots: Awaited<ReturnType<typeof mountSuspended>>[] = []
const WatchStub = defineComponent({
  name: 'ProductWatchPanel',
  props: ['variantId', 'scopeKey', 'enabled', 'pending'],
  emits: ['pending'],
  setup: () => () => h('div', { 'data-watch': '' })
})
function fixture() {
  return {
    id: 1,
    slug: 'producto-1',
    name: 'Producto sintético',
    brand: '',
    shortDesc: null,
    description: null,
    usage: null,
    badges: [],
    visual: { type: 'garrafa', color: '#123456' },
    image: null,
    datasheet: null,
    attrs: [],
    regulatory: {},
    siblings: [],
    breadcrumb: [],
    related: [],
    documents: [],
    variants: [11, 12].map((id) => ({
      uuid: `v-1-${id - 10}`,
      id,
      sku: `SKU-${id}`,
      format: `${id} L`,
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
    }))
  }
}
beforeEach(() => {
  request.mockReset()
  runtime.public.serverRuntime = 'cloudflare'
  ready.value = true
  loggedIn.value = false
  user.value = null
  session.value = null
  // The product fetch returns the fixture; the aggregate-review summary (SEO-026) is a separate resource with no data.
  fetchData.mockImplementation((source: string | (() => string)) => {
    const url = typeof source === 'function' ? source() : source
    const data = url.endsWith('/reviews/summary') ? null : fixture()
    return { data: ref(data), error: ref(null), pending: ref(false) }
  })
})
afterEach(() => {
  for (const wrapper of roots.splice(0)) wrapper.unmount()
})
async function panel(customerEnabled = false) {
  const wrapper = await mountSuspended(ProductEngagementPanel, {
    props: { productId: 1, variantId: 11, scopeKey: 'actor:1', enabled: true, customerEnabled },
    global: { stubs: { ProductWatchPanel: WatchStub } }
  })
  roots.push(wrapper)
  return wrapper
}
async function pdp() {
  const Host = defineComponent({ setup: () => () => h(Suspense, null, { default: () => h(ProductDetailPage) }) })
  const wrapper = await mountSuspended(Host, {
    route: '/producto/producto-1',
    global: {
      stubs: {
        ProductWatchPanel: WatchStub,
        PublishedProductRelations: true,
        PromotionalBlocks: true,
        ProductImageLightbox: true,
        PublishedProductImage: true,
        ProductVisual: true,
        ProductCard: true,
        VariantSelector: true,
        QuantityStepper: true,
        UButton: true,
        UBadge: true,
        UInput: true,
        NuxtLink: true
      }
    }
  })
  roots.push(wrapper)
  await flushPromises()
  return wrapper
}
function customer() {
  loggedIn.value = true
  user.value = { id: '90000000-0000-4000-8000-000000000001', email: 'synthetic@example.invalid', emailVerified: true }
  session.value = { sessionId: '90000000-0000-4000-8000-000000000002', sessionVersion: 1 }
}
// Other PDP sections issue their own public, read-only GETs. They are listed exactly so that any request made by the
// engagement/participation controls (contributions, watch, private reads, writes) still fails these tests.
const OTHER_PDP_SECTION_READS = [
  '/api/product-detail-extras',
  '/api/products/1/media-guides',
  '/api/products/1/reviews',
  '/api/products/1/questions'
]
function engagementRequests() {
  return request.mock.calls.filter(([url]) => !OTHER_PDP_SECTION_READS.includes(String(url)))
}
function otherSectionReads() {
  return request.mock.calls.filter(([url]) => OTHER_PDP_SECTION_READS.includes(String(url)))
}
describe('PDP real product engagement authority and coordination', () => {
  it('connects confirmed PDP product and variant facts while keeping anonymous writes disabled', async () => {
    const wrapper = await pdp()
    const engagement = wrapper.getComponent(ProductEngagementPanel)
    expect(engagement.props()).toMatchObject({ productId: 1, variantId: 11, enabled: true, customerEnabled: false })
    expect(engagementRequests()).toEqual([])
    // The curated alternatives/complements block is an expected anonymous GET, bound to this product slug only.
    const extras = request.mock.calls.filter(([url]) => url === '/api/product-detail-extras')
    expect(extras).toHaveLength(1)
    expect(extras[0]![1]).toMatchObject({ query: { slug: 'producto-1' } })
    expect(
      otherSectionReads().every(([, options]) => !options || !('method' in options) || options.method === 'GET')
    ).toBe(true)
  })
  it('permits anonymous explicit public reading without POST or private reads', async () => {
    const wrapper = await panel()
    const child = wrapper.getComponent(ProductContributionsPanel)
    expect(child.find('form[data-contribution-submit]').exists()).toBe(false)
    request.mockResolvedValueOnce({
      source: 'cloudflare',
      productId: 1,
      page: 1,
      perPage: 25,
      total: 0,
      pages: 0,
      items: []
    })
    await child
      .findAll('button')
      .find((b) => b.text() === 'Consultar reseñas y preguntas')!
      .trigger('click')
    await flushPromises()
    expect(request).toHaveBeenCalledTimes(1)
    expect(request.mock.calls[0]![0]).toBe('/api/products/1/contributions')
    expect(wrapper.getComponent(WatchStub).props('enabled')).toBe(false)
  })
  it('enables private controls only for the confirmed verified session and purges when it changes', async () => {
    customer()
    const wrapper = await pdp()
    const engagement = wrapper.getComponent(ProductEngagementPanel)
    expect(engagement.props('customerEnabled')).toBe(true)
    const child = wrapper.getComponent(ProductContributionsPanel)
    await child.get('[data-contribution-body]').setValue('Borrador privado sintético')
    user.value = { ...user.value, emailVerified: false }
    await flushPromises()
    expect(engagement.props('customerEnabled')).toBe(false)
    expect(child.find('textarea').exists()).toBe(false)
  })
  it('coordinates only the OTHER child pending state, never feeding a child its own pending', async () => {
    const wrapper = await panel(true),
      watch = wrapper.getComponent(WatchStub),
      contributions = wrapper.getComponent(ProductContributionsPanel)
    watch.vm.$emit('pending', true)
    await flushPromises()
    expect(watch.props('pending')).toBe(false)
    expect(contributions.props('pending')).toBe(true)
    watch.vm.$emit('pending', false)
    contributions.vm.$emit('pending', true)
    await flushPromises()
    expect(watch.props('pending')).toBe(true)
    expect(contributions.props('pending')).toBe(false)
  })
  it('purges drafts and pending state on selected variant changes and ignores old pending callbacks', async () => {
    const wrapper = await panel(true),
      child = wrapper.getComponent(ProductContributionsPanel)
    await child.get('[data-contribution-body]').setValue('Borrador anterior')
    const oldPending = child.vm.$.vnode.props?.onPending as (value: boolean) => void
    child.vm.$emit('pending', true)
    await wrapper.setProps({ variantId: 12 })
    await flushPromises()
    expect(wrapper.getComponent(ProductContributionsPanel).get('[data-contribution-body]').element).toHaveProperty(
      'value',
      ''
    )
    oldPending(true)
    await flushPromises()
    expect(wrapper.getComponent(WatchStub).props('pending')).toBe(false)
  })
  it('does not mount Cloudflare participation controls in Node', async () => {
    runtime.public.serverRuntime = 'node'
    const wrapper = await pdp()
    expect(wrapper.findComponent(ProductEngagementPanel).exists()).toBe(false)
    expect(engagementRequests()).toEqual([])
    // The Cloudflare-only extras block must not load in Node either.
    expect(request.mock.calls.some(([url]) => url === '/api/product-detail-extras')).toBe(false)
  })
})

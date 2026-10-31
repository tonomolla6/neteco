import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises, DOMWrapper } from '@vue/test-utils'
import { defineComponent, h, nextTick, ref, Suspense, type Ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ProductImage from '../../app/components/ProductImage.vue'
import OrderLineThumb from '../../app/components/OrderLineThumb.vue'
import HeroOfferSlider from '../../app/components/HeroOfferSlider.vue'
import PublishedProductImage from '../../app/components/PublishedProductImage.vue'
import ProductDetailPage from '../../app/pages/producto/[slug].vue'
import type { ProductCardData } from '../../shared/types/catalog'
import type { getPublishedProductDetail } from '../../workers/catalog/product-detail'
// Keep the established cold Nuxt bootstrap outside its fixed hook deadline.
import '#app/nuxt-vitest-app-entry'

const { runtimeMock, fetchMock, imageApiMock } = vi.hoisted(() => ({
  runtimeMock: vi.fn(() => ({
    app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
    public: { mediaGoverned: true, serverRuntime: 'cloudflare', baseUrl: 'http://localhost:3000' }
  })),
  fetchMock: vi.fn(),
  imageApiMock: vi.fn((source: string) => `/node-image-test?source=${encodeURIComponent(source)}`)
}))
mockNuxtImport('useRuntimeConfig', () => runtimeMock)
mockNuxtImport('useFetch', () => fetchMock)
mockNuxtImport('useImage', () => () => imageApiMock)
mockNuxtImport('useAnalytics', () => () => ({ track: async () => undefined }))
mockNuxtImport('useToast', () => () => ({ add: () => undefined }))
mockNuxtImport('useUserSession', () => () => ({
  ready: ref(true),
  loggedIn: ref(false),
  user: ref(null),
  session: ref(null),
  clear: async () => undefined,
  openInPopup: () => undefined,
  fetch: async () => undefined
}))

const publicationPath = '/media/12345678-1234-4321-aaaa-123456789abc/image'
const nextPublicationPath = '/media/87654321-4321-4321-bbbb-cba987654321/image'
const widths = [256, 400, 640, 800, 1200, 1600]
const approvedAlt = 'Envase real autorizado del SKU azul, etiqueta frontal'
const visual = { type: 'garrafa', color: '#123456' }
type Consumer = 'product' | 'order' | 'hero'
type Mounted = Awaited<ReturnType<typeof mountSuspended>>
interface BrowserTimeouts {
  setTimeout(handler: string | ((...args: unknown[]) => void), delay?: number, ...args: unknown[]): number
  clearTimeout(id?: number): void
}
const mounted: Mounted[] = []
const pdpRoots: HTMLElement[] = []
// Keep Nuxt's runtime host, but mount the async PDP itself normally so this
// integration exercises its original script-setup render bindings.
const PdpHost = defineComponent({
  setup: () => () => h(Suspense, null, { default: () => h(ProductDetailPage) })
})
const legacyImageSources: string[] = []
const preloads: ControlledPreload[] = []
type PdpFixture = NonNullable<Awaited<ReturnType<typeof getPublishedProductDetail>>>
let currentPdpData: Ref<PdpFixture> | undefined
let idleDescriptor: PropertyDescriptor | undefined
let cancelIdleDescriptor: PropertyDescriptor | undefined
let idleStubbed = false
const pendingIdle = new Map<number, () => void>()
const cancelledIdle: number[] = []
const pendingTimeouts = new Map<number, () => void>()
let idleSequence = 0
let timeoutSequence = 1000000
class ControlledPreload {
  src = ''
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  constructor() {
    preloads.push(this)
  }
}

const VisualStub = defineComponent({
  props: { visual: Object },
  setup() {
    return () => h('div', { 'data-product-visual': '', 'aria-label': 'Ilustración de familia, no fotografía' })
  }
})
const LegacyImageStub = defineComponent({
  inheritAttrs: false,
  setup(_, { attrs }) {
    return () => {
      legacyImageSources.push(String(attrs.src))
      return h('img', { ...attrs, 'data-node-image': '' })
    }
  }
})
const LinkButtonStub = defineComponent({
  inheritAttrs: false,
  props: { href: String },
  setup(props, { attrs, slots }) {
    return () => h(props.href ? 'a' : 'button', { ...attrs, href: props.href }, slots.default?.())
  }
})
const globalComponents = {
  components: { PublishedProductImage },
  stubs: { PublishedProductImage: false, ProductVisual: VisualStub, NuxtImg: LegacyImageStub, UIcon: true }
}

function configureRuntime(governed: boolean) {
  runtimeMock.mockReturnValue({
    app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
    public: {
      mediaGoverned: governed,
      serverRuntime: governed ? 'cloudflare' : 'node',
      baseUrl: 'http://localhost:3000'
    }
  })
}

function product(image: string | null, imageAlt: string | null = approvedAlt, name = 'Producto azul') {
  return { image, imageAlt, name, visual }
}
function card(image: string | null, imageAlt: string | null = approvedAlt, id = 1): ProductCardData {
  return {
    ...product(image, imageAlt),
    id,
    slug: `producto-${id}`,
    brand: 'NETECO',
    badges: [],
    minPrice: 500,
    minNetPrice: 413,
    compareAtPrice: 600,
    formats: 1
  }
}

function pdpFixture(image: string | null): PdpFixture {
  return {
    id: 1,
    categoryId: 7,
    slug: 'producto-1',
    name: 'Producto azul',
    brand: 'NETECO',
    shortDesc: null,
    description: null,
    usage: null,
    badges: [],
    visual,
    image: null,
    imageAlt: null,
    datasheet: null,
    featured: false,
    series: null,
    attrs: [],
    regulatory: {},
    siblings: [],
    breadcrumb: [],
    related: [],
    documents: [],
    variants: [
      {
        uuid: 'v-1-1',
        id: 11,
        sku: 'SKU-AZUL',
        format: 'Botella 1 L',
        ean: null,
        gtin: null,
        mpn: null,
        price: 500,
        compareAtPrice: null,
        referencePrice30d: null,
        priceTiers: [],
        pricingVersion: 'fixture',
        taxRateBasisPoints: 2100,
        netPrice: 413,
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
        image,
        imageAlt: approvedAlt
      }
    ]
  }
}

async function renderPdp(
  image: string | null,
  patch: Partial<PdpFixture> = {},
  scheduler: 'timeout' | 'idle' = 'timeout'
) {
  currentPdpData = ref({ ...pdpFixture(image), ...patch })
  // The PDP also fetches the review summary (reactive-URL getter); it has no data here.
  fetchMock.mockImplementation((source: string | (() => string)) => ({
    data: (typeof source === 'function' ? source() : source).endsWith('/reviews/summary') ? ref(null) : currentPdpData,
    error: ref(null),
    pending: ref(false),
    status: ref('success')
  }))
  vi.stubGlobal('Image', ControlledPreload)
  const idle = (callback: () => void) => {
    const id = ++idleSequence
    pendingIdle.set(id, callback)
    return id
  }
  const cancelIdle = (id: number) => {
    cancelledIdle.push(id)
    pendingIdle.delete(id)
  }
  // happy-dom's Window and Vitest's global may be distinct: control both the
  // feature test and invocation so no preload timer leaks into the next test.
  idleDescriptor = Object.getOwnPropertyDescriptor(window, 'requestIdleCallback')
  cancelIdleDescriptor = Object.getOwnPropertyDescriptor(window, 'cancelIdleCallback')
  idleStubbed = true
  vi.stubGlobal('requestIdleCallback', scheduler === 'idle' ? idle : undefined)
  vi.stubGlobal('cancelIdleCallback', cancelIdle)
  if (scheduler === 'idle') Object.defineProperty(window, 'requestIdleCallback', { configurable: true, value: idle })
  else Reflect.deleteProperty(window, 'requestIdleCallback')
  Object.defineProperty(window, 'cancelIdleCallback', { configurable: true, value: cancelIdle })
  // Keep Nuxt's async setup/router timers real. Only the page's exact 400 ms
  // prefetch schedule is controlled, and cancellation must come from the page.
  // Use the actual numeric browser ABI, not the conflicting NodeJS.Timeout
  // overload contributed by merged Worker/Node ambient declarations.
  const timers = window as unknown as BrowserTimeouts
  const setTimeout = timers.setTimeout.bind(window)
  const clearTimeout = timers.clearTimeout.bind(window)
  vi.spyOn(timers, 'setTimeout').mockImplementation((handler, delay, ...args) => {
    if (delay === 400 && typeof handler === 'function') {
      const id = ++timeoutSequence
      pendingTimeouts.set(id, () => handler(...args))
      return id
    }
    return setTimeout(handler, delay, ...args)
  })
  vi.spyOn(timers, 'clearTimeout').mockImplementation((id) => {
    if (typeof id === 'number' && pendingTimeouts.delete(id)) return
    clearTimeout(id)
  })
  const root = document.createElement('div')
  document.body.append(root)
  pdpRoots.push(root)
  const wrapper = await mountSuspended(PdpHost, {
    attachTo: root,
    route: '/producto/producto-1',
    // Render the extracted lightbox and its real headless focus primitives;
    // only unrelated page consumers remain shallow substitutes.
    global: {
      ...globalComponents,
      stubs: {
        ...globalComponents.stubs,
        UButton: LinkButtonStub,
        Teleport: false,
        NuxtLink: true,
        UInput: true,
        UBadge: true,
        VariantSelector: true,
        QuantityStepper: true,
        ProductCard: true,
        PublishedProductRelations: true,
        PromotionalBlocks: true
      }
    }
  })
  mounted.push(wrapper)
  await flushPromises()
  return wrapper
}

async function openPdpLightbox(wrapper: Mounted) {
  await wrapper.get('button[aria-label="Ver la imagen a pantalla completa"]').trigger('click')
  await vi.waitFor(() => expect(document.body.querySelector('[role="dialog"]')).not.toBeNull())
}

function pdpDialog() {
  return new DOMWrapper(document.body.querySelector<HTMLElement>('[role="dialog"]')!)
}

function release(wrapper: Mounted) {
  mounted.splice(mounted.indexOf(wrapper), 1)
  wrapper.unmount()
}

function flushIdleRequests() {
  for (const [id, callback] of [...pendingIdle]) {
    pendingIdle.delete(id)
    callback()
  }
}

function flushPrefetchTimeouts() {
  for (const [id, callback] of [...pendingTimeouts]) {
    pendingTimeouts.delete(id)
    callback()
  }
}

async function render(consumer: Consumer, image: string | null, imageAlt: string | null = approvedAlt) {
  let wrapper: Mounted
  if (consumer === 'product') {
    wrapper = await mountSuspended(ProductImage, {
      props: { product: product(image, imageAlt), sizes: '320px', context: 'detail' },
      global: globalComponents
    })
  } else if (consumer === 'order') {
    wrapper = await mountSuspended(OrderLineThumb, {
      props: { line: product(image, imageAlt) },
      global: globalComponents
    })
  } else {
    wrapper = await mountSuspended(HeroOfferSlider, {
      props: { items: [card(image, imageAlt)] },
      global: globalComponents
    })
  }
  mounted.push(wrapper)
  return wrapper
}

async function changeSource(wrapper: Mounted, consumer: Consumer, image: string | null, imageAlt = approvedAlt) {
  if (consumer === 'product') await wrapper.setProps({ product: product(image, imageAlt) })
  else if (consumer === 'order') await wrapper.setProps({ line: product(image, imageAlt) })
  else await wrapper.setProps({ items: [card(image, imageAlt)] })
}

function expectResponsive(wrapper: Mounted, path: string, alt: string, sizes: string, loading = 'lazy') {
  expect(wrapper.findComponent(PublishedProductImage).exists()).toBe(true)
  expect(wrapper.findAll('picture')).toHaveLength(1)
  const sources = wrapper.findAll('source')
  expect(sources.map((source: DOMWrapper<Element>) => source.attributes('type'))).toEqual(['image/avif', 'image/webp'])
  for (const [source, format] of [
    [sources[0]!, 'avif'],
    [sources[1]!, 'webp']
  ] as const) {
    expect(source.attributes('srcset').split(', ')).toEqual(
      widths.map((width) => `${path}?w=${width}&format=${format} ${width}w`)
    )
    expect(source.attributes('sizes')).toBe(sizes)
  }
  const image = wrapper.get('picture img')
  expect(image.attributes('src')).toBe(`${path}?w=800&format=jpeg`)
  expect(image.attributes('srcset').split(', ')).toEqual(
    widths.map((width) => `${path}?w=${width}&format=jpeg ${width}w`)
  )
  expect(image.attributes('alt')).toBe(alt)
  expect(image.attributes('sizes')).toBe(sizes)
  expect(image.attributes('loading')).toBe(loading)
  expect(image.attributes('decoding')).toBe('async')
  expect(legacyImageSources).toEqual([])
}

describe('governed image consumer boundaries', () => {
  beforeEach(() => {
    configureRuntime(true)
    legacyImageSources.splice(0)
    preloads.splice(0)
    pendingIdle.clear()
    pendingTimeouts.clear()
    cancelledIdle.splice(0)
    currentPdpData = undefined
    fetchMock.mockReset()
    imageApiMock.mockClear()
    // DOM/event acceptance only: never interpret a URL or a fake load event as
    // real browser transport, decoding, license evidence or a scanner verdict.
    vi.spyOn(HTMLImageElement.prototype, 'complete', 'get').mockReturnValue(false)
    vi.spyOn(HTMLImageElement.prototype, 'naturalWidth', 'get').mockReturnValue(0)
    vi.spyOn(window, 'matchMedia').mockReturnValue({
      matches: true,
      media: '(prefers-reduced-motion: reduce)',
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(() => true)
    })
  })
  afterEach(() => {
    for (const wrapper of mounted.splice(0)) wrapper.unmount()
    for (const root of pdpRoots.splice(0)) root.remove()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    if (idleStubbed) {
      if (idleDescriptor) Object.defineProperty(window, 'requestIdleCallback', idleDescriptor)
      else Reflect.deleteProperty(window, 'requestIdleCallback')
      if (cancelIdleDescriptor) Object.defineProperty(window, 'cancelIdleCallback', cancelIdleDescriptor)
      else Reflect.deleteProperty(window, 'cancelIdleCallback')
      idleStubbed = false
    }
  })

  describe.each(['product', 'order', 'hero'] as const)('%s', (consumer) => {
    it.each([
      '/img/products/legacy.webp',
      'https://unapproved.example.invalid/original.jpg',
      '//unapproved.example.invalid/original.jpg',
      'quarantine/private-object-key',
      `${publicationPath}?url=https://unapproved.example.invalid/original.jpg`,
      `${publicationPath}?w=800&w=1600`,
      publicationPath.replace('/media/', '/%6dedia/'),
      `${publicationPath}?%77=800`,
      publicationPath.toUpperCase(),
      ` ${publicationPath}`
    ])('Cloudflare generates no image request surface for ungoverned source %s', async (source) => {
      const fetch = vi.spyOn(globalThis, 'fetch')
      const wrapper = await render(consumer, source)
      expect(wrapper.find('img, picture, source').exists()).toBe(false)
      expect(wrapper.find('[src], [srcset]').exists()).toBe(false)
      expect(wrapper.find('[data-product-visual]').exists()).toBe(true)
      expect(wrapper.html()).not.toContain(source)
      expect(legacyImageSources).toEqual([])
      expect(fetch).not.toHaveBeenCalled()
      if (consumer === 'product') expect(wrapper.text()).toContain('Todavía no tenemos foto de esta referencia.')
    })

    it('uses real PublishedProductImage responsive derivatives with the approved alt', async () => {
      const wrapper = await render(consumer, `${publicationPath}?w=400&format=webp`)
      const sizes = consumer === 'product' ? '320px' : consumer === 'order' ? '56px' : '(min-width: 1024px) 400px, 90vw'
      expectResponsive(wrapper, publicationPath, approvedAlt, sizes, consumer === 'hero' ? 'eager' : 'lazy')
    })

    it('keeps a contextual name fallback when no explicit image alt is supplied', async () => {
      const wrapper = await render(consumer, publicationPath, null)
      expect(wrapper.get('img').attributes('alt')).toBe('Producto azul')
    })

    it('removes old governed sources immediately when the source is cleared or becomes ungoverned', async () => {
      const wrapper = await render(consumer, publicationPath)
      await changeSource(wrapper, consumer, null)
      expect(wrapper.find('img, source').exists()).toBe(false)
      expect(wrapper.find('[data-product-visual]').exists()).toBe(true)
      await changeSource(wrapper, consumer, 'https://unapproved.example.invalid/new.jpg')
      expect(wrapper.find('[src], [srcset]').exists()).toBe(false)
      await changeSource(wrapper, consumer, nextPublicationPath, 'Nueva fotografía autorizada')
      expect(wrapper.get('img').attributes('src')).toBe(`${nextPublicationPath}?w=800&format=jpeg`)
      expect(wrapper.get('img').attributes('alt')).toBe('Nueva fotografía autorizada')
      expect(wrapper.html()).not.toContain(publicationPath)
      expect(legacyImageSources).toEqual([])
    })

    it.each(['/img/products/legacy.webp', 'https://legacy.example.invalid/photo.jpg'])(
      'retains the existing Node image path %s without silently applying the Cloudflare guard',
      async (source) => {
        configureRuntime(false)
        const wrapper = await render(consumer, source, 'Texto alternativo Node')
        expect(wrapper.find('picture, source').exists()).toBe(false)
        const image = wrapper.get('img')
        expect(image.attributes('src')).toBe(source)
        expect(image.attributes('alt')).toBe('Texto alternativo Node')
        expect(wrapper.find('[data-product-visual]').exists()).toBe(false)
        if (consumer === 'product') {
          expect(image.attributes('data-node-image')).toBe('')
          expect(image.attributes('format')).toBe('webp')
          expect(image.attributes('loading')).toBe('lazy')
        } else expect(legacyImageSources).toEqual([])
      }
    )
  })

  it.each(['sm', 'md'] as const)(
    'OrderLineThumb resets a failed image when a new exact asset arrives (%s)',
    async (size) => {
      const wrapper = await render('order', publicationPath)
      await wrapper.setProps({ size })
      expect(wrapper.get('img').attributes('sizes')).toBe(size === 'sm' ? '40px' : '56px')
      await wrapper.get('img').trigger('error')
      expect(wrapper.find('img').exists()).toBe(false)
      expect(wrapper.find('[data-product-visual]').exists()).toBe(true)
      await wrapper.setProps({ line: product(nextPublicationPath, 'Envase exacto del nuevo SKU', 'Otro SKU') })
      expectResponsive(wrapper, nextPublicationPath, 'Envase exacto del nuevo SKU', size === 'sm' ? '40px' : '56px')
      expect(wrapper.find('[data-product-visual]').exists()).toBe(false)
      expect(wrapper.html()).not.toContain(publicationPath)
    }
  )

  it('OrderLineThumb preserves Node error recovery for a newly supplied legacy asset', async () => {
    configureRuntime(false)
    const wrapper = await render('order', '/img/products/legacy.webp')
    await wrapper.get('img').trigger('error')
    expect(wrapper.find('img').exists()).toBe(false)
    await wrapper.setProps({ line: product('/img/products/new-legacy.webp', 'Nuevo envase Node') })
    expect(wrapper.get('img').attributes('src')).toBe('/img/products/new-legacy.webp')
    expect(wrapper.get('img').attributes('alt')).toBe('Nuevo envase Node')
  })

  it('HeroOfferSlider never carries another offer image or alt into an ungoverned offer', async () => {
    const wrapper = await render('hero', publicationPath)
    await wrapper.setProps({
      items: [
        card(publicationPath),
        card('/img/products/legacy.webp', 'Alt antiguo', 2),
        card(nextPublicationPath, 'Foto propia tercera oferta', 3)
      ]
    })
    await wrapper.get('button[aria-label="Oferta siguiente"]').trigger('click')
    expect(wrapper.find('img, source').exists()).toBe(false)
    expect(wrapper.find('[data-product-visual]').exists()).toBe(true)
    expect(wrapper.html()).not.toContain(publicationPath)
    expect(wrapper.html()).not.toContain('Alt antiguo')
    await wrapper.get('button[aria-label="Oferta siguiente"]').trigger('click')
    expectResponsive(
      wrapper,
      nextPublicationPath,
      'Foto propia tercera oferta',
      '(min-width: 1024px) 400px, 90vw',
      'eager'
    )
    expect(wrapper.html()).not.toContain(publicationPath)
  })

  it.each(['publication', 'offer'] as const)(
    'HeroOfferSlider resets a failed image when the %s changes at the same index',
    async (change) => {
      const wrapper = await render('hero', publicationPath)
      await wrapper.get('img').trigger('error')
      expect(wrapper.find('img').exists()).toBe(false)
      await wrapper.setProps({
        items: [card(nextPublicationPath, 'Nueva oferta con foto propia', change === 'offer' ? 2 : 1)]
      })
      expectResponsive(
        wrapper,
        nextPublicationPath,
        'Nueva oferta con foto propia',
        '(min-width: 1024px) 400px, 90vw',
        'eager'
      )
      expect(wrapper.find('[data-product-visual]').exists()).toBe(false)
    }
  )

  it('PDP preloads and opens only bounded governed JPEG derivatives with the approved variant alt', async () => {
    const wrapper = await renderPdp(publicationPath)
    expect(preloads.length).toBeGreaterThan(0)
    expect(preloads.every((preload) => preload.src === `${publicationPath}?w=1200&format=jpeg`)).toBe(true)
    expect(imageApiMock).not.toHaveBeenCalled()
    preloads.find((preload) => preload.onload)?.onload?.()
    await nextTick()
    expectResponsive(
      wrapper,
      publicationPath,
      approvedAlt,
      '(min-width: 1280px) 33vw, (min-width: 1024px) 50vw, 100vw',
      'eager'
    )
    await openPdpLightbox(wrapper)
    const lightbox = pdpDialog()
    expect(document.body.style.overflow).toBe('hidden')
    expect(lightbox.get('img').attributes('src')).toBe(`${publicationPath}?w=1600&format=jpeg`)
    expect(lightbox.get('img').attributes('alt')).toBe(approvedAlt)
    expect(imageApiMock).not.toHaveBeenCalled()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await nextTick()
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
    expect(document.body.style.overflow).toBe('')
  })

  it.each([
    '/img/products/legacy.webp',
    'https://unapproved.example.invalid/original.jpg',
    'quarantine/private-object-key',
    publicationPath.toUpperCase(),
    `${publicationPath}?%77=800`,
    `${publicationPath}?url=https://unapproved.example.invalid/original.jpg`
  ])('PDP Cloudflare never preloads, displays, transforms or opens ungoverned source %s', async (source) => {
    const fetch = vi.spyOn(globalThis, 'fetch')
    const wrapper = await renderPdp(source, { image: source })
    expect(preloads).toEqual([])
    expect(imageApiMock).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
    expect(wrapper.find('img, picture, source').exists()).toBe(false)
    expect(wrapper.find('button[aria-label="Ver la imagen a pantalla completa"]').exists()).toBe(false)
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
    expect(wrapper.html()).not.toContain(source)
    expect(wrapper.find('[data-product-visual]').exists()).toBe(true)
    for (const preload of document.head.querySelectorAll('link[rel="preload"][as="image"]'))
      expect(preload.getAttribute('href')).not.toContain(source)
  })

  it('PDP immediately removes an open lightbox when its variant source becomes ungoverned', async () => {
    const wrapper = await renderPdp(publicationPath)
    preloads.find((preload) => preload.onload)?.onload?.()
    await nextTick()
    await openPdpLightbox(wrapper)
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull()
    expect(document.body.style.overflow).toBe('hidden')
    const previousPreloads = preloads.length
    currentPdpData!.value = {
      ...pdpFixture('https://unapproved.example.invalid/new.jpg'),
      image: '/img/products/legacy.webp'
    }
    await flushPromises()
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
    expect(wrapper.find('img, source').exists()).toBe(false)
    expect(document.body.style.overflow).toBe('')
    expect(preloads).toHaveLength(previousPreloads)
    expect(imageApiMock).not.toHaveBeenCalled()
  })

  it('PDP releases body scroll and never reopens the old lightbox when a new governed source loads', async () => {
    const wrapper = await renderPdp(publicationPath)
    preloads.find((preload) => preload.onload)?.onload?.()
    await nextTick()
    await openPdpLightbox(wrapper)
    expect(document.body.style.overflow).toBe('hidden')
    currentPdpData!.value.variants[0]!.image = nextPublicationPath
    currentPdpData!.value.variants[0]!.imageAlt = 'Nueva publicación explícita'
    await nextTick()
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
    expect(document.body.style.overflow).toBe('')
    preloads.find((preload) => preload.src.includes(nextPublicationPath) && preload.onload)?.onload?.()
    await nextTick()
    expect(wrapper.get('img').attributes('alt')).toBe('Nueva publicación explícita')
    expect(wrapper.get('img').attributes('src')).toBe(`${nextPublicationPath}?w=800&format=jpeg`)
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
    expect(document.body.style.overflow).toBe('')
  })

  it('PDP Cloudflare exposes only canonical governed technical PDF links, never legacy or private token URLs', async () => {
    const documentPath = '/media/23456789-2345-4321-bbbb-234567890abc/document'
    const unsafe = [
      '/doc/demo-legacy.pdf',
      'https://unapproved.example.invalid/datasheet.pdf',
      '/api/orders/synthetic-order/invoice?token=synthetic-private-token',
      `${documentPath}?token=synthetic-private-token`,
      documentPath.toUpperCase(),
      publicationPath
    ]
    const wrapper = await renderPdp(null, {
      datasheet: unsafe[0]!,
      documents: [documentPath, ...unsafe].map((url, index) => ({
        id: `synthetic-document-${index}`,
        role: 'datasheet',
        name: `Documento ${index}`,
        url,
        version: '2',
        language: 'es',
        authorizedAt: '2026-08-12'
      }))
    })
    const downloads = wrapper.findAll('a[target="_blank"]')
    expect(downloads.map((link) => link.attributes('href'))).toEqual([documentPath])
    expect(downloads[0]!.text()).toContain('Ficha técnica')
    expect(downloads[0]!.text()).toContain('v2')
    for (const source of unsafe) expect(wrapper.html()).not.toContain(source)
    expect(wrapper.html()).not.toContain('synthetic-private-token')
  })

  it('PDP Cloudflare keeps a canonical governed datasheet link but strips any query alias', async () => {
    const documentPath = '/media/23456789-2345-4321-bbbb-234567890abc/document'
    const wrapper = await renderPdp(null, { datasheet: documentPath })
    expect(wrapper.get('a[target="_blank"]').attributes('href')).toBe(documentPath)
    currentPdpData!.value.datasheet = `${documentPath}?download=1`
    await nextTick()
    expect(wrapper.find('a[target="_blank"]').exists()).toBe(false)
  })

  it('PDP Node retains legacy image transformation, lightbox and technical document links', async () => {
    configureRuntime(false)
    const legacy = '/img/products/node-photo.webp'
    const wrapper = await renderPdp(legacy, {
      datasheet: '/doc/node-legacy.pdf',
      documents: [
        {
          id: 'node-document',
          role: 'sds',
          name: 'Ficha Node',
          url: 'https://legacy.example.invalid/sds.pdf',
          version: '1',
          language: 'es',
          authorizedAt: '2020-01-01'
        }
      ]
    })
    expect(imageApiMock).toHaveBeenCalledWith(legacy, { format: 'webp', quality: 80, width: 1120 })
    preloads.find((preload) => preload.onload)?.onload?.()
    await nextTick()
    await openPdpLightbox(wrapper)
    expect(imageApiMock).toHaveBeenCalledWith(legacy, { format: 'webp', quality: 85, width: 1800 })
    expect(pdpDialog().get('img').attributes('src')).toBe(`/node-image-test?source=${encodeURIComponent(legacy)}`)
    expect(wrapper.findAll('a[target="_blank"]').map((link) => link.attributes('href'))).toEqual([
      '/doc/node-legacy.pdf',
      'https://legacy.example.invalid/sds.pdf'
    ])
  })

  it.each(['timeout', 'idle'] as const)(
    'PDP cancels pending %s prefetch when the component unmounts',
    async (scheduler) => {
      const wrapper = await renderPdp(publicationPath, {}, scheduler)
      const initialLoads = preloads.length
      expect(initialLoads).toBeGreaterThan(0)
      const pendingId = [...pendingIdle.keys()][0]
      if (scheduler === 'idle') expect(pendingId).toBeDefined()
      else expect(pendingTimeouts.size).toBeGreaterThan(0)
      release(wrapper)
      if (scheduler === 'idle') expect(cancelledIdle).toContain(pendingId)
      flushIdleRequests()
      flushPrefetchTimeouts()
      await nextTick()
      expect(preloads).toHaveLength(initialLoads)
    }
  )

  it.each(['timeout', 'idle'] as const)(
    'PDP cancels obsolete %s prefetch on source change and can prefetch that asset again later',
    async (scheduler) => {
      await renderPdp(publicationPath, {}, scheduler)
      const firstIdle = [...pendingIdle.keys()][0]
      currentPdpData!.value.variants[0]!.image = nextPublicationPath
      await nextTick()
      const nextLoads = preloads.length
      if (scheduler === 'idle') expect(cancelledIdle).toContain(firstIdle)
      flushIdleRequests()
      flushPrefetchTimeouts()
      await nextTick()
      expect(preloads.slice(nextLoads).map((preload) => preload.src)).toEqual([
        `${nextPublicationPath}?w=1200&format=jpeg`
      ])
      currentPdpData!.value.variants[0]!.image = publicationPath
      await nextTick()
      const restoredLoads = preloads.length
      flushIdleRequests()
      flushPrefetchTimeouts()
      await nextTick()
      // A cancelled schedule must not mark the old source as already prefetched.
      expect(preloads.slice(restoredLoads).map((preload) => preload.src)).toEqual([
        `${publicationPath}?w=1200&format=jpeg`
      ])
      expect(document.body.querySelector('[role="dialog"]')).toBeNull()
    }
  )
})

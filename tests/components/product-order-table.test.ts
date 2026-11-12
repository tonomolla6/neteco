import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { defineComponent, h, ref, Suspense } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ProductDetailPage from '../../app/pages/producto/[slug].vue'
import '#app/nuxt-vitest-app-entry'

const { request, fetchData, runtime, add, toast } = vi.hoisted(() => ({
  request: vi.fn(),
  fetchData: vi.fn(),
  add: vi.fn(),
  toast: vi.fn(),
  runtime: {
    app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
    public: {
      mediaGoverned: true,
      serverRuntime: 'node',
      baseUrl: 'http://localhost:3000',
      appEnv: 'production',
      commercial: {} as Record<string, unknown>
    }
  }
}))
mockNuxtImport('useRequestFetch', () => () => request)
mockNuxtImport('useFetch', () => fetchData)
mockNuxtImport('useRuntimeConfig', () => () => runtime)
mockNuxtImport('useUserSession', () => () => ({
  ready: ref(true),
  loggedIn: ref(false),
  user: ref(null),
  session: ref(null),
  clear: async () => undefined
}))
mockNuxtImport('useAnalytics', () => () => ({ track: async () => undefined }))
mockNuxtImport('useToast', () => () => ({ add: toast }))
vi.mock('../../app/stores/cart', () => ({
  useCartStore: () => ({ add, error: '', blockedMutations: false, count: 0 })
}))

const variant = (id: number, overrides = {}) => ({
  uuid: `v-${id}`,
  id,
  sku: `10${id}`,
  format: `Talla ${['S', 'M', 'L'][id - 1]}`,
  ean: null,
  gtin: null,
  mpn: null,
  price: 1210,
  compareAtPrice: null,
  referencePrice30d: null,
  priceTiers: [],
  pricingVersion: 'fixture',
  netPrice: 1000,
  taxRateBasisPoints: 2100,
  stock: 25,
  units: 100,
  unitBase: 'unit',
  unitLabel: 'ud',
  unitsPerCase: 1,
  casesPerPallet: null,
  minimumQuantity: 1,
  maximumQuantity: null,
  quantityIncrement: 1,
  backorderAllowed: false,
  leadTimeDays: null,
  color: null,
  image: null,
  ...overrides
})
let product: Record<string, unknown>
const base = () => ({
  id: 1,
  slug: 'guante-nitrilo',
  name: 'Guante de nitrilo',
  brand: 'NETECO',
  shortDesc: null,
  description: 'Guante desechable.',
  usage: null,
  badges: [],
  visual: { type: 'caja', color: '#123456' },
  image: null,
  datasheet: null,
  attrs: [],
  regulatory: {},
  siblings: [],
  breadcrumb: [],
  related: [],
  documents: [],
  variants: [variant(1), variant(2), variant(3, { stock: 0 })]
})

const roots: Awaited<ReturnType<typeof mountSuspended>>[] = []
async function pdp() {
  const Host = defineComponent({ setup: () => () => h(Suspense, null, { default: () => h(ProductDetailPage) }) })
  const wrapper = await mountSuspended(Host, {
    route: '/producto/guante-nitrilo',
    global: {
      stubs: {
        PublishedProductRelations: true,
        PromotionalBlocks: true,
        ProductImageLightbox: true,
        PublishedProductImage: true,
        ProductVisual: true,
        ProductCard: true,
        ProductEngagementPanel: true,
        ProductVerifiedReviewsQa: true,
        ProductVideoMediaGuide: true,
        ProductDetailExtras: true,
        AdrHazardNotice: true
      }
    }
  })
  roots.push(wrapper)
  await flushPromises()
  return wrapper
}
const rows = (page: Awaited<ReturnType<typeof pdp>>) => page.findAll('[data-variant-row]')
async function setQuantity(row: ReturnType<typeof rows>[number], value: number) {
  const input = row.get('input[inputmode="numeric"]')
  await input.setValue(String(value))
  await input.trigger('change')
}

beforeEach(() => {
  product = base()
  add.mockReset().mockResolvedValue(undefined)
  toast.mockReset()
  runtime.public.appEnv = 'production'
  runtime.public.commercial = {}
  fetchData.mockImplementation((source: string | (() => string)) => {
    const url = typeof source === 'function' ? source() : source
    return { data: ref(url.endsWith('/reviews/summary') ? null : product), error: ref(null), pending: ref(false) }
  })
})
afterEach(() => roots.splice(0).forEach((wrapper) => wrapper.unmount()))

describe('product page as an ordering surface', () => {
  it('offers a quantity per format, keeps the radio selection and prices each row', async () => {
    const page = await pdp()
    expect(rows(page)).toHaveLength(3)
    const radios = page.findAll('[role="radio"]')
    expect(radios).toHaveLength(3)
    expect(radios[0]!.attributes('aria-checked')).toBe('true')
    expect(radios[1]!.text()).toContain('Ref. 102')
    expect(rows(page)[0]!.text().replace(/\s+/g, ' ')).toContain('12,10 €')
    expect(rows(page)[0]!.text()).toContain('0,12 €/ud')
    // the selected format starts at its minimum, the rest at zero
    const values = rows(page).map((row) => (row.get('input[inputmode="numeric"]').element as HTMLInputElement).value)
    expect(values).toEqual(['1', '0', '0'])
    expect(rows(page)[2]!.text()).toContain('Agotado')
    expect(rows(page)[2]!.get('input[inputmode="numeric"]').attributes('disabled')).toBeDefined()
  })

  it('adds every format with a quantity in one action', async () => {
    const page = await pdp()
    await setQuantity(rows(page)[0]!, 3)
    await setQuantity(rows(page)[1]!, 2)
    const summary = page.get('[data-order-summary]').text().replace(/\s+/g, ' ')
    expect(summary).toContain('5 uds')
    expect(summary).toContain('60,50 €')
    await page.get('[data-add-to-cart]').trigger('click')
    await flushPromises()
    expect(add.mock.calls.map(([item, quantity]) => [item.variantId, item.sku, quantity])).toEqual([
      [1, '101', 3],
      [2, '102', 2]
    ])
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Añadido al carrito' }))
  })

  it('has a single primary action, no "buy now", and a labelled save-to-list button', async () => {
    const page = await pdp()
    expect(page.text()).not.toContain('Comprar ahora')
    expect(page.get('[data-save-to-list]').text()).toContain('Guardar en lista')
    expect(page.findAll('button').filter((button) => button.text() === 'Añadir al carrito')).toHaveLength(2)
  })

  it('shows the price at display size and the mobile bar with units and total', async () => {
    const page = await pdp()
    await setQuantity(rows(page)[0]!, 4)
    const total = page.get('[data-order-total]')
    expect(total.classes().join(' ')).toMatch(/text-\[1\.625rem\]|text-3xl/)
    const bar = page.get('[data-mobile-buy-bar]')
    expect(bar.text().replace(/\s+/g, ' ')).toContain('4 uds')
    expect(bar.text().replace(/\s+/g, ' ')).toContain('48,40 €')
    await bar.get('button').trigger('click')
    await flushPromises()
    expect(add).toHaveBeenCalledOnce()
    expect(add.mock.calls[0]![1]).toBe(4)
  })

  it('puts the purchase before the description and says the minimum only when it is not one', async () => {
    const page = await pdp()
    const html = page.html()
    expect(html.indexOf('data-add-to-cart')).toBeLessThan(html.indexOf('Guante desechable.'))
    expect(page.text()).not.toMatch(/Pedido mínimo|incremento/i)
    product = { ...base(), variants: [variant(1, { minimumQuantity: 10, quantityIncrement: 10 })] }
    const boxed = await pdp()
    expect(boxed.text()).toContain('Se vende de 10 en 10')
    expect(rows(boxed)).toHaveLength(1)
    expect((rows(boxed)[0]!.get('input[inputmode="numeric"]').element as HTMLInputElement).value).toBe('10')
  })

  it('stops at an addition that fails and says which format', async () => {
    add.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('offline'))
    const page = await pdp()
    await setQuantity(rows(page)[0]!, 1)
    await setQuantity(rows(page)[1]!, 1)
    await page.get('[data-add-to-cart]').trigger('click')
    await flushPromises()
    expect(add).toHaveBeenCalledTimes(2)
    expect(toast).toHaveBeenLastCalledWith(
      expect.objectContaining({ title: 'No se ha podido añadir', description: expect.stringContaining('Talla M') })
    )
  })
})

describe('safety documents next to the purchase', () => {
  it('links the safety data sheet beside the buy box and shows the hazard information', async () => {
    product = {
      ...base(),
      documents: [
        { id: 'd1', role: 'sds', version: 3, language: 'es', url: '/media/documents/fds.pdf', title: 'FDS' },
        { id: 'd2', role: 'datasheet', version: 1, language: 'es', url: '/media/documents/ft.pdf', title: 'FT' }
      ],
      regulatory: { signalWord: 'Peligro', hazardStatements: ['H314 Provoca quemaduras graves'] }
    }
    runtime.public.mediaGoverned = false
    const page = await pdp()
    runtime.public.mediaGoverned = true
    const documents = page.get('[data-product-documents]')
    expect(documents.text()).toContain('Ficha de datos de seguridad')
    expect(documents.get('a').attributes('href')).toBe('/media/documents/fds.pdf')
    const html = page.html()
    expect(html.indexOf('data-product-documents')).toBeLessThan(html.indexOf('Guante desechable.'))
    const safety = page.get('[data-product-safety]')
    expect(safety.text()).toContain('Peligro')
    expect(safety.text()).toContain('H314')
  })

  it('a regulated product without a data sheet says how to get it, in every environment', async () => {
    product = { ...base(), regulatory: { signalWord: 'Atención' } }
    const page = await pdp()
    expect(page.get('[data-product-documents]').text()).toContain(
      'Pídenos la ficha de seguridad: escríbenos a tienda@neteco.es'
    )
    expect(page.text()).not.toContain('demostración')
  })

  it('a product that is not regulated and has no documents shows no empty documents block', async () => {
    expect((await pdp()).find('[data-product-documents]').exists()).toBe(false)
  })
})

describe('delivery estimate on the product page', () => {
  beforeEach(() => {
    localStorage.clear()
    runtime.public.serverRuntime = 'node'
  })
  afterEach(() => {
    runtime.public.serverRuntime = 'node'
    localStorage.clear()
  })

  it('is not offered where the storefront cannot answer it', async () => {
    runtime.public.serverRuntime = 'cloudflare'
    const page = await pdp()
    expect(page.find('#delivery-postal-code').exists()).toBe(false)
    expect(page.text()).not.toContain('¿Cuándo me llega?')
  })

  it('asks for the destination once and remembers it for the next product', async () => {
    const first = await pdp()
    expect(first.find('#delivery-postal-code').exists()).toBe(true)
    localStorage.setItem('neteco-destination', JSON.stringify({ postalCode: '46870', city: 'Ontinyent' }))
    const second = await pdp()
    await flushPromises()
    expect(second.get('[data-delivery-destination]').text()).toContain('46870 Ontinyent')
    expect(second.find('#delivery-postal-code').exists()).toBe(false)
    await second.get('[data-delivery-change]').trigger('click')
    expect((second.get('#delivery-postal-code').element as HTMLInputElement).value).toBe('46870')
  })
})

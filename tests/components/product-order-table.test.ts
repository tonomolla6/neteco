import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { clearNuxtState } from '#app'
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
const rows = (page: Awaited<ReturnType<typeof pdp>>) => page.findAll('[data-variant-option]')
async function setQuantity(page: Awaited<ReturnType<typeof pdp>>, value: number) {
  await page.get('[data-buy-row] select').setValue(String(value))
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
    expect(radios[1]!.attributes('data-variant-option')).toBe('102')
    expect(rows(page)[0]!.text().replace(/\s+/g, ' ')).toContain('12,10 €')
    expect(rows(page)[0]!.text()).toContain('0,12 €/ud')
    expect((page.get('[data-buy-row] select').element as HTMLSelectElement).value).toBe('1')
    await radios[2]!.trigger('click')
    expect(radios[2]!.attributes('aria-checked')).toBe('true')
    expect(page.get('[data-add-to-cart]').attributes('disabled')).toBeDefined()
    expect(add).not.toHaveBeenCalled()
  })

  it('adds exact formats and quantities through the selected-format purchase box', async () => {
    const page = await pdp()
    await setQuantity(page, 3)
    await page.get('[data-add-to-cart]').trigger('click')
    await flushPromises()
    await rows(page)[1]!.trigger('click')
    await setQuantity(page, 2)
    expect(page.get('[data-order-total]').text().replace(/\s+/g, ' ')).toContain('24,20 €')
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
    await setQuantity(page, 4)
    expect(
      page
        .get('[data-product-price]')
        .findAll('span')
        .some((span) => span.classes().includes('text-[26px]'))
    ).toBe(true)
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
    expect(rows(boxed)).toHaveLength(0)
    expect((boxed.get('[data-buy-row] select').element as HTMLSelectElement).value).toBe('10')
  })

  it('stops at an addition that fails and says which format', async () => {
    add.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('offline'))
    const page = await pdp()
    await setQuantity(page, 1)
    await page.get('[data-add-to-cart]').trigger('click')
    await flushPromises()
    await rows(page)[1]!.trigger('click')
    await setQuantity(page, 1)
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
    const documents = page.get('[data-product-safety]')
    expect(documents.text()).toContain('Ficha de seguridad (PDF)')
    expect(documents.get('[data-sds-link]').attributes('href')).toBe('/media/documents/fds.pdf')
    const html = page.html()
    expect(html.indexOf('data-product-safety')).toBeLessThan(html.indexOf('Guante desechable.'))
    const safety = page.get('[data-product-safety]')
    expect(safety.text()).toContain('Peligro')
    expect(page.get('[data-product-tabs]').text()).toContain('H314')
  })

  it('a regulated product without a data sheet says how to get it, in every environment', async () => {
    product = { ...base(), regulatory: { signalWord: 'Atención' } }
    const page = await pdp()
    expect(page.get('[data-product-safety] [data-sds-on-request]').text()).toContain(
      'Ficha de seguridad disponible bajo petición'
    )
    expect(page.get('[data-product-safety] [data-sds-on-request]').attributes('href')).toBe('/contacto')
    expect(page.text()).not.toContain('demostración')
  })

  it('a product that is not regulated and has no documents shows no empty documents block', async () => {
    expect((await pdp()).find('[data-product-safety]').exists()).toBe(false)
  })
})

describe('delivery estimate on the product page', () => {
  beforeEach(() => {
    localStorage.clear()
    clearNuxtState('delivery-destination')
    runtime.public.serverRuntime = 'node'
    runtime.public.commercial = {
      ownDeliveryDays: 'martes y jueves',
      orderCutoffTime: '13:00',
      parcelLeadTime: '24-72 h'
    }
  })
  afterEach(() => {
    runtime.public.serverRuntime = 'node'
    localStorage.clear()
  })

  it('uses the configured client promise in Cloudflare without the retired product-rates form', async () => {
    runtime.public.serverRuntime = 'cloudflare'
    const page = await pdp()
    expect(page.find('#delivery-postal-code').exists()).toBe(false)
    expect(page.text()).not.toContain('¿Cuándo me llega?')
    expect(page.find('[data-delivery-date]').exists()).toBe(true)
  })

  it('asks for the destination once and remembers it for the next product', async () => {
    const first = await pdp()
    expect(first.find('[data-delivery-change]').exists()).toBe(true)
    localStorage.setItem('neteco-destination', JSON.stringify({ postalCode: '46870', city: 'Ontinyent' }))
    const second = await pdp()
    await flushPromises()
    expect(second.get('[data-delivery-promise]').text()).toContain('46870 Ontinyent')
    expect(second.find('input[autocomplete="postal-code"]').exists()).toBe(false)
    await second.get('[data-delivery-change]').trigger('click')
    expect((second.get('input[autocomplete="postal-code"]').element as HTMLInputElement).value).toBe('46870')
  })

  it('needs only the postal code to refine and remember the configured date without a product-rates mutation', async () => {
    const page = await pdp()
    await page.get('[data-delivery-change]').trigger('click')
    expect(page.find('input[autocomplete="address-level2"]').exists()).toBe(false)
    await page.get('input[autocomplete="postal-code"]').setValue('28001')
    await page.get('[data-delivery-promise] form').trigger('submit')
    await flushPromises()
    expect(page.get('[data-delivery-promise]').text()).toContain('28001 Madrid')
    expect(page.get('[data-delivery-date]').text()).toMatch(
      /^(lunes|martes|miércoles|jueves|viernes), \d+ de noviembre$/
    )
    expect(JSON.parse(localStorage.getItem('neteco-destination') ?? 'null')).toEqual({
      postalCode: '28001',
      city: 'Madrid'
    })
    expect(
      fetchData.mock.calls.some(
        ([source]) => typeof source === 'string' && source.includes('/api/shipping/product-rates')
      )
    ).toBe(false)
    expect(request).not.toHaveBeenCalledWith('/api/shipping/product-rates', expect.anything())
  })
})

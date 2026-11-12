import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { defineComponent, h, ref, Suspense } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ProductDetailPage from '../../app/pages/producto/[slug].vue'
import ContactPage from '../../app/pages/contacto.vue'
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

/**
 * Ficha de un producto publicado sin precio público (catálogo importado del PDF: precio 0,
 * stock 0). Se ve la tabla de formatos con sus referencias, el precio dice «Consultar precio»,
 * nada dice «Agotado» ni «0,00 €», no se puede añadir y la acción principal es «Pedir precio».
 */
const unpriced = (id: number) => variant(id, { price: 0, netPrice: 0, stock: 0 })
const flat = (wrapper: { text: () => string }) => wrapper.text().replace(/\s+/g, ' ')

describe('product page without a public price', () => {
  it('keeps the format table with references and says "Consultar precio", never 0,00 € or "Agotado"', async () => {
    product = { ...base(), variants: [unpriced(1), unpriced(2)] }
    const page = await pdp()
    expect(rows(page)).toHaveLength(2)
    expect(flat(rows(page)[0]!)).toContain('Ref. 101')
    expect(flat(rows(page)[1]!)).toContain('Ref. 102')
    for (const row of rows(page)) {
      expect(flat(row)).toContain('Consultar precio')
      expect(row.find('input[inputmode="numeric"]').exists()).toBe(false)
    }
    expect(flat(page)).not.toMatch(/0,00|Agotado/)
  })

  it('replaces "Añadir al carrito" with "Pedir precio" to contact, with product and reference prefilled', async () => {
    product = { ...base(), variants: [unpriced(1), unpriced(2)] }
    const page = await pdp()
    expect(page.find('[data-add-to-cart]').exists()).toBe(false)
    expect(page.findAll('button').some((button) => button.text().includes('Añadir al carrito'))).toBe(false)
    const links = page.findAll('a[data-price-request]')
    expect(links.length).toBeGreaterThanOrEqual(2) // caja de compra y barra móvil
    const url = new URL(links[0]!.attributes('href')!, 'https://shop.invalid')
    expect(links[0]!.text()).toContain('Pedir precio')
    expect(url.pathname).toBe('/contacto')
    expect(url.searchParams.get('producto')).toBe('guante-nitrilo')
    expect(url.searchParams.get('asunto')).toBe('Precio de Guante de nitrilo · Ref. 101')
    expect(page.get('[data-mobile-buy-bar]').find('a[data-price-request]').exists()).toBe(true)
    expect(add).not.toHaveBeenCalled()
  })

  it('publishes no offer price of 0 in the structured data', async () => {
    product = { ...base(), variants: [unpriced(1)] }
    await pdp()
    const scripts = [...document.querySelectorAll('script[type="application/ld+json"]')].map((s) => s.textContent)
    expect(scripts.join('')).not.toMatch(/"price":"0\.00"/)
  })

  it('with some formats priced, only the unpriced rows ask for the price and the rest can be added', async () => {
    product = { ...base(), variants: [variant(1), unpriced(2)] }
    const page = await pdp()
    expect(flat(rows(page)[0]!)).toContain('12,10 €')
    expect(flat(rows(page)[1]!)).toContain('Consultar precio')
    expect(flat(rows(page)[1]!)).not.toContain('Agotado')
    await page.get('[data-add-to-cart]').trigger('click')
    await flushPromises()
    expect(add.mock.calls.map(([item]) => item.variantId)).toEqual([1])
  })
})

describe('contact page reached from "Pedir precio"', () => {
  it('opens with the product, subject and message already written', async () => {
    const page = await mountSuspended(ContactPage, {
      route:
        '/contacto?producto=guante-nitrilo&asunto=Precio%20de%20Guante%20de%20nitrilo%20%C2%B7%20Ref.%20101&mensaje=Quiero%20saber%20el%20precio.%20Cantidad%20aproximada%3A%20'
    })
    roots.push(page)
    const values = page.findAll('input, textarea').map((field) => (field.element as HTMLInputElement).value)
    expect(values).toContain('guante-nitrilo')
    expect(values).toContain('Precio de Guante de nitrilo · Ref. 101')
    expect(values).toContain('Quiero saber el precio. Cantidad aproximada: ')
  })
})

import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import Panel from '../../app/components/ProductDetailExtras.vue'
import { productDetailExtrasSchema } from '../../shared/product-detail-extras'
import '#app/nuxt-vitest-app-entry'

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  runtime: vi.fn(() => ({
    app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
    public: { serverRuntime: 'cloudflare' }
  }))
}))
mockNuxtImport('useRequestFetch', () => () => mocks.request)
mockNuxtImport('useRuntimeConfig', () => mocks.runtime)

const none = { signalWord: null, hazardStatements: [], hasHazardData: false }
const item = (productId: number, over: Record<string, unknown> = {}) => ({
  productId,
  slug: `alt-${productId}`,
  name: `Alternativa ${productId}`,
  brand: 'NETECO',
  minPrice: 1210 + productId,
  minNetPrice: 1000,
  formats: 1,
  availability: 'in_stock',
  pickupAvailable: true,
  hazard: none,
  ...over
})
function payload(over: Record<string, unknown> = {}) {
  return productDetailExtrasSchema.parse({
    source: 'cloudflare',
    productSlug: 'origen',
    warehouse: { single: true, pickupEnabled: true },
    availability: [
      { variantId: 11, sku: 'SKU-A', status: 'in_stock', sellable: 20, pickupAvailable: true },
      { variantId: 12, sku: 'SKU-B', status: 'out_of_stock', sellable: 0, pickupAvailable: false }
    ],
    hazard: { signalWord: 'Peligro', hazardStatements: ['H314 Provoca quemaduras graves'], hasHazardData: true },
    alternatives: [
      {
        ...item(2, { availability: 'out_of_stock', pickupAvailable: false, minPrice: 900 }),
        kind: 'substitute',
        reviewed: true
      },
      {
        ...item(3, {
          hazard: { signalWord: 'Atención', hazardStatements: ['H315 Irrita la piel'], hasHazardData: true }
        }),
        kind: 'equivalent',
        reviewed: true
      }
    ],
    complements: [
      { ...item(6), kind: 'accessory', basis: 'curated' },
      { ...item(7), kind: 'co_purchase', basis: 'co_purchase', support: 12, confidencePermille: 400 }
    ],
    notice: 'Las relaciones no garantizan compatibilidad química.',
    ...over
  })
}
const mounted: Awaited<ReturnType<typeof mountSuspended>>[] = []
async function render(props: Record<string, unknown> = {}) {
  const wrapper = await mountSuspended(Panel, { props: { productSlug: 'origen', variantId: 11, ...props } })
  mounted.push(wrapper)
  await flushPromises()
  return wrapper
}
beforeEach(() => {
  mocks.runtime.mockReturnValue({
    app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
    public: { serverRuntime: 'cloudflare' }
  })
  mocks.request.mockReset().mockResolvedValue(payload())
})
afterEach(() => {
  mounted.splice(0).forEach((wrapper) => wrapper.unmount())
  vi.restoreAllMocks()
})

it('requests one GET with the slug and renders warehouse availability and pickup for the selected variant', async () => {
  const wrapper = await render()
  expect(mocks.request).toHaveBeenCalledTimes(1)
  expect(mocks.request).toHaveBeenCalledWith(
    '/api/product-detail-extras',
    expect.objectContaining({ query: { slug: 'origen' }, retry: 0 })
  )
  expect(wrapper.text()).toContain('Almacén único')
  expect(wrapper.text()).toContain('20 uds. disponibles')
  expect(wrapper.text()).toContain('Recogida en almacén disponible')
})
it('follows the selected variant (out of stock variant has no pickup)', async () => {
  const wrapper = await render({ variantId: 12 })
  expect(wrapper.text()).toContain('Agotado')
  expect(wrapper.text()).toContain('Recogida no disponible')
  await wrapper.setProps({ variantId: 11 })
  expect(wrapper.text()).toContain('20 uds. disponibles')
  expect(mocks.request).toHaveBeenCalledTimes(1)
})
it('says pickup is not enabled when the store has it disabled', async () => {
  mocks.request.mockResolvedValue(payload({ warehouse: { single: true, pickupEnabled: false } }))
  const wrapper = await render()
  expect(wrapper.text()).toContain('Recogida no habilitada')
})
it('does not claim availability when the single warehouse cannot be established', async () => {
  mocks.request.mockResolvedValue(
    payload({
      warehouse: { single: false, pickupEnabled: false },
      availability: [{ variantId: 11, sku: 'SKU-A', status: 'unavailable', sellable: 0, pickupAvailable: false }]
    })
  )
  const wrapper = await render()
  expect(wrapper.text()).toContain('Disponibilidad no confirmada')
  expect(wrapper.text()).not.toContain('uds. disponibles')
})
it('shows hazards of the product and of every alternative, always', async () => {
  const wrapper = await render()
  const text = wrapper.text()
  expect(text).toContain('H314 Provoca quemaduras graves')
  expect(text).toContain('H315 Irrita la piel')
  expect(text).toContain('Peligro')
  expect(text).toContain('Atención')
  expect(text).toContain('Sin datos de peligro publicados')
})
it('links alternatives and complements, shows prices and the measured basis, never adds to cart', async () => {
  const wrapper = await render()
  expect(wrapper.find('a[href="/producto/alt-2"]').exists()).toBe(true)
  expect(wrapper.find('a[href="/producto/alt-3"]').exists()).toBe(true)
  expect(wrapper.find('a[href="/producto/alt-6"]').exists()).toBe(true)
  expect(wrapper.text()).toMatch(/12,13\s*€/)
  expect(wrapper.text()).toContain('Sustitución revisada')
  expect(wrapper.text()).toContain('Comprado junto en 12 pedidos')
  expect(wrapper.text()).toContain('Seleccionado por el equipo')
  expect(wrapper.text()).toContain('no garantizan compatibilidad química')
  expect(
    wrapper
      .findAll('button')
      .map((b) => b.text())
      .join(' ')
  ).not.toMatch(/Añadir/)
})
it('sorts client-side by price without refetching', async () => {
  const wrapper = await render()
  const order = () => wrapper.findAll('[data-alternative]').map((n) => n.attributes('data-alternative'))
  expect(order()).toEqual(['2', '3'])
  await wrapper.find('select[data-alternatives-sort]').setValue('availability')
  expect(order()).toEqual(['3', '2'])
  expect(mocks.request).toHaveBeenCalledTimes(1)
})
it('available-only hides out of stock alternatives but reports how many and keeps hazards of the rest', async () => {
  const wrapper = await render()
  await wrapper.find('input[data-available-only]').setValue(true)
  expect(wrapper.find('[data-alternative="2"]').exists()).toBe(false)
  expect(wrapper.text()).toContain('1 alternativa oculta por falta de stock')
  expect(wrapper.text()).toContain('H315 Irrita la piel')
})
it('shows an honest empty state for alternatives', async () => {
  mocks.request.mockResolvedValue(payload({ alternatives: [], complements: [] }))
  const wrapper = await render()
  expect(wrapper.text()).toContain('No hay alternativas revisadas')
  expect(wrapper.text()).not.toContain('Comprado junto')
  expect(wrapper.find('[role="alert"]').exists()).toBe(false)
})
it.each(['failure', 'malformed'])('fails closed on %s with an alert and no stale content', async (mode) => {
  if (mode === 'failure') mocks.request.mockRejectedValue(new Error('private SQL error'))
  else
    mocks.request.mockResolvedValue({ ...payload(), alternatives: [{ ...payload().alternatives[0], reviewed: false }] })
  const wrapper = await render()
  expect(wrapper.find('[role="alert"]').exists()).toBe(true)
  expect(wrapper.text()).not.toContain('Alternativa 2')
  expect(wrapper.text()).not.toContain('private SQL')
})
it('refetches when the slug changes and ignores a late response for the old slug', async () => {
  let release!: (value: unknown) => void
  mocks.request
    .mockImplementationOnce(() => new Promise((resolve) => (release = resolve)))
    .mockResolvedValueOnce(payload({ productSlug: 'nuevo' }))
  const wrapper = await mountSuspended(Panel, { props: { productSlug: 'origen', variantId: 11 } })
  mounted.push(wrapper)
  await wrapper.setProps({ productSlug: 'nuevo' })
  await flushPromises()
  release(payload({ alternatives: [] }))
  await flushPromises()
  expect(mocks.request).toHaveBeenCalledTimes(2)
  expect(wrapper.text()).toContain('Alternativa 2')
})
it('renders nothing and does not fetch outside the Cloudflare runtime', async () => {
  mocks.runtime.mockReturnValue({
    app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
    public: { serverRuntime: 'node' }
  })
  const wrapper = await render()
  expect(mocks.request).not.toHaveBeenCalled()
  expect(wrapper.text()).toBe('')
})

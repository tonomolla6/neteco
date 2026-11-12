// @vitest-environment nuxt
import { mockNuxtImport, mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import HomeReorder from '../../app/components/HomeReorder.vue'
import HomePage from '../../app/pages/index.vue'

const state = vi.hoisted(() => ({
  loggedIn: true,
  orders: [] as Array<Record<string, unknown>>,
  add: vi.fn(),
  start: vi.fn(),
  commercial: {} as Record<string, unknown>
}))
const nuxtRuntime = vi.hoisted(() => ({ original: null as null | (() => { public: Record<string, unknown> }) }))
mockNuxtImport('useRuntimeConfig', (original) => {
  nuxtRuntime.original = original as never
  return () => {
    const config = nuxtRuntime.original!()
    return { ...config, public: { ...config.public, mediaGoverned: true, commercial: state.commercial } }
  }
})
mockNuxtImport('useUserSession', () => () => ({
  loggedIn: ref(state.loggedIn),
  user: ref(state.loggedIn ? { id: 'u', name: 'Ana Pérez', email: 'a@example.invalid', company: 'Bar Central' } : null),
  session: ref(null),
  ready: ref(true)
}))
vi.mock('../../app/stores/cart', () => ({
  useCartStore: () => ({ add: state.add, error: '', blockedMutations: false, count: 0 })
}))

const orderLine = (variantId: number, quantity: number) => ({
  sku: `10${variantId}`,
  name: `Desengrasante ${variantId}`,
  format: 'Garrafa 5 L',
  quantity,
  unitGross: 1186,
  lineGross: 1186 * quantity,
  variantId,
  slug: `desengrasante-${variantId}`,
  image: null,
  visual: { type: 'garrafa', color: '#fff' },
  available: true,
  reason: null
})
const detail = (orderId: string, orderedAt: string, lines: unknown[]) => ({
  orderId,
  orderedAt,
  shippingMethod: 'reparto',
  paymentMethod: 'tarjeta',
  fulfillmentStatus: 'delivered',
  destination: null,
  totals: { subtotalNet: 0, shippingNet: 0, tax: 0, total: 0 },
  shipment: null,
  lines
})
registerEndpoint('/api/orders', () => ({ orders: state.orders }))
registerEndpoint('/api/orders/ord-9/lines', () =>
  detail('ord-9', '2026-10-03T10:00:00Z', [orderLine(1, 4), orderLine(2, 2)])
)
registerEndpoint('/api/orders/ord-8/lines', () => detail('ord-8', '2026-09-01T10:00:00Z', [orderLine(1, 4)]))
registerEndpoint('/api/categories', () => ({ roots: [], flat: [] }))
registerEndpoint('/api/products', () => ({ items: [], total: 0, page: 1, pages: 1 }))

const stubs = {
  ReorderDialog: { template: '<div data-reorder-dialog />', methods: { start: state.start } },
  ProductImage: true,
  PromotionalBlocks: true,
  SearchBox: true,
  HeroOfferSlider: true,
  ProductCard: true
}
const wrappers: Array<{ unmount: () => void }> = []
async function mount<T>(component: T) {
  const wrapper = await mountSuspended(component as never, { global: { stubs } })
  wrappers.push(wrapper)
  await flushPromises()
  await flushPromises()
  return wrapper
}
beforeEach(() => {
  state.loggedIn = true
  state.orders = [
    { id: 'ord-9', status: 'entregado', total: 14260, createdAt: '2026-10-03T10:00:00Z', lines: 8 },
    { id: 'ord-8', status: 'entregado', total: 5000, createdAt: '2026-09-01T10:00:00Z', lines: 1 }
  ]
  state.add.mockReset().mockResolvedValue(undefined)
  state.start.mockReset()
  state.commercial = {}
})
afterEach(() => wrappers.splice(0).forEach((wrapper) => wrapper.unmount()))

describe('home for a returning customer', () => {
  it('puts the last order and its one-click repeat first', async () => {
    const block = await mount(HomeReorder)
    expect(block.get('h1').text()).toBe('Hola, Bar Central')
    const last = block.get('[data-last-order]')
    expect(last.text()).toContain('Tu último pedido')
    expect(last.text()).toContain('8 referencias')
    expect(last.text().replace(/\s+/g, ' ')).toContain('142,60 €')
    await last.get('[data-repeat-order]').trigger('click')
    expect(state.start).toHaveBeenCalledWith('ord-9')
    expect(block.get('a[href="/pedido-rapido"]').text()).toContain('Pedido rápido')
    expect(block.get('a[href="/cuenta/listas"]').text()).toContain('Mis listas')
  })

  it('lists the habitual references with their usual quantity, ready to add', async () => {
    const block = await mount(HomeReorder)
    const rows = block.findAll('[data-habitual]')
    expect(rows).toHaveLength(2)
    expect(rows[0]!.text()).toContain('Desengrasante 1')
    expect(rows[0]!.text()).toContain('Ref. 101')
    expect((rows[0]!.get('input[inputmode="numeric"]').element as HTMLInputElement).value).toBe('4')
    await rows[0]!.get('[data-habitual-add]').trigger('click')
    await flushPromises()
    expect(state.add.mock.calls[0]![0]).toMatchObject({ variantId: 1, sku: '101' })
    expect(state.add.mock.calls[0]![1]).toBe(4)
    expect(rows[0]!.get('[data-habitual-add]').text()).toBe('Añadido')
  })

  it('states the next delivery only with configured route data', async () => {
    expect((await mount(HomeReorder)).find('[data-next-delivery]').exists()).toBe(false)
    state.commercial = { ownDeliveryDays: 'martes y jueves', orderCutoffTime: '13:00' }
    expect((await mount(HomeReorder)).get('[data-next-delivery]').text()).toContain(
      'martes y jueves. Pide antes de las 13:00.'
    )
  })

  it('renders nothing for a visitor or a customer without orders', async () => {
    state.orders = []
    expect((await mount(HomeReorder)).find('[data-home-reorder]').exists()).toBe(false)
    state.loggedIn = false
    state.orders = [{ id: 'ord-9', status: 'entregado', total: 1, createdAt: '2026-10-03T10:00:00Z', lines: 1 }]
    expect((await mount(HomeReorder)).find('[data-home-reorder]').exists()).toBe(false)
  })

  it('the home page shows the repeat block before the sales pitch, and the pitch only to newcomers', async () => {
    const returning = await mount(HomePage)
    const html = returning.html()
    expect(returning.find('[data-home-reorder]').exists()).toBe(true)
    expect(returning.find('[data-home-hero]').exists()).toBe(false)
    expect(html.indexOf('data-home-reorder')).toBeLessThan(html.indexOf('data-commercial-promises'))
    state.loggedIn = false
    const visitor = await mount(HomePage)
    expect(visitor.find('[data-home-reorder]').exists()).toBe(false)
    expect(visitor.find('[data-home-hero]').exists()).toBe(true)
    expect(visitor.get('[data-home-hero] a[href="/pedido-rapido"]').text()).toContain('pedir por referencia')
  })
})

import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { defineComponent, h, ref, shallowRef } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Overview from '../../app/pages/cuenta/index.vue'
import '#app/nuxt-vitest-app-entry'

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  lazy: vi.fn(),
  read: vi.fn(),
  session: vi.fn(),
  runtime: vi.fn(() => ({
    app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
    public: { serverRuntime: 'cloudflare' }
  })),
  start: vi.fn()
}))
mockNuxtImport('useFetch', () => mocks.fetch)
mockNuxtImport('useLazyFetch', () => mocks.lazy)
mockNuxtImport('useRequestFetch', () => () => mocks.read)
mockNuxtImport('useUserSession', () => mocks.session)
mockNuxtImport('useRuntimeConfig', () => mocks.runtime)
const OWNER = '71000000-0000-4000-8000-000000000001',
  ORDER = '72000000-0000-4000-8000-000000000001'
const TIME = '2026-10-08T10:00:00Z'
const PATHS = {
  orders: '/api/orders',
  profile: '/api/account',
  addresses: '/api/account/addresses',
  favorites: '/api/account/favorites'
} as const
type Resource = keyof typeof PATHS
function fixtures() {
  return {
    orders: {
      orders: [
        {
          id: ORDER,
          status: 'pendiente_pago',
          total: 12100,
          createdAt: TIME,
          lines: 1,
          invoiceAvailable: false,
          fullDetailAvailable: true
        }
      ]
    },
    profile: {
      profile: {
        name: 'Private owner',
        phone: null,
        email: 'owner@example.invalid',
        companyId: null,
        company: null,
        tradeName: null,
        taxId: null,
        countryCode: null,
        companyStatus: null,
        companyRole: null
      }
    },
    addresses: {
      addresses: [
        {
          id: '74000000-0000-4000-8000-000000000001',
          kind: 'shipping',
          label: 'Private address',
          recipientName: 'Private recipient',
          companyName: null,
          taxId: null,
          line1: 'Private street',
          line2: null,
          postalCode: '46001',
          city: 'Private city',
          region: 'Valencia',
          countryCode: 'ES',
          phone: null,
          instructions: null,
          isDefault: true,
          createdAt: TIME,
          updatedAt: TIME
        }
      ]
    },
    favorites: {
      lists: [
        {
          id: '75000000-0000-4000-8000-000000000001',
          name: 'Private list',
          isDefault: true,
          items: [
            {
              variantId: '76000000-0000-4000-8000-000000000001',
              cartVariantId: 11,
              sku: 'PRIVATE-SKU',
              quantity: '1',
              name: 'Private favorite',
              slug: 'synthetic-product',
              format: 'Caja',
              unitLabel: 'unidad',
              minimumQuantity: 1,
              maximumQuantity: null,
              quantityIncrement: 1,
              available: true,
              reason: null
            }
          ]
        }
      ]
    }
  }
}
function detail(orderId = ORDER) {
  return {
    orderId,
    orderedAt: TIME,
    shippingMethod: 'Recogida',
    paymentMethod: null,
    fulfillmentStatus: null,
    destination: null,
    totals: { subtotalNet: 10000, shippingNet: 0, tax: 2100, total: 12100 },
    shipment: null,
    lines: [
      {
        sku: 'PRIVATE-SKU',
        name: 'Private last-order product',
        format: 'Caja',
        quantity: 1,
        unitGross: 12100,
        lineGross: 12100,
        variantId: null,
        slug: null,
        image: null,
        visual: null,
        available: false,
        reason: 'No disponible',
        reorderOffer: null
      }
    ]
  }
}
const sessionState = () => ({
  ready: ref(true),
  loggedIn: ref(true),
  user: ref({ id: OWNER, emailVerified: true }),
  session: ref({ sessionId: '73000000-0000-4000-8000-000000000001', sessionVersion: 1 })
})
let session: ReturnType<typeof sessionState>
let payloads: Record<Resource, unknown>
let failures: Set<Resource>
let held: Partial<Record<Resource | 'lines', Promise<unknown>>>
let sources: Record<
  Resource,
  {
    data: ReturnType<typeof shallowRef>
    status: ReturnType<typeof ref<string>>
    error: ReturnType<typeof ref<unknown>>
  }
>
let wrapper: Awaited<ReturnType<typeof mountSuspended>> | undefined
const Slot = defineComponent({
  setup:
    (_, { slots }) =>
    () =>
      h('section', slots.default?.())
})
const Button = defineComponent({
  props: { disabled: Boolean, loading: Boolean },
  setup:
    (props, { attrs, slots }) =>
    () =>
      h('button', { ...attrs, disabled: props.disabled || props.loading }, slots.default?.())
})
const Empty = defineComponent({
  props: { title: String, description: String },
  setup:
    (props, { slots }) =>
    () =>
      h('section', [props.title, props.description, slots.default?.()])
})
const Dialog = defineComponent({
  emits: ['added'],
  setup: (_, { expose }) => {
    expose({ start: mocks.start })
    return () => h('div', { 'data-testid': 'overview-dialog' })
  }
})
function deferred() {
  let resolve!: (value: unknown) => void
  const promise = new Promise((done) => {
    resolve = done
  })
  return { resolve, promise }
}
beforeEach(() => {
  session = sessionState()
  payloads = fixtures()
  failures = new Set()
  held = {}
  sources = Object.fromEntries(
    Object.keys(PATHS).map((name) => [
      name,
      { data: shallowRef(payloads[name as Resource]), status: ref('success'), error: ref(null) }
    ])
  ) as typeof sources
  mocks.session.mockReturnValue(session)
  mocks.runtime.mockReturnValue({
    app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
    public: { serverRuntime: 'cloudflare' }
  })
  mocks.fetch.mockImplementation(
    (path: string) => sources[(Object.keys(PATHS) as Resource[]).find((name) => PATHS[name] === path)!]
  )
  mocks.lazy.mockReturnValue({ data: shallowRef(detail()) })
  mocks.read.mockReset()
  mocks.start.mockReset()
  mocks.read.mockImplementation(async (path: string) => {
    const name = (Object.keys(PATHS) as Resource[]).find((resource) => PATHS[resource] === path)
    if (!name) return held.lines ?? detail()
    if (failures.has(name)) throw new Error('private SQL owner@example.invalid failure')
    return held[name] ?? payloads[name]
  })
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  mocks.fetch.mockReset()
  mocks.lazy.mockReset()
})
async function render() {
  wrapper = await mountSuspended(Overview, {
    global: {
      stubs: {
        UiPageHeader: Slot,
        UiSurface: Slot,
        UiEmptyState: Empty,
        UButton: Button,
        UBadge: Slot,
        UIcon: true,
        ReorderDialog: Dialog,
        AccountFeedback: defineComponent({ props: { notice: String }, setup: (props) => () => h('p', props.notice) }),
        OrderLineThumb: true,
        AccountOrderRow: true
      }
    }
  })
  await flushPromises()
  return wrapper
}
describe('Cloudflare account overview confirmed read contract', () => {
  it('reads the actual four resources and correlated last-order lines using only GET', async () => {
    await render()
    expect(mocks.read.mock.calls.map(([path]) => path)).toEqual(
      expect.arrayContaining([...Object.values(PATHS), `/api/orders/${ORDER}/lines`])
    )
    expect(
      mocks.read.mock.calls.every(
        ([, options]) => options.method === 'GET' && options.retry === 0 && options.cache === 'no-store'
      )
    ).toBe(true)
    expect(wrapper!.text()).toContain('Private last-order product')
    expect(wrapper!.text()).toContain('121,00')
  })
  it('does not expose cached order or assert empty while its current read is loading', async () => {
    const hold = deferred()
    held.orders = hold.promise
    sources.orders.status.value = 'pending'
    await render()
    expect(wrapper!.text()).not.toContain(ORDER)
    expect(wrapper!.text()).not.toContain('Aún no has hecho ningún pedido')
    expect(wrapper!.find('[data-overview-loading="orders"]').exists()).toBe(true)
    hold.resolve(payloads.orders)
    await flushPromises()
    expect(wrapper!.text()).toContain(ORDER)
  })
  it.each(Object.keys(PATHS) as Resource[])(
    'shows %s failure without invented empty data or private errors',
    async (name) => {
      failures.add(name)
      sources[name].status.value = 'error'
      sources[name].data.value = null
      await render()
      expect(wrapper!.find(`[data-overview-error="${name}"]`).exists()).toBe(true)
      expect(wrapper!.text()).not.toContain('private SQL')
      if (name === 'orders') expect(wrapper!.text()).not.toContain('Aún no has hecho ningún pedido')
      if (name === 'favorites') expect(wrapper!.text()).not.toContain('Sin referencias guardadas')
      if (name === 'addresses') expect(wrapper!.text()).not.toContain('Sin direcciones')
    }
  )
  it.each(Object.keys(PATHS) as Resource[])('rejects malformed %s DTO instead of counting it', async (name) => {
    const invalid =
      name === 'orders'
        ? { orders: [{ ...fixtures().orders.orders[0], total: '12100' }] }
        : name === 'profile'
          ? { profile: { ...fixtures().profile.profile, companyId: 'invalid' } }
          : name === 'addresses'
            ? { addresses: [{ ...fixtures().addresses.addresses[0], isDefault: 'false' }] }
            : {
                lists: [
                  {
                    ...fixtures().favorites.lists[0],
                    items: [{ ...fixtures().favorites.lists[0]!.items[0], cartVariantId: '11' }]
                  }
                ]
              }
    payloads[name] = invalid
    sources[name].data.value = invalid
    await render()
    expect(wrapper!.find(`[data-overview-error="${name}"]`).exists()).toBe(true)
  })
  it('labels the bounded order snapshot honestly, not as an exact account total', async () => {
    const list = Array.from({ length: 200 }, (_, index) => ({
      ...fixtures().orders.orders[0],
      id: `72000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`
    }))
    payloads.orders = { orders: list }
    sources.orders.data.value = payloads.orders
    await render()
    expect(wrapper!.text()).not.toContain('200 en total')
    expect(wrapper!.text()).toContain('200 consultados')
    expect(wrapper!.text()).toContain('200 más recientes')
    expect(wrapper!.text()).not.toContain('Tienes 200 pedidos en curso')
  })
  it('summarises lists and delivery instead of repeating the account menu as cards', async () => {
    await render()
    const lists = wrapper!.get('[data-account-lists]')
    expect(lists.text()).toContain('Tus listas')
    expect(lists.text()).toContain('Private list')
    expect(lists.text()).toContain('1 referencia')
    expect(lists.get('a[href="/cuenta/listas"]').text()).toContain('Abrir mis listas')
    expect(wrapper!.find('a[href="/cuenta/seguridad"]').exists()).toBe(false)
    expect(wrapper!.text()).not.toContain('Contraseña, MFA y sesiones')
    expect(wrapper!.get('[data-account-delivery]').text()).toContain('Private city')
  })
  it('shows one default address without adding a phantom extra address', async () => {
    await render()
    expect(wrapper!.text()).not.toContain('Private city y 1 más')
    expect(wrapper!.text()).toContain('Private city')
  })
  it('does not register undefined order lines for confirmed empty orders', async () => {
    payloads.orders = { orders: [] }
    sources.orders.data.value = payloads.orders
    await render()
    expect(mocks.lazy).not.toHaveBeenCalled()
    expect(mocks.read.mock.calls.some(([path]) => String(path).includes('/undefined/'))).toBe(false)
    expect(wrapper!.text()).toContain('Aún no has hecho ningún pedido')
  })
  it('rejects foreign last-order lines and does not offer reorder from an unconfirmed detail', async () => {
    held.lines = Promise.resolve(detail('72000000-0000-4000-8000-000000000002'))
    mocks.lazy.mockReturnValue({ data: shallowRef(detail('72000000-0000-4000-8000-000000000002')) })
    await render()
    expect(wrapper!.text()).not.toContain('Private last-order product')
    expect(wrapper!.find('[data-overview-error="lines"]').exists()).toBe(true)
    const button = wrapper!.findAll('button').find((item) => item.text().includes('Volver a pedir'))!
    await button.trigger('click')
    expect(mocks.start).not.toHaveBeenCalled()
  })
  it.each(['email', 'sessionId', 'sessionVersion', 'identity', 'logout'] as const)(
    'purges private facts and dialog on %s boundary',
    async (boundary) => {
      await render()
      expect(wrapper!.text()).toContain(ORDER)
      if (boundary === 'email') session.user.value.emailVerified = false
      else if (boundary === 'sessionId') session.session.value.sessionId = ORDER
      else if (boundary === 'sessionVersion') session.session.value.sessionVersion++
      else if (boundary === 'identity') session.user.value.id = ORDER
      else session.loggedIn.value = false
      await flushPromises()
      expect(wrapper!.text()).not.toContain(ORDER)
      expect(wrapper!.text()).not.toContain('Private city')
      expect(wrapper!.text()).not.toContain('Private last-order product')
      expect(wrapper!.find('[data-testid="overview-dialog"]').exists()).toBe(false)
    }
  )
  it('does not read any private endpoint without verified current authority', async () => {
    session.user.value.emailVerified = false
    await render()
    expect(mocks.read).not.toHaveBeenCalled()
    expect(wrapper!.text()).not.toContain(ORDER)
  })
  it('waits for session hydration and then starts the initial confirmed reads', async () => {
    session.ready.value = false
    await render()
    expect(mocks.read).not.toHaveBeenCalled()
    expect(wrapper!.text()).not.toContain(ORDER)
    session.ready.value = true
    await flushPromises()
    expect(mocks.read.mock.calls.map(([path]) => path)).toEqual(expect.arrayContaining(Object.values(PATHS)))
    expect(wrapper!.text()).toContain(ORDER)
  })
  it('ignores late results after session rotation and unmount', async () => {
    const hold = deferred()
    held.orders = hold.promise
    sources.orders.status.value = 'pending'
    await render()
    session.session.value.sessionVersion++
    await flushPromises()
    hold.resolve(payloads.orders)
    await flushPromises()
    expect(wrapper!.text()).not.toContain(ORDER)
    wrapper!.unmount()
    expect(mocks.read.mock.calls.some(([path]) => String(path).endsWith('/lines'))).toBe(false)
  })
  it('retries a failed GET explicitly and deduplicates double clicks', async () => {
    failures.add('orders')
    sources.orders.status.value = 'error'
    sources.orders.data.value = null
    await render()
    failures.delete('orders')
    const hold = deferred()
    held.orders = hold.promise
    const before = mocks.read.mock.calls.filter(([path]) => path === PATHS.orders).length
    await wrapper!.get('[data-overview-retry="orders"]').trigger('click')
    await wrapper!.get('[data-overview-retry="orders"]').trigger('click')
    expect(mocks.read.mock.calls.filter(([path]) => path === PATHS.orders)).toHaveLength(before + 1)
    hold.resolve(payloads.orders)
    await flushPromises()
    expect(wrapper!.text()).toContain(ORDER)
  })
  it('preserves the existing Node read adapters and order card', async () => {
    mocks.runtime().public.serverRuntime = 'node'
    await render()
    expect(mocks.fetch).toHaveBeenCalledTimes(4)
    expect(mocks.read).not.toHaveBeenCalled()
    expect(wrapper!.text()).toContain(ORDER)
    expect(wrapper!.text()).toContain('Private last-order product')
  })
})

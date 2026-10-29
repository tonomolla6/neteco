import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { defineComponent, h, ref } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import DashboardPage from '../../app/pages/admin/index.vue'
import '#app/nuxt-vitest-app-entry'

const { fetchMock, runtimeMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  runtimeMock: vi.fn(() => ({
    app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
    public: { serverRuntime: 'cloudflare', baseUrl: 'https://neteco.invalid' }
  }))
}))
mockNuxtImport('useFetch', () => fetchMock)
mockNuxtImport('useRuntimeConfig', () => runtimeMock)
mockNuxtImport('useUserSession', () => () => ({
  ready: ref(true),
  loggedIn: ref(true),
  user: ref({ id: 'synthetic-admin', role: 'admin', mfaVerified: true }),
  session: ref(null),
  clear: async () => undefined,
  openInPopup: () => undefined,
  fetch: async () => undefined
}))

const surface = defineComponent({ template: '<section><slot /><slot name="actions" /></section>' })
const EmptyState = defineComponent({
  props: { title: String, description: String, variant: String },
  setup:
    (props, { slots }) =>
    () =>
      h('div', { 'data-empty-state': props.variant ?? 'empty' }, [props.title, props.description, slots.default?.()])
})
const Button = defineComponent({
  emits: ['click'],
  setup:
    (_props, { slots, emit }) =>
    () =>
      h('button', { onClick: () => emit('click') }, slots.default?.())
})
const Link = defineComponent({
  props: { to: String },
  setup:
    (props, { slots }) =>
    () =>
      h('a', { href: props.to }, slots.default?.())
})
interface OperationsFixture {
  source?: string
  generatedAt: string
  summary: Record<string, unknown>
  capabilities?: Record<string, boolean>
}
function fixture(): OperationsFixture {
  return {
    source: 'cloudflare',
    generatedAt: '2026-09-30T09:00:00Z',
    summary: { inventoryExceptions: null, fiscalExceptions: 0, emailDeliveryExceptions: 0 },
    capabilities: { inventoryExceptions: false, fiscalExceptions: true, emailDeliveryExceptions: true }
  }
}
async function render(
  initial = fixture(),
  runtime = 'cloudflare',
  initialStatus = 'success',
  options: {
    stats?: Record<string, unknown> | null
    statsStatus?: string
    orders?: Array<Record<string, unknown>>
    ordersStatus?: string
  } = {}
) {
  const data = ref(initial)
  const status = ref(initialStatus)
  const refresh = vi.fn()
  const stats = ref<Record<string, unknown> | null>(
    options.stats === undefined
      ? {
          source: 'cloudflare',
          products: 17,
          variants: 32,
          categories: 5,
          users: 3,
          awaitingPayment: 0,
          readyToShip: null,
          capabilities: { shipments: false }
        }
      : options.stats
  )
  const statsStatus = ref(options.statsStatus ?? 'success')
  const orders = ref(options.orders ?? [])
  const ordersStatus = ref(options.ordersStatus ?? 'success')
  runtimeMock.mockReturnValue({
    app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
    public: { serverRuntime: runtime, baseUrl: 'https://neteco.invalid' }
  })
  fetchMock.mockImplementation((path: string) => {
    if (path === '/api/admin/operations') return { data, status, refresh }
    if (path === '/api/admin/stats') return { data: stats, status: statsStatus, refresh: vi.fn() }
    return {
      data: ref({ items: orders.value }),
      status: ordersStatus,
      refresh: vi.fn()
    }
  })
  const wrapper = await mountSuspended(DashboardPage, {
    global: {
      stubs: {
        UiPageHeader: surface,
        UiSurface: surface,
        UiEmptyState: EmptyState,
        UIcon: true,
        UButton: Button,
        NuxtLink: Link
      }
    }
  })
  return { wrapper, data, status, refresh, stats, statsStatus }
}

describe('dashboard observed operations and nullable inventory', () => {
  beforeEach(() => {
    fetchMock.mockReset()
    runtimeMock.mockReset()
  })

  it('does not claim that stock was checked when its scoped diagnostic is unavailable', async () => {
    const { wrapper } = await render()
    expect(wrapper.text()).toContain('Sin incidencias en los procesos observados')
    expect(wrapper.text()).toContain('Revisados únicamente los contadores disponibles')
    expect(wrapper.text()).not.toContain('Comprobados stock')
    expect(wrapper.text()).not.toContain('Incidencias de inventario')
    wrapper.unmount()
  })

  it.each([undefined, 'node'])('rejects missing/wrong Cloudflare source (%s)', async (source) => {
    const initial = fixture()
    initial.source = source
    initial.summary.inventoryExceptions = 999
    initial.capabilities!.inventoryExceptions = true
    const { wrapper } = await render(initial)
    expect(wrapper.text()).toContain('Estado de los procesos no disponible')
    expect(wrapper.text()).not.toContain('Sin incidencias en los procesos observados')
    expect(wrapper.text()).not.toContain('Incidencias de inventario')
    wrapper.unmount()
  })

  it('does not turn absent capabilities into zero or a successful all-clear', async () => {
    const initial = fixture()
    delete initial.capabilities
    const { wrapper } = await render(initial)
    expect(wrapper.text()).toContain('No se puede confirmar que todo esté resuelto')
    expect(wrapper.text()).not.toContain('Sin incidencias en los procesos observados')
    wrapper.unmount()
  })

  it('treats an incomplete summary as unknown rather than failing the whole dashboard', async () => {
    const initial = fixture()
    Reflect.deleteProperty(initial, 'summary')
    const { wrapper } = await render(initial)
    expect(wrapper.text()).toContain('Estado de los procesos no disponible')
    expect(wrapper.text()).not.toContain('Sin incidencias en los procesos observados')
    wrapper.unmount()
  })

  it.each([-1, 1.5, NaN, '2', null])('rejects invalid observed count %s', async (count) => {
    const initial = fixture()
    initial.summary = { inventoryExceptions: count }
    initial.capabilities = { inventoryExceptions: true }
    const { wrapper } = await render(initial)
    expect(wrapper.text()).toContain('Estado de los procesos no disponible')
    expect(wrapper.text()).not.toContain('Incidencias de inventario')
    wrapper.unmount()
  })

  it('links a verified inventory incident to its actual operations diagnostic', async () => {
    const initial = fixture()
    initial.summary.inventoryExceptions = 3
    initial.capabilities!.inventoryExceptions = true
    const { wrapper, data } = await render(initial)
    const incident = wrapper.findAll('a').find((link) => link.text().includes('Incidencias de inventario'))
    expect(incident?.attributes('href')).toBe('/admin/operaciones')
    expect(incident?.text()).toContain('3')
    data.value.capabilities = {}
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).not.toContain('Incidencias de inventario')
    expect(wrapper.text()).toContain('Estado de los procesos no disponible')
    wrapper.unmount()
  })

  it('does not release stale successful counts after a failed refresh and permits retry', async () => {
    const initial = fixture()
    initial.summary.inventoryExceptions = 3
    initial.capabilities!.inventoryExceptions = true
    const { wrapper, refresh } = await render(initial, 'cloudflare', 'error')
    expect(wrapper.text()).toContain('No hemos podido comprobar el estado de la tienda')
    expect(wrapper.text()).not.toContain('Incidencias de inventario')
    const retry = wrapper.findAll('button').find((button) => button.text() === 'Reintentar')
    expect(retry).toBeDefined()
    await retry!.trigger('click')
    expect(refresh).toHaveBeenCalledOnce()
    wrapper.unmount()
  })

  it('keeps a pending read separate from observed zero and unknown/error', async () => {
    const { wrapper } = await render(fixture(), 'cloudflare', 'pending')
    expect(wrapper.findAll('.animate-pulse')).toHaveLength(4)
    expect(wrapper.text()).not.toContain('Sin incidencias en los procesos observados')
    expect(wrapper.text()).not.toContain('Estado de los procesos no disponible')
    wrapper.unmount()
  })

  it('preserves ordinary Node counts without a capabilities extension', async () => {
    const initial = fixture()
    delete initial.source
    delete initial.capabilities
    initial.summary.inventoryExceptions = 2
    const { wrapper } = await render(initial, 'node')
    expect(wrapper.text()).toContain('Incidencias de inventario')
    expect(wrapper.text()).not.toContain('Estado de los procesos no disponible')
    wrapper.unmount()
  })

  it('preserves the ordinary Node observed-zero presentation', async () => {
    const initial = fixture()
    delete initial.source
    delete initial.capabilities
    initial.summary.inventoryExceptions = 0
    const { wrapper } = await render(initial, 'node')
    expect(wrapper.text()).toContain('No hay nada bloqueado')
    expect(wrapper.text()).not.toContain('Estado de los procesos no disponible')
    wrapper.unmount()
  })

  it.each(['pending', 'error', 'idle'])('does not display stale statistics during a %s read', async (statsStatus) => {
    const { wrapper } = await render(fixture(), 'cloudflare', 'success', {
      stats: { source: 'cloudflare', products: 999, awaitingPayment: 999, readyToShip: 999 },
      statsStatus
    })
    expect(wrapper.text()).not.toContain('999')
    expect(wrapper.text()).toContain('Recuento no disponible')
    expect(wrapper.text()).toContain('Expedición no disponible en este entorno')
    wrapper.unmount()
  })

  it.each([undefined, 'node'])('does not derive Cloudflare counts from foreign/missing stats (%s)', async (source) => {
    const { wrapper } = await render(fixture(), 'cloudflare', 'success', {
      stats: { source, products: 999, awaitingPayment: 999 },
      orders: [{ paymentStatus: 'pending' }, { paymentStatus: 'captured', fulfillmentStatus: 'pending' }]
    })
    expect(wrapper.text()).not.toContain('999')
    expect(wrapper.text()).toContain('Recuento no disponible')
    expect(wrapper.text()).not.toContain('Nada pendiente de preparar')
    wrapper.unmount()
  })

  it('does not enable an unimplemented fulfillment queue or product creation from forged capabilities', async () => {
    const { wrapper } = await render(fixture(), 'cloudflare', 'success', {
      stats: {
        source: 'cloudflare',
        awaitingPayment: 5,
        readyToShip: 999,
        capabilities: { shipments: true, productCreate: true }
      }
    })
    expect(wrapper.text()).toContain('Expedición no disponible en este entorno')
    expect(wrapper.text()).not.toContain('999')
    expect(wrapper.text()).not.toContain('Nuevo producto')
    expect(wrapper.text()).toContain('Pedidos sin pago confirmado')
    wrapper.unmount()
  })

  it('does not interpret an unknown runtime as authorized Node compatibility', async () => {
    const { wrapper } = await render(fixture(), 'unknown', 'success', {
      stats: { products: 999, awaitingPayment: 999 },
      orders: [{ paymentStatus: 'captured', fulfillmentStatus: 'pending' }]
    })
    expect(wrapper.text()).toContain('Estado de los procesos no disponible')
    expect(wrapper.text()).toContain('Recuento no disponible')
    expect(wrapper.text()).not.toContain('999')
    expect(wrapper.text()).not.toContain('Nuevo producto')
    expect(wrapper.text()).not.toContain('Listos para preparar en almacén')
    wrapper.unmount()
  })

  it.each([-1, 1.5, '2', null])(
    'does not treat invalid Cloudflare payment count %s as observed zero',
    async (awaitingPayment) => {
      const { wrapper } = await render(fixture(), 'cloudflare', 'success', {
        stats: { source: 'cloudflare', awaitingPayment },
        orders: [{ paymentStatus: 'pending' }]
      })
      expect(wrapper.text()).toContain('Recuento no disponible')
      expect(wrapper.text()).not.toContain('No hay pedidos esperando cobro')
      wrapper.unmount()
    }
  )

  it('preserves Node legacy queues and creation while requiring a successful refresh', async () => {
    const { wrapper, statsStatus } = await render(fixture(), 'node', 'success', {
      stats: { products: 17 },
      orders: [{ paymentStatus: 'pending' }, { paymentStatus: 'captured', fulfillmentStatus: 'pending' }]
    })
    expect(wrapper.text()).toContain('Nuevo producto')
    expect(wrapper.text()).toContain('Listos para preparar en almacén')
    expect(wrapper.text()).toContain('Pedidos sin pago confirmado')
    statsStatus.value = 'pending'
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).not.toContain('Listos para preparar en almacén')
    expect(wrapper.text()).not.toContain('Pedidos sin pago confirmado')
    wrapper.unmount()
  })
})

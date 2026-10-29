import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { nextTick, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AccountOrderRow from '../../app/components/AccountOrderRow.vue'
import type { OrderDetailLines } from '../../app/composables/useAccount'
import '#app/nuxt-vitest-app-entry'

const { lazyFetch, sessionMock, refresh } = vi.hoisted(() => ({
  lazyFetch: vi.fn(),
  sessionMock: vi.fn(),
  refresh: vi.fn()
}))
mockNuxtImport('useLazyFetch', () => lazyFetch)
mockNuxtImport('useUserSession', () => sessionMock)
const order = { id: 'NE123', status: 'pagado', total: 363, createdAt: '2026-10-08T10:00:00Z', lines: 1 }
function detail(): OrderDetailLines {
  return {
    orderId: order.id,
    orderedAt: order.createdAt,
    shippingMethod: 'envio',
    paymentMethod: null,
    fulfillmentStatus: 'packed',
    destination: { line1: null, postalCode: '46001', city: 'Ciudad privada' },
    totals: { subtotalNet: 300, shippingNet: 0, tax: 63, total: 363 },
    shipment: null,
    lines: [
      {
        sku: 'PRIVATE-SKU',
        name: 'Producto privado',
        format: 'Caja',
        quantity: 3,
        unitGross: 121,
        lineGross: 363,
        variantId: 101,
        slug: 'producto',
        image: null,
        visual: null,
        available: true,
        reason: null
      }
    ]
  }
}
let data = ref<OrderDetailLines | null>(null)
let status = ref('success')
let user = ref({ id: 'customer-one' })
let session = ref({ sessionId: 'session-one', sessionVersion: 1 })
let wrapper: Awaited<ReturnType<typeof mountSuspended>> | undefined
async function mount() {
  wrapper = await mountSuspended(AccountOrderRow, {
    props: { order, defaultOpen: true },
    global: {
      stubs: {
        UIcon: true,
        OrderLineThumb: { props: ['line'], template: '<div data-private-thumb>{{line.sku}}</div>' },
        UBadge: { template: '<span><slot /></span>' },
        UButton: {
          props: ['to', 'disabled', 'loading'],
          template:
            '<a v-if="to" :href="to"><slot /></a><button v-else :disabled="disabled || loading"><slot /></button>'
        }
      }
    }
  })
  return wrapper
}
beforeEach(() => {
  vi.clearAllMocks()
  data = ref(detail())
  status = ref('success')
  user = ref({ id: 'customer-one' })
  session = ref({ sessionId: 'session-one', sessionVersion: 1 })
  sessionMock.mockReturnValue({ user, session, loggedIn: ref(true) })
  lazyFetch.mockResolvedValue({ data, status, refresh })
  refresh.mockResolvedValue(undefined)
})
afterEach(() => wrapper?.unmount())

describe('private order detail presentation', () => {
  it('shows the confirmed fulfillment translation without inventing tracking', async () => {
    const page = await mount()
    expect(page.text()).toContain('Empaquetado')
    expect(page.text()).toContain('Producto privado')
    expect(page.text()).not.toContain('packed')
    expect(page.text()).not.toContain('Número de seguimiento')
  })
  it.each(['pending', 'error', 'idle'])('does not expose stale private data in %s', async (nextStatus) => {
    const page = await mount()
    status.value = nextStatus
    await nextTick()
    expect(page.text()).not.toContain('Producto privado')
    expect(page.text()).not.toContain('PRIVATE-SKU')
    expect(page.text()).not.toContain('Ciudad privada')
    expect(page.text()).not.toContain('Empaquetado')
    expect(page.find('dl').exists()).toBe(false)
    expect(page.find('[data-private-thumb]').exists()).toBe(false)
  })
  it('rejects a detail belonging to a different order', async () => {
    data.value = { ...detail(), orderId: 'OTHER' }
    const page = await mount()
    expect(page.text()).not.toContain('Producto privado')
    expect(page.get('[role="alert"]').text()).toContain('No hemos podido cargar')
  })
  it('hides detail immediately after the session scope changes, including a late response', async () => {
    const page = await mount()
    session.value.sessionVersion = 2
    await nextTick()
    expect(page.text()).not.toContain('Producto privado')
    data.value = detail()
    await nextTick()
    expect(page.text()).not.toContain('Producto privado')
    expect(page.find('dl').exists()).toBe(false)
  })
  it('allows an explicit single-flight read retry, never a cart mutation', async () => {
    status.value = 'error'
    const page = await mount()
    let finish!: () => void
    refresh.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        })
    )
    const button = page.get('[data-order-detail-retry]')
    await button.trigger('click')
    await button.trigger('click')
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(page.text()).not.toContain('Producto privado')
    status.value = 'success'
    finish()
    await flushPromises()
    expect(page.text()).toContain('Producto privado')
  })
})

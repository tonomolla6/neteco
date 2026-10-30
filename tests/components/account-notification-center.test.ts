import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AccountNotificationCenter from '../../app/components/AccountNotificationCenter.vue'
import '#app/nuxt-vitest-app-entry'

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  write: vi.fn(),
  auth: { value: null as unknown }
}))

mockNuxtImport('useRequestFetch', () => () => mocks.request)
mockNuxtImport('$fetch', () => mocks.write)
mockNuxtImport('useUserSession', () => () => mocks.auth.value)
mockNuxtImport('useRuntimeConfig', () => () => ({
  app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
  public: { serverRuntime: 'cloudflare' }
}))

let wrapper: { unmount: () => void } | undefined

describe('AccountNotificationCenter.vue', () => {
  beforeEach(() => {
    mocks.auth.value = {
      ready: ref(true),
      loggedIn: ref(true),
      user: ref({
        id: '10000000-0000-4000-8000-000000000046',
        email: 'buyer@example.invalid',
        emailVerified: true
      }),
      session: ref({
        sessionId: '20000000-0000-4000-8000-000000000046',
        sessionVersion: 1
      })
    }
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
    vi.restoreAllMocks()
  })

  it('renders loading state and displays empty state when there are no notifications', async () => {
    mocks.request.mockResolvedValueOnce({
      total: 0,
      unread: 0,
      byCategory: {
        pedido: { total: 0, unread: 0 },
        factura: { total: 0, unread: 0 },
        stock: { total: 0, unread: 0 },
        soporte: { total: 0, unread: 0 }
      }
    })
    mocks.request.mockResolvedValueOnce({
      total: 0,
      items: []
    })

    const component = await mountSuspended(AccountNotificationCenter)
    await flushPromises()
    wrapper = component

    expect(component.text()).toContain('Centro de notificaciones')
    expect(component.text()).toContain('No tienes notificaciones en esta sección')
    expect(component.find('[data-test="category-tab-all"]').exists()).toBe(true)
    expect(component.find('[data-test="category-tab-pedido"]').exists()).toBe(true)
    expect(component.find('[data-test="category-tab-factura"]').exists()).toBe(true)
    expect(component.find('[data-test="category-tab-stock"]').exists()).toBe(true)
    expect(component.find('[data-test="category-tab-soporte"]').exists()).toBe(true)
  })

  it('renders notifications with categories, unread badges and mandatory notice', async () => {
    mocks.request.mockResolvedValueOnce({
      total: 2,
      unread: 1,
      byCategory: {
        pedido: { total: 1, unread: 0 },
        factura: { total: 1, unread: 1 },
        stock: { total: 0, unread: 0 },
        soporte: { total: 0, unread: 0 }
      }
    })
    mocks.request.mockResolvedValueOnce({
      total: 2,
      items: [
        {
          id: '11111111-1111-4111-8111-111111111111',
          customerId: '10000000-0000-4000-8000-000000000046',
          category: 'factura',
          title: 'Factura F-2026-001 emitida',
          body: 'Tu factura legal ya está lista.',
          link: '/cuenta/pedidos',
          read: false,
          readAt: null,
          mandatory: true,
          metadata: {},
          createdAt: '2026-10-29T20:00:00Z',
          updatedAt: '2026-10-29T20:00:00Z'
        },
        {
          id: '22222222-2222-4222-8222-222222222222',
          customerId: '10000000-0000-4000-8000-000000000046',
          category: 'pedido',
          title: 'Pedido entregado',
          body: 'El pedido fue entregado satisfactoriamente.',
          link: '/cuenta/pedidos',
          read: true,
          readAt: '2026-10-29T21:00:00Z',
          mandatory: false,
          metadata: {},
          createdAt: '2026-10-29T19:00:00Z',
          updatedAt: '2026-10-29T21:00:00Z'
        }
      ]
    })

    const component = await mountSuspended(AccountNotificationCenter)
    await flushPromises()
    wrapper = component

    expect(component.text()).toContain('Factura F-2026-001 emitida')
    expect(component.text()).toContain('Pedido entregado')
    // Mandatory communication indicator
    expect(component.text()).toContain('Obligatoria')
    // Legal guarantee message
    expect(component.text()).toContain('Las notificaciones obligatorias no sustituyen los envíos legales por email')
  })

  it('handles mark all as read action', async () => {
    mocks.request.mockResolvedValueOnce({
      total: 1,
      unread: 1,
      byCategory: {
        pedido: { total: 0, unread: 0 },
        factura: { total: 0, unread: 0 },
        stock: { total: 1, unread: 1 },
        soporte: { total: 0, unread: 0 }
      }
    })
    mocks.request.mockResolvedValueOnce({
      total: 1,
      items: [
        {
          id: '33333333-3333-4333-8333-333333333333',
          customerId: '10000000-0000-4000-8000-000000000046',
          category: 'stock',
          title: 'Stock disponible',
          body: 'Producto de nuevo en stock',
          link: null,
          read: false,
          readAt: null,
          mandatory: false,
          metadata: {},
          createdAt: '2026-10-29T20:00:00Z',
          updatedAt: '2026-10-29T20:00:00Z'
        }
      ]
    })
    mocks.write.mockResolvedValueOnce({ affectedCount: 1 })

    const component = await mountSuspended(AccountNotificationCenter)
    await flushPromises()
    wrapper = component

    const markAllBtn = component.find('[data-test="btn-mark-all-read"]')
    expect(markAllBtn.exists()).toBe(true)
    await markAllBtn.trigger('click')

    expect(mocks.write).toHaveBeenCalledWith(
      '/api/account/notifications/mark-read',
      expect.objectContaining({
        method: 'POST',
        body: { all: true }
      })
    )
  })
})

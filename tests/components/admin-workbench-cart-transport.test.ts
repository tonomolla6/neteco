import { createRequire } from 'node:module'
import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h, ref } from 'vue'
import { useNuxtApp } from '#app'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import cartPlugin from '../../app/plugins/cart.client'
import { useCartStore } from '../../app/stores/cart'
import {
  createWorkbenchBrowserBridge,
  allowsOrderOperationsForeignRead
} from '../../scripts/lib/audit-native-order-operations-browser'
import '#app/nuxt-vitest-app-entry'

// Only the browser runner is excluded; both exported transport policies are real.
vi.mock('@playwright/test', () => ({
  chromium: {
    connect: () => {
      throw new Error('Browser connection is forbidden in component transport tests')
    },
    launch: () => {
      throw new Error('Browser launch is forbidden in component transport tests')
    }
  },
  expect: () => {
    throw new Error('Playwright assertions are forbidden in component transport tests')
  }
}))

const mocks = vi.hoisted(() => ({ request: vi.fn() }))
mockNuxtImport('$fetch', () => mocks.request)
mockNuxtImport('useRuntimeConfig', () => () => ({
  app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
  public: { serverRuntime: 'cloudflare' }
}))
mockNuxtImport('useUserSession', () => () => ({
  ready: ref(true),
  loggedIn: ref(true),
  user: ref({ id: 'synthetic-workbench-owner' }),
  session: ref({ sessionId: 'synthetic-workbench-session', sessionVersion: 1 })
}))
mockNuxtImport('useAnalytics', () => () => ({ track: vi.fn() }))

// A Playwright route forwards Node requests with Cookie intact. Browser Request
// implementations deliberately strip that header and are not this boundary.
const nodeFetch = createRequire(import.meta.url)('undici') as typeof import('undici')
const TransportRequest = nodeFetch.Request as unknown as typeof Request
const TransportResponse = nodeFetch.Response as unknown as typeof Response
const origin = 'https://shop-audit.neteco.test'
const sessionCookie = 'neteco-session=synthetic-workbench-session'
const originalCookie = sessionCookie + '; neteco-cart=synthetic-cart-cookie; ordinary-consent=synthetic'
const snapshot = {
  id: '10000000-0000-4000-8000-000000000087',
  version: 2,
  status: 'active',
  expiresAt: '2099-01-01T00:00:00Z',
  items: [],
  count: 0,
  subtotal: 0,
  subtotalNet: 0,
  tax: 0
}
let wrapper: Awaited<ReturnType<typeof mountSuspended>> | undefined
beforeEach(() => {
  mocks.request.mockReset()
  localStorage.removeItem('neteco-cart-cache')
  localStorage.removeItem('neteco-cart')
  localStorage.removeItem('neteco-cart-add-v1')
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  localStorage.removeItem('neteco-cart-cache')
  localStorage.removeItem('neteco-cart')
  localStorage.removeItem('neteco-cart-add-v1')
})

it.each(['owned_workbench', 'foreign_read'] as const)(
  'hydrates the actual global cart plugin and store through %s before logout with one original-cookie GET',
  async (transport) => {
    const dispatched: Request[] = []
    const dispatch = async (request: Request) => {
      dispatched.push(request.clone())
      return TransportResponse.json(snapshot)
    }
    const bridge = createWorkbenchBrowserBridge({
      origin,
      dispatch,
      bulk: {
        adminCookie: sessionCookie,
        orderIds: ['10000000-0000-4000-8000-000000000086'],
        async readCommittedBulk() {
          throw new Error('Cart hydration must not read a bulk commit')
        },
        async consumeBulkQueue() {
          throw new Error('Cart hydration must not consume a queue')
        }
      }
    })
    mocks.request.mockImplementation(async (path: string, options?: { method?: string }) => {
      const request = new TransportRequest(new URL(path, origin), {
        method: options?.method ?? 'GET',
        headers: { Cookie: originalCookie }
      })
      let response: Response | null = null
      if (transport === 'foreign_read') {
        if (allowsOrderOperationsForeignRead(request, { origin })) response = await dispatch(request)
      } else {
        const result = await bridge.forward(request)
        if (result.action === 'fulfill') response = result.response
      }
      if (!response) throw new Error('Actual workbench transport rejected global cart hydration')
      return response.json()
    })
    const pinia = createPinia()
    setActivePinia(pinia)
    let cart!: ReturnType<typeof useCartStore>
    wrapper = await mountSuspended(
      defineComponent({
        setup() {
          cart = useCartStore(pinia)
          // Execute the actual global plugin in its Nuxt context, not a copied
          // load callback or a replacement store implementation.
          cartPlugin(useNuxtApp())
          return () => h('output', { 'data-cart-hydrated': cart.ready && !cart.error }, cart.id ?? '')
        }
      }),
      { global: { plugins: [pinia] } }
    )
    await flushPromises()
    await vi.waitFor(() => expect(cart.loading).toBe(false))
    expect(dispatched).toHaveLength(1)
    expect(dispatched[0]!.method).toBe('GET')
    expect(dispatched[0]!.url).toBe(origin + '/api/cart')
    expect(dispatched[0]!.headers.get('cookie')).toBe(originalCookie)
    expect(mocks.request).toHaveBeenCalledTimes(1)
    expect(mocks.request.mock.calls[0]![0]).toBe('/api/cart')
    expect(cart.ready).toBe(true)
    expect(cart.error).toBe('')
    expect(cart.id).toBe(snapshot.id)
    expect(cart.version).toBe(snapshot.version)
    expect(cart.items).toEqual(snapshot.items)
    expect(cart.serverTotals).toEqual({ subtotal: 0, subtotalNet: 0, tax: 0 })
    expect(wrapper.get('[data-cart-hydrated="true"]').text()).toBe(snapshot.id)
    expect(bridge.proof.logoutPosts).toBe(0)
  }
)

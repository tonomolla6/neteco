import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { defineComponent, h, reactive, ref } from 'vue'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import Section from '../../app/components/CartRecoverySection.vue'
import Footer from '../../app/components/AppFooter.vue'
import AccountLayout from '../../app/layouts/cuenta.vue'
import '#app/nuxt-vitest-app-entry'

const mocks = vi.hoisted(() => ({
  cart: null as unknown,
  auth: null as unknown,
  runtime: vi.fn(() => ({
    app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
    public: { serverRuntime: 'cloudflare', appEnv: 'local' }
  }))
}))
vi.mock('../../app/stores/cart', () => ({ useCartStore: () => mocks.cart }))
mockNuxtImport('useUserSession', () => () => mocks.auth)
mockNuxtImport('useRuntimeConfig', () => mocks.runtime)
const ID = '10000000-0000-4000-8000-000000000090',
  SID = '20000000-0000-4000-8000-000000000090',
  CART = '30000000-0000-4000-8000-000000000090'
const Panel = defineComponent({
  name: 'CartRecoveryPanel',
  props: ['scopeKey', 'enabled', 'pending', 'cartId', 'cartVersion', 'stage'],
  setup: () => () => h('section', { 'data-recovery-surface': '' })
})
const Link = defineComponent({
  props: ['to'],
  setup:
    (p, { slots }) =>
    () =>
      h('a', { href: p.to }, slots.default?.())
})
const stubs = {
  CartRecoveryPanel: Panel,
  AppHeader: true,
  ConsentManager: true,
  UIcon: true,
  UInput: true,
  UButton: { template: '<button><slot /></button>' },
  USelectMenu: true,
  NuxtLink: Link
}
let store: {
  id: string
  version: number
  ready: boolean
  loading: boolean
  error: string
  pendingMutation: boolean
  items: { variantId: number; qty: number }[]
}
let auth: {
  ready: ReturnType<typeof ref<boolean>>
  loggedIn: ReturnType<typeof ref<boolean>>
  user: ReturnType<typeof ref<{ id: string; emailVerified: boolean }>>
  session: ReturnType<typeof ref<{ sessionId: string; sessionVersion: number }>>
  clear: () => Promise<void>
}
const mounted: Array<{ unmount: () => void }> = []
beforeEach(() => {
  store = reactive({
    id: CART,
    version: 2,
    ready: true,
    loading: false,
    error: '',
    pendingMutation: false,
    items: [{ variantId: 11, qty: 2 }]
  })
  auth = {
    ready: ref(true),
    loggedIn: ref(true),
    user: ref({ id: ID, emailVerified: true }),
    session: ref({ sessionId: SID, sessionVersion: 1 }),
    clear: async () => undefined
  }
  mocks.cart = store
  mocks.auth = auth
  mocks.runtime.mockReturnValue({
    app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
    public: { serverRuntime: 'cloudflare', appEnv: 'local' }
  })
})
afterEach(() => mounted.splice(0).forEach((w) => w.unmount()))
async function render(component: typeof Section | typeof Footer | typeof AccountLayout, props = {}) {
  const wrapper = await mountSuspended(component, { props, global: { stubs } })
  mounted.push(wrapper)
  return wrapper
}

it.each(['cart', 'checkout'] as const)(
  'binds the explicit %s recovery control to the authoritative cart and current verified owner',
  async (stage) => {
    const wrapper = await render(Section, { stage })
    const panel = wrapper.getComponent(Panel)
    expect(panel.props()).toMatchObject({ enabled: true, cartId: CART, cartVersion: 2, stage })
    const first = panel.props('scopeKey')
    auth.session.value = { sessionId: SID, sessionVersion: 2 }
    await wrapper.vm.$nextTick()
    expect(panel.props('scopeKey')).not.toBe(first)
  }
)
it('withholds cart recovery association while a cart read or mutation is unconfirmed', async () => {
  const wrapper = await render(Section, { stage: 'cart' })
  expect(wrapper.findComponent(Panel).exists()).toBe(true)
  store.pendingMutation = true
  await wrapper.vm.$nextTick()
  expect(wrapper.findComponent(Panel).exists()).toBe(false)
  store.pendingMutation = false
  store.error = 'unconfirmed'
  await wrapper.vm.$nextTick()
  expect(wrapper.findComponent(Panel).exists()).toBe(false)
})
it('does not expose a recovery writer for anonymous or legacy carts', async () => {
  auth.loggedIn.value = false
  expect((await render(Section, { stage: 'cart' })).findComponent(Panel).exists()).toBe(false)
  auth.loggedIn.value = true
  mocks.runtime.mockReturnValue({
    app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
    public: { serverRuntime: 'node', appEnv: 'local' }
  })
  expect((await render(Section, { stage: 'checkout' })).findComponent(Panel).exists()).toBe(false)
})
it('makes the published resource hub discoverable from the actual Cloudflare footer', async () => {
  const wrapper = await render(Footer)
  expect(wrapper.find('a[href="/recursos"]').exists()).toBe(true)
})
it('does not expose the Cloudflare resource hub in the legacy footer', async () => {
  mocks.runtime.mockReturnValue({
    app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
    public: { serverRuntime: 'node', appEnv: 'local' }
  })
  expect((await render(Footer)).find('a[href="/recursos"]').exists()).toBe(false)
})
it('makes dedicated recovery consent discoverable in the actual Cloudflare account shell', async () => {
  expect((await render(AccountLayout)).find('nav a[href="/cuenta/recuperar-carrito"]').exists()).toBe(true)
})
it('does not expose dedicated recovery in the legacy account shell', async () => {
  mocks.runtime.mockReturnValue({
    app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
    public: { serverRuntime: 'node', appEnv: 'local' }
  })
  expect((await render(AccountLayout)).find('nav a[href="/cuenta/recuperar-carrito"]').exists()).toBe(false)
})

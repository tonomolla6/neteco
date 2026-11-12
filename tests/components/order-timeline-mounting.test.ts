import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { nextTick, reactive, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AccountOrderRow from '../../app/components/AccountOrderRow.vue'
import AdminOrder from '../../app/pages/admin/pedidos/[id].vue'
import '#app/nuxt-vitest-app-entry'

// Actual mounting contract, with the real timeline child/read: closed lists,
// Node, guests, stale detail or authority must never trigger a timeline GET.
const mocks = vi.hoisted(() => ({
  runtime: vi.fn(() => ({
    app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
    public: { serverRuntime: 'cloudflare' }
  })),
  session: vi.fn(),
  lazy: vi.fn(),
  fetch: vi.fn(),
  request: vi.fn(),
  route: vi.fn(),
  navigation: vi.fn()
}))
mockNuxtImport('useRuntimeConfig', () => mocks.runtime)
mockNuxtImport('useUserSession', () => mocks.session)
mockNuxtImport('useLazyFetch', () => mocks.lazy)
mockNuxtImport('useFetch', () => mocks.fetch)
mockNuxtImport('useRequestFetch', () => () => mocks.request)
mockNuxtImport('useRoute', () => mocks.route)
mockNuxtImport('useAdminNavigation', () => mocks.navigation)
const ORDER = '10000000-0000-4000-8000-000000000001',
  OTHER = '10000000-0000-4000-8000-000000000002'
const IDENTITY = '20000000-0000-4000-8000-000000000001',
  SESSION = '30000000-0000-4000-8000-000000000001'
const summary = () => ({ id: ORDER, status: 'pagado', total: 121, createdAt: '2026-10-08T12:00:00Z', lines: 1 })
const customerDetail = () => ({
  orderId: ORDER,
  orderedAt: '2026-10-08T12:00:00Z',
  shippingMethod: 'pickup',
  paymentMethod: null,
  fulfillmentStatus: null,
  destination: null,
  totals: { subtotalNet: 100, shippingNet: 0, tax: 21, total: 121 },
  shipment: null,
  lines: []
})
const adminDetail = () => ({
  order: {
    id: ORDER,
    status: 'pagado',
    orderStatus: 'confirmed',
    paymentStatus: 'captured',
    fulfillmentStatus: 'pending',
    inventoryStatus: 'allocated',
    invoiceStatus: 'pending',
    shippingMethod: 'pickup',
    paymentMethod: 'tarjeta',
    createdAt: '2026-10-08T12:00:00Z',
    confirmedAt: null,
    updatedAt: '2026-10-08T12:00:00Z',
    totals: { subtotalNet: 100, discountNet: null, shippingNet: 0, tax: 21, total: 121 }
  },
  capabilities: {
    orderStatusUpdate: false,
    shipments: false,
    tracking: false,
    invoices: false,
    customerPreview: false
  },
  customer: { name: null, email: null, phone: null, company: null, companyStatus: null, taxId: null, isGuest: false },
  shippingAddress: null,
  billingAddress: null,
  lines: [],
  payments: [],
  shipments: [],
  returns: [],
  invoices: [],
  notes: [],
  history: [],
  timeline: [
    {
      id: 'legacy-private-correlation',
      eventType: 'synthetic_legacy_event',
      actorType: 'legacy-actor',
      origin: 'legacy-origin',
      reason: 'Legacy private reason',
      createdAt: '2026-10-08T12:00:00Z',
      fromState: null,
      toState: null
    }
  ]
})
let loggedIn = ref(true),
  user = ref<{ id: string; emailVerified?: boolean }>({ id: IDENTITY, emailVerified: true }),
  session = ref({ sessionId: SESSION, sessionVersion: 1 })
let customerData = ref<unknown>(customerDetail()),
  adminData = ref<unknown>(adminDetail()),
  customerStatus = ref('success'),
  adminStatus = ref('success'),
  adminError = ref<unknown>(null)
let navStatus = ref('ready'),
  capabilities = ref<unknown>(null),
  route = reactive({ params: { id: ORDER }, path: `/admin/pedidos/${ORDER}`, fullPath: `/admin/pedidos/${ORDER}` })
type Wrapper = Awaited<ReturnType<typeof mountSuspended>>
const mounted: Wrapper[] = []
async function render(audience: 'customer' | 'admin', props = {}) {
  const wrapper = await mountSuspended(audience === 'customer' ? AccountOrderRow : AdminOrder, {
    props: audience === 'customer' ? { order: summary(), defaultOpen: true, ...props } : {},
    global: {
      stubs: {
        UiSurface: { template: '<div><slot /></div>' },
        UiPageHeader: { template: '<header><slot name="actions" /></header>' },
        UiEmptyState: { props: ['title'], template: '<div>{{title}}<slot /></div>' },
        UBadge: { template: '<span><slot /></span>' },
        UButton: { props: ['to'], template: '<a v-if="to" :href="to"><slot /></a><button v-else><slot /></button>' },
        UModal: true,
        UIcon: true,
        OrderLineThumb: true,
        OrderCancellationPanel: true,
        OrderRefundPanel: true,
        OrderFulfillmentSection: true,
        OrderTrackingPanel: true,
        OrderFiscalSection: true,
        BeplyOrderPanel: true,
        AdminRefundActions: true
      }
    }
  })
  mounted.push(wrapper)
  await flushPromises()
  return wrapper
}
beforeEach(() => {
  mocks.runtime.mockReturnValue({
    app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
    public: { serverRuntime: 'cloudflare' }
  })
  loggedIn = ref(true)
  user = ref({ id: IDENTITY, emailVerified: true })
  session = ref({ sessionId: SESSION, sessionVersion: 1 })
  customerData = ref(customerDetail())
  adminData = ref(adminDetail())
  customerStatus = ref('success')
  adminStatus = ref('success')
  adminError = ref(null)
  navStatus = ref('ready')
  capabilities = ref({
    source: 'cloudflare',
    identityId: IDENTITY,
    sessionId: SESSION,
    sessionVersion: 1,
    state: 'ready',
    permissions: ['administration.manage']
  })
  route = reactive({ params: { id: ORDER }, path: `/admin/pedidos/${ORDER}`, fullPath: `/admin/pedidos/${ORDER}` })
  mocks.session.mockImplementation(() => ({ loggedIn, user, session }))
  mocks.navigation.mockImplementation(() => ({ status: navStatus, capabilities }))
  mocks.route.mockImplementation(() => route)
  mocks.lazy.mockResolvedValue({ data: customerData, status: customerStatus, refresh: vi.fn() })
  mocks.fetch.mockResolvedValue({ data: adminData, status: adminStatus, error: adminError, refresh: vi.fn() })
  mocks.request.mockReset().mockImplementation(async (path: string) => ({
    source: 'cloudflare',
    orderId: ORDER,
    audience: path.includes('/admin/') ? 'admin' : 'customer',
    items: [],
    nextCursor: null
  }))
})
afterEach(() => mounted.splice(0).forEach((wrapper) => wrapper.unmount()))

describe('timeline actual mounting', () => {
  it('purges customer timeline on email verification loss within the same session, permanently for this mounted row', async () => {
    mocks.request.mockResolvedValue({
      source: 'cloudflare',
      orderId: ORDER,
      audience: 'customer',
      items: [
        {
          id: 'checkout:existing',
          kind: 'checkout',
          state: 'created',
          createdAt: '2026-10-08T12:00:00Z',
          validationOnly: null
        }
      ],
      nextCursor: null
    })
    const wrapper = await render('customer')
    expect(wrapper.text()).toContain('Pedido registrado')
    const unchangedSession = { ...session.value }
    user.value.emailVerified = false
    await nextTick()
    expect(session.value).toEqual(unchangedSession)
    expect(wrapper.text()).not.toContain('Historial del pedido')
    expect(wrapper.text()).not.toContain('Pedido registrado')
    user.value.emailVerified = true
    customerData.value = customerDetail()
    await flushPromises()
    expect(wrapper.text()).not.toContain('Historial del pedido')
    expect(mocks.request).toHaveBeenCalledTimes(1)
  })
  it('mounts one real customer timeline only after the confirmed row is opened', async () => {
    const wrapper = await render('customer', { defaultOpen: false })
    expect(mocks.request).not.toHaveBeenCalled()
    await wrapper.get('button').trigger('click')
    await flushPromises()
    expect(mocks.request).toHaveBeenCalledExactlyOnceWith(
      `/api/orders/${ORDER}/timeline`,
      expect.objectContaining({ method: 'GET' })
    )
    expect(wrapper.text()).toContain('Historial del pedido')
    await wrapper.get('button').trigger('click')
    expect(wrapper.text()).not.toContain('Historial del pedido')
  })
  it.each(['node', 'guest', 'pending', 'error', 'wrong-order', 'invalid-detail', 'missing-session'] as const)(
    'does not mount customer timeline for %s',
    async (mode) => {
      if (mode === 'node')
        mocks.runtime.mockReturnValue({
          app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
          public: { serverRuntime: 'node' }
        })
      if (mode === 'guest') loggedIn.value = false
      if (mode === 'pending' || mode === 'error') customerStatus.value = mode
      if (mode === 'wrong-order') customerData.value = { ...customerDetail(), orderId: OTHER }
      if (mode === 'invalid-detail') customerData.value = { orderId: ORDER }
      if (mode === 'missing-session') session.value = { sessionId: '', sessionVersion: 1 }
      const wrapper = await render('customer')
      expect(mocks.request).not.toHaveBeenCalled()
      expect(wrapper.text()).not.toContain('Historial del pedido')
    }
  )
  it.each(['pending', 'error', 'owner', 'session', 'order', 'logout'] as const)(
    'unmounts the real customer timeline on %s and ignores old detail',
    async (mode) => {
      const wrapper = await render('customer')
      expect(wrapper.text()).toContain('Historial del pedido')
      if (mode === 'pending' || mode === 'error') customerStatus.value = mode
      if (mode === 'owner') user.value = { id: '20000000-0000-4000-8000-000000000002' }
      if (mode === 'session') session.value.sessionVersion = 2
      if (mode === 'order') await wrapper.setProps({ order: { ...summary(), id: OTHER } })
      if (mode === 'logout') loggedIn.value = false
      await nextTick()
      expect(wrapper.text()).not.toContain('Historial del pedido')
      customerData.value = customerDetail()
      await nextTick()
      expect(wrapper.text()).not.toContain('Historial del pedido')
      expect(mocks.request).toHaveBeenCalledTimes(1)
    }
  )
  it('replaces only the Cloudflare legacy trace with one authorized real admin timeline', async () => {
    const wrapper = await render('admin')
    expect(mocks.request).toHaveBeenCalledExactlyOnceWith(
      `/api/admin/orders/${ORDER}/timeline`,
      expect.objectContaining({ method: 'GET' })
    )
    expect(wrapper.text()).toContain('Historial del pedido')
    expect(wrapper.text()).not.toContain('Legacy private reason')
    expect(wrapper.text()).not.toContain('quién hizo qué y cuándo')
  })
  it('preserves the existing Node trace and makes no unified timeline GET', async () => {
    mocks.runtime.mockReturnValue({
      app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
      public: { serverRuntime: 'node' }
    })
    const wrapper = await render('admin')
    expect(mocks.request).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('Legacy private reason')
    expect(wrapper.text()).toContain('quién hizo qué y cuándo')
  })
  it.each([
    'pending',
    'error',
    'wrong-order',
    'guest',
    'cap-pending',
    'cap-error',
    'no-grant',
    'wrong-identity',
    'wrong-session',
    'mfa'
  ] as const)('never mounts admin timeline from %s authority/detail', async (mode) => {
    if (mode === 'pending') adminStatus.value = 'pending'
    if (mode === 'error') adminError.value = { statusCode: 403 }
    if (mode === 'wrong-order') adminData.value = { ...adminDetail(), order: { ...adminDetail().order, id: OTHER } }
    if (mode === 'guest') loggedIn.value = false
    if (mode === 'cap-pending') navStatus.value = 'loading'
    if (mode === 'cap-error') navStatus.value = 'error'
    if (mode === 'no-grant') capabilities.value = { ...(capabilities.value as object), permissions: ['catalog.write'] }
    if (mode === 'wrong-identity') capabilities.value = { ...(capabilities.value as object), identityId: OTHER }
    if (mode === 'wrong-session') capabilities.value = { ...(capabilities.value as object), sessionVersion: 2 }
    if (mode === 'mfa')
      capabilities.value = { ...(capabilities.value as object), state: 'mfa_required', permissions: [] }
    const wrapper = await render('admin')
    expect(mocks.request).not.toHaveBeenCalled()
    expect(wrapper.text()).not.toContain('Historial del pedido')
    expect(wrapper.text()).not.toContain('Legacy private reason')
  })
  it.each(['pending', 'error', 'session', 'grant', 'route'] as const)(
    'purges the mounted admin timeline on %s without reusing a stale detail',
    async (mode) => {
      const wrapper = await render('admin')
      expect(wrapper.text()).toContain('Historial del pedido')
      if (mode === 'pending') navStatus.value = 'loading'
      if (mode === 'error') adminError.value = { statusCode: 503 }
      if (mode === 'session') session.value.sessionVersion = 2
      if (mode === 'grant') capabilities.value = { ...(capabilities.value as object), permissions: [] }
      if (mode === 'route') route.params.id = OTHER
      await nextTick()
      expect(wrapper.text()).not.toContain('Historial del pedido')
      expect(mocks.request).toHaveBeenCalledTimes(1)
    }
  )
})

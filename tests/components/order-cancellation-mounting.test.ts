import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { defineComponent, nextTick, reactive, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AccountOrderRow from '../../app/components/AccountOrderRow.vue'
import AdminOrder from '../../app/pages/admin/pedidos/[id].vue'
import OrdersPage from '../../app/pages/cuenta/pedidos.vue'
import ReorderDialog from '../../app/components/ReorderDialog.vue'
import '#app/nuxt-vitest-app-entry'

const mocks = vi.hoisted(() => ({
  runtime: vi.fn(() => ({
    app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
    public: { serverRuntime: 'cloudflare' }
  })),
  session: vi.fn(),
  lazy: vi.fn(),
  fetch: vi.fn(),
  route: vi.fn(),
  navigation: vi.fn(),
  request: vi.fn(),
  detailRefresh: vi.fn(),
  listRefresh: vi.fn(),
  reorder: vi.fn(),
  reorderState: vi.fn(),
  leave: [] as Array<() => unknown>,
  update: [] as Array<() => unknown>
}))
mockNuxtImport('useRuntimeConfig', () => mocks.runtime)
mockNuxtImport('useUserSession', () => mocks.session)
mockNuxtImport('useLazyFetch', () => mocks.lazy)
mockNuxtImport('useFetch', () => mocks.fetch)
mockNuxtImport('useRoute', () => mocks.route)
mockNuxtImport('useAdminNavigation', () => mocks.navigation)
mockNuxtImport('useReorder', () => mocks.reorderState)
mockNuxtImport('useRequestFetch', () => () => mocks.request)
mockNuxtImport('onBeforeRouteLeave', () => (fn: () => unknown) => mocks.leave.push(fn))
mockNuxtImport('onBeforeRouteUpdate', () => (fn: () => unknown) => mocks.update.push(fn))
const ORDER = '10000000-0000-4000-8000-000000000001',
  OTHER = '10000000-0000-4000-8000-000000000002',
  IDENTITY = '20000000-0000-4000-8000-000000000001',
  SESSION = '30000000-0000-4000-8000-000000000001'
const summary = (id = ORDER) => ({
  id,
  status: 'pendiente_pago',
  total: 12100,
  createdAt: '2026-10-08T12:00:00Z',
  lines: 0,
  invoiceAvailable: false,
  fullDetailAvailable: false
})
const detail = (orderId = ORDER) => ({
  orderId,
  orderedAt: '2026-10-08T12:00:00Z',
  shippingMethod: 'pickup',
  paymentMethod: null,
  fulfillmentStatus: null,
  destination: null,
  totals: { subtotalNet: 10000, shippingNet: 0, tax: 2100, total: 12100 },
  shipment: null,
  lines: []
})
const adminDetail = () => ({
  order: {
    id: ORDER,
    status: 'pendiente_pago',
    orderStatus: 'awaiting_payment',
    paymentStatus: 'pending',
    fulfillmentStatus: 'pending',
    inventoryStatus: 'reserved',
    invoiceStatus: 'unavailable',
    shippingMethod: 'pickup',
    paymentMethod: 'tarjeta',
    createdAt: '2026-10-08T12:00:00Z',
    confirmedAt: null,
    updatedAt: '2026-10-08T12:00:00Z',
    totals: { subtotalNet: 10000, discountNet: null, shippingNet: 0, tax: 2100, total: 12100 }
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
  timeline: []
})
const receipt = (orderId = ORDER) => ({
  source: 'cloudflare',
  orderId,
  commandId: '40000000-0000-4000-8000-000000000001',
  outcome: 'cancelled',
  orderStatus: 'cancelled',
  inventoryEffect: 'released',
  updatedAt: '2026-10-08T12:00:00Z'
})
const Panel = defineComponent({
  name: 'OrderCancellationPanel',
  props: ['orderId', 'audience', 'scopeKey', 'enabled', 'pending'],
  emits: ['pending', 'confirmed'],
  template:
    '<section data-cancel-panel><button data-cancel-ambiguous @click="$emit(\'pending\',true)">Ambiguous</button><button data-cancel-clear @click="$emit(\'pending\',false)">Clear</button></section>'
})
const Timeline = defineComponent({
  name: 'OrderTimelinePanel',
  props: ['orderId', 'audience', 'scopeKey', 'enabled', 'pending'],
  template: '<div data-timeline />'
})
const Notes = defineComponent({
  name: 'OrderAnnotationsPanel',
  props: ['orderId', 'scopeKey', 'enabled', 'pending'],
  emits: ['pending', 'confirmed'],
  template: '<section data-private-annotations />'
})
const Fulfillment = defineComponent({
  name: 'OrderFulfillmentSection',
  emits: ['pending'],
  template: '<div data-preparation />'
})
const Reorder = defineComponent({
  name: 'ReorderDialog',
  setup() {
    return { start: mocks.reorder }
  },
  template: '<div />'
})
const stubs = {
  OrderCancellationPanel: Panel,
  OrderTimelinePanel: Timeline,
  OrderTrackingPanel: true,
  OrderAnnotationsPanel: Notes,
  OrderFulfillmentSection: Fulfillment,
  OrderFiscalSection: true,
  BeplyOrderPanel: true,
  OrderRefundPanel: true,
  AdminRefundActions: true,
  OrderLineThumb: true,
  AccountFeedback: true,
  ReorderDialog: Reorder,
  UiSurface: { template: '<div><slot /></div>' },
  UiPageHeader: { template: '<header><slot name="actions" /></header>' },
  UiEmptyState: { template: '<div><slot /></div>' },
  UBadge: { template: '<span><slot /></span>' },
  UIcon: true,
  UModal: true,
  UButton: {
    props: ['to', 'disabled'],
    template:
      '<a v-if="to" :href="to" :aria-disabled="disabled"><slot /></a><button v-else :disabled="disabled"><slot /></button>'
  },
  UInput: { props: ['modelValue', 'disabled'], template: '<input :value="modelValue" :disabled="disabled" />' },
  USelect: { props: ['disabled'], template: '<select :disabled="disabled" />' }
}
let loggedIn = ref(true),
  user = ref({ id: IDENTITY, emailVerified: true, mfaVerified: true }),
  session = ref({ sessionId: SESSION, sessionVersion: 1 })
let customerData = ref<unknown>(detail()),
  customerStatus = ref('success'),
  adminData = ref<unknown>(adminDetail()),
  adminStatus = ref('success'),
  adminError = ref<unknown>(null),
  navStatus = ref('ready'),
  caps = ref<unknown>(null),
  route = reactive({ params: { id: ORDER } })
type Wrapper = Awaited<ReturnType<typeof mountSuspended>>
const mounted: Wrapper[] = []
const originalConfirmDescriptor = Object.getOwnPropertyDescriptor(window, 'confirm')
async function render(audience: 'customer' | 'admin' | 'list' = 'customer', defaultOpen = true) {
  const wrapper = await mountSuspended(
    audience === 'customer' ? AccountOrderRow : audience === 'admin' ? AdminOrder : OrdersPage,
    { props: audience === 'customer' ? { order: summary(), defaultOpen } : {}, global: { stubs } }
  )
  mounted.push(wrapper)
  await flushPromises()
  return wrapper
}
const panel = (wrapper: Wrapper) => wrapper.findComponent(Panel)
async function ambiguous(wrapper: Wrapper) {
  await panel(wrapper).get('[data-cancel-ambiguous]').trigger('click')
  await flushPromises()
}
beforeEach(() => {
  Object.defineProperty(window, 'confirm', { value: vi.fn(() => false), configurable: true, writable: true })
  loggedIn = ref(true)
  user = ref({ id: IDENTITY, emailVerified: true, mfaVerified: true })
  session = ref({ sessionId: SESSION, sessionVersion: 1 })
  customerData = ref(detail())
  customerStatus = ref('success')
  adminData = ref(adminDetail())
  adminStatus = ref('success')
  adminError = ref(null)
  navStatus = ref('ready')
  caps = ref({
    source: 'cloudflare',
    identityId: IDENTITY,
    sessionId: SESSION,
    sessionVersion: 1,
    state: 'ready',
    permissions: ['administration.manage']
  })
  route = reactive({ params: { id: ORDER } })
  mocks.runtime.mockReturnValue({
    app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
    public: { serverRuntime: 'cloudflare' }
  })
  mocks.session.mockImplementation(() => ({ loggedIn, user, session, ready: ref(true) }))
  mocks.navigation.mockImplementation(() => ({ status: navStatus, capabilities: caps }))
  mocks.route.mockImplementation(() => route)
  mocks.detailRefresh.mockReset().mockResolvedValue(undefined)
  mocks.listRefresh.mockReset().mockResolvedValue(undefined)
  mocks.reorder.mockReset().mockResolvedValue(undefined)
  mocks.request.mockReset()
  mocks.lazy.mockImplementation(async (path: string) => ({
    data: path.includes(OTHER) ? ref(detail(OTHER)) : customerData,
    status: customerStatus,
    refresh: mocks.detailRefresh
  }))
  mocks.fetch.mockImplementation(async (path: unknown) =>
    typeof path === 'string' && path === '/api/orders'
      ? { data: ref({ orders: [summary(), summary(OTHER)] }), status: ref('success'), refresh: mocks.listRefresh }
      : { data: adminData, status: adminStatus, error: adminError, refresh: mocks.detailRefresh }
  )
  mocks.leave.length = 0
  mocks.update.length = 0
})
afterEach(() => {
  mounted.splice(0).forEach((wrapper) => wrapper.unmount())
  vi.restoreAllMocks()
  if (originalConfirmDescriptor) Object.defineProperty(window, 'confirm', originalConfirmDescriptor)
  else Reflect.deleteProperty(window, 'confirm')
})
describe('governed cancellation actual page mounting', () => {
  it('mounts private notes only in the current authorized Cloudflare admin order', async () => {
    const wrapper = await render('admin')
    expect(wrapper.findComponent(Notes).props()).toMatchObject({ orderId: ORDER, enabled: true, pending: false })
    expect(wrapper.findComponent(Notes).props('scopeKey')).toContain(SESSION)
    expect(mocks.request).not.toHaveBeenCalled()
  })
  it.each(['node', 'customer', 'mfa', 'grant'] as const)('does not mount private annotations for %s', async (mode) => {
    if (mode === 'node')
      mocks.runtime.mockReturnValue({
        app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
        public: { serverRuntime: 'node' }
      })
    if (mode === 'mfa') user.value.mfaVerified = false
    if (mode === 'grant') caps.value = { ...(caps.value as object), permissions: [] }
    expect((await render(mode === 'customer' ? 'customer' : 'admin')).findComponent(Notes).exists()).toBe(false)
  })
  it('preserves ambiguous notes recovery while blocking competing cancellation, preparation and navigation', async () => {
    const wrapper = await render('admin')
    wrapper.findComponent(Notes).vm.$emit('pending', true)
    await nextTick()
    expect(wrapper.findComponent(Notes).props()).toMatchObject({ enabled: true, pending: false })
    expect(panel(wrapper).props('pending')).toBe(true)
    expect(wrapper.findComponent(Fulfillment).exists()).toBe(false)
    expect(mocks.leave.at(-1)?.()).toBe(false)
    wrapper.findComponent(Notes).vm.$emit('pending', false)
    await nextTick()
    expect(panel(wrapper).props('pending')).toBe(false)
    expect(wrapper.findComponent(Fulfillment).exists()).toBe(true)
  })
  it('blocks annotations while cancellation is unresolved, without replacing either private scope', async () => {
    const wrapper = await render('admin')
    const notes = wrapper.findComponent(Notes).vm
    await ambiguous(wrapper)
    expect(wrapper.findComponent(Notes).props('pending')).toBe(true)
    expect(wrapper.findComponent(Notes).vm).toBe(notes)
  })
  it('purges the private notes lock on authority revocation', async () => {
    const wrapper = await render('admin')
    wrapper.findComponent(Notes).vm.$emit('pending', true)
    await nextTick()
    session.value.sessionVersion++
    await nextTick()
    expect(wrapper.findComponent(Notes).exists()).toBe(false)
    expect(mocks.leave.at(-1)?.()).not.toBe(false)
  })
  it('reports real reorder activity until close or authority revocation, including unmount cleanup', async () => {
    const state = {
      plan: ref<unknown>(null),
      loading: ref(false),
      adding: ref(false),
      canRetry: ref(false),
      error: ref(''),
      availableLines: ref([]),
      unavailableLines: ref([]),
      addedCount: ref(0),
      open: vi.fn(),
      close: vi.fn(),
      confirm: vi.fn(),
      retry: vi.fn(),
      unavailableReason: vi.fn()
    }
    mocks.reorderState.mockReturnValue(state)
    const wrapper = await mountSuspended(ReorderDialog, { global: { stubs: { UModal: true } } })
    mounted.push(wrapper)
    state.loading.value = true
    await nextTick()
    expect(wrapper.emitted('activity')?.at(-1)).toEqual([true])
    state.loading.value = false
    state.error.value = 'Resultado pendiente'
    await nextTick()
    expect(wrapper.emitted('activity')?.at(-1)).toEqual([true])
    session.value.sessionVersion++
    await nextTick()
    expect(wrapper.emitted('activity')?.at(-1)).toEqual([false])
    loggedIn.value = true
    state.error.value = ''
    await nextTick()
    state.adding.value = true
    await nextTick()
    expect(wrapper.emitted('activity')?.at(-1)).toEqual([true])
    wrapper.unmount()
    expect(wrapper.emitted('activity')?.at(-1)).toEqual([false])
  })
  it('blocks cancellation without destroying an already active reorder dialog', async () => {
    const wrapper = await render('list'),
      dialog = wrapper.findComponent(Reorder)
    dialog.vm.$emit('activity', true)
    await nextTick()
    expect(wrapper.findComponent(Reorder).vm.$.uid).toBe(dialog.vm.$.uid)
    expect(panel(wrapper).props('pending')).toBe(true)
    dialog.vm.$emit('activity', false)
    await nextTick()
    expect(panel(wrapper).props('pending')).toBe(false)
  })
  it('preserves an already pending preparation child and disables cancellation instead', async () => {
    const wrapper = await render('admin')
    const preparation = wrapper.findComponent(Fulfillment)
    preparation.vm.$emit('pending', true)
    await nextTick()
    expect(wrapper.findComponent(Fulfillment).vm).toBe(preparation.vm)
    expect(panel(wrapper).props('pending')).toBe(true)
  })
  it.each(['customer', 'admin'] as const)(
    'mounts one %s panel with the validated order and private authority scope',
    async (audience) => {
      const wrapper = await render(audience)
      expect(panel(wrapper).exists()).toBe(true)
      expect(panel(wrapper).props()).toMatchObject({ orderId: ORDER, audience, enabled: true, pending: false })
      expect(panel(wrapper).props('scopeKey')).toContain(SESSION)
      expect(mocks.request).not.toHaveBeenCalled()
    }
  )
  it('never mounts a customer panel for a closed row', async () => {
    const wrapper = await render('customer', false)
    expect(panel(wrapper).exists()).toBe(false)
    await wrapper.get('button').trigger('click')
    expect(panel(wrapper).exists()).toBe(true)
  })
  it.each(['customer', 'admin'] as const)('preserves Node %s without cancellation', async (audience) => {
    mocks.runtime.mockReturnValue({
      app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
      public: { serverRuntime: 'node' }
    })
    expect(panel(await render(audience)).exists()).toBe(false)
  })
  it.each(['guest', 'email', 'pending', 'invalid', 'wrong-order'] as const)(
    'does not mount customer cancellation with %s detail/authority',
    async (mode) => {
      if (mode === 'guest') loggedIn.value = false
      if (mode === 'email') user.value.emailVerified = false
      if (mode === 'pending') customerStatus.value = 'pending'
      if (mode === 'invalid') customerData.value = { lines: [] }
      if (mode === 'wrong-order') customerData.value = detail(OTHER)
      expect(panel(await render()).exists()).toBe(false)
    }
  )
  it.each(['grant', 'caps-loading', 'error', 'pending', 'wrong-order'] as const)(
    'does not mount admin cancellation with %s authority',
    async (mode) => {
      if (mode === 'grant') caps.value = { ...(caps.value as object), permissions: [] }
      if (mode === 'caps-loading') navStatus.value = 'loading'
      if (mode === 'error') adminError.value = { statusCode: 403 }
      if (mode === 'pending') adminStatus.value = 'pending'
      if (mode === 'wrong-order') adminData.value = { ...adminDetail(), order: { ...adminDetail().order, id: OTHER } }
      expect(panel(await render('admin')).exists()).toBe(false)
    }
  )
  it.each(['customer', 'admin'] as const)(
    'keeps its %s recovery child enabled while unknown, but blocks navigation with a tab-local warning',
    async (audience) => {
      const wrapper = await render(audience)
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
      await ambiguous(wrapper)
      expect(panel(wrapper).props()).toMatchObject({ enabled: true, pending: false })
      expect(wrapper.find('[data-order-cancellation-pending]').exists()).toBe(true)
      expect(mocks.leave.at(-1)?.()).toBe(false)
      expect(confirm).toHaveBeenCalled()
      expect(mocks.update.at(-1)?.()).toBe(false)
    }
  )
  it('blocks customer row closing and reorder while unknown, then restores them after recovery', async () => {
    const wrapper = await render()
    await ambiguous(wrapper)
    await wrapper.get('button').trigger('click')
    expect(panel(wrapper).exists()).toBe(true)
    const reorder = wrapper.findAll('button').find((button) => button.text() === 'Volver a pedir')!
    expect(reorder.attributes('disabled')).toBeDefined()
    await reorder.trigger('click')
    expect(wrapper.emitted('reorder')).toBeUndefined()
    await panel(wrapper).get('[data-cancel-clear]').trigger('click')
    await reorder.trigger('click')
    expect(wrapper.emitted('reorder')).toEqual([[ORDER]])
  })
  it.each(['customer', 'admin'] as const)(
    'purges %s cancellation and its local pending lock on scope revocation',
    async (audience) => {
      const wrapper = await render(audience)
      await ambiguous(wrapper)
      session.value.sessionVersion = 2
      await nextTick()
      await flushPromises()
      expect(panel(wrapper).exists()).toBe(false)
      expect(wrapper.find('[data-order-cancellation-pending]').exists()).toBe(false)
      expect(mocks.leave.at(-1)?.()).not.toBe(false)
    }
  )
  it.each(['customer', 'admin'] as const)(
    'refreshes %s detail and timeline only after matching confirmed cancellation',
    async (audience) => {
      const wrapper = await render(audience)
      const timeline = wrapper.findComponent(Timeline).vm
      panel(wrapper).vm.$emit('confirmed', receipt(OTHER))
      await flushPromises()
      expect(mocks.detailRefresh).not.toHaveBeenCalled()
      panel(wrapper).vm.$emit('confirmed', receipt())
      await flushPromises()
      expect(mocks.detailRefresh).toHaveBeenCalledTimes(1)
      expect(wrapper.findComponent(Timeline).vm).not.toBe(timeline)
      if (audience === 'customer') expect(wrapper.emitted('confirmed')).toEqual([[ORDER]])
    }
  )
  it('disables competing admin preparation while cancellation is unknown', async () => {
    const wrapper = await render('admin')
    expect(wrapper.findComponent(Fulfillment).exists()).toBe(true)
    await ambiguous(wrapper)
    expect(wrapper.findComponent(Fulfillment).exists()).toBe(false)
    await panel(wrapper).get('[data-cancel-clear]').trigger('click')
    expect(wrapper.findComponent(Fulfillment).exists()).toBe(true)
  })
  it('blocks sibling cancellation/reorder and filters in the real customer list, then refreshes the list after confirmation', async () => {
    const wrapper = await render('list'),
      rows = wrapper.findAllComponents(AccountOrderRow)
    expect(rows).toHaveLength(2)
    await ambiguous(rows[0]!)
    expect(rows[1]!.props('operationPending')).toBe(true)
    expect(wrapper.get('input').attributes('disabled')).toBeDefined()
    rows[1]!.vm.$emit('reorder', OTHER)
    await flushPromises()
    expect(mocks.reorder).not.toHaveBeenCalled()
    rows[0]!.findComponent(Panel).vm.$emit('pending', false)
    rows[0]!.findComponent(Panel).vm.$emit('confirmed', receipt())
    await flushPromises()
    expect(mocks.listRefresh).toHaveBeenCalledTimes(1)
  })
})

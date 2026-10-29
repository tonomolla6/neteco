import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { nextTick, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AdminOrderWorkbench from '../../app/components/AdminOrderWorkbench.vue'
import OrdersPage from '../../app/pages/admin/pedidos/index.vue'
import OrderFulfillmentSection from '../../app/components/OrderFulfillmentSection.vue'
import AdminOrderExport from '../../app/components/AdminOrderExport.vue'
import AdminOrderViews from '../../app/components/AdminOrderViews.vue'
import AdminOrderBatchPreparation from '../../app/components/AdminOrderBatchPreparation.vue'
import type { AdminOrderSummary } from '../../shared/types/admin'
import type { AdminOrderFulfillment } from '../../shared/order-fulfillment'
import '#app/nuxt-vitest-app-entry'

// ORD015/004: one explicit server-filtered queue, one real governed preparation
// context; explicit export of confirmed filters, no bulk writes/carrier API. Prepared or ambiguous commands
// freeze context controls, but NEVER retain revoked authority or private facts.
const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  post: vi.fn(),
  session: vi.fn(),
  navigation: vi.fn(),
  legacy: vi.fn(),
  runtime: vi.fn(() => ({
    app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
    public: { serverRuntime: 'cloudflare' }
  })),
  leave: [] as Array<() => unknown>,
  update: [] as Array<() => unknown>
}))
mockNuxtImport('useRequestFetch', () => () => mocks.request)
mockNuxtImport('$fetch', () => mocks.post)
mockNuxtImport('useUserSession', () => mocks.session)
mockNuxtImport('useAdminNavigation', () => mocks.navigation)
mockNuxtImport('useRuntimeConfig', () => mocks.runtime)
mockNuxtImport('useFetch', () => mocks.legacy)
mockNuxtImport('onBeforeRouteLeave', () => (guard: () => unknown) => {
  mocks.leave.push(guard)
})
mockNuxtImport('onBeforeRouteUpdate', () => (guard: () => unknown) => {
  mocks.update.push(guard)
})
const ACTOR = '10000000-0000-4000-8000-000000000001',
  SESSION = '20000000-0000-4000-8000-000000000001'
const ORDER = '30000000-0000-4000-8000-000000000001',
  SECOND = '30000000-0000-4000-8000-000000000002'
const row = (id = ORDER): AdminOrderSummary => ({
  id,
  status: 'pagado',
  orderStatus: 'awaiting_payment',
  paymentStatus: 'captured',
  fulfillmentStatus: 'pending',
  inventoryStatus: 'allocated',
  invoiceStatus: 'unavailable',
  name: 'Cliente privado sintético',
  company: null,
  email: 'synthetic@example.invalid',
  city: 'Ciudad sintética',
  paymentMethod: 'tarjeta',
  shippingMethod: 'recogida',
  total: 121,
  createdAt: '2026-10-08T12:00:00Z',
  lines: 1,
  shipmentId: null,
  trackingNumber: null,
  shipmentStatus: null
})
const caps = () => ({
  orderStatusUpdate: false,
  shipments: false,
  tracking: false,
  refunds: false,
  returns: false,
  invoices: false,
  notes: false,
  customerPreview: false,
  paymentsRead: true,
  inventoryRead: true,
  fulfillmentRead: true,
  orderHistory: true
})
const list = (items = [row(), row(SECOND)], page = 1, total = items.length) => ({
  source: 'cloudflare',
  items,
  pagination: {
    page,
    perPage: 25,
    total,
    pages: Math.ceil(total / 25),
    mode: 'cursor',
    nextCursor: page < Math.ceil(total / 25) ? `sealed-next-${page}` : null,
    previousCursor: page > 1 ? `sealed-previous-${page}` : null
  },
  capabilities: caps()
})
const query = () => ({
  q: '',
  page: 1,
  perPage: 25,
  bucket: 'todos',
  sortKey: 'createdAt',
  sortDir: 'desc',
  pagination: 'cursor'
})
const context = (orderId = ORDER, version = 0): AdminOrderFulfillment => ({
  source: 'cloudflare',
  orderId,
  warehouse: { id: 'main', code: 'MAIN', name: 'Único almacén sintético' },
  shippingMethod: 'pickup',
  state: version ? 'picking' : 'pending',
  interruptedState: null,
  version,
  readiness: { ready: true, blockers: [] },
  capabilities: {
    fulfillmentRead: true,
    fulfillmentTransitions: true,
    allowedActions: version ? ['packed', 'exception'] : ['picking', 'exception']
  },
  inventoryPolicy: 'allocated_on_payment_no_fulfillment_decrement',
  timeline: { items: [], pagination: { page: 1, perPage: 25, total: version, pages: Math.ceil(version / 25) } },
  evaluatedAt: '2026-10-08T12:00:00Z'
})
const receipt = () => ({
  source: 'cloudflare',
  orderId: ORDER,
  warehouseId: 'main',
  commandId: '40000000-0000-4000-8000-000000000001',
  action: 'picking',
  state: 'picking',
  interruptedState: null,
  version: 1,
  inventoryEffect: 'none',
  updated: true
})
function deferred() {
  let resolve!: (value: unknown) => void
  const promise = new Promise<unknown>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const makeSession = () => ({
  ready: ref(true),
  loggedIn: ref(true),
  user: ref({ id: ACTOR, emailVerified: true, mfaVerified: true }),
  session: ref({ sessionId: SESSION, sessionVersion: 1 })
})
let session: ReturnType<typeof makeSession>
let navStatus = ref('ready'),
  navCaps = ref<unknown>(null)
type Wrapper = Awaited<ReturnType<typeof mountSuspended>>
const mounted: Wrapper[] = []
const stubs = {
  NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' },
  UiPageHeader: true,
  UiDataTable: { template: '<div data-legacy-table />' },
  UModal: true
}
async function render(page = false) {
  const wrapper = await mountSuspended(page ? OrdersPage : AdminOrderWorkbench, { global: { stubs } })
  mounted.push(wrapper)
  await flushPromises()
  return wrapper
}
const listCalls = () => mocks.request.mock.calls.filter(([path]) => path === '/api/admin/orders')
const contextCalls = () => mocks.request.mock.calls.filter(([path]) => String(path).endsWith('/fulfillment'))
async function apply(wrapper: Wrapper) {
  await wrapper.get('[data-wb-form]').trigger('submit')
  await flushPromises()
}
async function open(wrapper: Wrapper, index = 0) {
  await wrapper.findAll('[data-wb-open]')[index]!.trigger('click')
  await flushPromises()
}
async function prepare(wrapper: Wrapper) {
  await wrapper.get('[data-testid="fulfillment-action"]').setValue('picking')
  await wrapper.get('[data-testid="fulfillment-reason"]').setValue('Synthetic verified warehouse preparation')
  await wrapper
    .get('[data-testid="fulfillment-action"]')
    .element.closest('form')!
    .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  await flushPromises()
}
beforeEach(() => {
  mocks.request
    .mockReset()
    .mockImplementation(async (path: string) => (path === '/api/admin/orders' ? list() : context(path.split('/')[4])))
  mocks.post.mockReset().mockResolvedValue(receipt())
  mocks.runtime.mockReturnValue({
    app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
    public: { serverRuntime: 'cloudflare' }
  })
  session = makeSession()
  mocks.session.mockImplementation(() => session)
  navStatus = ref('ready')
  navCaps = ref({
    source: 'cloudflare',
    identityId: ACTOR,
    sessionId: SESSION,
    sessionVersion: 1,
    state: 'ready',
    permissions: ['administration.manage']
  })
  mocks.navigation.mockImplementation(() => ({ status: navStatus, capabilities: navCaps }))
  mocks.legacy
    .mockReset()
    .mockResolvedValue({ data: ref({ items: [row()] }), status: ref('success'), refresh: vi.fn() })
  mocks.leave.length = 0
  mocks.update.length = 0
})
afterEach(() => mounted.splice(0).forEach((wrapper) => wrapper.unmount()))

describe('explicit operational order workbench', () => {
  it('distinguishes an emptied live cursor page from globally empty filters and returns through its previous token', async () => {
    mocks.request.mockResolvedValueOnce(list([row()], 1, 30))
    const wrapper = await render()
    mocks.request.mockResolvedValueOnce({
      ...list([], 2, 29),
      pagination: {
        page: 2,
        perPage: 25,
        total: 29,
        pages: 2,
        mode: 'cursor',
        nextCursor: null,
        previousCursor: 'live-previous'
      }
    })
    await wrapper.get('[data-wb-next]').trigger('click')
    await flushPromises()
    expect(wrapper.text()).not.toContain('No hay pedidos para estos filtros confirmados')
    expect(wrapper.get('[data-wb-empty]').text()).toContain('Esta página no contiene pedidos')
    expect(wrapper.get('[data-wb-previous]').attributes('disabled')).toBeUndefined()
    mocks.request.mockResolvedValueOnce(list([row(SECOND)], 1, 29))
    await wrapper.get('[data-wb-previous]').trigger('click')
    await flushPromises()
    expect(listCalls().at(-1)?.[1].query).toEqual({ ...query(), before: 'live-previous' })
    expect(wrapper.get('[data-wb-open]').attributes('data-wb-open')).toBeDefined()
    expect(wrapper.find('[data-wb-empty]').exists()).toBe(false)
    expect(mocks.post).not.toHaveBeenCalled()
  })
  it('uses cursor pagination for the explicit live queue and excludes tokens from export and saved views', async () => {
    mocks.request.mockResolvedValueOnce({
      ...list([row(), row(SECOND)], 1, 100),
      pagination: {
        page: 1,
        perPage: 25,
        total: 100,
        pages: 4,
        mode: 'cursor',
        nextCursor: 'sealed-next',
        previousCursor: null
      }
    })
    const wrapper = await render()
    expect(listCalls()[0]![1].query).toMatchObject({ pagination: 'cursor', page: 1, perPage: 25 })
    expect(wrapper.find('[data-wb-error]').exists()).toBe(false)
    expect(wrapper.getComponent(AdminOrderExport).props('appliedQuery')).not.toHaveProperty('pagination')
    expect(wrapper.getComponent(AdminOrderViews).props('appliedDefinition')).not.toHaveProperty('after')
    mocks.request.mockResolvedValueOnce({
      ...list([row(SECOND)], 2, 100),
      pagination: {
        page: 2,
        perPage: 25,
        total: 100,
        pages: 4,
        mode: 'cursor',
        nextCursor: 'sealed-third',
        previousCursor: 'sealed-previous'
      }
    })
    await wrapper.get('[data-wb-next]').trigger('click')
    await flushPromises()
    expect(listCalls().at(-1)![1].query).toMatchObject({ pagination: 'cursor', page: 2, after: 'sealed-next' })
    expect(listCalls().at(-1)![1].query).not.toHaveProperty('before')
    mocks.request.mockResolvedValueOnce({
      ...list([row()], 1, 100),
      pagination: {
        page: 1,
        perPage: 25,
        total: 100,
        pages: 4,
        mode: 'cursor',
        nextCursor: 'sealed-next',
        previousCursor: null
      }
    })
    await wrapper.get('[data-wb-previous]').trigger('click')
    await flushPromises()
    expect(listCalls().at(-1)![1].query).toMatchObject({ pagination: 'cursor', page: 1, before: 'sealed-previous' })
    expect(listCalls().at(-1)![1].query).not.toHaveProperty('after')
    expect(wrapper.getComponent(AdminOrderExport).props('appliedQuery')).not.toHaveProperty('before')
  })
  it('fails closed on an unconfirmed legacy response to a cursor request instead of silently changing pagination mode', async () => {
    mocks.request.mockResolvedValueOnce({ ...list(), pagination: { page: 1, perPage: 25, total: 2, pages: 1 } })
    const wrapper = await render()
    expect(wrapper.get('[data-wb-error]').exists()).toBe(true)
    expect(wrapper.find('[data-wb-open]').exists()).toBe(false)
    expect(wrapper.findComponent(AdminOrderBatchPreparation).exists()).toBe(false)
  })
  it('selects only the current confirmed page, not all matching results, without sending requests', async () => {
    mocks.request.mockResolvedValueOnce(list([row(), row(SECOND)], 1, 100))
    const wrapper = await render(),
      before = mocks.request.mock.calls.length
    await wrapper.get('[data-wb-select-page]').setValue(true)
    expect(wrapper.getComponent(AdminOrderBatchPreparation).props('orderIds')).toEqual([ORDER, SECOND])
    expect(wrapper.get('[data-wb-selection-count]').text()).toContain('2')
    expect(wrapper.get('[data-wb-selection-count]').text()).toContain('página')
    expect(mocks.request).toHaveBeenCalledTimes(before)
    expect(mocks.post).not.toHaveBeenCalled()
  })
  it('purges selected order IDs when draft filters, saved view or pagination changes', async () => {
    mocks.request.mockResolvedValueOnce(list([row(), row(SECOND)], 1, 100))
    const wrapper = await render()
    await wrapper.get('[data-wb-select-order="' + ORDER + '"]').setValue(true)
    expect(wrapper.getComponent(AdminOrderBatchPreparation).props('orderIds')).toEqual([ORDER])
    await wrapper.get('[data-wb-query]').setValue('another query')
    expect(wrapper.findComponent(AdminOrderBatchPreparation).exists()).toBe(false)
    mocks.request.mockImplementation(async (path: string, options: { query?: { page?: number } }) =>
      path === '/api/admin/orders' ? list([row(), row(SECOND)], options.query?.page ?? 1, 100) : context()
    )
    await wrapper.get('[data-wb-select-page]').setValue(true)
    await wrapper.get('[data-wb-next]').trigger('click')
    await flushPromises()
    expect(wrapper.findComponent(AdminOrderBatchPreparation).exists()).toBe(false)
    await wrapper.get('[data-wb-select-page]').setValue(true)
    wrapper
      .getComponent(AdminOrderViews)
      .vm.$emit('apply', { bucket: 'todos', sortKey: 'createdAt', sortDir: 'desc', columns: ['total'] })
    await flushPromises()
    expect(wrapper.findComponent(AdminOrderBatchPreparation).exists()).toBe(false)
  })
  it('blocks all competing contexts while a batch intent exists without echoing its pending back to the batch', async () => {
    const wrapper = await render()
    await wrapper.get('[data-wb-select-page]').setValue(true)
    const batch = wrapper.getComponent(AdminOrderBatchPreparation)
    batch.vm.$emit('pending', true)
    await nextTick()
    expect(batch.props('pending')).toBe(false)
    expect(wrapper.get('[data-wb-apply]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-wb-select-page]').attributes('disabled')).toBeDefined()
    expect(wrapper.getComponent(AdminOrderViews).props('pending')).toBe(true)
    expect(wrapper.findComponent(AdminOrderExport).exists()).toBe(false)
    batch.vm.$emit('pending', false)
    await nextTick()
    expect(wrapper.get('[data-wb-apply]').attributes('disabled')).toBeUndefined()
  })
  it('purges selection and batch private state on live session revocation, with no automatic write', async () => {
    const wrapper = await render()
    await wrapper.get('[data-wb-select-page]').setValue(true)
    expect(wrapper.findComponent(AdminOrderBatchPreparation).exists()).toBe(true)
    session.session.value = { ...session.session.value, sessionVersion: 2 }
    await nextTick()
    expect(wrapper.findComponent(AdminOrderBatchPreparation).exists()).toBe(false)
    expect(wrapper.find('[data-wb-select-page]').exists()).toBe(false)
    expect(mocks.post).not.toHaveBeenCalled()
  })
  it('mounts saved views with only confirmed configuration, never draft query, rows or paging', async () => {
    const wrapper = await render()
    const panel = wrapper.getComponent(AdminOrderViews)
    expect(panel.props('appliedDefinition')).toEqual({
      bucket: 'todos',
      sortKey: 'createdAt',
      sortDir: 'desc',
      columns: [
        'createdAt',
        'customer',
        'total',
        'paymentStatus',
        'fulfillmentStatus',
        'shippingMethod',
        'invoiceStatus'
      ]
    })
    await wrapper.get('[data-wb-query]').setValue('Private search must not be saved')
    await wrapper.get('[data-wb-payment]').setValue('captured')
    expect(panel.props('appliedDefinition')).not.toHaveProperty('paymentStatus')
    expect(JSON.stringify(panel.props('appliedDefinition'))).not.toMatch(/Private search|perPage|email/)
  })
  it('applies saved view with exactly one explicit server GET, clears search and selection, and never writes or exports', async () => {
    const wrapper = await render()
    await open(wrapper)
    await wrapper.get('[data-wb-query]').setValue('Private customer search')
    const before = listCalls().length
    wrapper.getComponent(AdminOrderViews).vm.$emit('apply', {
      bucket: 'por_cobrar',
      sortKey: 'total',
      sortDir: 'asc',
      paymentStatus: 'pending',
      columns: ['total']
    })
    await flushPromises()
    expect((wrapper.get('[data-wb-query]').element as HTMLInputElement).value).toBe('')
    expect(wrapper.find('[data-wb-close]').exists()).toBe(false)
    expect(listCalls()).toHaveLength(before + 1)
    expect(
      wrapper
        .get('table')
        .findAll('thead th')
        .map((cell) => cell.text())
    ).toEqual(['Selección', 'Pedido', 'Total', 'Preparación'])
    expect(listCalls().at(-1)?.[1].query).toEqual({
      q: '',
      page: 1,
      perPage: 25,
      pagination: 'cursor',
      bucket: 'por_cobrar',
      sortKey: 'total',
      sortDir: 'asc',
      paymentStatus: 'pending'
    })
    expect(mocks.post).not.toHaveBeenCalled()
    expect(mocks.request.mock.calls.some(([path]) => path === '/api/admin/orders/export.csv')).toBe(false)
  })
  it('renders a semantic bounded table with configurable columns and always preserves order links', async () => {
    const wrapper = await render()
    expect(wrapper.get('table').findAll('tbody tr')).toHaveLength(2)
    expect(
      wrapper
        .get('table')
        .findAll('thead th')
        .map((cell) => cell.text())
    ).toEqual([
      'Selección',
      'Pedido',
      'Fecha',
      'Cliente',
      'Total',
      'Pago',
      'Estado de preparación',
      'Entrega',
      'Factura',
      'Preparación'
    ])
    await wrapper.get('[data-wb-column="customer"]').setValue(false)
    expect(
      wrapper
        .get('table')
        .findAll('thead th')
        .map((cell) => cell.text())
    ).not.toContain('Cliente')
    expect(wrapper.find('a[href="/admin/pedidos/' + ORDER + '"]').exists()).toBe(true)
    expect(wrapper.findAll('[data-wb-open]')).toHaveLength(2)
  })
  it('blocks other contexts during a view command but never echoes its own pending back to the panel', async () => {
    const wrapper = await render(),
      panel = wrapper.getComponent(AdminOrderViews)
    panel.vm.$emit('pending', true)
    await nextTick()
    expect(wrapper.get('[data-wb-apply]').attributes('disabled')).toBeDefined()
    expect(wrapper.findComponent(AdminOrderExport).exists()).toBe(false)
    expect(panel.props('pending')).toBe(false)
    panel.vm.$emit('pending', false)
    await nextTick()
    expect(wrapper.get('[data-wb-apply]').attributes('disabled')).toBeUndefined()
  })
  it('blocks views while an export GET is in flight without unmounting that export or echoing its pending', async () => {
    const wrapper = await render(),
      exporter = wrapper.getComponent(AdminOrderExport)
    exporter.vm.$emit('pending', true)
    await nextTick()
    expect(wrapper.getComponent(AdminOrderViews).props('pending')).toBe(true)
    expect(wrapper.getComponent(AdminOrderExport).props('pending')).toBe(false)
    expect(wrapper.get('[data-wb-apply]').attributes('disabled')).toBeDefined()
    exporter.vm.$emit('pending', false)
    await nextTick()
    expect(wrapper.getComponent(AdminOrderViews).props('pending')).toBe(false)
  })
  it('mounts private export only after the confirmed default queue, never a second GET automatically', async () => {
    const waiting = deferred()
    mocks.request.mockReturnValueOnce(waiting.promise)
    const wrapper = await render()
    expect(wrapper.findComponent(AdminOrderExport).exists()).toBe(false)
    waiting.resolve(list())
    await flushPromises()
    expect(wrapper.getComponent(AdminOrderExport).props()).toMatchObject({
      enabled: true,
      pending: false,
      scopeKey: JSON.stringify([ACTOR, SESSION, 1]),
      appliedQuery: { q: '', bucket: 'todos', sortKey: 'createdAt', sortDir: 'desc' }
    })
    expect(mocks.request).toHaveBeenCalledTimes(1)
  })
  it('does not export draft edits; updates filters only after the next successful applied GET', async () => {
    const wrapper = await render()
    await wrapper.get('[data-wb-query]').setValue('  cliente aplicado  ')
    await wrapper.get('[data-wb-payment]').setValue('captured')
    expect(wrapper.getComponent(AdminOrderExport).props('appliedQuery')).toEqual({
      q: '',
      bucket: 'todos',
      sortKey: 'createdAt',
      sortDir: 'desc'
    })
    const waiting = deferred()
    mocks.request.mockReturnValueOnce(waiting.promise)
    await apply(wrapper)
    expect(wrapper.findComponent(AdminOrderExport).exists()).toBe(false)
    waiting.resolve(list())
    await flushPromises()
    expect(wrapper.getComponent(AdminOrderExport).props('appliedQuery')).toEqual({
      q: 'cliente aplicado',
      bucket: 'todos',
      sortKey: 'createdAt',
      sortDir: 'desc',
      paymentStatus: 'captured'
    })
    await wrapper.get('[data-wb-query]').setValue('otro borrador privado')
    expect(wrapper.getComponent(AdminOrderExport).props('appliedQuery').q).toBe('cliente aplicado')
    await wrapper.get('[data-wb-reset]').trigger('click')
    await flushPromises()
    expect(wrapper.getComponent(AdminOrderExport).props('appliedQuery')).toEqual({
      q: '',
      bucket: 'todos',
      sortKey: 'createdAt',
      sortDir: 'desc'
    })
  })
  it('does not expose failed applied filters as an exportable confirmed snapshot', async () => {
    const wrapper = await render()
    expect(wrapper.findComponent(AdminOrderExport).exists()).toBe(true)
    await wrapper.get('[data-wb-query]').setValue('búsqueda no confirmada')
    mocks.request.mockRejectedValueOnce({ statusCode: 403 })
    await apply(wrapper)
    expect(wrapper.findComponent(AdminOrderExport).exists()).toBe(false)
    expect(wrapper.find('[data-wb-error]').exists()).toBe(true)
  })
  it.each(['session', 'grant', 'caps-pending'])(
    'purges export on %s boundary and does not restore it without an explicit fresh queue',
    async (mode) => {
      const wrapper = await render()
      expect(wrapper.findComponent(AdminOrderExport).exists()).toBe(true)
      if (mode === 'session') session.session.value.sessionVersion = 2
      if (mode === 'grant') navCaps.value = { ...(navCaps.value as object), permissions: [] }
      if (mode === 'caps-pending') navStatus.value = 'loading'
      await nextTick()
      expect(wrapper.findComponent(AdminOrderExport).exists()).toBe(false)
      session.session.value.sessionVersion = 1
      navCaps.value = { ...(navCaps.value as object), permissions: ['administration.manage'] }
      navStatus.value = 'ready'
      await nextTick()
      await flushPromises()
      expect(wrapper.findComponent(AdminOrderExport).exists()).toBe(false)
      await apply(wrapper)
      expect(wrapper.findComponent(AdminOrderExport).exists()).toBe(true)
    }
  )
  it('unmounts export while a preparation intention is pending, retaining the recovery section after unknown', async () => {
    const wrapper = await render()
    expect(wrapper.findComponent(AdminOrderExport).exists()).toBe(true)
    await open(wrapper)
    await prepare(wrapper)
    expect(wrapper.findComponent(AdminOrderExport).exists()).toBe(false)
    expect(wrapper.getComponent(OrderFulfillmentSection).props('orderId')).toBe(ORDER)
    mocks.post.mockRejectedValueOnce(new Error('lost response'))
    await wrapper.get('[data-testid="fulfillment-confirm"]').trigger('click')
    await flushPromises()
    expect(wrapper.findComponent(AdminOrderExport).exists()).toBe(false)
    expect(wrapper.find('[data-testid="fulfillment-retry"]').exists()).toBe(true)
    expect(mocks.post).toHaveBeenCalledTimes(1)
  })
  it('purges a private query at an authority boundary without automatically resending it', async () => {
    const wrapper = await render()
    await wrapper.get('[data-wb-query]').setValue('synthetic-private@example.invalid')
    await apply(wrapper)
    expect(listCalls().at(-1)?.[1].query.q).toBe('synthetic-private@example.invalid')
    navStatus.value = 'loading'
    await nextTick()
    navStatus.value = 'ready'
    await nextTick()
    await flushPromises()
    expect(listCalls()).toHaveLength(2)
    expect((wrapper.get('[data-wb-query]').element as HTMLInputElement).value).toBe('')
    await apply(wrapper)
    expect(listCalls().at(-1)?.[1].query).toEqual(query())
  })
  it('starts exactly one first read when async authority becomes ready, without automatic reads after revocation', async () => {
    navStatus.value = 'loading'
    const wrapper = await render()
    expect(listCalls()).toHaveLength(0)
    navStatus.value = 'ready'
    await nextTick()
    await flushPromises()
    expect(listCalls()).toHaveLength(1)
    expect(wrapper.findAll('[data-wb-open]')).toHaveLength(2)
    navStatus.value = 'loading'
    await nextTick()
    expect(wrapper.text()).not.toContain('Cliente privado sintético')
    navStatus.value = 'ready'
    await nextTick()
    await flushPromises()
    expect(listCalls()).toHaveLength(1)
    expect(wrapper.find('[data-wb-open]').exists()).toBe(false)
    await apply(wrapper)
    expect(listCalls()).toHaveLength(2)
  })
  it('formats the real Cloudflare integer-cent total without multiplying the charged amount', async () => {
    mocks.request.mockResolvedValueOnce(list([{ ...row(), total: 12100 }]))
    const wrapper = await render()
    expect(wrapper.text()).toMatch(/121,00\s*€/)
    expect(wrapper.text()).not.toMatch(/12[.\s]?100,00/)
  })
  it('reads one bounded authorized server queue without any hidden preparation GET or write', async () => {
    const wrapper = await render()
    expect(listCalls()).toHaveLength(1)
    expect(listCalls()[0]).toEqual([
      '/api/admin/orders',
      expect.objectContaining({ method: 'GET', query: query(), retry: 0, cache: 'no-store' })
    ])
    expect(contextCalls()).toHaveLength(0)
    expect(mocks.post).not.toHaveBeenCalled()
    expect(wrapper.findAll('[data-wb-open]')).toHaveLength(2)
    expect(wrapper.text()).toContain('Cliente privado sintético')
  })
  it('applies all existing filters together explicitly, with no GET on keystrokes', async () => {
    const wrapper = await render()
    for (const [field, value] of Object.entries({
      query: '  Ácido %_\\ ',
      bucket: 'por_preparar',
      payment: 'captured',
      order: 'awaiting_payment',
      shipping: 'pickup',
      customer: 'b2b',
      from: '2026-10-01',
      to: '2026-10-08',
      sort: 'total',
      direction: 'asc'
    }))
      await wrapper.get(`[data-wb-${field}]`).setValue(value)
    expect(listCalls()).toHaveLength(1)
    await apply(wrapper)
    expect(listCalls()).toHaveLength(2)
    expect(listCalls()[1]?.[1].query).toEqual({
      ...query(),
      q: 'Ácido %_\\',
      bucket: 'por_preparar',
      paymentStatus: 'captured',
      orderStatus: 'awaiting_payment',
      shippingMethod: 'pickup',
      customerType: 'b2b',
      from: '2026-10-01',
      to: '2026-10-08',
      sortKey: 'total',
      sortDir: 'asc'
    })
    expect(mocks.post).not.toHaveBeenCalled()
  })
  it.each(['reversed-date', 'upper-date', 'long-query', 'control-query'])(
    'does not submit invalid %s or reinterpret it as an empty queue',
    async (mode) => {
      const wrapper = await render()
      if (mode === 'reversed-date') {
        await wrapper.get('[data-wb-from]').setValue('2026-10-09')
        await wrapper.get('[data-wb-to]').setValue('2026-10-08')
      }
      if (mode === 'upper-date') {
        await wrapper.get('[data-wb-from]').setValue('9999-12-31')
      }
      if (mode === 'long-query') await wrapper.get('[data-wb-query]').setValue('x'.repeat(121))
      if (mode === 'control-query') await wrapper.get('[data-wb-query]').setValue('ab\u007f')
      await apply(wrapper)
      expect(listCalls()).toHaveLength(1)
      expect(wrapper.find('[data-wb-validation]').exists()).toBe(true)
      expect(wrapper.find('[data-wb-empty]').exists()).toBe(false)
    }
  )
  it('uses server totals and pages, preserves applied filters on next page, and resets explicitly', async () => {
    mocks.request.mockResolvedValueOnce(list([row()], 1, 30))
    const wrapper = await render()
    await wrapper.get('[data-wb-payment]').setValue('captured')
    mocks.request.mockResolvedValueOnce(list([row()], 1, 30))
    await apply(wrapper)
    mocks.request.mockResolvedValueOnce(list([row(SECOND)], 2, 30))
    await wrapper.get('[data-wb-next]').trigger('click')
    await flushPromises()
    expect(listCalls().at(-1)?.[1].query).toEqual({
      ...query(),
      page: 2,
      paymentStatus: 'captured',
      after: 'sealed-next-1'
    })
    expect(wrapper.text()).toContain('30')
    mocks.request.mockResolvedValueOnce(list())
    await wrapper.get('[data-wb-reset]').trigger('click')
    await flushPromises()
    expect(listCalls().at(-1)?.[1].query).toEqual(query())
  })
  it('singleflights explicit queue reads and distinguishes pending, failure and confirmed empty', async () => {
    const pending = deferred()
    mocks.request.mockReturnValueOnce(pending.promise)
    const wrapper = await render()
    expect(wrapper.get('[data-wb-loading]').attributes('role')).toBe('status')
    expect(wrapper.find('[data-wb-empty]').exists()).toBe(false)
    await apply(wrapper)
    await apply(wrapper)
    expect(listCalls()).toHaveLength(1)
    pending.resolve(list([]))
    await flushPromises()
    expect(wrapper.get('[data-wb-empty]').text()).toContain('No hay pedidos')
  })
  it.each([401, 403, 429, 503])(
    'fails closed on queue error %s and retries only the same explicit GET',
    async (statusCode) => {
      mocks.request.mockRejectedValueOnce({ statusCode, message: 'private SQL token customer@example.invalid' })
      const wrapper = await render()
      expect(wrapper.get('[data-wb-error]').attributes('role')).toBe('alert')
      expect(wrapper.find('[data-wb-empty]').exists()).toBe(false)
      expect(wrapper.text()).not.toMatch(/private SQL|token|customer@/)
      await wrapper.get('[data-wb-retry]').trigger('click')
      await flushPromises()
      expect(listCalls()[1]?.[1].query).toEqual(query())
    }
  )
  it.each(['source', 'id', 'duplicate', 'page', 'size', 'capability', 'overflow'])(
    'rejects unconfirmed queue DTO %s before any actionable context',
    async (mode) => {
      const dto = list()
      if (mode === 'source') Object.assign(dto, { source: 'node' })
      if (mode === 'id') dto.items[0]!.id = '../private?token=x'
      if (mode === 'duplicate') dto.items = [row(), row()]
      if (mode === 'page') dto.pagination.page = 2
      if (mode === 'size') dto.pagination.perPage = 100
      if (mode === 'capability') dto.capabilities.orderStatusUpdate = true
      if (mode === 'overflow')
        dto.items = Array.from({ length: 26 }, (_, i) =>
          row(`30000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`)
        )
      mocks.request.mockResolvedValueOnce(dto)
      const wrapper = await render()
      expect(wrapper.find('[data-wb-error]').exists()).toBe(true)
      expect(wrapper.find('[data-wb-open]').exists()).toBe(false)
      expect(contextCalls()).toHaveLength(0)
    }
  )
  it.each(['logged-out', 'not-ready', 'email', 'mfa', 'caps-pending', 'caps-error', 'grant', 'identity', 'session'])(
    'never reads a private queue without %s authority',
    async (mode) => {
      if (mode === 'logged-out') session.loggedIn.value = false
      if (mode === 'not-ready') session.ready.value = false
      if (mode === 'email') session.user.value.emailVerified = false
      if (mode === 'mfa') session.user.value.mfaVerified = false
      if (mode === 'caps-pending') navStatus.value = 'loading'
      if (mode === 'caps-error') navStatus.value = 'error'
      if (mode === 'grant') navCaps.value = { ...(navCaps.value as object), permissions: ['catalog.write'] }
      if (mode === 'identity') navCaps.value = { ...(navCaps.value as object), identityId: ORDER }
      if (mode === 'session') navCaps.value = { ...(navCaps.value as object), sessionVersion: 2 }
      const wrapper = await render()
      expect(mocks.request).not.toHaveBeenCalled()
      expect(mocks.post).not.toHaveBeenCalled()
      expect(wrapper.text()).not.toContain('Cliente privado sintético')
    }
  )
  it('opens exactly one actual governed preparation section only after a row is chosen', async () => {
    const wrapper = await render()
    await open(wrapper)
    expect(wrapper.findComponent(OrderFulfillmentSection).props()).toMatchObject({
      orderId: ORDER,
      runtime: 'cloudflare'
    })
    expect(contextCalls()).toHaveLength(1)
    expect(mocks.post).not.toHaveBeenCalled()
    await open(wrapper, 1)
    expect(wrapper.findAllComponents(OrderFulfillmentSection)).toHaveLength(1)
    expect(wrapper.findComponent(OrderFulfillmentSection).props('orderId')).toBe(SECOND)
    await wrapper.get('[data-wb-close]').trigger('click')
    expect(wrapper.findComponent(OrderFulfillmentSection).exists()).toBe(false)
  })
  it('does not treat queue membership as transition permission when the operational read is blocked', async () => {
    const wrapper = await render()
    mocks.request.mockImplementation(async (path: string) =>
      String(path).endsWith('/fulfillment')
        ? {
            ...context(),
            readiness: { ready: false, blockers: ['payment_unconfirmed'] },
            capabilities: { fulfillmentRead: true, fulfillmentTransitions: false, allowedActions: [] }
          }
        : path === '/api/admin/orders'
          ? list()
          : context(path.split('/')[4])
    )
    await open(wrapper)
    expect(wrapper.text()).toContain('Pago capturado no confirmado')
    expect(wrapper.find('[data-testid="fulfillment-action"]').exists()).toBe(false)
    expect(mocks.post).not.toHaveBeenCalled()
  })
  it('freezes queue/context/navigation while an explicit intention is prepared, and releases after cancel', async () => {
    const wrapper = await render()
    await open(wrapper)
    await prepare(wrapper)
    expect(wrapper.find('[data-wb-pending]').exists()).toBe(true)
    for (const selector of ['[data-wb-query]', '[data-wb-apply]', '[data-wb-close]'])
      expect(wrapper.get(selector).attributes('disabled')).toBeDefined()
    await open(wrapper, 1)
    await apply(wrapper)
    expect(contextCalls()).toHaveLength(1)
    expect(listCalls()).toHaveLength(1)
    expect(mocks.leave.at(-1)?.()).toBe(false)
    expect(mocks.update.at(-1)?.()).toBe(false)
    await wrapper.get('[data-testid="fulfillment-cancel"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-wb-close]').attributes('disabled')).toBeUndefined()
    expect(mocks.leave.at(-1)?.()).not.toBe(false)
  })
  it('uses the existing real confirmation flow and refreshes the queue only after its receipt', async () => {
    const wrapper = await render()
    await open(wrapper)
    await prepare(wrapper)
    expect(mocks.post).not.toHaveBeenCalled()
    mocks.request.mockImplementation(async (path: string) =>
      path === '/api/admin/orders' ? list() : context(ORDER, mocks.post.mock.calls.length ? 1 : 0)
    )
    await wrapper.get('[data-testid="fulfillment-confirm"]').trigger('click')
    await flushPromises()
    expect(mocks.post).toHaveBeenCalledExactlyOnceWith(
      `/api/admin/orders/${ORDER}/fulfillment/transitions`,
      expect.objectContaining({
        method: 'POST',
        body: { action: 'picking', expectedVersion: 0, reason: 'Synthetic verified warehouse preparation' }
      })
    )
    expect(listCalls()).toHaveLength(2)
    expect(wrapper.text()).toContain('Operación confirmada y auditada')
  })
  it('retains the same real section and command key after a lost response, blocking other orders until exact replay', async () => {
    const wrapper = await render()
    await open(wrapper)
    await prepare(wrapper)
    mocks.post.mockRejectedValueOnce(new Error('response lost'))
    await wrapper.get('[data-testid="fulfillment-confirm"]').trigger('click')
    await flushPromises()
    const original = mocks.post.mock.calls[0]!
    expect(wrapper.find('[data-wb-pending]').exists()).toBe(true)
    await open(wrapper, 1)
    await wrapper.get('[data-wb-close]').trigger('click')
    expect(wrapper.findComponent(OrderFulfillmentSection).props('orderId')).toBe(ORDER)
    expect(mocks.post).toHaveBeenCalledTimes(1)
    mocks.request.mockImplementation(async (path: string) =>
      path === '/api/admin/orders' ? list() : context(ORDER, mocks.post.mock.calls.length > 1 ? 1 : 0)
    )
    await wrapper.get('[data-testid="fulfillment-retry"]').trigger('click')
    await flushPromises()
    expect(mocks.post).toHaveBeenCalledTimes(2)
    expect(mocks.post.mock.calls[1]?.[1].headers).toEqual(original[1].headers)
    expect(mocks.post.mock.calls[1]?.[1].body).toEqual(original[1].body)
    expect(wrapper.find('[data-wb-pending]').exists()).toBe(false)
  })
  it.each(['logout', 'session', 'grant', 'mfa', 'caps-pending'])(
    'purges authority/context on %s even while a prepared intent is pending',
    async (mode) => {
      const wrapper = await render()
      await open(wrapper)
      await prepare(wrapper)
      if (mode === 'logout') session.loggedIn.value = false
      if (mode === 'session') session.session.value.sessionVersion = 2
      if (mode === 'grant') navCaps.value = { ...(navCaps.value as object), permissions: [] }
      if (mode === 'mfa') session.user.value.mfaVerified = false
      if (mode === 'caps-pending') navStatus.value = 'loading'
      await nextTick()
      await flushPromises()
      expect(wrapper.findComponent(OrderFulfillmentSection).exists()).toBe(false)
      expect(wrapper.text()).not.toContain('Cliente privado sintético')
      expect(wrapper.find('[data-testid="fulfillment-confirm"]').exists()).toBe(false)
      expect(mocks.post).not.toHaveBeenCalled()
      expect(mocks.leave.at(-1)?.()).not.toBe(false)
    }
  )
  it('aborts a revoked queue read and ignores its late private result', async () => {
    const pending = deferred()
    mocks.request.mockReturnValueOnce(pending.promise)
    const wrapper = await render(),
      signal = listCalls()[0]?.[1].signal as AbortSignal
    session.loggedIn.value = false
    await nextTick()
    expect(signal.aborted).toBe(true)
    pending.resolve(list())
    await flushPromises()
    expect(wrapper.text()).not.toContain('Cliente privado sintético')
    expect(wrapper.find('[data-wb-open]').exists()).toBe(false)
  })
  it('does not mount or read Cloudflare workbench in Node', async () => {
    mocks.runtime.mockReturnValue({
      app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
      public: { serverRuntime: 'node' }
    })
    const wrapper = await render(true)
    expect(wrapper.find('[data-legacy-table]').exists()).toBe(true)
    expect(wrapper.findComponent(AdminOrderWorkbench).exists()).toBe(false)
    expect(wrapper.findComponent(AdminOrderExport).exists()).toBe(false)
    expect(mocks.legacy).toHaveBeenCalledTimes(1)
    expect(mocks.request).not.toHaveBeenCalled()
  })
  it('mounts only the new Cloudflare queue, never the old duplicate list request', async () => {
    const wrapper = await render(true)
    expect(wrapper.findComponent(AdminOrderWorkbench).exists()).toBe(true)
    expect(mocks.legacy).not.toHaveBeenCalled()
    expect(listCalls()).toHaveLength(1)
  })
})

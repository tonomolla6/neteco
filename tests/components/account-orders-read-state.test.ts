import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { defineComponent, h, nextTick, proxyRefs, ref, type PropType } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import OrdersPage from '../../app/pages/cuenta/pedidos.vue'
import type { OrderSummary } from '../../app/composables/useAccount'
import '#app/nuxt-vitest-app-entry'

const { fetchMock, requestMock, refreshMock, startMock, runtimeMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  requestMock: vi.fn(),
  refreshMock: vi.fn(),
  startMock: vi.fn(),
  runtimeMock: vi.fn(() => ({
    app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
    public: { serverRuntime: 'node' }
  }))
}))
mockNuxtImport('useFetch', () => fetchMock)
mockNuxtImport('$fetch', () => requestMock)
mockNuxtImport('useRuntimeConfig', () => runtimeMock)
mockNuxtImport('useUserSession', () => () => ({
  ready: ref(true),
  loggedIn: ref(true),
  user: ref({ id: 'synthetic-customer', role: 'customer' }),
  session: ref(null),
  clear: async () => undefined,
  fetch: async () => undefined,
  openInPopup: () => undefined
}))
const ORDER: OrderSummary = {
  id: 'ABC123',
  status: 'pagado',
  total: 12345,
  createdAt: '2026-10-01T10:00:00.123Z',
  lines: 2
}
const D1_ORDER: OrderSummary = {
  ...ORDER,
  id: 'a1000000-0000-4000-8000-000000000001',
  createdAt: '2026-10-01T10:00:00Z',
  invoiceAvailable: false,
  fullDetailAvailable: true
}
const Header = defineComponent({
  props: { title: String, count: Number },
  setup: (props) => () => h('header', { 'data-count': props.count }, h('h1', props.title))
})
const Surface = defineComponent({
  setup:
    (_, { slots }) =>
    () =>
      h('section', slots.default?.())
})
const EmptyState = defineComponent({
  props: { title: String, description: String },
  setup:
    (props, { slots }) =>
    () =>
      h('div', [h('h2', props.title), h('p', props.description), slots.default?.()])
})
const Button = defineComponent({
  inheritAttrs: false,
  props: { disabled: Boolean, loading: Boolean },
  setup:
    (props, { attrs, slots }) =>
    () =>
      h(
        'button',
        { ...attrs, type: attrs.type ?? 'button', disabled: props.disabled || props.loading },
        slots.default?.()
      )
})
const Input = defineComponent({
  inheritAttrs: false,
  props: { modelValue: String },
  emits: ['update:modelValue'],
  setup:
    (props, { attrs, emit }) =>
    () =>
      h('input', {
        ...attrs,
        value: props.modelValue,
        onInput: (event: Event) => emit('update:modelValue', (event.target as HTMLInputElement).value)
      })
})
const Select = defineComponent({
  inheritAttrs: false,
  props: { modelValue: String, items: Array as PropType<Array<{ label: string; value: string }>> },
  emits: ['update:modelValue'],
  setup:
    (props, { attrs, emit }) =>
    () =>
      h(
        'select',
        {
          ...attrs,
          value: props.modelValue,
          onChange: (event: Event) => emit('update:modelValue', (event.target as HTMLSelectElement).value)
        },
        props.items?.map((item) => h('option', { value: item.value }, item.label))
      )
})
const Row = defineComponent({
  props: { order: { type: Object as PropType<OrderSummary>, required: true }, defaultOpen: Boolean },
  emits: ['reorder'],
  setup:
    (props, { emit }) =>
    () =>
      h('article', { 'data-order-id': props.order.id }, [
        h('p', props.order.id),
        h('button', { type: 'button', onClick: () => emit('reorder', props.order.id) }, 'Volver a pedir')
      ])
})
const Dialog = defineComponent({
  emits: ['added'],
  setup: (_, { expose, emit }) => {
    expose({ start: startMock })
    return () =>
      h(
        'div',
        { 'data-reorder-dialog': true },
        h('button', { type: 'button', onClick: () => emit('added', 1) }, 'Confirmar recompra sintética')
      )
  }
})
const Feedback = defineComponent({
  props: { notice: String },
  setup: (props) => () => (props.notice ? h('p', { role: 'status' }, props.notice) : null)
})
type Wrapper = Awaited<ReturnType<typeof mountSuspended>>
let wrapper: Wrapper | undefined
let data: ReturnType<typeof ref<unknown>>
let status: ReturnType<typeof ref<string>>
async function render(options: { data?: unknown; status?: string } = {}) {
  data = ref(Object.hasOwn(options, 'data') ? options.data : { orders: [ORDER] })
  status = ref(options.status ?? 'success')
  fetchMock.mockReturnValue({ data, status, refresh: refreshMock, error: ref(null) })
  wrapper = await mountSuspended(OrdersPage, {
    global: {
      stubs: {
        UiPageHeader: Header,
        UiSurface: Surface,
        UiEmptyState: EmptyState,
        UButton: Button,
        UInput: Input,
        USelect: Select,
        AccountOrderRow: Row,
        ReorderDialog: Dialog,
        AccountFeedback: Feedback
      }
    }
  })
  return wrapper
}
const state = (page: Wrapper) => proxyRefs(page.setupState) as Record<string, unknown>
const retry = (page: Wrapper) => state(page).retryRead as () => Promise<void>
const reorder = (page: Wrapper) => state(page).startReorder as (id: unknown) => Promise<void>
const added = (page: Wrapper) => state(page).onAdded as (count: number) => void
function retryButton(page: Wrapper) {
  return page.findAll('button').find((button) => button.text() === 'Reintentar')
}
function expectNoWrites() {
  expect(requestMock).not.toHaveBeenCalled()
  expect(fetchMock.mock.calls.map((call) => call.slice(0, 2))).toEqual([['/api/orders', { method: 'GET' }]])
}
beforeEach(() => {
  fetchMock.mockReset()
  requestMock.mockReset()
  refreshMock.mockReset().mockResolvedValue(undefined)
  startMock.mockReset().mockResolvedValue(undefined)
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
})

describe('account orders confirmed read state', () => {
  it.each(['idle', 'pending'])(
    'announces %s without cached counts, filters, rows, dialog or reorder callbacks',
    async (readStatus) => {
      const page = await render({ status: readStatus })
      expect(page.get('[role="status"]').text()).toContain('Cargando tus pedidos')
      expect(page.get('[aria-busy]').attributes('aria-busy')).toBe('true')
      expect(page.get('header').attributes('data-count')).toBeUndefined()
      expect(page.find('input').exists()).toBe(false)
      expect(page.find('select').exists()).toBe(false)
      expect(page.find('article').exists()).toBe(false)
      expect(page.find('[data-reorder-dialog]').exists()).toBe(false)
      expect(page.text()).not.toContain('Todavía no tienes pedidos')
      expect(retryButton(page)).toBeUndefined()
      await retry(page)()
      await reorder(page)(ORDER.id)
      expect(refreshMock).not.toHaveBeenCalled()
      expect(startMock).not.toHaveBeenCalled()
      expectNoWrites()
    }
  )
  it('shows zero only after a successful bounded empty-array read', async () => {
    const page = await render({ data: { orders: [] } })
    expect(page.text()).toContain('Todavía no tienes pedidos')
    expect(page.get('header').attributes('data-count')).toBe('0')
    expect(page.find('[role="alert"]').exists()).toBe(false)
    expect(page.find('input').exists()).toBe(false)
    await retry(page)()
    await reorder(page)(ORDER.id)
    expect(refreshMock).not.toHaveBeenCalled()
    expect(startMock).not.toHaveBeenCalled()
    expectNoWrites()
  })
  it.each([ORDER, D1_ORDER])(
    'preserves real Node and D1 summaries/flags without normalizing them %#',
    async (order) => {
      const raw = { orders: [order] }
      const page = await render({ data: raw })
      expect(page.get('header').attributes('data-count')).toBe('1')
      expect(page.getComponent(Row).props('order')).toEqual(order)
      expect(data.value).toEqual(raw)
      expect(page.get('input').attributes('aria-label')).toBe('Buscar por número de pedido')
      expect(page.get('select').attributes('aria-label')).toBe('Filtrar pedidos por estado')
      expect(page.find('[role="alert"]').exists()).toBe(false)
      expect(startMock).not.toHaveBeenCalled()
      expectNoWrites()
    }
  )
  it('allows the Node extra metadata fields but passes only OrderSummary to rows', async () => {
    const page = await render({
      data: { orders: [{ ...ORDER, orderStatus: 'confirmed', paymentStatus: 'captured', paymentMethod: 'tarjeta' }] }
    })
    expect(page.getComponent(Row).props('order')).toEqual(ORDER)
    expectNoWrites()
  })
  it.each([undefined, { orders: [] }, { orders: [ORDER] }])(
    'never confirms empty/cached data after GET error %#',
    async (value) => {
      const page = await render({ data: value, status: 'error' })
      expect(page.get('[role="alert"]').text()).toContain('No hemos podido cargar tus pedidos')
      expect(page.get('header').attributes('data-count')).toBeUndefined()
      expect(page.find('input').exists()).toBe(false)
      expect(page.find('article').exists()).toBe(false)
      expect(page.text()).not.toContain('Todavía no tienes pedidos')
      expect(retryButton(page)?.attributes('type')).toBe('button')
      await reorder(page)(ORDER.id)
      expect(startMock).not.toHaveBeenCalled()
      expectNoWrites()
    }
  )
  it.each([
    undefined,
    null,
    {},
    [],
    { orders: null },
    { orders: {} },
    { orders: 'invalid' },
    { orders: [null] },
    { orders: [{ ...ORDER, id: 1 }] },
    { orders: [{ ...ORDER, id: '' }] },
    { orders: [{ ...ORDER, id: ' ABC123' }] },
    { orders: [{ ...ORDER, id: 'bad\nid' }] },
    { orders: [{ ...ORDER, id: 'x'.repeat(257) }] },
    { orders: [{ ...ORDER, status: 'toString' }] },
    { orders: [{ ...ORDER, status: 'unknown' }] },
    { orders: [{ ...ORDER, total: -1 }] },
    { orders: [{ ...ORDER, total: 1.2 }] },
    { orders: [{ ...ORDER, total: '12345' }] },
    { orders: [{ ...ORDER, total: Number.NaN }] },
    { orders: [{ ...ORDER, total: Number.MAX_SAFE_INTEGER + 1 }] },
    { orders: [{ ...ORDER, lines: -1 }] },
    { orders: [{ ...ORDER, lines: 1.2 }] },
    { orders: [{ ...ORDER, lines: '2' }] },
    { orders: [{ ...ORDER, createdAt: 'not-a-date' }] },
    { orders: [{ ...ORDER, createdAt: '2026-02-30T10:00:00Z' }] },
    { orders: [{ ...ORDER, invoiceAvailable: 'false' }] },
    { orders: [{ ...ORDER, fullDetailAvailable: undefined }] },
    { orders: [ORDER, ORDER] },
    { orders: Array.from({ length: 201 }, (_, index) => ({ ...ORDER, id: `SYNTHETIC${index}` })) }
  ])('rejects malformed summaries/payload instead of reporting empty %#', async (value) => {
    const page = await render({ data: value })
    expect(page.get('[role="alert"]').text()).toContain('No hemos podido cargar tus pedidos')
    expect(page.text()).not.toContain('Todavía no tienes pedidos')
    expect(page.get('header').attributes('data-count')).toBeUndefined()
    expect(page.find('article').exists()).toBe(false)
    await reorder(page)(ORDER.id)
    expect(startMock).not.toHaveBeenCalled()
    expectNoWrites()
  })
  it.each([
    'root_getter',
    'row_getter',
    'array_getter',
    'root_prototype',
    'row_prototype',
    'sparse_array',
    'array_prototype'
  ])('rejects %s without executing accessors', async (poison) => {
    const getter = vi.fn(() => ORDER.id)
    let value: unknown = { orders: [ORDER] }
    if (poison === 'root_getter') value = Object.defineProperty({}, 'orders', { get: getter, enumerable: true })
    if (poison === 'row_getter')
      value = { orders: [Object.defineProperty({ ...ORDER }, 'id', { get: getter, enumerable: true })] }
    if (poison === 'array_getter')
      value = { orders: Object.defineProperty([ORDER], '0', { get: getter, enumerable: true }) }
    if (poison === 'root_prototype') value = Object.create({ orders: [ORDER] })
    if (poison === 'row_prototype')
      value = {
        orders: [
          Object.assign(Object.create({ id: ORDER.id }), {
            status: ORDER.status,
            total: ORDER.total,
            createdAt: ORDER.createdAt,
            lines: ORDER.lines
          })
        ]
      }
    if (poison === 'sparse_array') value = { orders: new Array(1) }
    if (poison === 'array_prototype') value = { orders: Object.setPrototypeOf([ORDER], Object.create(Array.prototype)) }
    const page = await render({ data: value })
    expect(page.find('article').exists()).toBe(false)
    expect(page.find('[role="alert"]').exists()).toBe(true)
    expect(getter).not.toHaveBeenCalled()
    expectNoWrites()
  })
  it('preserves filtering of a valid list without changing the confirmed total', async () => {
    const page = await render({ data: { orders: [ORDER, { ...D1_ORDER, status: 'cancelado' }] } })
    await page.get('input').setValue('not-matching')
    expect(page.text()).toContain('Ningún pedido coincide con el filtro')
    expect(page.get('header').attributes('data-count')).toBe('2')
    await page
      .findAll('button')
      .find((button) => button.text() === 'Quitar filtros')!
      .trigger('click')
    expect(page.findAll('article')).toHaveLength(2)
    await page.get('select').setValue('cancelado')
    expect(page.findAll('article')).toHaveLength(1)
    expect(page.get('article').text()).toContain(D1_ORDER.id)
    expectNoWrites()
  })
  it.each([{ orders: [] }, { orders: [D1_ORDER] }])(
    'recovers only by a manual GET retry without reorder or writes %#',
    async (recovered) => {
      const page = await render({ status: 'error' })
      refreshMock.mockImplementationOnce(async () => {
        data.value = recovered
        status.value = 'success'
      })
      await retryButton(page)!.trigger('click')
      await flushPromises()
      expect(refreshMock).toHaveBeenCalledExactlyOnceWith()
      expect(page.find('[role="alert"]').exists()).toBe(false)
      expect(page.get('header').attributes('data-count')).toBe(String(recovered.orders.length))
      expect(startMock).not.toHaveBeenCalled()
      expectNoWrites()
    }
  )
  it('guards duplicate retries with a private latch and hides cache while the request is in flight', async () => {
    let resolve: () => void = () => undefined
    refreshMock.mockImplementationOnce(
      () =>
        new Promise<void>((done) => {
          resolve = done
        })
    )
    const page = await render({ status: 'error' })
    const callback = retry(page)
    const run = callback()
    await callback()
    await nextTick()
    expect(refreshMock).toHaveBeenCalledOnce()
    expect(page.find('article').exists()).toBe(false)
    expect(page.get('header').attributes('data-count')).toBeUndefined()
    await reorder(page)(ORDER.id)
    expect(startMock).not.toHaveBeenCalled()
    data.value = { orders: [] }
    status.value = 'success'
    resolve()
    await run
    await nextTick()
    expect(page.text()).toContain('Todavía no tienes pedidos')
    expectNoWrites()
  })
  it('keeps a thrown retry as an error even if the transport leaves a successful cached payload', async () => {
    const page = await render({ status: 'error' })
    refreshMock.mockImplementationOnce(async () => {
      status.value = 'success'
      throw new Error('synthetic provider secret not rendered')
    })
    await retry(page)()
    await nextTick()
    expect(page.find('article').exists()).toBe(false)
    expect(page.get('[role="alert"]').text()).not.toContain('provider secret')
    expect(page.get('header').attributes('data-count')).toBeUndefined()
    expect(startMock).not.toHaveBeenCalled()
    expectNoWrites()
  })
  it('allows only a current validated order to open the existing confirmation dialog', async () => {
    const page = await render()
    await page.get('article button').trigger('click')
    await flushPromises()
    expect(startMock).toHaveBeenCalledExactlyOnceWith(ORDER.id)
    expect(requestMock).not.toHaveBeenCalled()
    await reorder(page)('foreign-order')
    await reorder(page)([ORDER.id])
    await reorder(page)({ toString: () => ORDER.id })
    expect(startMock).toHaveBeenCalledOnce()
  })
  it('blocks cached reorder callbacks after error, malformed payload or removal of the order', async () => {
    const page = await render()
    const callback = reorder(page)
    status.value = 'error'
    await callback(ORDER.id)
    status.value = 'success'
    data.value = { orders: [{ ...ORDER, total: 'invalid' }] }
    await callback(ORDER.id)
    data.value = { orders: [D1_ORDER] }
    await callback(ORDER.id)
    expect(startMock).not.toHaveBeenCalled()
    expectNoWrites()
  })
  it('guards concurrent reorder opens and detaches the old dialog when the confirmed identity set changes', async () => {
    let resolve: () => void = () => undefined
    startMock.mockImplementationOnce(
      () =>
        new Promise<void>((done) => {
          resolve = done
        })
    )
    const page = await render()
    const oldDialog = page.getComponent(Dialog)
    const callback = reorder(page)
    const run = callback(ORDER.id)
    await callback(ORDER.id)
    expect(startMock).toHaveBeenCalledOnce()
    data.value = { orders: [D1_ORDER] }
    await nextTick()
    expect(page.getComponent(Dialog).vm.$.uid).not.toBe(oldDialog.vm.$.uid)
    resolve()
    await run
    added(page)(1)
    expect(state(page).notice).toBe('')
    await callback(ORDER.id)
    expect(startMock).toHaveBeenCalledOnce()
    expectNoWrites()
  })
  it('ignores cached actions and late callbacks after unmount', async () => {
    let resolve: () => void = () => undefined
    refreshMock.mockImplementationOnce(
      () =>
        new Promise<void>((done) => {
          resolve = done
        })
    )
    const page = await render({ status: 'error' })
    const retryCallback = retry(page)
    const reorderCallback = reorder(page)
    const addedCallback = added(page)
    const run = retryCallback()
    page.unmount()
    wrapper = undefined
    resolve()
    await run
    await retryCallback()
    await reorderCallback(ORDER.id)
    addedCallback(1)
    expect(refreshMock).toHaveBeenCalledOnce()
    expect(startMock).not.toHaveBeenCalled()
    expect(state(page).notice).toBe('')
    expectNoWrites()
  })
})

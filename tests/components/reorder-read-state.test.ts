import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { defineComponent, h, nextTick, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ReorderDialog from '../../app/components/ReorderDialog.vue'
import type { OrderDetailLines } from '../../app/composables/useAccount'
import type { useReorder } from '../../app/composables/useReorder'
import type { OrderReorderOffer } from '../../shared/order-reorder'
import '#app/nuxt-vitest-app-entry'

const { fetchMock, addMock, sessionMock, cartState, runtimeMock } = vi.hoisted(() => ({
  runtimeMock: vi.fn(() => ({
    app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
    public: { serverRuntime: 'node' }
  })),
  cartState: { pendingMutation: false },
  sessionMock: vi.fn(),
  fetchMock: vi.fn<(path: string, options?: { method?: string }) => Promise<OrderDetailLines>>(),
  addMock: vi.fn()
}))
mockNuxtImport('$fetch', () => fetchMock)
mockNuxtImport('useRuntimeConfig', () => runtimeMock)
vi.mock('../../app/stores/cart', () => ({
  useCartStore: () => ({
    get pendingMutation() {
      return cartState.pendingMutation
    },
    add: addMock,
    load: async () => undefined
  })
}))
mockNuxtImport('useUserSession', () => () => sessionMock())

const NODE_ID = 'NE0123456789'
const D1_ID = '10000000-0000-4000-8000-000000000001'
const GENERIC_ERROR = 'No hemos podido preparar la repetición del pedido. Puedes volver a intentarlo.'
const PRIVATE_ERROR = 'SQL private_table customer@example.invalid synthetic-token'

function detail(orderId = NODE_ID): OrderDetailLines {
  return {
    orderId,
    orderedAt: '2026-08-13T12:00:00Z',
    shippingMethod: 'envio',
    paymentMethod: null,
    fulfillmentStatus: null,
    destination: null,
    totals: { subtotalNet: 300, shippingNet: 0, tax: 63, total: 363 },
    shipment: null,
    lines: [
      {
        sku: 'SKU-AVAILABLE',
        name: 'Producto disponible',
        format: 'Caja',
        quantity: 3,
        unitGross: 121,
        lineGross: 363,
        variantId: 101,
        slug: 'producto-disponible',
        image: null,
        visual: null,
        available: true,
        reason: null
      },
      {
        sku: 'SKU-UNAVAILABLE',
        name: 'Producto antiguo',
        format: 'Botella',
        quantity: 1,
        unitGross: 121,
        lineGross: 121,
        variantId: null,
        slug: null,
        image: null,
        visual: null,
        available: false,
        reason: 'Ya no está en el catálogo'
      }
    ]
  }
}

// Keep the real Nuxt component, composable, buttons and alerts. Only isolate the
// modal portal/animation so closing behavior has a deterministic test surface.
const Modal = defineComponent({
  props: { open: Boolean, title: String },
  emits: ['update:open'],
  setup(props, { slots, emit }) {
    return () =>
      props.open
        ? h('dialog', { open: true }, [
            h('h2', props.title),
            h(
              'button',
              { type: 'button', 'data-modal-close': '', onClick: () => emit('update:open', false) },
              'Cerrar diálogo'
            ),
            slots.body?.(),
            slots.footer?.()
          ])
        : null
  }
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

type Wrapper = Awaited<ReturnType<typeof mountSuspended>>
let wrapper: Wrapper | undefined

async function render() {
  wrapper = await mountSuspended(ReorderDialog, {
    global: { stubs: { UModal: Modal, UIcon: true, OrderLineThumb: true } }
  })
  return wrapper
}
function controller(page: Wrapper) {
  return page.setupState.reorder as ReturnType<typeof useReorder>
}
function retryButton(page: Wrapper) {
  return page.findAll('button').find((button) => button.text() === 'Reintentar lectura del pedido')!
}
function addButton(page: Wrapper) {
  return page.findAll('button').find((button) => button.text().startsWith('Añadir '))!
}

beforeEach(() => {
  runtimeMock.mockReturnValue({
    app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
    public: { serverRuntime: 'node' }
  })
  cartState.pendingMutation = false
  sessionMock.mockReturnValue({
    loggedIn: ref(true),
    user: ref({ id: 'synthetic-customer' }),
    session: ref({ sessionId: 'session-a', sessionVersion: 1 })
  })
  fetchMock.mockReset().mockResolvedValue(detail())
  addMock.mockReset().mockResolvedValue(undefined)
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
})

describe('reorder read state and explicit safe retry', () => {
  const liveOffer = (): OrderReorderOffer => ({
    evaluatedAt: '2026-10-08T12:00:00Z',
    unitGross: 654,
    lineGross: 1962,
    unitNet: 595,
    lineNet: 1784,
    taxRateBasisPoints: 1000,
    pricingVersion: 'synthetic-approved-price',
    minimumQuantity: 1,
    maximumQuantity: null,
    quantityIncrement: 1,
    availableQuantity: 22,
    backorderAllowed: false,
    quantityAllowed: true,
    stockSufficient: true,
    purchasable: true
  })
  function currentPlan(current: OrderReorderOffer | null = liveOffer()) {
    const plan = detail(D1_ID)
    Object.assign(plan.lines[0]!, { reorderOffer: current })
    Object.assign(plan.lines[1]!, { reorderOffer: null })
    return plan
  }
  const cfRuntime = () =>
    runtimeMock.mockReturnValue({
      app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
      public: { serverRuntime: 'cloudflare' }
    })
  it('shows changed historical and observed gross/net prices with exact line rounding, then adds only after confirmation', async () => {
    cfRuntime()
    fetchMock.mockResolvedValueOnce(currentPlan())
    const page = await render(),
      reorder = controller(page)
    await reorder.open(D1_ID)
    await nextTick()
    expect(reorder.plan.value?.lines[0]).toMatchObject({ unitGross: 121, lineGross: 363, reorderOffer: liveOffer() })
    const text = page.text().replace(/\s+/g, ' ')
    expect(text).toContain('Precio histórico')
    expect(text).toContain('El precio ha cambiado')
    for (const price of ['1,21', '3,63', '6,54', '19,62', '5,95', '17,84']) expect(text).toContain(price)
    expect(text).toContain('IVA 10 %')
    expect(text).toContain('Disponibilidad observada')
    expect(text).toContain('22')
    expect(text).toContain('No reserva stock')
    expect(addMock).not.toHaveBeenCalled()
    await addButton(page).trigger('click')
    await flushPromises()
    expect(addMock).toHaveBeenCalledExactlyOnceWith({ variantId: 101 }, 3)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
  it.each(['null', 'quantity', 'stock', 'no-location-backorder'] as const)(
    'excludes %s current offers without changing original quantities',
    async (mode) => {
      cfRuntime()
      let current: OrderReorderOffer | null = liveOffer()
      if (mode === 'null') current = null
      if (mode === 'quantity') current = { ...current, minimumQuantity: 4, quantityAllowed: false, purchasable: false }
      if (mode === 'stock') current = { ...current, availableQuantity: 2, stockSufficient: false, purchasable: false }
      if (mode === 'no-location-backorder')
        current = {
          ...current,
          backorderAllowed: true,
          availableQuantity: 0,
          stockSufficient: false,
          purchasable: false
        }
      fetchMock.mockResolvedValueOnce(currentPlan(current))
      const page = await render(),
        reorder = controller(page)
      await reorder.open(D1_ID)
      await nextTick()
      expect(reorder.plan.value?.lines[0]?.quantity).toBe(3)
      expect(reorder.availableLines.value).toHaveLength(0)
      expect(reorder.unavailableLines.value).toHaveLength(2)
      expect(addButton(page).attributes('disabled')).toBeDefined()
      await reorder.confirm()
      expect(addMock).not.toHaveBeenCalled()
      expect(page.text()).toContain(
        mode === 'null' ? 'oferta vigente' : mode === 'quantity' ? 'límites vigentes' : 'disponibilidad observada'
      )
    }
  )
  it('rejects a CF response with a missing offer instead of treating it as a Node observation', async () => {
    cfRuntime()
    fetchMock.mockResolvedValueOnce(detail(D1_ID))
    const page = await render(),
      reorder = controller(page)
    await reorder.open(D1_ID)
    expect(reorder.plan.value).toBeNull()
    expect(reorder.canRetry.value).toBe(true)
    await reorder.confirm()
    expect(addMock).not.toHaveBeenCalled()
  })
  it('explains observed backorders and preserves unchanged historical gross prices without a false change warning', async () => {
    cfRuntime()
    const current = {
      ...liveOffer(),
      unitGross: 121,
      lineGross: 363,
      unitNet: 110,
      lineNet: 330,
      availableQuantity: 0,
      backorderAllowed: true
    }
    fetchMock.mockResolvedValueOnce(currentPlan(current))
    const page = await render(),
      reorder = controller(page)
    await reorder.open(D1_ID)
    await nextTick()
    expect(page.text()).toContain('Venta bajo pedido admitida')
    expect(page.text()).not.toContain('El precio ha cambiado')
    expect(reorder.availableLines.value).toHaveLength(1)
    expect(addMock).not.toHaveBeenCalled()
  })
  it('does not ADD any line while the cart already has an unresolved mutation', async () => {
    const page = await render(),
      reorder = controller(page)
    await reorder.open(NODE_ID)
    cartState.pendingMutation = true
    expect(await reorder.confirm()).toEqual({ added: 0, failed: [] })
    expect(addMock).not.toHaveBeenCalled()
    expect(reorder.availableLines.value.map((line) => line.variantId)).toEqual([101])
    expect(reorder.error.value).toContain('carrito')
  })
  it('stops after an ambiguous ADD and preserves never-sent lines for explicit confirmation after recovery', async () => {
    const plan = detail()
    plan.lines.push({ ...plan.lines[0]!, variantId: 202, sku: 'SECOND', name: 'Segunda', quantity: 2 })
    fetchMock.mockResolvedValueOnce(plan)
    const page = await render(),
      reorder = controller(page)
    await reorder.open(NODE_ID)
    addMock.mockImplementationOnce(async () => {
      cartState.pendingMutation = true
      throw new Error('response lost; durable ADD intent remains pending in cart store')
    })
    expect(await reorder.confirm()).toEqual({ added: 0, failed: ['Producto disponible'] })
    expect(addMock.mock.calls).toEqual([[{ variantId: 101 }, 3]])
    expect(reorder.availableLines.value.map((line) => line.variantId)).toEqual([202])
    await reorder.confirm()
    expect(addMock).toHaveBeenCalledTimes(1)
    cartState.pendingMutation = false
    await flushPromises()
    expect(addMock).toHaveBeenCalledTimes(1)
    expect(await reorder.confirm()).toEqual({ added: 1, failed: [] })
    expect(addMock.mock.calls).toEqual([
      [{ variantId: 101 }, 3],
      [{ variantId: 202 }, 2]
    ])
    expect(reorder.error.value).toContain('Producto disponible')
    expect(reorder.error.value).not.toContain('No se ha confirmado la adición: Segunda')
  })
  it('checks the cart mutation gate again before each never-sent line', async () => {
    const plan = detail()
    plan.lines.push({ ...plan.lines[0]!, variantId: 202, sku: 'SECOND', name: 'Segunda', quantity: 2 })
    fetchMock.mockResolvedValueOnce(plan)
    const page = await render(),
      reorder = controller(page)
    await reorder.open(NODE_ID)
    addMock.mockImplementationOnce(async () => {
      cartState.pendingMutation = true
    })
    expect(await reorder.confirm()).toEqual({ added: 1, failed: [] })
    expect(addMock).toHaveBeenCalledTimes(1)
    expect(reorder.availableLines.value.map((line) => line.variantId)).toEqual([202])
    expect(reorder.error.value).toContain('carrito')
  })
  it('singleflights confirmation with an immutable line intent even if UI refs are modified', async () => {
    const pending = deferred<undefined>(),
      page = await render(),
      reorder = controller(page)
    await reorder.open(NODE_ID)
    addMock.mockReturnValueOnce(pending.promise)
    const first = reorder.confirm()
    reorder.adding.value = false
    reorder.plan.value!.lines[0]!.quantity = 99
    const second = reorder.confirm()
    expect(addMock.mock.calls).toEqual([[{ variantId: 101 }, 3]])
    pending.resolve(undefined)
    await first
    await second
    expect(addMock).toHaveBeenCalledTimes(1)
    await reorder.confirm()
    expect(addMock).toHaveBeenCalledTimes(1)
  })
  it.each([400, 422])(
    'retries only definitely rejected lines (%s) without adding already successful lines again',
    async (statusCode) => {
      const plan = detail()
      plan.lines.push({ ...plan.lines[0]!, variantId: 202, sku: 'SECOND', name: 'Segunda', quantity: 2 })
      fetchMock.mockResolvedValueOnce(plan)
      addMock.mockResolvedValueOnce(undefined).mockRejectedValueOnce({ statusCode }).mockResolvedValueOnce(undefined)
      const page = await render(),
        reorder = controller(page)
      await reorder.open(NODE_ID)
      expect(await reorder.confirm()).toMatchObject({ added: 1, failed: ['Segunda'] })
      expect(reorder.availableLines.value.map((line) => line.variantId)).toEqual([202])
      expect(await reorder.confirm()).toMatchObject({ added: 1, failed: [] })
      expect(addMock.mock.calls).toEqual([
        [{ variantId: 101 }, 3],
        [{ variantId: 202 }, 2],
        [{ variantId: 202 }, 2]
      ])
    }
  )
  it('freezes all quantities before the first asynchronous addition settles', async () => {
    const plan = detail()
    plan.lines.push({ ...plan.lines[0]!, variantId: 202, sku: 'SECOND', quantity: 2 })
    fetchMock.mockResolvedValueOnce(plan)
    const page = await render(),
      reorder = controller(page),
      pending = deferred<undefined>()
    await reorder.open(NODE_ID)
    addMock.mockReturnValueOnce(pending.promise)
    const request = reorder.confirm()
    reorder.plan.value!.lines[2]!.variantId = 303
    reorder.plan.value!.lines[2]!.quantity = 99
    pending.resolve(undefined)
    await request
    expect(addMock.mock.calls).toEqual([
      [{ variantId: 101 }, 3],
      [{ variantId: 202 }, 2]
    ])
  })
  it.each([new Error('lost-response'), { statusCode: 500 }, { statusCode: 409 }, { statusCode: 404 }])(
    'never retries an ambiguous cart result %# with a new key',
    async (failure) => {
      const page = await render(),
        reorder = controller(page)
      await reorder.open(NODE_ID)
      addMock.mockRejectedValueOnce(failure)
      await reorder.confirm()
      await reorder.confirm()
      await nextTick()
      expect(addMock).toHaveBeenCalledTimes(1)
      expect(page.text()).toContain('Comprueba el carrito')
      expect(reorder.availableLines.value).toHaveLength(0)
    }
  )
  it.each(['close', 'dispose', 'identity', 'session', 'version', 'logout'] as const)(
    'does not continue or emit an obsolete confirmation after %s',
    async (action) => {
      const plan = detail()
      plan.lines.push({ ...plan.lines[0]!, variantId: 202, sku: 'SECOND' })
      fetchMock.mockResolvedValueOnce(plan)
      const pending = deferred<undefined>(),
        page = await render(),
        reorder = controller(page)
      await reorder.open(NODE_ID)
      addMock.mockReturnValueOnce(pending.promise)
      const request = reorder.confirm()
      if (action === 'close') reorder.close()
      if (action === 'dispose') {
        page.unmount()
        wrapper = undefined
      }
      if (action === 'identity') sessionMock().user.value = { id: 'other-customer' }
      if (action === 'session') sessionMock().session.value = { sessionId: 'session-b', sessionVersion: 1 }
      if (action === 'version') sessionMock().session.value = { sessionId: 'session-a', sessionVersion: 2 }
      if (action === 'logout') sessionMock().loggedIn.value = false
      await reorder.open(D1_ID)
      pending.resolve(undefined)
      expect(await request).toMatchObject({ added: 0 })
      expect(addMock).toHaveBeenCalledTimes(1)
      expect(reorder.plan.value).toBeNull()
      expect(page.emitted('added')).toBeUndefined()
    }
  )
  it('retains the ambiguous-line warning after a different safely rejected line is successfully retried', async () => {
    const plan = detail()
    plan.lines.push({ ...plan.lines[0]!, variantId: 202, sku: 'SECOND', quantity: 2 })
    fetchMock.mockResolvedValueOnce(plan)
    addMock
      .mockRejectedValueOnce(new Error('lost-response'))
      .mockRejectedValueOnce({ statusCode: 422 })
      .mockResolvedValueOnce(undefined)
    const page = await render(),
      reorder = controller(page)
    await reorder.open(NODE_ID)
    await reorder.confirm()
    await reorder.confirm()
    await nextTick()
    expect(addMock.mock.calls).toEqual([
      [{ variantId: 101 }, 3],
      [{ variantId: 202 }, 2],
      [{ variantId: 202 }, 2]
    ])
    expect(page.text()).toContain('Comprueba el carrito')
    expect(reorder.availableLines.value).toHaveLength(0)
    expect(reorder.addedCount.value).toBe(1)
  })
  it.each([401, 403])('stops all remaining additions on revoked authority %s', async (statusCode) => {
    const plan = detail()
    plan.lines.push({ ...plan.lines[0]!, variantId: 202, sku: 'SECOND' })
    fetchMock.mockResolvedValueOnce(plan)
    const page = await render(),
      reorder = controller(page)
    await reorder.open(NODE_ID)
    addMock.mockRejectedValueOnce({ statusCode })
    await reorder.confirm()
    await reorder.confirm()
    await nextTick()
    expect(addMock).toHaveBeenCalledTimes(1)
    expect(page.text()).toContain('sesión')
    expect(reorder.availableLines.value).toHaveLength(0)
  })
  it.each(['identity', 'quantity', 'variant', 'availability', 'date', 'unknown', 'getter'])(
    'rejects malformed reorder DTO %s before enabling any cart mutation',
    async (kind) => {
      const plan = detail(),
        getter = vi.fn(() => 101)
      if (kind === 'identity') plan.orderId = D1_ID
      if (kind === 'quantity') plan.lines[0]!.quantity = NaN
      if (kind === 'variant') plan.lines[0]!.variantId = -1
      if (kind === 'availability') plan.lines[0]!.variantId = null
      if (kind === 'date') plan.orderedAt = 'invalid'
      if (kind === 'unknown') Object.assign(plan, { unexpected: true })
      if (kind === 'getter') Object.defineProperty(plan.lines[0]!, 'variantId', { enumerable: true, get: getter })
      fetchMock.mockResolvedValueOnce(plan)
      const page = await render(),
        reorder = controller(page)
      await reorder.open(NODE_ID)
      await reorder.confirm()
      expect(reorder.plan.value).toBeNull()
      expect(addMock).not.toHaveBeenCalled()
      expect(getter).not.toHaveBeenCalled()
    }
  )
  it('does not describe a historical preview as current pricing', async () => {
    const page = await render()
    await controller(page).open(NODE_ID)
    await nextTick()
    expect(page.text()).not.toContain('los precios y la disponibilidad son los de hoy')
    expect(page.text()).toContain('precios históricos')
  })
  it('starts closed without fetching or adding anything', async () => {
    const page = await render()
    expect(page.find('dialog').exists()).toBe(false)
    await controller(page).retry()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(addMock).not.toHaveBeenCalled()
  })

  it.each([NODE_ID, D1_ID])('preserves the existing opaque order identity %s in a GET-only preview', async (id) => {
    fetchMock.mockResolvedValueOnce(detail(id))
    const page = await render()
    await controller(page).open(id)
    await nextTick()
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(`/api/orders/${id}/lines`, { method: 'GET' })
    expect(page.get('dialog').text()).toContain(id)
    expect(page.text()).toContain('Producto disponible')
    expect(page.text()).toContain('Producto antiguo')
    expect(page.text()).toContain('Ya no está en el catálogo')
    expect(addButton(page).text()).toBe('Añadir 1 al carrito')
    expect(retryButton(page)).toBeUndefined()
    expect(addMock).not.toHaveBeenCalled()
  })

  it('shows an announced pending read and disables add until it settles', async () => {
    const pending = deferred<OrderDetailLines>()
    fetchMock.mockReturnValueOnce(pending.promise)
    const page = await render()
    const request = controller(page).open(NODE_ID)
    await nextTick()
    expect(page.get('[role="status"]').text()).toContain('Preparando la repetición del pedido')
    expect(page.get('[role="status"]').attributes('aria-busy')).toBe('true')
    expect(addButton(page).attributes('disabled')).toBeDefined()
    expect(addMock).not.toHaveBeenCalled()
    pending.resolve(detail())
    await request
    await nextTick()
    expect(page.find('[role="status"]').exists()).toBe(false)
    expect(addButton(page).attributes('disabled')).toBeUndefined()
    expect(addMock).not.toHaveBeenCalled()
  })

  it.each([
    new Error(PRIVATE_ERROR),
    { statusCode: 503, data: { statusMessage: PRIVATE_ERROR } },
    { statusCode: 404, data: { message: PRIVATE_ERROR } }
  ])('keeps a generic visible error after read failure without reflecting server details: %#', async (failure) => {
    fetchMock.mockRejectedValueOnce(failure)
    const page = await render()
    await controller(page).open(NODE_ID)
    await nextTick()
    expect(page.get('dialog').exists()).toBe(true)
    expect(page.get('[role="alert"]').text()).toContain(GENERIC_ERROR)
    expect(page.html()).not.toContain(PRIVATE_ERROR)
    expect(retryButton(page).attributes('type')).toBe('button')
    expect(addButton(page)).toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(addMock).not.toHaveBeenCalled()
  })

  it('retries only the same GET on explicit click, then recovers without adding products', async () => {
    fetchMock.mockRejectedValueOnce(new Error(PRIVATE_ERROR)).mockResolvedValueOnce(detail(D1_ID))
    const page = await render()
    await controller(page).open(D1_ID)
    await nextTick()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await retryButton(page).trigger('click')
    await flushPromises()
    expect(fetchMock.mock.calls).toEqual([
      [`/api/orders/${D1_ID}/lines`, { method: 'GET' }],
      [`/api/orders/${D1_ID}/lines`, { method: 'GET' }]
    ])
    expect(page.text()).toContain(D1_ID)
    expect(page.find('[role="alert"]').exists()).toBe(false)
    expect(retryButton(page)).toBeUndefined()
    expect(addMock).not.toHaveBeenCalled()
    await controller(page).retry()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('uses a private pending guard for double starts, not the writable loading indicator', async () => {
    const pending = deferred<OrderDetailLines>()
    fetchMock.mockReturnValueOnce(pending.promise)
    const page = await render()
    const reorder = controller(page)
    const first = reorder.open(NODE_ID)
    reorder.loading.value = false
    await reorder.open(NODE_ID)
    await reorder.open(D1_ID)
    await reorder.retry()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    pending.resolve(detail())
    await first
    expect(reorder.plan.value?.orderId).toBe(NODE_ID)
    expect(addMock).not.toHaveBeenCalled()
  })

  it('blocks double retry callbacks while the same read is pending', async () => {
    const pending = deferred<OrderDetailLines>()
    fetchMock.mockRejectedValueOnce(new Error(PRIVATE_ERROR)).mockReturnValueOnce(pending.promise)
    const page = await render()
    const reorder = controller(page)
    await reorder.open(NODE_ID)
    const retry = reorder.retry
    const first = retry()
    await retry()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    await nextTick()
    expect(page.get('[role="status"]').exists()).toBe(true)
    pending.resolve(detail())
    await first
    expect(addMock).not.toHaveBeenCalled()
  })

  it.each(['resolve', 'reject'] as const)(
    'does not reopen after closing an in-flight read that later %ss',
    async (settle) => {
      const pending = deferred<OrderDetailLines>()
      fetchMock.mockReturnValueOnce(pending.promise)
      const page = await render()
      const reorder = controller(page)
      const request = reorder.open(NODE_ID)
      await nextTick()
      await page.get('[data-modal-close]').trigger('click')
      expect(page.find('dialog').exists()).toBe(false)
      if (settle === 'resolve') pending.resolve(detail())
      else pending.reject(new Error(PRIVATE_ERROR))
      await request
      await nextTick()
      expect(page.find('dialog').exists()).toBe(false)
      expect(reorder.plan.value).toBeNull()
      expect(reorder.error.value).toBe('')
      expect(reorder.loading.value).toBe(false)
      await reorder.retry()
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(addMock).not.toHaveBeenCalled()
    }
  )

  it('clears retry identity when cancelling an error dialog', async () => {
    fetchMock.mockRejectedValueOnce(new Error(PRIVATE_ERROR))
    const page = await render()
    const reorder = controller(page)
    await reorder.open(NODE_ID)
    await nextTick()
    const retry = reorder.retry
    await page
      .findAll('button')
      .find((button) => button.text() === 'Cancelar')!
      .trigger('click')
    await retry()
    expect(page.find('dialog').exists()).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(addMock).not.toHaveBeenCalled()
  })

  it.each(['resolve', 'reject'] as const)('ignores an obsolete %s without clearing a newer request', async (settle) => {
    const older = deferred<OrderDetailLines>()
    const newer = deferred<OrderDetailLines>()
    fetchMock.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise)
    const page = await render()
    const reorder = controller(page)
    const first = reorder.open(NODE_ID)
    reorder.close()
    const second = reorder.open(D1_ID)
    if (settle === 'resolve') older.resolve(detail())
    else older.reject(new Error(PRIVATE_ERROR))
    await first
    await nextTick()
    expect(reorder.loading.value).toBe(true)
    expect(reorder.plan.value).toBeNull()
    expect(reorder.error.value).toBe('')
    await reorder.open(NODE_ID)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    newer.resolve(detail(D1_ID))
    await second
    await nextTick()
    expect(page.get('dialog').text()).toContain(D1_ID)
    expect(page.text()).not.toContain(NODE_ID)
    expect(addMock).not.toHaveBeenCalled()
  })

  it.each(['resolve', 'reject'] as const)('ignores a pending %s and cached callbacks after unmount', async (settle) => {
    const pending = deferred<OrderDetailLines>()
    fetchMock.mockReturnValueOnce(pending.promise)
    const page = await render()
    const reorder = controller(page)
    const request = reorder.open(NODE_ID)
    page.unmount()
    wrapper = undefined
    if (settle === 'resolve') pending.resolve(detail())
    else pending.reject(new Error(PRIVATE_ERROR))
    await request
    await reorder.open(D1_ID)
    await reorder.retry()
    expect(reorder.plan.value).toBeNull()
    expect(reorder.loading.value).toBe(false)
    expect(reorder.error.value).toBe('')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(addMock).not.toHaveBeenCalled()
  })

  it.each([undefined, null, '', '   ', ' NE0123456789 ', `${NODE_ID}\n`, 123, [NODE_ID], { id: NODE_ID }, '\ud800'])(
    'does not coerce an invalid initial identity or make it retryable: %#',
    async (id) => {
      const page = await render()
      const reorder = controller(page)
      await reorder.open(id as string)
      await reorder.retry()
      expect(page.find('dialog').exists()).toBe(false)
      expect(fetchMock).not.toHaveBeenCalled()
      expect(addMock).not.toHaveBeenCalled()
    }
  )

  it('encodes an opaque identity as one path segment without changing its value', async () => {
    const id = 'opaque/id?query#fragment'
    fetchMock.mockResolvedValueOnce(detail(id))
    const page = await render()
    await controller(page).open(id)
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(`/api/orders/${encodeURIComponent(id)}/lines`, { method: 'GET' })
    expect(controller(page).plan.value?.orderId).toBe(id)
    expect(addMock).not.toHaveBeenCalled()
  })

  it('preserves explicit confirmation: adds only available lines with their original quantities', async () => {
    const page = await render()
    await controller(page).open(NODE_ID)
    await nextTick()
    expect(addMock).not.toHaveBeenCalled()
    await addButton(page).trigger('click')
    await flushPromises()
    expect(addMock).toHaveBeenCalledExactlyOnceWith({ variantId: 101 }, 3)
    expect(page.emitted('added')).toEqual([[1]])
    expect(page.find('dialog').exists()).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not turn a partial cart mutation failure into a read/mutation retry action', async () => {
    const plan = detail()
    plan.lines.push({ ...plan.lines[0]!, sku: 'SKU-SECOND', name: 'Segunda referencia', variantId: 202, quantity: 2 })
    fetchMock.mockResolvedValueOnce(plan)
    addMock.mockRejectedValueOnce(new Error(PRIVATE_ERROR)).mockResolvedValueOnce(undefined)
    const page = await render()
    await controller(page).open(NODE_ID)
    await nextTick()
    await addButton(page).trigger('click')
    await flushPromises()
    expect(addMock.mock.calls).toEqual([
      [{ variantId: 101 }, 3],
      [{ variantId: 202 }, 2]
    ])
    expect(page.emitted('added')).toEqual([[1]])
    expect(page.get('[role="alert"]').text()).toContain('No se ha confirmado la adición: Producto disponible.')
    expect(page.html()).not.toContain(PRIVATE_ERROR)
    expect(retryButton(page)).toBeUndefined()
    await controller(page).retry()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(addMock).toHaveBeenCalledTimes(2)
    expect(controller(page).plan.value).toEqual(plan)
  })
})

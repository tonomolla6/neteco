import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { ref } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import OrderFulfillmentPanel from '../../app/components/OrderFulfillmentPanel.vue'
import type { AdminOrderFulfillment } from '../../shared/order-fulfillment'
import '#app/nuxt-vitest-app-entry'

const { request } = vi.hoisted(() => ({ request: vi.fn() }))
mockNuxtImport('$fetch', () => request)
const ACTOR = '10000000-0000-4000-8000-000000000043',
  OTHER = '10000000-0000-4000-8000-000000000044',
  ORDER = '30000000-0000-4000-8000-000000000043'
const context = (): AdminOrderFulfillment => ({
  source: 'cloudflare',
  orderId: ORDER,
  warehouse: { id: 'main', code: 'MAIN', name: 'Synthetic only warehouse' },
  shippingMethod: 'pickup',
  state: 'pending',
  interruptedState: null,
  version: 0,
  readiness: { ready: true, blockers: [] },
  capabilities: { fulfillmentRead: true, fulfillmentTransitions: true, allowedActions: ['picking', 'exception'] },
  inventoryPolicy: 'allocated_on_payment_no_fulfillment_decrement',
  timeline: { items: [], pagination: { page: 1, perPage: 25, total: 0, pages: 0 } },
  evaluatedAt: '2026-10-03T00:00:00Z'
})
const receipt = () => ({
  source: 'cloudflare',
  action: 'picking',
  commandId: '40000000-0000-4000-8000-000000000043',
  orderId: ORDER,
  warehouseId: 'main',
  state: 'picking',
  interruptedState: null,
  version: 1,
  inventoryEffect: 'none',
  updated: true
})
const mounted: Array<{ unmount: () => void }> = []
afterEach(() => {
  for (const item of mounted.splice(0)) item.unmount()
  request.mockReset()
})
async function render(overrides: Record<string, unknown> = {}) {
  const authority = ref(true),
    data = ref(context()),
    reload = vi.fn(async () => data.value)
  const wrapper = await mountSuspended(OrderFulfillmentPanel, {
    props: {
      snapshot: data.value,
      operatorId: ACTOR,
      runtime: 'cloudflare',
      authorize: () => authority.value,
      reload,
      ...overrides
    }
  })
  await flushPromises()
  request.mockClear()
  mounted.push(wrapper)
  return { wrapper, authority, data, reload }
}
async function prepare(wrapper: Awaited<ReturnType<typeof render>>['wrapper'], action = 'picking') {
  await wrapper.get('[data-testid="fulfillment-action"]').setValue(action)
  await wrapper.get('[data-testid="fulfillment-reason"]').setValue('Synthetic verified warehouse operation')
  if (action === 'exception')
    await wrapper.get('[data-testid="fulfillment-evidence"]').setValue('Synthetic package damage evidence record 043')
  await wrapper.get('form').trigger('submit')
  await flushPromises()
}
describe('post-payment fulfillment UI confirmation and uncertainty', () => {
  it('shows genuine pending/warehouse facts and a mandatory review before sending', async () => {
    const { wrapper, reload } = await render()
    expect(wrapper.text()).toContain('Pendiente de preparación')
    expect(wrapper.text()).toContain('no lo descuentan de nuevo')
    await prepare(wrapper)
    expect(request).not.toHaveBeenCalled()
    expect(wrapper.emitted('pending')?.at(-1)).toEqual([true])
    request.mockResolvedValueOnce(receipt())
    await wrapper.get('[data-testid="fulfillment-confirm"]').trigger('click')
    await flushPromises()
    expect(reload).toHaveBeenCalledTimes(2)
    expect(request).toHaveBeenCalledTimes(1)
    expect(request.mock.calls[0]?.[0]).toBe(`/api/admin/orders/${ORDER}/fulfillment/transitions`)
    expect(request.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      retry: 0,
      body: { action: 'picking', expectedVersion: 0 }
    })
    expect(wrapper.emitted('confirmed')?.[0]?.[0]).toMatchObject(receipt())
  })
  it('offers no operations for unpaid, unknown history or a delivered order', async () => {
    const data = context()
    data.readiness = { ready: false, blockers: ['payment_unconfirmed'] }
    data.capabilities = { fulfillmentRead: true, fulfillmentTransitions: false, allowedActions: [] }
    const { wrapper } = await render({ snapshot: data })
    expect(wrapper.text()).toContain('Pago capturado no confirmado')
    expect(wrapper.find('form').exists()).toBe(false)
    expect(request).not.toHaveBeenCalled()
  })
  it.each([{ runtime: 'legacy' }, { authorize: () => false }, { snapshot: { ...context(), source: 'legacy' } }])(
    'does not expose a working legacy/unauthorized/malformed panel %#',
    async (props) => {
      const { wrapper } = await render(props)
      expect(wrapper.find('form').exists()).toBe(false)
      expect(request).not.toHaveBeenCalled()
    }
  )
  it('rejects stale fresh GET before send and does not reinterpret the intent on a newer version', async () => {
    const { wrapper, data } = await render()
    await prepare(wrapper)
    data.value.version = 1
    data.value.state = 'picking'
    data.value.capabilities.allowedActions = ['packed', 'exception']
    data.value.timeline.pagination.total = 1
    data.value.timeline.pagination.pages = 1
    await wrapper.get('[data-testid="fulfillment-confirm"]').trigger('click')
    await flushPromises()
    expect(request).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('La preparación ha cambiado')
  })
  it('refuses dispatch when authorization is lost during awaited preflight read', async () => {
    const { wrapper, authority, reload } = await render()
    await prepare(wrapper)
    reload.mockImplementationOnce(async () => {
      authority.value = false
      return context()
    })
    await wrapper.get('[data-testid="fulfillment-confirm"]').trigger('click')
    await flushPromises()
    expect(request).not.toHaveBeenCalled()
    expect(wrapper.emitted('confirmed')).toBeUndefined()
  })
  it('retains exact same intent/key on lost response, even when fresh state is now delivered', async () => {
    const { wrapper, data } = await render()
    await prepare(wrapper)
    request.mockRejectedValueOnce(new Error('response lost')).mockResolvedValueOnce(receipt())
    await wrapper.get('[data-testid="fulfillment-confirm"]').trigger('click')
    await flushPromises()
    const first = request.mock.calls[0]!
    expect(wrapper.find('[data-testid="fulfillment-retry"]').exists()).toBe(true)
    expect(wrapper.get('[data-testid="fulfillment-cancel"]').attributes('disabled')).toBeDefined()
    data.value.state = 'delivered'
    data.value.version = 4
    data.value.timeline.pagination.total = 4
    data.value.timeline.pagination.pages = 1
    data.value.capabilities = { fulfillmentRead: true, fulfillmentTransitions: false, allowedActions: [] }
    await wrapper.get('[data-testid="fulfillment-retry"]').trigger('click')
    await flushPromises()
    expect(request.mock.calls[1]).toEqual([first[0], { ...first[1], onResponseError: expect.any(Function) }])
    expect(wrapper.emitted('confirmed')).toHaveLength(1)
  })
  it('keeps 403 after possibly committed POST uncertain without evaluating FetchError getters', async () => {
    const { wrapper } = await render()
    await prepare(wrapper)
    let getters = 0
    request.mockImplementationOnce(async (_path: string, options: { onResponseError: (context: unknown) => void }) => {
      options.onResponseError({ response: { status: 403, _data: { error: { code: 'forbidden' } } } })
      throw Object.create({
        get data() {
          getters++
          return { error: { code: 'forbidden' } }
        }
      })
    })
    await wrapper.get('[data-testid="fulfillment-confirm"]').trigger('click')
    await flushPromises()
    expect(getters).toBe(0)
    expect(wrapper.find('[data-testid="fulfillment-retry"]').exists()).toBe(true)
    expect(wrapper.emitted('confirmed')).toBeUndefined()
  })
  it('treats a verified 409 as definite, but never trusts an inherited error getter', async () => {
    const { wrapper } = await render()
    await prepare(wrapper)
    let getters = 0
    request.mockImplementationOnce(async (_path: string, options: { onResponseError: (context: unknown) => void }) => {
      const response = new Response(null, { status: 409 })
      Object.defineProperty(response, '_data', { value: { error: { code: 'version_conflict' } }, enumerable: true })
      options.onResponseError({ response })
      throw Object.create({
        get data() {
          getters++
          return { error: { code: 'version_conflict' } }
        }
      })
    })
    await wrapper.get('[data-testid="fulfillment-confirm"]').trigger('click')
    await flushPromises()
    expect(getters).toBe(0)
    expect(wrapper.find('[data-testid="fulfillment-retry"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('La operación se ha rechazado')
  })
  it.each([
    { orderId: '30000000-0000-4000-8000-000000000044' },
    { version: 7 },
    { action: 'delivered', state: 'delivered' },
    { warehouseId: 'other' },
    { inventoryEffect: 'decremented' }
  ])('refuses spoofed success %# and preserves recovery', async (patch) => {
    const { wrapper } = await render()
    await prepare(wrapper)
    request.mockResolvedValueOnce({ ...receipt(), ...patch })
    await wrapper.get('[data-testid="fulfillment-confirm"]').trigger('click')
    await flushPromises()
    expect(wrapper.emitted('confirmed')).toBeUndefined()
    expect(wrapper.find('[data-testid="fulfillment-retry"]').exists()).toBe(true)
  })
  it('does not send an old operator intent or a different order while recovering', async () => {
    const { wrapper, data } = await render()
    await prepare(wrapper)
    request.mockRejectedValueOnce(new Error('lost'))
    await wrapper.get('[data-testid="fulfillment-confirm"]').trigger('click')
    await flushPromises()
    await wrapper.setProps({ operatorId: OTHER })
    await wrapper.get('[data-testid="fulfillment-retry"]').trigger('click')
    await flushPromises()
    expect(request).toHaveBeenCalledTimes(1)
    await wrapper.setProps({ operatorId: ACTOR })
    data.value.orderId = '30000000-0000-4000-8000-000000000044'
    await wrapper.get('[data-testid="fulfillment-retry"]').trigger('click')
    await flushPromises()
    expect(request).toHaveBeenCalledTimes(1)
  })
  it('ignores async preflight completion after unmount', async () => {
    const { wrapper, reload } = await render()
    await prepare(wrapper)
    let resolve: ((value: AdminOrderFulfillment) => void) | undefined
    reload.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done
        })
    )
    await wrapper.get('[data-testid="fulfillment-confirm"]').trigger('click')
    wrapper.unmount()
    resolve!(context())
    await flushPromises()
    expect(request).not.toHaveBeenCalled()
    expect(wrapper.emitted('confirmed')).toBeUndefined()
  })
  it('ignores async POST completion after unmount without emit or refresh', async () => {
    const { wrapper, reload } = await render()
    await prepare(wrapper)
    let resolve: ((value: ReturnType<typeof receipt>) => void) | undefined
    request.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done
        })
    )
    await wrapper.get('[data-testid="fulfillment-confirm"]').trigger('click')
    await flushPromises()
    wrapper.unmount()
    resolve!(receipt())
    await flushPromises()
    expect(wrapper.emitted('confirmed')).toBeUndefined()
    expect(reload).toHaveBeenCalledTimes(1)
  })
})

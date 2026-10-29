import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { ref } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import OrderReturnPanel from '../../app/components/OrderReturnPanel.vue'
import CustomerReturnPanel from '../../app/components/CustomerReturnPanel.vue'
import {
  ACTOR,
  OTHER,
  ORDER,
  NEXT,
  REF,
  adminContext,
  customerContext,
  receipt,
  deferred
} from './order-returns-fixture'
import '#app/nuxt-vitest-app-entry'
const { request } = vi.hoisted(() => ({ request: vi.fn() }))
mockNuxtImport('$fetch', () => request)
const mounted: Array<{ unmount: () => void }> = []
afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount()
  request.mockReset()
})
async function renderAdmin(props: Record<string, unknown> = {}) {
  const authority = ref(true),
    data = ref(adminContext()),
    reload = vi.fn(async () => data.value)
  const wrapper = await mountSuspended(OrderReturnPanel, {
    props: {
      snapshot: data.value,
      operatorId: ACTOR,
      runtime: 'cloudflare',
      authorize: () => authority.value,
      reload,
      ...props
    }
  })
  mounted.push(wrapper)
  await flushPromises()
  request.mockClear()
  return { wrapper, authority, data, reload }
}
async function renderCustomer(props: Record<string, unknown> = {}) {
  const authority = ref(true),
    data = ref(customerContext()),
    reload = vi.fn(async () => data.value)
  const wrapper = await mountSuspended(CustomerReturnPanel, {
    props: {
      snapshot: data.value,
      operatorId: ACTOR,
      runtime: 'cloudflare',
      authorize: () => authority.value,
      reload,
      ...props
    }
  })
  mounted.push(wrapper)
  await flushPromises()
  request.mockClear()
  return { wrapper, authority, data, reload }
}
async function prepareAdmin(wrapper: Awaited<ReturnType<typeof renderAdmin>>['wrapper'], action = 'approved') {
  await wrapper.get('[data-testid="return-action"]').setValue(action)
  await wrapper.get('[data-testid="return-reason"]').setValue('Private documented case review')
  await wrapper.get('[data-testid="return-public-message"]').setValue('Información visible para el cliente.')
  await wrapper.get('[data-testid="return-evidence"]').setValue('Private warehouse evidence reference')
  if (action === 'approved') await wrapper.get('[data-testid="return-decision"]').setValue('documented-review-ref')
  if (action === 'resolution_ready')
    await wrapper.get('[data-testid="return-resolution"]').setValue('Propuesta preparada sin efectos económicos.')
  await wrapper.get('form').trigger('submit')
  await flushPromises()
}
async function prepareCustomer(wrapper: Awaited<ReturnType<typeof renderCustomer>>['wrapper']) {
  await wrapper.get('[data-testid="customer-return-quantity-0"]').setValue(1)
  await wrapper.get('[data-testid="customer-return-reason"]').setValue('Synthetic product return reason')
  await wrapper.get('form').trigger('submit')
  await flushPromises()
}
describe('native RMA admin confirmation and same-key recovery', () => {
  it('requires review then sends a strict documented admission without stock/refund authority', async () => {
    const { wrapper, reload, data } = await renderAdmin()
    await prepareAdmin(wrapper)
    expect(request).not.toHaveBeenCalled()
    expect(wrapper.emitted('pending')?.at(-1)).toEqual([true])
    request.mockImplementation(async () => {
      data.value = adminContext('approved', 2)
      return receipt()
    })
    await wrapper.get('[data-testid="return-confirm"]').trigger('click')
    await flushPromises()
    expect(request).toHaveBeenCalledTimes(1)
    expect(request.mock.calls[0]).toMatchObject([
      `/api/admin/returns/${REF}`,
      {
        method: 'PUT',
        retry: 0,
        body: {
          action: 'approved',
          expectedVersion: 1,
          decisionRef: 'documented-review-ref',
          lines: [{ lineIndex: 0, quantity: 2 }]
        }
      }
    ])
    expect(reload).toHaveBeenCalledTimes(2)
    expect(wrapper.emitted('confirmed')?.[0]?.[0]).toEqual(receipt())
    expect(wrapper.text()).toContain('sin efectos sobre inventario')
  })
  it.each([
    { runtime: 'node' },
    { authorize: () => false },
    { operatorId: 'invalid' },
    { snapshot: { ...adminContext(), refunds: true } }
  ])('fails closed for unconfirmed context %#', async (props) => {
    const { wrapper } = await renderAdmin(props)
    expect(wrapper.find('form').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('Historical product')
    expect(request).not.toHaveBeenCalled()
  })
  it('does not send stale intent against a new version', async () => {
    const { wrapper, data } = await renderAdmin()
    await prepareAdmin(wrapper)
    data.value = adminContext('approved', 2)
    await wrapper.get('[data-testid="return-confirm"]').trigger('click')
    await flushPromises()
    expect(request).not.toHaveBeenCalled()
    expect(wrapper.find('[data-testid="return-intent"]').exists()).toBe(false)
  })
  it('cancels an unsent intent and requires no network action', async () => {
    const { wrapper } = await renderAdmin()
    await prepareAdmin(wrapper)
    await wrapper.get('[data-testid="return-cancel"]').trigger('click')
    expect(request).not.toHaveBeenCalled()
    expect(wrapper.emitted('pending')?.at(-1)).toEqual([false])
  })
  it('keeps exact frozen key/body after an uncertain PUT even after later resolution', async () => {
    const { wrapper, data } = await renderAdmin()
    await prepareAdmin(wrapper)
    request.mockRejectedValueOnce(new Error('network'))
    await wrapper.get('[data-testid="return-confirm"]').trigger('click')
    await flushPromises()
    const original = request.mock.calls[0]?.[1]
    expect(Object.isFrozen(original.body.lines)).toBe(true)
    expect(wrapper.find('[data-testid="return-cancel"]').exists()).toBe(false)
    data.value = adminContext('resolution_ready', 5)
    request.mockResolvedValueOnce(receipt())
    await wrapper.get('[data-testid="return-confirm"]').trigger('click')
    await flushPromises()
    expect(request.mock.calls[1]?.[1]).toMatchObject({ body: original.body, headers: original.headers })
    expect(wrapper.emitted('confirmed')).toHaveLength(1)
  })
  it('known 409 response is definitive but malformed receipt remains recoverable', async () => {
    const { wrapper } = await renderAdmin()
    await prepareAdmin(wrapper)
    request.mockImplementationOnce(async (_url, options) => {
      options.onResponseError({ response: { status: 409, _data: { error: { code: 'version_conflict' } } } })
      throw new Error('409')
    })
    await wrapper.get('[data-testid="return-confirm"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="return-intent"]').exists()).toBe(false)
    const second = await renderAdmin()
    await prepareAdmin(second.wrapper)
    request.mockResolvedValueOnce({ ...receipt(), inventoryEffect: 'restock' })
    await second.wrapper.get('[data-testid="return-confirm"]').trigger('click')
    await flushPromises()
    expect(second.wrapper.emitted('confirmed')).toBeUndefined()
    expect(second.wrapper.text()).toContain('Resultado no confirmado')
  })
  it('hides private facts and preserves uncertain key through transient MFA loss', async () => {
    const { wrapper, authority } = await renderAdmin()
    await prepareAdmin(wrapper)
    request.mockRejectedValueOnce(new Error('network'))
    await wrapper.get('[data-testid="return-confirm"]').trigger('click')
    await flushPromises()
    authority.value = false
    await flushPromises()
    expect(wrapper.text()).not.toContain(REF)
    expect(wrapper.text()).not.toContain('Historical product')
    authority.value = true
    await flushPromises()
    expect(wrapper.find('[data-testid="return-intent"]').exists()).toBe(true)
  })
  it('losing authority while GET waits prevents PUT and changing actor discards intent', async () => {
    const hold = deferred<unknown>(),
      { wrapper, authority } = await renderAdmin({ reload: () => hold.promise })
    await prepareAdmin(wrapper)
    await wrapper.get('[data-testid="return-confirm"]').trigger('click')
    authority.value = false
    hold.resolve(adminContext())
    await flushPromises()
    expect(request).not.toHaveBeenCalled()
    await wrapper.setProps({ operatorId: OTHER })
    authority.value = true
    await flushPromises()
    expect(wrapper.find('[data-testid="return-intent"]').exists()).toBe(false)
  })
  it('losing access after PUT suppresses receipt but retains ambiguous same-key intent', async () => {
    const hold = deferred<unknown>(),
      { wrapper, authority } = await renderAdmin()
    await prepareAdmin(wrapper)
    request.mockReturnValueOnce(hold.promise)
    await wrapper.get('[data-testid="return-confirm"]').trigger('click')
    await flushPromises()
    authority.value = false
    hold.resolve(receipt())
    await flushPromises()
    expect(wrapper.emitted('confirmed')).toBeUndefined()
    authority.value = true
    await flushPromises()
    expect(wrapper.text()).toContain('Recuperar con la misma clave')
  })
  it('inspection proposes quarantine and resolution records explicit zero separately from unknown cost', async () => {
    const inspected = await renderAdmin({ snapshot: adminContext('received', 3) })
    await prepareAdmin(inspected.wrapper, 'inspected')
    expect(inspected.wrapper.text()).toContain('Registrar inspección física')
    const ready = await renderAdmin({
      snapshot: adminContext('inspected', 4),
      reload: async () => adminContext('inspected', 4)
    })
    await ready.wrapper.get('[data-testid="return-action"]').setValue('resolution_ready')
    await ready.wrapper.get('[data-testid="return-known-cost"]').setValue(true)
    await ready.wrapper.get('[data-testid="return-cost-evidence"]').setValue('cost-evidence')
    await ready.wrapper.get('[data-testid="return-cost-description"]').setValue('Known zero operation cost')
    await prepareAdmin(ready.wrapper, 'resolution_ready')
    request.mockResolvedValueOnce(receipt('resolution_ready', 5))
    await ready.wrapper.get('[data-testid="return-confirm"]').trigger('click')
    await flushPromises()
    expect(request.mock.calls[0]?.[1].body.cost.amountCents).toBe(0)
  })
})
describe('native customer request privacy and quantity budget', () => {
  it('requires confirm and fresh quantity GET before real POST', async () => {
    const { wrapper, data } = await renderCustomer()
    await prepareCustomer(wrapper)
    expect(request).not.toHaveBeenCalled()
    request.mockImplementation(async () => {
      data.value = customerContext(ORDER, 1)
      return receipt('requested', 1)
    })
    await wrapper.get('[data-testid="customer-return-confirm"]').trigger('click')
    await flushPromises()
    expect(request.mock.calls[0]).toMatchObject([
      `/api/orders/${ORDER}/returns`,
      { method: 'POST', retry: 0, body: { expectedVersion: 0, lines: [{ lineIndex: 0, quantity: 1 }] } }
    ])
    expect(wrapper.text()).toContain('no confirma admisión ni reembolso')
    expect(wrapper.emitted('confirmed')).toHaveLength(1)
  })
  it('rejects excessive, fractional or empty quantity before any intent', async () => {
    const { wrapper } = await renderCustomer()
    await wrapper.get('[data-testid="customer-return-reason"]').setValue('Product return reason')
    for (const value of [0, 3, 1.5]) {
      await wrapper.get('[data-testid="customer-return-quantity-0"]').setValue(value)
      await wrapper.get('form').trigger('submit')
      expect(wrapper.find('[data-testid="customer-return-intent"]').exists()).toBe(false)
    }
    expect(request).not.toHaveBeenCalled()
  })
  it('fresh budget change or foreign order cannot dispatch', async () => {
    const { wrapper, data } = await renderCustomer()
    await prepareCustomer(wrapper)
    data.value = customerContext(ORDER, 1)
    await wrapper.get('[data-testid="customer-return-confirm"]').trigger('click')
    await flushPromises()
    expect(request).not.toHaveBeenCalled()
    const second = await renderCustomer({ reload: async () => customerContext(NEXT) })
    await prepareCustomer(second.wrapper)
    await second.wrapper.get('[data-testid="customer-return-confirm"]').trigger('click')
    await flushPromises()
    expect(request).not.toHaveBeenCalled()
  })
  it('recovers original POST after advanced budget with no available units', async () => {
    const { wrapper, data } = await renderCustomer()
    await prepareCustomer(wrapper)
    request.mockRejectedValueOnce(new Error('timeout'))
    await wrapper.get('[data-testid="customer-return-confirm"]').trigger('click')
    await flushPromises()
    const first = request.mock.calls[0]?.[1]
    data.value = customerContext(ORDER, 5)
    data.value.lines[0]!.claimedQuantity = 2
    data.value.lines[0]!.availableQuantity = 0
    data.value.capabilities.returnRequest = false
    request.mockResolvedValueOnce(receipt('requested', 1))
    await wrapper.get('[data-testid="customer-return-confirm"]').trigger('click')
    await flushPromises()
    expect(request.mock.calls[1]?.[1]).toMatchObject({ body: first.body, headers: first.headers })
    expect(wrapper.emitted('confirmed')).toHaveLength(1)
  })
  it('503 carrying fake conflict text and thrown accessors cannot classify committed outcome', async () => {
    const { wrapper } = await renderCustomer()
    await prepareCustomer(wrapper)
    request.mockImplementationOnce(async (_url, options) => {
      options.onResponseError({ response: { status: 503, _data: { error: { code: 'version_conflict' } } } })
      throw Object.defineProperty(new Error('failed'), 'data', {
        get() {
          throw new Error('getter')
        }
      })
    })
    await wrapper.get('[data-testid="customer-return-confirm"]').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('Recupera con el mismo')
    expect(wrapper.emitted('confirmed')).toBeUndefined()
  })
  it('operator/order replacement discards private prepared intent and no GET after unmount can send', async () => {
    const { wrapper } = await renderCustomer()
    await prepareCustomer(wrapper)
    await wrapper.setProps({ operatorId: OTHER, snapshot: customerContext(NEXT) })
    expect(wrapper.find('[data-testid="customer-return-intent"]').exists()).toBe(false)
    const hold = deferred<unknown>(),
      second = await renderCustomer({ reload: () => hold.promise })
    await prepareCustomer(second.wrapper)
    await second.wrapper.get('[data-testid="customer-return-confirm"]').trigger('click')
    second.wrapper.unmount()
    hold.resolve(customerContext())
    await flushPromises()
    expect(request).not.toHaveBeenCalled()
  })
})

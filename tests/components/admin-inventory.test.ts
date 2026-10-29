import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { defineComponent, h, proxyRefs, ref } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import InventoryOperations from '../../app/components/InventoryOperations.vue'
import '#app/nuxt-vitest-app-entry'

const { request } = vi.hoisted(() => ({ request: vi.fn() }))
mockNuxtImport('$fetch', () => request)
const ACTOR = '10000000-0000-4000-8000-000000000041',
  OTHER = '10000000-0000-4000-8000-000000000042',
  VARIANT = '40000000-0000-4000-8000-000000000041',
  PRODUCT = '30000000-0000-4000-8000-000000000041',
  PROPOSAL = '50000000-0000-4000-8000-000000000041'
const context = () => ({
  source: 'cloudflare',
  capabilities: {
    inventoryRead: true,
    inventoryReceipt: true,
    inventoryCountPropose: true,
    inventoryCountApprove: true
  },
  variant: {
    id: 11,
    uuid: VARIANT,
    productId: 1,
    productUuid: PRODUCT,
    sku: 'SKU-SYNTHETIC',
    format: 'Caja',
    status: 'draft',
    unitBase: 'ud',
    unitLabel: 'unidad'
  },
  warehouse: { id: 'main', code: 'MAIN', name: 'Synthetic warehouse' },
  balance: {
    physicalQuantity: 20,
    blockedQuantity: 1,
    safetyStock: 2,
    reservedQuantity: 8,
    sellableQuantity: 9,
    version: 1
  },
  reconciliation: {
    consistent: true,
    physicalLedgerQuantity: 20,
    reservedLedgerQuantity: 8,
    movementCount: 1,
    reservationExpiryPending: 1
  },
  ledger: {
    items: [
      {
        id: 'initial',
        type: 'initial',
        physicalDelta: 20,
        reservedDelta: 0,
        reason: null,
        reference: null,
        actorId: null,
        createdAt: '2026-10-01T00:00:00Z'
      }
    ],
    pagination: { page: 1, perPage: 25, total: 1, pages: 1 }
  },
  counts: {
    items: [
      {
        id: PROPOSAL,
        proposedBy: OTHER,
        expectedBalanceVersion: 1,
        countedPhysicalQuantity: 12,
        physicalDelta: -8,
        reason: 'Synthetic verified physical count',
        reference: 'COUNT-041',
        createdAt: '2026-10-01T00:00:00Z',
        approved: false,
        stale: false,
        canApprove: true
      }
    ],
    hasMore: false
  },
  evaluatedAt: '2026-10-01T00:00:00Z'
})
const receipt = (action = 'receipt') => ({
  source: 'cloudflare',
  action,
  commandId: '60000000-0000-4000-8000-000000000041',
  variantId: 11,
  variantUuid: VARIANT,
  warehouseId: 'main',
  balanceVersion: action === 'count_propose' ? 1 : 2,
  physicalQuantity: action === 'receipt' ? 25 : action === 'count_propose' ? 20 : 12,
  physicalDelta: action === 'receipt' ? 5 : action === 'count_propose' ? 0 : -8,
  proposedPhysicalDelta: action === 'count_propose' ? -8 : null,
  proposalId: action === 'receipt' ? null : PROPOSAL,
  updated: true
})
const Button = defineComponent({
  inheritAttrs: false,
  props: { loading: Boolean, disabled: Boolean },
  setup:
    (props, { attrs, slots }) =>
    () =>
      h(
        'button',
        { ...attrs, type: attrs.type ?? 'button', disabled: props.loading || props.disabled },
        slots.default?.()
      )
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
  const wrapper = await mountSuspended(InventoryOperations, {
    props: {
      snapshot: data.value,
      operatorId: ACTOR,
      runtime: 'cloudflare',
      authorize: () => authority.value,
      reload,
      ...overrides
    },
    global: { stubs: { UButton: Button } }
  })
  // Nuxt's independent session bootstrap may use the same auto-import mock.
  // Finish it before counting this component's own operational requests.
  await flushPromises()
  request.mockClear()
  mounted.push(wrapper)
  return { wrapper, authority, data, reload }
}
async function fillReceipt(wrapper: Awaited<ReturnType<typeof render>>['wrapper']) {
  await wrapper.get('[data-testid="receipt-quantity"]').setValue('5')
  await wrapper.get('[data-testid="inventory-reference"]').setValue('DELIVERY-041')
  await wrapper.get('[data-testid="inventory-reason"]').setValue('Synthetic documented stock receipt')
  await wrapper.get('[data-testid="prepare-receipt"]').trigger('submit')
  await flushPromises()
}
describe('governed inventory UI with fresh authority and exact retries', () => {
  it('classifies real ofetch 409 through response hook without accessing FetchError.data', async () => {
    const { wrapper } = await render()
    await fillReceipt(wrapper)
    let getterCalls = 0
    request.mockImplementationOnce(
      async (_path: string, options: { onResponseError: (context: unknown) => void; retry: number }) => {
        expect(options.retry).toBe(0)
        const response = new Response(null, { status: 409 })
        Object.defineProperty(response, '_data', { value: { error: { code: 'version_conflict' } }, enumerable: true })
        options.onResponseError({ response })
        const failure = Object.create({
          get data() {
            getterCalls++
            return { error: { code: 'version_conflict' } }
          }
        })
        throw failure
      }
    )
    await wrapper.get('[data-testid="confirm-inventory"]').trigger('click')
    await flushPromises()
    expect(getterCalls).toBe(0)
    expect(wrapper.find('[data-testid="retry-inventory"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="confirm-inventory"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('La operación se ha rechazado')
    expect(wrapper.find('[data-testid="prepare-receipt"]').exists()).toBe(false)
  })
  it('keeps response-hook 403 uncertain after the send without triggering getters', async () => {
    const { wrapper } = await render()
    await fillReceipt(wrapper)
    request.mockImplementationOnce(async (_path: string, options: { onResponseError: (context: unknown) => void }) => {
      options.onResponseError({ response: { status: 403, _data: { error: { code: 'forbidden' } } } })
      throw Object.create({
        get data() {
          throw new Error('getter_must_not_run')
        }
      })
    })
    await wrapper.get('[data-testid="confirm-inventory"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="retry-inventory"]').exists()).toBe(true)
  })
  it('does not dispatch after unmount while preflight GET is pending', async () => {
    const { wrapper, reload } = await render()
    await fillReceipt(wrapper)
    let resolve: ((value: ReturnType<typeof context>) => void) | undefined
    reload.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done
        })
    )
    await wrapper.get('[data-testid="confirm-inventory"]').trigger('click')
    wrapper.unmount()
    resolve!(context())
    await flushPromises()
    expect(request).not.toHaveBeenCalled()
    expect(wrapper.emitted('confirmed')).toBeUndefined()
  })
  it('ignores postwrite completion after unmount without refresh/emit/notices', async () => {
    const { wrapper, reload } = await render()
    await fillReceipt(wrapper)
    let resolve: ((value: ReturnType<typeof receipt>) => void) | undefined
    request.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done
        })
    )
    await wrapper.get('[data-testid="confirm-inventory"]').trigger('click')
    await flushPromises()
    expect(request).toHaveBeenCalledTimes(1)
    wrapper.unmount()
    resolve!(receipt())
    await flushPromises()
    expect(reload).toHaveBeenCalledTimes(1)
    expect(wrapper.emitted('confirmed')).toBeUndefined()
  })
  it('preserves the original retry when authorization is denied after a possibly committed POST', async () => {
    const { wrapper, data } = await render()
    await fillReceipt(wrapper)
    request.mockRejectedValueOnce({ data: { error: { code: 'forbidden' } } }).mockResolvedValueOnce(receipt())
    await wrapper.get('[data-testid="confirm-inventory"]').trigger('click')
    await flushPromises()
    const first = request.mock.calls[0]!
    expect(wrapper.find('[data-testid="retry-inventory"]').exists()).toBe(true)
    data.value.balance.version = 3
    await wrapper.get('[data-testid="retry-inventory"]').trigger('click')
    await flushPromises()
    expect(request.mock.calls[1]).toEqual([first[0], { ...first[1], onResponseError: expect.any(Function) }])
  })
  it('does not leave old balances operable after an ambiguous POST/read failure', async () => {
    const { wrapper } = await render()
    await fillReceipt(wrapper)
    request.mockRejectedValueOnce(new Error('lost response'))
    await wrapper.get('[data-testid="confirm-inventory"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="prepare-receipt"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="retry-inventory"]').exists()).toBe(true)
    expect(wrapper.emitted('pending')?.at(-1)).toEqual([true])
  })
  it('shows source balances, pending expired commitments and unknown historical actor honestly', async () => {
    const { wrapper } = await render()
    expect(wrapper.text()).toContain('reservas vencidas pendientes de liberar')
    expect(wrapper.text()).toContain('Movimiento histórico: actor no documentado')
    expect(wrapper.text()).toContain('doble control')
    expect(wrapper.text()).not.toContain('Admin catálogo')
  })
  it('requires separate review/confirmation and checks current server authority before writing', async () => {
    const { wrapper, reload } = await render()
    request.mockResolvedValue(receipt())
    await fillReceipt(wrapper)
    expect(request).not.toHaveBeenCalled()
    expect(wrapper.find('[data-testid="confirm-inventory"]').exists()).toBe(true)
    await wrapper.get('[data-testid="confirm-inventory"]').trigger('click')
    await flushPromises()
    expect(reload).toHaveBeenCalledTimes(2)
    expect(request).toHaveBeenCalledTimes(1)
    expect(request.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      body: {
        expectedBalanceVersion: 1,
        quantity: 5,
        reason: 'Synthetic documented stock receipt',
        reference: 'DELIVERY-041'
      }
    })
    expect(wrapper.text()).toContain('Movimiento confirmado y auditado')
  })
  it.each(['0', '-1', '1.2', '01', '1e3', '9007199254740992'])(
    'blocks invalid base-unit quantity %s',
    async (quantity) => {
      const fresh = await render()
      await fresh.wrapper.get('[data-testid="receipt-quantity"]').setValue(quantity)
      await fresh.wrapper.get('[data-testid="inventory-reference"]').setValue('DELIVERY-041')
      await fresh.wrapper.get('[data-testid="inventory-reason"]').setValue('Synthetic documented stock receipt')
      await fresh.wrapper.get('[data-testid="prepare-receipt"]').trigger('submit')
      await flushPromises()
      expect(fresh.wrapper.find('[data-testid="confirm-inventory"]').exists()).toBe(false)
      expect(request).not.toHaveBeenCalled()
    }
  )
  it('blocks revoked authority during the awaited fresh GET', async () => {
    const { wrapper, authority, reload } = await render()
    await fillReceipt(wrapper)
    reload.mockImplementation(async () => {
      authority.value = false
      return context()
    })
    await wrapper.get('[data-testid="confirm-inventory"]').trigger('click')
    await flushPromises()
    expect(request).not.toHaveBeenCalled()
    expect(wrapper.emitted('confirmed')).toBeUndefined()
  })
  it('blocks references/capabilities that drift without relying on cached computed state', async () => {
    const { wrapper, data } = await render()
    await fillReceipt(wrapper)
    data.value.capabilities.inventoryReceipt = false
    await wrapper.get('[data-testid="confirm-inventory"]').trigger('click')
    await flushPromises()
    expect(request).not.toHaveBeenCalled()
  })
  it('does not write a new intent against a stale balance version', async () => {
    const { wrapper, data } = await render()
    await fillReceipt(wrapper)
    data.value.balance.version = 2
    await wrapper.get('[data-testid="confirm-inventory"]').trigger('click')
    await flushPromises()
    expect(request).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('Las existencias han cambiado')
  })
  it('keeps original body/key after an ambiguous response, even if current version advanced', async () => {
    const { wrapper, data } = await render()
    await fillReceipt(wrapper)
    request.mockRejectedValueOnce(new Error('lost response')).mockResolvedValueOnce(receipt())
    await wrapper.get('[data-testid="confirm-inventory"]').trigger('click')
    await flushPromises()
    const first = request.mock.calls[0]!
    data.value.balance.version = 7
    data.value.balance.physicalQuantity = 45
    await wrapper.get('[data-testid="retry-inventory"]').trigger('click')
    await flushPromises()
    expect(request.mock.calls[1]?.[0]).toBe(first[0])
    expect(request.mock.calls[1]?.[1]).toEqual({ ...first[1], onResponseError: expect.any(Function) })
    expect(wrapper.emitted('confirmed')).toHaveLength(1)
  })
  it('does not transfer a frozen intent to another identity', async () => {
    const { wrapper } = await render()
    await fillReceipt(wrapper)
    request.mockRejectedValueOnce(new Error('lost response'))
    await wrapper.get('[data-testid="confirm-inventory"]').trigger('click')
    await flushPromises()
    await wrapper.setProps({ operatorId: OTHER })
    expect(wrapper.find('[data-testid="retry-inventory"]').exists()).toBe(false)
    expect(proxyRefs(wrapper.setupState).intent).toBeNull()
    await flushPromises()
    expect(request).toHaveBeenCalledTimes(1)
  })
  it('does not invent success for malformed/other-variant provider receipts', async () => {
    const { wrapper } = await render()
    await fillReceipt(wrapper)
    request.mockResolvedValue({ ...receipt(), variantUuid: PRODUCT })
    await wrapper.get('[data-testid="confirm-inventory"]').trigger('click')
    await flushPromises()
    expect(wrapper.emitted('confirmed')).toBeUndefined()
    expect(wrapper.find('[data-testid="retry-inventory"]').exists()).toBe(true)
  })
  it('records count preview with no physical delta and asks independent approval', async () => {
    const { wrapper } = await render()
    await wrapper.get('[data-testid="count-quantity"]').setValue('12')
    await wrapper.get('[data-testid="inventory-reference"]').setValue('COUNT-041')
    await wrapper.get('[data-testid="inventory-reason"]').setValue('Synthetic documented physical count')
    await wrapper.get('[data-testid="prepare-count"]').trigger('submit')
    await flushPromises()
    expect(request).not.toHaveBeenCalled()
    request.mockResolvedValue(receipt('count_propose'))
    await wrapper.get('[data-testid="confirm-inventory"]').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('No se ha cambiado el stock')
  })
  it('protects blocked/persisted reservations in count preview, including expired TTL', async () => {
    const { wrapper } = await render()
    await wrapper.get('[data-testid="count-quantity"]').setValue('8')
    await wrapper.get('[data-testid="inventory-reference"]').setValue('COUNT-041')
    await wrapper.get('[data-testid="inventory-reason"]').setValue('Synthetic documented physical count')
    await wrapper.get('[data-testid="prepare-count"]').trigger('submit')
    await flushPromises()
    expect(wrapper.find('[data-testid="confirm-inventory"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('no puede consumir unidades bloqueadas')
  })
  it('requires distinct independent actor and original proposal identity for approval', async () => {
    const { wrapper } = await render()
    await wrapper.get('[data-testid="select-count"]').trigger('click')
    await wrapper.get('[data-testid="approval-reason"]').setValue('Independent synthetic physical verification')
    await wrapper.get('[data-testid="prepare-approval"]').trigger('submit')
    await flushPromises()
    request.mockResolvedValue(receipt('count_approve'))
    await wrapper.get('[data-testid="confirm-inventory"]').trigger('click')
    await flushPromises()
    expect(request.mock.calls[0]?.[0]).toBe(`/api/admin/inventory/variants/11/counts/${PROPOSAL}/approve`)
    expect(request.mock.calls[0]?.[1].body).toEqual({
      expectedBalanceVersion: 1,
      reason: 'Independent synthetic physical verification'
    })
  })
  it('does not offer approval of own proposal even with a corrupted true flag', async () => {
    const data = context()
    data.counts.items[0]!.proposedBy = ACTOR
    const { wrapper } = await render({ snapshot: data })
    await wrapper.get('[data-testid="select-count"]').trigger('click')
    await wrapper.get('[data-testid="approval-reason"]').setValue('Independent synthetic physical verification')
    await wrapper.get('[data-testid="prepare-approval"]').trigger('submit')
    await flushPromises()
    expect(wrapper.find('[data-testid="confirm-inventory"]').exists()).toBe(false)
    expect(request).not.toHaveBeenCalled()
  })
  it.each(['node', undefined, null])('does not offer writes in unsupported runtime %s', async (runtime) => {
    const { wrapper } = await render({ runtime })
    expect(wrapper.find('[data-testid="prepare-receipt"]').exists()).toBe(false)
  })
})

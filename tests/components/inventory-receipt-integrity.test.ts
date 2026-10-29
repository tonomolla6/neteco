import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { defineComponent, h, proxyRefs } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import InventoryOperations from '../../app/components/InventoryOperations.vue'
import type { AdminInventoryVariant } from '../../shared/inventory-commands'
import '#app/nuxt-vitest-app-entry'

const mocks = vi.hoisted(() => ({ request: vi.fn() }))
mockNuxtImport('$fetch', () => mocks.request)
const ACTOR = '91000000-0000-4000-8000-000000000001'
const VARIANT = '92000000-0000-4000-8000-000000000001'
const PROPOSAL = '93000000-0000-4000-8000-000000000001'
const Button = defineComponent({
  props: { disabled: Boolean, loading: Boolean },
  setup:
    (props, { attrs, slots }) =>
    () =>
      h('button', { ...attrs, disabled: props.disabled || props.loading }, slots.default?.())
})
function context(): AdminInventoryVariant {
  return {
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
      productUuid: '94000000-0000-4000-8000-000000000001',
      sku: 'SKU-SYNTHETIC',
      format: 'Caja',
      status: 'draft',
      unitBase: 'ud',
      unitLabel: 'unidad'
    },
    warehouse: { id: 'main', code: 'MAIN', name: 'Almacén sintético' },
    balance: {
      physicalQuantity: 20,
      blockedQuantity: 0,
      safetyStock: 2,
      reservedQuantity: 0,
      sellableQuantity: 18,
      version: 1
    },
    reconciliation: {
      consistent: true,
      physicalLedgerQuantity: 20,
      reservedLedgerQuantity: 0,
      movementCount: 1,
      reservationExpiryPending: 0
    },
    ledger: { items: [], pagination: { page: 1, perPage: 25, total: 0, pages: 0 } },
    counts: {
      items: [
        {
          id: PROPOSAL,
          proposedBy: '91000000-0000-4000-8000-000000000002',
          expectedBalanceVersion: 1,
          countedPhysicalQuantity: 12,
          physicalDelta: -8,
          reason: 'Recuento sintético documentado',
          reference: 'COUNT-001',
          createdAt: '2026-10-08T10:00:00Z',
          approved: false,
          stale: false,
          canApprove: true
        }
      ],
      hasMore: false
    },
    evaluatedAt: '2026-10-08T10:00:00Z'
  }
}
function receipt(action: 'receipt' | 'count_propose' | 'count_approve') {
  return {
    source: 'cloudflare',
    action,
    commandId: '95000000-0000-4000-8000-000000000001',
    variantId: 11,
    variantUuid: VARIANT,
    warehouseId: 'main',
    balanceVersion: action === 'count_propose' ? 1 : 2,
    physicalQuantity: action === 'receipt' ? 25 : action === 'count_propose' ? 20 : 12,
    physicalDelta: action === 'receipt' ? 5 : action === 'count_propose' ? 0 : -8,
    proposedPhysicalDelta: action === 'count_propose' ? -8 : null,
    proposalId: action === 'receipt' ? null : PROPOSAL,
    updated: true
  }
}
let wrapper: Awaited<ReturnType<typeof mountSuspended>> | undefined
async function render(snapshot = context()) {
  const reload = vi.fn(async () => snapshot)
  wrapper = await mountSuspended(InventoryOperations, {
    props: {
      snapshot,
      operatorId: ACTOR,
      runtime: 'cloudflare',
      authorize: () => true,
      reload,
      scopeKey: 'identity/session/1'
    },
    global: { stubs: { UButton: Button } }
  })
  await flushPromises()
  mocks.request.mockClear()
  return { page: wrapper, reload }
}
async function prepare(action: 'receipt' | 'count_propose' | 'count_approve') {
  if (action === 'count_approve') {
    await wrapper!.get('[data-testid="select-count"]').trigger('click')
    await wrapper!.get('[data-testid="approval-reason"]').setValue('Comprobación sintética independiente')
    await wrapper!.get('[data-testid="prepare-approval"]').trigger('submit')
  } else {
    await wrapper!.get('[data-testid="inventory-reference"]').setValue('REFERENCE-001')
    await wrapper!.get('[data-testid="inventory-reason"]').setValue('Operación sintética documentada')
    await wrapper!
      .get(action === 'receipt' ? '[data-testid="receipt-quantity"]' : '[data-testid="count-quantity"]')
      .setValue(action === 'receipt' ? '5' : '12')
    await wrapper!
      .get(action === 'receipt' ? '[data-testid="prepare-receipt"]' : '[data-testid="prepare-count"]')
      .trigger('submit')
  }
  await flushPromises()
}
afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  mocks.request.mockReset()
})

describe('single-warehouse inventory receipt integrity and lifecycle', () => {
  it.each(['receipt', 'count_propose', 'count_approve'] as const)(
    'rejects wrong warehouse for %s instead of confirming an unrelated effect',
    async (action) => {
      await render()
      await prepare(action)
      mocks.request.mockResolvedValue({ ...receipt(action), warehouseId: 'other' })
      await wrapper!.get('[data-testid="confirm-inventory"]').trigger('click')
      await flushPromises()
      expect(wrapper!.emitted('confirmed')).toBeUndefined()
      expect(wrapper!.find('[data-testid="retry-inventory"]').exists()).toBe(true)
    }
  )
  it.each(['receipt', 'count_propose', 'count_approve'] as const)(
    'rejects inconsistent physical quantity for %s',
    async (action) => {
      await render()
      await prepare(action)
      const changed = { ...receipt(action), physicalQuantity: 999 }
      if (action === 'count_propose') changed.proposedPhysicalDelta = 12 - 999
      mocks.request.mockResolvedValue(changed)
      await wrapper!.get('[data-testid="confirm-inventory"]').trigger('click')
      await flushPromises()
      expect(wrapper!.emitted('confirmed')).toBeUndefined()
      expect(wrapper!.find('[data-testid="retry-inventory"]').exists()).toBe(true)
    }
  )
  it('rejects an approval delta inconsistent with the reviewed independent count', async () => {
    await render()
    await prepare('count_approve')
    mocks.request.mockResolvedValue({ ...receipt('count_approve'), physicalDelta: -1 })
    await wrapper!.get('[data-testid="confirm-inventory"]').trigger('click')
    await flushPromises()
    expect(wrapper!.emitted('confirmed')).toBeUndefined()
  })
  it('purges an unsent intent and operator drafts when the session scope changes', async () => {
    await render()
    await prepare('receipt')
    expect(wrapper!.find('[data-testid="confirm-inventory"]').exists()).toBe(true)
    await wrapper!.setProps({ scopeKey: 'identity/session/2' })
    const state = proxyRefs(wrapper!.setupState)
    expect(state.intent).toBeNull()
    expect(state.reason).toBe('')
    expect(state.reference).toBe('')
    expect(wrapper!.emitted('pending')?.at(-1)).toEqual([false])
    expect(mocks.request).not.toHaveBeenCalled()
  })
  it('purges drafts and intent on unmount', async () => {
    await render()
    await prepare('receipt')
    const state = proxyRefs(wrapper!.setupState)
    wrapper!.unmount()
    wrapper = undefined
    expect(state.intent).toBeNull()
    expect(state.quantity).toBe('')
    expect(state.reason).toBe('')
  })
  it.each(['rate_limited', 'version_conflict', 'not_found'])(
    'retains an uncertain committed intent when its explicit replay returns %s',
    async (code) => {
      await render()
      await prepare('receipt')
      mocks.request
        .mockRejectedValueOnce(new Error('Synthetic response lost after possible commit'))
        .mockRejectedValueOnce({
          statusCode: code === 'rate_limited' ? 429 : code === 'not_found' ? 404 : 409,
          data: { error: { code } }
        })
        .mockResolvedValueOnce(receipt('receipt'))

      await wrapper!.get('[data-testid="confirm-inventory"]').trigger('click')
      await flushPromises()
      const original = mocks.request.mock.calls[0]!
      expect(mocks.request).toHaveBeenCalledTimes(1)

      await wrapper!.get('[data-testid="retry-inventory"]').trigger('click')
      await flushPromises()
      expect(mocks.request).toHaveBeenCalledTimes(2)
      expect(wrapper!.emitted('confirmed')).toBeUndefined()
      expect(wrapper!.find('[data-testid="retry-inventory"]').exists()).toBe(true)
      expect(wrapper!.text()).not.toContain('La operación se ha rechazado')

      await wrapper!.get('[data-testid="retry-inventory"]').trigger('click')
      await flushPromises()
      expect(mocks.request).toHaveBeenCalledTimes(3)
      for (const call of mocks.request.mock.calls.slice(1)) {
        expect(call[0]).toBe(original[0])
        expect(call[1].headers['Idempotency-Key']).toBe(original[1].headers['Idempotency-Key'])
        expect(call[1].body).toBe(original[1].body)
        expect(call[1].retry).toBe(0)
      }
      expect(wrapper!.emitted('confirmed')).toEqual([[receipt('receipt')]])
    }
  )
  it('shows only data-derived zero-sellable and recorded safety-stock warnings', async () => {
    const snapshot = context()
    Object.assign(snapshot.balance, { physicalQuantity: 2, sellableQuantity: 0 })
    snapshot.reconciliation.physicalLedgerQuantity = 2
    await render(snapshot)
    expect(wrapper!.text()).toContain('No hay unidades vendibles')
    expect(wrapper!.text()).toContain('igual o inferior al stock de seguridad registrado')
    expect(mocks.request).not.toHaveBeenCalled()
  })
})

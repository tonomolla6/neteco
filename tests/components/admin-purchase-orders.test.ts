import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import AdminPurchaseOrders from '../../app/components/AdminPurchaseOrders.vue'
import '#app/nuxt-vitest-app-entry'

const mocks = vi.hoisted(() => ({ request: vi.fn() }))
mockNuxtImport('useRequestFetch', () => () => mocks.request)

const sampleOrders = [
  {
    id: '44444444-4444-4444-8444-444444444444',
    poNumber: 'PO-2026-001',
    supplierName: 'Química Industrial del Norte',
    status: 'draft',
    currency: 'EUR',
    totalCostCents: 125000,
    expectedUnits: 50,
    receivedUnits: 0,
    hasDiscrepancy: false,
    version: 1
  }
]

const apiError = (code: string) => Object.assign(new Error(code), { data: { error: { code } } })

const mount = async () => {
  const wrapper = await mountSuspended(AdminPurchaseOrders)
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  mocks.request.mockReset()
})

describe('AdminPurchaseOrders (INV-016)', () => {
  it('loads and displays purchase orders list', async () => {
    mocks.request.mockResolvedValueOnce({ items: sampleOrders })
    const wrapper = await mount()

    expect(wrapper.text()).toContain('Pedidos de compra a proveedores')
    expect(wrapper.text()).toContain('PO-2026-001')
    expect(wrapper.text()).toContain('Química Industrial del Norte')
    expect(wrapper.text()).toContain('1250,00')
  })

  it('shows error state when load fails', async () => {
    mocks.request.mockRejectedValueOnce(apiError('forbidden'))
    const wrapper = await mount()

    expect(wrapper.find('[role="alert"]').text()).toContain('forbidden')
  })

  it('creates a new purchase order successfully', async () => {
    mocks.request.mockResolvedValueOnce({ items: sampleOrders })
    const wrapper = await mount()

    mocks.request
      .mockResolvedValueOnce({
        commandId: 'cmd-po-create',
        action: 'create_purchase_order',
        targetId: '55555555-5555-4555-8555-555555555555',
        resultVersion: 1
      })
      .mockResolvedValueOnce({
        items: [
          ...sampleOrders,
          {
            id: '55555555-5555-4555-8555-555555555555',
            poNumber: 'PO-2026-002',
            supplierName: 'Distribuciones Químicas SL',
            status: 'draft',
            currency: 'EUR',
            totalCostCents: 60000,
            expectedUnits: 20,
            receivedUnits: 0,
            hasDiscrepancy: false,
            version: 1
          }
        ]
      })

    await wrapper.find('[data-test="po-number"]').setValue('PO-2026-002')
    await wrapper.find('[data-test="supplier-id"]').setValue('11111111-1111-4111-8111-111111111111')
    await wrapper.find('[data-test="line-variant-id"]').setValue('22222222-2222-4222-8222-222222222222')
    await wrapper.find('[data-test="line-quantity"]').setValue(20)
    await wrapper.find('[data-test="line-unit-cost"]').setValue(3000)
    await wrapper.find('[data-test="submit-po-btn"]').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-test="success-banner"]').text()).toContain('creado con éxito')
  })
})

import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import AdminOrderProcurementPanel from '../../app/components/AdminOrderProcurementPanel.vue'
import '#app/nuxt-vitest-app-entry'

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }))
mockNuxtImport('useRequestFetch', () => () => fetchMock)
mockNuxtImport('$fetch', () => fetchMock)

const sampleProcurement = {
  orderId: '33333333-3333-4333-8333-333333333333',
  purchaseOrderReference: 'PO-HOSPITAL-2026',
  costCenter: 'CC-QUIRURGICO-01',
  approvalStatus: 'pending_approval',
  requiresApproval: true,
  approvalThresholdCents: 150000,
  approvedBy: null,
  approvedAt: null,
  rejectedBy: null,
  rejectedAt: null,
  rejectionReason: null,
  approvalNotes: null,
  version: 1,
  events: [
    {
      id: 'evt-1',
      eventType: 'approval_requested',
      actorId: 'system',
      actorType: 'system',
      notes: 'Supera el umbral de 1500.00 EUR',
      createdAt: '2026-10-31T08:00:00Z'
    }
  ]
}

describe('AdminOrderProcurementPanel component', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('renders loading state before procurement details arrive', async () => {
    fetchMock.mockReturnValue(new Promise(() => {}))
    const wrapper = await mountSuspended(AdminOrderProcurementPanel, {
      props: { orderId: '33333333-3333-4333-8333-333333333333' }
    })
    expect(wrapper.text()).toContain('Cargando datos de compras...')
  })

  it('renders PO reference, cost center, and pending approval badge', async () => {
    fetchMock.mockResolvedValueOnce(sampleProcurement)
    const wrapper = await mountSuspended(AdminOrderProcurementPanel, {
      props: { orderId: '33333333-3333-4333-8333-333333333333' }
    })
    await flushPromises()

    expect(wrapper.text()).toContain('PO-HOSPITAL-2026')
    expect(wrapper.text()).toContain('CC-QUIRURGICO-01')
    expect(wrapper.text()).toContain('Pendiente de aprobación')
    expect(wrapper.find('[data-testid="approve-btn"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="reject-btn"]').exists()).toBe(true)
  })

  it('calls approval endpoint when approve button is clicked', async () => {
    fetchMock.mockResolvedValueOnce(sampleProcurement)
    fetchMock.mockResolvedValueOnce({
      ...sampleProcurement,
      approvalStatus: 'approved',
      version: 2
    })

    const wrapper = await mountSuspended(AdminOrderProcurementPanel, {
      props: { orderId: '33333333-3333-4333-8333-333333333333' }
    })
    await flushPromises()

    await wrapper.find('[data-testid="approve-btn"]').trigger('click')
    await flushPromises()

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/admin/orders/procurement/approve',
      expect.objectContaining({
        method: 'POST'
      })
    )
  })
})

import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import AdminSplitShipmentsPanel from '../../app/components/AdminSplitShipmentsPanel.vue'
import '#app/nuxt-vitest-app-entry'

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }))
mockNuxtImport('useRequestFetch', () => () => fetchMock)
mockNuxtImport('$fetch', () => fetchMock)

const sampleSplitData = {
  preferences: {
    customerAcceptsSplit: true,
    acceptedExtraShippingCents: 450,
    shippingCostPayer: 'customer',
    customerConsentAt: '2026-10-31T08:00:00Z'
  },
  shipments: [
    {
      id: 'ship-imm-01',
      shipmentNumber: 1,
      shipmentType: 'immediate',
      status: 'pending',
      trackingNumber: 'TRK-IMM-001',
      carrier: 'Correos Express',
      items: [{ lineIndex: 0, sku: 'SKU-01', quantityAllocated: 5, quantityBackordered: 0 }]
    },
    {
      id: 'ship-bck-02',
      shipmentNumber: 2,
      shipmentType: 'backorder',
      status: 'pending',
      estimatedRestockAt: '2026-11-20T00:00:00Z',
      items: [{ lineIndex: 1, sku: 'SKU-02', quantityAllocated: 0, quantityBackordered: 3 }]
    }
  ],
  billing: {
    totalBilledCents: 22835,
    expectedTotalCents: 22835,
    isFullyReconciled: true,
    discrepancyCents: 0
  }
}

describe('AdminSplitShipmentsPanel component', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('renders loading state before shipments arrive', async () => {
    fetchMock.mockReturnValue(new Promise(() => {}))
    const wrapper = await mountSuspended(AdminSplitShipmentsPanel, {
      props: { orderId: '44444444-4444-4444-8444-444444444444' }
    })
    expect(wrapper.text()).toContain('Cargando envíos parciales...')
  })

  it('renders split consent, immediate shipment and backorder shipment', async () => {
    fetchMock.mockResolvedValueOnce(sampleSplitData)
    const wrapper = await mountSuspended(AdminSplitShipmentsPanel, {
      props: { orderId: '44444444-4444-4444-8444-444444444444' }
    })
    await flushPromises()

    expect(wrapper.text()).toContain('Envío parcial aceptado por el cliente')
    expect(wrapper.text()).toContain('Envío inmediato')
    expect(wrapper.text()).toContain('Envío pendiente / Backorder')
    expect(wrapper.text()).toContain('Facturación totalmente conciliada')
  })
})

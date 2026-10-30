import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AdminWarehouseScanPanel from '../../app/components/AdminWarehouseScanPanel.vue'
import '#app/nuxt-vitest-app-entry'

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }))
mockNuxtImport('useRequestFetch', () => () => fetchMock)
mockNuxtImport('$fetch', () => fetchMock)

const sampleQueues = {
  reception: [
    {
      queueType: 'reception',
      id: 'REC-001',
      referenceCode: 'ALB-2026-1101',
      priority: 'high',
      status: 'pending',
      itemsTotal: 1,
      itemsScanned: 0,
      items: [
        {
          sku: 'DES-100',
          barcode: '8437001234567',
          name: 'Desinfectante Clorado 5L',
          expectedQty: 20,
          scannedQty: 0,
          location: 'B-02-14'
        }
      ],
      updatedAt: '2026-10-29T10:00:00Z'
    }
  ],
  picking: [],
  packing: [],
  exceptions: [
    {
      id: 'EXC-001',
      targetType: 'order',
      targetId: 'ORD-991',
      exceptionType: 'damaged_item',
      reason: 'Envase roto por impacto en horquilla',
      severity: 'high',
      status: 'open',
      createdAt: '2026-10-29T11:00:00Z'
    }
  ]
}

const sampleMetrics = {
  queueCounts: { reception: 1, picking: 0, packing: 0, exceptions: 1 },
  dailyStats: {
    itemsScannedToday: 142,
    ordersCompletedToday: 18,
    exceptionsRaisedToday: 2,
    avgPickMinutes: 4.5,
    avgPackMinutes: 2.1
  },
  activeOperatorsCount: 3,
  printers: [{ id: 'zebra-01', name: 'Zebra ZT411 Picking', status: 'online' }]
}

describe('ADM-031: AdminWarehouseScanPanel Component', () => {
  let wrappers: Array<{ unmount(): void }> = []

  beforeEach(() => {
    fetchMock.mockReset()
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/api/admin/warehouse/metrics')) return sampleMetrics
      if (url.includes('/api/admin/warehouse/printers')) return sampleMetrics.printers
      return sampleQueues
    })
  })

  afterEach(() => {
    wrappers.forEach((w) => w.unmount())
    wrappers = []
  })

  it('renders warehouse scan panel with queue tabs, metrics cards, and barcode input', async () => {
    const wrapper = await mountSuspended(AdminWarehouseScanPanel)
    wrappers.push(wrapper)
    await flushPromises()

    expect(wrapper.text()).toContain('Panel de Almacén — Modo Escaneo')
    expect(wrapper.find('[data-testid="input-barcode-scanner"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="queue-tab-reception"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="queue-tab-picking"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="queue-tab-packing"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="queue-tab-exceptions"]').exists()).toBe(true)
  })

  it('displays active operational metrics', async () => {
    const wrapper = await mountSuspended(AdminWarehouseScanPanel)
    wrappers.push(wrapper)
    await flushPromises()

    expect(wrapper.find('[data-testid="metric-scanned-today"]').text()).toContain('142')
    expect(wrapper.find('[data-testid="metric-avg-pick"]').text()).toContain('4.5')
  })

  it('displays exception item and triggers exception resolution modal', async () => {
    const wrapper = await mountSuspended(AdminWarehouseScanPanel)
    wrappers.push(wrapper)
    await flushPromises()

    // Switch to exceptions tab
    await wrapper.find('[data-testid="queue-tab-exceptions"]').trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('Envase roto por impacto')
    expect(wrapper.find('[data-testid="btn-resolve-exception-EXC-001"]').exists()).toBe(true)
  })
})

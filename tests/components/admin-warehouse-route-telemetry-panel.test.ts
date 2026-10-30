import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import AdminWarehouseRouteTelemetryPanel from '../../app/components/AdminWarehouseRouteTelemetryPanel.vue'
import '#app/nuxt-vitest-app-entry'

const mocks = vi.hoisted(() => ({ request: vi.fn() }))
mockNuxtImport('useRequestFetch', () => () => mocks.request)

const mockDevices = [
  {
    deviceId: 'rf-scanner-01',
    deviceType: 'rf_scanner',
    batteryPercent: 92,
    appVersion: 'v2.4.1',
    syncLatencyMs: 25,
    offlineQueueDepth: 0,
    errorCount24h: 0,
    status: 'online',
    lastHeartbeatAt: '2026-10-29T14:00:00Z'
  }
]

const mockAggregate = {
  id: 'agg-1',
  periodDate: '2026-10-29',
  shiftCode: 'morning',
  zoneCode: 'chemicals_bulk',
  avgPickRatePerHour: 55.4,
  pickErrorRateBasisPoints: 12,
  dockToStockMinutes: 18.2,
  packingParcelsPerHour: 42.0,
  onTimeDeliveryRatio: 0.985,
  damagesCount: 0,
  warehouseCapacityPercent: 78.5,
  vehicleCapacityPercent: 82.0,
  healthyDevicesRatio: 1.0,
  laborPrivacyReviewed: true,
  computedAt: '2026-10-29T14:00:00Z',
  computedBy: '10000000-0000-4000-8000-000000000001'
}

describe('AdminWarehouseRouteTelemetryPanel', () => {
  beforeEach(() => mocks.request.mockReset())

  it('renders labor privacy compliance notice and the 8 operational facets', async () => {
    mocks.request.mockImplementation(async (url?: string) => {
      if (String(url ?? '').includes('/devices')) return { devices: mockDevices }
      if (String(url ?? '').includes('/aggregates')) return { aggregate: mockAggregate }
      return {}
    })

    const wrapper = await mountSuspended(AdminWarehouseRouteTelemetryPanel)
    await flushPromises()

    // Verifies labor privacy notice (art. 20 bis ET, LOPDGDD)
    expect(wrapper.find('[data-labor-privacy-notice]').exists()).toBe(true)
    expect(wrapper.text()).toContain('Privacidad Laboral')
    expect(wrapper.text()).toContain('Art. 20 bis ET')

    // Verifies 8 facets displayed
    expect(wrapper.text()).toContain('55.4') // pick rate
    expect(wrapper.text()).toContain('18.2') // dock to stock
    expect(wrapper.text()).toContain('42') // packing
    expect(wrapper.text()).toContain('98.5%') // on time
    expect(wrapper.text()).toContain('78.5%') // warehouse capacity
    expect(wrapper.text()).toContain('82%') // vehicle capacity

    // Verifies device in fleet table
    expect(wrapper.text()).toContain('rf-scanner-01')
    expect(wrapper.text()).toContain('92%')
  })
})

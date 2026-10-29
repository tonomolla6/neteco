import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import InventoryLotsCostingForecastPanel from '../../app/components/InventoryLotsCostingForecastPanel.vue'

const mocks = vi.hoisted(() => ({
  request: vi.fn()
}))
mockNuxtImport('$fetch', () => mocks.request)

const VARIANT_UUID = '40000000-0000-4000-8000-000000000041'
const LOT_ID = '70000000-0000-4000-8000-000000000001'

function sampleLots() {
  return {
    items: [
      {
        id: LOT_ID,
        variantId: VARIANT_UUID,
        lotNumber: 'BATCH-2026-01',
        locationId: 'main',
        status: 'active',
        manufacturedAt: '2026-01-01T00:00:00Z',
        expiresAt: '2027-01-01T00:00:00Z',
        initialQuantity: 100,
        availableQuantity: 80,
        version: 1,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z'
      }
    ]
  }
}

function sampleMargin() {
  return {
    source: 'cloudflare',
    variantId: VARIANT_UUID,
    periodStart: '2026-01-01T00:00:00Z',
    periodEnd: '2026-12-31T23:59:59Z',
    totalUnitsSold: 50,
    totalRevenueNetCents: 50000,
    totalCogsCents: 30000,
    analyticalGrossMarginCents: 20000,
    analyticalGrossMarginBasisPoints: 4000,
    financialSourceRevenueNetCents: 50000,
    discrepancyCents: 0,
    reconciliationStatus: 'reconciled',
    consumptions: []
  }
}

function sampleSuggestions() {
  return {
    items: [
      {
        id: 'sugg-1',
        variantId: VARIANT_UUID,
        locationId: 'main',
        status: 'suggested',
        currentPhysicalStock: 10,
        safetyStock: 5,
        forecastedDailyDemand: 2.5,
        leadTimeDays: 7,
        suggestedQuantity: 30,
        suggestedReorderDate: '2026-10-29T12:00:00Z',
        reason: 'Stock bajo punto de reorden',
        createdAt: '2026-10-29T12:00:00Z'
      }
    ]
  }
}

function sampleAnomalies() {
  return {
    items: [
      {
        id: 'anom-1',
        variantId: VARIANT_UUID,
        detectedAt: '2026-10-29T12:00:00Z',
        kind: 'spike',
        severity: 'critical',
        observedUnits: 50,
        expectedUnits: 5,
        zScore: 3.2,
        status: 'open',
        createdAt: '2026-10-29T12:00:00Z'
      }
    ]
  }
}

const mounted: Array<{ unmount(): void }> = []

beforeEach(() => {
  mocks.request.mockReset()
  mocks.request.mockImplementation(async (path: string) => {
    if (path.includes('/api/admin/inventory/lots/traceability')) {
      return {
        source: 'cloudflare',
        records: [
          {
            allocationId: 'alloc-1',
            lotId: LOT_ID,
            lotNumber: 'BATCH-2026-01',
            variantId: VARIANT_UUID,
            orderId: '50000000-0000-4000-8000-000000000001',
            orderLineIndex: 0,
            customerId: '60000000-0000-4000-8000-000000000001',
            customerEmail: 'cliente@example.invalid',
            quantity: 5,
            allocatedAt: '2026-10-15T00:00:00Z',
            lotStatus: 'active',
            expiresAt: '2027-01-01T00:00:00Z'
          }
        ],
        totalUnitsTraced: 5
      }
    }
    if (path.includes('/api/admin/inventory/lots')) return sampleLots()
    if (path.includes('/api/admin/inventory/costing/margin')) return sampleMargin()
    if (path.includes('/api/admin/inventory/forecast/suggestions')) return sampleSuggestions()
    if (path.includes('/api/admin/inventory/forecast/anomalies')) return sampleAnomalies()
    return {}
  })
})

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount()
})

describe('InventoryLotsCostingForecastPanel component', () => {
  it('renders all 3 main tabs: lotes, costes, and forecast', async () => {
    const wrapper = await mountSuspended(InventoryLotsCostingForecastPanel, {
      props: {
        scopeKey: 'test-scope',
        enabled: true,
        pending: false,
        selectedVariantUuid: VARIANT_UUID,
        selectedVariantId: 11
      }
    })
    mounted.push(wrapper)
    await flushPromises()

    expect(wrapper.find('[role="tablist"]').exists()).toBe(true)
    const tabs = wrapper.findAll('[role="tab"]')
    expect(tabs).toHaveLength(3)
    expect(tabs[0]!.text()).toContain('Lotes y FEFO')
    expect(tabs[1]!.text()).toContain('Costes y Margen')
    expect(tabs[2]!.text()).toContain('Previsión y Anomalías')
  })

  it('displays lots list and FEFO expiry status in lotes tab', async () => {
    const wrapper = await mountSuspended(InventoryLotsCostingForecastPanel, {
      props: {
        scopeKey: 'test-scope',
        enabled: true,
        pending: false,
        selectedVariantUuid: VARIANT_UUID,
        selectedVariantId: 11
      }
    })
    mounted.push(wrapper)
    await flushPromises()

    expect(wrapper.text()).toContain('BATCH-2026-01')
    expect(wrapper.text()).toContain('80')
    expect(wrapper.text()).toContain('active')
  })

  it('switches to Costes tab and displays margin and financial reconciliation', async () => {
    const wrapper = await mountSuspended(InventoryLotsCostingForecastPanel, {
      props: {
        scopeKey: 'test-scope',
        enabled: true,
        pending: false,
        selectedVariantUuid: VARIANT_UUID,
        selectedVariantId: 11
      }
    })
    mounted.push(wrapper)
    await flushPromises()

    const tabs = wrapper.findAll('[role="tab"]')
    await tabs[1]!.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('Margen analítico bruto')
    expect(wrapper.text()).toContain('Conciliado con fuente financiera')
  })

  it('switches to Forecast tab and displays non-destructive suggestion indicator', async () => {
    const wrapper = await mountSuspended(InventoryLotsCostingForecastPanel, {
      props: {
        scopeKey: 'test-scope',
        enabled: true,
        pending: false,
        selectedVariantUuid: VARIANT_UUID,
        selectedVariantId: 11
      }
    })
    mounted.push(wrapper)
    await flushPromises()

    const tabs = wrapper.findAll('[role="tab"]')
    await tabs[2]!.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('Sugerencias de reabastecimiento')
    expect(wrapper.text()).toContain('no automática')
    expect(wrapper.text()).toContain('Anomalías de demanda detectadas')
  })

  it('performs traceability search when searching lot number', async () => {
    const wrapper = await mountSuspended(InventoryLotsCostingForecastPanel, {
      props: {
        scopeKey: 'test-scope',
        enabled: true,
        pending: false,
        selectedVariantUuid: VARIANT_UUID,
        selectedVariantId: 11
      }
    })
    mounted.push(wrapper)
    await flushPromises()

    const traceInput = wrapper.find('input[placeholder="Nº de lote"]')
    await traceInput.setValue('BATCH-2026-01')
    const traceBtn = wrapper.find('button[data-testid="search-traceability"]')
    await traceBtn.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('cliente@example.invalid')
    expect(wrapper.text()).toContain('50000000-0000-4000-8000-000000000001')
  })

  it('displays empty state when variant has no lots', async () => {
    mocks.request.mockImplementation(async (path: string) => {
      if (path.includes('/api/admin/inventory/lots')) return { items: [] }
      return {}
    })
    const wrapper = await mountSuspended(InventoryLotsCostingForecastPanel, {
      props: {
        scopeKey: 'test-scope',
        enabled: true,
        pending: false,
        selectedVariantUuid: VARIANT_UUID,
        selectedVariantId: 11
      }
    })
    mounted.push(wrapper)
    await flushPromises()

    expect(wrapper.text()).toContain('No hay lotes registrados para esta variante.')
  })
})

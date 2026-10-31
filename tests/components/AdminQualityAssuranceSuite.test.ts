import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import AdminQualityAssuranceSuite from '../../app/components/AdminQualityAssuranceSuite.vue'
import '#app/nuxt-vitest-app-entry'

const mocks = vi.hoisted(() => ({ request: vi.fn() }))
mockNuxtImport('useRequestFetch', () => () => mocks.request)

const mockMatrixSummary = {
  totalCases: 18,
  passedCases: 18,
  failedCases: 0,
  executedAt: '2026-10-31T08:00:00Z',
  coverage: {
    combinations: '100%',
    margin: '100%',
    eligibility: '100%',
    frequency: '100%',
    consent: '100%',
    refund: '100%'
  }
}

const mockIsolationStatus = {
  singleSiteConfirmed: true,
  concurrentQueriesPass: true,
  dataIsolationEnforced: true,
  pricingIsolationEnforced: true,
  commercialConditionsEnforced: true,
  prohibitedHierarchiesBlocked: true
}

const mockWarehouseStatus = {
  scanOperationsActive: true,
  printersOnline: 2,
  reconnectionSyncActive: true,
  duplicateDetectionEnforced: true,
  lostDeviceQuarantineActive: true,
  reconciliationConsistent: true
}

describe('AdminQualityAssuranceSuite component (TST-041, TST-042, TST-043)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.request.mockImplementation(async (url: string) => {
      if (url === '/api/admin/qa/promotions-matrix') {
        return { success: true, summary: mockMatrixSummary }
      }
      if (url === '/api/admin/qa/account-isolation') {
        return { success: true, status: mockIsolationStatus }
      }
      if (url === '/api/admin/qa/warehouse-offline') {
        return { success: true, status: mockWarehouseStatus }
      }
      return { success: false }
    })
  })

  it('renders loading skeleton and then successfully displays all 3 requirement panels', async () => {
    const wrapper = await mountSuspended(AdminQualityAssuranceSuite)
    await flushPromises()

    expect(wrapper.text()).toContain('Suite de Garantía de Calidad y Tests')
    expect(wrapper.text()).toContain('TST-041: Promociones y Automatizaciones por Tabla')
    expect(wrapper.text()).toContain('TST-042: Aislamiento Particulares vs Empresas')
    expect(wrapper.text()).toContain('TST-043: Almacén, Ruta y Modo Offline')

    // Verify stats in TST-041
    expect(wrapper.text()).toContain('18 / 18')
    expect(wrapper.text()).toContain('100%')

    // Verify badges in TST-042
    expect(wrapper.text()).toContain('Monosede verificada')
    expect(wrapper.text()).toContain('Aislamiento de tarifas OK')

    // Verify badges in TST-043
    expect(wrapper.text()).toContain('Conciliación 100% coherente')
  })

  it('handles error state gracefully when API fails', async () => {
    mocks.request.mockRejectedValue(new Error('Network error loading QA status'))

    const wrapper = await mountSuspended(AdminQualityAssuranceSuite)
    await flushPromises()

    expect(wrapper.text()).toContain('Error al cargar métricas de calidad')
  })
})

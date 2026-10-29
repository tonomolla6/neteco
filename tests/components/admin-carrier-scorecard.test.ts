import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AdminCarrierScorecard from '../../app/components/AdminCarrierScorecard.vue'
import AdminCarrierScorecardPage from '../../app/pages/admin/transportistas.vue'
import '#app/nuxt-vitest-app-entry'

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  session: { value: null as unknown },
  runtime: { value: 'cloudflare' as unknown }
}))

mockNuxtImport('useRequestFetch', () => () => mocks.request)
mockNuxtImport('useUserSession', () => () => mocks.session.value)
mockNuxtImport('useRuntimeConfig', () => () => ({
  app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
  public: { serverRuntime: mocks.runtime.value }
}))

const sampleScorecardData = {
  source: 'cloudflare',
  period: {
    from: '2026-10-01T00:00:00Z',
    to: '2026-10-29T23:59:59Z'
  },
  filters: {
    carrier: 'all'
  },
  summary: {
    totalShipments: 120,
    deliveredShipments: 118,
    onTimeRate: 0.95,
    firstAttemptRate: 0.88,
    incidentRate: 0.04,
    damageRate: 0.01,
    averageCostCents: 675,
    averageResolutionTimeHours: 3.5,
    hasSufficientSample: true
  },
  minSampleThreshold: 10,
  carriers: [
    {
      carrier: 'correos_express',
      carrierName: 'Correos Express',
      totalShipments: 80,
      deliveredShipments: 79,
      onTimeRate: 0.96,
      firstAttemptRate: 0.9,
      incidentRate: 0.03,
      damageRate: 0.01,
      averageCostCents: 650,
      averageResolutionTimeHours: 2.8,
      hasSufficientSample: true,
      circuitBreaker: {
        state: 'closed',
        consecutiveFailures: 0,
        lastFailureAt: null
      }
    },
    {
      carrier: 'gls',
      carrierName: 'GLS Spain',
      totalShipments: 35,
      deliveredShipments: 34,
      onTimeRate: 0.94,
      firstAttemptRate: 0.85,
      incidentRate: 0.05,
      damageRate: 0.01,
      averageCostCents: 710,
      averageResolutionTimeHours: 4.2,
      hasSufficientSample: true,
      circuitBreaker: {
        state: 'half_open',
        consecutiveFailures: 2,
        lastFailureAt: '2026-10-29T08:00:00Z'
      }
    },
    {
      carrier: 'dhl',
      carrierName: 'DHL Parcel',
      totalShipments: 5,
      deliveredShipments: 5,
      onTimeRate: 0.8,
      firstAttemptRate: 0.8,
      incidentRate: 0.1,
      damageRate: 0.0,
      averageCostCents: 850,
      averageResolutionTimeHours: 6.0,
      hasSufficientSample: false,
      circuitBreaker: {
        state: 'open',
        consecutiveFailures: 5,
        lastFailureAt: '2026-10-29T09:30:00Z'
      }
    }
  ],
  evaluatedAt: '2026-10-29T10:00:00Z'
}

describe('AdminCarrierScorecard component', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.session.value = {
      ready: ref(true),
      loggedIn: ref(true),
      user: ref({
        id: '10000000-0000-4000-8000-000000000043',
        emailVerified: true,
        mfaVerified: true,
        permissions: ['administration.manage']
      })
    }
    mocks.request.mockResolvedValue(sampleScorecardData)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('mounts and displays header and KPI summary metrics', async () => {
    const wrapper = await mountSuspended(AdminCarrierScorecard, {
      props: { runtime: 'cloudflare' }
    })
    await flushPromises()

    expect(wrapper.text()).toContain('Scorecard de transportistas')
    expect(wrapper.text()).toContain('120') // Total envíos
    expect(wrapper.text()).toContain('95.0%') // On-time rate
    expect(wrapper.text()).toContain('88.0%') // First attempt rate
    expect(wrapper.text()).toContain('4.0%') // Incidents
    expect(wrapper.text()).toContain('1.0%') // Damages
    expect(wrapper.text()).toContain('6,75') // Avg cost formatted in EUR
  })

  it('renders carriers table with circuit breaker status badges', async () => {
    const wrapper = await mountSuspended(AdminCarrierScorecard, {
      props: { runtime: 'cloudflare' }
    })
    await flushPromises()

    expect(wrapper.text()).toContain('Correos Express')
    expect(wrapper.text()).toContain('GLS Spain')
    expect(wrapper.text()).toContain('DHL Parcel')

    // Circuit breaker states
    expect(wrapper.text()).toMatch(/Normal|Cerrado/)
    expect(wrapper.text()).toMatch(/Prueba|Semiabierto/)
    expect(wrapper.text()).toMatch(/Degradado|Abierto|Fallo/)
  })

  it('shows low sample warning for carriers with totalShipments < threshold', async () => {
    const wrapper = await mountSuspended(AdminCarrierScorecard, {
      props: { runtime: 'cloudflare' }
    })
    await flushPromises()

    // DHL has 5 shipments (< 10 threshold)
    expect(wrapper.text()).toMatch(/Muestra baja|< 10|Muestra insuficiente/)
  })

  it('allows filtering by date range and carrier', async () => {
    const wrapper = await mountSuspended(AdminCarrierScorecard, {
      props: { runtime: 'cloudflare' }
    })
    await flushPromises()

    const carrierSelect = wrapper.find('select[data-filter="carrier"]')
    expect(carrierSelect.exists()).toBe(true)

    await carrierSelect.setValue('correos_express')
    await wrapper.find('button[data-action="apply-filters"]').trigger('click')
    await flushPromises()

    expect(mocks.request).toHaveBeenCalledWith(
      expect.stringContaining('/api/admin/carriers/scorecard'),
      expect.objectContaining({
        query: expect.objectContaining({
          carrier: 'correos_express'
        })
      })
    )
  })

  it('displays empty state message when no shipments are recorded', async () => {
    mocks.request.mockResolvedValueOnce({
      ...sampleScorecardData,
      summary: {
        totalShipments: 0,
        deliveredShipments: 0,
        onTimeRate: null,
        firstAttemptRate: null,
        incidentRate: null,
        damageRate: null,
        averageCostCents: 0,
        averageResolutionTimeHours: null,
        hasSufficientSample: false
      },
      carriers: []
    })

    const wrapper = await mountSuspended(AdminCarrierScorecard, {
      props: { runtime: 'cloudflare' }
    })
    await flushPromises()

    expect(wrapper.text()).toMatch(/No hay datos de envíos|Sin envíos registrados/i)
  })

  it('renders admin page wrapper transportistas.vue', async () => {
    const wrapper = await mountSuspended(AdminCarrierScorecardPage)
    await flushPromises()

    expect(wrapper.text()).toContain('Scorecard de transportistas')
  })
})

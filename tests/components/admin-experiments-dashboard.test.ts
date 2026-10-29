import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AdminExperimentsDashboard from '../../app/components/AdminExperimentsDashboard.vue'
import '#app/nuxt-vitest-app-entry'

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  runtime: 'cloudflare',
  owner: null as unknown
}))

mockNuxtImport('useRequestFetch', () => () => mocks.request)
mockNuxtImport('useUserSession', () => () => mocks.owner)
mockNuxtImport('useRuntimeConfig', () => () => ({
  app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
  public: { serverRuntime: mocks.runtime }
}))

const sampleExperiment = {
  id: 'exp-10000000-0000-4000-8000-000000000001',
  key: 'checkout-urgency-banner',
  name: 'Descuento químico profesional con urgencia de stock',
  hypothesis: 'Mostrar stock residual con 10% de descuento aumenta la conversión sin erosionar el margen del 15%',
  experimentType: 'message_offer',
  status: 'running',
  ownerEmail: 'admin.ab@neteco.es',
  targetSurface: 'checkout_incentive',
  targetSegment: 'b2b_only',
  exclusiveGroup: 'checkout_incentives_layer',
  primaryMetric: 'conversion_rate',
  guardrails: {
    marginFloorBasisPoints: 1500,
    maxUnsubscribeRateBasisPoints: 50,
    maxComplaintRateBasisPoints: 20,
    cwvLcpMaxMs: 2500,
    cwvClsMax: 0.1,
    cwvInpMaxMs: 200
  },
  trafficAllocationPercent: 100,
  minSampleSize: 100,
  minDurationDays: 7,
  startDate: '2026-10-20T10:00:00Z',
  holdoutPercent: 10,
  changesDescription: 'Variante A muestra banner estático, Variante B muestra badge dinámico de stock limitado',
  version: 2,
  createdAt: '2026-10-20T10:00:00Z',
  updatedAt: '2026-10-20T10:00:00Z'
}

const sampleReport = {
  experimentId: sampleExperiment.id,
  key: sampleExperiment.key,
  name: sampleExperiment.name,
  hypothesis: sampleExperiment.hypothesis,
  status: 'running',
  primaryMetric: 'conversion_rate',
  minSampleSize: 100,
  minDurationDays: 7,
  daysRunning: 9,
  hasMetMinDuration: true,
  hasMetMinSampleSize: true,
  srm: {
    status: 'pass',
    chiSquare: 0.12,
    pValue: 0.729,
    degreesOfFreedom: 1,
    expectedCounts: { control: 450, urgency_offer: 450 },
    observedCounts: { control: 454, urgency_offer: 446 }
  },
  guardrailsStatus: {
    status: 'healthy',
    breaches: []
  },
  variantsMetrics: [
    {
      variantKey: 'control',
      exposures: 454,
      conversions: 45,
      conversionRate: 0.099,
      averageMarginBasisPoints: 2200,
      p75LcpMs: 1400,
      p75Cls: 0.02,
      p75InpMs: 90
    },
    {
      variantKey: 'urgency_offer',
      exposures: 446,
      conversions: 62,
      conversionRate: 0.139,
      averageMarginBasisPoints: 1800,
      p75LcpMs: 1650,
      p75Cls: 0.03,
      p75InpMs: 110
    }
  ],
  liftVsControlPercent: 40.4
}

describe('AdminExperimentsDashboard Component (DAT-017, DAT-018, MKT-011)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.request.mockImplementation(async (url: string, _opts?: { method?: string; body?: unknown }) => {
      if (url === '/api/admin/experiments') {
        return {
          experiments: [sampleExperiment],
          total: 1
        }
      }
      if (url === `/api/admin/experiments/${sampleExperiment.id}`) {
        return {
          experiment: sampleExperiment,
          report: sampleReport
        }
      }
      if (url.includes('/decision')) {
        return {
          experimentId: sampleExperiment.id,
          status: 'archived',
          decision: 'variant_b_winner'
        }
      }
      throw new Error(`Unhandled route ${url}`)
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('renders experiment registry and report details', async () => {
    const wrapper = await mountSuspended(AdminExperimentsDashboard)
    await flushPromises()

    // Title and registry header
    expect(wrapper.text()).toContain('Registro de Experimentos & A/B Testing')
    expect(wrapper.text()).toContain(sampleExperiment.name)
    expect(wrapper.text()).toContain(sampleExperiment.ownerEmail)
    expect(wrapper.text()).toContain(sampleExperiment.targetSegment)

    // DAT-017 Acceptance: Hypothesis, Primary Metric, SRM
    expect(wrapper.text()).toContain(sampleExperiment.hypothesis)
    expect(wrapper.text()).toContain('SRM OK')

    // MKT-011 Acceptance: Guardrails (Margin, CWV, Bajas/Quejas)
    expect(wrapper.text()).toContain('Margen mínimo')
    expect(wrapper.text()).toContain('Core Web Vitals')
    expect(wrapper.text()).toContain('Holdout')
  })

  it('renders empty state when no experiments exist', async () => {
    mocks.request.mockResolvedValueOnce({ experiments: [], total: 0 })

    const wrapper = await mountSuspended(AdminExperimentsDashboard)
    await flushPromises()

    expect(wrapper.text()).toContain('No hay experimentos registrados')
  })

  it('shows error state on failed fetch', async () => {
    mocks.request.mockRejectedValueOnce(new Error('Network failure'))

    const wrapper = await mountSuspended(AdminExperimentsDashboard)
    await flushPromises()

    expect(wrapper.text()).toContain('Error al cargar experimentos')
  })
})

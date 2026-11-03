import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import AdminErrorBudgetReleaseGate from '../../app/components/AdminErrorBudgetReleaseGate.vue'
import AdminCapacityPlanningPanel from '../../app/components/AdminCapacityPlanningPanel.vue'
import AdminB2BContractSloPanel from '../../app/components/AdminB2BContractSloPanel.vue'
import '#app/nuxt-vitest-app-entry'

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  runtime: 'cloudflare'
}))

mockNuxtImport('useRequestFetch', () => () => mocks.request)
mockNuxtImport('useRuntimeConfig', () => () => ({
  app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
  public: { serverRuntime: mocks.runtime }
}))

describe('OBS-025: AdminErrorBudgetReleaseGate component', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.request.mockImplementation(async (url: string, _opts?: { method?: string; body?: unknown }) => {
      if (url === '/api/admin/observability/error-budget/overview') {
        return {
          generatedAt: '2026-10-29T12:00:00Z',
          featureFreezeActive: true,
          blockingJourneys: ['checkout_orders'],
          journeys: {
            checkout_orders: {
              journey: 'checkout_orders',
              targetSloRatio: 0.9995,
              totalEvents: 50000,
              failedEvents: 35,
              allowedErrorCount: 25,
              consumedBudgetPercent: 140,
              remainingBudgetPercent: -40,
              burnRate: 1.4,
              isExhausted: true,
              warningBurnRate: 2.0,
              freezeBurnRate: 14.4
            }
          }
        }
      }
      if (url === '/api/admin/observability/error-budget/decisions') {
        return {
          decisions: [
            {
              id: 'dec-1',
              releaseVersion: 'v2026.10.30-feat',
              releaseType: 'feature',
              commitHash: 'deadbeef1',
              status: 'blocked_budget_exhausted',
              budgetStatusSummary: { freezeActive: true, blockingJourneys: ['checkout_orders'] },
              createdAt: '2026-10-29T11:00:00Z'
            }
          ]
        }
      }
      if (url === '/api/admin/observability/error-budget/evaluate') {
        return {
          decision: {
            id: 'dec-2',
            releaseVersion: 'v2026.10.30-fix',
            releaseType: 'reliability_fix',
            commitHash: 'feedcafe1',
            status: 'approved',
            budgetStatusSummary: { freezeActive: true, blockingJourneys: ['checkout_orders'] },
            createdAt: '2026-10-29T12:05:00Z'
          }
        }
      }
      return {}
    })
  })

  it('renders feature freeze alert when error budget is exhausted', async () => {
    const wrapper = await mountSuspended(AdminErrorBudgetReleaseGate)
    await flushPromises()

    expect(wrapper.text()).toContain('Feature Freeze Activo')
    expect(wrapper.text()).toContain('Checkout y Pedidos')
    expect(wrapper.text()).toContain('v2026.10.30-feat')
  })
})

describe('OBS-026: AdminCapacityPlanningPanel component', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.request.mockImplementation(async (url: string, _opts?: { method?: string; body?: unknown }) => {
      if (url === '/api/admin/observability/capacity/metrics') {
        return {
          metrics: [
            {
              resourceKey: 'd1_rows_read_daily',
              quotaLimit: 25000000,
              currentBaseline: 4000000,
              unit: 'rows/day',
              costPerMillionUnits: 0.001,
              headroomPercent: 84.0,
              updatedAt: '2026-10-29T12:00:00Z'
            }
          ]
        }
      }
      if (url === '/api/admin/observability/capacity/plans') {
        return {
          plans: [
            {
              id: 'plan-1',
              campaignName: 'Black Friday 2026',
              startTime: '2026-11-27T00:00:00Z',
              endTime: '2026-11-29T23:59:59Z',
              projectedPeakMultiplier: 3.5,
              projectedVisitorsPeak: 12000,
              projectedOrdersHour: 450,
              status: 'simulated_passed',
              headroomVerdict: 'healthy',
              minHeadroomPercent: 28.5,
              minHeadroomResource: 'd1_rows_read_daily',
              estimatedCloudflareCostEur: 52.0,
              bottlenecks: [],
              mitigations: [],
              version: 1,
              createdAt: '2026-10-29T12:00:00Z'
            }
          ]
        }
      }
      return {}
    })
  })

  it('renders Cloudflare capacity metrics and simulation panel', async () => {
    const wrapper = await mountSuspended(AdminCapacityPlanningPanel)
    await flushPromises()

    expect(wrapper.text()).toContain('Cuotas y Headroom de Infraestructura Cloudflare')
    expect(wrapper.text()).toContain('D1: Filas Leídas al Día')
    expect(wrapper.text()).toContain('Black Friday 2026')
    expect(wrapper.text()).toContain('3.5x')
  })
})

describe('OBS-028: AdminB2BContractSloPanel component', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.request.mockImplementation(async (url: string, _opts?: { method?: string; body?: unknown }) => {
      if (url === '/api/admin/observability/b2b-slo/contracts') {
        return {
          contracts: [
            {
              id: 'ctr-1',
              customerId: 'cust-1',
              companyName: 'Lavanderías Industriales del Sur SA',
              contractRef: 'CTR-B2B-2026-001',
              tierCode: 'premium_b2b',
              availabilityTarget: 0.999,
              apiP95LatencyTargetMs: 400,
              supportResponseTargetMin: 30,
              dispatchLeadTargetHours: 24,
              status: 'active',
              operationalCapacityVerified: true,
              billingPeriodStart: '2026-10-01T00:00:00Z',
              billingPeriodEnd: '2026-10-31T23:59:59Z',
              version: 2
            }
          ]
        }
      }
      if (url === '/api/admin/observability/b2b-slo/reports') {
        return {
          report: {
            id: 'rep-1',
            contractId: 'ctr-1',
            reportMonth: '2026-10',
            availabilityAchieved: 0.9995,
            targetAvailability: 0.999,
            availabilityCompliant: true,
            latencyP95AchievedMs: 310,
            latencyCompliant: true,
            supportCompliant: true,
            fulfillmentCompliant: true,
            overallCompliant: true,
            totalDowntimeMinutes: 45,
            excludedDowntimeMinutes: 30,
            netChargeableDowntimeMinutes: 15,
            penaltyCreditCents: 0,
            alertLevel: 'nominal',
            generatedAt: '2026-10-29T12:00:00Z'
          }
        }
      }
      return {}
    })
  })

  it('renders B2B contract SLOs and reports', async () => {
    const wrapper = await mountSuspended(AdminB2BContractSloPanel)
    await flushPromises()

    expect(wrapper.text()).toContain('Contratos B2B y Niveles de Servicio Acordados')
    expect(wrapper.text()).toContain('CTR-B2B-2026-001')
    expect(wrapper.text()).toContain('Lavanderías Industriales del Sur SA')
    expect(wrapper.text()).toContain('99.90%')
  })

  it('renders an integer-cent penalty as a two-decimal euro amount', async () => {
    const wrapper = await mountSuspended(AdminB2BContractSloPanel)
    await flushPromises()
    mocks.request.mockResolvedValueOnce({
      report: {
        id: 'rep-1',
        contractId: 'ctr-1',
        reportMonth: '2026-10',
        availabilityAchieved: 0.9,
        targetAvailability: 0.999,
        availabilityCompliant: false,
        latencyP95AchievedMs: 1000,
        latencyCompliant: false,
        supportCompliant: true,
        fulfillmentCompliant: true,
        overallCompliant: false,
        totalDowntimeMinutes: 100,
        excludedDowntimeMinutes: 0,
        netChargeableDowntimeMinutes: 100,
        penaltyCreditCents: 18750,
        alertLevel: 'breached',
        generatedAt: '2026-10-29T12:00:00Z'
      }
    })
    const button = wrapper.findAll('button').find((item) => item.text().includes('Generar Informe'))
    expect(button).toBeDefined()
    await button!.trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('187.50 €')
  })
})

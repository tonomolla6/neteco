import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import AdminRecommendationEngine from '../../app/components/AdminRecommendationEngine.vue'
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

const mockPolicy = {
  id: 'global',
  version: 1,
  weightCompatibility: 40,
  weightSector: 25,
  weightCopurchase: 25,
  weightMargin: 10,
  marginFloorBasisPoints: 1500,
  maxPerCategory: 2,
  manualFallbackProductIds: ['prod-bayetas', 'prod-guantes'],
  updatedAt: '2026-10-29T12:00:00Z',
  updatedBy: '00000000-0000-4000-8000-000000000000'
}

const mockMetrics = {
  source: 'cloudflare',
  periodDays: 30,
  impressions: 1200,
  clicks: 180,
  conversions: 36,
  clickThroughRate: 0.15,
  conversionRate: 0.2,
  attributedRevenueGrossCents: 154000,
  byOrigin: {
    rule: { clicks: 150, conversions: 32 },
    manualFallback: { clicks: 30, conversions: 4 }
  },
  evaluatedAt: '2026-10-29T12:00:00Z'
}

describe('AdminRecommendationEngine component (MKT-020)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.request.mockImplementation(async (url: string, opts?: { method?: string; body?: unknown }) => {
      if (url === '/api/admin/recommendations/policy') {
        if (opts?.method === 'PUT') {
          return {
            policy: {
              ...mockPolicy,
              version: 2,
              weightCompatibility: 50
            }
          }
        }
        return { policy: mockPolicy }
      }
      if (url === '/api/admin/recommendations/metrics') {
        return { metrics: mockMetrics }
      }
      return null
    })
  })

  it('renders weights and measurement analytics correctly', async () => {
    const wrapper = await mountSuspended(AdminRecommendationEngine)
    await flushPromises()

    expect(wrapper.text()).toContain('Motor de Recomendaciones por Reglas (MKT-020)')
    expect(wrapper.text()).toContain('Ponderaciones de Señales')

    const impressions = wrapper.find('[data-testid="metric-impressions"]').text()
    expect(impressions).toBe('1200')

    const clicks = wrapper.find('[data-testid="metric-clicks"]').text()
    expect(clicks).toContain('180')
    expect(clicks).toContain('15.00%')

    const revenue = wrapper.find('[data-testid="metric-revenue"]').text()
    expect(revenue).toContain('1540.00 €')
  })

  it('updates recommendation weights with CAS version check', async () => {
    const wrapper = await mountSuspended(AdminRecommendationEngine)
    await flushPromises()

    const compatInput = wrapper.find('[data-testid="weight-compatibility-input"]')
    await compatInput.setValue(50)

    const saveButton = wrapper.find('[data-testid="save-recommendation-policy-button"]')
    await saveButton.trigger('click')
    await flushPromises()

    expect(mocks.request).toHaveBeenCalledWith(
      '/api/admin/recommendations/policy',
      expect.objectContaining({
        method: 'PUT',
        body: expect.objectContaining({
          expectedVersion: 1,
          weightCompatibility: 50
        })
      })
    )

    expect(wrapper.text()).toContain('Configuración del motor de recomendaciones guardada con éxito (v2)')
  })
})

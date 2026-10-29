import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import AdminPersonalizedRerankUplift from '../../app/components/AdminPersonalizedRerankUplift.vue'
import '#app/nuxt-vitest-app-entry'

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  runtime: { value: 'cloudflare' as unknown }
}))

mockNuxtImport('useRequestFetch', () => () => mocks.request)
mockNuxtImport('useRuntimeConfig', () => () => ({
  app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
  public: { serverRuntime: mocks.runtime.value }
}))

const sampleExperiments = [
  {
    id: 'rerank_affinity_v1',
    name: 'Reordenación por afinidad de segmento y categoría química',
    status: 'active'
  }
]

const sampleReport = {
  experimentId: 'rerank_affinity_v1',
  period: { from: '2026-10-01T00:00:00Z', to: '2026-10-29T23:59:59Z' },
  control: {
    impressions: 100,
    clicks: 10,
    ctr: 0.1,
    conversions: 2,
    cvr: 0.02,
    revenueCents: 5000,
    avgOrderValueCents: 2500
  },
  treatment: {
    impressions: 100,
    clicks: 15,
    ctr: 0.15,
    conversions: 4,
    cvr: 0.04,
    revenueCents: 10000,
    avgOrderValueCents: 2500
  },
  ctrUpliftPercent: 50.0,
  convUpliftPercent: 100.0,
  revenueUpliftPercent: 100.0,
  statisticallySignificant: true,
  totalEvaluatedEvents: 200,
  explicitSortBypassHonoredCount: 35
}

describe('AdminPersonalizedRerankUplift component (SEA-020)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders side-by-side comparison cards and positive uplift percentages', async () => {
    mocks.request.mockImplementation((url: string) => {
      if (url.includes('/api/admin/search-personalization/experiments')) {
        return Promise.resolve({ items: sampleExperiments })
      }
      if (url.includes('/api/admin/search-personalization/uplift')) {
        return Promise.resolve(sampleReport)
      }
      return Promise.resolve({})
    })

    const wrapper = await mountSuspended(AdminPersonalizedRerankUplift, {
      props: { runtime: 'cloudflare' }
    })
    await flushPromises()

    expect(wrapper.text()).toContain('Reordenación personalizada controlada y medición de uplift incremental (SEA-020)')
    expect(wrapper.text()).toContain('Grupo Control (A)')
    expect(wrapper.text()).toContain('Grupo Tratamiento (B)')
    expect(wrapper.text()).toContain('+50.0%') // CTR uplift
    expect(wrapper.text()).toContain('+100.0%') // Conv uplift
    expect(wrapper.text()).toContain('Significativo')
    expect(wrapper.text()).toContain('Filtros y orden explícitos respetados al 100%')
    expect(wrapper.text()).toContain('35 consultas con orden/filtros explícitos preservados')
  })

  it('renders accessible error alert when loading fails', async () => {
    mocks.request.mockRejectedValue(new Error('Network error'))

    const wrapper = await mountSuspended(AdminPersonalizedRerankUplift, {
      props: { runtime: 'cloudflare' }
    })
    await flushPromises()

    const alert = wrapper.find('[role="alert"]')
    expect(alert.exists()).toBe(true)
    expect(alert.text()).toContain('No se ha podido cargar el informe de uplift')
  })
})

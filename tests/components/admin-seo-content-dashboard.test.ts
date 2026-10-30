import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AdminSeoContentDashboard from '../../app/components/AdminSeoContentDashboard.vue'
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

const sampleSeoData = {
  summary: {
    totalImpressions: 12000,
    totalClicks: 650,
    overallCtr: 0.054,
    avgPosition: 4.8,
    assistedOrdersCount: 22,
    assistedRevenueGrossCents: 260000,
    assistedRevenueNetCents: 214876,
    totalContentCostCents: 35000,
    seoRoi: 6.14
  },
  queries: [
    {
      query: 'desengrasante industrial concentrado',
      impressions: 4500,
      clicks: 320,
      ctr: 0.071,
      avgPosition: 2.3,
      assistedOrdersCount: 12,
      assistedRevenueGrossCents: 144000,
      assistedRevenueNetCents: 119008
    },
    {
      query: 'detergente lavanderia profesional',
      impressions: 3200,
      clicks: 180,
      ctr: 0.056,
      avgPosition: 3.5,
      assistedOrdersCount: 6,
      assistedRevenueGrossCents: 72000,
      assistedRevenueNetCents: 59504
    }
  ],
  landingPages: [
    {
      landingPath: '/producto/desengrasante-industrial-5l',
      impressions: 5000,
      clicks: 350,
      ctr: 0.07,
      avgPosition: 2.5,
      assistedOrdersCount: 14,
      assistedRevenueGrossCents: 168000,
      assistedRevenueNetCents: 138843,
      contentCostCents: 20000,
      seoRoi: 6.94
    }
  ],
  syncStatus: {
    status: 'synced',
    dataThroughDate: '2026-10-28',
    lastSyncAt: '2026-10-29T12:00:00Z'
  }
}

describe('AdminSeoContentDashboard component (DAT-019)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.session.value = {
      ready: ref(true),
      loggedIn: ref(true),
      user: ref({
        id: '10000000-0000-4000-8000-000000000001',
        emailVerified: true,
        mfaVerified: true,
        permissions: ['administration.manage']
      })
    }
    mocks.request.mockResolvedValue(sampleSeoData)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('renders summary KPIs with impressions, clicks, queries, landings, assisted revenue, freshness and costs (not just sessions)', async () => {
    const wrapper = await mountSuspended(AdminSeoContentDashboard, {
      props: { runtime: 'cloudflare' }
    })
    await flushPromises()

    expect(wrapper.text()).toContain('SEO & Contenido')
    expect(wrapper.text()).toContain('DAT-019')

    // Impresiones
    expect(wrapper.find('[data-testid="seo-kpi-impressions"]').text()).toMatch(/12\.?000/)
    // Clicks
    expect(wrapper.find('[data-testid="seo-kpi-clicks"]').text()).toContain('650')
    // Revenue asistido
    expect(wrapper.find('[data-testid="seo-kpi-assisted-revenue"]').text()).toMatch(/2\.?148,76/)
    // Coste de contenido
    expect(wrapper.find('[data-testid="seo-kpi-content-cost"]').text()).toContain('350,00')
    // SEO ROI
    expect(wrapper.find('[data-testid="seo-kpi-roi"]').text()).toContain('6.14x')

    // Queries table
    expect(wrapper.find('[data-testid="seo-queries-table"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('desengrasante industrial concentrado')

    // Landings table
    expect(wrapper.find('[data-testid="seo-landings-table"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('/producto/desengrasante-industrial-5l')
  })

  it('re-fetches dashboard data when filters change', async () => {
    const wrapper = await mountSuspended(AdminSeoContentDashboard, {
      props: { runtime: 'cloudflare' }
    })
    await flushPromises()

    const deviceSelect = wrapper.find('[data-testid="seo-filter-device"]')
    await deviceSelect.setValue('desktop')
    await wrapper.find('[data-testid="seo-filter-submit"]').trigger('click')
    await flushPromises()

    expect(mocks.request).toHaveBeenCalledWith(expect.stringContaining('device=desktop'), expect.anything())
  })
})

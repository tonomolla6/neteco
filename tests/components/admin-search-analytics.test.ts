import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AdminSearchAnalytics from '../../app/components/AdminSearchAnalytics.vue'
import AdminSearchAnalyticsPage from '../../app/pages/admin/analitica-busqueda.vue'
import '#app/nuxt-vitest-app-entry'

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  session: { value: null as unknown },
  navigation: { value: null as unknown },
  runtime: { value: 'cloudflare' as unknown }
}))

mockNuxtImport('useRequestFetch', () => () => mocks.request)
mockNuxtImport('useUserSession', () => () => mocks.session.value)
mockNuxtImport('useRuntimeConfig', () => () => ({
  app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
  public: { serverRuntime: mocks.runtime.value }
}))

const sampleDashboardData = {
  period: {
    from: '2026-10-01T00:00:00Z',
    to: '2026-10-29T23:59:59Z'
  },
  filters: {
    device: 'all',
    segment: 'all'
  },
  summary: {
    totalSearches: 125,
    totalZeroResults: 15,
    totalClicks: 45,
    totalAddToCart: 20,
    globalCtr: 0.36,
    globalAddToCartRate: 0.16
  },
  minSampleThreshold: 20,
  topQueries: [
    {
      term: 'desengrasante industrial',
      searches: 50,
      zeroResults: 0,
      clicks: 25,
      addToCart: 12,
      ctr: 0.5,
      addToCartRate: 0.24,
      hasSufficientSample: true
    },
    {
      term: 'lejia neutra',
      searches: 30,
      zeroResults: 0,
      clicks: 12,
      addToCart: 6,
      ctr: 0.4,
      addToCartRate: 0.2,
      hasSufficientSample: true
    },
    {
      term: 'producto raro',
      searches: 10,
      zeroResults: 10,
      clicks: 1,
      addToCart: 0,
      ctr: null,
      addToCartRate: null,
      hasSufficientSample: false
    }
  ],
  zeroResultQueries: [
    {
      term: 'producto raro',
      searches: 10,
      zeroResults: 10,
      synonymUrl: '/admin/busqueda?q=producto+raro&tab=synonyms',
      merchandisingUrl: '/admin/busqueda?q=producto+raro&tab=merchandising'
    }
  ],
  pagination: {
    page: 1,
    perPage: 20,
    total: 3
  }
}

describe('AdminSearchAnalytics component', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.session.value = {
      ready: ref(true),
      loggedIn: ref(true),
      user: ref({
        id: '00000000-0000-4000-8000-000000000001',
        emailVerified: true,
        mfaVerified: true,
        permissions: ['administration.manage', 'catalog.write']
      })
    }
    mocks.request.mockResolvedValue(sampleDashboardData)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('mounts and renders page header and summary KPI metrics', async () => {
    const wrapper = await mountSuspended(AdminSearchAnalytics, {
      props: { runtime: 'cloudflare' }
    })
    await flushPromises()

    expect(wrapper.text()).toContain('Analítica de búsqueda')
    expect(wrapper.text()).toContain('125') // Total búsquedas
    expect(wrapper.text()).toContain('15') // Búsquedas sin resultados
    expect(wrapper.text()).toContain('36.0%') // CTR global
    expect(wrapper.text()).toContain('16.0%') // Add to cart global
  })

  it('renders top queries table with rates when sample is sufficient (>= 20)', async () => {
    const wrapper = await mountSuspended(AdminSearchAnalytics, {
      props: { runtime: 'cloudflare' }
    })
    await flushPromises()

    expect(wrapper.text()).toContain('desengrasante industrial')
    expect(wrapper.text()).toContain('50.0%') // CTR for desengrasante
    expect(wrapper.text()).toContain('24.0%') // Add to cart rate for desengrasante
  })

  it('indicates insufficient sample (< 20) and suppresses rates for queries below threshold', async () => {
    const wrapper = await mountSuspended(AdminSearchAnalytics, {
      props: { runtime: 'cloudflare' }
    })
    await flushPromises()

    expect(wrapper.text()).toContain('producto raro')
    // Rates should be suppressed with an indicator / dash
    expect(wrapper.text()).toMatch(/Muestra insuficiente|< 20|—/)
  })

  it('renders zero result queries with direct links to create synonym or merchandising rule', async () => {
    const wrapper = await mountSuspended(AdminSearchAnalytics, {
      props: { runtime: 'cloudflare' }
    })
    await flushPromises()

    const synonymLink = wrapper.find('a[href*="/admin/busqueda"][href*="synonyms"]')
    expect(synonymLink.exists()).toBe(true)

    const merchLink = wrapper.find('a[href*="/admin/busqueda"][href*="merchandising"]')
    expect(merchLink.exists()).toBe(true)
  })

  it('allows filtering by device and segment', async () => {
    const wrapper = await mountSuspended(AdminSearchAnalytics, {
      props: { runtime: 'cloudflare' }
    })
    await flushPromises()

    const deviceSelect = wrapper.find('select[data-filter="device"]')
    expect(deviceSelect.exists()).toBe(true)

    const segmentSelect = wrapper.find('select[data-filter="segment"]')
    expect(segmentSelect.exists()).toBe(true)

    await deviceSelect.setValue('mobile')
    await segmentSelect.setValue('professional')
    await wrapper.find('button[data-action="apply-filters"]').trigger('click')
    await flushPromises()

    expect(mocks.request).toHaveBeenCalledWith(
      expect.stringContaining('/api/admin/analytics/search'),
      expect.objectContaining({
        query: expect.objectContaining({
          device: 'mobile',
          segment: 'professional'
        })
      })
    )
  })

  it('renders admin page wrapper analitica-busqueda.vue', async () => {
    const wrapper = await mountSuspended(AdminSearchAnalyticsPage)
    await flushPromises()

    expect(wrapper.text()).toContain('Analítica de búsqueda')
  })
})

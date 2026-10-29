import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AdminCohorts from '../../app/components/AdminCohorts.vue'
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

const sampleCohortsData = {
  period: { from: '2026-01-01T00:00:00Z', to: '2026-10-29T23:59:59Z' },
  filters: { segment: 'all', categoryId: 'all', churnDays: 90 },
  definitionVersion: '2026-10-v1',
  definitions: {
    cohort: 'Mes de la primera compra válida.',
    validOrders: 'Pedidos pagados y no cancelados con reembolsos menores al total.',
    churn: 'Sin compras en los últimos 90 días.'
  },
  summary: {
    totalCustomers: 120,
    totalRepeatCustomers: 48,
    overallRepeatRate: 0.4,
    medianDaysToRepurchase: 32,
    overallChurnRate: 0.25
  },
  cohorts: [
    {
      cohort: '2026-01',
      size: 50,
      repeat30Days: { count: 10, rate: 0.2 },
      repeat60Days: { count: 18, rate: 0.36 },
      repeat90Days: { count: 22, rate: 0.44 },
      repeat180Days: { count: 25, rate: 0.5 },
      medianDaysToRepurchase: 28,
      churn: { days: 90, count: 12, rate: 0.24 },
      segments: {
        particular: { count: 35, repeatCount: 15, repeatRate: 0.428 },
        professional: { count: 15, repeatCount: 10, repeatRate: 0.667 }
      },
      topCategories: [
        { categoryId: 'cat-hosteleria', categoryName: 'Hostelería', customerCount: 30 },
        { categoryId: 'cat-hogar', categoryName: 'Hogar', customerCount: 20 }
      ]
    },
    {
      cohort: '2026-02',
      size: 70,
      repeat30Days: { count: 12, rate: 0.171 },
      repeat60Days: { count: 20, rate: 0.286 },
      repeat90Days: { count: 23, rate: 0.329 },
      repeat180Days: { count: 23, rate: 0.329 },
      medianDaysToRepurchase: 35,
      churn: { days: 90, count: 18, rate: 0.257 },
      segments: {
        particular: { count: 50, repeatCount: 15, repeatRate: 0.3 },
        professional: { count: 20, repeatCount: 8, repeatRate: 0.4 }
      },
      topCategories: [{ categoryId: 'cat-industria', categoryName: 'Industria', customerCount: 40 }]
    }
  ]
}

describe('AdminCohorts component (DAT-014)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.session.value = {
      ready: ref(true),
      loggedIn: ref(true),
      user: ref({
        id: '00000000-0000-4000-8000-000000000001',
        emailVerified: true,
        mfaVerified: true,
        permissions: ['administration.manage']
      })
    }
    mocks.request.mockResolvedValue(sampleCohortsData)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('renders title, summary KPIs and cohort rows when data loads', async () => {
    const wrapper = await mountSuspended(AdminCohorts, {
      props: { runtime: 'cloudflare' }
    })
    await flushPromises()

    expect(wrapper.text()).toContain('Cohortes de repetición')
    expect(wrapper.text()).toContain('120') // Total clientes
    expect(wrapper.text()).toContain('40.0%') // Tasa global recompra
    expect(wrapper.text()).toContain('32 días') // Mediana
    expect(wrapper.text()).toContain('25.0%') // Tasa churn

    // Check cohort table rows
    expect(wrapper.text()).toContain('2026-01')
    expect(wrapper.text()).toContain('2026-02')
    expect(wrapper.text()).toContain('20.0%') // 30d cohort 1
    expect(wrapper.text()).toContain('50.0%') // 180d cohort 1
  })

  it('shows definitions documentation version', async () => {
    const wrapper = await mountSuspended(AdminCohorts, {
      props: { runtime: 'cloudflare' }
    })
    await flushPromises()

    expect(wrapper.text()).toContain('2026-10-v1')
    expect(wrapper.text()).toContain('Mes de la primera compra válida')
  })

  it('handles empty cohorts state', async () => {
    mocks.request.mockResolvedValueOnce({
      ...sampleCohortsData,
      summary: {
        totalCustomers: 0,
        totalRepeatCustomers: 0,
        overallRepeatRate: 0,
        medianDaysToRepurchase: null,
        overallChurnRate: 0
      },
      cohorts: []
    })
    const wrapper = await mountSuspended(AdminCohorts, {
      props: { runtime: 'cloudflare' }
    })
    await flushPromises()

    expect(wrapper.find('[data-testid="cohorts-empty"]').exists()).toBe(true)
  })
})

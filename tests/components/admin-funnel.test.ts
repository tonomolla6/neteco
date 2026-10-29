import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AdminFunnel from '../../app/components/AdminFunnel.vue'
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

const sampleFunnelData = {
  period: { from: '2026-10-01T00:00:00Z', to: '2026-10-29T23:59:59Z' },
  filters: { device: 'all', source: 'all', segment: 'all' },
  minSampleThreshold: 30,
  steps: [
    {
      step: 'visit',
      name: 'Visita',
      sessions: 1500,
      conversionFromPrevious: { rate: null, lower: 0, upper: 0 },
      conversionFromStart: { rate: 1.0, lower: 1.0, upper: 1.0 },
      hasSufficientSample: true,
      isSmallSampleWarning: false
    },
    {
      step: 'product_view',
      name: 'Ficha de producto',
      sessions: 600,
      conversionFromPrevious: { rate: 0.4, lower: 0.375, upper: 0.425 },
      conversionFromStart: { rate: 0.4, lower: 0.375, upper: 0.425 },
      hasSufficientSample: true,
      isSmallSampleWarning: false
    },
    {
      step: 'cart_add',
      name: 'Añadir al carrito',
      sessions: 150,
      conversionFromPrevious: { rate: 0.25, lower: 0.217, upper: 0.286 },
      conversionFromStart: { rate: 0.1, lower: 0.086, upper: 0.116 },
      hasSufficientSample: true,
      isSmallSampleWarning: false
    },
    {
      step: 'checkout_start',
      name: 'Inicio checkout',
      sessions: 45,
      conversionFromPrevious: { rate: 0.3, lower: 0.233, upper: 0.378 },
      conversionFromStart: { rate: 0.03, lower: 0.022, upper: 0.04 },
      hasSufficientSample: true,
      isSmallSampleWarning: false
    },
    {
      step: 'purchase',
      name: 'Pago confirmado',
      sessions: 18,
      conversionFromPrevious: { rate: 0.4, lower: 0.267, upper: 0.552 },
      conversionFromStart: { rate: 0.012, lower: 0.0076, upper: 0.0189 },
      hasSufficientSample: false, // 18 < 30
      isSmallSampleWarning: true
    }
  ],
  overallConversion: {
    rate: 0.012,
    lower: 0.0076,
    upper: 0.0189,
    hasSufficientSample: false
  },
  breakdown: {
    byDevice: [
      { key: 'desktop', sessions: 900, purchaseSessions: 12, conversionRate: 0.0133 },
      { key: 'mobile', sessions: 550, purchaseSessions: 6, conversionRate: 0.0109 },
      { key: 'tablet', sessions: 50, purchaseSessions: 0, conversionRate: 0 }
    ],
    bySource: [
      { key: 'direct', sessions: 500, purchaseSessions: 8, conversionRate: 0.016 },
      { key: 'organic', sessions: 600, purchaseSessions: 7, conversionRate: 0.0117 },
      { key: 'cpc', sessions: 300, purchaseSessions: 3, conversionRate: 0.01 },
      { key: 'social', sessions: 100, purchaseSessions: 0, conversionRate: 0 }
    ],
    bySegment: [
      { key: 'anonymous', sessions: 1200, purchaseSessions: 10, conversionRate: 0.0083 },
      { key: 'customer', sessions: 200, purchaseSessions: 5, conversionRate: 0.025 },
      { key: 'professional', sessions: 100, purchaseSessions: 3, conversionRate: 0.03 }
    ]
  }
}

describe('AdminFunnel component (DAT-015)', () => {
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
    mocks.request.mockResolvedValue(sampleFunnelData)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('renders title, funnel steps and Wilson confidence intervals', async () => {
    const wrapper = await mountSuspended(AdminFunnel, {
      props: { runtime: 'cloudflare' }
    })
    await flushPromises()

    expect(wrapper.text()).toContain('Embudo de conversión')
    expect(wrapper.text()).toContain('Visita')
    expect(wrapper.text()).toContain('Ficha de producto')
    expect(wrapper.text()).toContain('Añadir al carrito')
    expect(wrapper.text()).toContain('Inicio checkout')
    expect(wrapper.text()).toContain('Pago confirmado')

    // Sessions count
    expect(wrapper.text()).toContain('1500')
    expect(wrapper.text()).toContain('600')

    // Wilson confidence interval rendering
    expect(wrapper.text()).toContain('IC 95%')
    expect(wrapper.text()).toContain('[37.5% - 42.5%]')
  })

  it('displays warning when sample size is below threshold (< 30)', async () => {
    const wrapper = await mountSuspended(AdminFunnel, {
      props: { runtime: 'cloudflare' }
    })
    await flushPromises()

    expect(wrapper.find('[data-testid="funnel-sample-warning"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('Muestra pequeña')
  })

  it('renders breakdowns by device, source and segment', async () => {
    const wrapper = await mountSuspended(AdminFunnel, {
      props: { runtime: 'cloudflare' }
    })
    await flushPromises()

    expect(wrapper.text()).toContain('desktop')
    expect(wrapper.text()).toContain('mobile')
    expect(wrapper.text()).toContain('direct')
    expect(wrapper.text()).toContain('organic')
    expect(wrapper.text()).toContain('professional')
  })
})

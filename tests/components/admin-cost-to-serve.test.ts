import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AdminCostToServe from '../../app/components/AdminCostToServe.vue'
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

const sampleCostData = {
  summary: {
    totalOrdersAnalyzed: 100,
    totalGrossRevenueCents: 12100000,
    totalNetRevenueCents: 10000000,
    totalTaxCents: 2100000,
    totalCogsCents: 4200000,
    totalDiscountCents: 500000,
    totalPaymentFeeCents: 120000,
    totalPickingCostCents: 250000,
    totalShippingRealCostCents: 650000,
    totalReturnsCostCents: 180000,
    totalSupportCostCents: 100000,
    totalCostToServeCents: 5500000,
    totalContributionMarginCents: 4500000,
    overallMarginRatio: 0.45,
    profitableOrdersCount: 92,
    lossMakingOrdersCount: 8,
    lossMakingRate: 0.08,
    tiersBreakdown: {
      highMarginCount: 65,
      healthyMarginCount: 22,
      lowMarginCount: 5,
      lossMakingCount: 8
    }
  },
  orders: [
    {
      id: 'cts-1',
      orderId: 'ord-101',
      currency: 'EUR',
      grossRevenueCents: 12100,
      netRevenueCents: 10000,
      taxCents: 2100,
      cogsCents: 4000,
      discountCents: 500,
      paymentFeeCents: 120,
      pickingCostCents: 250,
      shippingRealCostCents: 600,
      returnsCostCents: 0,
      supportCostCents: 80,
      totalCostToServeCents: 5050,
      contributionMarginCents: 4950,
      marginRatio: 0.495,
      profitabilityTier: 'high_margin',
      costBreakdownJson: '{}',
      version: 1,
      createdAt: '2026-10-28T10:00:00Z',
      updatedAt: '2026-10-28T10:00:00Z'
    }
  ]
}

describe('AdminCostToServe component (DAT-021)', () => {
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
    mocks.request.mockResolvedValue(sampleCostData)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('renders Cost-to-Serve and contribution margin with all 7 factors linked to order', async () => {
    const wrapper = await mountSuspended(AdminCostToServe, {
      props: { runtime: 'cloudflare' }
    })
    await flushPromises()

    expect(wrapper.text()).toContain('Cost-to-Serve')
    expect(wrapper.text()).toContain('DAT-021')

    // Summary KPIs
    expect(wrapper.find('[data-testid="cts-kpi-net-revenue"]').text()).toMatch(/100\.?000,00/)
    expect(wrapper.find('[data-testid="cts-kpi-cost-to-serve"]').text()).toMatch(/55\.?000,00/)
    expect(wrapper.find('[data-testid="cts-kpi-contribution-margin"]').text()).toMatch(/45\.?000,00/)
    expect(wrapper.find('[data-testid="cts-kpi-margin-ratio"]').text()).toContain('45.0%')
    expect(wrapper.find('[data-testid="cts-kpi-loss-making-rate"]').text()).toContain('8.0%')

    // 7 Factors
    expect(wrapper.find('[data-testid="factor-cogs"]').text()).toMatch(/42\.?000,00/)
    expect(wrapper.find('[data-testid="factor-discounts"]').text()).toMatch(/5\.?000,00/)
    expect(wrapper.find('[data-testid="factor-payment"]').text()).toMatch(/1\.?200,00/)
    expect(wrapper.find('[data-testid="factor-picking"]').text()).toMatch(/2\.?500,00/)
    expect(wrapper.find('[data-testid="factor-carrier"]').text()).toMatch(/6\.?500,00/)
    expect(wrapper.find('[data-testid="factor-returns"]').text()).toMatch(/1\.?800,00/)
    expect(wrapper.find('[data-testid="factor-support"]').text()).toMatch(/1\.?000,00/)

    // Orders table
    expect(wrapper.find('[data-testid="cts-orders-table"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('ord-101')
  })
})

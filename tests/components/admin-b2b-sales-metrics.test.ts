import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AdminB2bSalesMetrics from '../../app/components/AdminB2bSalesMetrics.vue'
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

const sampleB2bData = {
  activation: {
    totalRegisteredCompanies: 25,
    approvedCompanies: 20,
    activatedCompanies: 15,
    activationRate: 0.75,
    avgDaysToFirstOrder: 8.4,
    pendingActivationAging: {
      under30Days: 3,
      days30to90: 1,
      over90Days: 1
    }
  },
  conversion: {
    ordersCount: 42,
    revenueNetCents: 6300000,
    averageOrderValueCents: 150000,
    checkoutsCompleted: 42
  },
  recurrence: {
    oneTimeBuyers: 5,
    repeatBuyers: 10,
    repeatPurchaseRate: 0.667,
    avgDaysBetweenOrders: 28
  },
  commercialTerms: {
    paymentTermsDistribution: [
      { paymentDays: 0, companiesCount: 5 },
      { paymentDays: 15, companiesCount: 3 },
      { paymentDays: 30, companiesCount: 10 },
      { paymentDays: 60, companiesCount: 2 }
    ],
    creditExposure: {
      totalCreditLimitCents: 8500000,
      blockedCompaniesCount: 1
    },
    pricingTiersDistribution: [
      { priceListId: 'plist-industrial', companiesCount: 12 },
      { priceListId: 'plist-hosteleria', companiesCount: 6 }
    ]
  },
  topCompanies: [
    {
      companyId: 'comp-1',
      legalName: 'Lavanderías Industriales del Este S.L.',
      ordersCount: 8,
      revenueNetCents: 1850000
    }
  ]
}

describe('AdminB2bSalesMetrics component (DAT-020)', () => {
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
    mocks.request.mockResolvedValue(sampleB2bData)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('renders Activation, Conversion, Recurrence and Real Commercial Terms (strictly without sedes/aprobadores)', async () => {
    const wrapper = await mountSuspended(AdminB2bSalesMetrics, {
      props: { runtime: 'cloudflare' }
    })
    await flushPromises()

    expect(wrapper.text()).toContain('Venta a Empresas')
    expect(wrapper.text()).toContain('DAT-020')

    // 1. Activation
    expect(wrapper.find('[data-testid="b2b-kpi-activation-rate"]').text()).toContain('75.0%')
    expect(wrapper.find('[data-testid="b2b-kpi-activated-count"]').text()).toContain('15')
    expect(wrapper.find('[data-testid="b2b-kpi-avg-days-first-order"]').text()).toContain('8.4')

    // 2. Conversion
    expect(wrapper.find('[data-testid="b2b-kpi-orders-count"]').text()).toContain('42')
    expect(wrapper.find('[data-testid="b2b-kpi-revenue"]').text()).toMatch(/63\.?000,00/)
    expect(wrapper.find('[data-testid="b2b-kpi-aov"]').text()).toMatch(/1\.?500,00/)

    // 3. Recurrence
    expect(wrapper.find('[data-testid="b2b-kpi-repeat-rate"]').text()).toContain('66.7%')
    expect(wrapper.find('[data-testid="b2b-kpi-repeat-buyers"]').text()).toContain('10')
    expect(wrapper.find('[data-testid="b2b-kpi-cadence"]').text()).toContain('28')

    // 4. Commercial Terms
    expect(wrapper.find('[data-testid="b2b-payment-terms-table"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="b2b-kpi-credit-limit"]').text()).toMatch(/85\.?000,00/)
    expect(wrapper.find('[data-testid="b2b-kpi-blocked-companies"]').text()).toContain('1')

    // Confirm strict absence of sedes/aprobadores/presupuestos
    const text = wrapper.text().toLowerCase()
    expect(text).not.toContain('sedes')
    expect(text).not.toContain('aprobadores')
    expect(text).not.toContain('presupuestos departamentales')
  })
})

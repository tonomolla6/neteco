import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AdminPaymentFunnel from '../../app/components/AdminPaymentFunnel.vue'
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

const samplePaymentFunnelData = {
  period: { from: '2026-10-01T00:00:00Z', to: '2026-10-29T23:59:59Z' },
  filters: { device: 'all', method: 'all', bank: 'all' },
  minSampleThreshold: 30,
  summary: {
    totalAttempts: 50,
    authorizedCount: 35,
    declinedCount: 10,
    cancelledCount: 3,
    expiredCount: 2,
    authorizationRate: 0.7,
    declineRate: 0.2,
    cancellationRate: 0.06,
    expirationRate: 0.04,
    wilsonInterval: { lower: 0.56, upper: 0.81 },
    hasSufficientSample: true
  },
  stages: [
    {
      step: 'intent_created',
      name: 'Inicio de pago',
      count: 50,
      conversionFromPrevious: { rate: 1.0, lower: 1.0, upper: 1.0 },
      conversionFromStart: { rate: 1.0, lower: 1.0, upper: 1.0 },
      hasSufficientSample: true,
      isSmallSampleWarning: false
    },
    {
      step: 'redirected',
      name: 'Pasarela cargada / Redirección',
      count: 48,
      conversionFromPrevious: { rate: 0.96, lower: 0.86, upper: 0.99 },
      conversionFromStart: { rate: 0.96, lower: 0.86, upper: 0.99 },
      hasSufficientSample: true,
      isSmallSampleWarning: false
    },
    {
      step: 'authorized',
      name: 'Pago autorizado / confirmado',
      count: 35,
      conversionFromPrevious: { rate: 0.7292, lower: 0.59, upper: 0.83 },
      conversionFromStart: { rate: 0.7, lower: 0.56, upper: 0.81 },
      hasSufficientSample: true,
      isSmallSampleWarning: false
    }
  ],
  declineCauses: [
    {
      category: 'insufficient_funds',
      label: 'Saldo o fondos insuficientes',
      code: '0116',
      count: 5,
      percentage: 0.5
    },
    {
      category: 'auth_failed_3ds',
      label: 'Fallo de autenticación 3DS / Titular no autenticado',
      code: '0184',
      count: 3,
      percentage: 0.3
    },
    {
      category: 'expired_card',
      label: 'Tarjeta caducada o fecha incorrecta',
      code: '0101',
      count: 2,
      percentage: 0.2
    }
  ],
  breakdowns: {
    byDevice: [
      {
        key: 'desktop',
        label: 'Ordenador (Desktop)',
        attempts: 30,
        authorized: 22,
        declined: 6,
        cancelled: 2,
        successRate: 0.7333
      },
      {
        key: 'mobile',
        label: 'Móvil (Mobile)',
        attempts: 20,
        authorized: 13,
        declined: 4,
        cancelled: 1,
        successRate: 0.65
      }
    ],
    byMethod: [
      {
        key: 'card',
        label: 'Tarjeta bancaria',
        attempts: 40,
        authorized: 28,
        declined: 9,
        cancelled: 3,
        successRate: 0.7
      },
      { key: 'bizum', label: 'Bizum', attempts: 10, authorized: 7, declined: 1, cancelled: 0, successRate: 0.7 }
    ],
    byBank: [
      { key: 'BBVA', label: 'BBVA', attempts: 25, authorized: 18, declined: 5, cancelled: 2, successRate: 0.72 },
      {
        key: 'Santander',
        label: 'Santander',
        attempts: 15,
        authorized: 10,
        declined: 4,
        cancelled: 1,
        successRate: 0.6667
      }
    ]
  }
}

describe('AdminPaymentFunnel Component (PAY-018)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.runtime.value = 'cloudflare'
    mocks.session.value = {
      ready: ref(true),
      loggedIn: ref(true),
      user: ref({
        id: 'user-admin-1',
        email: 'admin@neteco.test',
        emailVerified: true,
        mfaVerified: true,
        role: 'admin'
      })
    }
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('renders disabled or restricted when user is not authorized', async () => {
    mocks.session.value = {
      ready: ref(true),
      loggedIn: ref(false),
      user: ref(null)
    }

    const wrapper = await mountSuspended(AdminPaymentFunnel, {
      props: { runtime: 'cloudflare' }
    })

    const refreshBtn = wrapper.find('[data-testid="payment-funnel-refresh"]')
    expect(refreshBtn.attributes('disabled')).toBeDefined()
    expect(mocks.request).not.toHaveBeenCalled()
  })

  it('automatically fetches payment funnel data on mount when authorized', async () => {
    mocks.request.mockResolvedValueOnce(samplePaymentFunnelData)

    const wrapper = await mountSuspended(AdminPaymentFunnel, {
      props: { runtime: 'cloudflare' }
    })
    await flushPromises()

    expect(mocks.request).toHaveBeenCalledTimes(1)
    expect(mocks.request).toHaveBeenCalledWith(
      expect.stringContaining('/api/admin/payments/funnel'),
      expect.objectContaining({ method: 'GET' })
    )

    // Check summary metric cards
    expect(wrapper.text()).toContain('PAY-018')
    expect(wrapper.find('[data-testid="summary-total-attempts"]').text()).toContain('50')
    expect(wrapper.find('[data-testid="summary-authorized"]').text()).toContain('35')
    expect(wrapper.find('[data-testid="summary-success-rate"]').text()).toContain('70.0%')
    expect(wrapper.find('[data-testid="summary-decline-rate"]').text()).toContain('20.0%')
  })

  it('renders all 3 payment funnel stages with conversion percentages', async () => {
    mocks.request.mockResolvedValueOnce(samplePaymentFunnelData)

    const wrapper = await mountSuspended(AdminPaymentFunnel, {
      props: { runtime: 'cloudflare' }
    })
    await flushPromises()

    const step1 = wrapper.find('[data-testid="funnel-step-intent_created"]')
    expect(step1.exists()).toBe(true)
    expect(step1.text()).toContain('Inicio de pago')
    expect(step1.text()).toContain('50')

    const step2 = wrapper.find('[data-testid="funnel-step-redirected"]')
    expect(step2.exists()).toBe(true)
    expect(step2.text()).toContain('Pasarela cargada')
    expect(step2.text()).toContain('48')

    const step3 = wrapper.find('[data-testid="funnel-step-authorized"]')
    expect(step3.exists()).toBe(true)
    expect(step3.text()).toContain('Pago autorizado')
    expect(step3.text()).toContain('35')
  })

  it('renders the decline causes table with codes, labels, and percentages', async () => {
    mocks.request.mockResolvedValueOnce(samplePaymentFunnelData)

    const wrapper = await mountSuspended(AdminPaymentFunnel, {
      props: { runtime: 'cloudflare' }
    })
    await flushPromises()

    const declineTable = wrapper.find('[data-testid="payment-decline-causes-table"]')
    expect(declineTable.exists()).toBe(true)
    expect(declineTable.text()).toContain('Saldo o fondos insuficientes')
    expect(declineTable.text()).toContain('0116')
    expect(declineTable.text()).toContain('5')
    expect(declineTable.text()).toContain('50.0%')

    expect(declineTable.text()).toContain('Fallo de autenticación 3DS')
    expect(declineTable.text()).toContain('0184')
    expect(declineTable.text()).toContain('3')

    expect(declineTable.text()).toContain('Tarjeta caducada')
    expect(declineTable.text()).toContain('0101')
    expect(declineTable.text()).toContain('2')
  })

  it('renders segmentation breakdowns by device, method, and bank', async () => {
    mocks.request.mockResolvedValueOnce(samplePaymentFunnelData)

    const wrapper = await mountSuspended(AdminPaymentFunnel, {
      props: { runtime: 'cloudflare' }
    })
    await flushPromises()

    // Device breakdown
    const deviceTable = wrapper.find('[data-testid="breakdown-device-table"]')
    expect(deviceTable.exists()).toBe(true)
    expect(deviceTable.text()).toContain('Desktop')
    expect(deviceTable.text()).toContain('Mobile')

    // Method breakdown
    const methodTable = wrapper.find('[data-testid="breakdown-method-table"]')
    expect(methodTable.exists()).toBe(true)
    expect(methodTable.text()).toContain('Tarjeta bancaria')
    expect(methodTable.text()).toContain('Bizum')

    // Bank breakdown
    const bankTable = wrapper.find('[data-testid="breakdown-bank-table"]')
    expect(bankTable.exists()).toBe(true)
    expect(bankTable.text()).toContain('BBVA')
    expect(bankTable.text()).toContain('Santander')
  })

  it('submits filter query when form is applied', async () => {
    mocks.request.mockResolvedValue(samplePaymentFunnelData)

    const wrapper = await mountSuspended(AdminPaymentFunnel, {
      props: { runtime: 'cloudflare' }
    })
    await flushPromises()

    // Select filters
    await wrapper.find('#payment-funnel-device').setValue('mobile')
    await wrapper.find('#payment-funnel-method').setValue('bizum')
    await wrapper.find('#payment-funnel-bank').setValue('BBVA')

    await wrapper.find('[data-testid="payment-funnel-apply"]').trigger('click')
    await flushPromises()

    expect(mocks.request).toHaveBeenLastCalledWith(
      expect.stringMatching(/device=mobile.*method=bizum.*bank=BBVA|device=mobile.*bank=BBVA.*method=bizum/),
      expect.objectContaining({ method: 'GET' })
    )
  })

  it('displays error alert when fetch fails', async () => {
    mocks.request.mockRejectedValueOnce(new Error('Fallo al conectar con el servidor'))

    const wrapper = await mountSuspended(AdminPaymentFunnel, {
      props: { runtime: 'cloudflare' }
    })
    await flushPromises()

    const errorBox = wrapper.find('[data-testid="payment-funnel-error"]')
    expect(errorBox.exists()).toBe(true)
    expect(errorBox.text()).toContain('Fallo al conectar con el servidor')
  })

  it('displays privacy badge affirming no prohibited data (PAN/CVV/PII)', async () => {
    mocks.request.mockResolvedValueOnce(samplePaymentFunnelData)

    const wrapper = await mountSuspended(AdminPaymentFunnel, {
      props: { runtime: 'cloudflare' }
    })
    await flushPromises()

    const privacyBadge = wrapper.find('[data-testid="payment-funnel-privacy-notice"]')
    expect(privacyBadge.exists()).toBe(true)
    expect(privacyBadge.text()).toContain('Sin datos prohibidos')
  })
})

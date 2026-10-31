import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import AdminMarketingObservabilityPanel from '../../app/components/AdminMarketingObservabilityPanel.vue'
import '#app/nuxt-vitest-app-entry'

const mocks = vi.hoisted(() => ({ request: vi.fn() }))
mockNuxtImport('useRequestFetch', () => () => mocks.request)

const mockWorkflows = [
  {
    workflowId: 'welcome_series',
    workflowName: 'Serie de Bienvenida',
    triggers: 120,
    suppressions: 15,
    deliveries: 105,
    conversions: 21,
    complaints: 1,
    errors: 0,
    totalGrossRevenueCents: 315000,
    totalCostCents: 150000,
    totalDiscountCents: 31500,
    totalNetMarginCents: 133500,
    marginBasisPoints: 4238,
    deliveryRatePercent: 87.5,
    conversionRatePercent: 20.0,
    complaintRatePercent: 0.95,
    errorRatePercent: 0.0,
    suppressionBreakdown: {
      fatigue_limit: 8,
      quiet_hours: 4,
      no_consent: 3
    },
    errorBreakdown: {},
    hasHighErrorRate: false,
    hasHighComplaintRate: false,
    hasNegativeMargin: false
  },
  {
    workflowId: 'abandoned_cart',
    workflowName: 'Recuperación Carrito',
    triggers: 85,
    suppressions: 10,
    deliveries: 70,
    conversions: 14,
    complaints: 0,
    errors: 5,
    totalGrossRevenueCents: 210000,
    totalCostCents: 90000,
    totalDiscountCents: 21000,
    totalNetMarginCents: 99000,
    marginBasisPoints: 4714,
    deliveryRatePercent: 82.35,
    conversionRatePercent: 20.0,
    complaintRatePercent: 0.0,
    errorRatePercent: 5.88,
    suppressionBreakdown: {
      inventory_out_of_stock: 6,
      cooldown_active: 4
    },
    errorBreakdown: {
      provider_timeout: 5
    },
    hasHighErrorRate: true,
    hasHighComplaintRate: false,
    hasNegativeMargin: false
  }
]

describe('AdminMarketingObservabilityPanel Component (OBS-027)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders per-workflow observability table with all 7 dimensions', async () => {
    mocks.request.mockResolvedValueOnce({ workflows: mockWorkflows })

    const wrapper = await mountSuspended(AdminMarketingObservabilityPanel)
    await flushPromises()

    expect(wrapper.text()).toContain('Observabilidad de Automatizaciones y Marketing (OBS-027)')
    // Dimensions should be present in table headers/cards
    expect(wrapper.text()).toContain('Disparos')
    expect(wrapper.text()).toContain('Supresión')
    expect(wrapper.text()).toContain('Entrega')
    expect(wrapper.text()).toContain('Conversión')
    expect(wrapper.text()).toContain('Quejas')
    expect(wrapper.text()).toContain('Descuento / Margen')
    expect(wrapper.text()).toContain('Errores')

    // Workflows present
    expect(wrapper.text()).toContain('Serie de Bienvenida')
    expect(wrapper.text()).toContain('Recuperación Carrito')
  })

  it('displays financial metrics (net margin, discount, bps) accurately', async () => {
    mocks.request.mockResolvedValueOnce({ workflows: mockWorkflows })

    const wrapper = await mountSuspended(AdminMarketingObservabilityPanel)
    await flushPromises()

    // 1335.00 € net margin, 315.00 € discount, 42.38% (4238 bps)
    expect(wrapper.text()).toMatch(/1\.?335,00/)
    expect(wrapper.text()).toContain('315,00')
    expect(wrapper.text()).toContain('42,38%')
  })

  it('highlights health warning when workflow has high error rate', async () => {
    mocks.request.mockResolvedValueOnce({ workflows: mockWorkflows })

    const wrapper = await mountSuspended(AdminMarketingObservabilityPanel)
    await flushPromises()

    // abandoned_cart has high error rate warning
    expect(wrapper.text()).toContain('Alerta de Error')
  })

  it('renders empty state when no workflows are returned', async () => {
    mocks.request.mockResolvedValueOnce({ workflows: [] })

    const wrapper = await mountSuspended(AdminMarketingObservabilityPanel)
    await flushPromises()

    expect(wrapper.text()).toContain('No hay eventos de telemetría de automatización registrados.')
  })

  it('displays error state when API request fails', async () => {
    mocks.request.mockRejectedValueOnce(new Error('Failed to fetch observability metrics'))

    const wrapper = await mountSuspended(AdminMarketingObservabilityPanel)
    await flushPromises()

    expect(wrapper.text()).toContain('Error al cargar la observabilidad de automatizaciones')
  })
})

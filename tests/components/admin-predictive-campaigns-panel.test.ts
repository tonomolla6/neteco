import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import AdminPredictiveCampaignsPanel from '../../app/components/AdminPredictiveCampaignsPanel.vue'
import '#app/nuxt-vitest-app-entry'

const mocks = vi.hoisted(() => ({ request: vi.fn() }))
mockNuxtImport('useRequestFetch', () => () => mocks.request)

const mockMetrics = {
  holdoutImpressions: 120,
  holdoutClicks: 15,
  holdoutConversions: 8,
  holdoutMarginCents: 15400,
  holdoutRevenueCents: 52000,
  testImpressions: 125,
  testClicks: 24,
  testConversions: 16,
  testMarginCents: 38200,
  testRevenueCents: 110000,
  incrementalMarginLiftCents: 22800,
  conversionLiftPercent: 92.5,
  ctrLiftPercent: 53.8
}

const mockRules = [
  {
    id: 'rule-turia-01',
    campaignId: 'camp-b2b-turia-vip',
    name: 'Auto-tune Lavanderías Industriales',
    maxDiscountPercent: 20,
    frequencyCapDays: 7,
    budgetCapCents: 300000,
    currentSpendCents: 85000,
    autoApprovalMaxDiscount: 10,
    killSwitchActive: false,
    status: 'active',
    version: 1,
    createdAt: '2026-10-29T10:00:00Z',
    updatedAt: '2026-10-29T10:00:00Z'
  }
]

describe('AdminPredictiveCampaignsPanel.vue', () => {
  beforeEach(() => mocks.request.mockReset())

  it('renders incremental lift metrics and guardrails table', async () => {
    mocks.request.mockImplementation((url: unknown) => {
      const u = typeof url === 'string' ? url : ''
      if (u.includes('/metrics')) return Promise.resolve({ metrics: mockMetrics })
      if (u.includes('/rules')) return Promise.resolve({ rules: mockRules })
      return Promise.resolve({})
    })

    const wrapper = await mountSuspended(AdminPredictiveCampaignsPanel)
    await flushPromises()

    expect(wrapper.text()).toContain('Personalización Predictiva & Optimización de Campañas')
    expect(wrapper.text()).toContain('+228.00 €')
    expect(wrapper.text()).toContain('+92.5%')
    expect(wrapper.text()).toContain('Auto-tune Lavanderías Industriales')
    expect(wrapper.text()).toContain('OPERATIVO')
  })

  it('displays empty state when no rules exist', async () => {
    mocks.request.mockImplementation((url: unknown) => {
      const u = typeof url === 'string' ? url : ''
      if (u.includes('/metrics')) return Promise.resolve({ metrics: null })
      if (u.includes('/rules')) return Promise.resolve({ rules: [] })
      return Promise.resolve({})
    })

    const wrapper = await mountSuspended(AdminPredictiveCampaignsPanel)
    await flushPromises()

    expect(wrapper.find('[data-test="empty-rules"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('No hay reglas de optimización automáticas registradas')
  })

  it('toggles emergency kill switch successfully', async () => {
    mocks.request.mockImplementation((url: unknown, opts?: { method?: string; body?: unknown }) => {
      const u = typeof url === 'string' ? url : ''
      if (opts?.method === 'POST' && u.includes('/kill-switch')) {
        return Promise.resolve({ rule: { ...mockRules[0], killSwitchActive: true, status: 'killed' } })
      }
      if (u.includes('/metrics')) return Promise.resolve({ metrics: mockMetrics })
      if (u.includes('/rules')) return Promise.resolve({ rules: [mockRules[0]] })
      return Promise.resolve({})
    })

    const wrapper = await mountSuspended(AdminPredictiveCampaignsPanel)
    await flushPromises()

    const btn = wrapper.find('[data-test="kill-switch-btn-rule-turia-01"]')
    expect(btn.exists()).toBe(true)
    await btn.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('Kill switch ACTIVADO')
  })
})

import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AdminMarketingAutomations from '../../app/components/AdminMarketingAutomations.vue'
import '#app/nuxt-vitest-app-entry'

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  runtime: 'cloudflare',
  owner: null as unknown,
  nav: null as unknown
}))

mockNuxtImport('useRequestFetch', () => () => mocks.request)
mockNuxtImport('useUserSession', () => () => mocks.owner)
mockNuxtImport('useRuntimeConfig', () => () => ({
  app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
  public: { serverRuntime: mocks.runtime }
}))

const mockPolicy = {
  id: 'global',
  version: 1,
  welcomeSeriesEnabled: true,
  welcomeDiscountEnabled: true,
  welcomeDiscountPercent: 10,
  welcomeDiscountMaxCents: 1500,
  welcomeMinOrderCents: 5000,
  welcomeMarginFloorBasisPoints: 2000,
  winbackEnabled: true,
  winbackInactivityDays: 90,
  winbackCooldownDays: 90,
  winbackDiscountPercent: 10,
  winbackDiscountMaxCents: 2000,
  winbackMarginFloorBasisPoints: 2000,
  postpurchaseEnabled: true,
  postpurchaseDelayHours: 12,
  updatedAt: '2026-10-29T12:00:00Z',
  updatedBy: '10000000-0000-4000-8000-000000000001'
}

const mockOverview = {
  policy: mockPolicy,
  counts: {
    welcomeDispatches: {
      professional_value: 12,
      categories_overview: 10,
      local_service: 9,
      preferences_prompt: 8,
      welcome_discount: 7
    },
    winbackEvaluations: {
      eligible: 5,
      excluded_incidents: 2,
      excluded_debt: 3,
      excluded_suppressed: 4,
      excluded_cooldown: 1,
      dispatched: 5
    },
    postpurchaseDispatches: {
      transactional_safety_usage: 45,
      commercial_replenishment: 28
    }
  }
}

describe('AdminMarketingAutomations component (MKT-015, MKT-018, MKT-019)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.request.mockImplementation(async (url: string, opts?: { method?: string; body?: unknown }) => {
      if (url === '/api/admin/marketing-automations/overview') {
        return mockOverview
      }
      if (url === '/api/admin/marketing-automations/policy') {
        if (opts?.method === 'PUT') {
          return {
            commandId: 'cmd-1',
            action: 'update_policy',
            appliedVersion: 2,
            payloadHash: 'a'.repeat(64),
            recordedAt: '2026-10-29T12:00:00Z'
          }
        }
        return mockPolicy
      }
      if (url === '/api/admin/marketing-automations/welcome/dispatch') {
        return {
          id: 'w-1',
          customerId: '30000000-0000-4000-8000-000000000001',
          step: 'professional_value',
          discountCode: null,
          discountCentsCap: null,
          minOrderCents: null,
          marginFloorBasisPoints: null,
          status: 'delivered',
          recipientEmailHash: 'a'.repeat(64),
          dispatchedAt: '2026-10-29T12:00:00Z',
          createdAt: '2026-10-29T12:00:00Z'
        }
      }
      if (url === '/api/admin/marketing-automations/winback/evaluate') {
        return {
          id: 'wb-1',
          customerId: '30000000-0000-4000-8000-000000000001',
          lastOrderId: '50000000-0000-4000-8000-000000000001',
          lastOrderAt: '2026-07-01T10:00:00Z',
          daysInactive: 120,
          eligibilityStatus: 'eligible',
          exclusionReason: null,
          discountCode: 'VUELVE-ABC1234',
          discountPercent: 10,
          discountMaxCents: 2000,
          marginFloorBasisPoints: 2000,
          dispatchedAt: '2026-10-29T12:00:00Z',
          createdAt: '2026-10-29T12:00:00Z'
        }
      }
      if (url === '/api/admin/marketing-automations/postpurchase/dispatch') {
        return [
          {
            id: 'pp-1',
            orderId: '50000000-0000-4000-8000-000000000001',
            customerId: '30000000-0000-4000-8000-000000000001',
            streamType: 'transactional_safety_usage',
            status: 'delivered',
            contentJson: '{"dilutionProtocol":"1:20"}',
            hasMarketingConsent: true,
            dispatchedAt: '2026-10-29T12:00:00Z',
            createdAt: '2026-10-29T12:00:00Z'
          },
          {
            id: 'pp-2',
            orderId: '50000000-0000-4000-8000-000000000001',
            customerId: '30000000-0000-4000-8000-000000000001',
            streamType: 'commercial_replenishment',
            status: 'delivered',
            contentJson: '{"estimatedReplenishmentDays":60}',
            hasMarketingConsent: true,
            dispatchedAt: '2026-10-29T12:00:00Z',
            createdAt: '2026-10-29T12:00:00Z'
          }
        ]
      }
      throw new Error(`Unhandled route ${url}`)
    })
  })

  it('renders all three requirement tabs and sections', async () => {
    const wrapper = await mountSuspended(AdminMarketingAutomations)
    await flushPromises()

    expect(wrapper.text()).toContain('Automatizaciones de Marketing')
    expect(wrapper.text()).toContain('MKT-015: Serie de Bienvenida')
    expect(wrapper.text()).toContain('MKT-018: Win-back por Inactividad')
    expect(wrapper.text()).toContain('MKT-019: Postcompra Útil')
  })

  it('shows policy configuration form with margin floor controls', async () => {
    const wrapper = await mountSuspended(AdminMarketingAutomations)
    await flushPromises()

    const discountInput = wrapper.find('input[name="welcomeDiscountPercent"]')
    expect(discountInput.exists()).toBe(true)
    expect((discountInput.element as HTMLInputElement).value).toBe('10')

    const winbackDaysInput = wrapper.find('input[name="winbackInactivityDays"]')
    expect(winbackDaysInput.exists()).toBe(true)
    expect((winbackDaysInput.element as HTMLInputElement).value).toBe('90')
  })

  it('allows triggering welcome series simulation', async () => {
    const wrapper = await mountSuspended(AdminMarketingAutomations)
    await flushPromises()

    const triggerWelcomeBtn = wrapper.find('button[data-test="trigger-welcome"]')
    expect(triggerWelcomeBtn.exists()).toBe(true)
    await triggerWelcomeBtn.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('Serie de bienvenida entregada')
  })

  it('allows triggering win-back evaluation and displays exclusions', async () => {
    const wrapper = await mountSuspended(AdminMarketingAutomations)
    await flushPromises()

    const triggerWinbackBtn = wrapper.find('button[data-test="trigger-winback"]')
    expect(triggerWinbackBtn.exists()).toBe(true)
    await triggerWinbackBtn.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('Evaluación de win-back completada')
    expect(wrapper.text()).toContain('VUELVE-ABC1234')
  })

  it('allows triggering postpurchase simulation showing stream separation', async () => {
    const wrapper = await mountSuspended(AdminMarketingAutomations)
    await flushPromises()

    const triggerPostpurchaseBtn = wrapper.find('button[data-test="trigger-postpurchase"]')
    expect(triggerPostpurchaseBtn.exists()).toBe(true)
    await triggerPostpurchaseBtn.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('Flujo postcompra emitido')
    expect(wrapper.text()).toContain('transactional_safety_usage')
    expect(wrapper.text()).toContain('commercial_replenishment')
  })

  it('renders accessible labels and roles', async () => {
    const wrapper = await mountSuspended(AdminMarketingAutomations)
    await flushPromises()

    expect(wrapper.find('main, [role="region"], section').exists()).toBe(true)
    const inputs = wrapper.findAll('input')
    for (const input of inputs) {
      expect(input.attributes('aria-label') || input.attributes('id')).toBeTruthy()
    }
  })
})

import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import AdminSendTimeOptimizationPanel from '../../app/components/AdminSendTimeOptimizationPanel.vue'
import '#app/nuxt-vitest-app-entry'

const mocks = vi.hoisted(() => ({ request: vi.fn() }))
mockNuxtImport('useRequestFetch', () => () => mocks.request)

const mockPolicy = {
  id: 'global',
  version: 1,
  holdoutRateBasisPoints: 1000,
  minHoursBetweenMarketing: 24,
  maxWeeklyMarketingSends: 2,
  allowedWindowStartHour: 9,
  allowedWindowEndHour: 18,
  updatedAt: '2026-10-29T10:00:00Z',
  updatedBy: '10000000-0000-4000-8000-000000000001'
}

describe('AdminSendTimeOptimizationPanel', () => {
  beforeEach(() => mocks.request.mockReset())

  it('renders policy details, holdout percentage and handles empty decisions', async () => {
    mocks.request.mockImplementation(async (url?: string) => {
      if (String(url ?? '').includes('/policy')) return { policy: mockPolicy }
      return { items: [], total: 0 }
    })

    const wrapper = await mountSuspended(AdminSendTimeOptimizationPanel)
    await flushPromises()

    expect(wrapper.text()).toContain('10%') // 1000 basis points
    expect(wrapper.text()).toContain('09:00')
    expect(wrapper.text()).toContain('18:00')
    expect(wrapper.find('[data-empty-decisions]').exists()).toBe(true)
  })

  it('simulates operational evaluation with immediate zero-delay dispatch', async () => {
    mocks.request.mockImplementation(async (url?: string, _options?: { method?: string; body?: unknown }) => {
      if (String(url ?? '').includes('/evaluate')) {
        return {
          decision: {
            id: 'dec-1',
            messageId: 'msg-factura-001',
            customerId: '30000000-0000-4000-8000-000000000001',
            category: 'operational',
            channel: 'email',
            status: 'sent_immediate',
            scheduledFor: '2026-10-29T10:00:00Z',
            reason: 'operational_immediate',
            holdoutApplied: false,
            consentVerified: true,
            createdAt: '2026-10-29T10:00:00Z'
          }
        }
      }
      if (String(url ?? '').includes('/policy')) return { policy: mockPolicy }
      return { items: [], total: 0 }
    })

    const wrapper = await mountSuspended(AdminSendTimeOptimizationPanel)
    await flushPromises()

    // Trigger evaluate
    const evalBtn = wrapper.get('[data-btn-evaluate]')
    await evalBtn.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('sent_immediate')
  })
})

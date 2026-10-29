import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ReferralAccountPanel from '../../app/components/marketing/ReferralAccountPanel.vue'
import '#app/nuxt-vitest-app-entry'

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  runtime: 'cloudflare'
}))

mockNuxtImport('useRequestFetch', () => () => mocks.request)
mockNuxtImport('useRuntimeConfig', () => () => ({
  app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' },
  public: { serverRuntime: mocks.runtime }
}))

describe('ReferralAccountPanel Component (MKT-026)', () => {
  beforeEach(() => {
    mocks.request.mockReset()
  })

  it('renders terms consent prompt when not enrolled', async () => {
    mocks.request.mockResolvedValueOnce({
      overview: {
        enrolled: false,
        totalAttributions: 0,
        pendingWindowCount: 0,
        pendingRewardCents: 0,
        rewardedCount: 0,
        totalRewardedCents: 0,
        rejectedCount: 0
      }
    })

    const wrapper = await mountSuspended(ReferralAccountPanel)
    await flushPromises()

    expect(wrapper.text()).toContain('Programa de Referidos')
    expect(wrapper.text()).toContain('Términos y condiciones')
    expect(wrapper.find('input[type="checkbox"]').exists()).toBe(true)
    expect(wrapper.find('button[data-testid="enroll-btn"]').exists()).toBe(true)
  })

  it('renders dashboard with unique code, pending window and rewarded stats when enrolled', async () => {
    mocks.request.mockResolvedValueOnce({
      overview: {
        enrolled: true,
        referralCode: 'REF-HOSTEL-99',
        termsVersion: 'terms-2026-v1',
        consentedAt: '2026-10-20T12:00:00Z',
        totalAttributions: 3,
        pendingWindowCount: 1,
        pendingRewardCents: 1500,
        rewardedCount: 2,
        totalRewardedCents: 3000,
        rejectedCount: 0
      }
    })

    const wrapper = await mountSuspended(ReferralAccountPanel)
    await flushPromises()

    expect(wrapper.text()).toContain('REF-HOSTEL-99')
    expect(wrapper.text()).toContain('30,00') // rewarded
    expect(wrapper.text()).toContain('15,00') // pending window
    expect(wrapper.text()).toContain('Ventana de devolución')
  })
})

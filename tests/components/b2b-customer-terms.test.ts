import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import B2BCustomerTerms from '../../app/components/B2BCustomerTerms.vue'
import '#app/nuxt-vitest-app-entry'
const mocks = vi.hoisted(() => ({ request: vi.fn() }))
mockNuxtImport('useRequestFetch', () => () => mocks.request)
const terms = {
  companyId: 'company',
  companyStatus: 'approved',
  paymentDays: 30,
  creditLimitCents: 10000,
  blocked: false,
  version: 1,
  priceListId: 'list',
  priceListName: 'Profesionales',
  exposureCents: 1000,
  availableCents: 9000
}
describe('customer commercial terms', () => {
  it('shows tariff, payment conditions and available credit', async () => {
    mocks.request.mockReset().mockResolvedValue({ terms })
    const wrapper = await mountSuspended(B2BCustomerTerms, { props: { enabled: true, scopeKey: 'a' } })
    await flushPromises()
    expect(wrapper.text()).toContain('Profesionales')
    expect(wrapper.text()).toContain('30 días')
    expect(wrapper.text()).toContain('90,00')
    wrapper.unmount()
  })
  it('hides private information and does not fetch without a live session', async () => {
    mocks.request.mockReset().mockResolvedValue({ terms })
    const wrapper = await mountSuspended(B2BCustomerTerms, { props: { enabled: true, scopeKey: 'a' } })
    await flushPromises()
    await wrapper.setProps({ enabled: false, scopeKey: 'b' })
    expect(wrapper.text()).not.toContain('Profesionales')
    expect(mocks.request).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })
  it('reports an unavailable account read without inventing a balance', async () => {
    mocks.request.mockReset().mockRejectedValue(new Error('offline'))
    const wrapper = await mountSuspended(B2BCustomerTerms, { props: { enabled: true, scopeKey: 'a' } })
    await flushPromises()
    expect(wrapper.find('[role="alert"]').exists()).toBe(true)
    expect(wrapper.text()).not.toContain('90,00')
    wrapper.unmount()
  })
})

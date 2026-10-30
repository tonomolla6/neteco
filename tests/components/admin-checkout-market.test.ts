import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { beforeEach, expect, it, vi } from 'vitest'
import AdminCheckoutMarket from '../../app/components/AdminCheckoutMarket.vue'
import '#app/nuxt-vitest-app-entry'
const mocks = vi.hoisted(() => ({ request: vi.fn() }))
mockNuxtImport('useRequestFetch', () => () => mocks.request)
const profile = {
  market: 'GB',
  currency: 'GBP',
  version: 1,
  exchangeNumerator: 86,
  exchangeDenominator: 100,
  goodsTaxBps: 2000,
  shippingNetMinor: 450,
  shippingTaxBps: 2000,
  termsVersion: 'gb-terms-v1',
  paymentMethods: ['card']
}
beforeEach(() => mocks.request.mockReset())
it('loads a profile and saves with its observed version', async () => {
  mocks.request.mockImplementation(async (url: string, opts?: { method?: string }) =>
    !url ? {} : opts?.method === 'POST' ? { version: 2 } : profile
  )
  const wrapper = await mountSuspended(AdminCheckoutMarket)
  await wrapper.find('input[name=market]').setValue('GB')
  await wrapper.find('form[data-test=load]').trigger('submit')
  await flushPromises()
  expect(wrapper.find('input[name=currency]').element.value).toBe('GBP')
  await wrapper.find('form[data-test=save]').trigger('submit')
  await flushPromises()
  const call = mocks.request.mock.calls.find((c) => c[1]?.method === 'POST')!
  expect(call[0]).toBe('/api/admin/checkout-markets/GB')
  expect(call[1].body).toMatchObject({
    currency: 'GBP',
    expectedVersion: 1,
    termsVersion: 'gb-terms-v1',
    paymentMethods: ['card']
  })
})
it('displays the unavailable profile as an accessible error', async () => {
  mocks.request.mockImplementation(async (url: string) => {
    if (!url) return {}
    throw new Error('unavailable')
  })
  const wrapper = await mountSuspended(AdminCheckoutMarket)
  await wrapper.find('input[name=market]').setValue('GB')
  await wrapper.find('form[data-test=load]').trigger('submit')
  await flushPromises()
  expect(wrapper.find('[role=alert]').exists()).toBe(true)
})

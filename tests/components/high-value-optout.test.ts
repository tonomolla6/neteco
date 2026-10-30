import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { beforeEach, expect, it, vi } from 'vitest'
import HighValueOptOut from '../../app/components/HighValueOptOut.vue'
import '#app/nuxt-vitest-app-entry'
const mocks = vi.hoisted(() => ({ request: vi.fn() }))
mockNuxtImport('useRequestFetch', () => () => mocks.request)
beforeEach(() => mocks.request.mockReset())
it('shows channel status and allows a customer to revoke with the current version', async () => {
  mocks.request.mockImplementation(async (url: string, opts?: { method?: string }) =>
    !url
      ? {}
      : opts?.method === 'POST'
        ? { version: 2, action: 'revoke' }
        : url.endsWith('/sms')
          ? { version: 1, granted: true }
          : { version: 0, granted: false }
  )
  const wrapper = await mountSuspended(HighValueOptOut)
  await flushPromises()
  expect(wrapper.text()).toContain('SMS')
  expect(wrapper.text()).toContain('WhatsApp')
  await wrapper.find('button[data-channel=sms]').trigger('click')
  await flushPromises()
  const post = mocks.request.mock.calls.find((call) => call[1]?.method === 'POST')!
  expect(post[0]).toBe('/api/account/high-value-consent/sms')
  expect(post[1].body).toEqual({ expectedVersion: 1 })
})
it('shows an accessible error instead of actionable stale status', async () => {
  mocks.request.mockImplementation(async (url: string) => {
    if (!url) return {}
    throw new Error('offline')
  })
  const wrapper = await mountSuspended(HighValueOptOut)
  await flushPromises()
  expect(wrapper.find('[role=alert]').exists()).toBe(true)
  expect(wrapper.find('button[data-channel=sms]').exists()).toBe(false)
})

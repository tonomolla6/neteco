import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { expect, it, vi } from 'vitest'
import PaymentTokenRemoval from '../../app/components/PaymentTokenRemoval.vue'
import '#app/nuxt-vitest-app-entry'
const mocks = vi.hoisted(() => ({ request: vi.fn() }))
mockNuxtImport('useRequestFetch', () => () => mocks.request)
it('shows pending provider confirmation after reloading the page', async () => {
  mocks.request.mockResolvedValue({
    tokens: [],
    pending: [
      {
        id: '40000000-0000-4000-8000-000000000022',
        status: 'removal_pending',
        version: 2,
        createdAt: '2026-10-29T12:00:00Z'
      }
    ]
  })
  const wrapper = await mountSuspended(PaymentTokenRemoval)
  await flushPromises()
  expect(wrapper.text()).toContain('pendiente de confirmación')
  expect(wrapper.text()).not.toContain('No tienes métodos de pago guardados')
  expect(wrapper.find('button').exists()).toBe(false)
})

import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { ref } from 'vue'
import { expect, it, vi } from 'vitest'
import PaymentTokenRemoval from '../../app/components/PaymentTokenRemoval.vue'
import '#app/nuxt-vitest-app-entry'
const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  auth: null as unknown as {
    user: { value: { id: string } }
    session: { value: { sessionId: string; sessionVersion: number } }
    loggedIn: { value: boolean }
    ready: { value: boolean }
  }
}))
mockNuxtImport('useRequestFetch', () => () => mocks.request)
mockNuxtImport('useUserSession', () => () => mocks.auth)
const token = {
  id: '40000000-0000-4000-8000-000000000022',
  status: 'active',
  version: 1,
  createdAt: '2026-10-29T12:00:00Z'
}
function auth() {
  return {
    user: ref({ id: 'buyer-a' }),
    session: ref({ sessionId: 'session-a', sessionVersion: 1 }),
    loggedIn: ref(true),
    ready: ref(true)
  }
}
it('discards a stale list response after a change of session', async () => {
  mocks.auth = auth()
  let resolveOld!: (value: unknown) => void
  mocks.request
    .mockReset()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve
        })
    )
    .mockResolvedValueOnce({ tokens: [] })
  const wrapper = await mountSuspended(PaymentTokenRemoval)
  mocks.auth.user.value = { id: 'buyer-b' }
  mocks.auth.session.value = { sessionId: 'session-b', sessionVersion: 1 }
  await flushPromises()
  resolveOld({ tokens: [token] })
  await flushPromises()
  expect(wrapper.text()).toContain('No tienes métodos de pago guardados')
  expect(wrapper.text()).not.toContain('Método guardado 1')
  expect(mocks.request).toHaveBeenCalledTimes(2)
})
it('discards an old account removal result after a session change', async () => {
  mocks.auth = auth()
  let resolveWrite!: (value: unknown) => void
  mocks.request
    .mockReset()
    .mockResolvedValueOnce({ tokens: [token] })
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveWrite = resolve
        })
    )
    .mockResolvedValueOnce({ tokens: [] })
  const wrapper = await mountSuspended(PaymentTokenRemoval)
  await flushPromises()
  await wrapper.get('button').trigger('click')
  mocks.auth.user.value = { id: 'buyer-b' }
  mocks.auth.session.value = { sessionId: 'session-b', sessionVersion: 1 }
  await flushPromises()
  resolveWrite({ tokenId: token.id, version: 2, outcome: 'removal_pending' })
  await flushPromises()
  expect(wrapper.text()).toContain('No tienes métodos de pago guardados')
  expect(wrapper.text()).not.toContain('pendiente de confirmación')
  expect(wrapper.find('button').exists()).toBe(false)
})

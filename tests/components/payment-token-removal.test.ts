import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { beforeEach, expect, it, vi } from 'vitest'
import PaymentTokenRemoval from '../../app/components/PaymentTokenRemoval.vue'
import '#app/nuxt-vitest-app-entry'
const mocks = vi.hoisted(() => ({ request: vi.fn() }))
mockNuxtImport('useRequestFetch', () => () => mocks.request)
const id = '40000000-0000-4000-8000-000000000022'
beforeEach(() => {
  mocks.request.mockReset()
})
it('shows an empty state for no stored payment methods', async () => {
  mocks.request.mockResolvedValue({ tokens: [] })
  const wrapper = await mountSuspended(PaymentTokenRemoval)
  await flushPromises()
  expect(wrapper.text()).toContain('No tienes métodos de pago guardados')
})
it('reports a read failure and allows retry', async () => {
  mocks.request.mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce({ tokens: [] })
  const wrapper = await mountSuspended(PaymentTokenRemoval)
  await flushPromises()
  expect(wrapper.text()).toContain('No hemos podido cargar')
  await wrapper.get('button').trigger('click')
  await flushPromises()
  expect(wrapper.text()).toContain('No tienes métodos de pago guardados')
})
it('requests deletion and describes it as pending confirmation', async () => {
  mocks.request
    .mockResolvedValueOnce({ tokens: [{ id, status: 'active', version: 1, createdAt: '2026-10-29T12:00:00Z' }] })
    .mockResolvedValueOnce({ tokenId: id, version: 2, outcome: 'removal_pending' })
    .mockResolvedValueOnce({ tokens: [] })
  const wrapper = await mountSuspended(PaymentTokenRemoval)
  await flushPromises()
  await wrapper.get('button').trigger('click')
  await flushPromises()
  expect(mocks.request).toHaveBeenCalledWith(
    '/api/account/payment-tokens',
    expect.objectContaining({ method: 'POST', body: expect.objectContaining({ tokenId: id, expectedVersion: 1 }) })
  )
  expect(wrapper.text()).toContain('pendiente de confirmación')
})
it('retains the same command after an uncertain failure', async () => {
  mocks.request
    .mockResolvedValueOnce({ tokens: [{ id, status: 'active', version: 1, createdAt: '2026-10-29T12:00:00Z' }] })
    .mockRejectedValueOnce(new Error('network'))
    .mockResolvedValueOnce({ tokenId: id, version: 2, outcome: 'removal_pending' })
    .mockResolvedValueOnce({ tokens: [] })
  const wrapper = await mountSuspended(PaymentTokenRemoval)
  await flushPromises()
  await wrapper.get('button').trigger('click')
  await flushPromises()
  expect(wrapper.text()).toContain('No hemos podido confirmar')
  await wrapper.get('button').trigger('click')
  await flushPromises()
  expect(mocks.request.mock.calls[1]![1].body.commandId).toBe(mocks.request.mock.calls[2]![1].body.commandId)
})
it('rejects malformed server lists instead of rendering them', async () => {
  mocks.request.mockResolvedValue({ tokens: [{ id, status: 'active', version: 1, providerToken: 'secret' }] })
  const wrapper = await mountSuspended(PaymentTokenRemoval)
  await flushPromises()
  expect(wrapper.text()).toContain('No hemos podido cargar')
  expect(wrapper.text()).not.toContain('secret')
})

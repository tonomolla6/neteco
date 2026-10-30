import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { ref } from 'vue'
import { beforeEach, expect, it, vi } from 'vitest'
import PayGoldLinkPanel from '../../app/components/PayGoldLinkPanel.vue'
import '#app/nuxt-vitest-app-entry'
const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  auth: null as unknown as {
    user: { value: { id: string } }
    session: { value: { sessionId: string; sessionVersion: number } }
    loggedIn: { value: boolean }
  }
}))
mockNuxtImport('useRequestFetch', () => () => mocks.request)
mockNuxtImport('useUserSession', () => () => mocks.auth)
const quoteId = '68000000-0000-4000-8000-000000000001',
  orderId = '68000000-0000-4000-8000-000000000002'
const receipt = { action: 'convert' as const, quoteId, orderId, version: 4 }
const future = () => new Date(Date.now() + 600000).toISOString().replace(/\.\d{3}Z$/, 'Z')
beforeEach(() => {
  mocks.auth = {
    user: ref({ id: 'buyer-a' }),
    session: ref({ sessionId: 'session-a', sessionVersion: 1 }),
    loggedIn: ref(true)
  }
  mocks.request.mockReset()
  mocks.request.mockImplementation(async (url: string, options?: { method?: string; body?: { expiresAt: string } }) => {
    if (url === `/api/account/sales-quotes/${quoteId}`)
      return {
        id: quoteId,
        version: 4,
        status: 'converted',
        orderId,
        validUntil: future(),
        total: { grossCents: 1500 }
      }
    if (url === `/api/orders/${orderId}`)
      return {
        id: orderId,
        orderStatus: 'awaiting_payment',
        inventoryStatus: 'reserved',
        reservationExpiresAt: future(),
        total: 1500
      }
    if (url === '/api/account/paygold-links' && options?.method === 'POST')
      return {
        quoteId,
        orderId,
        paymentIntentId: '68000000-0000-4000-8000-000000000004',
        amountCents: 1500,
        expiresAt: options.body!.expiresAt,
        url: 'https://paygold.example.test/link'
      }
    throw new Error('unexpected request')
  })
})
it('waits for a confirmed converted quote', async () => {
  const wrapper = await mountSuspended(PayGoldLinkPanel, { props: { receipt: null } })
  await flushPromises()
  expect(mocks.request).not.toHaveBeenCalled()
  expect(wrapper.text()).toContain('Crea un pedido')
})
it('creates a link only after refreshing the quote and the reserved order', async () => {
  const wrapper = await mountSuspended(PayGoldLinkPanel, { props: { receipt } })
  await flushPromises()
  await wrapper.get('button').trigger('click')
  await flushPromises()
  expect(wrapper.text()).toContain('Enlace de pago')
  expect(wrapper.get('a').attributes('href')).toBe('https://paygold.example.test/link')
  expect(mocks.request).toHaveBeenCalledWith(
    '/api/account/paygold-links',
    expect.objectContaining({ method: 'POST', body: expect.objectContaining({ quoteId, orderId, expectedVersion: 4 }) })
  )
})
it('retries an uncertain request with the same command and expiry', async () => {
  const base = mocks.request.getMockImplementation()!
  let failed = false
  mocks.request.mockImplementation(async (url: string, options: unknown) => {
    if (url === '/api/account/paygold-links' && !failed) {
      failed = true
      throw new Error('network')
    }
    return base(url, options)
  })
  const wrapper = await mountSuspended(PayGoldLinkPanel, { props: { receipt } })
  await flushPromises()
  await wrapper.get('button').trigger('click')
  await flushPromises()
  expect(wrapper.text()).toContain('No hemos podido confirmar')
  await wrapper.get('button').trigger('click')
  await flushPromises()
  const calls = mocks.request.mock.calls.filter(([url]) => url === '/api/account/paygold-links')
  expect(calls).toHaveLength(2)
  expect(calls[0]![1].body).toEqual(calls[1]![1].body)
})
it('refuses mismatched order facts before sending a payment request', async () => {
  const base = mocks.request.getMockImplementation()!
  mocks.request.mockImplementation(async (url: string, options: unknown) =>
    url === `/api/orders/${orderId}`
      ? {
          id: orderId,
          orderStatus: 'awaiting_payment',
          inventoryStatus: 'reserved',
          reservationExpiresAt: future(),
          total: 1499
        }
      : base(url, options)
  )
  const wrapper = await mountSuspended(PayGoldLinkPanel, { props: { receipt } })
  await flushPromises()
  expect(wrapper.text()).toContain('No hemos podido verificar')
  expect(wrapper.find('button').exists()).toBe(true)
  expect(mocks.request.mock.calls.some(([url]) => url === '/api/account/paygold-links')).toBe(false)
})
it('does not display a stale response after switching identity', async () => {
  const base = mocks.request.getMockImplementation()!
  let resolve!: (value: unknown) => void
  mocks.request.mockImplementation(async (url: string, options: unknown) =>
    url === '/api/account/paygold-links'
      ? new Promise((r) => {
          resolve = r
        })
      : base(url, options)
  )
  const wrapper = await mountSuspended(PayGoldLinkPanel, { props: { receipt } })
  await flushPromises()
  await wrapper.get('button').trigger('click')
  mocks.auth.user.value = { id: 'buyer-b' }
  mocks.auth.session.value = { sessionId: 'session-b', sessionVersion: 1 }
  await flushPromises()
  resolve({
    quoteId,
    orderId,
    paymentIntentId: '68000000-0000-4000-8000-000000000004',
    amountCents: 1500,
    expiresAt: future(),
    url: 'https://paygold.example.test/link'
  })
  await flushPromises()
  expect(wrapper.find('a').exists()).toBe(false)
})
it('recovers a pending command after reopening a converted quote', async () => {
  const base = mocks.request.getMockImplementation()!
  const commandId = '68000000-0000-4000-8000-000000000099'
  const expiresAt = future()
  mocks.request.mockImplementation(async (url: string, options: unknown) => {
    if (url.startsWith('/api/account/paygold-links/recover?'))
      return { attempt: { quoteId, orderId, expectedVersion: 4, commandId, expiresAt } }
    return base(url, options)
  })
  const wrapper = await mountSuspended(PayGoldLinkPanel, { props: { receipt: null } })
  await wrapper.get('input').setValue(quoteId)
  await wrapper.get('form').trigger('submit')
  await flushPromises()
  await wrapper.get('button[data-testid="paygold-issue"]').trigger('click')
  await flushPromises()
  expect(mocks.request).toHaveBeenCalledWith(
    '/api/account/paygold-links',
    expect.objectContaining({
      method: 'POST',
      body: { quoteId, orderId, expectedVersion: 4, commandId, expiresAt }
    })
  )
  expect(wrapper.find('a').exists()).toBe(true)
})
it('can open a different converted quote after one has already been opened', async () => {
  const base = mocks.request.getMockImplementation()!
  const otherQuote = '68000000-0000-4000-8000-000000000010'
  const otherOrder = '68000000-0000-4000-8000-000000000011'
  mocks.request.mockImplementation(async (url: string, options: unknown) => {
    if (url === `/api/account/sales-quotes/${otherQuote}`)
      return {
        id: otherQuote,
        version: 3,
        status: 'converted',
        orderId: otherOrder,
        validUntil: future(),
        total: { grossCents: 1200 }
      }
    if (url === `/api/orders/${otherOrder}`)
      return {
        id: otherOrder,
        orderStatus: 'awaiting_payment',
        inventoryStatus: 'reserved',
        reservationExpiresAt: future(),
        total: 1200
      }
    if (url.startsWith('/api/account/paygold-links/recover?')) return { attempt: null }
    return base(url, options)
  })
  const wrapper = await mountSuspended(PayGoldLinkPanel, { props: { receipt: null } })
  await wrapper.get('input').setValue(quoteId)
  await wrapper.get('form').trigger('submit')
  await flushPromises()
  await wrapper.get('input').setValue(otherQuote)
  await wrapper.get('form').trigger('submit')
  await flushPromises()
  expect(mocks.request.mock.calls.some(([url]) => url === `/api/orders/${otherOrder}`)).toBe(true)
  expect(wrapper.find('[data-testid="paygold-issue"]').exists()).toBe(true)
})
it('clears the manually entered quote when the account changes', async () => {
  const wrapper = await mountSuspended(PayGoldLinkPanel, { props: { receipt: null } })
  await wrapper.get('input').setValue(quoteId)
  mocks.auth.user.value = { id: 'buyer-b' }
  mocks.auth.session.value = { sessionId: 'session-b', sessionVersion: 1 }
  await flushPromises()
  expect((wrapper.get('input').element as HTMLInputElement).value).toBe('')
})

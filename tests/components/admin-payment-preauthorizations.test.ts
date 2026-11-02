import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import AdminPaymentPreauthorizations from '../../app/components/AdminPaymentPreauthorizations.vue'
import '#app/nuxt-vitest-app-entry'

const mocks = vi.hoisted(() => ({ request: vi.fn() }))
mockNuxtImport('useRequestFetch', () => () => mocks.request)

const samplePreauth = {
  id: '55555555-5555-4555-8555-555555555555',
  orderId: '33333333-3333-4333-8333-333333333333',
  merchantOrder: 'ORD-12345',
  amountCents: 4500,
  reasonCode: 'delayed_fulfillment',
  justification: 'Stock bajo demanda validado con almacén',
  requestedBy: 'admin-user',
  status: 'authorized',
  version: 1,
  createdAt: '2026-11-01T12:00:00Z',
  updatedAt: '2026-11-01T12:00:00Z'
}

const apiError = (code: string) => Object.assign(new Error(code), { data: { error: { code } } })

const mount = async () => {
  const wrapper = await mountSuspended(AdminPaymentPreauthorizations)
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  mocks.request.mockReset()
})

describe('AdminPaymentPreauthorizations (PAY-021)', () => {
  it('shows error when searching with invalid order id or server error', async () => {
    const wrapper = await mount()
    mocks.request.mockRejectedValueOnce(apiError('not_found'))

    await wrapper.find('[data-test="search-order-id"]').setValue('33333333-3333-4333-8333-333333333333')
    await wrapper.find('[data-test="search-btn"]').trigger('click')
    await flushPromises()

    expect(wrapper.find('[role="alert"]').text()).toContain('not_found')
  })

  it('renders preauthorizations list and handles capture', async () => {
    const wrapper = await mount()
    mocks.request.mockResolvedValueOnce({ preauthorizations: [samplePreauth] })

    await wrapper.find('[data-test="search-order-id"]').setValue('33333333-3333-4333-8333-333333333333')
    await wrapper.find('[data-test="search-btn"]').trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('Preautorizaciones de pago')
    expect(wrapper.text()).toContain('ORD-12345')
    expect(wrapper.text().replace(/\u00a0/g, ' ')).toContain('45,00 €')
    expect(wrapper.text()).toContain('authorized')

    // Capture
    mocks.request.mockResolvedValueOnce({
      ...samplePreauth,
      status: 'captured',
      version: 2
    })
    await wrapper.find('[data-test="capture-btn"]').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-test="success-banner"]').text()).toContain('capturada')
  })

  it('requests a new preauthorization successfully', async () => {
    const wrapper = await mount()
    mocks.request
      .mockResolvedValueOnce({
        ...samplePreauth,
        id: 'new-preauth-id'
      })
      .mockResolvedValueOnce({
        preauthorizations: [{ ...samplePreauth, id: 'new-preauth-id' }]
      })

    await wrapper.find('[data-test="new-order-id"]').setValue('33333333-3333-4333-8333-333333333333')
    await wrapper.find('[data-test="new-amount"]').setValue(5000)
    await wrapper.find('[data-test="new-reason-code"]').setValue('delayed_fulfillment')
    await wrapper.find('[data-test="new-justification"]').setValue('Pedido especial química industrial')
    await wrapper.find('[data-test="request-preauth-btn"]').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-test="success-banner"]').text()).toContain('solicitada')
  })
})

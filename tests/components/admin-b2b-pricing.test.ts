import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import AdminB2BPricing from '../../app/components/AdminB2BPricing.vue'
import '#app/nuxt-vitest-app-entry'
const mocks = vi.hoisted(() => ({ request: vi.fn() }))
mockNuxtImport('useRequestFetch', () => () => mocks.request)
const data = {
  companies: [
    {
      id: '30000000-0000-4000-8000-000000000099',
      legalName: 'Empresa Norte',
      status: 'approved',
      paymentDays: 30,
      creditLimitCents: 12000,
      blocked: 0,
      blockReason: null,
      creditVersion: 1,
      priceListId: null,
      assignmentVersion: null,
      assignmentActive: null,
      exposureCents: 2000
    }
  ],
  priceLists: [
    {
      id: 'list',
      code: 'P',
      name: 'Profesionales',
      status: 'active',
      version: 1,
      validFrom: '2026-01-01T00:00:00Z',
      validUntil: null,
      variantRules: [],
      categoryRules: []
    }
  ]
}
describe('tarifas y crédito B2B', () => {
  it('does not request or display private data without permission', async () => {
    mocks.request.mockReset()
    const wrapper = await mountSuspended(AdminB2BPricing, { props: { enabled: false, scopeKey: 'a' } })
    await flushPromises()
    expect(mocks.request).not.toHaveBeenCalled()
    expect(wrapper.text()).not.toContain('Empresa Norte')
    wrapper.unmount()
  })
  it('shows company credit and tariff once enabled, and clears them on revocation', async () => {
    mocks.request.mockReset().mockResolvedValue(data)
    const wrapper = await mountSuspended(AdminB2BPricing, { props: { enabled: true, scopeKey: 'a' } })
    await flushPromises()
    expect(wrapper.text()).toContain('Empresa Norte')
    expect(wrapper.text()).toContain('Profesionales')
    await wrapper.setProps({ enabled: false, scopeKey: 'b' })
    expect(wrapper.text()).not.toContain('Empresa Norte')
    wrapper.unmount()
  })
  it('sends a versioned credit change with an idempotency key', async () => {
    mocks.request.mockReset().mockResolvedValue(data)
    const wrapper = await mountSuspended(AdminB2BPricing, { props: { enabled: true, scopeKey: 'a' } })
    await flushPromises()
    await wrapper.find('[name="company"]').setValue(data.companies[0]!.id)
    await wrapper.find('[name="reason"]').setValue('Acuerdo actualizado')
    await wrapper.find('[data-test="credit-form"]').trigger('submit')
    await flushPromises()
    const call = mocks.request.mock.calls.find(([url]: [string]) => url.includes('/credit'))
    expect(call?.[1]).toMatchObject({
      method: 'PUT',
      body: {
        expectedVersion: 1,
        paymentDays: 30,
        creditLimitCents: 12000,
        blocked: false,
        blockReason: null,
        reason: 'Acuerdo actualizado'
      }
    })
    expect(call?.[1].headers['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/)
    wrapper.unmount()
  })
  it('lists and reconciles a transfer in the clearly labelled local simulation', async () => {
    const orderId = '30000000-0000-4000-8000-000000000012'
    mocks.request.mockReset().mockImplementation(async (url: string) =>
      url === '/api/admin/b2b'
        ? data
        : url === '/api/admin/b2b/transfers'
          ? {
              enabled: true,
              orders: [
                {
                  orderId,
                  companyId: data.companies[0]!.id,
                  companyName: 'Empresa Norte',
                  totalCents: 2000,
                  outstandingCents: 2000,
                  simulatedOutstandingCents: 2000,
                  paymentDueAt: null
                }
              ]
            }
          : { validationOnly: true, simulatedOutstandingCents: 0 }
    )
    const wrapper = await mountSuspended(AdminB2BPricing, { props: { enabled: true, scopeKey: 'a' } })
    await flushPromises()
    await wrapper.get('[data-test="load-transfers"]').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('Simulación local')
    await wrapper.get('[name="transfer-order"]').setValue(orderId)
    await wrapper.get('[name="transfer-amount"]').setValue('2000')
    await wrapper.get('[name="transfer-reference"]').setValue('FAKE-TEST-1')
    await wrapper.get('[name="transfer-reason"]').setValue('Prueba comercial')
    await wrapper.get('[data-test="transfer-form"]').trigger('submit')
    await flushPromises()
    const call = mocks.request.mock.calls.find(([url]: [string]) => url === `/api/admin/b2b/transfers/${orderId}`)
    expect(call?.[1]).toMatchObject({
      method: 'PUT',
      body: {
        expectedOutstandingCents: 2000,
        amountCents: 2000,
        bankReference: 'FAKE-TEST-1',
        reason: 'Prueba comercial'
      }
    })
    wrapper.unmount()
  })
  it('does not offer fake reconciliation in production', async () => {
    mocks.request
      .mockReset()
      .mockImplementation(async (url: string) => (url === '/api/admin/b2b' ? data : { enabled: false, orders: [] }))
    const wrapper = await mountSuspended(AdminB2BPricing, { props: { enabled: true, scopeKey: 'a' } })
    await flushPromises()
    await wrapper.get('[data-test="load-transfers"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-test="transfer-form"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('conciliación real')
    wrapper.unmount()
  })
})

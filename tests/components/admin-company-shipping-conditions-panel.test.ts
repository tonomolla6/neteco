import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import AdminCompanyShippingConditionsPanel from '../../app/components/AdminCompanyShippingConditionsPanel.vue'
import '#app/nuxt-vitest-app-entry'

const mocks = vi.hoisted(() => ({
  request: vi.fn()
}))

mockNuxtImport('useRequestFetch', () => () => mocks.request)

const sampleConditions = {
  companyId: 'comp-1',
  customMethodsEnabled: true,
  allowedMethods: ['pickup', 'parcel', 'carrier_customer_account'],
  carrierAccountCarrier: 'seur',
  carrierAccountNumber: 'SEUR-ACC-100',
  warehousePickupAllowed: true,
  freeShippingThresholdCents: 5000,
  customDeliveryInstructions: 'Carga por muelle 2',
  version: 1,
  createdAt: '2026-10-29T10:00:00Z',
  updatedAt: '2026-10-29T10:00:00Z'
}

describe('SHP-025: AdminCompanyShippingConditionsPanel component', () => {
  it('renders loading state initially', async () => {
    mocks.request.mockImplementation(() => new Promise(() => {}))
    const wrapper = await mountSuspended(AdminCompanyShippingConditionsPanel, {
      props: { companyId: 'comp-1' }
    })

    expect(wrapper.find('[role="status"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('Cargando condiciones de envío')
  })

  it('renders loaded conditions with carrier account and allowed methods', async () => {
    mocks.request.mockResolvedValueOnce({ conditions: sampleConditions })

    const wrapper = await mountSuspended(AdminCompanyShippingConditionsPanel, {
      props: { companyId: 'comp-1' }
    })
    await flushPromises()

    expect(wrapper.text()).toContain('Condiciones de envío B2B')
    expect(wrapper.text()).toContain('Cuenta de portes')
    expect(wrapper.find('input[name="carrierAccountNumber"]').exists()).toBe(true)
    const accInput = wrapper.find('input[name="carrierAccountNumber"]').element as HTMLInputElement
    expect(accInput.value).toBe('SEUR-ACC-100')
  })

  it('saves updated conditions and emits saved event', async () => {
    mocks.request.mockResolvedValueOnce({ conditions: sampleConditions })
    mocks.request.mockResolvedValueOnce({
      conditions: {
        ...sampleConditions,
        version: 2,
        carrierAccountNumber: 'SEUR-ACC-200'
      }
    })

    const wrapper = await mountSuspended(AdminCompanyShippingConditionsPanel, {
      props: { companyId: 'comp-1' }
    })
    await flushPromises()

    const accInput = wrapper.find('input[name="carrierAccountNumber"]')
    await accInput.setValue('SEUR-ACC-200')

    const saveBtn = wrapper.find('button[type="submit"]')
    await saveBtn.trigger('submit')
    await flushPromises()

    expect(wrapper.text()).toContain('Condiciones guardadas correctamente')
  })

  it('handles version conflict error gracefully', async () => {
    mocks.request.mockResolvedValueOnce({ conditions: sampleConditions })
    mocks.request.mockRejectedValueOnce({
      statusCode: 409,
      data: { error: { code: 'version_conflict' } }
    })

    const wrapper = await mountSuspended(AdminCompanyShippingConditionsPanel, {
      props: { companyId: 'comp-1' }
    })
    await flushPromises()

    const saveBtn = wrapper.find('button[type="submit"]')
    await saveBtn.trigger('submit')
    await flushPromises()

    expect(wrapper.find('[role="alert"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('Conflicto de versiones')
  })
})

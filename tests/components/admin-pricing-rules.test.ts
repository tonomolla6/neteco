import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import AdminPricingRules from '../../app/components/AdminPricingRules.vue'
import '#app/nuxt-vitest-app-entry'

const mocks = vi.hoisted(() => ({ request: vi.fn() }))
mockNuxtImport('useRequestFetch', () => () => mocks.request)

const sampleAutoDiscounts = {
  rules: [
    {
      id: 'rule-1',
      name: 'Descuento Cesta Química 10%',
      scope: 'basket',
      discountType: 'percentage',
      discountValue: 10,
      priority: 10,
      stackable: false,
      status: 'active',
      version: 1
    }
  ]
}

const sampleFreeShipping = {
  rules: [
    {
      id: 'fs-1',
      name: 'Envío Gratis Península > 100€',
      destinationZone: 'peninsula',
      minOrderGrossCents: 10000,
      status: 'active',
      version: 1
    }
  ]
}

const apiError = (code: string) => Object.assign(new Error(code), { data: { error: { code } } })

const mount = async () => {
  const wrapper = await mountSuspended(AdminPricingRules)
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  mocks.request.mockReset()
})

describe('AdminPricingRules (PRI-014/017/018/021)', () => {
  it('loads and lists auto discount rules and free shipping rules', async () => {
    mocks.request.mockResolvedValueOnce(sampleAutoDiscounts).mockResolvedValueOnce(sampleFreeShipping)

    const wrapper = await mount()
    expect(wrapper.text()).toContain('Reglas de precios y envío')
    expect(wrapper.text()).toContain('Descuento Cesta Química 10%')

    await wrapper.findAll('button[role="tab"]')[1]!.trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('Envío Gratis Península > 100€')
  })

  it('shows error state when rules fetch fails', async () => {
    mocks.request.mockRejectedValueOnce(apiError('forbidden'))
    const wrapper = await mount()
    expect(wrapper.find('[role="alert"]').text()).toContain('forbidden')
  })

  it('creates an auto discount rule successfully', async () => {
    mocks.request.mockResolvedValueOnce(sampleAutoDiscounts).mockResolvedValueOnce(sampleFreeShipping)

    const wrapper = await mount()

    mocks.request
      .mockResolvedValueOnce({
        rule: {
          id: 'rule-new',
          name: 'Descuento Desengrasantes 15%',
          status: 'draft',
          version: 1
        }
      })
      .mockResolvedValueOnce({
        rules: [
          ...sampleAutoDiscounts.rules,
          {
            id: 'rule-new',
            name: 'Descuento Desengrasantes 15%',
            scope: 'category',
            discountType: 'percentage',
            discountValue: 15,
            priority: 5,
            stackable: true,
            status: 'draft',
            version: 1
          }
        ]
      })
      .mockResolvedValueOnce(sampleFreeShipping)

    await wrapper.find('[data-test="discount-name"]').setValue('Descuento Desengrasantes 15%')
    await wrapper.find('[data-test="discount-scope"]').setValue('category')
    await wrapper.find('[data-test="discount-type"]').setValue('percentage')
    await wrapper.find('[data-test="discount-value"]').setValue(15)
    await wrapper.find('[data-test="save-discount-btn"]').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-test="notice"]').text()).toContain('guardada con éxito')
  })
})

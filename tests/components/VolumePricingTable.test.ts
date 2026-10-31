import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import VolumePricingTable from '../../app/components/VolumePricingTable.vue'

describe('VolumePricingTable.vue (MKT-023)', () => {
  const baseGrossCents = 5000 // 50.00 €
  const tiers = [
    { minimumQuantity: 6, unitGrossCents: 4500, packagingMultiple: 6, label: 'Caja de 6 uds' },
    { minimumQuantity: 12, unitGrossCents: 4000, packagingMultiple: 12, label: 'Pack 12 uds' }
  ]

  it('renders table before purchase with quantity multiples, prices, and effective discounts', () => {
    const wrapper = mount(VolumePricingTable, {
      props: {
        baseGrossCents,
        taxRateBasisPoints: 2100,
        tiers,
        currentQuantity: 1
      }
    })

    expect(wrapper.find('table').exists()).toBe(true)
    const text = wrapper.text()
    expect(text).toContain('50,00') // base
    expect(text).toContain('45,00') // tier 1
    expect(text).toContain('40,00') // tier 2
    expect(text).toContain('10%') // 10% discount
    expect(text).toContain('20%') // 20% discount
  })

  it('highlights active tier according to selected quantity', () => {
    const wrapper = mount(VolumePricingTable, {
      props: {
        baseGrossCents,
        taxRateBasisPoints: 2100,
        tiers,
        currentQuantity: 8 // should activate tier 1 (6-11)
      }
    })

    const rows = wrapper.findAll('tbody tr')
    expect(rows.length).toBe(3) // base + 2 tiers
    // Row 1 (index 1) is active
    expect(rows[1]?.classes()).toContain('active-tier')
    expect(rows[1]?.text()).toContain('Tramo aplicado')
  })

  it('shows next tier savings incentive when a better tier is available', () => {
    const wrapper = mount(VolumePricingTable, {
      props: {
        baseGrossCents,
        taxRateBasisPoints: 2100,
        tiers,
        currentQuantity: 8
      }
    })

    // From 8 to 12 needs 4 units
    expect(wrapper.text()).toContain('Añade 4 unidades más')
    expect(wrapper.text()).toContain('20%')
  })
})

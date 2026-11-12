import { mountSuspended } from '@nuxt/test-utils/runtime'
import { afterEach, describe, expect, it } from 'vitest'
import ProductFilters from '../../app/components/ProductFilters.vue'
import type { CatalogFilters, ProductFacets } from '../../shared/types/catalog'
import '#app/nuxt-vitest-app-entry'

const filters = (overrides: Partial<CatalogFilters> = {}): CatalogFilters => ({
  brands: [],
  badges: [],
  envases: [],
  tallas: [],
  capacidades: [],
  colors: [],
  medidas: [],
  acabados: [],
  priceMin: null,
  priceMax: null,
  ...overrides
})
const facets = (overrides: Partial<ProductFacets> = {}): ProductFacets => ({
  brands: [
    { value: 'NETECO', n: 3 },
    { value: 'NETTION', n: 2 }
  ],
  badges: [],
  envases: [],
  tallas: [],
  capacidades: [],
  colores: [],
  medidas: [],
  acabados: [],
  price: { min: 100, max: 900 },
  categories: [],
  inStock: 4,
  ...overrides
})
const mounted: Array<{ unmount(): void }> = []
async function mount(props: Record<string, unknown>) {
  const wrapper = await mountSuspended(ProductFilters, { props, global: { stubs: { UIcon: true } } })
  mounted.push(wrapper)
  return wrapper
}
afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount()
})

describe('"Solo en stock" facet', () => {
  it('is the first filter, with how many products it leaves', async () => {
    const wrapper = await mount({ facets: facets(), filters: filters() })
    const sections = wrapper.findAll('[data-filter-section]')
    expect(sections[0]!.attributes('data-filter-section')).toBe('stock')
    expect(wrapper.get('[data-filter-in-stock]').text()).toContain('Solo en stock')
    expect(wrapper.get('[data-filter-in-stock]').text()).toContain('4')
    // Price stays last.
    expect(sections.at(-1)!.attributes('data-filter-section')).toBe('price')
  })

  it('toggles the flag without touching the other filters', async () => {
    const wrapper = await mount({ facets: facets(), filters: filters({ brands: ['NETECO'] }) })
    await wrapper.get('[data-filter-in-stock] input').setValue(true)
    expect(wrapper.emitted('update:filters')!.at(-1)![0]).toMatchObject({ brands: ['NETECO'], inStock: true })
  })

  it('is not offered when nothing is in stock, unless it is already applied', async () => {
    expect(
      (await mount({ facets: facets({ inStock: 0 }), filters: filters() })).find('[data-filter-in-stock]').exists()
    ).toBe(false)
    expect(
      (await mount({ facets: facets({ inStock: undefined }), filters: filters() }))
        .find('[data-filter-in-stock]')
        .exists()
    ).toBe(false)
    const applied = await mount({ facets: facets({ inStock: 0 }), filters: filters({ inStock: true }) })
    expect((applied.get('[data-filter-in-stock] input').element as HTMLInputElement).checked).toBe(true)
  })
})

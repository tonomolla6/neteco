import { mountSuspended } from '@nuxt/test-utils/runtime'
import { afterEach, describe, expect, it } from 'vitest'
import ProductFilters from '../../app/components/ProductFilters.vue'
import type { CatalogFilters, ProductFacets } from '../../shared/types/catalog'
import '#app/nuxt-vitest-app-entry'

const A = 'c1000000-0000-4000-8000-000000000007',
  B = 'c2000000-0000-4000-8000-000000000007'
const filters = (): CatalogFilters => ({
  brands: [],
  badges: [],
  envases: [],
  tallas: [],
  capacidades: [],
  colors: [],
  medidas: [],
  acabados: [],
  priceMin: null,
  priceMax: null
})
const facets = (): ProductFacets => ({
  brands: [],
  badges: [],
  envases: [],
  tallas: [],
  capacidades: [],
  colores: [],
  medidas: [],
  acabados: [],
  price: null,
  categories: [],
  typed: [
    {
      definitionId: A,
      categoryId: 7,
      code: 'reusable',
      kind: 'boolean',
      label: 'Misma etiqueta',
      values: [
        { value: false, label: 'No', n: 2 },
        { value: true, label: 'Sí', n: 3 }
      ]
    },
    {
      definitionId: B,
      categoryId: 8,
      code: 'tone',
      kind: 'list',
      label: 'Misma etiqueta',
      values: [
        { value: 'blue', label: 'Azul', n: 4 },
        { value: 'none', label: 'Sin resultados', n: 0 }
      ]
    }
  ]
})
const mounted: Array<{ unmount(): void }> = []
async function mount(props: Record<string, unknown> = {}) {
  const wrapper = await mountSuspended(ProductFilters, {
    props: { facets: facets(), filters: filters(), ...props },
    global: { stubs: { UIcon: true } }
  })
  mounted.push(wrapper)
  return wrapper
}
afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount()
})

describe('accessible typed catalogue facets by stable identity', () => {
  it('renders distinct IDs even for identical labels, only with positive-result options', async () => {
    const wrapper = await mount()
    expect(wrapper.find(`[data-typed-group="${A}"]`).exists()).toBe(true)
    expect(wrapper.find(`[data-typed-group="${B}"]`).exists()).toBe(true)
    expect(wrapper.text()).not.toContain('Sin resultados')
    expect(wrapper.get(`[data-typed-group="${A}"]`).text()).toContain('(2)')
    const ids = wrapper.findAll('[data-typed-value]').map((control) => control.attributes('id'))
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.every(Boolean)).toBe(true)
  })
  it('selects exact false and stable list codes, emitting fresh snapshots without mutating props', async () => {
    const original = filters(),
      wrapper = await mount({ filters: original })
    await wrapper.get(`[data-typed-group="${A}"] [data-typed-value]`).setValue(true)
    const first = wrapper.emitted('update:filters')![0]![0] as CatalogFilters
    expect(first.typed).toEqual([{ definitionId: A, values: [false] }])
    expect(original).not.toHaveProperty('typed')
    await wrapper.setProps({ filters: first })
    await wrapper.get(`[data-typed-group="${B}"] [data-typed-value]`).setValue(true)
    const second = wrapper.emitted('update:filters')![1]![0] as CatalogFilters
    expect(second.typed).toEqual([
      { definitionId: A, values: [false] },
      { definitionId: B, values: ['blue'] }
    ])
    expect(second.typed).not.toBe(first.typed)
    await wrapper.setProps({ filters: second })
    await wrapper.get(`[data-typed-group="${A}"] [data-typed-value]`).setValue(false)
    expect((wrapper.emitted('update:filters')![2]![0] as CatalogFilters).typed).toEqual([
      { definitionId: B, values: ['blue'] }
    ])
  })
  it('preserves numeric zero and quantity/unit pairs without conversion or label identity', async () => {
    const data = facets()
    data.typed = [
      {
        definitionId: A,
        categoryId: 7,
        code: 'amount',
        kind: 'number',
        label: 'Número',
        values: [{ value: 0, label: '0', n: 2 }]
      },
      {
        definitionId: B,
        categoryId: 7,
        code: 'volume',
        kind: 'unit',
        label: 'Volumen',
        values: [{ value: { quantity: 0, unit: 'ml' }, label: '0 ml', n: 1 }]
      }
    ]
    const wrapper = await mount({ facets: data })
    await wrapper.get(`[data-typed-group="${B}"] [data-typed-value]`).setValue(true)
    expect((wrapper.emitted('update:filters')![0]![0] as CatalogFilters).typed).toEqual([
      { definitionId: B, values: [{ quantity: 0, unit: 'ml' }] }
    ])
  })
  it('handles optional/missing typed facets without adding or mutating filters', async () => {
    const data = facets()
    delete data.typed
    expect((await mount({ facets: data })).find('[data-typed-group]').exists()).toBe(false)
  })
  it('keeps a rejected over-limit checkbox visually unselected without emitting a wider query', async () => {
    const data = facets()
    data.typed = [
      {
        definitionId: A,
        categoryId: 7,
        code: 'number',
        kind: 'number',
        label: 'Número',
        values: Array.from({ length: 17 }, (_, value) => ({ value, label: String(value), n: 1 }))
      }
    ]
    const original = {
      ...filters(),
      typed: [{ definitionId: A, values: Array.from({ length: 16 }, (_, value) => value) }]
    }
    const wrapper = await mount({ facets: data, filters: original })
    const extra = wrapper.findAll<HTMLInputElement>('[data-typed-value]')[16]!
    await extra.setValue(true)
    expect(wrapper.emitted('update:filters')).toBeUndefined()
    expect(extra.element.checked).toBe(false)
    expect(wrapper.text()).toContain('límite')
    expect(original.typed[0]!.values).toHaveLength(16)
  })
})

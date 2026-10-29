import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { defineComponent, h, nextTick } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ProductFilters from '../../app/components/ProductFilters.vue'
import CartLineControls from '../../app/components/CartLineControls.vue'
import QuantityStepper from '../../app/components/QuantityStepper.vue'
import SearchBox from '../../app/components/SearchBox.vue'
import VariantSelector from '../../app/components/VariantSelector.vue'
import type { CatalogFilters, ProductFacets, SearchSuggestion } from '../../shared/types/catalog'

const IconStub = defineComponent({ template: '<span aria-hidden="true" />' })
const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }))
mockNuxtImport('$fetch', () => fetchMock)
const InputStub = defineComponent({
  inheritAttrs: false,
  props: { modelValue: { type: [String, Number], default: '' } },
  emits: ['update:modelValue'],
  setup(props, { attrs, emit }) {
    return () =>
      h('input', {
        ...attrs,
        value: props.modelValue,
        onInput: (event: Event) => emit('update:modelValue', (event.target as HTMLInputElement).value)
      })
  }
})

const filters: CatalogFilters = {
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
}
const facets: ProductFacets = {
  brands: [
    { value: 'NETECO', n: 3 },
    { value: 'PRO', n: 2 }
  ],
  badges: [{ value: 'eco', n: 2 }],
  envases: [],
  tallas: [],
  capacidades: [],
  colores: [],
  medidas: [],
  acabados: [],
  price: { min: 500, max: 5_000 },
  categories: []
}

describe('critical catalog controls', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.useRealTimers()
    fetchMock.mockReset()
  })

  it('navigates search suggestions with the keyboard and exposes an empty/error state', async () => {
    const item: SearchSuggestion = {
      name: 'Detergente profesional',
      slug: 'detergente-profesional',
      brand: 'NETECO',
      visual: { type: 'bottle', color: '#fff' },
      image: null,
      minPrice: 1299,
      minNetPrice: 1074,
      sku: 'DET-1'
    }
    fetchMock.mockResolvedValueOnce({ items: [item] }).mockRejectedValueOnce(new Error('offline'))
    const wrapper = await mountSuspended(SearchBox, {
      global: { stubs: { UInput: InputStub, ProductImage: true } }
    })
    fetchMock.mockClear()
    const input = wrapper.get('input[role="combobox"]')
    await input.setValue('det')
    await vi.advanceTimersByTimeAsync(200)
    await nextTick()
    expect(wrapper.get('[role="listbox"]').text()).toContain('Detergente profesional')
    await input.trigger('keydown', { key: 'ArrowDown' })
    expect(input.attributes('aria-activedescendant')).toContain('option-0')
    expect(wrapper.get('[role="option"]').attributes('aria-selected')).toBe('true')
    await input.trigger('keydown', { key: 'Escape' })
    expect(wrapper.find('[role="listbox"]').exists()).toBe(false)
    await input.trigger('focus')
    await input.trigger('keydown', { key: 'ArrowDown' })
    await input.trigger('keydown', { key: 'Enter' })
    expect(wrapper.find('[role="listbox"]').exists()).toBe(false)

    await input.setValue('fallo')
    await vi.advanceTimersByTimeAsync(200)
    await nextTick()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(wrapper.get('[role="alert"]').text()).toContain('No se han podido cargar')
  })

  it('emits immutable filter snapshots and clamps the price range', async () => {
    const wrapper = await mountSuspended(ProductFilters, {
      props: { facets, filters },
      global: { stubs: { UIcon: IconStub, PackageIcon: IconStub } }
    })
    const brand = wrapper.get('input[type="checkbox"]')
    await brand.setValue(true)
    expect(wrapper.emitted('update:filters')?.[0]?.[0]).toMatchObject({ brands: ['NETECO'] })
    expect(filters.brands).toEqual([])

    const minimum = wrapper.get('input[aria-label="Precio mínimo en euros"]')
    await minimum.setValue('60')
    await minimum.trigger('change')
    const last = wrapper.emitted('update:filters')?.at(-1)?.[0] as CatalogFilters
    expect(last.priceMin).toBe(50)
    expect(last.priceMax).toBeNull()
  })

  it('enforces quantity bounds and increments for product and cart controls', async () => {
    const wrapper = await mountSuspended(QuantityStepper, {
      props: { modelValue: 2, minimum: 2, maximum: 6, step: 2, label: 'Producto' },
      global: { stubs: { UIcon: IconStub } }
    })
    const [decrease, increase] = wrapper.findAll('button')
    expect(decrease!.attributes()).toHaveProperty('disabled')
    await increase!.trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('update:modelValue')).toEqual([[4]])
    await wrapper.setProps({ modelValue: 6 })
    expect(increase!.attributes()).toHaveProperty('disabled')
    await increase!.trigger('click')
    expect(wrapper.emitted('update:modelValue')).toEqual([[4]])
  })

  it('exposes cart quantity/removal actions and a visible synchronization error', async () => {
    const wrapper = await mountSuspended(CartLineControls, {
      props: { quantity: 2, minimum: 1, maximum: 3, step: 1, label: 'Detergente', error: 'Sin conexión' },
      global: { stubs: { UIcon: IconStub } }
    })
    expect(wrapper.get('[role="alert"]').text()).toBe('Sin conexión')
    const buttons = wrapper.findAll('button')
    await buttons[1]!.trigger('click')
    await buttons[2]!.trigger('click')
    expect(wrapper.emitted('quantity')).toEqual([[3]])
    expect(wrapper.emitted('remove')).toHaveLength(1)
  })

  it('selects exactly one variant with accessible radio state and roving focus', async () => {
    const variants = [
      { id: 1, format: '1 litro', sku: 'ONE' },
      { id: 2, format: '5 litros', sku: 'FIVE' }
    ]
    const wrapper = await mountSuspended(VariantSelector, {
      props: { variants, modelValue: 1 },
      attachTo: document.body
    })
    const buttons = wrapper.findAll('[role="radio"]')
    expect(wrapper.get('[role="radiogroup"]').attributes('aria-label')).toBe('Formato')
    expect(buttons.map((button) => button.attributes('aria-checked'))).toEqual(['true', 'false'])
    expect(buttons.map((button) => button.attributes('tabindex'))).toEqual(['0', '-1'])
    await buttons[0]!.trigger('keydown', { key: 'ArrowDown' })
    expect(wrapper.emitted('update:modelValue')).toEqual([[2]])
    expect(document.activeElement).toBe(buttons[1]!.element)
    await wrapper.setProps({ modelValue: 2 })
    expect(buttons.map((button) => button.attributes('aria-checked'))).toEqual(['false', 'true'])
    await buttons[1]!.trigger('keydown', { key: 'ArrowRight' })
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual([1])
    expect(document.activeElement).toBe(buttons[0]!.element)
    await buttons[0]!.trigger('keydown', { key: 'End' })
    expect(document.activeElement).toBe(buttons[1]!.element)
    await buttons[1]!.trigger('keydown', { key: 'Home' })
    expect(document.activeElement).toBe(buttons[0]!.element)
    await buttons[1]!.trigger('click')
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual([2])
    wrapper.unmount()
  })
})

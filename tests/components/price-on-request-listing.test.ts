// @vitest-environment nuxt
import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { defineComponent, h, nextTick } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import PriceBlock from '../../app/components/PriceBlock.vue'
import ProductCard from '../../app/components/ProductCard.vue'
import ProductRow from '../../app/components/ProductRow.vue'
import SearchBox from '../../app/components/SearchBox.vue'
import type { ProductCardData } from '../../shared/types/catalog'

/**
 * Productos publicados sin precio público (importados del catálogo en PDF): precio 0 y stock 0.
 * La tienda no puede decir «0,00 €» ni «Agotado», ni dejarlos en el carrito: dice
 * «Consultar precio» y ofrece «Pedir precio» con el producto ya escrito en el contacto.
 */
const mocks = vi.hoisted(() => ({ add: vi.fn(), fetch: vi.fn() }))
mockNuxtImport('$fetch', () => mocks.fetch)
vi.mock('../../app/stores/cart', () => ({
  useCartStore: () => ({ add: mocks.add, error: '', blockedMutations: false })
}))

const unpriced: ProductCardData = {
  id: 9,
  slug: 'bayeta-microfibra',
  name: 'Bayeta microfibra',
  brand: 'NETECO',
  badges: [],
  visual: { type: 'caja', color: '#2563eb' },
  image: null,
  minPrice: 0,
  minNetPrice: 0,
  formats: 1,
  single: {
    variantId: 90,
    sku: 'BM-40',
    format: 'Pack 10',
    units: 10,
    unitLabel: 'ud',
    minimumQuantity: 1,
    quantityIncrement: 1,
    maximumQuantity: null,
    stock: 0,
    backorderAllowed: false
  }
}
const unpricedMulti: ProductCardData = {
  ...unpriced,
  id: 10,
  slug: 'fregona',
  name: 'Fregona',
  formats: 3,
  single: null
}

type Wrapper = Awaited<ReturnType<typeof mountSuspended>>
const wrappers: Wrapper[] = []
async function render(component: unknown, props: Record<string, unknown>) {
  const wrapper = await mountSuspended(component as typeof ProductCard, {
    props,
    global: { stubs: { ProductImage: true } }
  })
  wrappers.push(wrapper)
  return wrapper
}
const flat = (wrapper: Wrapper) => wrapper.text().replace(/\s+/g, ' ')

beforeEach(() => mocks.add.mockReset().mockResolvedValue(undefined))
afterEach(() => wrappers.splice(0).forEach((wrapper) => wrapper.unmount()))

describe('price block without a public price', () => {
  it('says "Consultar precio" instead of an amount, a VAT note or a unit price', async () => {
    const block = await render(PriceBlock, { grossCents: 0, netCents: 0, from: true, units: 10, unitLabel: 'ud' })
    expect(flat(block)).toBe('Consultar precio')
    expect(block.find('[data-price-on-request]').exists()).toBe(true)
  })
})

describe.each([
  ['ProductCard', ProductCard],
  ['ProductRow', ProductRow]
] as const)('%s without a public price', (_name, component) => {
  it('shows "Consultar precio", never 0,00 € or "Agotado", and keeps the reference visible', async () => {
    const wrapper = await render(component, { product: unpriced })
    expect(flat(wrapper)).toContain('Consultar precio')
    expect(flat(wrapper)).not.toMatch(/0,00|Agotado|desde/)
    expect(wrapper.get('[data-product-reference]').text()).toBe('Ref. BM-40')
  })

  it('cannot be added to the cart: the action is "Pedir precio" with the product prefilled in contact', async () => {
    const wrapper = await render(component, { product: unpriced })
    expect(wrapper.find('[data-product-add]').exists()).toBe(false)
    expect(wrapper.find('input[inputmode="numeric"]').exists()).toBe(false)
    const link = wrapper.get('a[data-price-request]')
    expect(link.text()).toBe('Pedir precio')
    const url = new URL(link.attributes('href')!, 'https://shop.invalid')
    expect(url.pathname).toBe('/contacto')
    expect(url.searchParams.get('producto')).toBe('bayeta-microfibra')
    expect(url.searchParams.get('asunto')).toContain('Ref. BM-40')
    expect(mocks.add).not.toHaveBeenCalled()
  })

  it('does not say "desde" for a multi-format product without a public price', async () => {
    const wrapper = await render(component, { product: unpricedMulti })
    expect(flat(wrapper)).toContain('Consultar precio')
    expect(flat(wrapper)).not.toMatch(/0,00|desde/)
    expect(wrapper.get('a[data-price-request]').text()).toBe('Pedir precio')
  })
})

const InputStub = defineComponent({
  inheritAttrs: false,
  props: { modelValue: { type: String, default: '' } },
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

describe('search suggestion without a public price', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mocks.fetch.mockReset().mockImplementation(async (path: string) => {
      if (path === '/api/search')
        return {
          items: [
            {
              name: 'Bayeta microfibra',
              slug: 'bayeta-microfibra',
              brand: 'NETECO',
              visual: { type: 'caja', color: '#fff' },
              image: null,
              minPrice: 0,
              minNetPrice: 0,
              sku: 'BM-40'
            }
          ]
        }
      return {
        id: 9,
        slug: 'bayeta-microfibra',
        name: 'Bayeta microfibra',
        brand: 'NETECO',
        visual: null,
        variants: [
          {
            id: 90,
            sku: 'BM-40',
            format: 'Pack 10',
            price: 0,
            netPrice: 0,
            minimumQuantity: 1,
            quantityIncrement: 1,
            maximumQuantity: null,
            stock: 0,
            backorderAllowed: false
          }
        ]
      }
    })
  })
  afterEach(() => vi.useRealTimers())

  it('reads "Consultar precio", offers "Pedir precio" and Enter on the exact reference adds nothing', async () => {
    const wrapper = await mountSuspended(SearchBox, { global: { stubs: { UInput: InputStub, ProductImage: true } } })
    wrappers.push(wrapper)
    const input = wrapper.get('input[role="combobox"]')
    await input.setValue('BM-40')
    await vi.advanceTimersByTimeAsync(200)
    await flushPromises()
    await nextTick()
    const option = wrapper.get('[role="option"]')
    expect(option.text()).toContain('Consultar precio')
    expect(option.text()).not.toMatch(/0,00/)
    expect(option.find('[data-suggestion-add]').exists()).toBe(false)
    expect(option.get('a[data-price-request]').text()).toBe('Pedir precio')
    await input.trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(mocks.add).not.toHaveBeenCalled()
  })
})

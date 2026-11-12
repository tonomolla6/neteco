// @vitest-environment nuxt
import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { defineComponent, h, nextTick } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SearchBox from '../../app/components/SearchBox.vue'

const mocks = vi.hoisted(() => ({ add: vi.fn(), fetch: vi.fn(), push: vi.fn() }))
mockNuxtImport('$fetch', () => mocks.fetch)
vi.mock('../../app/stores/cart', () => ({
  useCartStore: () => ({ add: mocks.add, error: '', blockedMutations: false })
}))

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
const suggestion = (id: number, sku: string | null) => ({
  name: `Desengrasante ${id}`,
  slug: `desengrasante-${id}`,
  brand: 'NETECO',
  visual: { type: 'garrafa', color: '#fff' },
  image: null,
  minPrice: 1186,
  minNetPrice: 980,
  sku
})
const variant = (id: number, sku: string, overrides = {}) => ({
  id,
  sku,
  format: 'Garrafa 5 L',
  price: 1186,
  netPrice: 980,
  minimumQuantity: 2,
  quantityIncrement: 2,
  maximumQuantity: null,
  stock: 20,
  backorderAllowed: false,
  taxRateBasisPoints: 2100,
  ...overrides
})

type Wrapper = Awaited<ReturnType<typeof mountSuspended>>
let wrapper: Wrapper
async function search(text: string) {
  wrapper = await mountSuspended(SearchBox, { global: { stubs: { UInput: InputStub, ProductImage: true } } })
  const input = wrapper.get('input[role="combobox"]')
  await input.setValue(text)
  await vi.advanceTimersByTimeAsync(200)
  await flushPromises()
  await nextTick()
  return input
}

beforeEach(() => {
  vi.useFakeTimers()
  mocks.add.mockReset().mockResolvedValue(undefined)
  mocks.fetch.mockReset().mockImplementation(async (path: string) => {
    if (path === '/api/search') return { items: [suggestion(1, '1042'), suggestion(2, null)] }
    if (path === '/api/products/desengrasante-1')
      return {
        id: 1,
        slug: 'desengrasante-1',
        name: 'Desengrasante 1',
        brand: 'NETECO',
        visual: null,
        variants: [variant(11, '1042'), variant(12, '1043')]
      }
    return {
      id: 2,
      slug: 'desengrasante-2',
      name: 'Desengrasante 2',
      brand: 'NETECO',
      visual: null,
      variants: [variant(21, '2000'), variant(22, '2001')]
    }
  })
})
afterEach(() => {
  wrapper?.unmount()
  vi.useRealTimers()
})

describe('search suggestions as an ordering surface', () => {
  it('shows the reference and marks an exact reference match first', async () => {
    await search('1042')
    const options = wrapper.findAll('[role="option"]')
    expect(options[0]!.text()).toContain('Referencia exacta')
    expect(options[0]!.text()).toContain('Ref. 1042')
    expect(options[1]!.text()).not.toContain('Referencia exacta')
  })

  it('adds from a suggestion without closing the list or navigating', async () => {
    await search('1042')
    await wrapper.get('[data-suggestion-add]').trigger('click')
    await flushPromises()
    expect(mocks.fetch).toHaveBeenCalledWith('/api/products/desengrasante-1')
    expect(mocks.add).toHaveBeenCalledOnce()
    expect(mocks.add.mock.calls[0]![0]).toMatchObject({ variantId: 11, sku: '1042', slug: 'desengrasante-1' })
    // the variant minimum, not an invalid single unit
    expect(mocks.add.mock.calls[0]![1]).toBe(2)
    expect(wrapper.find('[role="listbox"]').exists()).toBe(true)
    expect(wrapper.get('[data-suggestion-add]').text()).toBe('Añadido')
    expect(wrapper.get('[aria-live="polite"]').text()).toBe('2 × Desengrasante 1 en el carrito')
  })

  it('Enter on an exact reference adds it to the cart instead of leaving the page', async () => {
    const input = await search('1042')
    await input.trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(mocks.add).toHaveBeenCalledOnce()
    expect(mocks.add.mock.calls[0]![0]).toMatchObject({ variantId: 11 })
    expect(wrapper.find('[role="listbox"]').exists()).toBe(true)
  })

  it('does not guess a format: a multi-format product without an exact reference opens its page', async () => {
    await search('desengrasante')
    const choose = wrapper.findAll('[role="option"]')[1]!.get('[data-suggestion-add]')
    await choose.trigger('click')
    await flushPromises()
    expect(mocks.add).not.toHaveBeenCalled()
    expect(wrapper.get('[role="status"]').text()).toContain('Desengrasante 2 tiene varios formatos')
  })

  it('says so when the addition fails', async () => {
    mocks.add.mockRejectedValueOnce(new Error('offline'))
    await search('1042')
    await wrapper.get('[data-suggestion-add]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toContain('No se ha podido añadir')
  })
})

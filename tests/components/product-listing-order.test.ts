// @vitest-environment nuxt
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ProductCard from '../../app/components/ProductCard.vue'
import ProductRow from '../../app/components/ProductRow.vue'
import { usePriceDisplay } from '../../app/composables/usePriceDisplay'
import type { ProductCardData } from '../../shared/types/catalog'

const mocks = vi.hoisted(() => ({ add: vi.fn(), blocked: false }))
vi.mock('../../app/stores/cart', () => ({
  useCartStore: () => ({
    add: mocks.add,
    error: '',
    get blockedMutations() {
      return mocks.blocked
    }
  })
}))

const single: ProductCardData = {
  id: 7,
  slug: 'desengrasante-dg-5',
  name: 'Desengrasante en frío DG-5',
  brand: 'NETECO',
  badges: [],
  visual: { type: 'garrafa', color: '#2563eb' },
  image: null,
  minPrice: 1186,
  minNetPrice: 980,
  formats: 1,
  single: {
    variantId: 1042,
    sku: '1042',
    format: 'Garrafa 5 L',
    units: 5,
    unitLabel: 'L',
    minimumQuantity: 2,
    quantityIncrement: 2,
    maximumQuantity: null,
    stock: 40,
    backorderAllowed: false
  }
}
const multi: ProductCardData = {
  ...single,
  id: 8,
  slug: 'guante-nitrilo',
  name: 'Guante de nitrilo',
  formats: 4,
  single: null
}

const stubs = { ProductImage: true }
type Wrapper = Awaited<ReturnType<typeof mountSuspended>>
const wrappers: Wrapper[] = []
async function render(component: typeof ProductCard | typeof ProductRow, props: Record<string, unknown>) {
  const wrapper = await mountSuspended(component, { props, global: { stubs } })
  wrappers.push(wrapper)
  return wrapper
}

beforeEach(() => {
  mocks.add.mockReset().mockResolvedValue(undefined)
  mocks.blocked = false
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
})
afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount())
  vi.useRealTimers()
})

describe.each([
  ['ProductCard', ProductCard],
  ['ProductRow', ProductRow]
] as const)('%s as an ordering surface', (_name, component) => {
  it('shows the exact product, delivery line and price per unit of measure', async () => {
    const wrapper = await render(component, { product: single })
    expect(wrapper.get('h3 a').attributes('href')).toBe('/producto/desengrasante-dg-5')
    expect(wrapper.find('[data-product-delivery]').exists()).toBe(true)
    expect(wrapper.text()).toContain('2,37 €/L')
    expect(wrapper.html()).not.toContain('uppercase')
    if (component === ProductRow)
      expect(wrapper.find('button[aria-label="Comparar Desengrasante en frío DG-5"]').exists()).toBe(true)
  })

  it('is not a single link: only image and name navigate, quantity and button are controls', async () => {
    const wrapper = await render(component, { product: single })
    expect(wrapper.element.tagName).not.toBe('A')
    const links = wrapper.findAll('a')
    expect(links.length).toBeGreaterThanOrEqual(1)
    expect(links.every((link) => link.attributes('href') === '/producto/desengrasante-dg-5')).toBe(true)
    expect(wrapper.find('a button').exists()).toBe(false)
    expect(wrapper.find('a input').exists()).toBe(false)
  })

  it('adds a single-format product from the listing without navigating and announces it', async () => {
    const wrapper = await render(component, { product: single })
    if (component === ProductCard) {
      expect(wrapper.find('[data-product-add]').exists()).toBe(false)
      expect(wrapper.find('input[inputmode="numeric"]').exists()).toBe(false)
      expect(wrapper.get('h3 a').attributes('href')).toBe('/producto/desengrasante-dg-5')
      expect(mocks.add).not.toHaveBeenCalled()
      return
    }
    const quantity = wrapper.get('input[inputmode="numeric"]')
    expect((quantity.element as HTMLInputElement).value).toBe('2')
    await wrapper.get('button[aria-label^="Más unidades"]').trigger('click')
    await wrapper.get('[data-product-add]').trigger('click')
    await flushPromises()
    expect(mocks.add).toHaveBeenCalledOnce()
    expect(mocks.add.mock.calls[0]![0]).toMatchObject({ variantId: 1042, sku: '1042', slug: 'desengrasante-dg-5' })
    expect(mocks.add.mock.calls[0]![1]).toBe(4)
    expect(wrapper.get('[data-product-add]').text()).toBe('Añadido')
    const live = wrapper.get('[aria-live="polite"]')
    expect(live.text()).toBe('4 × Desengrasante en frío DG-5 en el carrito')
    vi.advanceTimersByTime(2100)
    await nextTick()
    expect(wrapper.get('[data-product-add]').text()).toBe('Añadir')
  })

  it('says why when the cart rejects the addition and keeps the control usable', async () => {
    mocks.add.mockRejectedValueOnce(new Error('offline'))
    const wrapper = await render(component, { product: single })
    if (component === ProductCard) {
      expect(wrapper.find('[data-product-add]').exists()).toBe(false)
      expect(mocks.add).not.toHaveBeenCalled()
      expect(wrapper.get('h3 a').attributes('href')).toBe('/producto/desengrasante-dg-5')
      return
    }
    await wrapper.get('[data-product-add]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toContain('No se ha podido añadir')
    expect(wrapper.get('[data-product-add]').attributes('disabled')).toBeUndefined()
  })

  it('sends a multi-format product to its format table instead of guessing a variant', async () => {
    const wrapper = await render(component, { product: multi })
    expect(wrapper.find('[data-product-add]').exists()).toBe(false)
    expect(wrapper.find('input[inputmode="numeric"]').exists()).toBe(false)
    const choose = component === ProductCard ? wrapper.get('h3 a') : wrapper.get('[data-product-formats]')
    if (component === ProductRow) expect(choose.text()).toContain('4 formatos')
    expect(choose.attributes('href')).toBe('/producto/guante-nitrilo')
    expect(wrapper.text()).toContain('desde')
  })

  it('does not offer to add an unavailable product', async () => {
    const wrapper = await render(component, {
      product: { ...single, single: { ...single.single!, stock: 0, backorderAllowed: false } }
    })
    expect(wrapper.text()).not.toContain('Agotado')
    if (component === ProductRow) expect(wrapper.get('[data-product-add]').attributes('disabled')).toBeDefined()
    else expect(wrapper.find('[data-product-add]').exists()).toBe(false)
    expect(mocks.add).not.toHaveBeenCalled()
  })

  it('marks a backorder product as such and still lets it be ordered', async () => {
    const wrapper = await render(component, {
      product: { ...single, single: { ...single.single!, stock: 0, backorderAllowed: true } }
    })
    expect(wrapper.find('[data-product-delivery]').exists()).toBe(true)
    if (component === ProductRow) expect(wrapper.get('[data-product-add]').attributes('disabled')).toBeUndefined()
    else expect(wrapper.get('h3 a').attributes('href')).toBe('/producto/desengrasante-dg-5')
  })

  it('shows the brand only when the listing asks for it', async () => {
    const product = { ...single, brand: 'Vijusa' }
    expect((await render(component, { product })).text()).not.toContain('Vijusa')
    expect((await render(component, { product, showBrand: true })).text()).toContain('Vijusa')
  })
})

describe('card and row describe the price the same way', () => {
  const priceText = (wrapper: Wrapper) => wrapper.get('[data-product-price]').text().replace(/\s+/g, ' ')
  it.each(['gross', 'net'] as const)('in %s mode', async (mode) => {
    const card = await render(ProductCard, { product: single })
    const row = await render(ProductRow, { product: single })
    usePriceDisplay().setMode(mode)
    await nextTick()
    expect(priceText(card)).toBe(priceText(row))
    expect(priceText(card)).toContain(mode === 'net' ? '9,80 € sin IVA' : '11,86 € IVA incluido')
    expect(priceText(card)).toContain(mode === 'net' ? '11,86 € con IVA' : '9,80 € sin IVA')
    usePriceDisplay().setMode('gross')
  })
})

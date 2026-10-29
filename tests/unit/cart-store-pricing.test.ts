import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import { useCartStore, type CartItem } from '../../app/stores/cart'

const item: CartItem = {
  productId: 1,
  slug: 'test',
  name: 'Test',
  brand: 'NETECO',
  variantId: 11,
  format: '1 L',
  sku: 'SKU-11',
  price: 3,
  netPrice: 2,
  lineNet: 5,
  taxRateBasisPoints: 2100,
  qty: 2,
  visual: { type: 'bottle', color: '#123456' }
}

describe('cart store fiscal totals', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('uses the authoritative line-rounded server totals and resets them with the cart', () => {
    const cart = useCartStore()
    cart.apply({
      id: 'cart-1',
      version: 2,
      status: 'active',
      expiresAt: '2026-08-15T00:00:00Z',
      items: [item],
      count: 2,
      subtotal: 6,
      subtotalNet: 5,
      tax: 1
    })
    expect({ subtotal: cart.subtotal, subtotalNet: cart.subtotalNet, tax: cart.tax }).toEqual({
      subtotal: 6,
      subtotalNet: 5,
      tax: 1
    })
    cart.resetLocal()
    expect({ subtotal: cart.subtotal, subtotalNet: cart.subtotalNet, tax: cart.tax }).toEqual({
      subtotal: 0,
      subtotalNet: 0,
      tax: 0
    })
  })
})

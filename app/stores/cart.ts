import { defineStore } from 'pinia'

export interface CartItem {
  productId: number
  slug: string
  name: string
  brand: string
  variantId: number
  format: string
  sku: string
  price: number
  basePrice?: number
  compareAtPrice?: number | null
  referencePrice30d?: number | null
  priceTiers?: Array<{ minimumQuantity: number; unitGrossCents: number }>
  pricingVersion?: string
  netPrice: number
  taxRateBasisPoints: number
  qty: number
  visual: { type: string; color: string }
  image?: string | null
  minimumQuantity?: number
  maximumQuantity?: number | null
  quantityIncrement?: number
}

interface ServerCart {
  id: string
  version: number
  status: string
  expiresAt: string
  items: CartItem[]
  count: number
  subtotal: number
  subtotalNet: number
  tax: number
}

let loadPromise: Promise<void> | null = null

export const useCartStore = defineStore('cart', {
  state: () => ({
    items: [] as CartItem[],
    id: null as string | null,
    version: 0,
    ready: false,
    loading: false,
    error: ''
  }),
  getters: {
    count: (state) => state.items.reduce((total, item) => total + item.qty, 0),
    subtotal: (state) => state.items.reduce((total, item) => total + item.price * item.qty, 0),
    subtotalNet: (state) => state.items.reduce((total, item) => total + (item.netPrice ?? item.price) * item.qty, 0),
    tax: (state) =>
      state.items.reduce((total, item) => total + (item.price - (item.netPrice ?? item.price)) * item.qty, 0)
  },
  actions: {
    apply(cart: ServerCart) {
      this.id = cart.id
      this.version = cart.version
      this.items = cart.items
      this.ready = true
      this.error = ''
      this.persist()
    },
    persist() {
      if (import.meta.client) localStorage.setItem('neteco-cart-cache', JSON.stringify(this.items))
    },
    async load() {
      if (!import.meta.client) return
      if (loadPromise) return loadPromise
      loadPromise = (async () => {
        this.loading = true
        const cached = localStorage.getItem('neteco-cart-cache') ?? localStorage.getItem('neteco-cart')
        if (!this.ready && cached) {
          try {
            this.items = JSON.parse(cached)
          } catch {
            this.items = []
          }
        }
        try {
          let cart = await $fetch<ServerCart>('/api/cart')
          if (cart.items.length === 0 && this.items.length > 0) {
            for (const item of this.items) {
              cart = await $fetch<ServerCart>('/api/cart/items', {
                method: 'POST',
                body: {
                  variantId: item.variantId,
                  quantity: item.qty,
                  expectedVersion: cart.version,
                  idempotencyKey: crypto.randomUUID()
                }
              })
            }
            localStorage.removeItem('neteco-cart')
          }
          this.apply(cart)
        } catch {
          this.error = 'No se ha podido sincronizar el carrito'
          this.ready = true
        } finally {
          this.loading = false
        }
      })()
      try {
        await loadPromise
      } finally {
        loadPromise = null
      }
    },
    async ensureLoaded() {
      if (!this.ready) await this.load()
      if (!this.id || this.version < 1) throw new Error('El carrito no está disponible')
    },
    async add(item: Omit<CartItem, 'qty'>, qty = 1) {
      await this.ensureLoaded()
      try {
        const cart = await $fetch<ServerCart>('/api/cart/items', {
          method: 'POST',
          body: {
            variantId: item.variantId,
            quantity: qty,
            expectedVersion: this.version,
            idempotencyKey: crypto.randomUUID()
          }
        })
        this.apply(cart)
        void useAnalytics().track('cart_item_added', {
          variantId: item.variantId,
          quantity: qty,
          cartVersion: cart.version
        })
      } catch (error) {
        await this.load()
        throw error
      }
    },
    async setQty(variantId: number, qty: number) {
      if (qty <= 0) return this.remove(variantId)
      await this.ensureLoaded()
      const previous = this.items.find((item) => item.variantId === variantId)?.qty ?? 0
      try {
        const cart = await $fetch<ServerCart>(`/api/cart/items/${variantId}`, {
          method: 'PUT',
          body: { quantity: qty, expectedVersion: this.version, idempotencyKey: crypto.randomUUID() }
        })
        this.apply(cart)
        const difference = qty - previous
        if (difference !== 0) {
          void useAnalytics().track(difference > 0 ? 'cart_item_added' : 'cart_item_removed', {
            variantId,
            quantity: Math.abs(difference),
            cartVersion: cart.version
          })
        }
      } catch (error) {
        await this.load()
        throw error
      }
    },
    async remove(variantId: number) {
      await this.ensureLoaded()
      const previous = this.items.find((item) => item.variantId === variantId)?.qty ?? 0
      try {
        const cart = await $fetch<ServerCart>(`/api/cart/items/${variantId}`, {
          method: 'DELETE',
          query: { expectedVersion: this.version, idempotencyKey: crypto.randomUUID() }
        })
        this.apply(cart)
        if (previous > 0) {
          void useAnalytics().track('cart_item_removed', {
            variantId,
            quantity: previous,
            cartVersion: cart.version
          })
        }
      } catch (error) {
        await this.load()
        throw error
      }
    },
    async clear() {
      if (!this.ready) await this.load()
      if (!this.id) {
        this.items = []
        this.persist()
        return
      }
      await $fetch('/api/cart', {
        method: 'DELETE',
        query: { expectedVersion: this.version, idempotencyKey: crypto.randomUUID() }
      })
      this.items = []
      this.id = null
      this.version = 0
      this.ready = false
      this.persist()
    },
    resetLocal() {
      this.items = []
      this.id = null
      this.version = 0
      this.ready = false
      this.persist()
    }
  }
})

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
  qty: number
  visual: { type: string; color: string }
  image?: string | null
}

export const useCartStore = defineStore('cart', {
  state: () => ({
    items: [] as CartItem[]
  }),
  getters: {
    count: (s) => s.items.reduce((acc, i) => acc + i.qty, 0),
    subtotal: (s) => s.items.reduce((acc, i) => acc + i.price * i.qty, 0)
  },
  actions: {
    add(item: Omit<CartItem, 'qty'>, qty = 1) {
      const existing = this.items.find((i) => i.variantId === item.variantId)
      if (existing) existing.qty = Math.min(existing.qty + qty, 999)
      else this.items.push({ ...item, qty })
      this.persist()
    },
    setQty(variantId: number, qty: number) {
      const item = this.items.find((i) => i.variantId === variantId)
      if (!item) return
      if (qty <= 0) this.remove(variantId)
      else {
        item.qty = Math.min(qty, 999)
        this.persist()
      }
    },
    remove(variantId: number) {
      this.items = this.items.filter((i) => i.variantId !== variantId)
      this.persist()
    },
    clear() {
      this.items = []
      this.persist()
    },
    persist() {
      if (import.meta.client) localStorage.setItem('neteco-cart', JSON.stringify(this.items))
    },
    load() {
      if (!import.meta.client) return
      try {
        this.items = JSON.parse(localStorage.getItem('neteco-cart') ?? '[]')
      } catch {
        this.items = []
      }
    }
  }
})

import type { ProductVisualData } from './catalog'

export interface AdminStats {
  products: number
  variants: number
  categories: number
  users: number
  orders: number
  openOrders: number
}

export interface AdminProductSummary {
  id: number
  name: string
  slug: string
  brand: string
  featured: boolean
  active: boolean
  series: string | null
  visual: ProductVisualData
  categoryId: number
  categoryName: string
  minPrice: number
  formats: number
}

export interface AdminProductDetail {
  id: number
  name: string
  slug: string
  brand: string
  categoryId: number
  shortDesc: string | null
  description: string | null
  usage: string | null
  badges: string[]
  visual: ProductVisualData
  featured: boolean
  active: boolean
  series: string | null
  attrs: Array<{ k: string; v: string }>
  variants: Array<{
    id: number
    format: string
    sku: string
    price: number
    stock: number
    units: number
    unitLabel: string
    color: string | null
    image: string | null
  }>
}

export interface AdminOrderSummary {
  id: string
  status: string
  orderStatus: string
  paymentStatus: string
  fulfillmentStatus: string
  inventoryStatus: string
  invoiceStatus: string
  name: string
  company: string | null
  email: string
  city: string
  paymentMethod: string
  shippingMethod: string
  total: number
  createdAt: string
  lines: number
  shipmentId: string | null
  trackingNumber: string | null
  shipmentStatus: string | null
}

export interface AdminReturnSummary {
  id: string
  orderNumber: string
  status: string
  reason: string
  resolution: string | null
  customerName: string
  email: string
  createdAt: string
  updatedAt: string
  quantity: number
  refundAmountCents: number | null
  refundStatus: string | null
}

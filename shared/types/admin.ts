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
  status: 'draft' | 'review' | 'published' | 'hidden' | 'discontinued'
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
  status: 'draft' | 'review' | 'published' | 'hidden' | 'discontinued'
  series: string | null
  image: string | null
  imageAlt: string | null
  imageRightsOwner: string | null
  imageRightsLicense: string | null
  imageAuthorizedAt: string | null
  attrs: Array<{ k: string; v: string }>
  variants: Array<{
    id: number
    format: string
    sku: string
    ean: string | null
    gtin: string | null
    mpn: string | null
    identifierExceptionReason: string | null
    price: number
    stock: number
    units: number
    unitLabel: string
    unitBase: string
    unitsPerCase: number
    casesPerPallet: number | null
    minimumQuantity: number
    quantityIncrement: number
    maximumQuantity: number | null
    weightGrams: number
    widthMm: number
    heightMm: number
    depthMm: number
    safetyStock: number
    backorderAllowed: boolean
    leadTimeDays: number | null
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

export interface AdminSupportTicket {
  id: string
  category: string
  priority: 'low' | 'normal' | 'high' | 'urgent'
  status: 'open' | 'waiting_customer' | 'waiting_provider' | 'resolved' | 'closed'
  subject: string
  requesterName: string
  requesterEmail: string
  orderNumber: string | null
  productSlug: string | null
  ownerName: string | null
  slaDueAt: string
  nextActionAt: string | null
  createdAt: string
  updatedAt: string
  messages: number
}

export interface AdminSupportTicketDetail extends AdminSupportTicket {
  requesterPhone: string | null
  orderId: string | null
  timeline: Array<{
    id: string
    authorType: 'customer' | 'staff' | 'system'
    authorName: string | null
    body: string
    private: boolean
    createdAt: string
  }>
}

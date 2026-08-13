export interface OrderLineView {
  id: string
  name: string
  format: string
  sku: string
  price: number
  qty: number
}

export interface OrderDetailView {
  id: string
  status: string
  orderStatus: string
  paymentStatus: string
  inventoryStatus: string
  fulfillmentStatus: string
  invoiceStatus: string
  name: string
  company: string | null
  nif: string | null
  email: string
  phone: string
  address: string
  zip: string
  city: string
  province: string
  notes: string | null
  shippingMethod: string
  paymentMethod: string
  subtotal: number
  shippingCost: number
  tax: number
  total: number
  createdAt: string
  items: OrderLineView[]
}

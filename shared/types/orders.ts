export interface OrderLineView {
  id: string
  name: string
  format: string
  sku: string
  price: number
  qty: number
  lineIndex?: number
  lineBaseGrossCents?: number
  discountGrossCents?: number
  lineNetCents?: number
  lineTaxCents?: number
  lineGrossCents?: number
}

export interface OrderDetailView {
  source?: 'cloudflare'
  /** Sealed guest links grant consultation only, never checkout/payment authority. */
  accessMode?: 'view_only'
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
  purchaseOrderReference?: string | null
  shippingMethod: string
  paymentMethod: string
  transferInstructions: { iban: string; beneficiary: string; reference: string } | null
  subtotal: number
  subtotalBaseGrossCents?: number
  discountGrossCents?: number
  subtotalNetCents?: number
  goodsTaxCents?: number
  shippingNetCents?: number
  shippingTaxCents?: number
  shippingCost: number
  tax: number
  total: number
  createdAt: string
  reservationExpiresAt?: string
  items: OrderLineView[]
}

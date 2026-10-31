import { z } from 'zod'

export const customerSplitPreferencesSchema = z
  .object({
    orderId: z.string().uuid(),
    customerAcceptsSplit: z.boolean(),
    acceptedExtraShippingCents: z.number().int().min(0).default(0),
    shippingCostPayer: z.enum(['merchant', 'customer']).default('merchant'),
    customerId: z.string().optional().nullable()
  })
  .strict()

export type CustomerSplitPreferencesInput = z.infer<typeof customerSplitPreferencesSchema>

export interface CustomerSplitPreferences {
  orderId: string
  customerAcceptsSplit: boolean
  acceptedExtraShippingCents: number
  shippingCostPayer: 'merchant' | 'customer'
  customerConsentAt: string
  customerId: string | null
  version: number
  createdAt: string
  updatedAt: string
}

export const splitShipmentLineAllocationSchema = z
  .object({
    lineIndex: z.number().int().min(0),
    quantityToShip: z.number().int().min(0),
    quantityBackordered: z.number().int().min(0)
  })
  .strict()

export const splitShipmentInputSchema = z
  .object({
    orderId: z.string().uuid(),
    allocations: z.array(splitShipmentLineAllocationSchema).min(1),
    carrier: z.string().max(80).optional(),
    estimatedRestockAt: z.string().datetime().optional()
  })
  .strict()

export type SplitShipmentInput = z.infer<typeof splitShipmentInputSchema>

export interface SplitShipmentItem {
  id: string
  shipmentId: string
  orderId: string
  lineIndex: number
  variantId: string
  quantityRequested: number
  quantityAllocated: number
  quantityBackordered: number
  unitGrossCents: number
  createdAt: string
}

export interface SplitShipment {
  id: string
  orderId: string
  shipmentNumber: number
  shipmentType: 'immediate' | 'backorder'
  status: 'pending' | 'picking' | 'shipped' | 'delivered' | 'cancelled'
  trackingNumber: string | null
  carrier: string | null
  estimatedDeliveryAt: string | null
  estimatedRestockAt: string | null
  shippingCostCents: number
  shippedAt: string | null
  deliveredAt: string | null
  version: number
  items: SplitShipmentItem[]
  createdAt: string
  updatedAt: string
}

export const splitBillingReconciliationSchema = z
  .object({
    orderId: z.string().uuid(),
    shipmentId: z.string().uuid().optional().nullable(),
    invoiceNumber: z.string().min(1).max(80),
    amountNetCents: z.number().int().min(0),
    taxCents: z.number().int().min(0),
    shippingCents: z.number().int().min(0),
    totalGrossCents: z.number().int().min(0),
    notes: z.string().max(500).optional()
  })
  .strict()

export type SplitBillingReconciliationInput = z.infer<typeof splitBillingReconciliationSchema>

export interface SplitBillingReconciliationRecord {
  id: string
  orderId: string
  shipmentId: string | null
  invoiceNumber: string
  amountNetCents: number
  taxCents: number
  shippingCents: number
  totalGrossCents: number
  status: 'draft' | 'issued' | 'reconciled' | 'credited'
  reconciledWithCapture: boolean
  notes: string | null
  createdAt: string
}

export interface OrderSplitBillingSummary {
  orderId: string
  orderGrossCents: number
  acceptedExtraShippingCents: number
  expectedTotalCents: number
  totalBilledCents: number
  isFullyReconciled: boolean
  discrepancyCents: number
  records: SplitBillingReconciliationRecord[]
}

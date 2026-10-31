import { z } from 'zod'

export const warehouseScanExecutionInputSchema = z
  .object({
    queueType: z.enum(['reception', 'picking', 'packing']),
    targetId: z.string().min(1),
    barcode: z.string().min(1),
    quantity: z.number().int().positive()
  })
  .strict()

export type WarehouseScanExecutionInput = z.infer<typeof warehouseScanExecutionInputSchema>

export const warehouseScanExecutionResultSchema = z
  .object({
    success: z.boolean(),
    scannedQty: z.number().int().nonnegative(),
    remainingQty: z.number().int().nonnegative(),
    queueItemStatus: z.enum(['pending', 'in_progress', 'completed', 'exception'])
  })
  .strict()

export type WarehouseScanExecutionResult = z.infer<typeof warehouseScanExecutionResultSchema>

export const printJobExecutionInputSchema = z
  .object({
    printerId: z.string().min(1),
    labelType: z.enum(['parcel_4x6', 'shelf_barcode', 'lot_tag']),
    documentId: z.string().min(1),
    copies: z.number().int().positive()
  })
  .strict()

export type PrintJobExecutionInput = z.infer<typeof printJobExecutionInputSchema>

export const printJobExecutionResultSchema = z
  .object({
    id: z.string(),
    status: z.enum(['completed', 'failed', 'queued']),
    copies: z.number().int().positive(),
    isReprint: z.boolean().optional()
  })
  .strict()

export type PrintJobExecutionResult = z.infer<typeof printJobExecutionResultSchema>

export const lostDeviceRevocationInputSchema = z
  .object({
    lostIdentityId: z.string().uuid(),
    reason: z.string().min(5).max(300)
  })
  .strict()

export type LostDeviceRevocationInput = z.infer<typeof lostDeviceRevocationInputSchema>

export const lostDeviceRevocationResultSchema = z
  .object({
    revoked: z.boolean(),
    activeSessionsTerminated: z.number().int().nonnegative()
  })
  .strict()

export type LostDeviceRevocationResult = z.infer<typeof lostDeviceRevocationResultSchema>

export const fulfillmentInventoryReconciliationReportSchema = z
  .object({
    orderId: z.string(),
    isReconciled: z.boolean(),
    orderedQuantity: z.number().int().nonnegative(),
    fulfilledQuantity: z.number().int().nonnegative(),
    inventoryDecremented: z.number().int().nonnegative(),
    discrepancies: z.array(z.string()),
    ledgerConsistent: z.boolean()
  })
  .strict()

export type FulfillmentInventoryReconciliationReport = z.infer<typeof fulfillmentInventoryReconciliationReportSchema>

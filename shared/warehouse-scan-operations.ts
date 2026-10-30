import { z } from 'zod'
import { catalogPolicyUuidSchema as uuid, catalogPolicyInstantSchema as instant } from './catalog-publication-policy'

export const queueTypeSchema = z.enum(['reception', 'picking', 'packing', 'exceptions'])
export type QueueType = z.infer<typeof queueTypeSchema>

export const queueItemStatusSchema = z.enum(['pending', 'in_progress', 'completed', 'exception'])
export type QueueItemStatus = z.infer<typeof queueItemStatusSchema>

export const scanItemDetailSchema = z
  .object({
    sku: z.string().min(1).max(80),
    barcode: z.string().min(1).max(80),
    name: z.string().min(1).max(200),
    expectedQty: z.number().int().min(1),
    scannedQty: z.number().int().min(0),
    location: z.string().optional(),
    lotNumber: z.string().optional()
  })
  .strict()
export type ScanItemDetail = z.infer<typeof scanItemDetailSchema>

export const warehouseQueueItemSchema = z
  .object({
    queueType: queueTypeSchema,
    id: z.string().min(1).max(64),
    referenceCode: z.string().min(1).max(100),
    priority: z.enum(['urgent', 'high', 'normal']),
    status: queueItemStatusSchema,
    itemsTotal: z.number().int().min(0),
    itemsScanned: z.number().int().min(0),
    items: z.array(scanItemDetailSchema),
    updatedAt: instant
  })
  .strict()
export type WarehouseQueueItem = z.infer<typeof warehouseQueueItemSchema>

export const createWarehouseReceptionInputSchema = z
  .object({
    supplierName: z.string().trim().min(2).max(160),
    referenceCode: z.string().trim().min(2).max(100),
    expectedItems: z.array(scanItemDetailSchema).min(1)
  })
  .strict()
export type CreateWarehouseReceptionInput = z.infer<typeof createWarehouseReceptionInputSchema>

export const barcodeScanInputSchema = z
  .object({
    queueType: z.enum(['reception', 'picking', 'packing']),
    targetId: z.string().min(1).max(64),
    barcode: z.string().trim().min(1).max(80),
    quantity: z.number().int().min(1).default(1),
    location: z.string().optional()
  })
  .strict()
export type BarcodeScanInput = z.infer<typeof barcodeScanInputSchema>

export const exceptionTypeSchema = z.enum([
  'damaged_item',
  'barcode_mismatch',
  'shortage',
  'spill_hazard',
  'expired_lot',
  'damaged_box'
])
export type ExceptionType = z.infer<typeof exceptionTypeSchema>

export const exceptionSeveritySchema = z.enum(['low', 'medium', 'high', 'critical'])
export type ExceptionSeverity = z.infer<typeof exceptionSeveritySchema>

export const reportWarehouseExceptionInputSchema = z
  .object({
    targetType: z.enum(['order', 'reception', 'item']),
    targetId: z.string().trim().min(1).max(64),
    exceptionType: exceptionTypeSchema,
    severity: exceptionSeveritySchema,
    reason: z.string().trim().min(10).max(500)
  })
  .strict()
export type ReportWarehouseExceptionInput = z.infer<typeof reportWarehouseExceptionInputSchema>

export const resolveWarehouseExceptionInputSchema = z
  .object({
    resolution: z.enum(['resolved', 'waived', 'returned_to_vendor', 'scrapped']),
    resolutionNotes: z.string().trim().min(5).max(500)
  })
  .strict()
export type ResolveWarehouseExceptionInput = z.infer<typeof resolveWarehouseExceptionInputSchema>

export const warehouseExceptionRecordSchema = z
  .object({
    id: uuid,
    targetType: z.enum(['order', 'reception', 'item']),
    targetId: z.string(),
    exceptionType: exceptionTypeSchema,
    severity: exceptionSeveritySchema,
    reason: z.string(),
    status: z.enum(['open', 'investigating', 'resolved', 'waived']),
    reportedBy: uuid,
    resolvedBy: uuid.nullable().optional(),
    resolutionNotes: z.string().nullable().optional(),
    createdAt: instant,
    updatedAt: instant
  })
  .strict()
export type WarehouseExceptionRecord = z.infer<typeof warehouseExceptionRecordSchema>

export const warehousePrinterSchema = z
  .object({
    id: z.string().min(2).max(64),
    name: z.string().min(2).max(80),
    location: z.string().min(2).max(80),
    protocol: z.enum(['zpl', 'ipp', 'raw_tcp', 'cups_pdf']),
    endpointAddress: z.string().optional(),
    status: z.enum(['online', 'offline', 'error', 'paper_out']),
    supportedFormats: z.array(z.string())
  })
  .strict()
export type WarehousePrinter = z.infer<typeof warehousePrinterSchema>

export const dispatchPrintJobInputSchema = z
  .object({
    printerId: z.string().min(2).max(64),
    labelType: z.enum(['parcel_4x6', 'shelf_barcode', 'lot_tag']),
    documentId: z.string().min(1).max(64),
    copies: z.number().int().min(1).max(100).default(1)
  })
  .strict()
export type DispatchPrintJobInput = z.infer<typeof dispatchPrintJobInputSchema>

export const warehouseMetricsSummarySchema = z
  .object({
    queueCounts: z.object({
      reception: z.number().int().min(0),
      picking: z.number().int().min(0),
      packing: z.number().int().min(0),
      exceptions: z.number().int().min(0)
    }),
    dailyStats: z.object({
      itemsScannedToday: z.number().int().min(0),
      ordersCompletedToday: z.number().int().min(0),
      exceptionsRaisedToday: z.number().int().min(0),
      avgPickMinutes: z.number().min(0),
      avgPackMinutes: z.number().min(0)
    }),
    activeOperatorsCount: z.number().int().min(0),
    printers: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        status: z.string()
      })
    )
  })
  .strict()
export type WarehouseMetricsSummary = z.infer<typeof warehouseMetricsSummarySchema>

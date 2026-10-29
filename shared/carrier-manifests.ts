import { z } from 'zod'

const commandId = z
  .string()
  .min(8)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/)
const expectedVersion = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)
const tracking = z.string().trim().min(1).max(120)

export const manifestCarrierSchema = z.string().trim().min(1).max(100)
export const createManifestInputSchema = z
  .object({
    commandId,
    carrier: manifestCarrierSchema,
    pickupDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
  })
  .strict()
export const setManifestItemInputSchema = z
  .object({ commandId, expectedVersion, trackingNumber: tracking, decision: z.enum(['included', 'excluded']) })
  .strict()
export const closeManifestInputSchema = z.object({ commandId, expectedVersion }).strict()
export const cancelManifestInputSchema = z.object({ commandId, expectedVersion }).strict()
export const schedulePickupInputSchema = z.object({ commandId, expectedVersion }).strict()
export const confirmPickupInputSchema = z
  .object({ commandId, expectedVersion, scannedTrackingNumbers: z.array(tracking).max(1000) })
  .strict()

export type CreateManifestInput = z.infer<typeof createManifestInputSchema>
export type SetManifestItemInput = z.infer<typeof setManifestItemInputSchema>
export type ManifestStatus = 'open' | 'closed' | 'picked_up' | 'discrepancy' | 'cancelled'
export type ExclusionReason = 'already_manifested' | 'order_exception' | 'already_delivered' | 'manual_hold'

export interface ManifestItemView {
  trackingNumber: string
  shipmentNumber: string
  orderId: string
  parcelIndex: number
  weightGrams: number
  decision: 'included' | 'excluded'
  exclusionReason: ExclusionReason | null
  scanStatus: 'pending' | 'scanned' | 'missing'
}
export interface ManifestView {
  id: string
  carrier: string
  pickupDate: string
  status: ManifestStatus
  version: number
  includedShipments: number
  excludedShipments: number
  parcelCount: number
  weightGrams: number
  providerManifestId: string | null
  closedAt: string | null
  createdAt: string
  updatedAt: string
  items: ManifestItemView[]
  documents: Array<{ kind: 'manifest_csv' | 'pickup_receipt'; sha256: string; byteLength: number; createdAt: string }>
  pickup: {
    providerPickupId: string
    scheduledDate: string
    parcelCount: number
    status: 'scheduled' | 'confirmed' | 'discrepancy'
    scannedCount: number | null
    missingCount: number | null
    unexpectedTrackings: string[]
    confirmedAt: string | null
  } | null
  reconciliation: {
    candidates: number
    included: number
    excluded: number
    excludedByReason: Partial<Record<ExclusionReason, number>>
    balanced: boolean
  }
}
export interface ManifestSummary {
  id: string
  carrier: string
  pickupDate: string
  status: ManifestStatus
  version: number
  includedShipments: number
  excludedShipments: number
  parcelCount: number
}

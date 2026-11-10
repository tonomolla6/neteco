import { z } from 'zod'

export const telemetryFacetSchema = z.enum([
  'pick_rate',
  'dock_to_stock',
  'packing',
  'on_time_delivery',
  'damages',
  'capacity',
  'devices'
])
export type TelemetryFacet = z.infer<typeof telemetryFacetSchema>

export const telemetryShiftCodeSchema = z.enum(['morning', 'afternoon', 'night'])
export type TelemetryShiftCode = z.infer<typeof telemetryShiftCodeSchema>

export const telemetryZoneCodeSchema = z.enum([
  'chemicals_bulk',
  'picking_flow',
  'packing_dock',
  'fleet_transit',
  'warehouse_general'
])
export type TelemetryZoneCode = z.infer<typeof telemetryZoneCodeSchema>

export const warehouseDeviceTypeSchema = z.enum([
  'rf_scanner',
  'forklift_terminal',
  'driver_handheld',
  'pack_station_tablet'
])
export type WarehouseDeviceType = z.infer<typeof warehouseDeviceTypeSchema>

export const warehouseDeviceStatusSchema = z.enum(['online', 'offline', 'degraded'])
export type WarehouseDeviceStatus = z.infer<typeof warehouseDeviceStatusSchema>

export const warehouseTelemetryEventInputSchema = z
  .object({
    facet: telemetryFacetSchema,
    shiftCode: telemetryShiftCodeSchema,
    zoneCode: telemetryZoneCodeSchema,
    operatorId: z.string().trim().min(2).max(100),
    metricPrimary: z.number().min(0),
    metricSecondary: z.number().default(0),
    errorCount: z.number().int().min(0).default(0),
    laborPrivacyReviewed: z.literal(true), // Mandatory explicit verification
    metadata: z.record(z.string(), z.unknown()).default({}),
    occurredAt: z.string()
  })
  .strict()
export type WarehouseTelemetryEventInput = z.infer<typeof warehouseTelemetryEventInputSchema>

export const warehouseDeviceHeartbeatInputSchema = z
  .object({
    deviceId: z.string().trim().min(4).max(64),
    deviceType: warehouseDeviceTypeSchema,
    batteryPercent: z.number().int().min(0).max(100),
    appVersion: z.string().trim().min(1).max(32),
    syncLatencyMs: z.number().int().min(0),
    offlineQueueDepth: z.number().int().min(0),
    errorCount24h: z.number().int().min(0),
    status: warehouseDeviceStatusSchema
  })
  .strict()
export type WarehouseDeviceHeartbeatInput = z.infer<typeof warehouseDeviceHeartbeatInputSchema>

export const warehouseTelemetryComputeInputSchema = z
  .object({
    periodDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    shiftCode: z.enum(['morning', 'afternoon', 'night', 'all_day']),
    zoneCode: z.enum(['chemicals_bulk', 'picking_flow', 'packing_dock', 'fleet_transit', 'all_warehouse'])
  })
  .strict()
export type WarehouseTelemetryComputeInput = z.infer<typeof warehouseTelemetryComputeInputSchema>

export interface WarehouseTelemetryAggregate {
  id: string
  periodDate: string
  shiftCode: string
  zoneCode: string
  avgPickRatePerHour: number
  pickErrorRateBasisPoints: number
  dockToStockMinutes: number
  packingParcelsPerHour: number
  onTimeDeliveryRatio: number
  damagesCount: number
  warehouseCapacityPercent: number
  vehicleCapacityPercent: number
  healthyDevicesRatio: number
  laborPrivacyReviewed: boolean
  computedAt: string
  computedBy: string
}

export interface WarehouseDeviceTelemetry {
  deviceId: string
  deviceType: WarehouseDeviceType
  batteryPercent: number
  appVersion: string
  syncLatencyMs: number
  offlineQueueDepth: number
  errorCount24h: number
  status: WarehouseDeviceStatus
  lastHeartbeatAt: string
}

export interface WarehouseTelemetryEvent {
  id: string
  facet: TelemetryFacet
  shiftCode: TelemetryShiftCode
  zoneCode: TelemetryZoneCode
  operatorPseudonym: string
  metricPrimary: number
  metricSecondary: number
  errorCount: number
  laborPrivacyReviewed: boolean
  metadata: Record<string, unknown>
  occurredAt: string
  recordedAt: string
}

/**
 * Worker Privacy compliance helper (art. 20 bis ET, LOPDGDD arts. 89-90).
 * Replaces direct operator identifiers with a deterministic 64-character SHA-256 digest
 * with an internal salt so worker identities are not exposed to dashboard views.
 */
export async function pseudonymizeOperatorId(operatorId: string): Promise<string> {
  const bytes = new TextEncoder().encode(`neteco:labor-privacy:operator:v1:${operatorId.trim()}`)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

export async function warehouseTelemetryIntentHash(action: string, input: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(['warehouse-telemetry:v1', action, input]))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

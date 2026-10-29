import { z } from 'zod'

export const operationalAlertAreaSchema = z.enum(['warehouse', 'delivery', 'general'])
export type OperationalAlertArea = z.infer<typeof operationalAlertAreaSchema>

export const operationalAlertSeveritySchema = z.enum(['info', 'warning', 'critical'])
export type OperationalAlertSeverity = z.infer<typeof operationalAlertSeveritySchema>

export const operationalAlertCategorySchema = z.enum([
  'chemical_spill',
  'hazard_dg_rupture',
  'temperature_breach',
  'urgent_stock_shortage',
  'dock_blockage',
  'vehicle_breakdown',
  'route_blocked',
  'critical_delivery_delay',
  'parcel_hazardous_damage',
  'minor_damage_hold',
  'general_operational'
])
export type OperationalAlertCategory = z.infer<typeof operationalAlertCategorySchema>

export const operationalAlertStatusSchema = z.enum(['open', 'acknowledged', 'escalated', 'resolved'])
export type OperationalAlertStatus = z.infer<typeof operationalAlertStatusSchema>

export const operationalAlertChannelSchema = z.enum([
  'dashboard',
  'warehouse_terminal',
  'sms_pager',
  'redundant_webhook'
])
export type OperationalAlertChannel = z.infer<typeof operationalAlertChannelSchema>

export const operationalAlertInputSchema = z
  .object({
    area: operationalAlertAreaSchema,
    severity: operationalAlertSeveritySchema,
    category: operationalAlertCategorySchema,
    title: z.string().trim().min(5).max(200),
    description: z.string().trim().min(5).max(2000),
    locationRef: z.string().trim().min(2).max(100)
  })
  .strict()
export type OperationalAlertInput = z.infer<typeof operationalAlertInputSchema>

export const operationalAlertAckInputSchema = z
  .object({
    expectedVersion: z.number().int().min(1),
    ackNote: z.string().trim().min(1).max(1000)
  })
  .strict()
export type OperationalAlertAckInput = z.infer<typeof operationalAlertAckInputSchema>

export const operationalAlertEscalateInputSchema = z
  .object({
    expectedVersion: z.number().int().min(1),
    targetTier: z.number().int().min(2).max(4),
    escalationReason: z.string().trim().min(1).max(1000)
  })
  .strict()
export type OperationalAlertEscalateInput = z.infer<typeof operationalAlertEscalateInputSchema>

export const operationalAlertResolveInputSchema = z
  .object({
    expectedVersion: z.number().int().min(1),
    resolutionNote: z.string().trim().min(1).max(1000)
  })
  .strict()
export type OperationalAlertResolveInput = z.infer<typeof operationalAlertResolveInputSchema>

export const operationalAlertListQuerySchema = z
  .object({
    status: operationalAlertStatusSchema.optional(),
    severity: operationalAlertSeveritySchema.optional(),
    area: operationalAlertAreaSchema.optional(),
    page: z.number().int().min(1).default(1),
    perPage: z.number().int().min(1).max(50).default(20)
  })
  .strict()
export type OperationalAlertListQuery = z.infer<typeof operationalAlertListQuerySchema>

export interface OperationalAlertDispatch {
  id: string
  alertId: string
  channel: OperationalAlertChannel
  isRedundant: boolean
  recipientTarget: string
  status: 'dispatched' | 'delivered' | 'failed'
  dispatchedAt: string
}

export interface OperationalAlert {
  id: string
  area: OperationalAlertArea
  severity: OperationalAlertSeverity
  category: OperationalAlertCategory
  title: string
  description: string
  locationRef: string
  status: OperationalAlertStatus
  escalationTier: number
  redundantChannelRequired: boolean
  redundantChannelDispatched: boolean
  version: number
  acknowledgedAt: string | null
  acknowledgedBy: string | null
  ackNote: string | null
  escalatedAt: string | null
  escalationReason: string | null
  resolvedAt: string | null
  resolvedBy: string | null
  resolutionNote: string | null
  createdAt: string
  createdBy: string
  dispatches: OperationalAlertDispatch[]
}

export async function operationalAlertIntentHash(action: string, alertId: string, input: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(['operational-alert:v1', action, alertId, input]))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

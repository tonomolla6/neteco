import { z } from 'zod'

export const B2B_SLA_TIERS = ['standard', 'premium_b2b', 'enterprise_vip'] as const
export type B2BSlaTierCode = (typeof B2B_SLA_TIERS)[number]

export const B2B_CONTRACT_STATUSES = [
  'draft',
  'operational_check_pending',
  'active',
  'suspended_capacity',
  'terminated'
] as const
export type B2BContractStatus = (typeof B2B_CONTRACT_STATUSES)[number]

export const B2B_SERVICE_JOURNEYS = [
  'b2b_portal',
  'b2b_api_orders',
  'priority_fulfillment',
  'dedicated_support'
] as const
export type B2BServiceJourney = (typeof B2B_SERVICE_JOURNEYS)[number]

export const B2B_EXCLUSION_REASONS = [
  'scheduled_maintenance',
  'customer_fault',
  'force_majeure',
  'upstream_provider_outage'
] as const
export type B2BExclusionReason = (typeof B2B_EXCLUSION_REASONS)[number]

export const B2B_ALERT_LEVELS = ['nominal', 'warning_risk_of_breach', 'breached'] as const
export type B2BAlertLevel = (typeof B2B_ALERT_LEVELS)[number]

export class B2BContractSloError extends Error {
  constructor(
    public readonly code: string,
    public readonly statusCode: number = 400,
    message?: string
  ) {
    super(message ?? code)
    this.name = 'B2BContractSloError'
  }
}

export const createB2BContractSloSchema = z
  .object({
    commandId: z.string().uuid(),
    idempotencyKey: z.string().min(1).max(128),
    customerId: z.string().min(1).max(64),
    companyName: z.string().trim().min(2).max(200),
    contractRef: z.string().trim().min(4).max(64),
    tierCode: z.enum(B2B_SLA_TIERS),
    billingPeriodStart: z.string().datetime(),
    billingPeriodEnd: z.string().datetime()
  })
  .strict()
  .refine((data) => new Date(data.billingPeriodEnd) >= new Date(data.billingPeriodStart), {
    message: 'billingPeriodEnd must be greater than or equal to billingPeriodStart'
  })

export type CreateB2BContractSloInput = z.infer<typeof createB2BContractSloSchema>

export const verifyOperationalCapacitySchema = z
  .object({
    commandId: z.string().uuid(),
    idempotencyKey: z.string().min(1).max(128),
    contractId: z.string().uuid(),
    expectedVersion: z.number().int().positive(),
    capacityAssessment: z
      .object({
        errorBudgetHealthy: z.boolean(),
        currentHeadroomPercent: z.number().nonnegative(),
        hasDedicatedManager: z.boolean()
      })
      .strict()
  })
  .strict()

export type VerifyOperationalCapacityInput = z.infer<typeof verifyOperationalCapacitySchema>

export const recordB2BSloEventSchema = z
  .object({
    commandId: z.string().uuid(),
    idempotencyKey: z.string().min(1).max(128),
    contractId: z.string().uuid(),
    eventDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    serviceJourney: z.enum(B2B_SERVICE_JOURNEYS),
    totalTransactions: z.number().int().nonnegative(),
    successfulTransactions: z.number().int().nonnegative(),
    p95LatencyMs: z.number().int().nonnegative(),
    downtimeMinutes: z.number().int().nonnegative(),
    supportTicketsCount: z.number().int().nonnegative().default(0),
    supportBreachesCount: z.number().int().nonnegative().default(0),
    fulfillmentDispatchesCount: z.number().int().nonnegative().default(0),
    fulfillmentDelaysCount: z.number().int().nonnegative().default(0)
  })
  .strict()
  .refine((data) => data.successfulTransactions <= data.totalTransactions, {
    message: 'successfulTransactions cannot exceed totalTransactions'
  })
  .refine((data) => data.supportBreachesCount <= data.supportTicketsCount, {
    message: 'supportBreachesCount cannot exceed supportTicketsCount'
  })
  .refine((data) => data.fulfillmentDelaysCount <= data.fulfillmentDispatchesCount, {
    message: 'fulfillmentDelaysCount cannot exceed fulfillmentDispatchesCount'
  })

export type RecordB2BSloEventInput = z.infer<typeof recordB2BSloEventSchema>

export const recordB2BExclusionSchema = z
  .object({
    commandId: z.string().uuid(),
    idempotencyKey: z.string().min(1).max(128),
    contractId: z.string().uuid(),
    reasonCategory: z.enum(B2B_EXCLUSION_REASONS),
    startTime: z.string().datetime(),
    endTime: z.string().datetime(),
    excludedDowntimeMinutes: z.number().int().positive(),
    justification: z.string().trim().min(10).max(1000)
  })
  .strict()
  .refine((data) => new Date(data.endTime) >= new Date(data.startTime), {
    message: 'endTime must be greater than or equal to startTime'
  })

export type RecordB2BExclusionInput = z.infer<typeof recordB2BExclusionSchema>

export const generateComplianceReportSchema = z
  .object({
    commandId: z.string().uuid(),
    idempotencyKey: z.string().min(1).max(128),
    contractId: z.string().uuid(),
    reportMonth: z.string().regex(/^\d{4}-\d{2}$/)
  })
  .strict()

export type GenerateComplianceReportInput = z.infer<typeof generateComplianceReportSchema>

export interface B2BSlaTier {
  tierCode: B2BSlaTierCode
  name: string
  availabilitySloTarget: number
  apiP95LatencyMs: number
  supportResponseMaxMinutes: number
  dispatchLeadHours: number
  requiredDedicatedManager: boolean
  requiredMinHeadroomPercent: number
  penaltyCreditPercentPerBreach: number
}

export interface B2BContractSloRecord {
  id: string
  customerId: string
  companyName: string
  contractRef: string
  tierCode: B2BSlaTierCode
  availabilityTarget: number
  apiP95LatencyTargetMs: number
  supportResponseTargetMin: number
  dispatchLeadTargetHours: number
  status: B2BContractStatus
  operationalCapacityVerified: boolean
  operationalCheckNotes?: string | null
  billingPeriodStart: string
  billingPeriodEnd: string
  createdBy: string
  version: number
  createdAt: string
  updatedAt: string
}

export interface B2BComplianceReport {
  id: string
  contractId: string
  reportMonth: string
  availabilityAchieved: number
  targetAvailability: number
  availabilityCompliant: boolean
  latencyP95AchievedMs: number
  latencyCompliant: boolean
  supportCompliant: boolean
  fulfillmentCompliant: boolean
  overallCompliant: boolean
  totalDowntimeMinutes: number
  excludedDowntimeMinutes: number
  netChargeableDowntimeMinutes: number
  penaltyCreditEur: number
  alertLevel: B2BAlertLevel
  generatedAt: string
}

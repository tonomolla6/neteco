import { z } from 'zod'

export const CLOUDFLARE_RESOURCE_KEYS = [
  'worker_cpu_ms',
  'worker_subrequests',
  'd1_rows_read_daily',
  'd1_rows_written_daily',
  'd1_storage_bytes',
  'do_connections_hotspot',
  'r2_class_a_operations_monthly',
  'r2_class_b_operations_monthly',
  'r2_storage_bytes',
  'queues_backlog_messages',
  'workflows_active_instances',
  'cdn_edge_bandwidth_gb',
  'provider_redsys_tps',
  'provider_beply_rate_limit'
] as const

export type CloudflareResourceKey = (typeof CLOUDFLARE_RESOURCE_KEYS)[number]

export const CAPACITY_PLAN_STATUSES = [
  'draft',
  'simulated_passed',
  'simulated_warning',
  'simulated_failed',
  'approved'
] as const

export type CapacityPlanStatus = (typeof CAPACITY_PLAN_STATUSES)[number]

export const HEADROOM_VERDICTS = ['healthy', 'warning_headroom_low', 'critical_quota_exhausted'] as const

export type HeadroomVerdict = (typeof HEADROOM_VERDICTS)[number]

export class CloudflareCapacityError extends Error {
  constructor(
    public readonly code: string,
    public readonly statusCode: number = 400,
    message?: string
  ) {
    super(message ?? code)
    this.name = 'CloudflareCapacityError'
  }
}

export const simulateCampaignSchema = z
  .object({
    commandId: z.string().uuid(),
    idempotencyKey: z.string().min(1).max(128),
    campaignName: z.string().trim().min(3).max(100),
    startTime: z.string().datetime(),
    endTime: z.string().datetime(),
    projectedPeakMultiplier: z.number().min(1.0).max(50.0),
    projectedVisitorsPeak: z.number().int().positive(),
    projectedOrdersHour: z.number().int().nonnegative()
  })
  .strict()
  .refine((data) => new Date(data.endTime) >= new Date(data.startTime), {
    message: 'endTime must be greater than or equal to startTime'
  })

export type SimulateCampaignInput = z.infer<typeof simulateCampaignSchema>

export const approveCampaignPlanSchema = z
  .object({
    commandId: z.string().uuid(),
    idempotencyKey: z.string().min(1).max(128),
    planId: z.string().uuid(),
    expectedVersion: z.number().int().positive()
  })
  .strict()

export type ApproveCampaignPlanInput = z.infer<typeof approveCampaignPlanSchema>

export interface CapacityMetricRecord {
  resourceKey: CloudflareResourceKey
  quotaLimit: number
  currentBaseline: number
  unit: string
  costPerMillionUnits: number
  headroomPercent: number
  updatedAt: string
}

export interface CapacityBottleneck {
  resourceKey: CloudflareResourceKey
  unit: string
  baseline: number
  projectedPeak: number
  quotaLimit: number
  headroomPercent: number
  status: 'healthy' | 'warning' | 'critical'
  recommendedMitigation?: string
}

export interface CloudflareCampaignPlan {
  id: string
  campaignName: string
  startTime: string
  endTime: string
  projectedPeakMultiplier: number
  projectedVisitorsPeak: number
  projectedOrdersHour: number
  status: CapacityPlanStatus
  headroomVerdict: HeadroomVerdict
  minHeadroomPercent: number
  minHeadroomResource: CloudflareResourceKey
  estimatedCloudflareCostEur: number
  bottlenecks: CapacityBottleneck[]
  mitigations: string[]
  createdBy: string
  version: number
  createdAt: string
  updatedAt: string
}

export const DEFAULT_CAPACITY_BASELINES: Record<
  CloudflareResourceKey,
  { quotaLimit: number; currentBaseline: number; unit: string; costPerMillionUnits: number }
> = {
  worker_cpu_ms: { quotaLimit: 50.0, currentBaseline: 12.0, unit: 'ms', costPerMillionUnits: 0.15 },
  worker_subrequests: { quotaLimit: 50.0, currentBaseline: 6.0, unit: 'count', costPerMillionUnits: 0.0 },
  d1_rows_read_daily: {
    quotaLimit: 25000000.0,
    currentBaseline: 3500000.0,
    unit: 'rows/day',
    costPerMillionUnits: 0.001
  },
  d1_rows_written_daily: {
    quotaLimit: 5000000.0,
    currentBaseline: 400000.0,
    unit: 'rows/day',
    costPerMillionUnits: 1.0
  },
  d1_storage_bytes: {
    quotaLimit: 10737418240.0,
    currentBaseline: 1500000000.0,
    unit: 'bytes',
    costPerMillionUnits: 0.75
  },
  do_connections_hotspot: { quotaLimit: 500.0, currentBaseline: 45.0, unit: 'count', costPerMillionUnits: 0.0 },
  r2_class_a_operations_monthly: {
    quotaLimit: 1000000.0,
    currentBaseline: 120000.0,
    unit: 'count',
    costPerMillionUnits: 4.5
  },
  r2_class_b_operations_monthly: {
    quotaLimit: 10000000.0,
    currentBaseline: 1800000.0,
    unit: 'count',
    costPerMillionUnits: 0.36
  },
  r2_storage_bytes: {
    quotaLimit: 107374182400.0,
    currentBaseline: 18000000000.0,
    unit: 'bytes',
    costPerMillionUnits: 0.015
  },
  queues_backlog_messages: { quotaLimit: 100000.0, currentBaseline: 2500.0, unit: 'count', costPerMillionUnits: 0.4 },
  workflows_active_instances: { quotaLimit: 1000.0, currentBaseline: 80.0, unit: 'count', costPerMillionUnits: 0.5 },
  cdn_edge_bandwidth_gb: { quotaLimit: 1000.0, currentBaseline: 140.0, unit: 'gb', costPerMillionUnits: 40.0 },
  provider_redsys_tps: { quotaLimit: 25.0, currentBaseline: 2.5, unit: 'tps', costPerMillionUnits: 0.0 },
  provider_beply_rate_limit: {
    quotaLimit: 120.0,
    currentBaseline: 20.0,
    unit: 'requests/min',
    costPerMillionUnits: 0.0
  }
}

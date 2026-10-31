import { z } from 'zod'

export const INTEGRATION_FAULT_TYPES = [
  'timeout',
  'http_500',
  'http_401',
  'partial_payload',
  'duplicate',
  'latency'
] as const

export type IntegrationFaultType = (typeof INTEGRATION_FAULT_TYPES)[number]

export const RECOVERY_ACTIONS = [
  'retried',
  'idempotent_cached',
  'clean_rejection',
  'dlq_routed',
  'fallback_executed'
] as const

export type RecoveryAction = (typeof RECOVERY_ACTIONS)[number]

export const FAULT_PROVIDERS = ['beply', 'redsys', 'carrier', 'webhook', 'all'] as const
export type FaultProvider = (typeof FAULT_PROVIDERS)[number]

export const FaultInjectionScenarioInputSchema = z.object({
  provider: z.enum(FAULT_PROVIDERS),
  operation: z.string().min(2).max(64),
  faultType: z.enum(INTEGRATION_FAULT_TYPES),
  targetEntityId: z.string().min(2).max(128),
  timeoutMs: z.number().int().min(1).max(30000).optional(),
  latencyMs: z.number().int().min(1).max(30000).optional(),
  idempotencyKey: z.string().min(4).max(128).optional(),
  parameters: z.record(z.unknown()).optional()
})

export type FaultInjectionScenarioInput = z.infer<typeof FaultInjectionScenarioInputSchema>

export const FaultRuleInputSchema = z.object({
  id: z.string().uuid().optional(),
  provider: z.enum(FAULT_PROVIDERS),
  operation: z.string().min(2).max(64),
  faultType: z.enum(INTEGRATION_FAULT_TYPES),
  parameters: z.record(z.unknown()).optional(),
  active: z.boolean().default(true),
  expectedVersion: z.number().int().positive().optional()
})

export type FaultRuleInput = z.infer<typeof FaultRuleInputSchema>

export interface FaultRule {
  id: string
  provider: FaultProvider
  operation: string
  faultType: IntegrationFaultType
  parameters: Record<string, unknown>
  active: boolean
  version: number
  createdBy: string
  createdAt: string
  updatedAt: string
}

export interface FaultSimulationResult {
  id: string
  ruleId?: string | null
  provider: FaultProvider
  operation: string
  faultInjected: IntegrationFaultType
  recovered: boolean
  recoveryAction: RecoveryAction
  stateConsistent: boolean
  auditDetails: Record<string, unknown>
  createdAt: string
}

export interface EntityConsistencyCheck {
  entityId: string
  corrupted: boolean
  casVersionIntact: boolean
  duplicateCount: number
  outboxClean: boolean
  notes: string[]
}

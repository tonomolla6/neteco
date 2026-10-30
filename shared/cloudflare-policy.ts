import { z } from 'zod'

export const TARGET_ENVIRONMENTS = ['preview', 'staging', 'production'] as const
export type TargetEnvironment = (typeof TARGET_ENVIRONMENTS)[number]

export class CloudflarePolicyError extends Error {
  constructor(
    public readonly code: string,
    public readonly statusCode: number = 400,
    message?: string
  ) {
    super(message ?? code)
    this.name = 'CloudflarePolicyError'
  }
}

export const r2BucketConfigSchema = z
  .object({
    bucketName: z.string().min(1).max(64),
    publicAccess: z.boolean(),
    bucketWebsite: z.boolean().optional(),
    corsRules: z.array(z.unknown()).optional(),
    authorizedPublicBypass: z.boolean().optional()
  })
  .strict()

export const bindingConfigSchema = z
  .object({
    bindingName: z.string().min(1).max(64),
    type: z.enum(['d1', 'kv', 'r2', 'durable_object', 'queue', 'service']),
    targetResource: z.string().min(1).max(128),
    targetEnvironment: z.enum(['preview', 'staging', 'production'])
  })
  .strict()

export const d1DatabaseConfigSchema = z
  .object({
    databaseName: z.string().min(1).max(64),
    databaseId: z.string().min(1).max(64),
    timeTravelEnabled: z.boolean(),
    isolatedNamespace: z.boolean(),
    backupScheduleConfigured: z.boolean()
  })
  .strict()

export const durableObjectConfigSchema = z
  .object({
    className: z.string().min(1).max(64),
    isolatedNamespace: z.boolean()
  })
  .strict()

export const edgeSecurityConfigSchema = z
  .object({
    minTlsVersion: z.enum(['1.0', '1.1', '1.2', '1.3']),
    sslMode: z.enum(['off', 'flexible', 'full', 'strict', 'full_strict']),
    wafEnabled: z.boolean(),
    managedRulesetsActive: z.boolean(),
    backupExportConfigured: z.boolean()
  })
  .strict()

export const cloudflareManifestSchema = z
  .object({
    environment: z.enum(TARGET_ENVIRONMENTS),
    policyVersion: z.string().min(1).max(32),
    r2Buckets: z.array(r2BucketConfigSchema),
    bindings: z.array(bindingConfigSchema),
    d1Databases: z.array(d1DatabaseConfigSchema),
    durableObjects: z.array(durableObjectConfigSchema),
    vars: z.record(z.string()),
    edgeSecurity: edgeSecurityConfigSchema
  })
  .strict()

export type CloudflareManifest = z.infer<typeof cloudflareManifestSchema>

export interface PolicyViolation {
  ruleId: string
  severity: 'blocker' | 'warning'
  resource: string
  message: string
}

export interface DriftDifference {
  resource: string
  property: string
  expected: unknown
  actual: unknown
  critical: boolean
}

export const runPolicyAuditSchema = z
  .object({
    commandId: z.string().min(6).max(128),
    environment: z.enum(TARGET_ENVIRONMENTS),
    manifest: cloudflareManifestSchema
  })
  .strict()

export type RunPolicyAuditInput = z.infer<typeof runPolicyAuditSchema>

export const runDriftAuditSchema = z
  .object({
    commandId: z.string().min(6).max(128),
    environment: z.enum(TARGET_ENVIRONMENTS),
    declaredManifest: cloudflareManifestSchema,
    liveManifest: cloudflareManifestSchema
  })
  .strict()

export type RunDriftAuditInput = z.infer<typeof runDriftAuditSchema>

export interface CloudflarePolicyAuditRecord {
  id: string
  targetEnvironment: TargetEnvironment
  policyVersion: string
  passed: boolean
  blockersCount: number
  warningsCount: number
  rulesEvaluatedCount: number
  violations: PolicyViolation[]
  manifestHash: string
  hasCriticalDrift: boolean
  driftSummary: DriftDifference[] | null
  createdAt: string
  createdBy: string
}

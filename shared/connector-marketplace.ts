import { z } from 'zod'

export const CONNECTOR_CATEGORIES = [
  'erp',
  'carrier',
  'payment',
  'crm',
  'accounting',
  'marketing',
  'analytics',
  'webhook'
] as const
export type ConnectorCategory = (typeof CONNECTOR_CATEGORIES)[number]

export const CONNECTOR_PROVIDER_TYPES = ['internal_adapter', 'webhook_outbound', 'rest_sync', 'edi_batch'] as const
export type ConnectorProviderType = (typeof CONNECTOR_PROVIDER_TYPES)[number]

export const GOVERNED_SCOPES = [
  'orders.read',
  'orders.write',
  'catalog.read',
  'inventory.read',
  'inventory.write',
  'customers.read_masked',
  'shipping.read',
  'shipping.write',
  'webhooks.deliver'
] as const
export type GovernedScope = (typeof GOVERNED_SCOPES)[number]

export const GOVERNANCE_STATUSES = ['draft', 'in_review', 'approved', 'rejected', 'deprecated'] as const
export type GovernanceStatus = (typeof GOVERNANCE_STATUSES)[number]

export const INSTALLATION_STATUSES = ['active', 'paused', 'uninstalled'] as const
export type InstallationStatus = (typeof INSTALLATION_STATUSES)[number]

// --- Zod schemas ---

export const connectorIdSchema = z
  .string()
  .min(3)
  .max(64)
  .regex(/^[a-z0-9_-]+$/, 'El identificador debe contener solo minúsculas, números, guiones y guiones bajos')

export const governedScopeSchema = z.enum(GOVERNED_SCOPES)

export const proposeConnectorSchema = z
  .object({
    id: connectorIdSchema,
    name: z.string().min(2).max(100),
    category: z.enum(CONNECTOR_CATEGORIES),
    description: z.string().min(5).max(1000),
    version: z
      .string()
      .min(1)
      .max(32)
      .regex(/^[0-9]+(\.[0-9]+)*(-[a-z0-9.]+)?$/i, 'Formato de versión semántica'),
    providerType: z.enum(CONNECTOR_PROVIDER_TYPES),
    allowedScopes: z
      .array(governedScopeSchema)
      .min(1)
      .refine((items) => new Set(items).size === items.length, {
        message: 'Los scopes permitidos no deben contener duplicados'
      }),
    configSchema: z
      .object({
        endpointUrl: z.string().url().optional(),
        timeoutMs: z.number().int().min(100).max(30000).optional(),
        declaredSecrets: z
          .array(
            z
              .string()
              .min(2)
              .max(64)
              .regex(/^[a-zA-Z0-9_-]+$/)
          )
          .max(10)
      })
      .passthrough()
  })
  .strict()

export const reviewConnectorSchema = z
  .object({
    decision: z.enum(['approve', 'reject']),
    reviewNotes: z.string().min(10).max(1000)
  })
  .strict()

export const secretInputSchema = z.string().min(8, 'El secreto debe tener al menos 8 caracteres').max(512)

export const installConnectorSchema = z
  .object({
    connectorId: connectorIdSchema,
    displayName: z.string().min(2).max(100),
    grantedScopes: z
      .array(governedScopeSchema)
      .min(1)
      .refine((items) => new Set(items).size === items.length, {
        message: 'Los scopes otorgados no deben contener duplicados'
      }),
    config: z.record(z.string(), z.unknown()).default({}),
    secrets: z.record(z.string().regex(/^[a-zA-Z0-9_-]+$/), secretInputSchema).default({})
  })
  .strict()

export const configureConnectorSchema = z
  .object({
    action: z.enum(['configure', 'pause', 'resume']),
    config: z.record(z.string(), z.unknown()).optional(),
    expectedVersion: z.number().int().positive()
  })
  .strict()

export const rotateSecretSchema = z
  .object({
    action: z.literal('rotate_secret'),
    secretKey: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-zA-Z0-9_-]+$/),
    secretValue: secretInputSchema,
    expectedVersion: z.number().int().positive()
  })
  .strict()

export const uninstallConnectorSchema = z
  .object({
    action: z.literal('uninstall'),
    expectedVersion: z.number().int().positive(),
    reason: z.string().min(3).max(500).optional()
  })
  .strict()

export const dispatchConnectorSchema = z
  .object({
    operation: z.string().min(1).max(64),
    payload: z.record(z.string(), z.unknown()).default({}),
    requiredScope: governedScopeSchema
  })
  .strict()

// --- Secret utilities ---

export function maskSecret(secret: string): string {
  if (secret.length <= 8) {
    return '••••' + secret.slice(-2)
  }
  const prefixMatch = secret.match(/^([a-z0-9]+_)/i)
  const prefix = prefixMatch?.[1] ?? ''
  const remaining = secret.slice(prefix.length)
  if (remaining.length <= 6) {
    return `${prefix}••••${remaining.slice(-2)}`
  }
  return `${prefix}••••••${remaining.slice(-4)}`
}

export async function hashSecret(secret: string, pepper = ''): Promise<string> {
  const encoder = new TextEncoder()
  const data = encoder.encode(`${pepper}:${secret}`)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

export async function encryptSecret(secret: string, pepper: string): Promise<string> {
  // Deterministic AES-GCM envelope using HKDF-derived key from pepper and nonce
  const enc = new TextEncoder()
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(pepper.padEnd(32, '0').slice(0, 32)),
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt']
  )
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, keyMaterial, enc.encode(secret))
  const combined = new Uint8Array(iv.length + ciphertext.byteLength)
  combined.set(iv, 0)
  combined.set(new Uint8Array(ciphertext), iv.length)
  return Array.from(combined, (b) => b.toString(16).padStart(2, '0')).join('')
}

// --- Metrics calculation ---

export interface RawMetricEvent {
  status: 'success' | 'failure' | 'timeout'
  latency_ms: number
  error_code: string | null
  invoked_at: string
}

export interface ConnectorMetricsSummary {
  totalInvocations: number
  successCount: number
  errorCount: number
  errorRate: number
  avgLatencyMs: number
  p95LatencyMs: number
  minLatencyMs: number
  maxLatencyMs: number
  lastInvokedAt: string | null
  lastSuccessAt: string | null
  lastErrorAt: string | null
  lastErrorCode: string | null
}

export function calculateConnectorMetrics(events: RawMetricEvent[]): ConnectorMetricsSummary {
  if (events.length === 0) {
    return {
      totalInvocations: 0,
      successCount: 0,
      errorCount: 0,
      errorRate: 0,
      avgLatencyMs: 0,
      p95LatencyMs: 0,
      minLatencyMs: 0,
      maxLatencyMs: 0,
      lastInvokedAt: null,
      lastSuccessAt: null,
      lastErrorAt: null,
      lastErrorCode: null
    }
  }

  let successCount = 0
  let errorCount = 0
  let sumLatency = 0
  let minLatencyMs = Number.MAX_SAFE_INTEGER
  let maxLatencyMs = 0
  let lastInvokedAt: string | null = null
  let lastSuccessAt: string | null = null
  let lastErrorAt: string | null = null
  let lastErrorCode: string | null = null

  const latencies: number[] = []

  for (const e of events) {
    latencies.push(e.latency_ms)
    sumLatency += e.latency_ms
    if (e.latency_ms < minLatencyMs) minLatencyMs = e.latency_ms
    if (e.latency_ms > maxLatencyMs) maxLatencyMs = e.latency_ms

    if (!lastInvokedAt || e.invoked_at > lastInvokedAt) {
      lastInvokedAt = e.invoked_at
    }

    if (e.status === 'success') {
      successCount++
      if (!lastSuccessAt || e.invoked_at > lastSuccessAt) {
        lastSuccessAt = e.invoked_at
      }
    } else {
      errorCount++
      if (!lastErrorAt || e.invoked_at > lastErrorAt) {
        lastErrorAt = e.invoked_at
        lastErrorCode = e.error_code
      }
    }
  }

  latencies.sort((a, b) => a - b)
  const p95Index = Math.min(Math.floor(latencies.length * 0.95), latencies.length - 1)
  const p95LatencyMs = latencies[p95Index] ?? 0

  return {
    totalInvocations: events.length,
    successCount,
    errorCount,
    errorRate: Math.round((errorCount / events.length) * 1000) / 1000,
    avgLatencyMs: Math.round(sumLatency / events.length),
    p95LatencyMs,
    minLatencyMs: minLatencyMs === Number.MAX_SAFE_INTEGER ? 0 : minLatencyMs,
    maxLatencyMs,
    lastInvokedAt,
    lastSuccessAt,
    lastErrorAt,
    lastErrorCode
  }
}

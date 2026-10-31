import { z } from 'zod'

export const SANDBOX_PROVIDERS = ['beply', 'redsys', 'carrier', 'generic'] as const
export type SandboxProvider = (typeof SANDBOX_PROVIDERS)[number]

export const CONTRACT_RUN_STATUSES = ['passed', 'drift_detected', 'quota_exceeded', 'failed'] as const
export type ContractRunStatus = (typeof CONTRACT_RUN_STATUSES)[number]

export const DRIFT_TYPES = [
  'schema_mismatch',
  'missing_field',
  'status_code_changed',
  'checksum_drift',
  'semantic_drift'
] as const
export type DriftType = (typeof DRIFT_TYPES)[number]

export interface ContractDriftFinding {
  field: string
  driftType: DriftType
  expected: string
  actual: string
}

export interface ExpectedContractSchema {
  requiredFields: string[]
  fieldTypes?: Record<string, 'string' | 'number' | 'boolean' | 'object' | 'array'>
  allowedStatuses?: string[]
}

/**
 * Validador estricto de seguridad de datos sintéticos y secretos de sandbox.
 * Rechaza credenciales de producción, endpoints reales no sandbox y PII real.
 */
export function assertSyntheticDataSafe(payload: unknown): void {
  if (!payload || typeof payload !== 'object') return

  const obj = payload as Record<string, unknown>
  const serialized = JSON.stringify(payload)

  // 1. Detección de claves de producción
  if (
    /live_sec_|live_pk_|beply_prod_|redsys_real_/i.test(serialized) ||
    (typeof obj.token === 'string' && obj.token.startsWith('live_'))
  ) {
    throw new Error('credential_safety_violation: production credentials are strictly forbidden in sandbox tests')
  }

  // 2. Validación de endpoint URL
  const endpoint = obj.endpointUrl || obj.url || obj.baseUrl
  if (typeof endpoint === 'string' && endpoint.length > 0) {
    try {
      const url = new URL(endpoint)
      if (url.protocol !== 'https:') {
        throw new Error('https_required: sandbox contract endpoints must use HTTPS')
      }
      if (
        !url.hostname.includes('sandbox') &&
        !url.hostname.includes('test') &&
        !url.hostname.includes('sis-t') &&
        !url.hostname.includes('invalid') &&
        !url.hostname.includes('localhost') &&
        !url.hostname.includes('127.0.0.1')
      ) {
        throw new Error('production_endpoint_violation: sandbox endpoints must include sandbox/test/invalid domain')
      }
    } catch (err: unknown) {
      if (err instanceof Error) {
        if (err.message.includes('https_required') || err.message.includes('production_endpoint_violation')) {
          throw err
        }
        throw new Error(`invalid_endpoint_url: ${err.message}`, { cause: err })
      }
      throw new Error(`invalid_endpoint_url: ${String(err)}`, { cause: err })
    }
  }

  // 3. Validación de PII sintética
  const customer = obj.customer
  if (customer && typeof customer === 'object') {
    const custObj = customer as Record<string, unknown>
    const email = custObj.email
    if (typeof email === 'string') {
      if (
        !email.endsWith('.invalid') &&
        !email.endsWith('@example.com') &&
        !email.includes('+sandbox') &&
        !email.includes('+contract')
      ) {
        throw new Error('synthetic_data_violation: customer email must use .invalid or synthetic test domain')
      }
    }

    const legalName = custObj.legalName || custObj.name
    if (typeof legalName === 'string') {
      if (
        !legalName.toLowerCase().includes('sandbox') &&
        !legalName.toLowerCase().includes('sintético') &&
        !legalName.toLowerCase().includes('sintetico') &&
        !legalName.toLowerCase().includes('test') &&
        !legalName.toLowerCase().includes('contrato')
      ) {
        throw new Error('synthetic_data_violation: customer name must explicitly indicate synthetic/sandbox test data')
      }
    }
  }
}

/**
 * Compara la respuesta de un proveedor con el esquema esperado y extrae las divergencias (drift).
 */
export function detectContractDrift(actual: unknown, expected: ExpectedContractSchema): ContractDriftFinding[] {
  const drifts: ContractDriftFinding[] = []

  if (!actual || typeof actual !== 'object' || Array.isArray(actual)) {
    drifts.push({
      field: '$root',
      driftType: 'schema_mismatch',
      expected: 'object',
      actual: actual === null ? 'null' : Array.isArray(actual) ? 'array' : typeof actual
    })
    return drifts
  }

  const record = actual as Record<string, unknown>

  // 1. Comprobación de campos obligatorios ausentes
  for (const field of expected.requiredFields) {
    if (!(field in record) || record[field] === undefined || record[field] === null) {
      drifts.push({
        field,
        driftType: 'missing_field',
        expected: 'present',
        actual: 'missing'
      })
    }
  }

  // 2. Comprobación de tipos de campos
  if (expected.fieldTypes) {
    for (const [field, expectedType] of Object.entries(expected.fieldTypes)) {
      if (field in record && record[field] !== undefined && record[field] !== null) {
        const val = record[field]
        const actualType = Array.isArray(val) ? 'array' : typeof val
        if (actualType !== expectedType) {
          drifts.push({
            field,
            driftType: 'schema_mismatch',
            expected: expectedType,
            actual: actualType
          })
        }
      }
    }
  }

  // 3. Comprobación de estados enumerados
  if (expected.allowedStatuses && typeof record.status === 'string') {
    if (!expected.allowedStatuses.includes(record.status)) {
      drifts.push({
        field: 'status',
        driftType: 'semantic_drift',
        expected: expected.allowedStatuses.join(' | '),
        actual: record.status
      })
    }
  }

  return drifts
}

export const SandboxContractRunInputSchema = z.object({
  provider: z.enum(SANDBOX_PROVIDERS),
  suiteName: z.string().min(2).max(100),
  simulateDrift: z.boolean().optional(),
  overrideCustomer: z
    .object({
      legalName: z.string(),
      email: z.string().email(),
      taxId: z.string().optional()
    })
    .optional()
})

export type SandboxContractRunInput = z.infer<typeof SandboxContractRunInputSchema>

export interface SandboxQuotaStatus {
  provider: SandboxProvider
  dailyLimit: number
  hourlyLimit: number
  dailyUsed: number
  hourlyUsed: number
  windowDate: string
  windowHour: string
  remainingDaily: number
  remainingHourly: number
}

export interface SandboxContractRunSummary {
  id: string
  provider: SandboxProvider
  suiteName: string
  status: ContractRunStatus
  durationMs: number
  syntheticSeed: string
  quotaConsumed: number
  driftCount: number
  driftSummary: ContractDriftFinding[]
  details: Record<string, unknown>
  triggeredBy: string
  createdAt: string
}

export interface SandboxDriftAlert {
  id: string
  runId: string
  provider: SandboxProvider
  severity: 'warning' | 'critical'
  driftType: DriftType
  description: string
  diff: ContractDriftFinding[]
  acknowledged: boolean
  acknowledgedAt?: string | null
  acknowledgedBy?: string | null
  createdAt: string
}

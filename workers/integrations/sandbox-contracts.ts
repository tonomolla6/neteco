import { randomUUID } from 'node:crypto'
import {
  assertSyntheticDataSafe,
  detectContractDrift,
  type ContractDriftFinding,
  type ContractRunStatus,
  type DriftType,
  type ExpectedContractSchema,
  type SandboxContractRunInput,
  type SandboxContractRunSummary,
  type SandboxDriftAlert,
  type SandboxProvider,
  type SandboxQuotaStatus
} from '../../shared/integration-sandbox-contracts'

export class SandboxContractsError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'SandboxContractsError'
  }
}

function normalizeNow(now?: string): string {
  const value = now ?? new Date().toISOString()
  return value.replace(/\.\d{3}Z$/, 'Z')
}

/**
 * Consulta y actualiza la ventana de cuota de llamadas a sandbox para un proveedor.
 */
export async function getSandboxContractQuotas(
  db: D1Database,
  provider: SandboxProvider,
  nowStr?: string
): Promise<SandboxQuotaStatus> {
  const now = normalizeNow(nowStr)
  const windowDate = now.slice(0, 10) // 'YYYY-MM-DD'
  const windowHour = now.slice(0, 13) // 'YYYY-MM-DDTHH'

  let row = await db
    .prepare(
      `SELECT provider, daily_limit, hourly_limit, daily_used, hourly_used, window_date, window_hour, version, updated_at
       FROM sandbox_contract_quotas
       WHERE provider = ?1`
    )
    .bind(provider)
    .first<{
      provider: SandboxProvider
      daily_limit: number
      hourly_limit: number
      daily_used: number
      hourly_used: number
      window_date: string
      window_hour: string
      version: number
      updated_at: string
    }>()

  if (!row) {
    // Si no existe, sembrar cuota por defecto
    await db
      .prepare(
        `INSERT OR IGNORE INTO sandbox_contract_quotas
         (provider, daily_limit, hourly_limit, daily_used, hourly_used, window_date, window_hour, version, updated_at)
         VALUES (?1, 100, 20, 0, 0, ?2, ?3, 1, ?4)`
      )
      .bind(provider, windowDate, windowHour, now)
      .run()

    row = {
      provider,
      daily_limit: 100,
      hourly_limit: 20,
      daily_used: 0,
      hourly_used: 0,
      window_date: windowDate,
      window_hour: windowHour,
      version: 1,
      updated_at: now
    }
  }

  // Comprobar si hay que resetear ventana diaria u horaria
  let dailyUsed = row.daily_used
  let hourlyUsed = row.hourly_used
  let needsUpdate = false

  if (row.window_date !== windowDate) {
    dailyUsed = 0
    hourlyUsed = 0
    needsUpdate = true
  } else if (row.window_hour !== windowHour) {
    hourlyUsed = 0
    needsUpdate = true
  }

  if (needsUpdate) {
    await db
      .prepare(
        `UPDATE sandbox_contract_quotas
         SET daily_used = ?1, hourly_used = ?2, window_date = ?3, window_hour = ?4, updated_at = ?5
         WHERE provider = ?6`
      )
      .bind(dailyUsed, hourlyUsed, windowDate, windowHour, now, provider)
      .run()
  }

  return {
    provider,
    dailyLimit: row.daily_limit,
    hourlyLimit: row.hourly_limit,
    dailyUsed,
    hourlyUsed,
    windowDate,
    windowHour,
    remainingDaily: Math.max(0, row.daily_limit - dailyUsed),
    remainingHourly: Math.max(0, row.hourly_limit - hourlyUsed)
  }
}

/**
 * Incrementa el uso de cuota para un proveedor. Retorna false si se excede el límite.
 */
async function consumeQuota(db: D1Database, provider: SandboxProvider, amount: number, now: string): Promise<boolean> {
  const quota = await getSandboxContractQuotas(db, provider, now)
  if (quota.dailyUsed + amount > quota.dailyLimit || quota.hourlyUsed + amount > quota.hourlyLimit) {
    return false
  }

  await db
    .prepare(
      `UPDATE sandbox_contract_quotas
       SET daily_used = daily_used + ?1, hourly_used = hourly_used + ?1, updated_at = ?2
       WHERE provider = ?3`
    )
    .bind(amount, now, provider)
    .run()

  return true
}

/**
 * Ejecuta una prueba de contrato sintética contra sandbox con detección de drift y cuotas.
 */
export async function executeSandboxContractRun(
  db: D1Database,
  input: SandboxContractRunInput,
  options: { actorId: string; now?: string }
): Promise<SandboxContractRunSummary> {
  const now = normalizeNow(options.now)
  const runId = randomUUID()
  const syntheticSeed = `contract-${runId.slice(0, 8)}`

  // 1. Validar seguridad de datos sintéticos
  const customer = input.overrideCustomer ?? {
    legalName: `NETECO Contrato Sandbox ${syntheticSeed}`,
    email: `contract+${syntheticSeed}@example.invalid`,
    taxId: '12345678Z'
  }

  const endpointUrl =
    input.provider === 'beply'
      ? 'https://sandbox.beply.es/api/v1/invoices'
      : input.provider === 'redsys'
        ? 'https://sis-t.redsys.es:25443/sis/realizarPago'
        : 'https://sandbox.carrier.invalid/v1/shipments'

  try {
    assertSyntheticDataSafe({
      customer,
      endpointUrl,
      orderNumber: `NETECO-${syntheticSeed.toUpperCase()}`,
      amountCents: 145
    })
  } catch (err: unknown) {
    throw new SandboxContractsError(err instanceof Error ? err.message : String(err))
  }

  // 2. Control de cuotas
  const quotaAllowed = await consumeQuota(db, input.provider, 1, now)
  if (!quotaAllowed) {
    const quotaExceededDetails = {
      reason: 'Sandbox rate limit or budget threshold exceeded',
      provider: input.provider,
      attemptedAt: now
    }

    await db
      .prepare(
        `INSERT INTO sandbox_contract_runs
         (id, provider, suite_name, status, duration_ms, synthetic_seed, quota_consumed, drift_count, drift_summary_json, details_json, triggered_by, created_at)
         VALUES (?1, ?2, ?3, 'quota_exceeded', 0, ?4, 0, 0, '[]', ?5, ?6, ?7)`
      )
      .bind(
        runId,
        input.provider,
        input.suiteName,
        syntheticSeed,
        JSON.stringify(quotaExceededDetails),
        options.actorId,
        now
      )
      .run()

    // Crear alerta de cuota
    const alertId = randomUUID()
    await db
      .prepare(
        `INSERT INTO sandbox_drift_alerts
         (id, run_id, provider, severity, drift_type, description, diff_json, acknowledged, created_at)
         VALUES (?1, ?2, ?3, 'critical', 'status_code_changed', ?4, '[]', 0, ?5)`
      )
      .bind(
        alertId,
        runId,
        input.provider,
        `Superado el límite de cuota configurado para llamadas al sandbox de ${input.provider}`,
        now
      )
      .run()

    return {
      id: runId,
      provider: input.provider,
      suiteName: input.suiteName,
      status: 'quota_exceeded',
      durationMs: 0,
      syntheticSeed,
      quotaConsumed: 0,
      driftCount: 0,
      driftSummary: [],
      details: quotaExceededDetails,
      triggeredBy: options.actorId,
      createdAt: now
    }
  }

  // 3. Ejecutar suite determinista de contrato y comparar con esquema esperado
  const expectedSchema: ExpectedContractSchema =
    input.provider === 'beply'
      ? {
          requiredFields: ['invoice_id', 'status', 'invoice_code', 'currency', 'pdf_checksum'],
          fieldTypes: {
            invoice_id: 'string',
            status: 'string',
            invoice_code: 'string',
            currency: 'string',
            pdf_checksum: 'string'
          },
          allowedStatuses: ['issued', 'paid', 'credit_note_issued']
        }
      : {
          requiredFields: ['order_reference', 'status', 'signature_version', 'action_url'],
          fieldTypes: {
            order_reference: 'string',
            status: 'string',
            signature_version: 'string',
            action_url: 'string'
          },
          allowedStatuses: ['authorized', 'redirect_ready', 'completed']
        }

  // Generar respuesta del adaptador / mock sandbox
  let simulatedResponse: Record<string, unknown>
  if (input.simulateDrift) {
    // Provocar drift intencional para verificar detección y alertas
    simulatedResponse =
      input.provider === 'beply'
        ? {
            invoice_id: `inv-${syntheticSeed}`,
            status: 'legacy_status_unsupported', // semantic drift
            // falta invoice_code (missing_field)
            currency: 978, // schema mismatch (number en vez de string)
            pdf_checksum: 'a'.repeat(64)
          }
        : {
            order_reference: `ORD-${syntheticSeed}`,
            status: 'divergent_protocol',
            signature_version: 'HMAC_SHA1_DEPRECATED',
            action_url: 'https://sis-t.redsys.es:25443/sis/realizarPago'
          }
  } else {
    simulatedResponse =
      input.provider === 'beply'
        ? {
            invoice_id: `inv-${syntheticSeed}`,
            status: 'issued',
            invoice_code: `F2026-${syntheticSeed.slice(-4).toUpperCase()}`,
            currency: 'EUR',
            pdf_checksum: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
          }
        : {
            order_reference: `ORD-${syntheticSeed}`,
            status: 'redirect_ready',
            signature_version: 'HMAC_SHA256_V1',
            action_url: 'https://sis-t.redsys.es:25443/sis/realizarPago'
          }
  }

  const drifts: ContractDriftFinding[] = detectContractDrift(simulatedResponse, expectedSchema)
  const status: ContractRunStatus = drifts.length > 0 ? 'drift_detected' : 'passed'
  const durationMs = 45 // Latencia simulada en contrato

  const details = {
    requestPayload: { customer, endpointUrl },
    responsePayload: simulatedResponse,
    executedSuite: input.suiteName
  }

  // Guardar run
  await db
    .prepare(
      `INSERT INTO sandbox_contract_runs
       (id, provider, suite_name, status, duration_ms, synthetic_seed, quota_consumed, drift_count, drift_summary_json, details_json, triggered_by, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7, ?8, ?9, ?10, ?11)`
    )
    .bind(
      runId,
      input.provider,
      input.suiteName,
      status,
      durationMs,
      syntheticSeed,
      drifts.length,
      JSON.stringify(drifts),
      JSON.stringify(details),
      options.actorId,
      now
    )
    .run()

  // Si hay drift, generar alerta
  if (drifts.length > 0) {
    const alertId = randomUUID()
    const description = `Divergencia de contrato detectada en ${input.provider}: ${drifts.map((d) => `${d.field} (${d.driftType})`).join(', ')}`
    await db
      .prepare(
        `INSERT INTO sandbox_drift_alerts
         (id, run_id, provider, severity, drift_type, description, diff_json, acknowledged, created_at)
         VALUES (?1, ?2, ?3, 'critical', ?4, ?5, ?6, 0, ?7)`
      )
      .bind(alertId, runId, input.provider, drifts[0]!.driftType, description, JSON.stringify(drifts), now)
      .run()
  }

  return {
    id: runId,
    provider: input.provider,
    suiteName: input.suiteName,
    status,
    durationMs,
    syntheticSeed,
    quotaConsumed: 1,
    driftCount: drifts.length,
    driftSummary: drifts,
    details,
    triggeredBy: options.actorId,
    createdAt: now
  }
}

/**
 * Lista ejecuciones históricas de pruebas de contrato sandbox.
 */
export async function listSandboxContractRuns(
  db: D1Database,
  filter?: { provider?: SandboxProvider; status?: ContractRunStatus; limit?: number }
): Promise<SandboxContractRunSummary[]> {
  let query = `SELECT id, provider, suite_name, status, duration_ms, synthetic_seed, quota_consumed, drift_count, drift_summary_json, details_json, triggered_by, created_at FROM sandbox_contract_runs WHERE 1=1`
  const binds: (string | number | boolean | null)[] = []

  if (filter?.provider) {
    binds.push(filter.provider)
    query += ` AND provider = ?${binds.length}`
  }
  if (filter?.status) {
    binds.push(filter.status)
    query += ` AND status = ?${binds.length}`
  }

  query += ` ORDER BY created_at DESC LIMIT ${filter?.limit ?? 50}`

  const { results } = await db
    .prepare(query)
    .bind(...binds)
    .all<{
      id: string
      provider: SandboxProvider
      suite_name: string
      status: ContractRunStatus
      duration_ms: number
      synthetic_seed: string
      quota_consumed: number
      drift_count: number
      drift_summary_json: string
      details_json: string
      triggered_by: string
      created_at: string
    }>()

  return (results ?? []).map((row) => ({
    id: row.id,
    provider: row.provider,
    suiteName: row.suite_name,
    status: row.status,
    durationMs: row.duration_ms,
    syntheticSeed: row.synthetic_seed,
    quotaConsumed: row.quota_consumed,
    driftCount: row.drift_count,
    driftSummary: JSON.parse(row.drift_summary_json || '[]'),
    details: JSON.parse(row.details_json || '{}'),
    triggeredBy: row.triggered_by,
    createdAt: row.created_at
  }))
}

/**
 * Lista alertas de drift activas o históricas.
 */
export async function listDriftAlerts(
  db: D1Database,
  filter?: { provider?: SandboxProvider; acknowledged?: boolean; limit?: number }
): Promise<SandboxDriftAlert[]> {
  let query = `SELECT id, run_id, provider, severity, drift_type, description, diff_json, acknowledged, acknowledged_at, acknowledged_by, created_at FROM sandbox_drift_alerts WHERE 1=1`
  const binds: (string | number | boolean | null)[] = []

  if (filter?.provider) {
    binds.push(filter.provider)
    query += ` AND provider = ?${binds.length}`
  }
  if (filter?.acknowledged !== undefined) {
    binds.push(filter.acknowledged ? 1 : 0)
    query += ` AND acknowledged = ?${binds.length}`
  }

  query += ` ORDER BY created_at DESC LIMIT ${filter?.limit ?? 50}`

  const { results } = await db
    .prepare(query)
    .bind(...binds)
    .all<{
      id: string
      run_id: string
      provider: SandboxProvider
      severity: 'warning' | 'critical'
      drift_type: DriftType
      description: string
      diff_json: string
      acknowledged: number
      acknowledged_at: string | null
      acknowledged_by: string | null
      created_at: string
    }>()

  return (results ?? []).map((r) => ({
    id: r.id,
    runId: r.run_id,
    provider: r.provider,
    severity: r.severity,
    driftType: r.drift_type,
    description: r.description,
    diff: JSON.parse(r.diff_json || '[]'),
    acknowledged: r.acknowledged === 1,
    acknowledgedAt: r.acknowledged_at,
    acknowledgedBy: r.acknowledged_by,
    createdAt: r.created_at
  }))
}

/**
 * Reconoce (acknowledge) una alerta de drift.
 */
export async function acknowledgeDriftAlert(
  db: D1Database,
  alertId: string,
  options: { actorId: string; now?: string }
): Promise<SandboxDriftAlert> {
  const now = normalizeNow(options.now)
  await db
    .prepare(
      `UPDATE sandbox_drift_alerts
       SET acknowledged = 1, acknowledged_at = ?1, acknowledged_by = ?2
       WHERE id = ?3`
    )
    .bind(now, options.actorId, alertId)
    .run()

  const row = await db
    .prepare(
      `SELECT id, run_id, provider, severity, drift_type, description, diff_json, acknowledged, acknowledged_at, acknowledged_by, created_at
       FROM sandbox_drift_alerts
       WHERE id = ?1`
    )
    .bind(alertId)
    .first<{
      id: string
      run_id: string
      provider: SandboxProvider
      severity: 'warning' | 'critical'
      drift_type: DriftType
      description: string
      diff_json: string
      acknowledged: number
      acknowledged_at: string | null
      acknowledged_by: string | null
      created_at: string
    }>()

  if (!row) throw new SandboxContractsError('alert_not_found')

  return {
    id: row.id,
    runId: row.run_id,
    provider: row.provider,
    severity: row.severity,
    driftType: row.drift_type,
    description: row.description,
    diff: JSON.parse(row.diff_json || '[]'),
    acknowledged: row.acknowledged === 1,
    acknowledgedAt: row.acknowledged_at,
    acknowledgedBy: row.acknowledged_by,
    createdAt: row.created_at
  }
}

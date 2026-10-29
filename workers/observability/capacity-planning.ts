import {
  type CloudflareResourceKey,
  type SimulateCampaignInput,
  type ApproveCampaignPlanInput,
  type CapacityMetricRecord,
  type CloudflareCampaignPlan,
  type CapacityBottleneck,
  type HeadroomVerdict,
  type CapacityPlanStatus,
  simulateCampaignSchema,
  approveCampaignPlanSchema,
  CloudflareCapacityError,
  DEFAULT_CAPACITY_BASELINES,
  CLOUDFLARE_RESOURCE_KEYS
} from '../../shared/cloudflare-capacity-planning'
import type { VerifiedSessionClaims } from '../catalog/authorization'

export interface CapacityOperationOptions {
  now?: string
}

function getIsoNow(options?: CapacityOperationOptions): string {
  if (options?.now) return options.now
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
}

async function sha256Hex(content: string): Promise<string> {
  const encoded = new TextEncoder().encode(content)
  const hashBuf = await crypto.subtle.digest('SHA-256', encoded)
  return Array.from(new Uint8Array(hashBuf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

export async function initializeD1CapacityMetrics(
  database: D1Database,
  claims: VerifiedSessionClaims,
  options?: CapacityOperationOptions
): Promise<void> {
  const now = getIsoNow(options)
  const statements = CLOUDFLARE_RESOURCE_KEYS.map((key) => {
    const def = DEFAULT_CAPACITY_BASELINES[key]
    return database
      .prepare(
        `INSERT OR IGNORE INTO cloudflare_capacity_metrics (
          resource_key, quota_limit, current_baseline, unit, cost_per_million_units,
          updated_at, updated_by
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
      )
      .bind(key, def.quotaLimit, def.currentBaseline, def.unit, def.costPerMillionUnits, now, claims.identityId)
  })

  await database.batch(statements)
}

export async function readD1CapacityMetrics(database: D1Database): Promise<CapacityMetricRecord[]> {
  const rows = await database.prepare(`SELECT * FROM cloudflare_capacity_metrics`).all<{
    resource_key: CloudflareResourceKey
    quota_limit: number
    current_baseline: number
    unit: string
    cost_per_million_units: number
    updated_at: string
  }>()

  return (rows.results ?? []).map((r) => {
    const quota = r.quota_limit
    const baseline = r.current_baseline
    const headroom = quota > 0 ? ((quota - baseline) / quota) * 100 : 0
    return {
      resourceKey: r.resource_key,
      quotaLimit: quota,
      currentBaseline: baseline,
      unit: r.unit,
      costPerMillionUnits: r.cost_per_million_units,
      headroomPercent: Math.max(headroom, 0),
      updatedAt: r.updated_at
    }
  })
}

export async function simulateD1CampaignCapacity(
  database: D1Database,
  claims: VerifiedSessionClaims,
  rawInput: SimulateCampaignInput,
  options?: CapacityOperationOptions
): Promise<CloudflareCampaignPlan> {
  const parsed = simulateCampaignSchema.safeParse(rawInput)
  if (!parsed.success) {
    throw new CloudflareCapacityError('invalid_input', 400, parsed.error.message)
  }
  const input = parsed.data
  const now = getIsoNow(options)

  const payloadHash = await sha256Hex(
    JSON.stringify({
      campaignName: input.campaignName,
      startTime: input.startTime,
      endTime: input.endTime,
      multiplier: input.projectedPeakMultiplier,
      visitorsPeak: input.projectedVisitorsPeak,
      ordersHour: input.projectedOrdersHour
    })
  )

  const existingCommand = await database
    .prepare(
      `SELECT payload_hash, receipt_json FROM cloudflare_capacity_commands
       WHERE actor_id = ?1 AND idempotency_key = ?2`
    )
    .bind(claims.identityId, input.idempotencyKey)
    .first<{ payload_hash: string; receipt_json: string }>()

  if (existingCommand) {
    if (existingCommand.payload_hash !== payloadHash) {
      throw new CloudflareCapacityError('idempotency_conflict', 409, 'Idempotency conflict for campaign simulation')
    }
    return JSON.parse(existingCommand.receipt_json)
  }

  const metrics = await readD1CapacityMetrics(database)
  const metricMap = new Map<CloudflareResourceKey, CapacityMetricRecord>()
  for (const m of metrics) {
    metricMap.set(m.resourceKey, m)
  }

  const mult = input.projectedPeakMultiplier
  const bottlenecks: CapacityBottleneck[] = []
  const mitigations: string[] = []

  let minHeadroom = 100
  let minHeadroomResource: CloudflareResourceKey = 'd1_rows_read_daily'
  let estimatedCost = 35.0 // Base monthly Workers plan + D1/R2 baseline

  for (const key of CLOUDFLARE_RESOURCE_KEYS) {
    const metric = metricMap.get(key) ?? {
      resourceKey: key,
      quotaLimit: DEFAULT_CAPACITY_BASELINES[key].quotaLimit,
      currentBaseline: DEFAULT_CAPACITY_BASELINES[key].currentBaseline,
      unit: DEFAULT_CAPACITY_BASELINES[key].unit,
      costPerMillionUnits: DEFAULT_CAPACITY_BASELINES[key].costPerMillionUnits,
      headroomPercent: 50,
      updatedAt: now
    }

    let projectedPeak = metric.currentBaseline

    switch (key) {
      case 'worker_cpu_ms':
        projectedPeak = metric.currentBaseline * (1 + 0.15 * Math.log2(Math.max(mult, 1)))
        break
      case 'worker_subrequests':
        projectedPeak = metric.currentBaseline * (1 + 0.1 * mult)
        break
      case 'd1_rows_read_daily':
        projectedPeak = metric.currentBaseline * mult
        break
      case 'd1_rows_written_daily':
        projectedPeak = metric.currentBaseline * (1 + input.projectedOrdersHour / 60)
        break
      case 'd1_storage_bytes':
        projectedPeak = metric.currentBaseline + input.projectedOrdersHour * 24 * 1024 * 20
        break
      case 'do_connections_hotspot':
        projectedPeak = metric.currentBaseline * mult
        break
      case 'r2_class_a_operations_monthly':
        projectedPeak = metric.currentBaseline * (1 + 0.4 * mult)
        break
      case 'r2_class_b_operations_monthly':
        projectedPeak = metric.currentBaseline * mult
        break
      case 'r2_storage_bytes':
        projectedPeak = metric.currentBaseline
        break
      case 'queues_backlog_messages':
        projectedPeak = metric.currentBaseline * (mult * 1.2)
        break
      case 'workflows_active_instances':
        projectedPeak = metric.currentBaseline * mult
        break
      case 'cdn_edge_bandwidth_gb':
        projectedPeak = metric.currentBaseline * mult
        break
      case 'provider_redsys_tps':
        // Peak TPS is approximately 8x average TPS
        projectedPeak = Math.max(metric.currentBaseline, (input.projectedOrdersHour / 3600) * 8)
        break
      case 'provider_beply_rate_limit':
        projectedPeak = Math.max(metric.currentBaseline, (input.projectedOrdersHour / 60) * 1.5)
        break
    }

    const quota = metric.quotaLimit
    const headroom = ((quota - projectedPeak) / quota) * 100

    let status: 'healthy' | 'warning' | 'critical' = 'healthy'
    let mitigation: string | undefined

    if (headroom < 0) {
      status = 'critical'
      if (key === 'provider_redsys_tps') {
        mitigation =
          'Pasarela Redsys: ráfaga de pedidos excede límite TPS. Habilitar cola de espera escalonada en checkout.'
      } else if (key === 'do_connections_hotspot') {
        mitigation =
          'Durable Objects: concentración de conexiones en carrito coordinador. Activar particionado DO por hash de sesión.'
      } else if (key === 'd1_rows_read_daily') {
        mitigation = 'D1: lecturas exceden cuota diaria. Forzar caché CDN TTL 300s en catálogo y búsqueda.'
      } else {
        mitigation = `Recurso ${key} excede cuota máxima. Escalar plan de Cloudflare o restringir tráfico concurrente.`
      }
    } else if (headroom < 20.0) {
      status = 'warning'
      if (key === 'd1_rows_read_daily') {
        mitigation = 'D1 lecturas con margen bajo (< 20%). Configurar stale-while-revalidate en respuestas públicas.'
      } else if (key === 'do_connections_hotspot') {
        mitigation = 'Durable Objects: margen bajo de concurrencia. Reducir frecuencia de ping en WebSockets.'
      } else if (key === 'cdn_edge_bandwidth_gb') {
        mitigation = 'Ancho de banda CDN ajustado. Verificar compresión brotli y redimensionado de imágenes Cloudflare.'
      } else {
        mitigation = `Margen de seguridad reducido en ${key}. Monitorear alertas en tiempo real durante la campaña.`
      }
    }

    if (headroom < minHeadroom) {
      minHeadroom = headroom
      minHeadroomResource = key
    }

    if (mitigation && !mitigations.includes(mitigation)) {
      mitigations.push(mitigation)
    }

    // Cost accumulation
    if (metric.costPerMillionUnits > 0) {
      estimatedCost += (projectedPeak / 1000000) * metric.costPerMillionUnits
    }

    bottlenecks.push({
      resourceKey: key,
      unit: metric.unit,
      baseline: metric.currentBaseline,
      projectedPeak: Number(projectedPeak.toFixed(2)),
      quotaLimit: quota,
      headroomPercent: Number(headroom.toFixed(1)),
      status,
      recommendedMitigation: mitigation
    })
  }

  let headroomVerdict: HeadroomVerdict
  let planStatus: CapacityPlanStatus

  if (bottlenecks.some((b) => b.status === 'critical')) {
    headroomVerdict = 'critical_quota_exhausted'
    planStatus = 'simulated_failed'
  } else if (bottlenecks.some((b) => b.status === 'warning')) {
    headroomVerdict = 'warning_headroom_low'
    planStatus = 'simulated_warning'
  } else {
    headroomVerdict = 'healthy'
    planStatus = 'simulated_passed'
  }

  const planId = crypto.randomUUID()
  const plan: CloudflareCampaignPlan = {
    id: planId,
    campaignName: input.campaignName,
    startTime: input.startTime,
    endTime: input.endTime,
    projectedPeakMultiplier: input.projectedPeakMultiplier,
    projectedVisitorsPeak: input.projectedVisitorsPeak,
    projectedOrdersHour: input.projectedOrdersHour,
    status: planStatus,
    headroomVerdict,
    minHeadroomPercent: Number(minHeadroom.toFixed(1)),
    minHeadroomResource,
    estimatedCloudflareCostEur: Number(estimatedCost.toFixed(2)),
    bottlenecks,
    mitigations,
    createdBy: claims.identityId,
    version: 1,
    createdAt: now,
    updatedAt: now
  }

  await database.batch([
    database
      .prepare(
        `INSERT INTO cloudflare_campaign_capacity_plans (
          id, campaign_name, start_time, end_time, projected_peak_multiplier,
          projected_visitors_peak, projected_orders_hour, status, headroom_verdict,
          min_headroom_percent, min_headroom_resource, estimated_cloudflare_cost_eur,
          bottlenecks_json, mitigations_json, created_by, version, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)`
      )
      .bind(
        planId,
        plan.campaignName,
        plan.startTime,
        plan.endTime,
        plan.projectedPeakMultiplier,
        plan.projectedVisitorsPeak,
        plan.projectedOrdersHour,
        plan.status,
        plan.headroomVerdict,
        plan.minHeadroomPercent,
        plan.minHeadroomResource,
        plan.estimatedCloudflareCostEur,
        JSON.stringify(plan.bottlenecks),
        JSON.stringify(plan.mitigations),
        claims.identityId,
        1,
        now,
        now
      ),
    database
      .prepare(
        `INSERT INTO cloudflare_capacity_commands (
          command_id, actor_id, action, idempotency_key, expected_version,
          result_version, payload_hash, input_json, receipt_json, created_at
        ) VALUES (?1, ?2, 'simulate_campaign', ?3, 0, 1, ?4, ?5, ?6, ?7)`
      )
      .bind(
        input.commandId,
        claims.identityId,
        input.idempotencyKey,
        payloadHash,
        JSON.stringify(input),
        JSON.stringify(plan),
        now
      )
  ])

  return plan
}

export async function approveD1CampaignPlan(
  database: D1Database,
  claims: VerifiedSessionClaims,
  rawInput: ApproveCampaignPlanInput,
  options?: CapacityOperationOptions
): Promise<CloudflareCampaignPlan> {
  const parsed = approveCampaignPlanSchema.safeParse(rawInput)
  if (!parsed.success) {
    throw new CloudflareCapacityError('invalid_input', 400, parsed.error.message)
  }
  const input = parsed.data
  const now = getIsoNow(options)

  const payloadHash = await sha256Hex(
    JSON.stringify({
      planId: input.planId,
      expectedVersion: input.expectedVersion
    })
  )

  const existingCommand = await database
    .prepare(
      `SELECT payload_hash, receipt_json FROM cloudflare_capacity_commands
       WHERE actor_id = ?1 AND idempotency_key = ?2`
    )
    .bind(claims.identityId, input.idempotencyKey)
    .first<{ payload_hash: string; receipt_json: string }>()

  if (existingCommand) {
    if (existingCommand.payload_hash !== payloadHash) {
      throw new CloudflareCapacityError('idempotency_conflict', 409, 'Idempotency conflict for campaign plan approval')
    }
    return JSON.parse(existingCommand.receipt_json)
  }

  const existing = await database
    .prepare(`SELECT * FROM cloudflare_campaign_capacity_plans WHERE id = ?1`)
    .bind(input.planId)
    .first<{
      id: string
      campaign_name: string
      start_time: string
      end_time: string
      projected_peak_multiplier: number
      projected_visitors_peak: number
      projected_orders_hour: number
      status: CapacityPlanStatus
      headroom_verdict: HeadroomVerdict
      min_headroom_percent: number
      min_headroom_resource: CloudflareResourceKey
      estimated_cloudflare_cost_eur: number
      bottlenecks_json: string
      mitigations_json: string
      created_by: string
      version: number
      created_at: string
      updated_at: string
    }>()

  if (!existing) {
    throw new CloudflareCapacityError('not_found', 404, 'Campaign plan not found')
  }

  if (existing.version !== input.expectedVersion) {
    throw new CloudflareCapacityError(
      'concurrency_conflict',
      409,
      `Version mismatch: expected ${input.expectedVersion}, got ${existing.version}`
    )
  }

  if (existing.status === 'simulated_failed') {
    throw new CloudflareCapacityError(
      'cannot_approve_failed_simulation',
      400,
      'Cannot approve a campaign plan with critical quota exhaustion'
    )
  }

  const newVersion = existing.version + 1
  const updated: CloudflareCampaignPlan = {
    id: existing.id,
    campaignName: existing.campaign_name,
    startTime: existing.start_time,
    endTime: existing.end_time,
    projectedPeakMultiplier: existing.projected_peak_multiplier,
    projectedVisitorsPeak: existing.projected_visitors_peak,
    projectedOrdersHour: existing.projected_orders_hour,
    status: 'approved',
    headroomVerdict: existing.headroom_verdict,
    minHeadroomPercent: existing.min_headroom_percent,
    minHeadroomResource: existing.min_headroom_resource,
    estimatedCloudflareCostEur: existing.estimated_cloudflare_cost_eur,
    bottlenecks: JSON.parse(existing.bottlenecks_json),
    mitigations: JSON.parse(existing.mitigations_json),
    createdBy: existing.created_by,
    version: newVersion,
    createdAt: existing.created_at,
    updatedAt: now
  }

  await database.batch([
    database
      .prepare(
        `UPDATE cloudflare_campaign_capacity_plans
         SET status = 'approved',
             version = ?2,
             updated_at = ?3
         WHERE id = ?1 AND version = ?4`
      )
      .bind(input.planId, newVersion, now, input.expectedVersion),
    database
      .prepare(
        `INSERT INTO cloudflare_capacity_commands (
          command_id, actor_id, action, idempotency_key, expected_version,
          result_version, payload_hash, input_json, receipt_json, created_at
        ) VALUES (?1, ?2, 'approve_campaign_plan', ?3, ?4, ?5, ?6, ?7, ?8, ?9)`
      )
      .bind(
        input.commandId,
        claims.identityId,
        input.idempotencyKey,
        input.expectedVersion,
        newVersion,
        payloadHash,
        JSON.stringify(input),
        JSON.stringify(updated),
        now
      )
  ])

  return updated
}

export async function listD1CampaignPlans(database: D1Database, limit = 50): Promise<CloudflareCampaignPlan[]> {
  const rows = await database
    .prepare(`SELECT * FROM cloudflare_campaign_capacity_plans ORDER BY created_at DESC LIMIT ?1`)
    .bind(limit)
    .all<{
      id: string
      campaign_name: string
      start_time: string
      end_time: string
      projected_peak_multiplier: number
      projected_visitors_peak: number
      projected_orders_hour: number
      status: CapacityPlanStatus
      headroom_verdict: HeadroomVerdict
      min_headroom_percent: number
      min_headroom_resource: CloudflareResourceKey
      estimated_cloudflare_cost_eur: number
      bottlenecks_json: string
      mitigations_json: string
      created_by: string
      version: number
      created_at: string
      updated_at: string
    }>()

  return (rows.results ?? []).map((r) => ({
    id: r.id,
    campaignName: r.campaign_name,
    startTime: r.start_time,
    endTime: r.end_time,
    projectedPeakMultiplier: r.projected_peak_multiplier,
    projectedVisitorsPeak: r.projected_visitors_peak,
    projectedOrdersHour: r.projected_orders_hour,
    status: r.status,
    headroomVerdict: r.headroom_verdict,
    minHeadroomPercent: r.min_headroom_percent,
    minHeadroomResource: r.min_headroom_resource,
    estimatedCloudflareCostEur: r.estimated_cloudflare_cost_eur,
    bottlenecks: JSON.parse(r.bottlenecks_json),
    mitigations: JSON.parse(r.mitigations_json),
    createdBy: r.created_by,
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }))
}

import { z } from 'zod'
import { catalogPolicyInstantSchema, catalogPolicyUuidSchema } from './catalog-publication-policy'

export const GAME_DAY_SCENARIOS = [
  'beply_outage',
  'carrier_outage',
  'd1_outage',
  'durable_object_outage',
  'queue_outage',
  'r2_outage',
  'worker_deployment_failure'
] as const

export type GameDayScenarioId = (typeof GAME_DAY_SCENARIOS)[number]

export const GAME_DAY_STATUSES = ['in_progress', 'passed', 'warning', 'failed', 'aborted'] as const
export type GameDayStatus = (typeof GAME_DAY_STATUSES)[number]

export const TRAFFIC_EXPANSION_GATES = ['pending', 'approved', 'blocked', 'conditional'] as const
export type TrafficExpansionGate = (typeof TRAFFIC_EXPANSION_GATES)[number]

export const ALERT_SEVERITIES = ['warning', 'critical'] as const
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number]

export const ALERT_CHANNELS = ['slack_sre', 'pagerduty', 'email_ops'] as const
export type AlertChannel = (typeof ALERT_CHANNELS)[number]

export const ROLLBACK_RESTORE_STATUSES = ['not_needed', 'rollback_executed', 'restore_completed', 'failed'] as const
export type RollbackRestoreStatus = (typeof ROLLBACK_RESTORE_STATUSES)[number]

export const COORDINATION_STATUSES = ['completed', 'delayed', 'failed'] as const
export type CoordinationStatus = (typeof COORDINATION_STATUSES)[number]

export interface GameDayRunbook {
  id: string
  scenarioId: GameDayScenarioId
  title: string
  description: string
  steps: string[]
  mitigationActions: string[]
  escalationTeam: string
}

export const GAME_DAY_RUNBOOKS: Record<GameDayScenarioId, GameDayRunbook> = {
  beply_outage: {
    id: 'RB-GAME-BEPLY',
    scenarioId: 'beply_outage',
    title: 'Caída de Beply ERP / Facturación',
    description: 'Protocolo de resiliencia ante indisponibilidad, timeouts o límites HTTP 429/503 del ERP Beply.',
    steps: [
      '1. Aislar peticiones salientes síncronas hacia Beply.',
      '2. Enrutar facturación y pedidos al búfer durable de reintentos con backoff exponencial.',
      '3. Verificar que el checkout del cliente no se bloquee y confirme el pedido en estado pendiente de emisión fiscal.',
      '4. Supervisar latencia de alerta SRE en PagerDuty (< 60s).'
    ],
    mitigationActions: [
      'Activar modo degradado ERP',
      'Descongelar cola de sincronización tras recuperación de Beply',
      'Verificar reconciliación contable sin duplicados'
    ],
    escalationTeam: 'SRE & Integraciones ERP'
  },
  carrier_outage: {
    id: 'RB-GAME-CARRIER',
    scenarioId: 'carrier_outage',
    title: 'Caída de APIs de Transportistas (GLS / SEUR)',
    description: 'Protocolo de contingencia ante caída en generación de etiquetas y tracking de envíos.',
    steps: [
      '1. Detectar error 5xx o timeout > 5s en API del transportista.',
      '2. Conmutar emisión de albaranes a almacén local con código pre-reservado.',
      '3. Notificar al equipo de empaquetado para retención selectiva.',
      '4. Disparar alerta en Slack #sre-ops.'
    ],
    mitigationActions: [
      'Conmutar transportista alternativo si disponible',
      'Encolar emisión masiva asíncrona',
      'Comprobar integridad de manifiestos de salida'
    ],
    escalationTeam: 'Logística & SRE'
  },
  d1_outage: {
    id: 'RB-GAME-D1',
    scenarioId: 'd1_outage',
    title: 'Degradación o Caída de Cloudflare D1',
    description: 'Protocolo ante fallos transitorios de lectura/escritura en réplicas o primario D1.',
    steps: [
      '1. Evaluar tasa de fallos de transacciones SQL D1 en edge workers.',
      '2. Conmutar consultas críticas a réplica de sólo lectura con aviso de degradación.',
      '3. Mantener carritos en Durable Objects aislados del catálogo transaccional.',
      '4. Emitir alerta de severidad crítica en PagerDuty.'
    ],
    mitigationActions: [
      'Reintento transparente con jitter',
      'Paso a modo seguro de catálogo estático',
      'Verificar checkpoints de backup diario R2'
    ],
    escalationTeam: 'Cloudflare Edge SRE'
  },
  durable_object_outage: {
    id: 'RB-GAME-DO',
    scenarioId: 'durable_object_outage',
    title: 'Caída o Partición de Durable Objects',
    description: 'Protocolo de recuperación ante desalojo de memoria, bloqueo o timeout en sesión/carrito DO.',
    steps: [
      '1. Detectar desconexión de WebSocket o timeout en llamada a DO.',
      '2. Rehidratar estado persistente desde storage transactional del DO.',
      '3. Reintentar mutación del carrito con command_id idempotente.',
      '4. Disparar alerta crítica si el restablecimiento supera el SLO de 30s.'
    ],
    mitigationActions: [
      'Forzar reubicación geográfica del DO',
      'Reconciliar carrito con snapshot D1',
      'Verificar inexistencia de inconsistencias de stock reservado'
    ],
    escalationTeam: 'Core Platform Engineering'
  },
  queue_outage: {
    id: 'RB-GAME-QUEUE',
    scenarioId: 'queue_outage',
    title: 'Saturación o Bloqueo en Cloudflare Queues',
    description:
      'Protocolo ante incremento anómalo de profundidad de cola, retraso de procesamiento o saturación de DLQ.',
    steps: [
      '1. Medir antigüedad de mensaje más antiguo y tamaño de DLQ.',
      '2. Escalar consumidores concurrentes en Workers.',
      '3. Enrutar mensajes erróneos a DLQ sin perder eventos.',
      '4. Comprobar que no hay mensajes perdidos ni entregas duplicadas descontroladas.'
    ],
    mitigationActions: [
      'Reprocesar DLQ con payload validado',
      'Aumentar max_concurrency temporalmente',
      'Verificar métricas de descarte permanente'
    ],
    escalationTeam: 'Cloudflare SRE'
  },
  r2_outage: {
    id: 'RB-GAME-R2',
    scenarioId: 'r2_outage',
    title: 'Caída de Almacenamiento Cloudflare R2',
    description: 'Protocolo ante fallo de subida o lectura de facturas PDF, imágenes o backups en R2.',
    steps: [
      '1. Detectar 503 Service Unavailable o timeout en PutObject R2.',
      '2. Servir assets estáticos cacheados en Cloudflare CDN con stale-while-revalidate.',
      '3. Guardar facturas temporalmente en cola durable de subida diferida.',
      '4. Alertar al equipo de soporte y operaciones.'
    ],
    mitigationActions: [
      'Activar búfer local de documentos',
      'Comprobar consistencia hash SHA-256 al regenerar archivos',
      'Drenar cola de subida tras restablecimiento'
    ],
    escalationTeam: 'Storage & Media SRE'
  },
  worker_deployment_failure: {
    id: 'RB-GAME-WORKER',
    scenarioId: 'worker_deployment_failure',
    title: 'Fallo Crítico en Despliegue de Worker (Canary)',
    description:
      'Protocolo de rollback inmediato ante excepciones no capturadas o incremento de errores 500 tras un deploy.',
    steps: [
      '1. Detección automática en canary router de tasa de 500 > 1%.',
      '2. Drenaje inmediato de tráfico del canary al 0% hacia la versión estable anterior.',
      '3. Ejecución de rollback en Cloudflare Workers (< 60s).',
      '4. Emisión de alerta de bloqueo de despliegues y apertura de postmortem.'
    ],
    mitigationActions: [
      'Rollback automático o manual de versión',
      'Purga selectiva de caché de rutas afectadas',
      'Bloqueo preventivo de nuevos merges hasta RCA'
    ],
    escalationTeam: 'Release Engineering & SRE'
  }
}

export const gameDayScenarioInputSchema = z
  .object({
    scenarioId: z.enum(GAME_DAY_SCENARIOS),
    targetDetectionSeconds: z.number().int().positive(),
    actualDetectionSeconds: z.number().int().nonnegative(),
    targetRecoverySeconds: z.number().int().positive(),
    actualRecoverySeconds: z.number().int().nonnegative(),
    targetDataLossSeconds: z.number().int().nonnegative(),
    actualDataLossSeconds: z.number().int().nonnegative(),
    alertTriggered: z.boolean(),
    alertSeverity: z.enum(ALERT_SEVERITIES),
    alertChannel: z.enum(ALERT_CHANNELS),
    rollbackRestoreStatus: z.enum(ROLLBACK_RESTORE_STATUSES),
    coordinationStatus: z.enum(COORDINATION_STATUSES),
    runbookReference: z.string().min(3).max(64),
    details: z.record(z.unknown()).optional()
  })
  .strict()

export type GameDayScenarioInput = z.infer<typeof gameDayScenarioInputSchema>

export interface ScenarioEvaluation {
  status: 'passed' | 'warning' | 'failed'
  targetMet: boolean
  breaches: string[]
  warnings: string[]
}

export function evaluateScenarioResult(input: GameDayScenarioInput): ScenarioEvaluation {
  const breaches: string[] = []
  const warnings: string[] = []

  if (input.actualDetectionSeconds > input.targetDetectionSeconds) {
    breaches.push('detection_time_exceeded')
  }

  if (input.actualRecoverySeconds > input.targetRecoverySeconds) {
    breaches.push('recovery_time_exceeded')
  }

  if (input.actualDataLossSeconds > input.targetDataLossSeconds) {
    breaches.push('data_loss_exceeded')
  }

  if (!input.alertTriggered) {
    breaches.push('alert_not_triggered')
  }

  if (input.rollbackRestoreStatus === 'failed') {
    breaches.push('rollback_restore_failed')
  }

  if (input.coordinationStatus === 'failed') {
    breaches.push('coordination_failed')
  } else if (input.coordinationStatus === 'delayed') {
    warnings.push('coordination_delayed')
  }

  const status: 'passed' | 'warning' | 'failed' =
    breaches.length > 0 ? 'failed' : warnings.length > 0 ? 'warning' : 'passed'

  return {
    status,
    targetMet: breaches.length === 0,
    breaches,
    warnings
  }
}

export interface GateEvaluationOptions {
  completedAt: string | null
  now: string
  scenarios: Array<{
    scenarioId: GameDayScenarioId
    status: 'passed' | 'warning' | 'failed'
    targetMet: boolean
    breaches: string[]
    warnings: string[]
  }>
  maxAgeDays?: number
}

export interface TrafficExpansionGateResult {
  status: TrafficExpansionGate
  approved: boolean
  scenariosTotal: number
  scenariosPassed: number
  scenariosFailed: number
  reasons: string[]
}

export function evaluateTrafficExpansionGate(options: GateEvaluationOptions): TrafficExpansionGateResult {
  const maxAgeDays = options.maxAgeDays ?? 30
  const reasons: string[] = []

  const total = options.scenarios.length
  const passed = options.scenarios.filter((s) => s.status === 'passed').length
  const failed = options.scenarios.filter((s) => s.status === 'failed').length
  const warnings = options.scenarios.filter((s) => s.status === 'warning').length

  // Check scenarios completeness
  if (total < GAME_DAY_SCENARIOS.length) {
    reasons.push(`incomplete_scenarios: missing ${GAME_DAY_SCENARIOS.length - total} required fault scenarios`)
  }

  // Check scenario failures
  for (const scen of options.scenarios) {
    if (scen.status === 'failed') {
      reasons.push(`scenario_failed: ${scen.scenarioId} (${scen.breaches.join(', ') || 'unmet_target'})`)
    }
  }

  // Check freshness
  if (!options.completedAt) {
    reasons.push('drill_not_completed: simulation drill is still pending completion')
  } else {
    const completedMs = Date.parse(options.completedAt)
    const nowMs = Date.parse(options.now)
    const diffDays = (nowMs - completedMs) / (1000 * 60 * 60 * 24)
    if (diffDays > maxAgeDays) {
      reasons.push(`drill_expired: last game day executed > ${maxAgeDays} days ago`)
    }
  }

  if (reasons.length > 0) {
    return {
      status: 'blocked',
      approved: false,
      scenariosTotal: total,
      scenariosPassed: passed,
      scenariosFailed: failed,
      reasons
    }
  }

  if (warnings > 0) {
    return {
      status: 'conditional',
      approved: false,
      scenariosTotal: total,
      scenariosPassed: passed,
      scenariosFailed: failed,
      reasons: ['conditional_approval: some scenarios had warnings and require operational sign-off']
    }
  }

  return {
    status: 'approved',
    approved: true,
    scenariosTotal: total,
    scenariosPassed: passed,
    scenariosFailed: failed,
    reasons: []
  }
}

export const gameDayDrillCreateInputSchema = z
  .object({
    cohort: z.string().trim().min(3).max(160),
    notes: z.string().max(2000).default('')
  })
  .strict()

export type GameDayDrillCreateInput = z.infer<typeof gameDayDrillCreateInputSchema>

export const gameDayDrillCompleteInputSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    notes: z.string().max(2000).default('')
  })
  .strict()

export type GameDayDrillCompleteInput = z.infer<typeof gameDayDrillCompleteInputSchema>

export const gameDayDrillSchema = z
  .object({
    id: catalogPolicyUuidSchema,
    cohort: z.string(),
    status: z.enum(GAME_DAY_STATUSES),
    expansionGate: z.enum(TRAFFIC_EXPANSION_GATES),
    leadEngineerId: catalogPolicyUuidSchema,
    scenariosTotal: z.number().int().nonnegative(),
    scenariosPassed: z.number().int().nonnegative(),
    scenariosFailed: z.number().int().nonnegative(),
    version: z.number().int().positive(),
    notes: z.string(),
    startedAt: catalogPolicyInstantSchema,
    completedAt: catalogPolicyInstantSchema.nullable(),
    createdAt: catalogPolicyInstantSchema,
    updatedAt: catalogPolicyInstantSchema
  })
  .strict()

export type GameDayDrill = z.infer<typeof gameDayDrillSchema>

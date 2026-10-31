import { z } from 'zod'
import { catalogPolicyInstantSchema, catalogPolicyUuidSchema } from './catalog-publication-policy'

export const ANOMALY_DIMENSIONS = ['conversion', 'payment', 'stock', 'tracking', 'data'] as const

export type AnomalyDimension = (typeof ANOMALY_DIMENSIONS)[number]

export const ANOMALY_SEVERITIES = ['info', 'warning', 'critical'] as const
export type AnomalySeverity = (typeof ANOMALY_SEVERITIES)[number]

export const ANOMALY_STATUSES = [
  'open',
  'acknowledged',
  'under_investigation',
  'resolved',
  'dismissed_false_positive'
] as const

export type AnomalyStatus = (typeof ANOMALY_STATUSES)[number]

export const ANOMALY_REVIEW_ACTIONS = ['acknowledge', 'investigate', 'resolve', 'dismiss'] as const

export type AnomalyReviewAction = (typeof ANOMALY_REVIEW_ACTIONS)[number]

export const anomalyPolicySchema = z
  .object({
    dimension: z.enum(ANOMALY_DIMENSIONS),
    version: z.number().int().positive(),
    warningDropPercent: z.number().int().min(1).max(100),
    criticalDropPercent: z.number().int().min(1).max(100),
    minSampleSize: z.number().int().positive(),
    evaluationWindowMinutes: z.number().int().positive(),
    cooldownMinutes: z.number().int().nonnegative(),
    enabled: z.boolean(),
    updatedAt: catalogPolicyInstantSchema,
    updatedBy: catalogPolicyUuidSchema
  })
  .strict()

export type AnomalyPolicy = z.infer<typeof anomalyPolicySchema>

export const anomalyPolicyInputSchema = z
  .object({
    warningDropPercent: z.number().int().min(1).max(100),
    criticalDropPercent: z.number().int().min(1).max(100),
    minSampleSize: z.number().int().positive(),
    evaluationWindowMinutes: z.number().int().positive(),
    cooldownMinutes: z.number().int().nonnegative(),
    enabled: z.boolean(),
    expectedVersion: z.number().int().nonnegative()
  })
  .strict()

export type AnomalyPolicyInput = z.infer<typeof anomalyPolicyInputSchema>

export const anomalyAlertSchema = z
  .object({
    id: catalogPolicyUuidSchema,
    dimension: z.enum(ANOMALY_DIMENSIONS),
    metricName: z.string().min(3).max(80),
    severity: z.enum(ANOMALY_SEVERITIES),
    status: z.enum(ANOMALY_STATUSES),
    baselineValue: z.number().nonnegative(),
    observedValue: z.number().nonnegative(),
    deviationPercent: z.number(),
    sampleSize: z.number().int().nonnegative(),
    thresholdApplied: z.number(),
    runbookId: z.string().min(3).max(64),
    runbookTitle: z.string().min(3).max(255),
    summary: z.string().min(3).max(500),
    detectedAt: catalogPolicyInstantSchema,
    version: z.number().int().positive(),
    reviewerId: catalogPolicyUuidSchema.nullable(),
    reviewedAt: catalogPolicyInstantSchema.nullable(),
    reviewNotes: z.string().nullable(),
    resolutionAction: z.string().nullable(),
    createdAt: catalogPolicyInstantSchema,
    updatedAt: catalogPolicyInstantSchema
  })
  .strict()

export type AnomalyAlert = z.infer<typeof anomalyAlertSchema>

export const anomalyReviewSchema = z
  .object({
    id: catalogPolicyUuidSchema,
    alertId: catalogPolicyUuidSchema,
    reviewerId: catalogPolicyUuidSchema,
    action: z.enum(ANOMALY_REVIEW_ACTIONS),
    previousStatus: z.string(),
    newStatus: z.string(),
    notes: z.string().min(1).max(2000),
    resolutionAction: z.string().nullable(),
    reviewedAt: catalogPolicyInstantSchema
  })
  .strict()

export type AnomalyReview = z.infer<typeof anomalyReviewSchema>

export const anomalySignalInputSchema = z
  .object({
    dimension: z.enum(ANOMALY_DIMENSIONS),
    metricName: z.string().min(3).max(80),
    baselineValue: z.number().nonnegative(),
    observedValue: z.number().nonnegative(),
    sampleSize: z.number().int().nonnegative(),
    detectedAt: catalogPolicyInstantSchema,
    idempotencyKey: z.string().min(8).max(128)
  })
  .strict()

export type AnomalySignalInput = z.infer<typeof anomalySignalInputSchema>

export const anomalyReviewInputSchema = z
  .object({
    action: z.enum(ANOMALY_REVIEW_ACTIONS),
    notes: z.string().min(1).max(2000),
    resolutionAction: z.string().min(1).max(255).optional(),
    expectedVersion: z.number().int().positive(),
    idempotencyKey: z.string().min(8).max(128)
  })
  .strict()

export type AnomalyReviewInput = z.infer<typeof anomalyReviewInputSchema>

export const anomalyAlertsQuerySchema = z
  .object({
    dimension: z.enum(ANOMALY_DIMENSIONS).optional(),
    severity: z.enum(ANOMALY_SEVERITIES).optional(),
    status: z.enum(ANOMALY_STATUSES).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    offset: z.coerce.number().int().nonnegative().default(0)
  })
  .strict()

export type AnomalyAlertsQuery = z.infer<typeof anomalyAlertsQuerySchema>

export interface AnomalyRunbook {
  runbookId: string
  dimension: AnomalyDimension
  title: string
  severity: AnomalySeverity
  summary: string
  immediateActions: string[]
  diagnosticSteps: string[]
  mitigationSteps: string[]
  escalationContact: string
}

export const ANOMALY_RUNBOOKS: Record<AnomalyDimension, AnomalyRunbook> = {
  conversion: {
    runbookId: 'RB-CONV-001',
    dimension: 'conversion',
    title: 'Protocolo de Caída de Conversión en Checkout (RB-CONV-001)',
    severity: 'critical',
    summary: 'Detección de desplome anómalo en la tasa de conversión respecto a la línea base esperada.',
    immediateActions: [
      'Verificar estado de salud y latencia del worker de checkout (/api/checkout).',
      'Comprobar anomalías en la pasarela de pago o servicios de inventario.',
      'Revisar si hay despliegues recientes de canary o cambios en frontend de la tienda.'
    ],
    diagnosticSteps: [
      'Comprobar ratio de errores HTTP 4xx y 5xx en edge analytics de Cloudflare.',
      'Verificar si los clientes reportan bloqueos en el formulario de dirección o envío.',
      'Chequear si hay bloqueo masivo de stock o carritos huérfanos.'
    ],
    mitigationSteps: [
      'Si se asocia a un release reciente, realizar rollback inmediato al build anterior.',
      'Si la pasarela primaria falla, activar failover de pagos.',
      'Notificar al equipo de operaciones y escalado comercial.'
    ],
    escalationContact: 'oncall-engineering@neteco.es'
  },
  payment: {
    runbookId: 'RB-PAYM-002',
    dimension: 'payment',
    title: 'Protocolo de Fallos y Denegaciones en Pasarela de Pagos (RB-PAYM-002)',
    severity: 'critical',
    summary: 'Aumento inusual de transacciones de pago fallidas o caída de autorización.',
    immediateActions: [
      'Comprobar estado del proveedor de pagos (Redsys / Banco Sabadell / PayGold).',
      'Verificar errores de firma HMAC, caducidad de certificados o credenciales D1.',
      'Inspeccionar webhooks entrantes y respuestas del callback de pago.'
    ],
    diagnosticSteps: [
      'Consultar logs de auditoría de pagos para códigos de denegación SIS (ej. 0184, 0190, 9915).',
      'Identificar si afecta a un emisor de tarjeta específico o es general.',
      'Verificar si hay sobrecarga de peticiones simultáneas o rate limiting.'
    ],
    mitigationSteps: [
      'Conmutar al terminal o pasarela redundante PayGold / Bizum.',
      'Habilitar reintento asistido desde atención al cliente para pedidos pendientes.',
      'Publicar aviso temporal en checkout si es una indisponibilidad bancaria general.'
    ],
    escalationContact: 'oncall-payments@neteco.es'
  },
  stock: {
    runbookId: 'RB-STCK-003',
    dimension: 'stock',
    title: 'Protocolo de Anomalías de Rotura y Agotamiento de Stock (RB-STCK-003)',
    severity: 'warning',
    summary: 'Agotamiento súbito o desajuste de stock no justificado por pedidos registrados.',
    immediateActions: [
      'Revisar órdenes confirmadas en las últimas horas para los SKUs afectados.',
      'Verificar si existe reserva huérfana de stock o duplicación de decrementos.',
      'Contactar con almacén para verificar existencia física en ubicación.'
    ],
    diagnosticSteps: [
      'Ejecutar auditoría de transacciones en inventory_movements contra orders.',
      'Comprobar si hubo importaciones manuales o sincronizaciones de ERP erróneas.',
      'Revisar si los lotes químicos tienen fecha de caducidad superada o cuarentena.'
    ],
    mitigationSteps: [
      'Ajustar inventario virtual en D1 si se confirma stock físico disponible.',
      'Activar backorder o deshabilitar producto si hay rotura real de fabricante.',
      'Generar orden urgente de aprovisionamiento con proveedor.'
    ],
    escalationContact: 'logistica-almacen@neteco.es'
  },
  tracking: {
    runbookId: 'RB-TRCK-004',
    dimension: 'tracking',
    title: 'Protocolo de Pérdida de Telemetría y Eventos de Tracking (RB-TRCK-004)',
    severity: 'warning',
    summary: 'Caída abrupta en el volumen de eventos de navegación, clics o analítica CRM.',
    immediateActions: [
      'Verificar disponibilidad del endpoint de ingestión (/api/analytics/events).',
      'Comprobar si el consent manager de cookies está bloqueando scripts técnicos.',
      'Revisar si hay reglas WAF o de AdBlock agresivas bloqueando el dominio de beacon.'
    ],
    diagnosticSteps: [
      'Examinar tasas de error 403 o 429 en el rate limiter de telemetría.',
      'Probar despacho de evento simulado desde consola del navegador.',
      'Verificar cuotas de Cloudflare D1 / Queues para cola de ingestión.'
    ],
    mitigationSteps: [
      'Ajustar umbrales del rate limiter si hay tráfico legítimo filtrado.',
      'Corregir configuración de headers CORS o Content-Security-Policy.',
      'Reprocesar eventos almacenados en búfer local de navegador si existen.'
    ],
    escalationContact: 'data-platform@neteco.es'
  },
  data: {
    runbookId: 'RB-DATA-005',
    dimension: 'data',
    title: 'Protocolo de Retardo y Degradación en Ingestión de Datos (RB-DATA-005)',
    severity: 'warning',
    summary: 'Retraso crítico en la sincronización de feeds de datos, catálogos o reconciliaciones.',
    immediateActions: [
      'Verificar estado de los Cron Triggers en Cloudflare Workers.',
      'Revisar si las tablas de conciliación o outbox tienen trabajos bloqueados.',
      'Comprobar si hay errores de esquema o migraciones D1 incompletas.'
    ],
    diagnosticSteps: [
      'Inspeccionar timestamps de última sincronización en las tablas de feeds.',
      'Verificar locks o timeout de 30s en transacciones SQLite/D1.',
      'Consultar volumen de mensajes pendientes en Cloudflare Queues.'
    ],
    mitigationSteps: [
      'Reiniciar el worker de ingestión o desencadenar ejecución manual asistida.',
      'Aumentar el límite de memoria del worker si se produjeron OOM por archivos grandes.',
      'Alertar a operaciones de datos para reintentar lotes fallidos.'
    ],
    escalationContact: 'data-ops@neteco.es'
  }
}

export function getRunbookForDimension(dimension: AnomalyDimension): AnomalyRunbook {
  return ANOMALY_RUNBOOKS[dimension]
}

export interface AnomalyEvaluationResult {
  isAnomaly: boolean
  dropPercent: number
  severity: AnomalySeverity | null
  reason?: string
}

/**
 * Noise avoidance engine: avoids triggering alerts when sample size is insufficient,
 * or when drop percentage is within normal expected tolerance bounds.
 */
export function evaluateAnomalyDrop(
  baseline: number,
  observed: number,
  sampleSize: number,
  policy: AnomalyPolicy
): AnomalyEvaluationResult {
  if (!policy.enabled) {
    return {
      isAnomaly: false,
      dropPercent: 0,
      severity: null,
      reason: 'policy_disabled'
    }
  }

  if (sampleSize < policy.minSampleSize) {
    return {
      isAnomaly: false,
      dropPercent: 0,
      severity: null,
      reason: `sample_size_below_threshold (${sampleSize} < ${policy.minSampleSize})`
    }
  }

  if (baseline <= 0) {
    return {
      isAnomaly: false,
      dropPercent: 0,
      severity: null,
      reason: 'baseline_zero_or_negative'
    }
  }

  // Calculate percentage drop from baseline: ((baseline - observed) / baseline) * 100
  const dropPercent = Math.max(0, Math.round(((baseline - observed) / baseline) * 10000) / 100)

  if (dropPercent >= policy.criticalDropPercent) {
    return {
      isAnomaly: true,
      dropPercent,
      severity: 'critical'
    }
  }

  if (dropPercent >= policy.warningDropPercent) {
    return {
      isAnomaly: true,
      dropPercent,
      severity: 'warning'
    }
  }

  return {
    isAnomaly: false,
    dropPercent,
    severity: null,
    reason: `drop_within_tolerance (${dropPercent}% < ${policy.warningDropPercent}%)`
  }
}

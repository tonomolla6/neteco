import { z } from 'zod'
import { CANONICAL_INSTANT } from './performance-insights-error'

/**
 * OBS-030: AIOps is limited to *recommendation*. Nothing here executes an action:
 * the catalogue carries steps for a human operator, and destructive runbooks need
 * explicit human approval (enforced in workers/observability/aiops.ts).
 */
export const AIOPS_SIGNAL_KINDS = [
  'error_rate',
  'latency_p95',
  'queue_backlog',
  'db_errors',
  'payment_failures',
  'provider_timeout',
  'deploy',
  'saturation'
] as const
export const AIOPS_SERVICES = [
  'storefront',
  'checkout',
  'payments',
  'fulfillment',
  'search',
  'database',
  'queues',
  'auth',
  'cdn'
] as const
export const AIOPS_SEVERITIES = ['low', 'medium', 'high', 'critical'] as const

export type AiopsSignalKind = (typeof AIOPS_SIGNAL_KINDS)[number]
export type AiopsService = (typeof AIOPS_SERVICES)[number]
export type AiopsSeverity = (typeof AIOPS_SEVERITIES)[number]

export interface AiopsSignal {
  id: string
  kind: AiopsSignalKind
  service: AiopsService
  severity: AiopsSeverity
  metricValue: number
  thresholdValue: number
  observedAt: string
}

export interface AiopsRunbook {
  title: string
  destructive: boolean
  steps: readonly string[]
}

export const AIOPS_RUNBOOKS = {
  rollback_release: {
    title: 'Revertir la última versión desplegada',
    destructive: true,
    steps: [
      'Confirmar que el pico de errores empieza tras el despliegue (comparar con el panel de release).',
      'Congelar nuevos despliegues.',
      'Un operador ejecuta el rollback a la versión anterior desde el pipeline autorizado.',
      'Verificar que la tasa de errores vuelve a su línea base y anotar el resultado.'
    ]
  },
  pause_payment_provider: {
    title: 'Pausar el proveedor de pagos afectado',
    destructive: true,
    steps: [
      'Comprobar el estado público del proveedor y los códigos de error recientes.',
      'Un operador desactiva el método de pago afectado en la configuración de checkout.',
      'Comunicar la incidencia a soporte.',
      'Reactivar tras tres comprobaciones correctas consecutivas.'
    ]
  },
  scale_queue_consumers: {
    title: 'Aumentar consumidores y aliviar la presión sobre la base de datos',
    destructive: false,
    steps: [
      'Revisar la antigüedad del mensaje más viejo y la tasa de reintentos.',
      'Reducir temporalmente el tamaño de lote para aliviar D1.',
      'Vigilar el backlog hasta que baje del umbral.'
    ]
  },
  harden_edge_cache: {
    title: 'Reforzar la caché de borde ante saturación',
    destructive: false,
    steps: [
      'Identificar las rutas más costosas en el panel de capacidad.',
      'Subir temporalmente el TTL de las respuestas públicas cacheables.',
      'Revertir el TTL cuando la saturación remita.'
    ]
  },
  manual_triage: {
    title: 'Triaje manual guiado',
    destructive: false,
    steps: [
      'Revisar las señales correlacionadas y su cronología.',
      'Asignar un responsable y abrir una incidencia.',
      'Registrar el resultado para medir la precisión de la recomendación.'
    ]
  }
} as const satisfies Record<string, AiopsRunbook>

export type AiopsRunbookId = keyof typeof AIOPS_RUNBOOKS

export interface AiopsCandidate {
  signalIds: string[]
  services: AiopsService[]
  summary: string
  runbookId: AiopsRunbookId
  destructive: boolean
  steps: string[]
  confidence: number
}

const SEVERITY_RANK: Record<AiopsSeverity, number> = { low: 0, medium: 1, high: 2, critical: 3 }

function chooseRunbook(kinds: Set<AiopsSignalKind>, services: Set<AiopsService>): AiopsRunbookId {
  const has = (...k: AiopsSignalKind[]) => k.some((kind) => kinds.has(kind))
  if (has('deploy') && has('error_rate', 'latency_p95', 'db_errors')) return 'rollback_release'
  if (services.has('payments') && has('payment_failures') && has('provider_timeout', 'error_rate'))
    return 'pause_payment_provider'
  if (has('queue_backlog') && has('db_errors', 'saturation')) return 'scale_queue_consumers'
  if (has('saturation', 'latency_p95') && (services.has('cdn') || services.has('storefront')) && !has('deploy'))
    return 'harden_edge_cache'
  return 'manual_triage'
}

/**
 * Deterministic correlation: signals are clustered when consecutive observations are
 * within `windowMinutes`; a cluster becomes a proposal if it holds at least two distinct
 * signals of medium severity or higher, or a critical one. Order of input is irrelevant.
 */
export function correlateSignals(
  signals: readonly AiopsSignal[],
  options: { windowMinutes: number }
): AiopsCandidate[] {
  const unique = new Map<string, AiopsSignal>()
  for (const signal of signals) unique.set(signal.id, signal)
  const ordered = [...unique.values()].sort(
    (a, b) => a.observedAt.localeCompare(b.observedAt) || a.id.localeCompare(b.id)
  )
  const windowMs = options.windowMinutes * 60_000
  const clusters: AiopsSignal[][] = []
  for (const signal of ordered) {
    const current = clusters.at(-1)
    const last = current?.at(-1)
    if (current && last && Date.parse(signal.observedAt) - Date.parse(last.observedAt) <= windowMs) current.push(signal)
    else clusters.push([signal])
  }
  const out: AiopsCandidate[] = []
  for (const cluster of clusters) {
    const relevant = cluster.filter((s) => SEVERITY_RANK[s.severity] >= SEVERITY_RANK.medium)
    const critical = cluster.some((s) => s.severity === 'critical')
    if (!critical && relevant.length < 2) continue
    const kinds = new Set(cluster.map((s) => s.kind))
    const services = new Set(cluster.map((s) => s.service))
    const runbookId = chooseRunbook(kinds, services)
    const runbook: AiopsRunbook = AIOPS_RUNBOOKS[runbookId]
    const maxRank = Math.max(...cluster.map((s) => SEVERITY_RANK[s.severity]))
    const confidence = Math.min(0.95, 0.35 + 0.15 * kinds.size + 0.05 * maxRank)
    const serviceList = [...services].sort()
    out.push({
      signalIds: cluster.map((s) => s.id).sort(),
      services: serviceList,
      summary: `${cluster.length} señal(es) correlacionadas en ${serviceList.join(', ')}: ${[...kinds].sort().join(', ')}`,
      runbookId,
      destructive: runbook.destructive,
      steps: [...runbook.steps],
      confidence: Math.round(confidence * 100) / 100
    })
  }
  return out
}

export const AIOPS_MIN_REVIEWED_FOR_PRECISION = 10

export interface AiopsPrecision {
  total: number
  reviewed: number
  truePositives: number
  falsePositives: number
  pending: number
  precision: number | null
  sampleSufficient: boolean
}

export function computeAiopsPrecision(
  items: ReadonlyArray<{ outcome: 'pending' | 'true_positive' | 'false_positive' }>
): AiopsPrecision {
  const truePositives = items.filter((i) => i.outcome === 'true_positive').length
  const falsePositives = items.filter((i) => i.outcome === 'false_positive').length
  const reviewed = truePositives + falsePositives
  return {
    total: items.length,
    reviewed,
    truePositives,
    falsePositives,
    pending: items.length - reviewed,
    precision: reviewed === 0 ? null : truePositives / reviewed,
    sampleSufficient: reviewed >= AIOPS_MIN_REVIEWED_FOR_PRECISION
  }
}

const command = {
  commandId: z.string().uuid(),
  idempotencyKey: z.string().min(1).max(128)
}
const instant = z.string().regex(CANONICAL_INSTANT)

export const ingestSignalSchema = z
  .object({
    ...command,
    kind: z.enum(AIOPS_SIGNAL_KINDS),
    service: z.enum(AIOPS_SERVICES),
    severity: z.enum(AIOPS_SEVERITIES),
    metricValue: z.number().finite(),
    thresholdValue: z.number().finite(),
    observedAt: instant
  })
  .strict()
export type IngestSignalInput = z.infer<typeof ingestSignalSchema>

export const correlateSchema = z
  .object({
    ...command,
    windowMinutes: z.number().int().min(1).max(120).default(15),
    lookbackMinutes: z.number().int().min(5).max(1440).default(120)
  })
  .strict()
export type CorrelateInput = z.infer<typeof correlateSchema>

export const decideRecommendationSchema = z
  .object({
    ...command,
    recommendationId: z.string().uuid(),
    expectedVersion: z.number().int().min(1),
    decision: z.enum(['approve', 'reject']),
    reason: z.string().trim().min(10).max(500),
    confirmDestructive: z.boolean().optional()
  })
  .strict()
export type DecideRecommendationInput = z.infer<typeof decideRecommendationSchema>

export const recordOutcomeSchema = z
  .object({
    ...command,
    recommendationId: z.string().uuid(),
    expectedVersion: z.number().int().min(1),
    outcome: z.enum(['true_positive', 'false_positive'])
  })
  .strict()
export type RecordOutcomeInput = z.infer<typeof recordOutcomeSchema>

export interface AiopsRecommendation {
  id: string
  correlationKey: string
  signalIds: string[]
  services: string[]
  summary: string
  runbookId: string
  steps: string[]
  destructive: boolean
  confidence: number
  status: 'proposed' | 'approved' | 'rejected'
  decisionReason: string | null
  decidedBy: string | null
  decidedAt: string | null
  outcome: 'pending' | 'true_positive' | 'false_positive'
  version: number
  createdAt: string
  updatedAt: string
}

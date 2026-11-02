import { z } from 'zod'

export const paymentFunnelDeviceSchema = z.enum(['desktop', 'mobile', 'tablet', 'unknown'])
export type PaymentFunnelDevice = z.infer<typeof paymentFunnelDeviceSchema>

export const paymentFunnelMethodSchema = z.enum(['card', 'bizum', 'bank_transfer', 'unknown'])
export type PaymentFunnelMethod = z.infer<typeof paymentFunnelMethodSchema>

export const paymentFunnelStepSchema = z.enum([
  'intent_created',
  'redirected',
  'authorized',
  'captured',
  'declined',
  'cancelled',
  'expired'
])
export type PaymentFunnelStep = z.infer<typeof paymentFunnelStepSchema>

export const paymentDeclineCategorySchema = z.enum([
  'insufficient_funds',
  'expired_card',
  'auth_failed_3ds',
  'card_restriction',
  'invalid_card_details',
  'pin_attempts_exceeded',
  'user_cancelled',
  'issuer_declined',
  'issuer_unavailable',
  'fraud_suspicion',
  'bizum_error',
  'system_error',
  'other'
])
export type PaymentDeclineCategory = z.infer<typeof paymentDeclineCategorySchema>

export const DECLINE_CATEGORY_LABELS: Record<PaymentDeclineCategory, string> = {
  insufficient_funds: 'Saldo o fondos insuficientes',
  expired_card: 'Tarjeta caducada o fecha incorrecta',
  auth_failed_3ds: 'Fallo de autenticación 3DS / Titular no autenticado',
  card_restriction: 'Operación no permitida para la tarjeta o tarjeta restringida',
  invalid_card_details: 'Datos de tarjeta incorrectos / CVV inválido',
  pin_attempts_exceeded: 'Número de intentos de PIN superados',
  user_cancelled: 'Pago cancelado voluntariamente por el usuario',
  issuer_declined: 'Denegado por la entidad emisora',
  issuer_unavailable: 'Entidad emisora no disponible o timeout de pasarela',
  fraud_suspicion: 'Sospecha de fraude o excepción temporal de seguridad',
  bizum_error: 'Operación Bizum no autorizada o límite de usuario excedido',
  system_error: 'Error de configuración o sistema de pasarela',
  other: 'Otros motivos de rechazo'
}

export const MIN_PAYMENT_FUNNEL_SAMPLE_THRESHOLD = 30

const PAN_REGEX = /\b(?:\d{13,19}|\d{4}[ -]\d{4}[ -]\d{4}[ -]\d{1,7})\b/
const SENSITIVE_KEY_REGEX = /(?:cvv|cvc|securitycode|cardnumber|pan|pin|password|secret|expiry|expiration)/i
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Validates that an object or value contains NO prohibited data (PAN, CVV, PIN, PII, expiry).
 */
export function assertNoProhibitedData(value: unknown): void {
  if (value === null || value === undefined) return
  if (typeof value === 'string') {
    if (UUID_REGEX.test(value)) return
    if (PAN_REGEX.test(value)) {
      throw new Error('payment_funnel_prohibited_data: PAN detected')
    }
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) assertNoProhibitedData(item)
    return
  }
  if (typeof value === 'object') {
    for (const [key, val] of Object.entries(value)) {
      if (SENSITIVE_KEY_REGEX.test(key)) {
        throw new Error(`payment_funnel_prohibited_data: sensitive field '${key}' detected`)
      }
      assertNoProhibitedData(val)
    }
  }
}

/**
 * Maps Redsys or gateway response codes to standardized decline categories and descriptions.
 */
export function classifyDeclineResponse(
  responseCode: string,
  method?: string
): { category: PaymentDeclineCategory; label: string; code: string } {
  const code = responseCode.trim().padStart(4, '0')
  const num = Number(code)

  if (method === 'bizum' && (num === 9104 || num === 9218)) {
    return { category: 'bizum_error', label: DECLINE_CATEGORY_LABELS.bizum_error, code }
  }

  if (num === 116) {
    return { category: 'insufficient_funds', label: DECLINE_CATEGORY_LABELS.insufficient_funds, code }
  }
  if (num === 184 || num === 9998 || num === 9999) {
    return { category: 'auth_failed_3ds', label: DECLINE_CATEGORY_LABELS.auth_failed_3ds, code }
  }
  if (num === 101 || num === 191) {
    return { category: 'expired_card', label: DECLINE_CATEGORY_LABELS.expired_card, code }
  }
  if (num === 102) {
    return { category: 'fraud_suspicion', label: DECLINE_CATEGORY_LABELS.fraud_suspicion, code }
  }
  if (num === 104 || num === 125) {
    return { category: 'card_restriction', label: DECLINE_CATEGORY_LABELS.card_restriction, code }
  }
  if (num === 129 || num === 9051 || num === 118) {
    return { category: 'invalid_card_details', label: DECLINE_CATEGORY_LABELS.invalid_card_details, code }
  }
  if (num === 106) {
    return { category: 'pin_attempts_exceeded', label: DECLINE_CATEGORY_LABELS.pin_attempts_exceeded, code }
  }
  if (num === 9915) {
    return { category: 'user_cancelled', label: DECLINE_CATEGORY_LABELS.user_cancelled, code }
  }
  if (num === 190) {
    return { category: 'issuer_declined', label: DECLINE_CATEGORY_LABELS.issuer_declined, code }
  }
  if (num === 9912) {
    return { category: 'issuer_unavailable', label: DECLINE_CATEGORY_LABELS.issuer_unavailable, code }
  }
  if (num === 9104 || num === 9218) {
    return { category: 'bizum_error', label: DECLINE_CATEGORY_LABELS.bizum_error, code }
  }
  if (num === 904) {
    return { category: 'system_error', label: DECLINE_CATEGORY_LABELS.system_error, code }
  }

  return { category: 'other', label: DECLINE_CATEGORY_LABELS.other, code }
}

export interface WilsonScoreResult {
  rate: number
  lower: number
  upper: number
  hasSufficientSample: boolean
}

export function computeWilsonScoreInterval(successes: number, total: number, confidence = 0.95): WilsonScoreResult {
  if (!Number.isFinite(total) || total <= 0) {
    return { rate: 0, lower: 0, upper: 0, hasSufficientSample: false }
  }
  const k = Math.max(0, Math.min(successes, total))
  const n = total
  const p = k / n
  const z = confidence === 0.99 ? 2.5758 : confidence === 0.9 ? 1.6449 : 1.96
  const z2 = z * z
  const denominator = 1 + z2 / n
  const center = (p + z2 / (2 * n)) / denominator
  const margin = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denominator

  const lower = Math.max(0, Math.min(1, center - margin))
  const upper = Math.max(0, Math.min(1, center + margin))

  return {
    rate: Math.round(p * 10000) / 10000,
    lower: Math.round(lower * 10000) / 10000,
    upper: Math.round(upper * 10000) / 10000,
    hasSufficientSample: n >= MIN_PAYMENT_FUNNEL_SAMPLE_THRESHOLD
  }
}

export interface RecordPaymentFunnelInput {
  id?: string
  intentId: string
  orderId: string
  step: PaymentFunnelStep
  method: PaymentFunnelMethod
  device: PaymentFunnelDevice
  bank?: string | null
  responseCode?: string | null
  declineCategory?: PaymentDeclineCategory | null
  amountCents: number
  currency?: 'EUR'
  createdAt: string
}

export async function recordPaymentFunnelEvent(database: D1Database, input: RecordPaymentFunnelInput): Promise<void> {
  assertNoProhibitedData(input)

  let declineCategory = input.declineCategory ?? null
  if (input.step === 'declined' && !declineCategory && input.responseCode) {
    declineCategory = classifyDeclineResponse(input.responseCode, input.method).category
  }

  const id = input.id ?? crypto.randomUUID()
  const currency = input.currency ?? 'EUR'
  const bank = input.bank ? input.bank.trim().slice(0, 80) : null
  const responseCode = input.responseCode ? input.responseCode.trim().slice(0, 10) : null

  await database
    .prepare(
      `INSERT INTO payment_funnel_events (
         id, intent_id, order_id, step, method, device, bank, response_code,
         decline_category, amount_cents, currency, created_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`
    )
    .bind(
      id,
      input.intentId,
      input.orderId,
      input.step,
      input.method,
      input.device,
      bank,
      responseCode,
      declineCategory,
      input.amountCents,
      currency,
      input.createdAt
    )
    .run()
}

export interface PaymentFunnelQuery {
  from: string
  to: string
  device?: string
  method?: string
  bank?: string
}

export interface PaymentFunnelStage {
  step: PaymentFunnelStep
  name: string
  count: number
  conversionFromPrevious: {
    rate: number
    lower: number
    upper: number
  }
  conversionFromStart: {
    rate: number
    lower: number
    upper: number
  }
  hasSufficientSample: boolean
  isSmallSampleWarning: boolean
}

export interface PaymentDeclineCause {
  category: PaymentDeclineCategory
  label: string
  code: string
  count: number
  percentage: number
}

export interface PaymentFunnelBreakdownItem {
  key: string
  label: string
  attempts: number
  authorized: number
  declined: number
  cancelled: number
  successRate: number
}

export interface PaymentFunnelDashboardResponse {
  period: {
    from: string
    to: string
  }
  filters: {
    device: string
    method: string
    bank: string
  }
  minSampleThreshold: number
  summary: {
    totalAttempts: number
    authorizedCount: number
    declinedCount: number
    cancelledCount: number
    expiredCount: number
    authorizationRate: number
    declineRate: number
    cancellationRate: number
    expirationRate: number
    wilsonInterval: {
      lower: number
      upper: number
    }
    hasSufficientSample: boolean
  }
  stages: PaymentFunnelStage[]
  declineCauses: PaymentDeclineCause[]
  breakdowns: {
    byDevice: PaymentFunnelBreakdownItem[]
    byMethod: PaymentFunnelBreakdownItem[]
    byBank: PaymentFunnelBreakdownItem[]
  }
}

export async function readPaymentFunnelDashboard(
  database: D1Database,
  query: PaymentFunnelQuery
): Promise<PaymentFunnelDashboardResponse> {
  assertNoProhibitedData(query)

  const device = query.device ?? 'all'
  const method = query.method ?? 'all'
  const bank = query.bank ?? 'all'
  const from = query.from
  const to = query.to

  const whereConditions: string[] = ['created_at >= ?1', 'created_at <= ?2']
  const binds: unknown[] = [from, to]

  if (device !== 'all') {
    binds.push(device)
    whereConditions.push(`device = ?${binds.length}`)
  }
  if (method !== 'all') {
    binds.push(method)
    whereConditions.push(`method = ?${binds.length}`)
  }
  if (bank !== 'all') {
    binds.push(bank)
    whereConditions.push(`bank = ?${binds.length}`)
  }

  const whereSql = whereConditions.join(' AND ')

  // 1. Query counts per step
  const stepCountsResult = await database
    .prepare(
      `SELECT step, COUNT(DISTINCT intent_id) AS intent_count
       FROM payment_funnel_events
       WHERE ${whereSql}
       GROUP BY step`
    )
    .bind(...binds)
    .all<{ step: PaymentFunnelStep; intent_count: number }>()

  const countByStep = new Map<PaymentFunnelStep, number>()
  for (const row of stepCountsResult.results ?? []) {
    countByStep.set(row.step, row.intent_count)
  }

  // Also query total unique payment intents attempting payment
  const totalAttemptsRow = await database
    .prepare(
      `SELECT COUNT(DISTINCT intent_id) AS total_intents
       FROM payment_funnel_events
       WHERE ${whereSql}`
    )
    .bind(...binds)
    .first<{ total_intents: number }>()

  const totalAttempts = totalAttemptsRow?.total_intents ?? 0
  const redirectedCount = countByStep.get('redirected') ?? 0
  const authorizedCount = (countByStep.get('authorized') ?? 0) + (countByStep.get('captured') ?? 0)
  const declinedCount = countByStep.get('declined') ?? 0
  const cancelledCount = countByStep.get('cancelled') ?? 0
  const expiredCount = countByStep.get('expired') ?? 0

  const authWilson = computeWilsonScoreInterval(authorizedCount, totalAttempts)
  const declineRate = totalAttempts > 0 ? Math.round((declinedCount / totalAttempts) * 10000) / 10000 : 0
  const cancellationRate = totalAttempts > 0 ? Math.round((cancelledCount / totalAttempts) * 10000) / 10000 : 0
  const expirationRate = totalAttempts > 0 ? Math.round((expiredCount / totalAttempts) * 10000) / 10000 : 0

  // 2. Build Funnel Stages
  const stagesDefinition: Array<{ step: PaymentFunnelStep; name: string; count: number }> = [
    { step: 'intent_created', name: 'Inicio de pago', count: totalAttempts },
    { step: 'redirected', name: 'Pasarela cargada / Redirección', count: redirectedCount },
    { step: 'authorized', name: 'Pago autorizado / confirmado', count: authorizedCount }
  ]

  const stages: PaymentFunnelStage[] = []
  let prevCount: number | null = null

  for (const [idx, stage] of stagesDefinition.entries()) {
    const convFromStart = computeWilsonScoreInterval(stage.count, totalAttempts)
    const convFromPrev =
      idx === 0
        ? { rate: 1.0, lower: 1.0, upper: 1.0, hasSufficientSample: stage.count >= MIN_PAYMENT_FUNNEL_SAMPLE_THRESHOLD }
        : computeWilsonScoreInterval(stage.count, prevCount ?? stage.count)

    const hasSufficientSample = stage.count >= MIN_PAYMENT_FUNNEL_SAMPLE_THRESHOLD
    const isSmallSampleWarning = !hasSufficientSample && stage.count > 0

    stages.push({
      step: stage.step,
      name: stage.name,
      count: stage.count,
      conversionFromPrevious: {
        rate: convFromPrev.rate,
        lower: convFromPrev.lower,
        upper: convFromPrev.upper
      },
      conversionFromStart: {
        rate: convFromStart.rate,
        lower: convFromStart.lower,
        upper: convFromStart.upper
      },
      hasSufficientSample,
      isSmallSampleWarning
    })

    prevCount = stage.count
  }

  // 3. Decline causes breakdown
  const declineCausesResult = await database
    .prepare(
      `SELECT
         COALESCE(decline_category, 'other') AS category,
         COALESCE(response_code, 'N/D') AS code,
         COUNT(id) AS decline_count
       FROM payment_funnel_events
       WHERE step = 'declined' AND ${whereSql}
       GROUP BY category, code
       ORDER BY decline_count DESC`
    )
    .bind(...binds)
    .all<{ category: PaymentDeclineCategory; code: string; decline_count: number }>()

  const declineCauses: PaymentDeclineCause[] = []
  const totalDeclinesFound = (declineCausesResult.results ?? []).reduce((acc, row) => acc + row.decline_count, 0)

  for (const row of declineCausesResult.results ?? []) {
    const category = row.category in DECLINE_CATEGORY_LABELS ? row.category : 'other'
    declineCauses.push({
      category,
      label: DECLINE_CATEGORY_LABELS[category],
      code: row.code,
      count: row.decline_count,
      percentage: totalDeclinesFound > 0 ? Math.round((row.decline_count / totalDeclinesFound) * 10000) / 10000 : 0
    })
  }

  // 4. Breakdowns by device, method, and bank
  async function computeDimensionBreakdown(
    dimension: 'device' | 'method' | 'bank'
  ): Promise<PaymentFunnelBreakdownItem[]> {
    const rows = await database
      .prepare(
        `SELECT
           COALESCE(${dimension}, 'unknown') AS dimension_key,
           COUNT(DISTINCT intent_id) AS attempts,
           COUNT(DISTINCT CASE WHEN step IN ('authorized', 'captured') THEN intent_id END) AS authorized,
           COUNT(DISTINCT CASE WHEN step = 'declined' THEN intent_id END) AS declined,
           COUNT(DISTINCT CASE WHEN step = 'cancelled' THEN intent_id END) AS cancelled
         FROM payment_funnel_events
         WHERE created_at >= ?1 AND created_at <= ?2
         GROUP BY ${dimension}`
      )
      .bind(from, to)
      .all<{
        dimension_key: string
        attempts: number
        authorized: number
        declined: number
        cancelled: number
      }>()

    return (rows.results ?? []).map((r) => {
      const key = r.dimension_key
      const label =
        dimension === 'device'
          ? key === 'desktop'
            ? 'Ordenador (Desktop)'
            : key === 'mobile'
              ? 'Móvil (Mobile)'
              : key === 'tablet'
                ? 'Tablet'
                : 'Desconocido'
          : dimension === 'method'
            ? key === 'card'
              ? 'Tarjeta bancaria'
              : key === 'bizum'
                ? 'Bizum'
                : key === 'bank_transfer'
                  ? 'Transferencia'
                  : 'Desconocido'
            : key === 'unknown'
              ? 'No disponible / Desconocido'
              : key

      const successRate = r.attempts > 0 ? Math.round((r.authorized / r.attempts) * 10000) / 10000 : 0
      return {
        key,
        label,
        attempts: r.attempts,
        authorized: r.authorized,
        declined: r.declined,
        cancelled: r.cancelled,
        successRate
      }
    })
  }

  const [byDevice, byMethod, byBank] = await Promise.all([
    computeDimensionBreakdown('device'),
    computeDimensionBreakdown('method'),
    computeDimensionBreakdown('bank')
  ])

  return {
    period: { from, to },
    filters: { device, method, bank },
    minSampleThreshold: MIN_PAYMENT_FUNNEL_SAMPLE_THRESHOLD,
    summary: {
      totalAttempts,
      authorizedCount,
      declinedCount,
      cancelledCount,
      expiredCount,
      authorizationRate: authWilson.rate,
      declineRate,
      cancellationRate,
      expirationRate,
      wilsonInterval: {
        lower: authWilson.lower,
        upper: authWilson.upper
      },
      hasSufficientSample: authWilson.hasSufficientSample
    },
    stages,
    declineCauses,
    breakdowns: {
      byDevice,
      byMethod,
      byBank
    }
  }
}

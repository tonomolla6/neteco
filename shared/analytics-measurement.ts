import { z } from 'zod'
import { catalogPolicyOwnJson, catalogPolicyInstantSchema, catalogPolicyUuidSchema } from './catalog-publication-policy'
import { cloudflareClientAnalyticsEventSchema as clientAnalyticsEventSchema } from './promotional-analytics'

export { clientAnalyticsEventSchema }
export const analyticsEnvironmentSchema = z.enum(['local', 'preview', 'production'])
export const analyticsSourceKindSchema = z.enum(['capture_applied', 'refund_confirmed', 'fiscal_issued'])
export const analyticsClientNameSchema = z.enum([
  'page_view',
  'catalog_viewed',
  'search_completed',
  'product_viewed',
  'cart_item_added',
  'cart_item_removed',
  'checkout_started',
  'web_vital',
  'promotional_impression',
  'promotional_click'
])
export const analyticsCountSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
export const analyticsHashSchema = z.string().regex(/^[0-9a-f]{64}$/)
const text = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine(
      (value) =>
        value === value.trim() &&
        Array.from(value).every((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127)
    )
function own(input: unknown) {
  try {
    return catalogPolicyOwnJson(input)
  } catch {
    return undefined
  }
}

/** Configuration is an explicit approved dataset policy, not implied consent.
 * No reviewer, purpose, retention or environment is supplied by default. */
export const analyticsMeasurementPolicySchema = z.preprocess(
  own,
  z
    .object({
      reference: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{2,99}$/),
      version: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/),
      purpose: z.literal('first_party_measurement'),
      consentVersion: z.literal('v1'),
      retentionDays: analyticsCountSchema.min(1).max(3650),
      environment: analyticsEnvironmentSchema,
      approvedAt: catalogPolicyInstantSchema
    })
    .strict()
)
export type AnalyticsMeasurementPolicy = z.infer<typeof analyticsMeasurementPolicySchema>

export const analyticsRangeSchema = z.preprocess(
  own,
  z
    .object({
      from: catalogPolicyInstantSchema,
      to: catalogPolicyInstantSchema,
      page: analyticsCountSchema.min(1).max(1000000).default(1),
      perPage: analyticsCountSchema.min(1).max(50).default(20)
    })
    .strict()
    .refine((value) => {
      const duration = Date.parse(value.to) - Date.parse(value.from)
      return duration > 0 && duration <= 31 * 86400000
    })
)
export type AnalyticsRange = z.infer<typeof analyticsRangeSchema>

export const analyticsFactSchema = z
  .object({
    sourceKind: analyticsSourceKindSchema,
    sourceId: catalogPolicyUuidSchema,
    orderId: catalogPolicyUuidSchema,
    currency: z.literal('EUR'),
    grossCents: analyticsCountSchema,
    netCents: analyticsCountSchema,
    taxCents: analyticsCountSchema,
    shippingGrossCents: analyticsCountSchema,
    occurredAt: catalogPolicyInstantSchema,
    projectedAt: catalogPolicyInstantSchema,
    population: z.enum(['validation', 'real']),
    sourceFingerprint: analyticsHashSchema
  })
  .strict()
  .refine(
    (value) => value.grossCents === value.netCents + value.taxCents && value.shippingGrossCents <= value.grossCents
  )
export type AnalyticsFact = z.infer<typeof analyticsFactSchema>

export const analyticsStreamCoverageSchema = z
  .object({
    kind: analyticsSourceKindSchema,
    sourceCount: analyticsCountSchema,
    eligibleCount: analyticsCountSchema,
    unconfirmedCount: analyticsCountSchema,
    excludedCount: analyticsCountSchema,
    projectedCount: analyticsCountSchema,
    backlogCount: analyticsCountSchema,
    oldestUnprojectedAt: catalogPolicyInstantSchema.nullable(),
    provenance: z.enum(['legacy_capture_unavailable', 'verified_capture', 'persisted_contract'])
  })
  .strict()
  .refine(
    (value) =>
      value.sourceCount === value.eligibleCount + value.unconfirmedCount + value.excludedCount &&
      value.projectedCount + value.backlogCount === value.eligibleCount
  )
const pagination = z
  .object({
    page: analyticsCountSchema.min(1).max(1000000),
    perPage: analyticsCountSchema.min(1).max(50),
    total: analyticsCountSchema,
    pages: analyticsCountSchema
  })
  .strict()
  .refine((value) => value.pages === Math.ceil(value.total / value.perPage))
const population = z
  .object({
    environment: analyticsEnvironmentSchema,
    validationOnly: z.boolean()
  })
  .strict()
  .refine((value) => value.validationOnly === (value.environment !== 'production'))

export const ANALYTICS_DEFINITIONS = [
  {
    key: 'grossCollectedCents',
    label: 'Cobrado bruto',
    definition:
      'Captura aplicada al pedido ganador, con prueba de origen única, reclamación de fulfillment y recuperación completada. Autoridad ausente o varios callbacks son no confirmados. Incluye IVA y portes.',
    population: 'Hechos de captura del servidor; producción requiere procedencia de proveedor verificable.',
    source: 'payment_events/payment_intents/order_payment_states/payment_fulfilment_claims/payment_recovery_jobs'
  },
  {
    key: 'refundedCents',
    label: 'Reembolsado confirmado',
    definition:
      'Importe de contratos de reembolso con trabajo completado y recibo succeeded coincidente. No solicitudes de devolución ni resultados ambiguos.',
    population: 'Contratos/recibos de reembolso; producción excluye sandbox y validation_only.',
    source: 'refund_contracts/refund_work/refund_receipts/order_events'
  },
  {
    key: 'collectedAfterRefundsCents',
    label: 'Cobrado menos reembolsos',
    definition:
      'Cobrado bruto menos reembolsos confirmados ocurridos dentro del mismo periodo. Es flujo monetario del periodo, NO ventas netas, margen ni liquidación bancaria.',
    population: 'Sólo disponible cuando ambas corrientes están completas y confirmadas.',
    source: 'analytics_commerce_facts'
  },
  {
    key: 'issuedFiscalCents',
    label: 'Documentación fiscal emitida',
    definition:
      'Documentos ordinarios con emisión completed, recibo issued y PDF persistido. No demuestra compra, envío ni liquidación bancaria.',
    population: 'Producción exige contrato/política production, proveedor Beply y validation_only=false.',
    source: 'fiscal_invoice_intents/fiscal_issuance_work/fiscal_provider_receipts/fiscal_documents'
  },
  {
    key: 'browserEvents',
    label: 'Eventos consentidos del navegador',
    definition:
      'Eventos cliente v1 aceptados, sin queries, PII ni rutas privadas. El navegador no es autoridad financiera y estos eventos no se unen por email a los pedidos.',
    population: 'Consentimiento analítico explícito; excluye bots conocidos y páginas privadas.',
    source: 'analytics_browser_events (client-reported)'
  }
] as const
const definition = z
  .object({ key: text(80), label: text(100), definition: text(1000), population: text(500), source: text(500) })
  .strict()

export const analyticsSnapshotSchema = z.preprocess(
  own,
  z
    .object({
      schemaVersion: z.literal('v1'),
      source: z.literal('cloudflare'),
      generatedAt: catalogPolicyInstantSchema,
      policy: z
        .object({
          reference: text(100),
          version: text(80),
          purpose: z.literal('first_party_measurement'),
          retentionDays: analyticsCountSchema.min(1).max(3650)
        })
        .strict(),
      period: z.object({ from: catalogPolicyInstantSchema, to: catalogPolicyInstantSchema }).strict(),
      population,
      coverage: z
        .object({
          status: z.enum(['complete', 'partial', 'unavailable']),
          streams: z.array(analyticsStreamCoverageSchema).length(3)
        })
        .strict(),
      metrics: z
        .object({
          currency: z.literal('EUR'),
          grossCollectedCents: analyticsCountSchema.nullable(),
          capturedOrders: analyticsCountSchema.nullable(),
          refundedCents: analyticsCountSchema.nullable(),
          confirmedRefunds: analyticsCountSchema.nullable(),
          collectedAfterRefundsCents: z
            .number()
            .int()
            .min(-Number.MAX_SAFE_INTEGER)
            .max(Number.MAX_SAFE_INTEGER)
            .nullable(),
          issuedFiscalCents: analyticsCountSchema.nullable(),
          issuedFiscalDocuments: analyticsCountSchema.nullable(),
          settlementCertified: z.literal(false)
        })
        .strict(),
      browser: z
        .object({
          eventCounts: z
            .array(z.object({ name: analyticsClientNameSchema, count: analyticsCountSchema }).strict())
            .length(10),
          uniqueSessions: analyticsCountSchema,
          financialAuthority: z.literal('none')
        })
        .strict(),
      definitions: z.array(definition).length(5),
      facts: z.array(analyticsFactSchema).max(50),
      pagination
    })
    .strict()
    .superRefine((value, context) => {
      const kinds = value.coverage.streams.map((stream) => stream.kind)
      if (new Set(kinds).size !== 3 || new Set(value.browser.eventCounts.map((event) => event.name)).size !== 10)
        context.addIssue({ code: z.ZodIssueCode.custom, message: 'Repeated measurement dimensions' })
      if (
        Date.parse(value.period.to) <= Date.parse(value.period.from) ||
        Date.parse(value.period.to) - Date.parse(value.period.from) > 31 * 86400000
      )
        context.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid measurement period' })
      if (
        value.facts.length > value.pagination.perPage ||
        value.facts.some(
          (fact) =>
            fact.occurredAt < value.period.from ||
            fact.occurredAt >= value.period.to ||
            fact.occurredAt > value.generatedAt ||
            fact.projectedAt < fact.occurredAt ||
            fact.projectedAt > value.generatedAt ||
            (fact.population === 'validation') !== value.population.validationOnly
        )
      )
        context.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid measurement population' })
      const metricStreams = [
        { kind: 'capture_applied', cents: value.metrics.grossCollectedCents, count: value.metrics.capturedOrders },
        { kind: 'refund_confirmed', cents: value.metrics.refundedCents, count: value.metrics.confirmedRefunds },
        { kind: 'fiscal_issued', cents: value.metrics.issuedFiscalCents, count: value.metrics.issuedFiscalDocuments }
      ]
      for (const metric of metricStreams) {
        const stream = value.coverage.streams.find((item) => item.kind === metric.kind)
        if (
          stream &&
          (((stream.unconfirmedCount > 0 || stream.backlogCount > 0) &&
            (metric.cents !== null || metric.count !== null)) ||
            (metric.count !== null && metric.count !== stream.projectedCount))
        )
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Unavailable or inconsistent financial observation'
          })
      }
      const cashIncomplete = value.coverage.streams.some(
        (stream) => stream.kind !== 'fiscal_issued' && (stream.unconfirmedCount > 0 || stream.backlogCount > 0)
      )
      if (
        (cashIncomplete && value.metrics.collectedAfterRefundsCents !== null) ||
        (value.metrics.grossCollectedCents !== null &&
          value.metrics.refundedCents !== null &&
          value.metrics.collectedAfterRefundsCents !== null &&
          value.metrics.collectedAfterRefundsCents !== value.metrics.grossCollectedCents - value.metrics.refundedCents)
      )
        context.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid period cash difference' })
      const total = value.coverage.streams.reduce((count, stream) => count + stream.projectedCount, 0)
      const incomplete = value.coverage.streams.some((stream) => stream.unconfirmedCount > 0 || stream.backlogCount > 0)
      const expectedStatus = incomplete ? (total > 0 ? 'partial' : 'unavailable') : 'complete'
      if (
        value.pagination.total !== total ||
        value.coverage.status !== expectedStatus ||
        value.facts.length !==
          Math.min(
            value.pagination.perPage,
            Math.max(0, total - (value.pagination.page - 1) * value.pagination.perPage)
          ) ||
        new Set(value.facts.map((fact) => `${fact.sourceKind}:${fact.sourceId}`)).size !== value.facts.length ||
        value.browser.uniqueSessions > value.browser.eventCounts.reduce((count, event) => count + event.count, 0)
      )
        context.addIssue({ code: z.ZodIssueCode.custom, message: 'Inconsistent measurement coverage' })
      if (
        new Set(value.definitions.map((item) => item.key)).size !== 5 ||
        value.definitions.some(
          (item) =>
            !ANALYTICS_DEFINITIONS.some(
              (known) =>
                known.key === item.key &&
                known.definition === item.definition &&
                known.population === item.population &&
                known.source === item.source &&
                known.label === item.label
            )
        )
      )
        context.addIssue({ code: z.ZodIssueCode.custom, message: 'Unknown metric definition' })
    })
)
export type AnalyticsSnapshot = z.infer<typeof analyticsSnapshotSchema>

export const analyticsReconciliationSchema = z.preprocess(
  own,
  z
    .object({
      schemaVersion: z.literal('v1'),
      source: z.literal('cloudflare'),
      generatedAt: catalogPolicyInstantSchema,
      policy: z
        .object({
          reference: text(100),
          version: text(80),
          purpose: z.literal('first_party_measurement'),
          retentionDays: analyticsCountSchema.min(1).max(3650)
        })
        .strict(),
      period: z.object({ from: catalogPolicyInstantSchema, to: catalogPolicyInstantSchema }).strict(),
      population,
      readOnly: z.literal(true),
      settlementCertified: z.literal(false),
      summary: z
        .object({
          sourceCount: analyticsCountSchema,
          missingCount: analyticsCountSchema,
          mismatchCount: analyticsCountSchema,
          unconfirmedCount: analyticsCountSchema,
          excludedCount: analyticsCountSchema,
          projectionLagSeconds: analyticsCountSchema.nullable()
        })
        .strict(),
      issues: z
        .array(
          z
            .object({
              code: z.enum(['missing', 'mismatch', 'unconfirmed']),
              sourceKind: analyticsSourceKindSchema,
              sourceId: catalogPolicyUuidSchema,
              occurredAt: catalogPolicyInstantSchema,
              lagSeconds: analyticsCountSchema.nullable(),
              hint: z.enum([
                'projection_pending',
                'projection_mismatch',
                'source_proof_unavailable',
                'capture_provenance_unavailable'
              ])
            })
            .strict()
        )
        .max(50),
      pagination
    })
    .strict()
)
export type AnalyticsReconciliation = z.infer<typeof analyticsReconciliationSchema>

export const analyticsProjectionResultSchema = z
  .object({
    enabled: z.boolean(),
    environment: analyticsEnvironmentSchema,
    validationOnly: z.boolean(),
    examined: analyticsCountSchema,
    projected: analyticsCountSchema,
    pages: analyticsCountSchema,
    remaining: analyticsCountSchema,
    complete: z.boolean(),
    sourceUnavailable: analyticsCountSchema,
    generatedAt: catalogPolicyInstantSchema
  })
  .strict()
export type AnalyticsProjectionResult = z.infer<typeof analyticsProjectionResultSchema>

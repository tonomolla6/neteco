import { z } from 'zod'

/** Shared contracts for SUP-014 (contact analysis), SUP-015 (education pipeline) and SUP-017 (B2B portal). */
const uuid = z.string().uuid()
const note = (min: number, max: number) =>
  z
    .string()
    .trim()
    .min(min)
    .max(max)
    .refine((value) => !/[\p{Cc}\p{Cf}]/u.test(value.replace(/[\n\t]/g, '')))
const version = z.number().int().min(1).max(9_007_199_254_740_990)

export function addHours(instant: string, hours: number): string {
  return new Date(Date.parse(instant) + hours * 3_600_000).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

// ---------------------------------------------------------------- SUP-014
export const ROOT_CAUSES = [
  'delivery_delay',
  'transit_damage',
  'wrong_item',
  'missing_item',
  'stock_unavailable',
  'product_information',
  'safety_usage_question',
  'payment_issue',
  'invoice_issue',
  'return_process',
  'account_access',
  'other'
] as const
export type RootCause = (typeof ROOT_CAUSES)[number]
export const ROOT_CAUSE_LABELS: Record<RootCause | 'unclassified', string> = {
  delivery_delay: 'Retraso en la entrega',
  transit_damage: 'Daño en transporte',
  wrong_item: 'Artículo equivocado',
  missing_item: 'Artículo faltante',
  stock_unavailable: 'Sin stock',
  product_information: 'Información de producto',
  safety_usage_question: 'Uso y seguridad',
  payment_issue: 'Incidencia de pago',
  invoice_issue: 'Incidencia de factura',
  return_process: 'Proceso de devolución',
  account_access: 'Acceso a la cuenta',
  other: 'Otros',
  unclassified: 'Sin clasificar'
}
const TICKET_DEFAULT: Record<string, RootCause> = {
  shipping: 'delivery_delay',
  product: 'product_information',
  payment: 'payment_issue',
  invoice: 'invoice_issue',
  return: 'return_process',
  account: 'account_access'
}
export function defaultRootCause(ticketCategory: string): RootCause {
  return TICKET_DEFAULT[ticketCategory] ?? 'other'
}
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
function validDay(value: string) {
  return (
    Number.isFinite(Date.parse(value + 'T00:00:00Z')) && new Date(value + 'T00:00:00Z').toISOString().startsWith(value)
  )
}
export const dayWindowSchema = z
  .object({ from: day, to: day })
  .strict()
  .refine((value) => {
    if (!validDay(value.from) || !validDay(value.to)) return false
    const span = (Date.parse(value.to) - Date.parse(value.from)) / 86_400_000
    return span >= 1 && span <= 366
  })
export const contactAnalysisQuerySchema = z
  .object({
    from: day,
    to: day,
    touchCostCents: z.number().int().min(0).max(1_000_000).optional(),
    limit: z.number().int().min(1).max(50).default(10)
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!validDay(value.from) || !validDay(value.to))
      return void ctx.addIssue({ code: 'custom', message: 'invalid_day' })
    const span = (Date.parse(value.to) - Date.parse(value.from)) / 86_400_000
    if (span < 1 || span > 366) ctx.addIssue({ code: 'custom', message: 'invalid_window' })
  })
export type ContactAnalysisQuery = z.infer<typeof contactAnalysisQuerySchema>
export const classifyInputSchema = z
  .object({
    ticketId: uuid,
    rootCause: z.enum(ROOT_CAUSES),
    note: note(1, 500).optional(),
    expectedVersion: z.number().int().min(0).max(9_007_199_254_740_990)
  })
  .strict()
export const BACKLOG_DIMENSIONS = ['order', 'product', 'carrier', 'category', 'root_cause'] as const
export const backlogCreateInputSchema = z
  .object({
    dimension: z.enum(BACKLOG_DIMENSIONS),
    dimensionKey: z.string().trim().min(1).max(160),
    rootCause: z.enum([...ROOT_CAUSES, 'unclassified']),
    title: note(5, 200),
    priority: z.enum(['low', 'normal', 'high']),
    from: day,
    to: day,
    evidence: z.record(z.string().max(60), z.union([z.string().max(300), z.number(), z.boolean(), z.null()])),
    rcaId: uuid.optional()
  })
  .strict()
  .refine(
    (value) =>
      validDay(value.from) && validDay(value.to) && value.to > value.from && Object.keys(value.evidence).length <= 20
  )
export type BacklogCreateInput = z.infer<typeof backlogCreateInputSchema>
export const backlogTransitionInputSchema = z
  .object({ action: z.enum(['plan', 'complete', 'dismiss']), expectedVersion: version, rcaId: uuid.optional() })
  .strict()
export const BACKLOG_NEXT: Record<string, Record<string, string>> = {
  open: { plan: 'planned', dismiss: 'dismissed' },
  planned: { complete: 'done', dismiss: 'dismissed' }
}

// ---------------------------------------------------------------- SUP-015
export type EducationStatus = 'detected' | 'in_review' | 'approved' | 'published' | 'rejected'
const EDU_NEXT: Record<string, Record<string, EducationStatus>> = {
  detected: { start_review: 'in_review' },
  in_review: { approve: 'approved', reject: 'rejected' },
  approved: { publish: 'published' }
}
export function educationNextStatus(status: EducationStatus, action: string): EducationStatus | null {
  return EDU_NEXT[status]?.[action] ?? null
}
export const EDUCATION_TARGETS = ['faq', 'guide', 'pdp'] as const
export const educationDetectInputSchema = z
  .object({ from: day, to: day, minOccurrences: z.number().int().min(2).max(1000).default(3) })
  .strict()
  .refine((value) => validDay(value.from) && validDay(value.to) && value.to > value.from)
export const educationCommandSchema = z
  .discriminatedUnion('action', [
    z.object({ action: z.literal('start_review'), expectedVersion: version }).strict(),
    z
      .object({
        action: z.literal('approve'),
        expectedVersion: version,
        reviewNotes: note(10, 2000),
        targetKind: z.enum(EDUCATION_TARGETS),
        safetyReviewed: z.literal(true)
      })
      .strict(),
    z.object({ action: z.literal('reject'), expectedVersion: version, reviewNotes: note(10, 2000) }).strict(),
    z
      .object({
        action: z.literal('publish'),
        expectedVersion: version,
        targetPageId: uuid.optional(),
        targetProductSlug: z
          .string()
          .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
          .max(160)
          .optional()
      })
      .strict()
  ])
  .refine(
    (value) =>
      value.action !== 'publish' || (value.targetPageId === undefined) !== (value.targetProductSlug === undefined)
  )
export type EducationCommand = z.infer<typeof educationCommandSchema>

export interface DeflectionTurn {
  createdAt: string
  escalated: boolean
  helpful: boolean | null
}
export interface DeflectionWindow {
  turns: number
  escalated: number
  rateBp: number
  helpfulRateBp: number | null
}
export interface DeflectionResult {
  status: 'measured' | 'insufficient_data'
  windowDays: number
  observedDays: number
  before: DeflectionWindow
  after: DeflectionWindow
  deflectionBp: number | null
}
export const DEFLECTION_MIN_OBSERVED_DAYS = 7
export const DEFLECTION_MIN_BASELINE_TURNS = 3
function windowStats(turns: DeflectionTurn[]): DeflectionWindow {
  const escalated = turns.filter((turn) => turn.escalated).length
  const rated = turns.filter((turn) => turn.helpful !== null)
  return {
    turns: turns.length,
    escalated,
    rateBp: turns.length === 0 ? 0 : Math.round((escalated / turns.length) * 10000),
    helpfulRateBp:
      rated.length === 0 ? null : Math.round((rated.filter((turn) => turn.helpful).length / rated.length) * 10000)
  }
}
/** Real deflection: how much the share of questions that still needed a human fell after publication. */
export function computeDeflection(input: {
  publishedAt: string
  now: string
  windowDays: number
  turns: DeflectionTurn[]
}): DeflectionResult {
  const published = Date.parse(input.publishedAt),
    now = Date.parse(input.now),
    span = input.windowDays * 86_400_000
  const before = input.turns.filter(
    (t) => Date.parse(t.createdAt) >= published - span && Date.parse(t.createdAt) < published
  )
  const afterEnd = Math.min(now, published + span)
  const after = input.turns.filter((t) => Date.parse(t.createdAt) >= published && Date.parse(t.createdAt) < afterEnd)
  const observedDays = Math.max(0, Math.floor((afterEnd - published) / 86_400_000))
  const b = windowStats(before),
    a = windowStats(after)
  const enough =
    observedDays >= DEFLECTION_MIN_OBSERVED_DAYS && b.turns >= DEFLECTION_MIN_BASELINE_TURNS && b.rateBp > 0
  return {
    status: enough ? 'measured' : 'insufficient_data',
    windowDays: input.windowDays,
    observedDays,
    before: b,
    after: a,
    deflectionBp: enough ? Math.round(((b.rateBp - a.rateBp) / b.rateBp) * 10000) : null
  }
}

// ---------------------------------------------------------------- SUP-017
export const B2B_KINDS = ['quote', 'product_onboarding', 'documentation', 'credit', 'claim'] as const
export type B2bKind = (typeof B2B_KINDS)[number]
/** Internal first-response targets (calendar hours). Operator-adjustable constants, not a customer promise. */
export const B2B_SLA_HOURS: Record<B2bKind, number> = {
  quote: 24,
  product_onboarding: 72,
  documentation: 48,
  credit: 72,
  claim: 24
}
export type B2bStatus =
  'submitted' | 'in_review' | 'waiting_customer' | 'approved' | 'rejected' | 'resolved' | 'cancelled'
export const B2B_OPEN: readonly B2bStatus[] = ['submitted', 'in_review', 'waiting_customer']
const slug = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  .max(160)
const subject = note(5, 200)
export const b2bCreateInputSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('quote'),
      subject,
      details: z
        .object({
          lines: z
            .array(z.object({ productSlug: slug, quantity: z.number().int().min(1).max(100000) }).strict())
            .min(1)
            .max(30),
          deliveryNote: note(1, 500).optional()
        })
        .strict()
    })
    .strict(),
  z
    .object({
      kind: z.literal('product_onboarding'),
      subject,
      details: z
        .object({
          productName: note(3, 160),
          brand: note(1, 120).optional(),
          intendedUse: note(5, 500),
          estimatedMonthlyUnits: z.number().int().min(1).max(1_000_000),
          hasSafetyDataSheet: z.boolean()
        })
        .strict()
    })
    .strict(),
  z
    .object({
      kind: z.literal('documentation'),
      subject,
      details: z
        .object({
          documentType: z.enum(['safety_data_sheet', 'technical_sheet', 'certificate', 'invoice_copy', 'other']),
          productSlug: slug.optional(),
          reason: note(1, 500).optional()
        })
        .strict()
    })
    .strict(),
  z
    .object({
      kind: z.literal('credit'),
      subject,
      details: z
        .object({
          requestedLimitCents: z.number().int().min(1).max(1_000_000_000),
          paymentTermDays: z.union([z.literal(30), z.literal(60), z.literal(90)]),
          justification: note(10, 1000)
        })
        .strict()
    })
    .strict(),
  z
    .object({
      kind: z.literal('claim'),
      subject,
      orderId: uuid,
      details: z
        .object({
          claimType: z.enum(['damaged', 'missing', 'wrong_item', 'billing', 'quality']),
          description: note(10, 1500),
          affectedUnits: z.number().int().min(1).max(100000).optional()
        })
        .strict()
    })
    .strict()
])
export type B2bCreateInput = z.infer<typeof b2bCreateInputSchema>
export const B2B_DOCUMENT_KINDS = [
  'safety_data_sheet',
  'technical_sheet',
  'certificate',
  'tax_document',
  'credit_report',
  'claim_evidence',
  'other'
] as const
export const b2bDocumentInputSchema = z
  .object({
    kind: z.enum(B2B_DOCUMENT_KINDS),
    fileName: z
      .string()
      .min(1)
      .max(120)
      .refine((v) => v === v.trim() && !/[/\\\p{Cc}]/u.test(v)),
    contentType: z.enum(['application/pdf', 'image/jpeg', 'image/png']),
    sizeBytes: z.number().int().min(1).max(10_485_760),
    sha256: z.string().regex(/^[a-f0-9]{64}$/)
  })
  .strict()
export const b2bReplyInputSchema = z.object({ message: note(1, 2000) }).strict()
export const b2bCancelInputSchema = z.object({ expectedVersion: version, reason: note(1, 500).optional() }).strict()
export const B2B_ADMIN_ACTIONS = [
  'start_review',
  'request_info',
  'approve',
  'reject',
  'resolve',
  'reply',
  'assign'
] as const
export const b2bAdminCommandSchema = z
  .object({ action: z.enum(B2B_ADMIN_ACTIONS), expectedVersion: version, note: note(1, 2000).optional() })
  .strict()
  .refine((value) => !['request_info', 'reject', 'reply'].includes(value.action) || value.note !== undefined)
export type B2bAdminCommand = z.infer<typeof b2bAdminCommandSchema>
export function b2bNextStatus(status: B2bStatus, action: string, kind: B2bKind): B2bStatus | null {
  if (action === 'start_review') return status === 'submitted' ? 'in_review' : null
  if (action === 'request_info') return status === 'in_review' ? 'waiting_customer' : null
  if (action === 'approve')
    return status === 'in_review' && ['quote', 'product_onboarding', 'credit'].includes(kind) ? 'approved' : null
  if (action === 'reject') return status === 'in_review' ? 'rejected' : null
  if (action === 'resolve') return status === 'in_review' || status === 'approved' ? 'resolved' : null
  return null
}
export type B2bSlaState = 'on_track' | 'at_risk' | 'met' | 'breached'
export function b2bSlaState(
  request: { createdAt: string; slaDueAt: string; firstResponseAt: string | null },
  now: string
): B2bSlaState {
  if (request.firstResponseAt !== null) return request.firstResponseAt <= request.slaDueAt ? 'met' : 'breached'
  if (now > request.slaDueAt) return 'breached'
  const window = Date.parse(request.slaDueAt) - Date.parse(request.createdAt)
  const left = Date.parse(request.slaDueAt) - Date.parse(now)
  return left * 4 <= window ? 'at_risk' : 'on_track'
}

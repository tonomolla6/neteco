import { z } from 'zod'
import { catalogPolicyInstantSchema, catalogPolicyOwnJson, catalogPolicyUuidSchema } from './catalog-publication-policy'
import { cmsCtaHrefIsSafe } from './cms-safe-links'

export const DEFAULT_GLOBAL_MODAL_COOLDOWN_SECONDS = 3600
export const MIN_MODAL_TIME_ON_PAGE_SECONDS = 5
export const MAX_MOBILE_VIEWPORT_HEIGHT_PERCENT = 50
export const DESKTOP_MAX_VIEWPORT_HEIGHT_PERCENT = 80

const own = (value: unknown) => {
  try {
    return catalogPolicyOwnJson(value)
  } catch {
    return undefined
  }
}

/**
 * Strips HTML/script/style markup, angle brackets and control characters,
 * normalizing plain text in NFC so free-form HTML is never stored or rendered.
 */
export function sanitizeMarketingModalText(raw: string): string {
  if (typeof raw !== 'string') return ''
  const cleaned = raw
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[<>]/g, '')

  let out = ''
  for (let i = 0; i < cleaned.length; i++) {
    const code = cleaned.charCodeAt(i)
    if (
      (code >= 32 && code !== 127 && !(code >= 128 && code <= 159) && code !== 0x2028 && code !== 0x2029) ||
      code === 10
    ) {
      out += cleaned[i]
    } else {
      out += ' '
    }
  }
  return out
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line, idx, arr) => line.length > 0 || (idx > 0 && arr[idx - 1] !== ''))
    .join('\n')
    .trim()
}

const sanitizedText = (min: number, max: number) =>
  z
    .string()
    .max(max * 2)
    .transform((value) => sanitizeMarketingModalText(value))
    .pipe(
      z
        .string()
        .min(min)
        .max(max)
        .refine((value) => !/[<>]/.test(value), 'No se permite marcado HTML')
    )

const PROHIBITED_ROUTE_PATTERN =
  /^\/(?:carrito(?:-compartido)?|checkout|pago[^/]*|cuenta\/seguridad|privacidad|politica-(?:de-)?privacidad|cookies|politica-(?:de-)?cookies|terminos|condiciones(?:-generales)?|aviso-legal|legal|accesibilidad|devoluciones|formas-de-pago|envios|admin|api|auth|login|registro|recuperar-clave|restablecer-clave|reset|reset-password|verificar-email|pedido|pedidos|newsletter\/(?:baja|confirmar|preferencias)|contenido\/(?:aviso-legal|privacidad|cookies|terminos|condiciones|legal))(?:[/\\%?]|$)/i

/**
 * Authoritative route check for MKT-010: never allow modals on cart, checkout,
 * payment, account security, legal pages, admin or authentication routes.
 */
export function isMarketingModalProhibitedRoute(path: string): boolean {
  if (typeof path !== 'string' || path.length === 0 || path.length > 300) return true
  let candidate = path.trim()
  for (let round = 0; round < 4; round++) {
    const withoutQuery = candidate.split(/[?#]/)[0] ?? ''
    if (
      !withoutQuery.startsWith('/') ||
      withoutQuery.startsWith('//') ||
      withoutQuery.includes('..') ||
      withoutQuery.includes('/./') ||
      withoutQuery.includes('\\') ||
      PROHIBITED_ROUTE_PATTERN.test(withoutQuery)
    ) {
      return true
    }
    for (let i = 0; i < withoutQuery.length; i++) {
      const code = withoutQuery.charCodeAt(i)
      if (code <= 32 || code === 127) return true
    }
    try {
      const decoded = decodeURIComponent(candidate)
      if (decoded === candidate) {
        return !/^\/[A-Za-z0-9/_-]*$/.test(withoutQuery)
      }
      candidate = decoded
    } catch {
      return true
    }
  }
  return true
}

/**
 * Reuses canonical cmsCtaHrefIsSafe and enforces an internal storefront path
 * that is never an external URL, admin route, API endpoint, cart or checkout.
 */
export function isSafeInternalModalCtaPath(href: string): boolean {
  if (typeof href !== 'string' || href.length < 1 || href.length > 300) return false
  if (!href.startsWith('/') || href.startsWith('//')) return false
  if (href.includes('..') || href.includes('/./') || href.includes('\\')) return false
  if (!cmsCtaHrefIsSafe(href)) return false
  const pathOnly = href.split(/[?#]/)[0] ?? ''
  if (/^\/(?:admin|api|carrito|checkout|pago|login|registro|auth)(?:\/|$)/i.test(pathOnly)) return false
  return true
}

export function normalizeModalRoutePath(path: string): string {
  const clean = (path.split(/[?#]/)[0] ?? '').trim()
  if (clean === '/' || clean === '') return '/'
  return clean.endsWith('/') ? clean.slice(0, -1) : clean
}

export function matchesModalRoutePrefix(path: string, prefix: string): boolean {
  const normalizedPath = normalizeModalRoutePath(path)
  const normalizedPrefix = normalizeModalRoutePath(prefix)
  if (normalizedPrefix === '/') return normalizedPath.startsWith('/')
  // Segment boundary only: "/catalogo" matches "/catalogo/x" but never "/catalogo-outlet".
  return normalizedPath === normalizedPrefix || normalizedPath.startsWith(`${normalizedPrefix}/`)
}

export function selectMarketingModalVariant(modalId: string, splitPercent: number, seed = 'default'): 'A' | 'B' {
  if (!Number.isFinite(splitPercent) || splitPercent <= 0) return 'A'
  if (splitPercent >= 100) return 'B'
  const input = `${modalId}:${seed}`
  let hash = 2166136261
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  const bucket = (hash >>> 0) % 100
  return bucket < splitPercent ? 'B' : 'A'
}

export const marketingModalStatusSchema = z.enum(['draft', 'published', 'retired'])
export type MarketingModalStatus = z.infer<typeof marketingModalStatusSchema>

export const marketingModalObjectiveSchema = z.enum([
  'newsletter_subscription',
  'professional_lead',
  'catalog_discovery',
  'promotion_redemption',
  'support_guidance'
])
export type MarketingModalObjective = z.infer<typeof marketingModalObjectiveSchema>

export const marketingModalTriggerKindSchema = z.enum(['time_on_page', 'scroll_depth', 'exit_intent', 'page_views'])
export type MarketingModalTriggerKind = z.infer<typeof marketingModalTriggerKindSchema>

export const marketingModalAudienceSegmentSchema = z.enum(['anonymous', 'customer', 'professional'])
export type MarketingModalAudienceSegment = z.infer<typeof marketingModalAudienceSegmentSchema>

export const marketingModalConsentRequirementSchema = z.enum(['any', 'with_consent', 'without_consent'])
export type MarketingModalConsentRequirement = z.infer<typeof marketingModalConsentRequirementSchema>

export const marketingModalPriorityTierSchema = z.enum(['normal', 'high', 'critical'])
export type MarketingModalPriorityTier = z.infer<typeof marketingModalPriorityTierSchema>

export const marketingModalVariantKeySchema = z.enum(['A', 'B'])
export type MarketingModalVariantKey = z.infer<typeof marketingModalVariantKeySchema>

export const marketingModalViewportSchema = z.enum(['mobile', 'desktop'])
export type MarketingModalViewport = z.infer<typeof marketingModalViewportSchema>

export const marketingModalEventTypeSchema = z.enum(['impression', 'dismiss', 'convert'])
export type MarketingModalEventType = z.infer<typeof marketingModalEventTypeSchema>

export const marketingModalRejectionReasonSchema = z.enum([
  'eligible',
  'prohibited_route',
  'initial_load_guard',
  'active_modal_open',
  'page_view_limit_reached',
  'session_limit_reached',
  'global_cooldown_active',
  'no_matching_modal',
  'not_published',
  'outside_validity_window',
  'route_excluded',
  'route_not_included',
  'audience_mismatch',
  'consent_mismatch',
  'dismissed_permanently',
  'converted_permanently',
  'frequency_cap_reached',
  'exit_intent_mobile_forbidden',
  'trigger_not_met'
])
export type MarketingModalRejectionReason = z.infer<typeof marketingModalRejectionReasonSchema>

const internalCtaPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(300)
  .refine(isSafeInternalModalCtaPath, 'El CTA debe apuntar a una ruta interna segura')

const routePrefixSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^\/[A-Za-z0-9/_-]*$/, 'El prefijo de ruta debe empezar por /')
  .refine((prefix) => !prefix.startsWith('//') && !prefix.includes('..'), 'Prefijo inválido')

const includePrefixSchema = routePrefixSchema.refine(
  (prefix) => prefix === '/' || !isMarketingModalProhibitedRoute(prefix),
  'No se puede incluir una ruta prohibida por las reglas anti-molestia'
)

export const marketingModalTriggerSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('time_on_page'),
      minSeconds: z.number().int().min(MIN_MODAL_TIME_ON_PAGE_SECONDS).max(3600)
    })
    .strict(),
  z
    .object({
      kind: z.literal('scroll_depth'),
      minPercent: z.number().int().min(10).max(100)
    })
    .strict(),
  z
    .object({
      kind: z.literal('exit_intent'),
      minSeconds: z.number().int().min(MIN_MODAL_TIME_ON_PAGE_SECONDS).max(3600).default(5)
    })
    .strict(),
  z
    .object({
      kind: z.literal('page_views'),
      minPageViews: z.number().int().min(1).max(100)
    })
    .strict()
])
export type MarketingModalTrigger = z.infer<typeof marketingModalTriggerSchema>

export const marketingModalAbVariantSchema = z
  .object({
    title: sanitizedText(3, 160),
    body: sanitizedText(10, 2000),
    ctaLabel: sanitizedText(2, 80),
    ctaPath: internalCtaPathSchema,
    splitPercent: z.number().int().min(1).max(99)
  })
  .strict()
export type MarketingModalAbVariant = z.infer<typeof marketingModalAbVariantSchema>

export const marketingModalDefinitionSchema = z
  .object({
    id: catalogPolicyUuidSchema,
    version: z.number().int().min(1).max(1_000_000),
    code: z
      .string()
      .trim()
      .min(3)
      .max(64)
      .regex(/^[a-z0-9][a-z0-9_-]*$/),
    status: marketingModalStatusSchema,
    title: sanitizedText(3, 160),
    body: sanitizedText(10, 2000),
    ctaLabel: sanitizedText(2, 80),
    ctaPath: internalCtaPathSchema,
    objective: marketingModalObjectiveSchema,
    abVariant: marketingModalAbVariantSchema.nullable(),
    trigger: marketingModalTriggerSchema,
    audience: z
      .object({
        segments: z
          .array(marketingModalAudienceSegmentSchema)
          .min(1)
          .max(3)
          .refine((items) => new Set(items).size === items.length, 'Audiencia duplicada'),
        marketingConsent: marketingModalConsentRequirementSchema
      })
      .strict(),
    targeting: z
      .object({
        includePrefixes: z
          .array(includePrefixSchema)
          .min(1)
          .max(20)
          .refine((items) => new Set(items).size === items.length, 'Prefijo incluido duplicado'),
        excludePrefixes: z
          .array(routePrefixSchema)
          .max(20)
          .refine((items) => new Set(items).size === items.length, 'Prefijo excluido duplicado')
      })
      .strict(),
    priority: z.number().int().min(0).max(1000),
    priorityTier: marketingModalPriorityTierSchema,
    frequency: z
      .object({
        maxImpressionsPerVisitor: z.number().int().min(1).max(50),
        windowSeconds: z.number().int().min(60).max(7_776_000)
      })
      .strict(),
    startsAt: catalogPolicyInstantSchema,
    endsAt: catalogPolicyInstantSchema.nullable()
  })
  .strict()
  .superRefine((def, ctx) => {
    if (def.endsAt !== null && def.endsAt <= def.startsAt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'La fecha de fin debe ser posterior al inicio'
      })
    }
  })
export type MarketingModalDefinition = z.infer<typeof marketingModalDefinitionSchema>

export const adminMarketingModalInputSchema = z.preprocess(
  own,
  z
    .object({
      expectedVersion: z.number().int().min(0).max(999_999),
      definition: marketingModalDefinitionSchema,
      reason: sanitizedText(5, 500)
    })
    .strict()
    .superRefine((value, ctx) => {
      if (value.definition.version !== value.expectedVersion + 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'La versión de la definición debe ser expectedVersion + 1'
        })
      }
    })
)
export type AdminMarketingModalInput = z.infer<typeof adminMarketingModalInputSchema>

export const adminMarketingModalPolicyInputSchema = z.preprocess(
  own,
  z
    .object({
      expectedVersion: z.number().int().min(0).max(999_999),
      globalCooldownSeconds: z.number().int().min(60).max(604_800),
      reason: sanitizedText(5, 500)
    })
    .strict()
)
export type AdminMarketingModalPolicyInput = z.infer<typeof adminMarketingModalPolicyInputSchema>

export const adminMarketingModalQuerySchema = z
  .object({
    q: z.string().trim().max(120).default(''),
    status: z.enum(['all', 'draft', 'published', 'retired']).default('all'),
    page: z.number().int().min(1).max(10_000).default(1),
    perPage: z.number().int().min(1).max(50).default(25)
  })
  .strict()
export type AdminMarketingModalQuery = z.infer<typeof adminMarketingModalQuerySchema>

export const marketingModalStatsSchema = z
  .object({
    impressions: z.number().int().nonnegative(),
    dismissals: z.number().int().nonnegative(),
    conversions: z.number().int().nonnegative()
  })
  .strict()
export type MarketingModalStats = z.infer<typeof marketingModalStatsSchema>

export const adminMarketingModalItemSchema = z
  .object({
    definition: marketingModalDefinitionSchema,
    stats: marketingModalStatsSchema,
    createdAt: catalogPolicyInstantSchema,
    updatedAt: catalogPolicyInstantSchema
  })
  .strict()
export type AdminMarketingModalItem = z.infer<typeof adminMarketingModalItemSchema>

export const marketingModalPolicySchema = z
  .object({
    version: z.number().int().nonnegative(),
    globalCooldownSeconds: z.number().int().min(60).max(604_800),
    updatedAt: catalogPolicyInstantSchema.nullable(),
    updatedBy: catalogPolicyUuidSchema.nullable()
  })
  .strict()
export type MarketingModalPolicy = z.infer<typeof marketingModalPolicySchema>

export const adminMarketingModalListSchema = z
  .object({
    source: z.literal('cloudflare'),
    policy: marketingModalPolicySchema,
    items: z.array(adminMarketingModalItemSchema).max(50),
    total: z.number().int().nonnegative(),
    page: z.number().int().positive(),
    perPage: z.number().int().positive()
  })
  .strict()
export type AdminMarketingModalList = z.infer<typeof adminMarketingModalListSchema>

export const adminMarketingModalHistoryEntrySchema = z
  .object({
    definition: marketingModalDefinitionSchema,
    actorId: catalogPolicyUuidSchema,
    reason: z.string().min(5).max(500),
    createdAt: catalogPolicyInstantSchema
  })
  .strict()
export type AdminMarketingModalHistoryEntry = z.infer<typeof adminMarketingModalHistoryEntrySchema>

export const adminMarketingModalDetailSchema = z
  .object({
    source: z.literal('cloudflare'),
    item: adminMarketingModalItemSchema,
    history: z.array(adminMarketingModalHistoryEntrySchema).max(50),
    historyTotal: z.number().int().nonnegative(),
    historyPage: z.number().int().positive()
  })
  .strict()
export type AdminMarketingModalDetail = z.infer<typeof adminMarketingModalDetailSchema>

export const adminMarketingModalReceiptSchema = z
  .object({
    source: z.literal('cloudflare'),
    commandId: catalogPolicyUuidSchema,
    modalId: catalogPolicyUuidSchema,
    version: z.number().int().positive(),
    status: marketingModalStatusSchema,
    payloadHash: z.string().regex(/^[0-9a-f]{64}$/),
    definitionHash: z.string().regex(/^[0-9a-f]{64}$/),
    item: adminMarketingModalItemSchema,
    createdAt: catalogPolicyInstantSchema
  })
  .strict()
export type AdminMarketingModalReceipt = z.infer<typeof adminMarketingModalReceiptSchema>

export const adminMarketingModalPolicyReceiptSchema = z
  .object({
    source: z.literal('cloudflare'),
    commandId: catalogPolicyUuidSchema,
    payloadHash: z.string().regex(/^[0-9a-f]{64}$/),
    policy: marketingModalPolicySchema
  })
  .strict()
export type AdminMarketingModalPolicyReceipt = z.infer<typeof adminMarketingModalPolicyReceiptSchema>

export const marketingModalEligibilityInputSchema = z.preprocess(
  own,
  z
    .object({
      path: z.string().trim().min(1).max(300),
      viewport: marketingModalViewportSchema.default('desktop'),
      timeOnPageSeconds: z.number().min(0).max(86_400),
      scrollPercent: z.number().min(0).max(100).default(0),
      exitIntent: z.boolean().default(false),
      pageViewsInSession: z.number().int().min(1).max(1000).default(1),
      isInitialLoad: z.boolean().default(false),
      activeModalOpen: z.boolean().default(false),
      pageViewModalsShown: z.number().int().min(0).max(100).default(0),
      sessionModalsShown: z.number().int().min(0).max(100).default(0),
      prefersReducedMotion: z.boolean().default(false),
      marketingConsent: z.boolean().default(false),
      analyticsConsent: z.boolean().default(false),
      variantSeed: z
        .string()
        .trim()
        .max(120)
        .regex(/^[A-Za-z0-9._:-]*$/)
        .optional(),
      lastDismissedAt: catalogPolicyInstantSchema.nullable().optional(),
      dismissedModalIds: z.array(catalogPolicyUuidSchema).max(100).default([]),
      convertedModalIds: z.array(catalogPolicyUuidSchema).max(100).default([]),
      convertedObjectives: z.array(marketingModalObjectiveSchema).max(5).default([]),
      impressionsByModal: z.record(catalogPolicyUuidSchema, z.array(catalogPolicyInstantSchema).max(50)).default({}),
      newsletterSubscribed: z.boolean().default(false)
    })
    .strict()
)
export type MarketingModalEligibilityInput = z.infer<typeof marketingModalEligibilityInputSchema>

export const publicMarketingModalSchema = z
  .object({
    id: catalogPolicyUuidSchema,
    code: z.string().min(3).max(64),
    version: z.number().int().positive(),
    title: z.string().min(3).max(160),
    body: z.string().min(10).max(2000),
    ctaLabel: z.string().min(2).max(80),
    ctaPath: internalCtaPathSchema,
    objective: marketingModalObjectiveSchema,
    variant: marketingModalVariantKeySchema,
    priority: z.number().int().min(0).max(1000),
    priorityTier: marketingModalPriorityTierSchema,
    triggerKind: marketingModalTriggerKindSchema,
    presentation: z
      .object({
        layout: z.enum(['bottom_sheet', 'centered_dialog']),
        maxViewportHeightPercent: z.union([z.literal(50), z.literal(80)]),
        reducedMotion: z.boolean(),
        closePersistent: z.literal(true)
      })
      .strict()
  })
  .strict()
export type PublicMarketingModal = z.infer<typeof publicMarketingModalSchema>

export const marketingModalEligibilityResponseSchema = z
  .object({
    source: z.literal('cloudflare'),
    eligible: z.boolean(),
    reason: marketingModalRejectionReasonSchema,
    globalCooldownSeconds: z.number().int().min(60).max(604_800),
    modal: publicMarketingModalSchema.nullable(),
    evaluatedAt: catalogPolicyInstantSchema
  })
  .strict()
export type MarketingModalEligibilityResponse = z.infer<typeof marketingModalEligibilityResponseSchema>

export const marketingModalInteractionInputSchema = z.preprocess(
  own,
  z
    .object({
      eventId: catalogPolicyUuidSchema,
      modalId: catalogPolicyUuidSchema,
      modalVersion: z.number().int().min(1).max(1_000_000),
      variant: marketingModalVariantKeySchema,
      eventType: marketingModalEventTypeSchema,
      objective: marketingModalObjectiveSchema,
      analyticsConsent: z.boolean().default(false)
    })
    .strict()
)
export type MarketingModalInteractionInput = z.infer<typeof marketingModalInteractionInputSchema>

export const marketingModalInteractionReceiptSchema = z
  .object({
    source: z.literal('cloudflare'),
    eventId: catalogPolicyUuidSchema,
    recorded: z.boolean(),
    persisted: z.enum(['server_d1', 'browser_only']),
    replayed: z.boolean(),
    reason: z.enum(['recorded', 'analytics_consent_required'])
  })
  .strict()
export type MarketingModalInteractionReceipt = z.infer<typeof marketingModalInteractionReceiptSchema>

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`)
    .join(',')}}`
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function marketingModalDefinitionHash(definition: MarketingModalDefinition): Promise<string> {
  const parsed = marketingModalDefinitionSchema.parse(definition)
  return sha256(`neteco:marketing-modal:definition:v1:${canonicalize(parsed)}`)
}

export async function adminMarketingModalIntentHash(input: AdminMarketingModalInput): Promise<string> {
  const parsed = adminMarketingModalInputSchema.parse(input)
  return sha256(`neteco:marketing-modal:intent:v1:${canonicalize(parsed)}`)
}

export async function adminMarketingModalPolicyIntentHash(input: AdminMarketingModalPolicyInput): Promise<string> {
  const parsed = adminMarketingModalPolicyInputSchema.parse(input)
  return sha256(`neteco:marketing-modal:policy-intent:v1:${canonicalize(parsed)}`)
}

export async function marketingModalInteractionHash(input: {
  modalId: string
  modalVersion: number
  variant: 'A' | 'B'
  eventType: 'impression' | 'dismiss' | 'convert'
  objective: string
}): Promise<string> {
  return sha256(`neteco:marketing-modal:interaction:v1:${canonicalize(input)}`)
}

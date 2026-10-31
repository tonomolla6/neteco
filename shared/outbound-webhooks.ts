import { createHmac, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'

export const WEBHOOK_TOPICS = [
  'order.created',
  'order.paid',
  'order.fulfilled',
  'order.cancelled',
  'invoice.issued',
  'inventory.low',
  'test.ping'
] as const

export type WebhookTopic = (typeof WEBHOOK_TOPICS)[number]

export const WEBHOOK_DELIVERY_STATUSES = ['pending', 'delivered', 'retrying', 'dead_letter', 'failed'] as const
export type WebhookDeliveryStatus = (typeof WEBHOOK_DELIVERY_STATUSES)[number]

export const CreateWebhookSubscriptionInputSchema = z.object({
  url: z
    .string()
    .url()
    .refine((url) => url.startsWith('https://'), {
      message: 'https_required: Webhook destination URL must use HTTPS'
    }),
  topics: z.array(z.enum(WEBHOOK_TOPICS)).min(1),
  description: z.string().min(2).max(255)
})

export type CreateWebhookSubscriptionInput = z.infer<typeof CreateWebhookSubscriptionInputSchema>

export const UpdateWebhookSubscriptionInputSchema = z.object({
  id: z.string().uuid(),
  url: z
    .string()
    .url()
    .refine((url) => url.startsWith('https://'), {
      message: 'https_required: Webhook destination URL must use HTTPS'
    })
    .optional(),
  topics: z.array(z.enum(WEBHOOK_TOPICS)).min(1).optional(),
  description: z.string().min(2).max(255).optional(),
  status: z.enum(['active', 'paused', 'disabled']).optional(),
  expectedVersion: z.number().int().positive()
})

export type UpdateWebhookSubscriptionInput = z.infer<typeof UpdateWebhookSubscriptionInputSchema>

export const RotateSecretInputSchema = z.object({
  expectedVersion: z.number().int().positive(),
  gracePeriodSeconds: z.number().int().min(60).max(604800).default(86400) // 1 día por defecto
})

export type RotateSecretInput = z.infer<typeof RotateSecretInputSchema>

export interface WebhookSubscription {
  id: string
  ownerId: string
  url: string
  topics: WebhookTopic[]
  description: string
  status: 'active' | 'paused' | 'disabled'
  primarySecret: string
  secondarySecret?: string | null
  secondarySecretExpiresAt?: string | null
  secretRotatedAt?: string | null
  version: number
  createdAt: string
  updatedAt: string
}

export interface MinimizedWebhookEnvelope {
  id: string
  event: WebhookTopic
  version: 'v1' | '2026-10-01'
  occurred_at: string
  data: Record<string, unknown>
}

export interface WebhookDelivery {
  id: string
  subscriptionId: string
  eventId: string
  topic: WebhookTopic
  payloadVersion: string
  minimizedPayload: MinimizedWebhookEnvelope
  status: WebhookDeliveryStatus
  attempts: number
  maxAttempts: number
  nextAttemptAt: string
  deliveredAt?: string | null
  lastHttpStatus?: number | null
  lastError?: string | null
  version: number
  createdAt: string
  updatedAt: string
}

export interface WebhookDeliveryLog {
  id: string
  deliveryId: string
  attemptNumber: number
  targetUrl: string
  httpStatus: number
  latencyMs: number
  errorMessage?: string | null
  requestHeaders: Record<string, string>
  responseSnippet?: string | null
  createdAt: string
}

/**
 * Firma un payload de webhook saliente con HMAC SHA-256.
 */
export function signOutboundWebhook(payloadJson: string, secret: string): string {
  const hash = createHmac('sha256', secret).update(payloadJson, 'utf8').digest('hex')
  return `sha256=${hash}`
}

/**
 * Verifica de forma criptográfica y timing-safe la firma de un webhook saliente,
 * dando soporte a rotación sin caída verificando también el secreto secundario
 * si aún no ha expirado su periodo de gracia.
 */
export function verifyOutboundWebhookSignature(params: {
  payload: string
  signature: string | undefined | null
  primarySecret: string
  secondarySecret?: string | null
  secondarySecretExpiresAt?: string | null
  now?: string
}): boolean {
  if (!params.signature || !params.signature.startsWith('sha256=')) return false

  const verifyWithKey = (key: string): boolean => {
    try {
      const expected = signOutboundWebhook(params.payload, key)
      const actualBuffer = Buffer.from(params.signature!.slice(7), 'hex')
      const expectedBuffer = Buffer.from(expected.slice(7), 'hex')
      return actualBuffer.byteLength === expectedBuffer.byteLength && timingSafeEqual(actualBuffer, expectedBuffer)
    } catch {
      return false
    }
  }

  // 1. Probar con secreto primario actual
  if (verifyWithKey(params.primarySecret)) return true

  // 2. Si no coincide, comprobar si existe un secreto secundario vigente durante la rotación
  if (params.secondarySecret && params.secondarySecretExpiresAt) {
    const currentInstant = Date.parse(params.now ?? new Date().toISOString())
    const expiresInstant = Date.parse(params.secondarySecretExpiresAt)
    if (Number.isFinite(expiresInstant) && currentInstant <= expiresInstant) {
      if (verifyWithKey(params.secondarySecret)) return true
    }
  }

  return false
}

/**
 * Construye un payload minimizado según el evento, sin exponer PII no esencial,
 * tarjetas de pago ni claves internas.
 */
export function buildMinimizedWebhookPayload(
  topic: WebhookTopic,
  data: Record<string, unknown>,
  version: 'v1' | '2026-10-01' = 'v1',
  now: string = new Date().toISOString()
): MinimizedWebhookEnvelope {
  const envelopeId = (data.orderId as string) || (data.id as string) || `evt-${Date.now()}`

  let sanitizedData: Record<string, unknown>

  switch (topic) {
    case 'order.created':
    case 'order.paid':
    case 'order.fulfilled':
    case 'order.cancelled': {
      sanitizedData = {
        order_id: data.orderId || data.id,
        status: data.status,
        total_cents: data.totalCents || data.totalGrossCents,
        currency: data.currency || 'EUR',
        lines_count: data.linesCount || (Array.isArray(data.lines) ? data.lines.length : undefined)
      }
      break
    }
    case 'invoice.issued': {
      sanitizedData = {
        invoice_id: data.invoiceId || data.id,
        order_id: data.orderId,
        invoice_code: data.code || data.invoiceCode,
        amount_cents: data.amountCents || data.totalCents,
        currency: data.currency || 'EUR'
      }
      break
    }
    case 'inventory.low': {
      sanitizedData = {
        variant_id: data.variantId || data.id,
        sku: data.sku,
        available_quantity: data.availableQuantity || data.quantity
      }
      break
    }
    case 'test.ping':
    default: {
      sanitizedData = {
        message: 'Neteco outbound webhook connection test',
        ping_timestamp: now
      }
      break
    }
  }

  return {
    id: String(envelopeId),
    event: topic,
    version,
    occurred_at: now,
    data: sanitizedData
  }
}

/**
 * Calcula el backoff exponencial en segundos para reintentos.
 * Intento 1: 60s (1m)
 * Intento 2: 300s (5m)
 * Intento 3: 1800s (30m)
 * Intento 4: 7200s (2h)
 * Intento 5: 28800s (8h)
 */
export function calculateWebhookBackoff(attempt: number): number {
  switch (attempt) {
    case 1:
      return 60
    case 2:
      return 300
    case 3:
      return 1800
    case 4:
      return 7200
    default:
      return 28800
  }
}

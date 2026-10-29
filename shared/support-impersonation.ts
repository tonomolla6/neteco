import { z } from 'zod'
import { catalogPolicyInstantSchema, catalogPolicyUuidSchema } from './catalog-publication-policy'

export const IMPERSONATION_DEFAULT_MINUTES = 10
export const IMPERSONATION_MAX_MINUTES = 15
export const impersonationStartSchema = z
  .object({
    customerId: catalogPolicyUuidSchema,
    ticketRef: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{2,39}$/),
    reason: z.string().trim().min(10).max(300),
    minutes: z.number().int().min(1).max(IMPERSONATION_MAX_MINUTES).default(IMPERSONATION_DEFAULT_MINUTES)
  })
  .strict()
export const impersonationActionInputSchema = z
  .object({
    action: z.string().regex(/^[a-z][a-z0-9_.]{0,59}$/),
    resource: z.string().min(1).max(120).optional()
  })
  .strict()
const ALLOWED = new Set([
  'view_account',
  'view_orders',
  'view_order',
  'view_addresses',
  'view_preferences',
  'view_support_tickets',
  'view_invoices',
  'reply_support_ticket',
  'add_internal_note'
])
const CREDENTIALS = new Set([
  'change_password',
  'reset_password',
  'change_email',
  'reset_mfa',
  'disable_mfa',
  'enroll_mfa',
  'create_api_token',
  'view_session_tokens',
  'change_credentials'
])
const PAYMENTS = new Set([
  'view_payment_method',
  'add_payment_method',
  'remove_payment_method',
  'view_card_data',
  'pay_order',
  'capture_payment',
  'refund_payment',
  'change_bank_details'
])
export type ImpersonationBlockReason = 'sensitive_credentials' | 'sensitive_payment' | 'not_permitted'
/** Allow-list: credentials and payments are never reachable, and unknown actions are denied. */
export function classifyImpersonatedAction(
  action: string
): { outcome: 'allowed' } | { outcome: 'blocked'; reason: ImpersonationBlockReason } {
  if (CREDENTIALS.has(action)) return { outcome: 'blocked', reason: 'sensitive_credentials' }
  if (PAYMENTS.has(action)) return { outcome: 'blocked', reason: 'sensitive_payment' }
  return ALLOWED.has(action) ? { outcome: 'allowed' } : { outcome: 'blocked', reason: 'not_permitted' }
}
export const impersonationSessionSchema = z
  .object({
    source: z.literal('cloudflare'),
    id: catalogPolicyUuidSchema,
    actorId: catalogPolicyUuidSchema,
    customerId: catalogPolicyUuidSchema,
    customerName: z.string().nullable(),
    ticketRef: z.string(),
    reason: z.string(),
    startedAt: catalogPolicyInstantSchema,
    expiresAt: catalogPolicyInstantSchema,
    endedAt: catalogPolicyInstantSchema.nullable(),
    status: z.enum(['active', 'ended', 'expired']),
    remainingSeconds: z
      .number()
      .int()
      .min(0)
      .max(IMPERSONATION_MAX_MINUTES * 60),
    banner: z.string()
  })
  .strict()
export const impersonationActionResultSchema = z
  .object({
    source: z.literal('cloudflare'),
    sessionId: catalogPolicyUuidSchema,
    seq: z.number().int().min(1),
    action: z.string(),
    resource: z.string().nullable(),
    outcome: z.enum(['allowed', 'blocked']),
    reason: z.enum(['sensitive_credentials', 'sensitive_payment', 'not_permitted', 'session_inactive']).nullable(),
    recordedAt: catalogPolicyInstantSchema
  })
  .strict()
export const impersonationLogSchema = z
  .object({
    source: z.literal('cloudflare'),
    session: impersonationSessionSchema,
    actions: z.array(impersonationActionResultSchema.omit({ sessionId: true, source: true })).max(2000)
  })
  .strict()
export type ImpersonationSession = z.infer<typeof impersonationSessionSchema>
export type ImpersonationActionResult = z.infer<typeof impersonationActionResultSchema>
export function impersonationBanner(customerName: string | null, ticketRef: string) {
  return `Suplantación de soporte activa: actúas como ${customerName ?? 'el cliente'} (ticket ${ticketRef}). Cada acción queda registrada; no se permiten cambios de credenciales ni pagos.`
}

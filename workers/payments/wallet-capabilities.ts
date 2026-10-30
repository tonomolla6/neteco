import { z } from 'zod'

/** Trusted configuration evidence, never data supplied by the checkout client. */
const instant = z.string().refine((value) => {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)) return false
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) && new Date(parsed).toISOString().replace('.000Z', 'Z') === value
})
const origin = z
  .string()
  .max(255)
  .refine((value) => {
    try {
      const url = new URL(value)
      return url.protocol === 'https:' && url.origin === value && !url.username && !url.password
    } catch {
      return false
    }
  })
const terminal = z.string().regex(/^\d{3}$/)
const environment = z.enum(['sandbox', 'production'])
const evidenceSchema = z
  .object({
    method: z.enum(['apple_pay', 'google_pay']),
    approved: z.literal(true),
    bankSupported: z.literal(true),
    domainVerified: z.literal(true),
    terminalEnabled: z.literal(true),
    origin,
    terminal,
    environment,
    validUntil: instant,
    /** Bank-assigned Redsys DS_MERCHANT_PAYMETHODS code from the approval, if the TPV requires one. */
    payMethod: z
      .string()
      .regex(/^[A-Za-z0-9]{1,10}$/)
      .optional()
  })
  .strict()
const contextSchema = z.object({ origin, terminal, environment, now: instant }).strict()

export type WalletResolution =
  { method: 'redirect' } | { method: 'apple_pay' | 'google_pay'; fallback: 'redirect'; payMethod?: string }

/** Decision only. A separate, approved provider adapter must perform the payment. */
export function resolveWalletPayment(input: {
  method: unknown
  evidence: unknown
  deviceAvailable: unknown
  origin: unknown
  terminal: unknown
  environment: unknown
  now: unknown
}): WalletResolution {
  if ((input.method !== 'apple_pay' && input.method !== 'google_pay') || input.deviceAvailable !== true)
    return { method: 'redirect' }
  const context = contextSchema.safeParse({
    origin: input.origin,
    terminal: input.terminal,
    environment: input.environment,
    now: input.now
  })
  const evidence = evidenceSchema.safeParse(input.evidence)
  if (!context.success || !evidence.success) return { method: 'redirect' }
  if (
    evidence.data.method !== input.method ||
    evidence.data.origin !== context.data.origin ||
    evidence.data.terminal !== context.data.terminal ||
    evidence.data.environment !== context.data.environment ||
    evidence.data.validUntil <= context.data.now
  )
    return { method: 'redirect' }
  return {
    method: input.method,
    fallback: 'redirect',
    ...(evidence.data.payMethod ? { payMethod: evidence.data.payMethod } : {})
  }
}

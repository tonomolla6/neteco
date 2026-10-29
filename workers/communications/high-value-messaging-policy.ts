import { z } from 'zod'

// This policy consumes trusted, freshly read facts. It neither grants consent nor sends messages.
const instant = z
  .string()
  .regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/)
  .refine((value) => {
    const epoch = Date.parse(value)
    return Number.isFinite(epoch) && new Date(epoch).toISOString() === value.replace('Z', '.000Z')
  })
const common = {
  event: z.enum(['recall', 'delivery_exception', 'security_alert']),
  consent: z.boolean(),
  optedOut: z.boolean(),
  costMinor: z.number().int().nonnegative().max(1000000),
  budgetMinor: z.number().int().nonnegative().max(1000000),
  fallback: z.enum(['email', 'manual']),
  now: instant
}
const inputSchema = z.discriminatedUnion('channel', [
  z.object({ ...common, channel: z.literal('sms') }).strict(),
  z
    .object({
      ...common,
      channel: z.literal('whatsapp'),
      provider: z.enum(['official', 'unofficial']),
      template: z
        .object({ id: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/), event: common.event, approved: z.boolean() })
        .strict()
        .nullable(),
      lastInboundAt: instant.nullable(),
      handoffRequested: z.boolean()
    })
    .strict()
])
const messages = {
  recall: 'NETECO: Hay un aviso importante sobre un producto. Contacte con nuestro servicio de atención.',
  delivery_exception:
    'NETECO: Hay una incidencia importante con una entrega. Contacte con nuestro servicio de atención.',
  security_alert: 'NETECO: Hay un aviso de seguridad. Contacte con nuestro servicio de atención.'
} as const

export function evaluateHighValueMessage(raw: unknown) {
  const parsed = inputSchema.safeParse(raw)
  if (!parsed.success) throw new Error('invalid_input')
  const input = parsed.data
  const fallback = (reason: string, channel: 'email' | 'manual' = input.fallback) => ({
    outcome: 'fallback' as const,
    reason,
    channel
  })
  if (input.optedOut) return fallback('opted_out')
  if (!input.consent) return fallback('consent_required')
  if (input.channel === 'whatsapp' && input.handoffRequested) return fallback('human_handoff', 'manual')
  if (input.costMinor > input.budgetMinor) return fallback('budget_exceeded')
  const text = messages[input.event]
  if (input.channel === 'sms') return { outcome: 'send' as const, costMinor: input.costMinor, text }
  if (input.provider !== 'official') return fallback('provider_not_official')
  const elapsed = input.lastInboundAt === null ? Infinity : Date.parse(input.now) - Date.parse(input.lastInboundAt)
  if (elapsed >= 0 && elapsed < 24 * 60 * 60 * 1000)
    return { outcome: 'send' as const, costMinor: input.costMinor, text, mode: 'session' as const }
  if (!input.template?.approved || input.template.event !== input.event) return fallback('template_required')
  return {
    outcome: 'send' as const,
    costMinor: input.costMinor,
    text,
    mode: 'template' as const,
    templateId: input.template.id
  }
}

import { z } from 'zod'

export const SUPPORT_CHAT_DISCLAIMER =
  'Atención al cliente exclusivamente humana por el equipo de Neteco. No utilizamos bots simulando ser personas.'

export const supportChatDepartmentSchema = z.enum(['general', 'technical', 'logistics', 'sales', 'billing'])
export type SupportChatDepartment = z.infer<typeof supportChatDepartmentSchema>

export const supportChatSessionStatusSchema = z.enum([
  'waiting_operator',
  'in_progress',
  'transferred',
  'resolved',
  'closed',
  'escalated_ticket',
  'expired_inactivity'
])
export type SupportChatSessionStatus = z.infer<typeof supportChatSessionStatusSchema>

export const supportChatContextSchema = z
  .object({
    url: z.string().max(500).optional(),
    productSlug: z.string().max(120).optional(),
    categorySlug: z.string().max(120).optional(),
    orderReference: z.string().max(60).optional(),
    subject: z.string().max(200).optional()
  })
  .strict()
export type SupportChatContext = z.infer<typeof supportChatContextSchema>

export const supportChatCreateInputSchema = z
  .object({
    consentGiven: z.literal(true),
    consentPolicyHash: z.string().regex(/^[a-f0-9]{64}$/),
    department: supportChatDepartmentSchema,
    customerName: z.string().min(1).max(120).optional(),
    initialMessage: z.string().min(1).max(2000).optional(),
    context: supportChatContextSchema.optional(),
    now: z.string().datetime().optional()
  })
  .strict()
export type SupportChatCreateInput = z.infer<typeof supportChatCreateInputSchema>

export const supportChatMessageInputSchema = z
  .object({
    message: z.string().min(1).max(2000),
    now: z.string().datetime().optional()
  })
  .strict()
export type SupportChatMessageInput = z.infer<typeof supportChatMessageInputSchema>

export const supportChatClaimInputSchema = z
  .object({
    expectedVersion: z.number().int().min(1),
    operatorName: z.string().min(1).max(120),
    now: z.string().datetime().optional()
  })
  .strict()
export type SupportChatClaimInput = z.infer<typeof supportChatClaimInputSchema>

export const supportChatHandoffInputSchema = z
  .object({
    expectedVersion: z.number().int().min(1),
    targetDepartment: supportChatDepartmentSchema.optional(),
    targetOperatorId: z.string().uuid().optional(),
    note: z.string().min(3).max(1000),
    now: z.string().datetime().optional()
  })
  .strict()
export type SupportChatHandoffInput = z.infer<typeof supportChatHandoffInputSchema>

export const supportChatEscalateInputSchema = z
  .object({
    expectedVersion: z.number().int().min(1),
    category: z.enum(['product', 'order', 'shipping', 'payment', 'invoice', 'return', 'account', 'other']).optional(),
    priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
    summary: z.string().min(5).max(1000),
    now: z.string().datetime().optional()
  })
  .strict()
export type SupportChatEscalateInput = z.infer<typeof supportChatEscalateInputSchema>

export const supportChatCloseInputSchema = z
  .object({
    expectedVersion: z.number().int().min(1),
    closureReason: z.string().min(3).max(100),
    resolutionSummary: z.string().max(2000).optional(),
    now: z.string().datetime().optional()
  })
  .strict()
export type SupportChatCloseInput = z.infer<typeof supportChatCloseInputSchema>

export interface SupportChatAvailability {
  isOpen: boolean
  schedule: string
  timezone: string
  currentUtc: string
  nextOpeningAt?: string
  disclaimer: string
  queue: {
    length: number
    estimatedWaitSeconds: number
  }
}

export function isSupportChatOperatingHours(instantStr?: string): {
  isOpen: boolean
  schedule: string
  timezone: string
  currentUtc: string
  nextOpeningAt?: string
} {
  const d = instantStr ? new Date(instantStr) : new Date()
  const currentUtc = d.toISOString()
  const timezone = 'Europe/Madrid'
  const schedule = 'Lunes a Viernes de 08:00 a 18:00 (hora peninsular española)'

  // Use Intl.DateTimeFormat to inspect Europe/Madrid weekday and hour
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    hour: 'numeric',
    minute: 'numeric',
    hourCycle: 'h23'
  })
  const parts = formatter.formatToParts(d)
  const weekday = parts.find((p) => p.type === 'weekday')?.value // 'Mon', 'Tue', etc.
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0)

  const isWeekday = weekday !== 'Sat' && weekday !== 'Sun'
  const isBusinessHour = hour >= 8 && hour < 18

  const isOpen = Boolean(isWeekday && isBusinessHour)

  let nextOpeningAt: string | undefined
  if (!isOpen) {
    // Deterministic calculation for next opening
    const next = new Date(d)
    if (weekday === 'Sat') {
      next.setDate(next.getDate() + 2)
    } else if (weekday === 'Sun') {
      next.setDate(next.getDate() + 1)
    } else if (hour >= 18) {
      if (weekday === 'Fri') {
        next.setDate(next.getDate() + 3)
      } else {
        next.setDate(next.getDate() + 1)
      }
    }
    next.setUTCHours(7, 0, 0, 0) // Roughly 08:00 or 09:00 Madrid
    nextOpeningAt = next.toISOString()
  }

  return {
    isOpen,
    schedule,
    timezone,
    currentUtc,
    nextOpeningAt
  }
}

export function estimateWaitSeconds(queuePosition: number): number {
  if (queuePosition <= 0) return 60
  return Math.min(queuePosition * 120, 3600)
}

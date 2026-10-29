import { z } from 'zod'

export const customerSlaTierSchema = z.enum(['standard', 'priority', 'vip', 'custom'])
export type CustomerSlaTier = z.infer<typeof customerSlaTierSchema>

export const calendarChannelSchema = z.enum(['phone', 'video', 'in_person'])
export type CalendarChannel = z.infer<typeof calendarChannelSchema>

export const calendarStatusSchema = z.enum(['scheduled', 'confirmed', 'completed', 'cancelled', 'rescheduled'])
export type CalendarStatus = z.infer<typeof calendarStatusSchema>

export const opportunityStageSchema = z.enum(['lead', 'qualified', 'proposal', 'negotiation', 'won', 'lost'])
export type OpportunityStage = z.infer<typeof opportunityStageSchema>

export const noteCategorySchema = z.enum(['commercial', 'credit', 'logistics', 'operations', 'general'])
export type NoteCategory = z.infer<typeof noteCategorySchema>

export const noteConfidentialitySchema = z.enum(['internal_sales', 'admin_only'])
export type NoteConfidentiality = z.infer<typeof noteConfidentialitySchema>

export const accountManagerAssignInputSchema = z
  .object({
    managerIdentityId: z.string().uuid(),
    managerName: z.string().min(2).max(120),
    managerEmail: z.string().email().max(160),
    managerPhone: z.string().max(40).optional(),
    availabilitySchedule: z.string().min(3).max(200),
    slaTier: customerSlaTierSchema,
    slaResponseHours: z.number().int().min(1).max(168),
    slaDescription: z.string().max(500).optional(),
    reason: z.string().min(5).max(500),
    now: z.string().datetime().optional()
  })
  .strict()
export type AccountManagerAssignInput = z.infer<typeof accountManagerAssignInputSchema>

export const commercialNoteCreateInputSchema = z
  .object({
    category: noteCategorySchema,
    confidentiality: noteConfidentialitySchema,
    title: z.string().min(3).max(200),
    content: z.string().min(3).max(4000),
    now: z.string().datetime().optional()
  })
  .strict()
export type CommercialNoteCreateInput = z.infer<typeof commercialNoteCreateInputSchema>

export const opportunityCreateInputSchema = z
  .object({
    title: z.string().min(3).max(200),
    estimatedValueCents: z.number().int().min(0).max(100_000_000_00), // Max 100M EUR
    stage: opportunityStageSchema,
    probabilityPercent: z.number().int().min(0).max(100),
    expectedCloseDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    assignedManagerId: z.string().uuid().optional(),
    notes: z.string().max(2000).optional(),
    now: z.string().datetime().optional()
  })
  .strict()
export type OpportunityCreateInput = z.infer<typeof opportunityCreateInputSchema>

export const opportunityUpdateStageInputSchema = z
  .object({
    expectedVersion: z.number().int().min(1),
    stage: opportunityStageSchema,
    probabilityPercent: z.number().int().min(0).max(100).optional(),
    notes: z.string().max(2000).optional(),
    reason: z.string().min(5).max(500),
    now: z.string().datetime().optional()
  })
  .strict()
export type OpportunityUpdateStageInput = z.infer<typeof opportunityUpdateStageInputSchema>

export const calendarEventScheduleInputSchema = z
  .object({
    managerIdentityId: z.string().uuid(),
    subject: z.string().min(3).max(200),
    scheduledAt: z.string().datetime(),
    durationMinutes: z.number().int().min(5).max(480),
    channel: calendarChannelSchema,
    customerConsentVerified: z.literal(true),
    consentReference: z.string().min(3).max(500).optional(),
    notes: z.string().max(2000).optional(),
    now: z.string().datetime().optional()
  })
  .strict()
export type CalendarEventScheduleInput = z.infer<typeof calendarEventScheduleInputSchema>

export const calendarEventUpdateStatusInputSchema = z
  .object({
    status: calendarStatusSchema,
    notes: z.string().max(2000).optional(),
    now: z.string().datetime().optional()
  })
  .strict()
export type CalendarEventUpdateStatusInput = z.infer<typeof calendarEventUpdateStatusInputSchema>

export const GENERAL_SUPPORT_INFO = {
  email: 'soporte@neteco.es',
  phone: '+34 962 000 000',
  hours: 'L-V 08:00 - 18:00'
}

export interface CustomerVisibleAccountManager {
  hasAssignedManager: boolean
  manager?: {
    name: string
    email: string
    phone: string | null
    availabilitySchedule: string
    slaTier: CustomerSlaTier
    slaResponseHours: number
    slaDescription?: string
  }
  generalSupport: {
    email: string
    phone: string
    hours: string
  }
}

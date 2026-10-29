import { z } from 'zod'

export const EVENT_TYPES = ['webinar', 'demo', 'local_event'] as const
export type EventType = (typeof EVENT_TYPES)[number]

export const EVENT_SECTORS = [
  'hosteleria',
  'automocion',
  'sanitario',
  'industrial',
  'oficinas',
  'colectividades',
  'general'
] as const
export type EventSector = (typeof EVENT_SECTORS)[number]

export const EVENT_STATUSES = ['scheduled', 'live', 'completed', 'cancelled'] as const
export type EventStatus = (typeof EVENT_STATUSES)[number]

export interface EventItemView {
  id: string
  slug: string
  title: string
  description: string
  type: EventType
  sector: EventSector
  locationType: 'online' | 'in_person'
  locationDetails: string
  scheduledAt: string
  durationMinutes: number
  maxAttendees: number
  currentAttendeesCount: number
  status: EventStatus
  recordingUrl: string | null
  subtitlesUrl: string | null
  recordingDurationSeconds: number | null
  recordingPublishedAt: string | null
  version: number
  createdAt: string
  updatedAt: string
}

export interface EventRegistrationView {
  id: string
  eventId: string
  customerId: string | null
  attendeeName: string
  attendeeEmail: string
  attendeePhone: string | null
  consentEmailReminder: boolean
  consentSmsReminder: boolean
  consentFollowup: boolean
  consentTermsVersion: string
  consentedAt: string
  attendanceStatus: 'registered' | 'attended' | 'no_show' | 'cancelled'
  createdAt: string
}

export interface EventQuestionView {
  id: string
  eventId: string
  customerId: string | null
  authorName: string
  questionText: string
  answerText: string | null
  answeredBy: string | null
  answeredAt: string | null
  isPublic: boolean
  createdAt: string
}

export interface EventReminderView {
  id: string
  eventId: string
  registrationId: string
  channel: 'email' | 'sms'
  triggerType: '24h_before' | '1h_before' | 'starting_now'
  status: 'dispatched' | 'suppressed_no_consent' | 'skipped'
  dispatchedAt: string
  createdAt: string
}

export interface EventFollowupView {
  id: string
  eventId: string
  registrationId: string
  channel: 'email'
  summaryNotes: string
  recordingIncluded: boolean
  technicalSheetsIncluded: boolean
  status: 'dispatched' | 'suppressed_no_consent'
  dispatchedAt: string
  createdAt: string
}

export const eventCreateSchema = z.object({
  commandId: z.string().uuid(),
  idempotencyKey: z.string().min(8).max(128),
  slug: z
    .string()
    .min(2)
    .max(100)
    .regex(/^[a-z0-9_-]+$/),
  title: z.string().min(3).max(200),
  description: z.string().min(3).max(2000),
  type: z.enum(EVENT_TYPES),
  sector: z.enum(EVENT_SECTORS),
  locationType: z.enum(['online', 'in_person']),
  locationDetails: z.string().min(3).max(500),
  scheduledAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/),
  durationMinutes: z.number().int().min(15).max(480),
  maxAttendees: z.number().int().min(1).max(1000)
})

export const eventUpdateSchema = z.object({
  commandId: z.string().uuid(),
  idempotencyKey: z.string().min(8).max(128),
  eventId: z.string().uuid(),
  expectedVersion: z.number().int().min(0),
  title: z.string().min(3).max(200).optional(),
  description: z.string().min(3).max(2000).optional(),
  locationDetails: z.string().min(3).max(500).optional(),
  scheduledAt: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
    .optional(),
  durationMinutes: z.number().int().min(15).max(480).optional(),
  maxAttendees: z.number().int().min(1).max(1000).optional(),
  status: z.enum(EVENT_STATUSES).optional()
})

export const eventRegistrationSchema = z.object({
  commandId: z.string().uuid(),
  idempotencyKey: z.string().min(8).max(128),
  eventId: z.string().uuid(),
  attendeeName: z.string().min(2).max(100),
  attendeeEmail: z.string().email().max(150),
  attendeePhone: z.string().min(5).max(30).optional(),
  consentEmailReminder: z.boolean(),
  consentSmsReminder: z.boolean(),
  consentFollowup: z.boolean(),
  consentTermsVersion: z.string().min(1).max(32)
})

export const eventQuestionSchema = z.object({
  commandId: z.string().uuid(),
  idempotencyKey: z.string().min(8).max(128),
  authorName: z.string().min(2).max(100),
  questionText: z.string().min(5).max(1000)
})

export const eventAnswerQuestionSchema = z.object({
  commandId: z.string().uuid(),
  idempotencyKey: z.string().min(8).max(128),
  questionId: z.string().uuid(),
  answerText: z.string().min(1).max(2000)
})

export const eventPublishRecordingSchema = z.object({
  commandId: z.string().uuid(),
  idempotencyKey: z.string().min(8).max(128),
  eventId: z.string().uuid(),
  expectedVersion: z.number().int().min(0),
  recordingUrl: z.string().url().max(1000),
  subtitlesUrl: z.string().url().max(1000).optional(),
  recordingDurationSeconds: z.number().int().positive().optional()
})

export const eventFollowupSchema = z.object({
  commandId: z.string().uuid(),
  idempotencyKey: z.string().min(8).max(128),
  eventId: z.string().uuid(),
  summaryNotes: z.string().min(5).max(2000),
  technicalSheetsIncluded: z.boolean().default(true)
})

export function canRegisterForEvent(
  maxAttendees: number,
  currentAttendeesCount: number,
  eventStatus: string
): { allowed: boolean; reason?: string } {
  if (eventStatus !== 'scheduled' && eventStatus !== 'live') {
    return { allowed: false, reason: 'event_not_open_for_registration' }
  }
  if (currentAttendeesCount >= maxAttendees) {
    return { allowed: false, reason: 'event_capacity_reached' }
  }
  return { allowed: true }
}

export function determineReminderEligibility(
  registration: { consentEmailReminder: boolean; consentSmsReminder: boolean },
  channel: 'email' | 'sms'
): { eligible: boolean; status: 'dispatched' | 'suppressed_no_consent' } {
  if (channel === 'email') {
    return {
      eligible: registration.consentEmailReminder,
      status: registration.consentEmailReminder ? 'dispatched' : 'suppressed_no_consent'
    }
  }
  return {
    eligible: registration.consentSmsReminder,
    status: registration.consentSmsReminder ? 'dispatched' : 'suppressed_no_consent'
  }
}

export function determineFollowupEligibility(registration: { consentFollowup: boolean }): {
  eligible: boolean
  status: 'dispatched' | 'suppressed_no_consent'
} {
  return {
    eligible: registration.consentFollowup,
    status: registration.consentFollowup ? 'dispatched' : 'suppressed_no_consent'
  }
}

function canonicalizeJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map((element) => canonicalizeJson(element)).join(',')}]`
  }
  const keys = Object.keys(value as Record<string, unknown>).sort()
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${canonicalizeJson((value as Record<string, unknown>)[key])}`)
    .join(',')}}`
}

export async function eventIntentHash(payload: unknown): Promise<string> {
  const text = canonicalizeJson(payload)
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

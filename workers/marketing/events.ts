import { authorizeD1Session, type VerifiedSessionClaims } from '../catalog/authorization'
import {
  type EventFollowupView,
  type EventItemView,
  type EventQuestionView,
  type EventRegistrationView,
  type EventReminderView,
  type EventSector,
  type EventStatus,
  type EventType,
  canRegisterForEvent,
  determineFollowupEligibility,
  determineReminderEligibility,
  eventAnswerQuestionSchema,
  eventCreateSchema,
  eventFollowupSchema,
  eventIntentHash,
  eventPublishRecordingSchema,
  eventQuestionSchema,
  eventRegistrationSchema,
  eventUpdateSchema
} from '../../shared/events'

export class EventError extends Error {
  constructor(
    readonly code:
      | 'invalid_input'
      | 'unauthenticated'
      | 'forbidden'
      | 'not_found'
      | 'conflict'
      | 'version_conflict'
      | 'event_full'
      | 'event_not_open'
      | 'already_registered'
  ) {
    super(code)
    this.name = 'EventError'
  }
}

function fail(code: EventError['code']): never {
  throw new EventError(code)
}

function resolveNow(now?: string | (() => string)): string {
  if (typeof now === 'function') return now()
  if (now) return now
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
}

export async function createD1Event(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  input: {
    commandId: string
    idempotencyKey: string
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
    now?: string
  }
): Promise<EventItemView> {
  const now = resolveNow(input.now)
  if (!claims?.identityId) fail('unauthenticated')

  const auth = await authorizeD1Session(db, claims, 'administration.manage', { now })
  if (!auth.allowed) fail('forbidden')

  const parsed = eventCreateSchema.safeParse(input)
  if (!parsed.success) fail('invalid_input')

  // Check idempotency replay
  const existingCommand = await db
    .prepare(`SELECT receipt_json FROM event_commands WHERE actor_id = ? AND idempotency_key = ?`)
    .bind(claims.identityId, input.idempotencyKey)
    .first<{ receipt_json: string }>()

  if (existingCommand?.receipt_json) {
    return JSON.parse(existingCommand.receipt_json) as EventItemView
  }

  // Check existing slug
  const existingEvent = await db
    .prepare(`SELECT id FROM events WHERE slug = ?`)
    .bind(input.slug)
    .first<{ id: string }>()

  if (existingEvent) fail('conflict')

  const eventId = input.commandId
  const payloadHash = await eventIntentHash({
    action: 'create_event',
    slug: input.slug,
    title: input.title,
    scheduledAt: input.scheduledAt
  })

  const eventRecord: EventItemView = {
    id: eventId,
    slug: input.slug,
    title: input.title,
    description: input.description,
    type: input.type,
    sector: input.sector,
    locationType: input.locationType,
    locationDetails: input.locationDetails,
    scheduledAt: input.scheduledAt,
    durationMinutes: input.durationMinutes,
    maxAttendees: input.maxAttendees,
    currentAttendeesCount: 0,
    status: 'scheduled',
    recordingUrl: null,
    subtitlesUrl: null,
    recordingDurationSeconds: null,
    recordingPublishedAt: null,
    version: 1,
    createdAt: now,
    updatedAt: now
  }

  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO events (
          id, slug, title, description, type, sector, location_type, location_details,
          scheduled_at, duration_minutes, max_attendees, status, version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', 1, ?, ?)`
      )
      .bind(
        eventId,
        input.slug,
        input.title,
        input.description,
        input.type,
        input.sector,
        input.locationType,
        input.locationDetails,
        input.scheduledAt,
        input.durationMinutes,
        input.maxAttendees,
        now,
        now
      ),
    db
      .prepare(
        `INSERT INTO event_commands (
          command_id, actor_id, action, idempotency_key, expected_version,
          applied_version, payload_hash, input_json, receipt_json, created_at
        ) VALUES (?, ?, 'create_event', ?, 0, 1, ?, ?, ?, ?)`
      )
      .bind(
        input.commandId,
        claims.identityId,
        input.idempotencyKey,
        payloadHash,
        JSON.stringify(input),
        JSON.stringify(eventRecord),
        now
      )
  ]

  await db.batch(statements)
  return eventRecord
}

export async function updateD1Event(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  input: {
    commandId: string
    idempotencyKey: string
    eventId: string
    expectedVersion: number
    title?: string
    description?: string
    locationDetails?: string
    scheduledAt?: string
    durationMinutes?: number
    maxAttendees?: number
    status?: EventStatus
    now?: string
  }
): Promise<EventItemView> {
  const now = resolveNow(input.now)
  if (!claims?.identityId) fail('unauthenticated')

  const auth = await authorizeD1Session(db, claims, 'administration.manage', { now })
  if (!auth.allowed) fail('forbidden')

  const parsed = eventUpdateSchema.safeParse(input)
  if (!parsed.success) fail('invalid_input')

  const current = await db
    .prepare(`SELECT * FROM events WHERE id = ?`)
    .bind(input.eventId)
    .first<Record<string, unknown>>()

  if (!current) fail('not_found')
  if ((current.version as number) !== input.expectedVersion) fail('version_conflict')

  const nextVersion = (current.version as number) + 1
  const title = input.title ?? (current.title as string)
  const description = input.description ?? (current.description as string)
  const locationDetails = input.locationDetails ?? (current.location_details as string)
  const scheduledAt = input.scheduledAt ?? (current.scheduled_at as string)
  const durationMinutes = input.durationMinutes ?? (current.duration_minutes as number)
  const maxAttendees = input.maxAttendees ?? (current.max_attendees as number)
  const status = input.status ?? (current.status as EventStatus)

  const payloadHash = await eventIntentHash({
    action: 'update_event',
    eventId: input.eventId,
    expectedVersion: input.expectedVersion,
    input
  })

  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `UPDATE events SET
          title = ?, description = ?, location_details = ?,
          scheduled_at = ?, duration_minutes = ?, max_attendees = ?,
          status = ?, version = ?, updated_at = ?
        WHERE id = ? AND version = ?`
      )
      .bind(
        title,
        description,
        locationDetails,
        scheduledAt,
        durationMinutes,
        maxAttendees,
        status,
        nextVersion,
        now,
        input.eventId,
        input.expectedVersion
      ),
    db
      .prepare(
        `INSERT INTO event_commands (
          command_id, actor_id, action, idempotency_key, expected_version,
          applied_version, payload_hash, input_json, receipt_json, created_at
        ) VALUES (?, ?, 'update_event', ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        input.commandId,
        claims.identityId,
        input.idempotencyKey,
        input.expectedVersion,
        nextVersion,
        payloadHash,
        JSON.stringify(input),
        JSON.stringify({ id: input.eventId, version: nextVersion }),
        now
      )
  ]

  await db.batch(statements)

  const updated = await getD1EventBySlug(db, current.slug as string)
  if (!updated) fail('not_found')
  return updated
}

export async function publishD1EventRecording(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  input: {
    commandId: string
    idempotencyKey: string
    eventId: string
    expectedVersion: number
    recordingUrl: string
    subtitlesUrl?: string
    recordingDurationSeconds?: number
    now?: string
  }
): Promise<EventItemView> {
  const now = resolveNow(input.now)
  if (!claims?.identityId) fail('unauthenticated')

  const auth = await authorizeD1Session(db, claims, 'administration.manage', { now })
  if (!auth.allowed) fail('forbidden')

  const parsed = eventPublishRecordingSchema.safeParse(input)
  if (!parsed.success) fail('invalid_input')

  const current = await db
    .prepare(`SELECT * FROM events WHERE id = ?`)
    .bind(input.eventId)
    .first<Record<string, unknown>>()

  if (!current) fail('not_found')
  if ((current.version as number) !== input.expectedVersion) fail('version_conflict')

  const nextVersion = (current.version as number) + 1

  const payloadHash = await eventIntentHash({
    action: 'publish_recording',
    eventId: input.eventId,
    recordingUrl: input.recordingUrl
  })

  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `UPDATE events SET
          recording_url = ?, subtitles_url = ?, recording_duration_seconds = ?,
          recording_published_at = ?, status = 'completed', version = ?, updated_at = ?
        WHERE id = ? AND version = ?`
      )
      .bind(
        input.recordingUrl,
        input.subtitlesUrl ?? null,
        input.recordingDurationSeconds ?? null,
        now,
        nextVersion,
        now,
        input.eventId,
        input.expectedVersion
      ),
    db
      .prepare(
        `INSERT INTO event_commands (
          command_id, actor_id, action, idempotency_key, expected_version,
          applied_version, payload_hash, input_json, receipt_json, created_at
        ) VALUES (?, ?, 'publish_recording', ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        input.commandId,
        claims.identityId,
        input.idempotencyKey,
        input.expectedVersion,
        nextVersion,
        payloadHash,
        JSON.stringify(input),
        JSON.stringify({ recordingUrl: input.recordingUrl }),
        now
      )
  ]

  await db.batch(statements)

  const updated = await getD1EventBySlug(db, current.slug as string)
  if (!updated) fail('not_found')
  return updated
}

export async function getD1EventBySlug(db: D1Database, slug: string): Promise<EventItemView | null> {
  const event = await db
    .prepare(
      `SELECT
        id, slug, title, description, type, sector, location_type, location_details,
        scheduled_at, duration_minutes, max_attendees, status, recording_url,
        subtitles_url, recording_duration_seconds, recording_published_at,
        version, created_at, updated_at
      FROM events
      WHERE slug = ?`
    )
    .bind(slug)
    .first<{
      id: string
      slug: string
      title: string
      description: string
      type: EventType
      sector: EventSector
      location_type: 'online' | 'in_person'
      location_details: string
      scheduled_at: string
      duration_minutes: number
      max_attendees: number
      status: EventStatus
      recording_url: string | null
      subtitles_url: string | null
      recording_duration_seconds: number | null
      recording_published_at: string | null
      version: number
      created_at: string
      updated_at: string
    }>()

  if (!event) return null

  const attendeesCountRow = await db
    .prepare(
      `SELECT count(*) as count FROM event_registrations
       WHERE event_id = ? AND attendance_status <> 'cancelled'`
    )
    .bind(event.id)
    .first<{ count: number }>()

  return {
    id: event.id,
    slug: event.slug,
    title: event.title,
    description: event.description,
    type: event.type,
    sector: event.sector,
    locationType: event.location_type,
    locationDetails: event.location_details,
    scheduledAt: event.scheduled_at,
    durationMinutes: event.duration_minutes,
    maxAttendees: event.max_attendees,
    currentAttendeesCount: attendeesCountRow?.count ?? 0,
    status: event.status,
    recordingUrl: event.recording_url,
    subtitlesUrl: event.subtitles_url,
    recordingDurationSeconds: event.recording_duration_seconds,
    recordingPublishedAt: event.recording_published_at,
    version: event.version,
    createdAt: event.created_at,
    updatedAt: event.updated_at
  }
}

export async function listD1Events(
  db: D1Database,
  filters?: { sector?: string; type?: string; status?: string }
): Promise<{ items: EventItemView[] }> {
  let query = `SELECT slug FROM events WHERE 1=1`
  const bindings: unknown[] = []

  if (filters?.sector) {
    query += ` AND sector = ?`
    bindings.push(filters.sector)
  }
  if (filters?.type) {
    query += ` AND type = ?`
    bindings.push(filters.type)
  }
  if (filters?.status) {
    query += ` AND status = ?`
    bindings.push(filters.status)
  }

  query += ` ORDER BY scheduled_at ASC`

  const rows = await db
    .prepare(query)
    .bind(...bindings)
    .all<{ slug: string }>()

  const items: EventItemView[] = []
  for (const row of rows.results || []) {
    const detail = await getD1EventBySlug(db, row.slug)
    if (detail) items.push(detail)
  }

  return { items }
}

export async function registerD1EventAttendee(
  db: D1Database,
  input: {
    commandId: string
    idempotencyKey: string
    eventId: string
    customerId?: string
    attendeeName: string
    attendeeEmail: string
    attendeePhone?: string
    consentEmailReminder: boolean
    consentSmsReminder: boolean
    consentFollowup: boolean
    consentTermsVersion: string
    now?: string
  }
): Promise<EventRegistrationView> {
  const now = resolveNow(input.now)
  const parsed = eventRegistrationSchema.safeParse(input)
  if (!parsed.success) fail('invalid_input')

  const event = await db
    .prepare(`SELECT * FROM events WHERE id = ?`)
    .bind(input.eventId)
    .first<Record<string, unknown>>()

  if (!event) fail('not_found')

  const attendeesCountRow = await db
    .prepare(
      `SELECT count(*) as count FROM event_registrations
       WHERE event_id = ? AND attendance_status <> 'cancelled'`
    )
    .bind(input.eventId)
    .first<{ count: number }>()

  const capacityCheck = canRegisterForEvent(
    event.max_attendees as number,
    attendeesCountRow?.count ?? 0,
    event.status as string
  )

  if (!capacityCheck.allowed) {
    if (capacityCheck.reason === 'event_capacity_reached') fail('event_full')
    fail('event_not_open')
  }

  const existing = await db
    .prepare(`SELECT id FROM event_registrations WHERE event_id = ? AND attendee_email = ?`)
    .bind(input.eventId, input.attendeeEmail)
    .first<{ id: string }>()

  if (existing) fail('conflict')

  const registrationId = input.commandId
  const registrationRecord: EventRegistrationView = {
    id: registrationId,
    eventId: input.eventId,
    customerId: input.customerId ?? null,
    attendeeName: input.attendeeName,
    attendeeEmail: input.attendeeEmail,
    attendeePhone: input.attendeePhone ?? null,
    consentEmailReminder: input.consentEmailReminder,
    consentSmsReminder: input.consentSmsReminder,
    consentFollowup: input.consentFollowup,
    consentTermsVersion: input.consentTermsVersion,
    consentedAt: now,
    attendanceStatus: 'registered',
    createdAt: now
  }

  const payloadHash = await eventIntentHash({
    action: 'register_attendee',
    eventId: input.eventId,
    attendeeEmail: input.attendeeEmail
  })

  // Find actor identity (or fallback to admin or dummy if guest)
  const actor = await db
    .prepare(`SELECT id FROM identities WHERE email = ? LIMIT 1`)
    .bind(input.attendeeEmail)
    .first<{ id: string }>()

  const adminActor = await db.prepare(`SELECT id FROM identities LIMIT 1`).first<{ id: string }>()

  const actorId = actor?.id ?? adminActor?.id ?? '10000000-0000-4000-8000-000000000001'

  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO event_registrations (
          id, event_id, customer_id, attendee_name, attendee_email, attendee_phone,
          consent_email_reminder, consent_sms_reminder, consent_followup,
          consent_terms_version, consented_at, attendance_status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'registered', ?)`
      )
      .bind(
        registrationId,
        input.eventId,
        input.customerId ?? null,
        input.attendeeName,
        input.attendeeEmail,
        input.attendeePhone ?? null,
        input.consentEmailReminder ? 1 : 0,
        input.consentSmsReminder ? 1 : 0,
        input.consentFollowup ? 1 : 0,
        input.consentTermsVersion,
        now,
        now
      ),
    db
      .prepare(
        `INSERT INTO event_commands (
          command_id, actor_id, action, idempotency_key, expected_version,
          applied_version, payload_hash, input_json, receipt_json, created_at
        ) VALUES (?, ?, 'register_attendee', ?, 0, 1, ?, ?, ?, ?)`
      )
      .bind(
        input.commandId,
        actorId,
        input.idempotencyKey,
        payloadHash,
        JSON.stringify(input),
        JSON.stringify(registrationRecord),
        now
      )
  ]

  await db.batch(statements)
  return registrationRecord
}

export async function dispatchD1EventReminders(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  input: {
    commandId: string
    idempotencyKey: string
    eventId: string
    triggerType: '24h_before' | '1h_before' | 'starting_now'
    now?: string
  }
): Promise<EventReminderView[]> {
  const now = resolveNow(input.now)
  if (!claims?.identityId) fail('unauthenticated')

  const auth = await authorizeD1Session(db, claims, 'administration.manage', { now })
  if (!auth.allowed) fail('forbidden')

  const registrations = await db
    .prepare(
      `SELECT
        id, event_id, consent_email_reminder, consent_sms_reminder
      FROM event_registrations
      WHERE event_id = ? AND attendance_status = 'registered'`
    )
    .bind(input.eventId)
    .all<{
      id: string
      event_id: string
      consent_email_reminder: number
      consent_sms_reminder: number
    }>()

  const dispatched: EventReminderView[] = []

  for (const reg of registrations.results || []) {
    // 1. Email reminder
    const emailElig = determineReminderEligibility(
      {
        consentEmailReminder: reg.consent_email_reminder === 1,
        consentSmsReminder: reg.consent_sms_reminder === 1
      },
      'email'
    )

    const emailReminderId = crypto.randomUUID()
    await db
      .prepare(
        `INSERT OR REPLACE INTO event_reminders (
          id, event_id, registration_id, channel, trigger_type, status, dispatched_at, created_at
        ) VALUES (?, ?, ?, 'email', ?, ?, ?, ?)`
      )
      .bind(emailReminderId, input.eventId, reg.id, input.triggerType, emailElig.status, now, now)
      .run()

    dispatched.push({
      id: emailReminderId,
      eventId: input.eventId,
      registrationId: reg.id,
      channel: 'email',
      triggerType: input.triggerType,
      status: emailElig.status,
      dispatchedAt: now,
      createdAt: now
    })

    // 2. SMS reminder
    const smsElig = determineReminderEligibility(
      {
        consentEmailReminder: reg.consent_email_reminder === 1,
        consentSmsReminder: reg.consent_sms_reminder === 1
      },
      'sms'
    )

    const smsReminderId = crypto.randomUUID()
    await db
      .prepare(
        `INSERT OR REPLACE INTO event_reminders (
          id, event_id, registration_id, channel, trigger_type, status, dispatched_at, created_at
        ) VALUES (?, ?, ?, 'sms', ?, ?, ?, ?)`
      )
      .bind(smsReminderId, input.eventId, reg.id, input.triggerType, smsElig.status, now, now)
      .run()

    dispatched.push({
      id: smsReminderId,
      eventId: input.eventId,
      registrationId: reg.id,
      channel: 'sms',
      triggerType: input.triggerType,
      status: smsElig.status,
      dispatchedAt: now,
      createdAt: now
    })
  }

  return dispatched
}

export async function submitD1EventQuestion(
  db: D1Database,
  input: {
    commandId: string
    idempotencyKey: string
    eventId: string
    customerId?: string
    authorName: string
    questionText: string
    now?: string
  }
): Promise<EventQuestionView> {
  const now = resolveNow(input.now)
  const parsed = eventQuestionSchema.safeParse(input)
  if (!parsed.success) fail('invalid_input')

  const questionId = input.commandId
  const questionRecord: EventQuestionView = {
    id: questionId,
    eventId: input.eventId,
    customerId: input.customerId ?? null,
    authorName: input.authorName,
    questionText: input.questionText,
    answerText: null,
    answeredBy: null,
    answeredAt: null,
    isPublic: true,
    createdAt: now
  }

  await db
    .prepare(
      `INSERT INTO event_questions (
        id, event_id, customer_id, author_name, question_text, answer_text,
        answered_by, answered_at, is_public, created_at
      ) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, 1, ?)`
    )
    .bind(questionId, input.eventId, input.customerId ?? null, input.authorName, input.questionText, now)
    .run()

  return questionRecord
}

export async function answerD1EventQuestion(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  input: {
    commandId: string
    idempotencyKey: string
    questionId: string
    answerText: string
    now?: string
  }
): Promise<EventQuestionView> {
  const now = resolveNow(input.now)
  if (!claims?.identityId) fail('unauthenticated')

  const auth = await authorizeD1Session(db, claims, 'administration.manage', { now })
  if (!auth.allowed) fail('forbidden')

  const parsed = eventAnswerQuestionSchema.safeParse(input)
  if (!parsed.success) fail('invalid_input')

  await db
    .prepare(
      `UPDATE event_questions
       SET answer_text = ?, answered_by = ?, answered_at = ?
       WHERE id = ?`
    )
    .bind(input.answerText, claims.identityId, now, input.questionId)
    .run()

  const updated = await db.prepare(`SELECT * FROM event_questions WHERE id = ?`).bind(input.questionId).first<{
    id: string
    event_id: string
    customer_id: string | null
    author_name: string
    question_text: string
    answer_text: string | null
    answered_by: string | null
    answered_at: string | null
    is_public: number
    created_at: string
  }>()

  if (!updated) fail('not_found')

  return {
    id: updated.id,
    eventId: updated.event_id,
    customerId: updated.customer_id,
    authorName: updated.author_name,
    questionText: updated.question_text,
    answerText: updated.answer_text,
    answeredBy: updated.answered_by,
    answeredAt: updated.answered_at,
    isPublic: updated.is_public === 1,
    createdAt: updated.created_at
  }
}

export async function listD1EventQuestions(
  db: D1Database,
  eventId: string
): Promise<{ questions: EventQuestionView[] }> {
  const rows = await db
    .prepare(
      `SELECT
        id, event_id, customer_id, author_name, question_text, answer_text,
        answered_by, answered_at, is_public, created_at
      FROM event_questions
      WHERE event_id = ? AND is_public = 1
      ORDER BY created_at ASC`
    )
    .bind(eventId)
    .all<{
      id: string
      event_id: string
      customer_id: string | null
      author_name: string
      question_text: string
      answer_text: string | null
      answered_by: string | null
      answered_at: string | null
      is_public: number
      created_at: string
    }>()

  return {
    questions: (rows.results || []).map((q) => ({
      id: q.id,
      eventId: q.event_id,
      customerId: q.customer_id,
      authorName: q.author_name,
      questionText: q.question_text,
      answerText: q.answer_text,
      answeredBy: q.answered_by,
      answeredAt: q.answered_at,
      isPublic: q.is_public === 1,
      createdAt: q.created_at
    }))
  }
}

export async function dispatchD1EventFollowup(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  input: {
    commandId: string
    idempotencyKey: string
    eventId: string
    summaryNotes: string
    technicalSheetsIncluded?: boolean
    now?: string
  }
): Promise<EventFollowupView[]> {
  const now = resolveNow(input.now)
  if (!claims?.identityId) fail('unauthenticated')

  const auth = await authorizeD1Session(db, claims, 'administration.manage', { now })
  if (!auth.allowed) fail('forbidden')

  const parsed = eventFollowupSchema.safeParse(input)
  if (!parsed.success) fail('invalid_input')

  const event = await db
    .prepare(`SELECT recording_url FROM events WHERE id = ?`)
    .bind(input.eventId)
    .first<{ recording_url: string | null }>()

  const hasRecording = Boolean(event?.recording_url)

  const registrations = await db
    .prepare(`SELECT id, consent_followup FROM event_registrations WHERE event_id = ?`)
    .bind(input.eventId)
    .all<{ id: string; consent_followup: number }>()

  const followups: EventFollowupView[] = []

  for (const reg of registrations.results || []) {
    const elig = determineFollowupEligibility({
      consentFollowup: reg.consent_followup === 1
    })

    const followupId = crypto.randomUUID()
    await db
      .prepare(
        `INSERT OR REPLACE INTO event_followups (
          id, event_id, registration_id, channel, summary_notes,
          recording_included, technical_sheets_included, status, dispatched_at, created_at
        ) VALUES (?, ?, ?, 'email', ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        followupId,
        input.eventId,
        reg.id,
        input.summaryNotes,
        hasRecording ? 1 : 0,
        input.technicalSheetsIncluded !== false ? 1 : 0,
        elig.status,
        now,
        now
      )
      .run()

    followups.push({
      id: followupId,
      eventId: input.eventId,
      registrationId: reg.id,
      channel: 'email',
      summaryNotes: input.summaryNotes,
      recordingIncluded: hasRecording,
      technicalSheetsIncluded: input.technicalSheetsIncluded !== false,
      status: elig.status,
      dispatchedAt: now,
      createdAt: now
    })
  }

  return followups
}

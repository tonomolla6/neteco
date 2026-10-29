import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { d1OverSqlite, openMigratedDatabase } from '../support/d1-sqlite'
import { canRegisterForEvent, determineReminderEligibility, determineFollowupEligibility } from '../../shared/events'
import {
  EventError,
  createD1Event,
  getD1EventBySlug,
  listD1Events,
  registerD1EventAttendee,
  dispatchD1EventReminders,
  submitD1EventQuestion,
  answerD1EventQuestion,
  publishD1EventRecording,
  dispatchD1EventFollowup
} from '../../workers/marketing/events'

const NOW = '2026-10-29T12:00:00Z'
const FUTURE_DATE = '2026-11-05T10:00:00Z'
const PAST_DATE = '2026-10-20T10:00:00Z'

const ADMIN_ID = '10000000-0000-4000-8000-000000000001'
const ADMIN_CLAIMS = { identityId: ADMIN_ID, sessionId: '20000000-0000-4000-8000-000000000001', sessionVersion: 1 }

const CUSTOMER_ID = '30000000-0000-4000-8000-000000000001'
const CUSTOMER_IDENTITY_ID = '10000000-0000-4000-8000-000000000011'
const CUSTOMER_CLAIMS = {
  identityId: CUSTOMER_IDENTITY_ID,
  sessionId: '20000000-0000-4000-8000-000000000011',
  sessionVersion: 1
}

async function setupTestDb(): Promise<DatabaseSync> {
  const sqlite = await openMigratedDatabase()
  const sql = await readFile(
    new URL('../../db/d1/migrations/0112_bundles_referrals_events.sql', import.meta.url),
    'utf8'
  )
  sqlite.exec(sql)

  // Roles & permissions
  sqlite.exec(`
    INSERT OR IGNORE INTO roles (code, name, description) VALUES
      ('admin', 'Administrador', 'Fixture admin');
    INSERT OR IGNORE INTO permissions (code, resource, action, description) VALUES
      ('administration.manage', 'administration', 'manage', 'Fixture admin');
    INSERT OR IGNORE INTO role_permissions (role_code, permission_code) VALUES
      ('admin', 'administration.manage');

    INSERT OR IGNORE INTO customers (id, name, status, created_at, updated_at) VALUES
      ('${CUSTOMER_ID}', 'Taller Mecánico Rápido', 'active', '${NOW}', '${NOW}');

    INSERT OR IGNORE INTO identities (id, customer_id, email, password_hash, status, session_version, email_verified_at, created_at, updated_at) VALUES
      ('${ADMIN_ID}', NULL, 'admin@neteco.test', 'hash', 'active', 1, '${NOW}', '${NOW}', '${NOW}'),
      ('${CUSTOMER_IDENTITY_ID}', '${CUSTOMER_ID}', 'cliente@taller-mecanico.test', 'hash', 'active', 1, '${NOW}', '${NOW}', '${NOW}');

    INSERT OR IGNORE INTO auth_sessions (id, identity_id, session_version, mfa_verified, created_at, expires_at) VALUES
      ('${ADMIN_CLAIMS.sessionId}', '${ADMIN_ID}', 1, 1, '${NOW}', '2027-01-01T00:00:00Z'),
      ('${CUSTOMER_CLAIMS.sessionId}', '${CUSTOMER_IDENTITY_ID}', 1, 1, '${NOW}', '2027-01-01T00:00:00Z');

    INSERT OR IGNORE INTO identity_roles (identity_id, role_code, granted_at) VALUES
      ('${ADMIN_ID}', 'admin', '${NOW}');
  `)

  return sqlite
}

describe('MKT-030 Events, Webinars & Demos - Registrations, Reminders, Q&A, Recording & Followup', () => {
  let sqlite: DatabaseSync
  let db: D1Database

  beforeEach(async () => {
    sqlite = await setupTestDb()
    db = d1OverSqlite(sqlite)
  })

  afterEach(() => {
    sqlite?.close()
  })

  describe('Pure business checks', () => {
    it('validates event capacity', () => {
      expect(canRegisterForEvent(50, 49, 'scheduled').allowed).toBe(true)
      expect(canRegisterForEvent(50, 50, 'scheduled').allowed).toBe(false)
      expect(canRegisterForEvent(50, 10, 'completed').allowed).toBe(false)
    })

    it('enforces explicit consent per communication channel for reminders', () => {
      // Email reminder requires consentEmailReminder
      expect(
        determineReminderEligibility({ consentEmailReminder: true, consentSmsReminder: false }, 'email').status
      ).toBe('dispatched')

      expect(
        determineReminderEligibility({ consentEmailReminder: false, consentSmsReminder: true }, 'email').status
      ).toBe('suppressed_no_consent')

      // SMS reminder requires consentSmsReminder
      expect(
        determineReminderEligibility({ consentEmailReminder: true, consentSmsReminder: false }, 'sms').status
      ).toBe('suppressed_no_consent')

      expect(
        determineReminderEligibility({ consentEmailReminder: false, consentSmsReminder: true }, 'sms').status
      ).toBe('dispatched')
    })

    it('enforces explicit followup consent', () => {
      expect(determineFollowupEligibility({ consentFollowup: true }).status).toBe('dispatched')
      expect(determineFollowupEligibility({ consentFollowup: false }).status).toBe('suppressed_no_consent')
    })
  })

  describe('D1 Event Management Lifecycle', () => {
    it('creates scheduled webinar with CAS and command audit', async () => {
      const event = await createD1Event(db, ADMIN_CLAIMS, {
        commandId: 'e0000000-0000-4000-8000-000000000001',
        idempotencyKey: 'idem-create-webinar-1',
        slug: 'webinar-dilucion-seguridad-quimica',
        title: 'Protocolos de Dilución y Seguridad Química en Hostelería',
        description: 'Sesión técnica sobre dosificación óptima y normativas APPCC.',
        type: 'webinar',
        sector: 'hosteleria',
        locationType: 'online',
        locationDetails: 'https://conferencias.neteco.test/dilucion-seguridad',
        scheduledAt: FUTURE_DATE,
        durationMinutes: 45,
        maxAttendees: 100,
        now: NOW
      })

      expect(event.id).toBeDefined()
      expect(event.slug).toBe('webinar-dilucion-seguridad-quimica')
      expect(event.status).toBe('scheduled')

      const found = await getD1EventBySlug(db, 'webinar-dilucion-seguridad-quimica')
      expect(found).not.toBeNull()
      expect(found?.title).toBe('Protocolos de Dilución y Seguridad Química en Hostelería')
      expect(found?.currentAttendeesCount).toBe(0)

      const list = await listD1Events(db, { sector: 'hosteleria' })
      expect(list.items.length).toBeGreaterThanOrEqual(1)
      expect(list.items.some((e) => e.slug === 'webinar-dilucion-seguridad-quimica')).toBe(true)
    })

    it('registers attendee with channel-specific consent', async () => {
      const event = await createD1Event(db, ADMIN_CLAIMS, {
        commandId: 'e0000000-0000-4000-8000-000000000002',
        idempotencyKey: 'idem-event-2',
        slug: 'demo-lavado-industrial',
        title: 'Demostración Técnica de Lavado Industrial',
        description: 'Demostración práctica presencial.',
        type: 'demo',
        sector: 'industrial',
        locationType: 'in_person',
        locationDetails: 'Instalaciones Centrales Neteco, Polígono Industrial',
        scheduledAt: FUTURE_DATE,
        durationMinutes: 60,
        maxAttendees: 20,
        now: NOW
      })

      const reg = await registerD1EventAttendee(db, {
        commandId: 'e0000000-0000-4000-8000-000000000003',
        idempotencyKey: 'idem-reg-1',
        eventId: event.id,
        customerId: CUSTOMER_ID,
        attendeeName: 'Carlos Ingeniero',
        attendeeEmail: 'carlos@taller-mecanico.test',
        attendeePhone: '+34600112233',
        consentEmailReminder: true,
        consentSmsReminder: false,
        consentFollowup: true,
        consentTermsVersion: 'event-terms-v1',
        now: NOW
      })

      expect(reg.id).toBeDefined()
      expect(reg.consentEmailReminder).toBe(true)
      expect(reg.consentSmsReminder).toBe(false)
      expect(reg.consentFollowup).toBe(true)

      // Duplicate registration rejected
      await expect(
        registerD1EventAttendee(db, {
          commandId: 'e0000000-0000-4000-8000-000000000004',
          idempotencyKey: 'idem-reg-dup',
          eventId: event.id,
          attendeeName: 'Carlos Ingeniero',
          attendeeEmail: 'carlos@taller-mecanico.test',
          consentEmailReminder: true,
          consentSmsReminder: false,
          consentFollowup: true,
          consentTermsVersion: 'event-terms-v1',
          now: NOW
        })
      ).rejects.toThrow(EventError)
    })

    it('dispatches reminders respecting channel consent suppression', async () => {
      const event = await createD1Event(db, ADMIN_CLAIMS, {
        commandId: 'e0000000-0000-4000-8000-000000000005',
        idempotencyKey: 'idem-event-reminders',
        slug: 'webinar-recordatorios',
        title: 'Webinar de Recordatorios',
        description: 'Prueba de envío.',
        type: 'webinar',
        sector: 'general',
        locationType: 'online',
        locationDetails: 'https://conferencias.neteco.test/room-1',
        scheduledAt: FUTURE_DATE,
        durationMinutes: 30,
        maxAttendees: 50,
        now: NOW
      })

      // Reg 1: consents only to email
      await registerD1EventAttendee(db, {
        commandId: 'e0000000-0000-4000-8000-000000000006',
        idempotencyKey: 'idem-reg-email-only',
        eventId: event.id,
        attendeeName: 'Ana Gomez',
        attendeeEmail: 'ana@empresa.test',
        consentEmailReminder: true,
        consentSmsReminder: false,
        consentFollowup: false,
        consentTermsVersion: 'terms-v1',
        now: NOW
      })

      const reminders = await dispatchD1EventReminders(db, ADMIN_CLAIMS, {
        commandId: 'e0000000-0000-4000-8000-000000000007',
        idempotencyKey: 'idem-dispatch-24h',
        eventId: event.id,
        triggerType: '24h_before',
        now: NOW
      })

      // Email dispatched, SMS suppressed
      const emailResult = reminders.find((r) => r.channel === 'email')
      const smsResult = reminders.find((r) => r.channel === 'sms')
      expect(emailResult?.status).toBe('dispatched')
      expect(smsResult?.status).toBe('suppressed_no_consent')
    })

    it('submits attendee questions and allows admin answers', async () => {
      const event = await createD1Event(db, ADMIN_CLAIMS, {
        commandId: 'e0000000-0000-4000-8000-000000000008',
        idempotencyKey: 'idem-event-qa',
        slug: 'webinar-qa',
        title: 'Webinar con Q&A',
        description: 'Prueba de preguntas.',
        type: 'webinar',
        sector: 'automocion',
        locationType: 'online',
        locationDetails: 'https://conferencias.neteco.test/qa',
        scheduledAt: FUTURE_DATE,
        durationMinutes: 45,
        maxAttendees: 50,
        now: NOW
      })

      const question = await submitD1EventQuestion(db, {
        commandId: 'e0000000-0000-4000-8000-000000000009',
        idempotencyKey: 'idem-submit-q',
        eventId: event.id,
        customerId: CUSTOMER_ID,
        authorName: 'Taller Rápido',
        questionText: '¿Es compatible el limpiador con llantas de aluminio anodizado?',
        now: NOW
      })

      expect(question.id).toBeDefined()
      expect(question.answerText).toBeNull()

      const answered = await answerD1EventQuestion(db, ADMIN_CLAIMS, {
        commandId: 'e0000000-0000-4000-8000-000000000010',
        idempotencyKey: 'idem-answer-q',
        questionId: question.id,
        answerText: 'Sí, a una dilución máxima del 5% y enjuagando antes de 3 minutos.',
        now: NOW
      })

      expect(answered.answerText).toContain('dilución máxima del 5%')
      expect(answered.answeredBy).toBe(ADMIN_ID)
    })

    it('publishes recording with subtitles and dispatches post-event follow-up', async () => {
      const event = await createD1Event(db, ADMIN_CLAIMS, {
        commandId: 'e0000000-0000-4000-8000-000000000011',
        idempotencyKey: 'idem-event-past',
        slug: 'webinar-grabacion',
        title: 'Webinar Grabado',
        description: 'Grabación disponible.',
        type: 'webinar',
        sector: 'sanitario',
        locationType: 'online',
        locationDetails: 'https://conferencias.neteco.test/rec',
        scheduledAt: PAST_DATE,
        durationMinutes: 45,
        maxAttendees: 50,
        now: NOW
      })

      await registerD1EventAttendee(db, {
        commandId: 'e0000000-0000-4000-8000-000000000012',
        idempotencyKey: 'idem-reg-followup',
        eventId: event.id,
        attendeeName: 'Laura Farmacia',
        attendeeEmail: 'laura@farmacia.test',
        consentEmailReminder: true,
        consentSmsReminder: false,
        consentFollowup: true,
        consentTermsVersion: 'terms-v1',
        now: NOW
      })

      // Admin publishes recording & subtitles
      const updated = await publishD1EventRecording(db, ADMIN_CLAIMS, {
        commandId: 'e0000000-0000-4000-8000-000000000013',
        idempotencyKey: 'idem-pub-rec',
        eventId: event.id,
        expectedVersion: 1,
        recordingUrl: 'https://media.neteco.test/webinars/grabacion-sanitario-2026.mp4',
        subtitlesUrl: 'https://media.neteco.test/webinars/subtitulos-es.vtt',
        recordingDurationSeconds: 2700,
        now: NOW
      })

      expect(updated.recordingUrl).toBe('https://media.neteco.test/webinars/grabacion-sanitario-2026.mp4')
      expect(updated.subtitlesUrl).toBe('https://media.neteco.test/webinars/subtitulos-es.vtt')

      // Dispatch follow-up
      const followups = await dispatchD1EventFollowup(db, ADMIN_CLAIMS, {
        commandId: 'e0000000-0000-4000-8000-000000000014',
        idempotencyKey: 'idem-dispatch-followup',
        eventId: event.id,
        summaryNotes: 'Resumen técnico y ficha de seguridad adjunta.',
        technicalSheetsIncluded: true,
        now: NOW
      })

      expect(followups).toHaveLength(1)
      expect(followups[0].status).toBe('dispatched')
      expect(followups[0].recordingIncluded).toBe(true)
    })
  })
})

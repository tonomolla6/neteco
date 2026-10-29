import { sha256Hex } from '../catalog/inventory'
import { authorizeD1Session, type VerifiedSessionClaims } from '../catalog/authorization'
import {
  accountManagerAssignInputSchema,
  commercialNoteCreateInputSchema,
  opportunityCreateInputSchema,
  opportunityUpdateStageInputSchema,
  calendarEventScheduleInputSchema,
  calendarEventUpdateStatusInputSchema,
  GENERAL_SUPPORT_INFO,
  type CustomerVisibleAccountManager,
  type CustomerSlaTier,
  type OpportunityStage,
  type CalendarStatus,
  type CalendarChannel,
  type NoteCategory,
  type NoteConfidentiality
} from '../../shared/customer-account-manager'

export interface CrmOptions {
  now?: string
}

function canonicalIso(iso?: string): string {
  const d = iso ? new Date(iso) : new Date()
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

export interface CustomerAccountManagerRecord {
  id: string
  customerId: string
  managerIdentityId: string
  managerName: string
  managerEmail: string
  managerPhone: string | null
  availabilitySchedule: string
  slaTier: CustomerSlaTier
  slaResponseHours: number
  slaDescription: string | null
  isActive: number
  assignedBy: string
  version: number
  createdAt: string
  updatedAt: string
}

export interface CommercialNoteRecord {
  id: string
  customerId: string
  authorId: string
  category: NoteCategory
  confidentiality: NoteConfidentiality
  title: string
  content: string
  createdAt: string
}

export interface OpportunityRecord {
  id: string
  customerId: string
  title: string
  estimatedValueCents: number
  stage: OpportunityStage
  probabilityPercent: number
  expectedCloseDate: string | null
  assignedManagerId: string | null
  notes: string | null
  version: number
  createdBy: string
  createdAt: string
  updatedAt: string
}

export interface CalendarEventRecord {
  id: string
  customerId: string
  managerIdentityId: string
  subject: string
  scheduledAt: string
  durationMinutes: number
  channel: CalendarChannel
  customerConsentVerified: number
  consentReference: string | null
  status: CalendarStatus
  notes: string | null
  createdBy: string
  createdAt: string
  updatedAt: string
}

interface ManagerDbRow {
  id: string
  customer_id: string
  manager_identity_id: string
  manager_name: string
  manager_email: string
  manager_phone: string | null
  availability_schedule: string
  sla_tier: CustomerSlaTier
  sla_response_hours: number
  sla_description: string | null
  is_active: number
  assigned_by: string
  version: number
  created_at: string
  updated_at: string
}

interface NoteDbRow {
  id: string
  customer_id: string
  author_id: string
  category: NoteCategory
  confidentiality: NoteConfidentiality
  title: string
  content: string
  created_at: string
}

interface OpportunityDbRow {
  id: string
  customer_id: string
  title: string
  estimated_value_cents: number
  stage: OpportunityStage
  probability_percent: number
  expected_close_date: string | null
  assigned_manager_id: string | null
  notes: string | null
  version: number
  created_by: string
  created_at: string
  updated_at: string
}

interface CalendarEventDbRow {
  id: string
  customer_id: string
  manager_identity_id: string
  subject: string
  scheduled_at: string
  duration_minutes: number
  channel: CalendarChannel
  customer_consent_verified: number
  consent_reference: string | null
  status: CalendarStatus
  notes: string | null
  created_by: string
  created_at: string
  updated_at: string
}

function extractNow(options: CrmOptions, rawInput: unknown): string {
  if (options.now) return canonicalIso(options.now)
  if (typeof rawInput === 'object' && rawInput !== null && 'now' in rawInput) {
    const rawNow = (rawInput as { now?: unknown }).now
    if (typeof rawNow === 'string') return canonicalIso(rawNow)
  }
  return canonicalIso()
}

export async function assignCustomerAccountManager(
  database: D1Database,
  claims: VerifiedSessionClaims,
  customerId: string,
  rawInput: unknown,
  options: CrmOptions = {}
): Promise<CustomerAccountManagerRecord> {
  const now = extractNow(options, rawInput)
  const auth = await authorizeD1Session(database, claims, 'support.manage', { now, requireMfa: false })
  if (!auth.allowed) throw new Error(auth.code)

  const parsed = accountManagerAssignInputSchema.safeParse(rawInput)
  if (!parsed.success) throw new Error('invalid_input')
  const input = parsed.data

  const existing = await database
    .prepare('SELECT * FROM customer_account_managers WHERE customer_id = ?1')
    .bind(customerId)
    .first<ManagerDbRow>()

  const id = existing?.id ?? crypto.randomUUID()
  const version = (existing?.version ?? 0) + 1
  const createdAt = existing?.created_at ?? now

  if (existing) {
    await database
      .prepare(
        `UPDATE customer_account_managers
         SET manager_identity_id = ?1, manager_name = ?2, manager_email = ?3, manager_phone = ?4,
             availability_schedule = ?5, sla_tier = ?6, sla_response_hours = ?7, sla_description = ?8,
             is_active = 1, assigned_by = ?9, version = ?10, updated_at = ?11
         WHERE customer_id = ?12`
      )
      .bind(
        input.managerIdentityId,
        input.managerName,
        input.managerEmail,
        input.managerPhone ?? null,
        input.availabilitySchedule,
        input.slaTier,
        input.slaResponseHours,
        input.slaDescription ?? null,
        claims.identityId,
        version,
        now,
        customerId
      )
      .run()
  } else {
    await database
      .prepare(
        `INSERT INTO customer_account_managers (
          id, customer_id, manager_identity_id, manager_name, manager_email, manager_phone,
          availability_schedule, sla_tier, sla_response_hours, sla_description, is_active,
          assigned_by, version, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 1, ?11, 1, ?12, ?13)`
      )
      .bind(
        id,
        customerId,
        input.managerIdentityId,
        input.managerName,
        input.managerEmail,
        input.managerPhone ?? null,
        input.availabilitySchedule,
        input.slaTier,
        input.slaResponseHours,
        input.slaDescription ?? null,
        claims.identityId,
        now,
        now
      )
      .run()
  }

  // Audit command
  const payloadHash = await sha256Hex(
    JSON.stringify({ action: 'assign', customerId, managerId: input.managerIdentityId })
  )
  await database
    .prepare(
      `INSERT INTO customer_account_manager_commands (
        id, entity_type, entity_id, customer_id, actor_id, action, expected_version, result_version, payload_hash, input_json, created_at
      ) VALUES (?1, 'manager', ?2, ?3, ?4, 'assign', ?5, ?6, ?7, ?8, ?9)`
    )
    .bind(
      crypto.randomUUID(),
      id,
      customerId,
      claims.identityId,
      version - 1,
      version,
      payloadHash,
      JSON.stringify(input),
      now
    )
    .run()

  return {
    id,
    customerId,
    managerIdentityId: input.managerIdentityId,
    managerName: input.managerName,
    managerEmail: input.managerEmail,
    managerPhone: input.managerPhone ?? null,
    availabilitySchedule: input.availabilitySchedule,
    slaTier: input.slaTier,
    slaResponseHours: input.slaResponseHours,
    slaDescription: input.slaDescription ?? null,
    isActive: 1,
    assignedBy: claims.identityId,
    version,
    createdAt,
    updatedAt: now
  }
}

export async function readCustomerAccountManager(
  database: D1Database,
  claims: VerifiedSessionClaims,
  customerId: string,
  options: CrmOptions = {}
): Promise<CustomerAccountManagerRecord | null> {
  const now = canonicalIso(options.now)
  const auth = await authorizeD1Session(database, claims, 'support.manage', { now, requireMfa: false })
  if (!auth.allowed) throw new Error(auth.code)

  const row = await database
    .prepare('SELECT * FROM customer_account_managers WHERE customer_id = ?1')
    .bind(customerId)
    .first<ManagerDbRow>()

  if (!row) return null

  return {
    id: row.id,
    customerId: row.customer_id,
    managerIdentityId: row.manager_identity_id,
    managerName: row.manager_name,
    managerEmail: row.manager_email,
    managerPhone: row.manager_phone,
    availabilitySchedule: row.availability_schedule,
    slaTier: row.sla_tier,
    slaResponseHours: row.sla_response_hours,
    slaDescription: row.sla_description,
    isActive: row.is_active,
    assignedBy: row.assigned_by,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export async function readCustomerVisibleAccountManager(
  database: D1Database,
  customerId: string
): Promise<CustomerVisibleAccountManager> {
  const row = await database
    .prepare('SELECT * FROM customer_account_managers WHERE customer_id = ?1 AND is_active = 1')
    .bind(customerId)
    .first<ManagerDbRow>()

  if (!row) {
    return {
      hasAssignedManager: false,
      generalSupport: GENERAL_SUPPORT_INFO
    }
  }

  return {
    hasAssignedManager: true,
    manager: {
      name: row.manager_name,
      email: row.manager_email,
      phone: row.manager_phone ?? null,
      availabilitySchedule: row.availability_schedule,
      slaTier: row.sla_tier,
      slaResponseHours: row.sla_response_hours,
      slaDescription: row.sla_description ?? undefined
    },
    generalSupport: GENERAL_SUPPORT_INFO
  }
}

export async function createCustomerCommercialNote(
  database: D1Database,
  claims: VerifiedSessionClaims,
  customerId: string,
  rawInput: unknown,
  options: CrmOptions = {}
): Promise<CommercialNoteRecord> {
  const now = extractNow(options, rawInput)
  const auth = await authorizeD1Session(database, claims, 'support.manage', { now, requireMfa: false })
  if (!auth.allowed) throw new Error(auth.code)

  const parsed = commercialNoteCreateInputSchema.safeParse(rawInput)
  if (!parsed.success) throw new Error('invalid_input')
  const { category, confidentiality, title, content } = parsed.data

  const id = crypto.randomUUID()
  await database
    .prepare(
      `INSERT INTO customer_commercial_notes (
        id, customer_id, author_id, category, confidentiality, title, content, created_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
    )
    .bind(id, customerId, claims.identityId, category, confidentiality, title.trim(), content.trim(), now)
    .run()

  return {
    id,
    customerId,
    authorId: claims.identityId,
    category,
    confidentiality,
    title: title.trim(),
    content: content.trim(),
    createdAt: now
  }
}

export async function listCustomerCommercialNotes(
  database: D1Database,
  claims: VerifiedSessionClaims,
  customerId: string,
  options: CrmOptions = {}
): Promise<CommercialNoteRecord[]> {
  const now = canonicalIso(options.now)
  const auth = await authorizeD1Session(database, claims, 'support.manage', { now, requireMfa: false })
  if (!auth.allowed) throw new Error(auth.code)

  const rows = await database
    .prepare('SELECT * FROM customer_commercial_notes WHERE customer_id = ?1 ORDER BY created_at DESC')
    .bind(customerId)
    .all<NoteDbRow>()

  return (rows.results ?? []).map((r) => ({
    id: r.id,
    customerId: r.customer_id,
    authorId: r.author_id,
    category: r.category,
    confidentiality: r.confidentiality,
    title: r.title,
    content: r.content,
    createdAt: r.created_at
  }))
}

export async function createCustomerOpportunity(
  database: D1Database,
  claims: VerifiedSessionClaims,
  customerId: string,
  rawInput: unknown,
  options: CrmOptions = {}
): Promise<OpportunityRecord> {
  const now = extractNow(options, rawInput)
  const auth = await authorizeD1Session(database, claims, 'support.manage', { now, requireMfa: false })
  if (!auth.allowed) throw new Error(auth.code)

  const parsed = opportunityCreateInputSchema.safeParse(rawInput)
  if (!parsed.success) throw new Error('invalid_input')
  const { title, estimatedValueCents, stage, probabilityPercent, expectedCloseDate, assignedManagerId, notes } =
    parsed.data

  const id = crypto.randomUUID()
  await database
    .prepare(
      `INSERT INTO customer_opportunities (
        id, customer_id, title, estimated_value_cents, stage, probability_percent,
        expected_close_date, assigned_manager_id, notes, version, created_by, created_at, updated_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 1, ?10, ?11, ?12)`
    )
    .bind(
      id,
      customerId,
      title.trim(),
      estimatedValueCents,
      stage,
      probabilityPercent,
      expectedCloseDate ?? null,
      assignedManagerId ?? null,
      notes?.trim() ?? null,
      claims.identityId,
      now,
      now
    )
    .run()

  const payloadHash = await sha256Hex(JSON.stringify({ action: 'create_opp', id, customerId }))
  await database
    .prepare(
      `INSERT INTO customer_account_manager_commands (
        id, entity_type, entity_id, customer_id, actor_id, action, expected_version, result_version, payload_hash, input_json, created_at
      ) VALUES (?1, 'opportunity', ?2, ?3, ?4, 'create_opp', 0, 1, ?5, ?6, ?7)`
    )
    .bind(crypto.randomUUID(), id, customerId, claims.identityId, payloadHash, JSON.stringify(parsed.data), now)
    .run()

  return {
    id,
    customerId,
    title: title.trim(),
    estimatedValueCents,
    stage,
    probabilityPercent,
    expectedCloseDate: expectedCloseDate ?? null,
    assignedManagerId: assignedManagerId ?? null,
    notes: notes?.trim() ?? null,
    version: 1,
    createdBy: claims.identityId,
    createdAt: now,
    updatedAt: now
  }
}

export async function updateCustomerOpportunityStage(
  database: D1Database,
  claims: VerifiedSessionClaims,
  opportunityId: string,
  rawInput: unknown,
  options: CrmOptions = {}
): Promise<OpportunityRecord> {
  const now = extractNow(options, rawInput)
  const auth = await authorizeD1Session(database, claims, 'support.manage', { now, requireMfa: false })
  if (!auth.allowed) throw new Error(auth.code)

  const parsed = opportunityUpdateStageInputSchema.safeParse(rawInput)
  if (!parsed.success) throw new Error('invalid_input')
  const { expectedVersion, stage, probabilityPercent, notes, reason } = parsed.data

  const opp = await database
    .prepare('SELECT * FROM customer_opportunities WHERE id = ?1')
    .bind(opportunityId)
    .first<OpportunityDbRow>()

  if (!opp) throw new Error('not_found')
  if (opp.version !== expectedVersion) throw new Error('version_conflict')

  const newVersion = expectedVersion + 1
  const newProbability = probabilityPercent ?? (stage === 'won' ? 100 : stage === 'lost' ? 0 : opp.probability_percent)

  await database
    .prepare(
      `UPDATE customer_opportunities
       SET stage = ?1, probability_percent = ?2, notes = COALESCE(?3, notes),
           version = ?4, updated_at = ?5
       WHERE id = ?6 AND version = ?7`
    )
    .bind(stage, newProbability, notes?.trim() ?? null, newVersion, now, opportunityId, expectedVersion)
    .run()

  const payloadHash = await sha256Hex(
    JSON.stringify({ action: 'update_opp_stage', opportunityId, stage, expectedVersion, reason })
  )
  await database
    .prepare(
      `INSERT INTO customer_account_manager_commands (
        id, entity_type, entity_id, customer_id, actor_id, action, expected_version, result_version, payload_hash, input_json, created_at
      ) VALUES (?1, 'opportunity', ?2, ?3, ?4, 'update_opp_stage', ?5, ?6, ?7, ?8, ?9)`
    )
    .bind(
      crypto.randomUUID(),
      opportunityId,
      opp.customer_id,
      claims.identityId,
      expectedVersion,
      newVersion,
      payloadHash,
      JSON.stringify(parsed.data),
      now
    )
    .run()

  return {
    id: opp.id,
    customerId: opp.customer_id,
    title: opp.title,
    estimatedValueCents: opp.estimated_value_cents,
    stage,
    probabilityPercent: newProbability,
    expectedCloseDate: opp.expected_close_date,
    assignedManagerId: opp.assigned_manager_id,
    notes: notes?.trim() ?? opp.notes,
    version: newVersion,
    createdBy: opp.created_by,
    createdAt: opp.created_at,
    updatedAt: now
  }
}

export async function listCustomerOpportunities(
  database: D1Database,
  claims: VerifiedSessionClaims,
  customerId: string,
  options: CrmOptions = {}
): Promise<OpportunityRecord[]> {
  const now = canonicalIso(options.now)
  const auth = await authorizeD1Session(database, claims, 'support.manage', { now, requireMfa: false })
  if (!auth.allowed) throw new Error(auth.code)

  const rows = await database
    .prepare('SELECT * FROM customer_opportunities WHERE customer_id = ?1 ORDER BY created_at DESC')
    .bind(customerId)
    .all<OpportunityDbRow>()

  return (rows.results ?? []).map((r) => ({
    id: r.id,
    customerId: r.customer_id,
    title: r.title,
    estimatedValueCents: r.estimated_value_cents,
    stage: r.stage,
    probabilityPercent: r.probability_percent,
    expectedCloseDate: r.expected_close_date,
    assignedManagerId: r.assigned_manager_id,
    notes: r.notes,
    version: r.version,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }))
}

export async function scheduleCustomerCalendarEvent(
  database: D1Database,
  claims: VerifiedSessionClaims,
  customerId: string,
  rawInput: unknown,
  options: CrmOptions = {}
): Promise<CalendarEventRecord> {
  const now = extractNow(options, rawInput)
  const auth = await authorizeD1Session(database, claims, 'support.manage', { now, requireMfa: false })
  if (!auth.allowed) throw new Error(auth.code)

  const parsed = calendarEventScheduleInputSchema.safeParse(rawInput)
  if (!parsed.success) {
    const consentErr = parsed.error.issues.find((i) => i.path.includes('customerConsentVerified'))
    if (consentErr) throw new Error('consent_required')
    throw new Error('invalid_input')
  }
  const { managerIdentityId, subject, scheduledAt, durationMinutes, channel, consentReference, notes } = parsed.data

  const id = crypto.randomUUID()
  await database
    .prepare(
      `INSERT INTO customer_calendar_events (
        id, customer_id, manager_identity_id, subject, scheduled_at, duration_minutes,
        channel, customer_consent_verified, consent_reference, status, notes, created_by, created_at, updated_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1, ?8, 'scheduled', ?9, ?10, ?11, ?12)`
    )
    .bind(
      id,
      customerId,
      managerIdentityId,
      subject.trim(),
      scheduledAt,
      durationMinutes,
      channel,
      consentReference ?? null,
      notes?.trim() ?? null,
      claims.identityId,
      now,
      now
    )
    .run()

  const payloadHash = await sha256Hex(JSON.stringify({ action: 'schedule_event', id, customerId, scheduledAt }))
  await database
    .prepare(
      `INSERT INTO customer_account_manager_commands (
        id, entity_type, entity_id, customer_id, actor_id, action, expected_version, result_version, payload_hash, input_json, created_at
      ) VALUES (?1, 'calendar', ?2, ?3, ?4, 'schedule_event', 0, 1, ?5, ?6, ?7)`
    )
    .bind(crypto.randomUUID(), id, customerId, claims.identityId, payloadHash, JSON.stringify(parsed.data), now)
    .run()

  return {
    id,
    customerId,
    managerIdentityId,
    subject: subject.trim(),
    scheduledAt,
    durationMinutes,
    channel,
    customerConsentVerified: 1,
    consentReference: consentReference ?? null,
    status: 'scheduled',
    notes: notes?.trim() ?? null,
    createdBy: claims.identityId,
    createdAt: now,
    updatedAt: now
  }
}

export async function updateCustomerCalendarEventStatus(
  database: D1Database,
  claims: VerifiedSessionClaims,
  eventId: string,
  rawInput: unknown,
  options: CrmOptions = {}
): Promise<CalendarEventRecord> {
  const now = extractNow(options, rawInput)
  const auth = await authorizeD1Session(database, claims, 'support.manage', { now, requireMfa: false })
  if (!auth.allowed) throw new Error(auth.code)

  const parsed = calendarEventUpdateStatusInputSchema.safeParse(rawInput)
  if (!parsed.success) throw new Error('invalid_input')
  const { status, notes } = parsed.data

  const event = await database
    .prepare('SELECT * FROM customer_calendar_events WHERE id = ?1')
    .bind(eventId)
    .first<CalendarEventDbRow>()

  if (!event) throw new Error('not_found')

  await database
    .prepare(
      `UPDATE customer_calendar_events
       SET status = ?1, notes = COALESCE(?2, notes), updated_at = ?3
       WHERE id = ?4`
    )
    .bind(status, notes?.trim() ?? null, now, eventId)
    .run()

  return {
    id: event.id,
    customerId: event.customer_id,
    managerIdentityId: event.manager_identity_id,
    subject: event.subject,
    scheduledAt: event.scheduled_at,
    durationMinutes: event.duration_minutes,
    channel: event.channel,
    customerConsentVerified: event.customer_consent_verified,
    consentReference: event.consent_reference,
    status,
    notes: notes?.trim() ?? event.notes,
    createdBy: event.created_by,
    createdAt: event.created_at,
    updatedAt: now
  }
}

export async function listCustomerCalendarEvents(
  database: D1Database,
  claims: VerifiedSessionClaims,
  customerId: string,
  options: CrmOptions = {}
): Promise<CalendarEventRecord[]> {
  const now = canonicalIso(options.now)
  const auth = await authorizeD1Session(database, claims, 'support.manage', { now, requireMfa: false })
  if (!auth.allowed) throw new Error(auth.code)

  const rows = await database
    .prepare('SELECT * FROM customer_calendar_events WHERE customer_id = ?1 ORDER BY scheduled_at ASC')
    .bind(customerId)
    .all<CalendarEventDbRow>()

  return (rows.results ?? []).map((r) => ({
    id: r.id,
    customerId: r.customer_id,
    managerIdentityId: r.manager_identity_id,
    subject: r.subject,
    scheduledAt: r.scheduled_at,
    durationMinutes: r.duration_minutes,
    channel: r.channel,
    customerConsentVerified: r.customer_consent_verified,
    consentReference: r.consent_reference,
    status: r.status,
    notes: r.notes,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }))
}

export async function listMyCustomerCalendarEvents(
  database: D1Database,
  customerId: string
): Promise<CalendarEventRecord[]> {
  const rows = await database
    .prepare(
      `SELECT * FROM customer_calendar_events
       WHERE customer_id = ?1 AND status NOT IN ('cancelled')
       ORDER BY scheduled_at ASC`
    )
    .bind(customerId)
    .all<CalendarEventDbRow>()

  return (rows.results ?? []).map((r) => ({
    id: r.id,
    customerId: r.customer_id,
    managerIdentityId: r.manager_identity_id,
    subject: r.subject,
    scheduledAt: r.scheduled_at,
    durationMinutes: r.duration_minutes,
    channel: r.channel,
    customerConsentVerified: r.customer_consent_verified,
    consentReference: r.consent_reference,
    status: r.status,
    notes: r.notes,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }))
}

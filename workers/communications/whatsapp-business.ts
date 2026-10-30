import { z } from 'zod'
import type { VerifiedSessionClaims } from '../catalog/authorization'
import { canonicalPayloadHash } from '../catalog/cart'
import { catalogPolicyInstantSchema } from '../../shared/catalog-publication-policy'
import { readHighValueConsent } from './high-value-consent'
import { highValueMessageText } from './high-value-messaging-policy'
import { highValueEventIdSchema, HighValueSourceError } from './high-value-source'

export class WhatsAppBusinessError extends Error {
  constructor(
    readonly code:
      | 'invalid_input'
      | 'delivery_disabled'
      | 'consent_required'
      | 'template_required'
      | 'human_handoff'
      | 'conflict'
      | 'budget_exceeded'
      | 'rate_limited'
      | 'unavailable'
  ) {
    super(code)
  }
}
const uuid = z.string().uuid()
const event = z.enum(['recall', 'delivery_exception', 'security_alert'])
const version = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER - 1)
const stateSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('approve_template'),
      expectedVersion: version,
      event,
      templateId: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
      approvalRef: z.string().regex(/^[a-zA-Z0-9_-]{8,100}$/)
    })
    .strict(),
  z.object({ action: z.literal('inbound'), expectedVersion: version }).strict(),
  z.object({ action: z.literal('handoff'), expectedVersion: version }).strict(),
  z.object({ action: z.literal('resume'), expectedVersion: version }).strict()
])
const messageSchema = z
  .object({ eventId: highValueEventIdSchema, event, consentVersion: version, stateVersion: version })
  .strict()
const priceSchema = z
  .object({
    whatsappCostMinor: z.number().int().min(0).max(1000000),
    dailyBudgetMinor: z.number().int().min(0).max(1000000)
  })
  .strict()
type Options = { now?: () => string; transport: string; pricing: unknown; requireSource?: boolean }
interface StateRow {
  command_id: string
  customer_id: string
  action: string
  event_type: string | null
  template_id: string | null
  payload_hash: string
  version: number
  created_at: string
}
interface DeliveryRow {
  command_id: string
  event_id: string
  customer_id: string
  event_type: string
  mode: 'session' | 'template'
  template_id: string | null
  payload_hash: string
  cost_minor: number
  created_at: string
}
function fail(code: WhatsAppBusinessError['code']): never {
  throw new WhatsAppBusinessError(code)
}
function clock(options: Options) {
  const value = options.now?.() ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  if (!catalogPolicyInstantSchema.safeParse(value).success) fail('unavailable')
  return value
}
function requireFake(options: Options) {
  if (options.transport !== 'official-fake') fail('delivery_disabled')
}
function stateReceipt(row: StateRow) {
  return {
    source: 'cloudflare' as const,
    commandId: row.command_id,
    customerId: row.customer_id,
    action: row.action,
    version: row.version,
    createdAt: row.created_at
  }
}
function deliveryReceipt(row: DeliveryRow) {
  return {
    source: 'cloudflare' as const,
    status: 'simulated' as const,
    channel: 'whatsapp' as const,
    commandId: row.command_id,
    eventId: row.event_id,
    customerId: row.customer_id,
    mode: row.mode,
    templateId: row.template_id,
    costMinor: row.cost_minor,
    createdAt: row.created_at,
    message: highValueMessageText(row.event_type),
    fakeReceipt: `fake:${row.command_id}`
  }
}
export async function readWhatsAppState(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  customerId: string,
  options: Options
) {
  if (!uuid.safeParse(customerId).success) fail('invalid_input')
  requireFake(options)
  await readHighValueConsent(db, claims, customerId, 'whatsapp', options)
  const state = await db
    .prepare(
      `SELECT COALESCE((SELECT max(version) FROM high_value_whatsapp_state WHERE customer_id=?1),0) version,
      (SELECT action FROM high_value_whatsapp_state WHERE customer_id=?1 AND action IN('handoff','resume') ORDER BY version DESC LIMIT 1) handoff,
      (SELECT created_at FROM high_value_whatsapp_state WHERE customer_id=?1 AND action='inbound' ORDER BY version DESC LIMIT 1) inbound`
    )
    .bind(customerId)
    .first<{ version: number; handoff: string | null; inbound: string | null }>()
  const templates = await db
    .prepare(
      `SELECT s.event_type event,s.template_id templateId FROM high_value_whatsapp_state s
      WHERE s.customer_id=?1 AND s.action='approve_template' AND s.version=(SELECT max(t.version)
        FROM high_value_whatsapp_state t WHERE t.customer_id=s.customer_id AND t.action='approve_template' AND t.event_type=s.event_type)
      ORDER BY s.event_type LIMIT 3`
    )
    .bind(customerId)
    .all<{ event: string; templateId: string }>()
  await readHighValueConsent(db, claims, customerId, 'whatsapp', options)
  if (!state) fail('unavailable')
  return {
    source: 'cloudflare' as const,
    version: state.version,
    handoff: state.handoff === 'handoff',
    lastInboundAt: state.inbound,
    templates: templates.results
  }
}
export async function recordWhatsAppState(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  customerId: string,
  commandId: string,
  raw: unknown,
  options: Options
) {
  const input = stateSchema.safeParse(raw)
  if (!input.success || !uuid.safeParse(customerId).success || !uuid.safeParse(commandId).success) fail('invalid_input')
  requireFake(options)
  await readHighValueConsent(db, claims, customerId, 'whatsapp', options)
  if (!claims) fail('unavailable')
  const value = input.data,
    now = clock(options),
    hash = await canonicalPayloadHash({ customerId, actorId: claims.identityId, ...value })
  const lookup = async () =>
    db.prepare('SELECT * FROM high_value_whatsapp_state WHERE command_id=?').bind(commandId).first<StateRow>()
  const previous = await lookup()
  if (previous) {
    if (previous.customer_id !== customerId || previous.payload_hash !== hash) fail('conflict')
    await readHighValueConsent(db, claims, customerId, 'whatsapp', options)
    return stateReceipt(previous)
  }
  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO high_value_whatsapp_state(command_id,customer_id,action,event_type,template_id,approval_ref,actor_id,session_id,session_version,payload_hash,expected_version,version,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`
        )
        .bind(
          commandId,
          customerId,
          value.action,
          value.action === 'approve_template' ? value.event : null,
          value.action === 'approve_template' ? value.templateId : null,
          value.action === 'approve_template' ? value.approvalRef : null,
          claims.identityId,
          claims.sessionId,
          claims.sessionVersion,
          hash,
          value.expectedVersion,
          value.expectedVersion + 1,
          now
        )
    ])
  } catch (cause) {
    await readHighValueConsent(db, claims, customerId, 'whatsapp', options)
    const raced = await lookup()
    if (raced) {
      if (raced.customer_id !== customerId || raced.payload_hash !== hash) fail('conflict')
      return stateReceipt(raced)
    }
    if (cause instanceof Error && cause.message.includes('state_conflict')) fail('conflict')
    fail('unavailable')
  }
  const row = await lookup()
  await readHighValueConsent(db, claims, customerId, 'whatsapp', options)
  if (!row) fail('unavailable')
  return stateReceipt(row)
}
export async function simulateWhatsAppMessage(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  customerId: string,
  commandId: string,
  raw: unknown,
  options: Options
) {
  const input = messageSchema.safeParse(raw),
    price = priceSchema.safeParse(options.pricing)
  if (!input.success || !price.success || !uuid.safeParse(customerId).success || !uuid.safeParse(commandId).success)
    fail('invalid_input')
  requireFake(options)
  const consent = await readHighValueConsent(db, claims, customerId, 'whatsapp', options)
  if (!consent.granted || consent.version !== input.data.consentVersion) fail('consent_required')
  if (!claims) fail('unavailable')
  const value = input.data,
    now = clock(options),
    hash = await canonicalPayloadHash({
      customerId,
      actorId: claims.identityId,
      ...value,
      pricing: price.data,
      ...(options.requireSource ? { sourceVerified: true } : {})
    })
  const lookup = async () =>
    db.prepare('SELECT * FROM high_value_whatsapp_delivery WHERE command_id=?').bind(commandId).first<DeliveryRow>()
  const previous = await lookup()
  if (previous) {
    if (previous.customer_id !== customerId || previous.payload_hash !== hash) fail('conflict')
    await readHighValueConsent(db, claims, customerId, 'whatsapp', options)
    return deliveryReceipt(previous)
  }
  const state = await db
    .prepare(
      `SELECT COALESCE((SELECT max(version) FROM high_value_whatsapp_state WHERE customer_id=?1),0) version,
 (SELECT action FROM high_value_whatsapp_state WHERE customer_id=?1 AND action IN('handoff','resume') ORDER BY version DESC LIMIT 1) handoff,
 (SELECT created_at FROM high_value_whatsapp_state WHERE customer_id=?1 AND action='inbound' ORDER BY version DESC LIMIT 1) inbound,
 (SELECT template_id FROM high_value_whatsapp_state WHERE customer_id=?1 AND action='approve_template' AND event_type=?2 ORDER BY version DESC LIMIT 1) template`
    )
    .bind(customerId, value.event)
    .first<{ version: number; handoff: string | null; inbound: string | null; template: string | null }>()
  if (!state) fail('unavailable')
  if (state.version !== value.stateVersion) fail('conflict')
  if (state.handoff === 'handoff') fail('human_handoff')
  const elapsed = state.inbound === null ? Infinity : Date.parse(now) - Date.parse(state.inbound)
  const mode = elapsed >= 0 && elapsed < 86400000 ? 'session' : 'template'
  if (mode === 'template' && !state.template) fail('template_required')
  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO high_value_whatsapp_delivery(command_id,event_id,customer_id,event_type,mode,template_id,actor_id,session_id,session_version,payload_hash,consent_version,state_version,cost_minor,budget_minor,created_at,source_verified) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
        )
        .bind(
          commandId,
          value.eventId,
          customerId,
          value.event,
          mode,
          mode === 'template' ? state.template : null,
          claims.identityId,
          claims.sessionId,
          claims.sessionVersion,
          hash,
          value.consentVersion,
          value.stateVersion,
          price.data.whatsappCostMinor,
          price.data.dailyBudgetMinor,
          now,
          options.requireSource ? 1 : 0
        )
    ])
  } catch (cause) {
    const current = await readHighValueConsent(db, claims, customerId, 'whatsapp', options)
    if (!current.granted || current.version !== value.consentVersion) fail('consent_required')
    const raced = await lookup()
    if (raced) {
      if (raced.customer_id !== customerId || raced.payload_hash !== hash) fail('conflict')
      return deliveryReceipt(raced)
    }
    const duplicate = await db
      .prepare('SELECT 1 FROM high_value_whatsapp_delivery WHERE event_id=? AND customer_id=?')
      .bind(value.eventId, customerId)
      .first()
    if (duplicate) fail('conflict')
    if (cause instanceof Error && cause.message.includes('event_unavailable'))
      throw new HighValueSourceError('event_unavailable')
    if (cause instanceof Error && cause.message.includes('frequency_limited')) fail('rate_limited')
    if (cause instanceof Error && cause.message.includes('budget_exceeded')) fail('budget_exceeded')
    if (cause instanceof Error && cause.message.includes('state_conflict')) fail('conflict')
    fail('unavailable')
  }
  const row = await lookup()
  await readHighValueConsent(db, claims, customerId, 'whatsapp', options)
  if (!row) fail('unavailable')
  return deliveryReceipt(row)
}

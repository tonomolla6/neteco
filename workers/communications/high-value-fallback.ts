import { z } from 'zod'
import type { VerifiedSessionClaims } from '../catalog/authorization'
import { canonicalPayloadHash } from '../catalog/cart'
import { readHighValueConsent } from './high-value-consent'
import { dispatchHighValueMessage, HighValueDeliveryError } from './high-value-delivery'
import { highValueEventIdSchema, HighValueSourceError } from './high-value-source'

const uuid = z.string().uuid()
const schema = z
  .object({
    eventId: highValueEventIdSchema,
    event: z.enum(['recall', 'delivery_exception', 'security_alert']),
    channel: z.literal('sms'),
    consentVersion: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
  })
  .strict()
type Options = { now?: () => string; pricing: unknown; transport: string; requireSource?: boolean }
interface Row {
  command_id: string
  event_id: string
  customer_id: string
  channel: string
  reason: string
  payload_hash: string
  created_at: string
}
function fail(code: HighValueDeliveryError['code']): never {
  throw new HighValueDeliveryError(code)
}
function receipt(row: Row) {
  return {
    source: 'cloudflare' as const,
    status: 'fallback' as const,
    fallback: 'manual' as const,
    reason: row.reason,
    commandId: row.command_id,
    eventId: row.event_id,
    customerId: row.customer_id,
    channel: row.channel,
    createdAt: row.created_at
  }
}
export async function prepareHighValueMessage(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  customerId: string,
  commandId: string,
  raw: unknown,
  options: Options
) {
  const parsed = schema.safeParse(raw)
  if (!parsed.success || !uuid.safeParse(commandId).success || !uuid.safeParse(customerId).success)
    fail('invalid_input')
  const input = parsed.data
  await readHighValueConsent(db, claims, customerId, 'sms', options)
  if (!claims) fail('unavailable')
  const hash = await canonicalPayloadHash({
    customerId,
    actorId: claims.identityId,
    ...input,
    ...(options.requireSource ? { sourceVerified: true } : {})
  })
  const lookup = async () =>
    db.prepare('SELECT * FROM high_value_fallback_commands WHERE command_id=?').bind(commandId).first<Row>()
  const previous = await lookup()
  if (previous) {
    if (previous.payload_hash !== hash || previous.customer_id !== customerId) fail('conflict')
    await readHighValueConsent(db, claims, customerId, 'sms', options)
    return receipt(previous)
  }
  const event = await db
    .prepare('SELECT 1 FROM high_value_fallback_commands WHERE customer_id=? AND event_id=? AND channel=?')
    .bind(customerId, input.eventId, input.channel)
    .first()
  if (event) fail('conflict')
  let reason: 'consent_required' | 'budget_exceeded' | 'delivery_disabled'
  try {
    return await dispatchHighValueMessage(db, claims, customerId, commandId, input, options)
  } catch (cause) {
    if (
      !(cause instanceof HighValueDeliveryError) ||
      !['consent_required', 'budget_exceeded', 'delivery_disabled'].includes(cause.code)
    )
      throw cause
    reason = cause.code as typeof reason
  }
  const now = options.now?.() ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  try {
    await db.batch([
      db
        .prepare(
          'INSERT INTO high_value_fallback_commands(command_id,event_id,customer_id,channel,event_type,reason,actor_id,session_id,session_version,payload_hash,created_at,source_verified) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)'
        )
        .bind(
          commandId,
          input.eventId,
          customerId,
          input.channel,
          input.event,
          reason,
          claims.identityId,
          claims.sessionId,
          claims.sessionVersion,
          hash,
          now,
          options.requireSource ? 1 : 0
        )
    ])
  } catch (cause) {
    await readHighValueConsent(db, claims, customerId, 'sms', options)
    const raced = await lookup()
    if (raced) {
      if (raced.payload_hash !== hash || raced.customer_id !== customerId) fail('conflict')
      return receipt(raced)
    }
    if (cause instanceof Error && cause.message.includes('event_unavailable'))
      throw new HighValueSourceError('event_unavailable')
    fail('conflict')
  }
  const result = await lookup()
  await readHighValueConsent(db, claims, customerId, 'sms', options)
  if (!result) fail('unavailable')
  return receipt(result)
}

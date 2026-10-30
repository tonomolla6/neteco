import { z } from 'zod'
import type { VerifiedSessionClaims } from '../catalog/authorization'
import { canonicalPayloadHash } from '../catalog/cart'
import { catalogPolicyInstantSchema } from '../../shared/catalog-publication-policy'
import { HighValueConsentError } from './high-value-consent'
const uuid = z.string().uuid(),
  channelSchema = z.enum(['sms', 'whatsapp'])
const schema = z
  .object({
    channel: channelSchema,
    expectedVersion: z
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER - 1)
  })
  .strict()
type Options = { now?: () => string }
type Row = {
  command_id: string
  customer_id: string
  channel: string
  action: string
  payload_hash: string
  version: number
  created_at: string
}
const cte = `WITH clock AS MATERIALIZED (SELECT COALESCE(?1,strftime('%Y-%m-%dT%H:%M:%SZ','now')) now), owner AS MATERIALIZED (
 SELECT i.customer_id customerId,(i.email_verified_at IS NOT NULL AND i.email_verified_at<=(SELECT now FROM clock)) emailVerified
 FROM auth_sessions s JOIN identities i ON i.id=s.identity_id WHERE s.id=?2 AND s.identity_id=?3 AND s.session_version=?4
 AND i.session_version=s.session_version AND i.status IN('pending','active') AND s.revoked_at IS NULL
 AND s.created_at<=(SELECT now FROM clock) AND s.expires_at>(SELECT now FROM clock))`
function fail(code: HighValueConsentError['code']): never {
  throw new HighValueConsentError(code)
}
function params(claims: VerifiedSessionClaims | null, options: Options) {
  if (
    !claims ||
    !uuid.safeParse(claims.identityId).success ||
    !uuid.safeParse(claims.sessionId).success ||
    !Number.isSafeInteger(claims.sessionVersion) ||
    claims.sessionVersion < 1
  )
    fail('unauthenticated')
  const now = options.now?.() ?? null
  if (now !== null && !catalogPolicyInstantSchema.safeParse(now).success) fail('unavailable')
  return [now, claims.sessionId, claims.identityId, claims.sessionVersion]
}
async function owner(db: D1Database, claims: VerifiedSessionClaims | null, options: Options) {
  const row = await db
    .prepare(`${cte} SELECT * FROM owner`)
    .bind(...params(claims, options))
    .first<{ customerId: string | null; emailVerified: number }>()
  if (!row) fail('unauthenticated')
  if (!row.emailVerified) fail('email_unverified')
  if (!row.customerId) fail('forbidden')
  return row.customerId
}
function receipt(row: Row) {
  return {
    source: 'cloudflare' as const,
    commandId: row.command_id,
    channel: row.channel,
    action: row.action,
    version: row.version,
    createdAt: row.created_at
  }
}
export async function readOwnHighValueConsent(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  channel: string,
  options: Options = {}
) {
  if (!channelSchema.safeParse(channel).success) fail('invalid_input')
  const customerId = await owner(db, claims, options)
  const row = await db
    .prepare(
      `${cte} SELECT c.version,c.action FROM high_value_consent_commands c,owner WHERE owner.emailVerified=1 AND owner.customerId=c.customer_id AND c.channel=?5 ORDER BY c.version DESC LIMIT 1`
    )
    .bind(...params(claims, options), channel)
    .first<{ version: number; action: string }>()
  if ((await owner(db, claims, options)) !== customerId) fail('unauthenticated')
  return { source: 'cloudflare' as const, channel, version: row?.version ?? 0, granted: row?.action === 'grant' }
}
export async function revokeOwnHighValueConsent(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  commandId: string,
  raw: unknown,
  options: Options = {}
) {
  const parsed = schema.safeParse(raw)
  if (!parsed.success || !uuid.safeParse(commandId).success) fail('invalid_input')
  const customerId = await owner(db, claims, options)
  if (!claims) fail('unauthenticated')
  const value = parsed.data,
    hash = await canonicalPayloadHash({ purpose: 'self-opt-out', customerId, actorId: claims.identityId, ...value })
  const lookup = async () =>
    db.prepare('SELECT * FROM high_value_consent_commands WHERE command_id=?').bind(commandId).first<Row>()
  const previous = await lookup()
  if (previous) {
    if (previous.customer_id !== customerId || previous.payload_hash !== hash) fail('conflict')
    if ((await owner(db, claims, options)) !== customerId) fail('unauthenticated')
    return receipt(previous)
  }
  try {
    await db.batch([
      db
        .prepare(
          `${cte} INSERT INTO high_value_consent_commands(command_id,customer_id,channel,action,proof,actor_id,session_id,session_version,payload_hash,expected_version,version,created_at)
 SELECT ?5,customerId,?6,'revoke','account-optout-v1',?3,?2,?4,?7,?8,?8+1,(SELECT now FROM clock) FROM owner WHERE emailVerified=1 AND customerId=?9`
        )
        .bind(...params(claims, options), commandId, value.channel, hash, value.expectedVersion, customerId)
    ])
  } catch {
    if ((await owner(db, claims, options)) !== customerId) fail('unauthenticated')
    const raced = await lookup()
    if (raced) {
      if (raced.customer_id !== customerId || raced.payload_hash !== hash) fail('conflict')
      return receipt(raced)
    }
    const current = await readOwnHighValueConsent(db, claims, value.channel, options)
    if (current.version !== value.expectedVersion) fail('conflict')
    fail('unavailable')
  }
  const row = await lookup()
  if ((await owner(db, claims, options)) !== customerId) fail('unauthenticated')
  if (!row) fail('unavailable')
  return receipt(row)
}

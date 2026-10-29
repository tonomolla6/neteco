import { z } from 'zod'
import type { VerifiedSessionClaims } from '../catalog/authorization'
import { canonicalPayloadHash } from '../catalog/cart'
import { catalogPolicyInstantSchema } from '../../shared/catalog-publication-policy'

export class HighValueConsentError extends Error {
  constructor(
    readonly code:
      | 'invalid_input'
      | 'unauthenticated'
      | 'email_unverified'
      | 'mfa_required'
      | 'forbidden'
      | 'not_found'
      | 'conflict'
      | 'unavailable'
  ) {
    super(code)
  }
}
const uuid = z.string().uuid()
const channelSchema = z.enum(['sms', 'whatsapp'])
const inputSchema = z
  .object({
    channel: channelSchema,
    expectedVersion: z
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER - 1),
    action: z.enum(['grant', 'revoke']),
    proof: z.string().regex(/^[a-zA-Z0-9_-]{8,100}$/)
  })
  .strict()
type Options = { now?: () => string }
const cte = `WITH clock AS MATERIALIZED (SELECT COALESCE(?1,strftime('%Y-%m-%dT%H:%M:%SZ','now')) now), authority AS MATERIALIZED (
 SELECT i.id actorId,s.mfa_verified mfaVerified,(i.email_verified_at IS NOT NULL AND i.email_verified_at<=(SELECT now FROM clock)) emailVerified,
 EXISTS(SELECT 1 FROM customers WHERE id=?5) customerExists,
 EXISTS(SELECT 1 FROM identity_roles r JOIN role_permissions p ON p.role_code=r.role_code WHERE r.identity_id=i.id AND p.permission_code='administration.manage' AND r.granted_at<=(SELECT now FROM clock) AND (r.expires_at IS NULL OR r.expires_at>(SELECT now FROM clock))) permitted
 FROM auth_sessions s JOIN identities i ON i.id=s.identity_id WHERE s.id=?2 AND s.identity_id=?3 AND s.session_version=?4 AND i.session_version=s.session_version AND i.status IN('pending','active') AND s.revoked_at IS NULL AND s.created_at<=(SELECT now FROM clock) AND s.expires_at>(SELECT now FROM clock))`
const allowed = 'emailVerified=1 AND mfaVerified=1 AND permitted=1 AND customerExists=1'
function fail(code: HighValueConsentError['code']): never {
  throw new HighValueConsentError(code)
}
function params(claims: VerifiedSessionClaims | null, customerId: string, options: Options) {
  if (
    !claims ||
    !uuid.safeParse(claims.identityId).success ||
    !uuid.safeParse(claims.sessionId).success ||
    !Number.isSafeInteger(claims.sessionVersion) ||
    claims.sessionVersion < 1
  )
    fail('unauthenticated')
  if (!uuid.safeParse(customerId).success) fail('not_found')
  const now = options.now?.() ?? null
  if (now !== null && !catalogPolicyInstantSchema.safeParse(now).success) fail('unavailable')
  return [now, claims.sessionId, claims.identityId, claims.sessionVersion, customerId]
}
async function authority(db: D1Database, claims: VerifiedSessionClaims | null, customerId: string, options: Options) {
  const row = await db
    .prepare(`${cte} SELECT * FROM authority`)
    .bind(...params(claims, customerId, options))
    .first<{ actorId: string; emailVerified: number; mfaVerified: number; permitted: number; customerExists: number }>()
  if (!row) fail('unauthenticated')
  if (!row.emailVerified) fail('email_unverified')
  if (!row.mfaVerified) fail('mfa_required')
  if (!row.permitted) fail('forbidden')
  if (!row.customerExists) fail('not_found')
  return row
}
interface Stored {
  command_id: string
  customer_id: string
  channel: string
  action: string
  payload_hash: string
  version: number
  created_at: string
}
async function stored(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  customerId: string,
  commandId: string,
  options: Options
) {
  return db
    .prepare(`${cte} SELECT c.* FROM high_value_consent_commands c,authority WHERE ${allowed} AND c.command_id=?6`)
    .bind(...params(claims, customerId, options), commandId)
    .first<Stored>()
}
function receipt(row: Stored) {
  return {
    source: 'cloudflare' as const,
    commandId: row.command_id,
    customerId: row.customer_id,
    channel: row.channel,
    action: row.action,
    version: row.version,
    createdAt: row.created_at
  }
}
export async function readHighValueConsent(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  customerId: string,
  channel: string,
  options: Options = {}
) {
  if (!channelSchema.safeParse(channel).success) fail('invalid_input')
  await authority(db, claims, customerId, options)
  const row = await db
    .prepare(
      `${cte} SELECT c.version,c.action FROM high_value_consent_commands c,authority WHERE ${allowed} AND c.customer_id=?5 AND c.channel=?6 ORDER BY c.version DESC LIMIT 1`
    )
    .bind(...params(claims, customerId, options), channel)
    .first<{ version: number; action: string }>()
  await authority(db, claims, customerId, options)
  return {
    source: 'cloudflare' as const,
    customerId,
    channel,
    version: row?.version ?? 0,
    granted: row?.action === 'grant'
  }
}
export async function executeHighValueConsent(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  customerId: string,
  commandId: string,
  raw: unknown,
  options: Options = {}
) {
  const parsed = inputSchema.safeParse(raw)
  if (!parsed.success || !uuid.safeParse(commandId).success) fail('invalid_input')
  const actor = await authority(db, claims, customerId, options),
    input = parsed.data
  const hash = await canonicalPayloadHash({ customerId, actorId: actor.actorId, ...input })
  const previous = await stored(db, claims, customerId, commandId, options)
  if (previous) {
    if (previous.payload_hash !== hash || previous.customer_id !== customerId) fail('conflict')
    await authority(db, claims, customerId, options)
    return receipt(previous)
  }
  try {
    await db.batch([
      db
        .prepare(
          `${cte} INSERT INTO high_value_consent_commands(command_id,customer_id,channel,action,proof,actor_id,session_id,session_version,payload_hash,expected_version,version,created_at)
 SELECT ?6,?5,?7,?8,?9,actorId,?2,?4,?10,?11,?11+1,(SELECT now FROM clock) FROM authority WHERE ${allowed}`
        )
        .bind(
          ...params(claims, customerId, options),
          commandId,
          input.channel,
          input.action,
          input.proof,
          hash,
          input.expectedVersion
        )
    ])
  } catch {
    await authority(db, claims, customerId, options)
    const raced = await stored(db, claims, customerId, commandId, options)
    if (raced) {
      if (raced.payload_hash !== hash || raced.customer_id !== customerId) fail('conflict')
      await authority(db, claims, customerId, options)
      return receipt(raced)
    }
    const current = await readHighValueConsent(db, claims, customerId, input.channel, options)
    if (current.version !== input.expectedVersion) fail('conflict')
    fail('unavailable')
  }
  const result = await stored(db, claims, customerId, commandId, options)
  await authority(db, claims, customerId, options)
  if (!result) fail('unavailable')
  if (result.payload_hash !== hash || result.customer_id !== customerId) fail('conflict')
  return receipt(result)
}

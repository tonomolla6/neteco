import { z } from 'zod'
import type { VerifiedSessionClaims } from '../catalog/authorization'
import { canonicalPayloadHash } from '../catalog/cart'
import { catalogPolicyInstantSchema } from '../../shared/catalog-publication-policy'
import {
  ACCOUNT_PREFERENCES_POLICY_VERSION as POLICY,
  ACCOUNT_PREFERENCES_CONSENT_TEXT as TEXT,
  accountPreferencesInputSchema,
  accountPreferencesSnapshotSchema,
  accountPreferencesReceiptSchema,
  accountPreferencesCommandSchema
} from '../../shared/account-preferences'
export interface AccountPreferencesOptions {
  now?: () => string
}
export class AccountPreferencesError extends Error {
  constructor(
    readonly code:
      'invalid_input' | 'unauthenticated' | 'email_unverified' | 'mfa_required' | 'conflict' | 'unavailable'
  ) {
    super(code)
  }
}
function fail(code: AccountPreferencesError['code']): never {
  throw new AccountPreferencesError(code)
}
const uuid = z.string().uuid()
const cte = `WITH clock AS MATERIALIZED(SELECT COALESCE(?1,strftime('%Y-%m-%dT%H:%M:%SZ','now')) now),authority AS MATERIALIZED(
 SELECT c.id customerId,i.id actorId,
 (i.email_verified_at IS NOT NULL AND i.email_verified_at<=(SELECT now FROM clock)) emailVerified,
 (s.mfa_verified=1 OR NOT EXISTS(SELECT 1 FROM identity_mfa m WHERE m.identity_id=i.id AND m.verified_at IS NOT NULL)) mfaVerified
 FROM auth_sessions s JOIN identities i ON i.id=s.identity_id JOIN customers c ON c.id=i.customer_id
 WHERE s.id=?2 AND i.id=?3 AND s.session_version=?4 AND i.session_version=s.session_version
 AND c.status='active' AND i.status='active' AND s.revoked_at IS NULL AND s.created_at<=(SELECT now FROM clock) AND s.expires_at>(SELECT now FROM clock))`
const allowed = 'a.emailVerified=1 AND a.mfaVerified=1'
// Reuse the exact live authority inside dependent atomic D1 batches.
// Bindings ?1..?4 remain clock, session ID, identity ID and session version.
export { cte as accountPreferenceAuthoritySql, allowed as accountPreferenceAuthorityAllowedSql }
function params(claims: VerifiedSessionClaims | null, options: AccountPreferencesOptions) {
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
export async function authorizeD1AccountPreferences(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  options: AccountPreferencesOptions = {}
) {
  const raw = await db
    .prepare(`${cte} SELECT * FROM authority`)
    .bind(...params(claims, options))
    .first()
  if (raw === null) fail('unauthenticated')
  const parsed = z
    .object({
      customerId: uuid,
      actorId: uuid,
      emailVerified: z.union([z.literal(0), z.literal(1)]),
      mfaVerified: z.union([z.literal(0), z.literal(1)])
    })
    .strict()
    .safeParse(raw)
  if (!parsed.success) fail('unavailable')
  if (!parsed.data.emailVerified) fail('email_unverified')
  if (!parsed.data.mfaVerified) fail('mfa_required')
  return parsed.data
}
async function finalOwner(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  customerId: string,
  options: AccountPreferencesOptions
) {
  if ((await authorizeD1AccountPreferences(db, claims, options)).customerId !== customerId) fail('unauthenticated')
}
async function snapshot(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  customerId: string,
  options: AccountPreferencesOptions
) {
  const raw = await db
    .prepare(
      `${cte},preference_snapshot AS MATERIALIZED(
 SELECT COALESCE(p.version,0) version,COALESCE(p.product_updates,0) productUpdates,COALESCE(p.replenishment,0) replenishment,p.updated_at updatedAt,
 CASE WHEN p.customer_id IS NULL THEN 1 ELSE EXISTS(SELECT 1 FROM account_preference_commands c WHERE c.customer_id=p.customer_id AND c.command_id=p.command_id
 AND c.applied_version=p.version AND c.product_updates=p.product_updates AND c.replenishment=p.replenishment AND c.recorded_at=p.updated_at AND c.policy_version=?6) END confirmed
 FROM authority a LEFT JOIN customer_account_preferences p ON p.customer_id=a.customerId WHERE ${allowed} AND a.customerId=?5
 AND(p.updated_at IS NULL OR p.updated_at<=(SELECT now FROM clock))) SELECT * FROM preference_snapshot`
    )
    .bind(...params(claims, options), customerId, POLICY)
    .first()
  const parsed = z
    .object({
      version: z
        .number()
        .int()
        .min(0)
        .max(Number.MAX_SAFE_INTEGER - 1),
      productUpdates: z.union([z.literal(0), z.literal(1)]),
      replenishment: z.union([z.literal(0), z.literal(1)]),
      updatedAt: catalogPolicyInstantSchema.nullable(),
      confirmed: z.literal(1)
    })
    .strict()
    .safeParse(raw)
  if (!parsed.success) fail('unavailable')
  return accountPreferencesSnapshotSchema.parse({
    source: 'cloudflare',
    version: parsed.data.version,
    preferences: { product_updates: parsed.data.productUpdates === 1, replenishment: parsed.data.replenishment === 1 },
    policyVersion: POLICY,
    consentText: TEXT,
    updatedAt: parsed.data.updatedAt
  })
}
export async function readD1AccountPreferences(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  options: AccountPreferencesOptions = {}
) {
  const owner = await authorizeD1AccountPreferences(db, claims, options),
    value = await snapshot(db, claims, owner.customerId, options)
  await finalOwner(db, claims, owner.customerId, options)
  return value
}
const storedSchema = z
  .object({
    command_id: uuid,
    payload_hash: z.string().regex(/^[a-f0-9]{64}$/),
    expected_version: z.number().int().min(0),
    applied_version: z.number().int().min(1),
    product_updates: z.union([z.literal(0), z.literal(1)]),
    replenishment: z.union([z.literal(0), z.literal(1)]),
    policy_version: z.literal(POLICY),
    text_hash: z.string().regex(/^[a-f0-9]{64}$/),
    recorded_at: catalogPolicyInstantSchema
  })
  .strict()
async function stored(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  customerId: string,
  key: string,
  options: AccountPreferencesOptions
) {
  const raw = await db
    .prepare(
      `${cte},preference_receipt AS MATERIALIZED(
 SELECT c.command_id,c.payload_hash,c.expected_version,c.applied_version,c.product_updates,c.replenishment,c.policy_version,c.text_hash,c.recorded_at
 FROM account_preference_commands c,authority a WHERE ${allowed} AND a.customerId=?5 AND c.customer_id=a.customerId AND c.actor_id=a.actorId AND c.command_id=?6 AND c.recorded_at<=(SELECT now FROM clock)) SELECT * FROM preference_receipt`
    )
    .bind(...params(claims, options), customerId, key)
    .first()
  if (raw === null) return null
  const parsed = storedSchema.safeParse(raw)
  if (!parsed.success) fail('unavailable')
  const row = parsed.data,
    preferences = { product_updates: row.product_updates === 1, replenishment: row.replenishment === 1 }
  if ((await canonicalPayloadHash({ policyVersion: POLICY, consentText: TEXT, preferences })) !== row.text_hash)
    fail('unavailable')
  const receipt = accountPreferencesReceiptSchema.safeParse({
    source: 'cloudflare',
    commandId: row.command_id,
    expectedVersion: row.expected_version,
    version: row.applied_version,
    preferences,
    policyVersion: row.policy_version,
    textHash: row.text_hash,
    recordedAt: row.recorded_at
  })
  if (!receipt.success) fail('unavailable')
  return { hash: row.payload_hash, receipt: receipt.data }
}
export async function readD1AccountPreferenceCommand(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  key: string,
  options: AccountPreferencesOptions = {}
) {
  if (!uuid.safeParse(key).success) fail('invalid_input')
  const owner = await authorizeD1AccountPreferences(db, claims, options),
    value = await stored(db, claims, owner.customerId, key, options)
  await finalOwner(db, claims, owner.customerId, options)
  return accountPreferencesCommandSchema.parse({
    source: 'cloudflare',
    commandId: key,
    outcome: value ? 'applied' : 'unknown',
    receipt: value?.receipt ?? null
  })
}
export async function updateD1AccountPreferences(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  key: string,
  input: unknown,
  options: AccountPreferencesOptions = {}
) {
  const parsed = accountPreferencesInputSchema.safeParse(input)
  if (!parsed.success || !uuid.safeParse(key).success) fail('invalid_input')
  const owner = await authorizeD1AccountPreferences(db, claims, options),
    value = parsed.data,
    hash = await canonicalPayloadHash({ customerId: owner.customerId, actorId: owner.actorId, ...value }),
    previous = await stored(db, claims, owner.customerId, key, options)
  if (previous) {
    await finalOwner(db, claims, owner.customerId, options)
    if (previous.hash !== hash) fail('conflict')
    return previous.receipt
  }
  const current = await snapshot(db, claims, owner.customerId, options)
  if (current.version !== value.expectedVersion) fail('conflict')
  const textHash = await canonicalPayloadHash({
    policyVersion: POLICY,
    consentText: TEXT,
    preferences: value.preferences
  })
  try {
    const results = await db.batch([
      db
        .prepare(
          `${cte} INSERT INTO account_preference_commands(customer_id,command_id,actor_id,session_id,session_version,payload_hash,expected_version,applied_version,product_updates,replenishment,policy_version,text_hash,recorded_at)
 SELECT a.customerId,?6,a.actorId,?2,?4,?7,?8,?8+1,?9,?10,?11,?12,(SELECT now FROM clock) FROM authority a
 WHERE ${allowed} AND a.customerId=?5 AND COALESCE((SELECT version FROM customer_account_preferences WHERE customer_id=a.customerId),0)=?8`
        )
        .bind(
          ...params(claims, options),
          owner.customerId,
          key,
          hash,
          value.expectedVersion,
          value.preferences.product_updates ? 1 : 0,
          value.preferences.replenishment ? 1 : 0,
          POLICY,
          textHash
        )
    ])
    if (results.some((r) => r.success !== true)) fail('unavailable')
  } catch {
    /* A failed/lost response does not establish absence. Read the durable command. */
  }
  const recovered = await stored(db, claims, owner.customerId, key, options)
  await finalOwner(db, claims, owner.customerId, options)
  if (recovered) {
    if (recovered.hash !== hash) fail('conflict')
    return recovered.receipt
  }
  const fresh = await snapshot(db, claims, owner.customerId, options)
  await finalOwner(db, claims, owner.customerId, options)
  if (fresh.version !== value.expectedVersion) fail('conflict')
  fail('unavailable')
}

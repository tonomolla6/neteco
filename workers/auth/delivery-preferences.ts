import { z } from 'zod'
import type { VerifiedSessionClaims } from '../catalog/authorization'
import {
  authorizeD1AccountPreferences,
  AccountPreferencesError,
  type AccountPreferencesOptions
} from './account-preferences'
import { canonicalPayloadHash } from '../catalog/cart'
import { catalogPolicyInstantSchema as instant } from '../../shared/catalog-publication-policy'
import {
  DELIVERY_PREFERENCES_POLICY_VERSION as POLICY,
  DELIVERY_PREFERENCES_NOTICE_TEXT as TEXT,
  deliveryPreferencesInputSchema,
  deliveryPreferencesSnapshotSchema,
  deliveryPreferencesReceiptSchema,
  deliveryPreferencesCommandSchema,
  deliveryPreferenceIntentHash,
  type DeliveryPreferencesSnapshot,
  type DeliveryPreferencesReceipt,
  type DeliveryPreferencesCommand
} from '../../shared/delivery-preferences'
export type DeliveryPreferencesOptions = AccountPreferencesOptions
export class DeliveryPreferencesError extends Error {
  constructor(
    readonly code:
      | 'invalid_input'
      | 'unauthenticated'
      | 'email_unverified'
      | 'mfa_required'
      | 'conflict'
      | 'version_conflict'
      | 'unavailable'
  ) {
    super(code)
    this.name = 'DeliveryPreferencesError'
  }
}
function fail(code: DeliveryPreferencesError['code']): never {
  throw new DeliveryPreferencesError(code)
}
const uuid = z.string().uuid(),
  hash = z.string().regex(/^[a-f0-9]{64}$/)
function now(options: DeliveryPreferencesOptions) {
  const value = options.now?.() ?? null
  if (value !== null && !instant.safeParse(value).success) fail('unavailable')
  return value
}
async function authority(db: D1Database, claims: VerifiedSessionClaims | null, options: DeliveryPreferencesOptions) {
  try {
    return await authorizeD1AccountPreferences(db, claims, options)
  } catch (cause) {
    if (cause instanceof AccountPreferencesError) fail(cause.code)
    return fail('unavailable')
  }
}
async function finalOwner(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  customerId: string,
  options: DeliveryPreferencesOptions
) {
  if ((await authority(db, claims, options)).customerId !== customerId) fail('unauthenticated')
}
/** Arguments are trusted code-owned expressions, never request inputs. Shared
 * with the atomic operational sender/suppression boundary, not a second policy. */
export function deliveryPreferenceProjectionProofSql(customerIdSql: string, p = 'p') {
  return `((${p}.customer_id IS NULL AND NOT EXISTS(SELECT 1 FROM delivery_preference_commands WHERE customer_id=${customerIdSql})) OR
   (${p}.customer_id=${customerIdSql} AND EXISTS(SELECT 1 FROM delivery_preference_commands c
    WHERE c.customer_id=${p}.customer_id AND c.command_id=${p}.command_id AND c.applied_version=${p}.version
    AND c.delivery_updates=${p}.delivery_updates AND c.recorded_at=${p}.updated_at AND c.policy_version='${POLICY}')
    AND (SELECT count(*) FROM delivery_preference_commands WHERE customer_id=${customerIdSql})=${p}.version
    AND NOT EXISTS(SELECT 1 FROM delivery_preference_commands c WHERE c.customer_id=${customerIdSql}
      AND (c.applied_version>${p}.version OR c.recorded_at>${p}.updated_at))))`
}
const storedSchema = z
  .object({
    command_id: uuid,
    payload_hash: hash,
    expected_version: z.number().int().min(0),
    applied_version: z.number().int().min(1),
    delivery_updates: z.union([z.literal(0), z.literal(1)]),
    policy_version: z.literal(POLICY),
    text_hash: hash,
    recorded_at: instant
  })
  .strict()
type Stored = z.infer<typeof storedSchema>
async function checkedReceipt(raw: unknown) {
  const parsed = storedSchema.safeParse(raw)
  if (!parsed.success) return fail('unavailable')
  const row = parsed.data,
    input = {
      expectedVersion: row.expected_version,
      deliveryUpdates: row.delivery_updates === 1,
      policyVersion: POLICY
    }
  if (
    (await deliveryPreferenceIntentHash(input)) !== row.payload_hash ||
    (await canonicalPayloadHash({
      policyVersion: POLICY,
      noticeText: TEXT,
      deliveryUpdates: input.deliveryUpdates
    })) !== row.text_hash
  )
    fail('unavailable')
  const receipt = deliveryPreferencesReceiptSchema.safeParse({
    source: 'cloudflare',
    commandId: row.command_id,
    expectedVersion: row.expected_version,
    version: row.applied_version,
    deliveryUpdates: input.deliveryUpdates,
    policyVersion: POLICY,
    textHash: row.text_hash,
    recordedAt: row.recorded_at
  })
  if (!receipt.success) return fail('unavailable')
  return { hash: row.payload_hash, receipt: receipt.data }
}
const columns =
  'command_id,payload_hash,expected_version,applied_version,delivery_updates,policy_version,text_hash,recorded_at'
async function snapshot(
  db: D1Database,
  customerId: string,
  options: DeliveryPreferencesOptions
): Promise<DeliveryPreferencesSnapshot> {
  const raw = await db
    .prepare(
      `WITH delivery_clock AS MATERIALIZED(SELECT COALESCE(?2,strftime('%Y-%m-%dT%H:%M:%SZ','now')) now)
    SELECT COALESCE(p.version,0) version,COALESCE(p.delivery_updates,1) deliveryUpdates,p.updated_at updatedAt,
    ${deliveryPreferenceProjectionProofSql('owner.id')} confirmed,
    (SELECT json_object('command_id',c.command_id,'payload_hash',c.payload_hash,'expected_version',c.expected_version,
      'applied_version',c.applied_version,'delivery_updates',c.delivery_updates,'policy_version',c.policy_version,
      'text_hash',c.text_hash,'recorded_at',c.recorded_at) FROM delivery_preference_commands c WHERE c.customer_id=owner.id AND c.command_id=p.command_id) proof
    FROM customers owner LEFT JOIN delivery_preferences p ON p.customer_id=owner.id WHERE owner.id=?1
    AND (p.updated_at IS NULL OR p.updated_at<=(SELECT now FROM delivery_clock))`
    )
    .bind(customerId, now(options))
    .first()
  const parsed = z
    .object({
      version: z
        .number()
        .int()
        .min(0)
        .max(Number.MAX_SAFE_INTEGER - 1),
      deliveryUpdates: z.union([z.literal(0), z.literal(1)]),
      updatedAt: instant.nullable(),
      confirmed: z.literal(1),
      proof: z.string().nullable()
    })
    .strict()
    .safeParse(raw)
  if (!parsed.success) return fail('unavailable')
  if (parsed.data.proof !== null) await checkedReceipt(JSON.parse(parsed.data.proof))
  const result = deliveryPreferencesSnapshotSchema.safeParse({
    source: 'cloudflare',
    version: parsed.data.version,
    deliveryUpdates: parsed.data.deliveryUpdates === 1,
    policyVersion: POLICY,
    noticeText: TEXT,
    updatedAt: parsed.data.updatedAt
  })
  if (!result.success) return fail('unavailable')
  return result.data
}
async function stored(
  db: D1Database,
  customerId: string,
  actorId: string,
  key: string,
  options: DeliveryPreferencesOptions
) {
  const raw = await db
    .prepare(
      `SELECT ${columns} FROM delivery_preference_commands WHERE customer_id=?1 AND actor_id=?2 AND command_id=?3
    AND recorded_at<=COALESCE(?4,strftime('%Y-%m-%dT%H:%M:%SZ','now'))`
    )
    .bind(customerId, actorId, key, now(options))
    .first<Stored>()
  if (raw === null) {
    if (
      await db
        .prepare(
          'SELECT 1 present FROM delivery_preference_commands WHERE customer_id=?1 AND actor_id=?2 AND command_id=?3'
        )
        .bind(customerId, actorId, key)
        .first()
    )
      fail('unavailable')
    return null
  }
  return checkedReceipt(raw)
}
async function boundary<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (cause) {
    if (cause instanceof DeliveryPreferencesError) throw cause
    return fail('unavailable')
  }
}
export async function readD1DeliveryPreferences(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  options: DeliveryPreferencesOptions = {}
): Promise<DeliveryPreferencesSnapshot> {
  return boundary(async () => {
    const owner = await authority(db, claims, options),
      value = await snapshot(db, owner.customerId, options)
    await finalOwner(db, claims, owner.customerId, options)
    return value
  })
}
export async function readD1DeliveryPreferenceCommand(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  key: string,
  payloadHash: string,
  options: DeliveryPreferencesOptions = {}
): Promise<DeliveryPreferencesCommand> {
  return boundary(async () => {
    if (!uuid.safeParse(key).success || !hash.safeParse(payloadHash).success) fail('invalid_input')
    const owner = await authority(db, claims, options)
    await snapshot(db, owner.customerId, options)
    const value = await stored(db, owner.customerId, owner.actorId, key, options)
    await finalOwner(db, claims, owner.customerId, options)
    if (value && value.hash !== payloadHash) fail('conflict')
    return deliveryPreferencesCommandSchema.parse({
      source: 'cloudflare',
      commandId: key,
      outcome: value ? 'applied' : 'unknown',
      receipt: value?.receipt ?? null
    })
  })
}
export async function updateD1DeliveryPreferences(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  key: string,
  input: unknown,
  options: DeliveryPreferencesOptions = {}
): Promise<DeliveryPreferencesReceipt> {
  return boundary(async () => {
    const parsed = deliveryPreferencesInputSchema.safeParse(input)
    if (!parsed.success || !uuid.safeParse(key).success) fail('invalid_input')
    const owner = await authority(db, claims, options),
      value = parsed.data,
      payloadHash = await deliveryPreferenceIntentHash(value)
    const current = await snapshot(db, owner.customerId, options),
      previous = await stored(db, owner.customerId, owner.actorId, key, options)
    if (previous) {
      await finalOwner(db, claims, owner.customerId, options)
      if (previous.hash !== payloadHash) fail('conflict')
      return previous.receipt
    }
    const collision = await db
      .prepare('SELECT 1 present FROM delivery_preference_commands WHERE customer_id=?1 AND command_id=?2')
      .bind(owner.customerId, key)
      .first()
    await finalOwner(db, claims, owner.customerId, options)
    if (collision) fail('conflict')
    if (current.version !== value.expectedVersion) fail('version_conflict')
    const textHash = await canonicalPayloadHash({
      policyVersion: POLICY,
      noticeText: TEXT,
      deliveryUpdates: value.deliveryUpdates
    })
    try {
      const result = await db.batch([
        db
          .prepare(
            `WITH delivery_clock AS MATERIALIZED(SELECT COALESCE(?1,strftime('%Y-%m-%dT%H:%M:%SZ','now')) now)
       INSERT INTO delivery_preference_commands(customer_id,command_id,actor_id,session_id,session_version,payload_hash,expected_version,applied_version,delivery_updates,policy_version,text_hash,recorded_at)
       SELECT ?2,?3,?4,?5,?6,?7,?8,?8+1,?9,?10,?11,(SELECT now FROM delivery_clock)
       FROM customers owner LEFT JOIN delivery_preferences p ON p.customer_id=owner.id WHERE owner.id=?2
       AND ${deliveryPreferenceProjectionProofSql('owner.id')}`
          )
          .bind(
            now(options),
            owner.customerId,
            key,
            owner.actorId,
            claims!.sessionId,
            claims!.sessionVersion,
            payloadHash,
            value.expectedVersion,
            value.deliveryUpdates ? 1 : 0,
            POLICY,
            textHash
          )
      ])
      if (result.some((item) => item.success !== true)) fail('unavailable')
    } catch {
      /* A lost/failed response is resolved only by durable evidence. */
    }
    const recovered = await stored(db, owner.customerId, owner.actorId, key, options)
    await finalOwner(db, claims, owner.customerId, options)
    if (recovered) {
      if (recovered.hash !== payloadHash) fail('conflict')
      return recovered.receipt
    }
    const fresh = await snapshot(db, owner.customerId, options)
    await finalOwner(db, claims, owner.customerId, options)
    if (
      await db
        .prepare('SELECT 1 present FROM delivery_preference_commands WHERE customer_id=?1 AND command_id=?2')
        .bind(owner.customerId, key)
        .first()
    )
      fail('conflict')
    await finalOwner(db, claims, owner.customerId, options)
    if (fresh.version !== value.expectedVersion) fail('version_conflict')
    return fail('unavailable')
  })
}

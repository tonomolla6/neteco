import { z } from 'zod'
import type { VerifiedSessionClaims } from '../catalog/authorization'
import { canonicalPayloadHash } from '../catalog/cart'
import { catalogPolicyInstantSchema } from '../../shared/catalog-publication-policy'
import {
  PREFERENCE_CENTER_CONSENT_TEXT as TEXT,
  PREFERENCE_CENTER_POLICY_VERSION as POLICY,
  preferenceCenterInputSchema,
  preferenceCenterReceiptSchema,
  preferenceCenterSnapshotSchema,
  type PreferenceCenterValues
} from '../../shared/preference-center'
import {
  boolInt,
  customerAuthority,
  finalCustomer,
  lifecycleBindings,
  lifecycleFail,
  lifecycleNow,
  lifecycleUuid,
  type AccountLifecycleOptions
} from './account-lifecycle-core'

const syncStatuses = z.enum(['pending', 'synced', 'failed', 'superseded'])
const rowSchema = z
  .object({
    version: z.number().int().min(0),
    frequency: z.enum(['weekly', 'biweekly', 'monthly', 'quarterly', 'never']),
    topics: z.string(),
    sectors: z.string(),
    channel_email: z.union([z.literal(0), z.literal(1)]),
    channel_sms: z.union([z.literal(0), z.literal(1)]),
    channel_push: z.union([z.literal(0), z.literal(1)]),
    unsubscribe_all: z.union([z.literal(0), z.literal(1)]),
    at: catalogPolicyInstantSchema.nullable(),
    esp: syncStatuses.nullable(),
    cmp: syncStatuses.nullable()
  })
  .strict()
function values(row: z.infer<typeof rowSchema>): PreferenceCenterValues {
  try {
    return preferenceCenterInputSchema.shape.preferences.parse({
      frequency: row.frequency,
      topics: JSON.parse(row.topics),
      sectors: JSON.parse(row.sectors),
      channels: { email: row.channel_email === 1, sms: row.channel_sms === 1, push: row.channel_push === 1 },
      unsubscribeAll: row.unsubscribe_all === 1
    })
  } catch {
    return lifecycleFail('unavailable')
  }
}
const syncOf = (row: z.infer<typeof rowSchema>) => ({ esp: row.esp, cmp: row.cmp })
async function currentRow(db: D1Database, customerId: string) {
  const raw = await db
    .prepare(
      `SELECT p.version,p.frequency,p.topics,p.sectors,p.channel_email,p.channel_sms,p.channel_push,p.unsubscribe_all,p.updated_at at,
 (SELECT status FROM preference_center_sync_jobs j WHERE j.customer_id=p.customer_id AND j.command_id=p.command_id AND j.target='esp') esp,
 (SELECT status FROM preference_center_sync_jobs j WHERE j.customer_id=p.customer_id AND j.command_id=p.command_id AND j.target='cmp') cmp
 FROM customer_preference_center p WHERE p.customer_id=?1`
    )
    .bind(customerId)
    .first()
  if (raw === null) return null
  const parsed = rowSchema.safeParse(raw)
  if (!parsed.success) return lifecycleFail('unavailable')
  return parsed.data
}
export const EMPTY_PREFERENCES: PreferenceCenterValues = {
  frequency: 'never',
  topics: [],
  sectors: [],
  channels: { email: false, sms: false, push: false },
  unsubscribeAll: false
}
function toSnapshot(row: z.infer<typeof rowSchema> | null) {
  return preferenceCenterSnapshotSchema.parse({
    source: 'cloudflare',
    version: row?.version ?? 0,
    preferences: row ? values(row) : EMPTY_PREFERENCES,
    policyVersion: POLICY,
    consentText: TEXT,
    updatedAt: row?.at ?? null,
    sync: row ? syncOf(row) : { esp: null, cmp: null }
  })
}
export async function readD1PreferenceCenter(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  options: AccountLifecycleOptions = {}
) {
  const owner = await customerAuthority(db, claims, options),
    snapshot = toSnapshot(await currentRow(db, owner.customerId))
  await finalCustomer(db, claims, owner.customerId, options)
  return snapshot
}
async function stored(db: D1Database, customerId: string, actorId: string, key: string) {
  const raw = await db
    .prepare(
      `SELECT c.payload_hash hash,c.expected_version,c.applied_version version,c.frequency,c.topics,c.sectors,c.channel_email,c.channel_sms,c.channel_push,
 c.unsubscribe_all,c.recorded_at at,
 (SELECT status FROM preference_center_sync_jobs j WHERE j.customer_id=c.customer_id AND j.command_id=c.command_id AND j.target='esp') esp,
 (SELECT status FROM preference_center_sync_jobs j WHERE j.customer_id=c.customer_id AND j.command_id=c.command_id AND j.target='cmp') cmp
 FROM preference_center_commands c WHERE c.customer_id=?1 AND c.command_id=?2 AND c.actor_id=?3`
    )
    .bind(customerId, key, actorId)
    .first<Record<string, unknown>>()
  if (raw === null) return null
  const { hash, expected_version: expectedVersion, ...rest } = raw,
    parsed = rowSchema.safeParse(rest)
  if (!parsed.success || typeof hash !== 'string' || typeof expectedVersion !== 'number')
    return lifecycleFail('unavailable')
  const receipt = preferenceCenterReceiptSchema.safeParse({
    source: 'cloudflare',
    commandId: key,
    expectedVersion,
    version: parsed.data.version,
    preferences: values(parsed.data),
    policyVersion: POLICY,
    recordedAt: parsed.data.at,
    sync: syncOf(parsed.data)
  })
  if (!receipt.success) return lifecycleFail('unavailable')
  return { hash, receipt: receipt.data }
}
/** A consent is "new" when a channel or topic switches on that was not on before. */
function newlyEnabled(before: PreferenceCenterValues, after: PreferenceCenterValues) {
  return (
    (['email', 'sms', 'push'] as const).some((c) => after.channels[c] && !before.channels[c]) ||
    after.topics.some((t) => !before.topics.includes(t))
  )
}
export async function updateD1PreferenceCenter(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  key: string,
  input: unknown,
  options: AccountLifecycleOptions = {}
) {
  const parsed = preferenceCenterInputSchema.safeParse(input)
  if (!parsed.success || !lifecycleUuid.safeParse(key).success) return lifecycleFail('invalid_input')
  const value = parsed.data,
    owner = await customerAuthority(db, claims, options),
    hash = await canonicalPayloadHash({ customerId: owner.customerId, actorId: owner.actorId, ...value }),
    previous = await stored(db, owner.customerId, owner.actorId, key)
  if (previous) {
    await finalCustomer(db, claims, owner.customerId, options)
    if (previous.hash !== hash) return lifecycleFail('conflict')
    return previous.receipt
  }
  const row = await currentRow(db, owner.customerId),
    current = toSnapshot(row)
  if (current.version !== value.expectedVersion) return lifecycleFail('conflict')
  if (newlyEnabled(current.preferences, value.preferences) && !value.acknowledged)
    return lifecycleFail('consent_required')
  const p = value.preferences,
    now = lifecycleNow(options)
  try {
    await db
      .prepare(
        `INSERT INTO preference_center_commands(customer_id,command_id,actor_id,session_id,session_version,payload_hash,expected_version,applied_version,
 frequency,topics,sectors,channel_email,channel_sms,channel_push,unsubscribe_all,policy_version,recorded_at)
 VALUES(?5,?6,?3,?2,?4,?7,?8,?8+1,?9,?10,?11,?12,?13,?14,?15,?16,?1)`
      )
      .bind(
        ...lifecycleBindings(claims, now),
        owner.customerId,
        key,
        hash,
        value.expectedVersion,
        p.frequency,
        JSON.stringify(p.topics),
        JSON.stringify(p.sectors),
        boolInt(p.channels.email),
        boolInt(p.channels.sms),
        boolInt(p.channels.push),
        boolInt(p.unsubscribeAll),
        POLICY
      )
      .run()
  } catch {
    /* A lost response proves nothing: read the durable command below. */
  }
  const recovered = await stored(db, owner.customerId, owner.actorId, key)
  await finalCustomer(db, claims, owner.customerId, options)
  if (recovered) {
    if (recovered.hash !== hash) return lifecycleFail('conflict')
    return recovered.receipt
  }
  const fresh = toSnapshot(await currentRow(db, owner.customerId))
  return lifecycleFail(fresh.version !== value.expectedVersion ? 'conflict' : 'unavailable')
}

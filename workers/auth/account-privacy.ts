import { z } from 'zod'
import type { VerifiedSessionClaims } from '../catalog/authorization'
import { canonicalPayloadHash } from '../catalog/cart'
import { catalogPolicyInstantSchema } from '../../shared/catalog-publication-policy'
import {
  accountPrivacyInputSchema,
  accountPrivacyRequestSchema,
  accountPrivacyResponseSchema,
  accountPrivacyCommandSchema,
  accountPrivacyExportSchema
} from '../../shared/account-privacy'
export interface AccountPrivacyOptions {
  now?: () => string
}
export class AccountPrivacyError extends Error {
  constructor(
    readonly code:
      | 'invalid_input'
      | 'unauthenticated'
      | 'email_unverified'
      | 'customer_required'
      | 'not_found'
      | 'conflict'
      | 'unavailable'
      | 'export_too_large'
  ) {
    super(code)
  }
}
function fail(code: AccountPrivacyError['code']): never {
  throw new AccountPrivacyError(code)
}
const uuid = z.string().uuid()
const cte = `WITH clock AS MATERIALIZED(SELECT COALESCE(?1,strftime('%Y-%m-%dT%H:%M:%SZ','now')) now), authority AS MATERIALIZED(
 SELECT i.id actorId,i.customer_id customerId,i.email,c.name,c.phone,c.status customerStatus,c.created_at createdAt,
 (i.email_verified_at IS NOT NULL AND i.email_verified_at<=(SELECT now FROM clock)) emailVerified
 FROM auth_sessions s JOIN identities i ON i.id=s.identity_id LEFT JOIN customers c ON c.id=i.customer_id AND c.status='active'
 WHERE s.id=?2 AND i.id=?3 AND s.session_version=?4 AND i.session_version=s.session_version AND i.status='active'
 AND s.revoked_at IS NULL AND s.created_at<=(SELECT now FROM clock) AND s.expires_at>(SELECT now FROM clock))`
const allowed = "emailVerified=1 AND customerStatus='active' AND customerId=?5"
function params(claims: VerifiedSessionClaims | null, options: AccountPrivacyOptions) {
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
async function authority(db: D1Database, claims: VerifiedSessionClaims | null, options: AccountPrivacyOptions) {
  const row = await db
    .prepare(`${cte} SELECT * FROM authority`)
    .bind(...params(claims, options))
    .first<{ customerId: string | null; emailVerified: number; customerStatus: string | null }>()
  if (!row) fail('unauthenticated')
  if (row.emailVerified !== 1) fail('email_unverified')
  if (!row.customerId || row.customerStatus !== 'active') fail('customer_required')
  return row.customerId
}
const fields =
  'r.id,r.command_id commandId,r.request_type requestType,r.status,r.requested_at requestedAt,r.due_at dueAt,r.completed_at completedAt'
async function stored(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  customer: string,
  key: string,
  options: AccountPrivacyOptions
) {
  return db
    .prepare(
      `${cte} SELECT ${fields},r.payload_hash payloadHash FROM account_privacy_requests r,authority WHERE ${allowed} AND r.customer_id=customerId AND r.command_id=?6`
    )
    .bind(...params(claims, options), customer, key)
    .first<Record<string, unknown>>()
}
function receipt(row: Record<string, unknown>) {
  const { payloadHash: _, ...value } = row
  return accountPrivacyRequestSchema.parse(value)
}
export async function readD1AccountPrivacy(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  options: AccountPrivacyOptions = {}
) {
  const customer = await authority(db, claims, options)
  const row = await db
    .prepare(
      `${cte}, page AS MATERIALIZED(SELECT ${fields} FROM account_privacy_requests r WHERE r.customer_id=?5 ORDER BY r.requested_at DESC,r.id DESC LIMIT 201)
 SELECT (SELECT json_group_array(json_object('id',id,'commandId',commandId,'requestType',requestType,'status',status,'requestedAt',requestedAt,'dueAt',dueAt,'completedAt',completedAt)) FROM page) requests FROM authority WHERE ${allowed}`
    )
    .bind(...params(claims, options), customer)
    .first<{ requests: string }>()
  if (!row) {
    await authority(db, claims, options)
    fail('unavailable')
  }
  const requests = JSON.parse(row.requests)
  if (requests.length > 200) fail('export_too_large')
  if ((await authority(db, claims, options)) !== customer) fail('unauthenticated')
  return accountPrivacyResponseSchema.parse({ source: 'cloudflare', requests })
}
export async function readD1AccountPrivacyCommand(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  key: string,
  options: AccountPrivacyOptions = {}
) {
  if (!uuid.safeParse(key).success) fail('invalid_input')
  const customer = await authority(db, claims, options),
    row = await stored(db, claims, customer, key, options)
  if ((await authority(db, claims, options)) !== customer) fail('unauthenticated')
  return accountPrivacyCommandSchema.parse({
    source: 'cloudflare',
    commandId: key,
    outcome: row ? 'applied' : 'unknown',
    receipt: row ? receipt(row) : null
  })
}
export async function executeD1AccountPrivacy(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  input: unknown,
  options: AccountPrivacyOptions = {}
) {
  const parsed = accountPrivacyInputSchema.safeParse(input)
  if (!parsed.success) fail('invalid_input')
  const customer = await authority(db, claims, options),
    value = parsed.data,
    hash = await canonicalPayloadHash({ customerId: customer, requestType: value.requestType }),
    previous = await stored(db, claims, customer, value.idempotencyKey, options)
  if (previous) {
    if (previous.payloadHash !== hash) fail('conflict')
    const recovered = await readD1AccountPrivacyCommand(db, claims, value.idempotencyKey, options)
    if (recovered.outcome !== 'applied') fail('unavailable')
    return recovered.receipt!
  }
  try {
    await db.batch([
      db
        .prepare(
          `${cte} INSERT INTO account_privacy_requests(id,customer_id,actor_id,session_id,session_version,command_id,payload_hash,request_type,status,requested_at,due_at,completed_at)
 SELECT ?6,customerId,actorId,?2,?4,?7,?8,?9,CASE WHEN ?9='export' THEN 'completed' ELSE 'requested' END,(SELECT now FROM clock),strftime('%Y-%m-%dT%H:%M:%SZ',(SELECT now FROM clock),'+30 days'),CASE WHEN ?9='export' THEN (SELECT now FROM clock) ELSE NULL END FROM authority WHERE ${allowed}`
        )
        .bind(...params(claims, options), customer, crypto.randomUUID(), value.idempotencyKey, hash, value.requestType)
    ])
  } catch {
    if ((await authority(db, claims, options)) !== customer) fail('unauthenticated')
    const raced = await stored(db, claims, customer, value.idempotencyKey, options)
    if (!raced) fail('unavailable')
    if (raced.payloadHash !== hash) fail('conflict')
  }
  const result = await readD1AccountPrivacyCommand(db, claims, value.idempotencyKey, options)
  if (result.outcome !== 'applied') fail('unavailable')
  return result.receipt!
}
export async function downloadD1AccountPrivacy(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  id: string,
  options: AccountPrivacyOptions = {}
) {
  if (!uuid.safeParse(id).success) fail('not_found')
  const customer = await authority(db, claims, options)
  const row = await db
    .prepare(
      `${cte}, owner AS MATERIALIZED(SELECT * FROM authority WHERE ${allowed}),
 addresses AS MATERIALIZED(SELECT * FROM customer_addresses WHERE customer_id=?5 ORDER BY created_at,id LIMIT 1001),
 orders_page AS MATERIALIZED(SELECT * FROM orders WHERE customer_id=?5 ORDER BY created_at,id LIMIT 1001),
 subscriptions AS MATERIALIZED(SELECT s.* FROM newsletter_subscriptions s,owner WHERE s.email_normalized=lower(owner.email)),
 consents AS MATERIALIZED(SELECT e.* FROM newsletter_consent_events e JOIN subscriptions s ON s.id=e.subscription_id ORDER BY e.occurred_at,e.id LIMIT 1001),
 favorites AS MATERIALIZED(SELECT l.name listName,v.sku,i.quantity,i.created_at FROM customer_favorite_lists l JOIN customer_favorite_items i ON i.list_id=l.id JOIN variants v ON v.id=i.variant_id WHERE l.customer_id=?5 ORDER BY l.id,i.variant_id LIMIT 1001),
 security_notices AS MATERIALIZED(SELECT s.kind,s.recipient,s.audience,s.created_at FROM identity_account_security_events s,owner WHERE s.identity_id=owner.actorId ORDER BY s.created_at,s.id LIMIT 1001)
 SELECT json_object('schemaVersion',1,'exportedAt',(SELECT now FROM clock),
 'securityNotices',json((SELECT json_group_array(json_object('kind',kind,'recipient',recipient,'audience',audience,'createdAt',created_at)) FROM security_notices)),
 'deliveryPreferences',json((SELECT json_object('version',p.version,'deliveryUpdates',json(CASE p.delivery_updates WHEN 1 THEN 'true' ELSE 'false' END),'updatedAt',p.updated_at) FROM delivery_preferences p WHERE p.customer_id=owner.customerId)),
 'accountPreferences',json((SELECT json_object('version',p.version,'product_updates',json(CASE p.product_updates WHEN 1 THEN 'true' ELSE 'false' END),'replenishment',json(CASE p.replenishment WHEN 1 THEN 'true' ELSE 'false' END),'updatedAt',p.updated_at) FROM customer_account_preferences p WHERE p.customer_id=owner.customerId)),
 'profile',json_object('email',email,'name',name,'phone',phone,'status',customerStatus,'createdAt',createdAt),
 'addresses',json((SELECT json_group_array(json_object('kind',kind,'label',label,'recipientName',recipient_name,'companyName',company_name,'taxId',tax_id,'line1',line1,'line2',line2,'postalCode',postal_code,'city',city,'region',region,'countryCode',country_code,'phone',phone,'instructions',instructions,'isDefault',json(CASE is_default WHEN 1 THEN 'true' ELSE 'false' END))) FROM addresses)),
 'orders',json((SELECT json_group_array(json_object('id',id,'orderStatus',status,'totalCents',total_gross_cents,'currency',currency,'createdAt',created_at)) FROM orders_page)),
 'consents',json((SELECT json_group_array(json_object('purpose',purpose,'action',event_type,'policyVersion',consent_version,'consentText',consent_text,'source',consent_source,'occurredAt',occurred_at)) FROM consents)),
 'preferences',json((SELECT json_group_array(json_object('status',s.status,'frequency',json_extract(p.document,'$.frequency'),'topics',json_extract(p.document,'$.topics'),'locale',json_extract(p.document,'$.locale'),'updatedAt',p.updated_at)) FROM subscriptions s LEFT JOIN newsletter_editorial_preferences p ON p.subscription_id=s.id)),
 'favorites',json((SELECT json_group_array(json_object('listName',listName,'sku',sku,'quantity',quantity,'createdAt',created_at)) FROM favorites))) document
 FROM owner WHERE EXISTS(SELECT 1 FROM account_privacy_requests r WHERE r.id=?6 AND r.customer_id=owner.customerId AND r.request_type='export' AND r.status='completed')`
    )
    .bind(...params(claims, options), customer, id)
    .first<{ document: string }>()
  if (!row) {
    await authority(db, claims, options)
    fail('not_found')
  }
  if (new TextEncoder().encode(row.document).length > 2 * 1024 * 1024) fail('export_too_large')
  const value = JSON.parse(row.document)
  for (const section of ['addresses', 'orders', 'consents', 'favorites', 'securityNotices'])
    if (value[section].length > 1000) fail('export_too_large')
  if ((await authority(db, claims, options)) !== customer) fail('unauthenticated')
  return accountPrivacyExportSchema.parse(value)
}

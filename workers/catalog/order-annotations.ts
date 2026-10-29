import { z } from 'zod'
import type { VerifiedSessionClaims } from './authorization'
import { canonicalPayloadHash } from './cart'
import { catalogPolicyInstantSchema } from '../../shared/catalog-publication-policy'
import {
  orderAnnotationsInputSchema,
  orderAnnotationsResponseSchema,
  orderAnnotationsReceiptSchema,
  orderAnnotationCommandSchema,
  type OrderAnnotationsReceipt
} from '../../shared/order-annotations'
export interface OrderAnnotationsOptions {
  now?: () => string
}
export class OrderAnnotationsError extends Error {
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
function fail(code: OrderAnnotationsError['code']): never {
  throw new OrderAnnotationsError(code)
}
const uuid = z.string().uuid()
const cte = `WITH clock AS MATERIALIZED (SELECT COALESCE(?1,strftime('%Y-%m-%dT%H:%M:%SZ','now')) AS now), authority AS MATERIALIZED (
 SELECT i.id actorId,s.mfa_verified mfaVerified,(i.email_verified_at IS NOT NULL AND i.email_verified_at<=(SELECT now FROM clock)) emailVerified,
 EXISTS(SELECT 1 FROM orders WHERE id=?5) orderExists,
 EXISTS(SELECT 1 FROM identity_roles r JOIN role_permissions p ON p.role_code=r.role_code
 WHERE r.identity_id=i.id AND p.permission_code='administration.manage' AND r.granted_at<=(SELECT now FROM clock)
 AND(r.expires_at IS NULL OR r.expires_at>(SELECT now FROM clock))) permitted
 FROM auth_sessions s JOIN identities i ON i.id=s.identity_id WHERE s.id=?2 AND s.identity_id=?3 AND s.session_version=?4
 AND i.session_version=s.session_version AND i.status IN('pending','active') AND s.revoked_at IS NULL
 AND s.created_at<=(SELECT now FROM clock) AND s.expires_at>(SELECT now FROM clock))`
const allowed = 'emailVerified=1 AND mfaVerified=1 AND permitted=1 AND orderExists=1'
function params(claims: VerifiedSessionClaims | null, orderId: string, options: OrderAnnotationsOptions) {
  if (
    !claims ||
    !uuid.safeParse(claims.identityId).success ||
    !uuid.safeParse(claims.sessionId).success ||
    !Number.isSafeInteger(claims.sessionVersion) ||
    claims.sessionVersion < 1
  )
    fail('unauthenticated')
  if (!uuid.safeParse(orderId).success) fail('not_found')
  const instant = options.now?.() ?? null
  if (instant !== null && !catalogPolicyInstantSchema.safeParse(instant).success) fail('unavailable')
  return [instant, claims.sessionId, claims.identityId, claims.sessionVersion, orderId]
}
async function authority(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  orderId: string,
  options: OrderAnnotationsOptions
) {
  const row = await db
    .prepare(`${cte} SELECT * FROM authority`)
    .bind(...params(claims, orderId, options))
    .first<{ actorId: string; emailVerified: number; mfaVerified: number; permitted: number; orderExists: number }>()
  if (!row) fail('unauthenticated')
  if (row.emailVerified !== 1) fail('email_unverified')
  if (row.mfaVerified !== 1) fail('mfa_required')
  if (row.permitted !== 1) fail('forbidden')
  if (row.orderExists !== 1) fail('not_found')
  return row
}
export async function readD1OrderAnnotations(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  orderId: string,
  query: { limit?: number; before?: string } = {},
  options: OrderAnnotationsOptions = {}
) {
  const limit = query.limit ?? 20
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 50 ||
    (query.before !== undefined && !uuid.safeParse(query.before).success)
  )
    fail('invalid_input')
  await authority(db, claims, orderId, options)
  const row = await db
    .prepare(
      `${cte}, cursor AS MATERIALIZED(SELECT created_at,command_id FROM order_annotation_commands WHERE order_id=?5 AND command_id=?6 AND note IS NOT NULL),
 page AS MATERIALIZED(SELECT * FROM order_annotation_commands WHERE order_id=?5 AND note IS NOT NULL
 AND (?6 IS NULL OR (created_at,command_id)<(SELECT created_at,command_id FROM cursor)) ORDER BY created_at DESC,command_id DESC LIMIT ?7)
 SELECT COALESCE((SELECT max(version) FROM order_annotation_commands WHERE order_id=?5),0) version,
 COALESCE((SELECT labels FROM order_annotation_commands WHERE order_id=?5 ORDER BY version DESC LIMIT 1),'[]') labels,
 (SELECT json_group_array(json_object('id',command_id,'authorId',actor_id,'createdAt',created_at,'text',note)) FROM page) notes,
 (?6 IS NULL OR EXISTS(SELECT 1 FROM cursor)) cursorValid FROM authority WHERE ${allowed}`
    )
    .bind(...params(claims, orderId, options), query.before ?? null, limit + 1)
    .first<{ version: number; labels: string; notes: string; cursorValid: number }>()
  if (!row) {
    await authority(db, claims, orderId, options)
    fail('unavailable')
  }
  if (row.cursorValid !== 1) fail('invalid_input')
  const notes = JSON.parse(row.notes) as Array<{ id: string }>,
    more = notes.length > limit
  return orderAnnotationsResponseSchema.parse({
    source: 'cloudflare',
    orderId,
    version: row.version,
    labels: JSON.parse(row.labels),
    notes: notes.slice(0, limit),
    nextCursor: more ? notes[limit - 1]!.id : null
  })
}
interface Stored {
  command_id: string
  actor_id: string
  payload_hash: string
  version: number
  note: string | null
  labels: string
  created_at: string
}
function receipt(orderId: string, row: Stored): OrderAnnotationsReceipt {
  return orderAnnotationsReceiptSchema.parse({
    source: 'cloudflare',
    orderId,
    commandId: row.command_id,
    version: row.version,
    noteId: row.note === null ? null : row.command_id,
    labels: JSON.parse(row.labels),
    createdAt: row.created_at
  })
}
async function stored(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  orderId: string,
  key: string,
  options: OrderAnnotationsOptions
) {
  return db
    .prepare(
      `${cte} SELECT c.* FROM order_annotation_commands c,authority WHERE ${allowed} AND c.order_id=?5 AND c.command_id=?6`
    )
    .bind(...params(claims, orderId, options), key)
    .first<Stored>()
}
export async function readD1OrderAnnotationCommand(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  orderId: string,
  commandId: string,
  options: OrderAnnotationsOptions = {}
) {
  if (!uuid.safeParse(commandId).success) fail('invalid_input')
  await authority(db, claims, orderId, options)
  const row = await stored(db, claims, orderId, commandId, options)
  await authority(db, claims, orderId, options)
  return orderAnnotationCommandSchema.parse({
    source: 'cloudflare',
    orderId,
    commandId,
    outcome: row ? 'applied' : 'unknown',
    receipt: row ? receipt(orderId, row) : null
  })
}
export async function executeD1OrderAnnotations(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  orderId: string,
  commandId: string,
  input: unknown,
  options: OrderAnnotationsOptions = {}
) {
  const parsed = orderAnnotationsInputSchema.safeParse(input)
  if (!parsed.success || !uuid.safeParse(commandId).success) fail('invalid_input')
  const actor = await authority(db, claims, orderId, options),
    value = parsed.data
  const hash = await canonicalPayloadHash({ orderId, actorId: actor.actorId, ...value })
  const previous = await stored(db, claims, orderId, commandId, options)
  if (previous) {
    if (previous.payload_hash !== hash) fail('conflict')
    const recovered = await readD1OrderAnnotationCommand(db, claims, orderId, commandId, options)
    if (recovered.outcome !== 'applied') fail('unavailable')
    return recovered.receipt
  }
  try {
    await db.batch([
      db
        .prepare(
          `${cte} INSERT INTO order_annotation_commands(order_id,command_id,actor_id,session_id,session_version,payload_hash,expected_version,version,note,labels,created_at)
 SELECT ?5,?6,actorId,?2,?4,?7,?8,?8+1,?9,COALESCE(?10,(SELECT labels FROM order_annotation_commands WHERE order_id=?5 ORDER BY version DESC LIMIT 1),'[]'),(SELECT now FROM clock)
 FROM authority WHERE ${allowed}`
        )
        .bind(
          ...params(claims, orderId, options),
          commandId,
          hash,
          value.expectedVersion,
          value.note ?? null,
          value.labels === undefined ? null : JSON.stringify(value.labels)
        )
    ])
  } catch {
    await authority(db, claims, orderId, options)
    const raced = await stored(db, claims, orderId, commandId, options)
    if (raced) {
      if (raced.payload_hash !== hash) fail('conflict')
      const recovered = await readD1OrderAnnotationCommand(db, claims, orderId, commandId, options)
      if (recovered.outcome !== 'applied') fail('unavailable')
      return recovered.receipt
    }
    const current = await readD1OrderAnnotations(db, claims, orderId, {}, options)
    if (current.version !== value.expectedVersion) fail('conflict')
    fail('unavailable')
  }
  const result = await readD1OrderAnnotationCommand(db, claims, orderId, commandId, options)
  if (result.outcome !== 'applied') fail('unavailable')
  return result.receipt
}

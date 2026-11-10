import { z } from 'zod'
import type { VerifiedSessionClaims } from './authorization'
import { canonicalPayloadHash } from './cart'
import { catalogPolicyInstantSchema } from '../../shared/catalog-publication-policy'

export class ProductRecallError extends Error {
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
const inputSchema = z
  .object({
    expectedVersion: z
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER - 1),
    action: z.enum(['open', 'communicate', 'trace', 'resolve']),
    orderId: z.string().uuid().optional(),
    lineIndex: z.number().int().min(0).optional(),
    targetLotId: z.string().uuid().optional(),
    quantity: z.number().int().min(1).max(999).optional(),
    evidence: z.string().regex(/^[a-zA-Z0-9_-]{8,100}$/)
  })
  .strict()
  .refine((v) =>
    v.action === 'trace'
      ? v.orderId !== undefined && v.lineIndex !== undefined && v.targetLotId !== undefined && v.quantity !== undefined
      : v.action === 'communicate'
        ? v.orderId !== undefined &&
          v.lineIndex !== undefined &&
          v.targetLotId === undefined &&
          v.quantity === undefined
        : v.orderId === undefined &&
          v.lineIndex === undefined &&
          v.targetLotId === undefined &&
          v.quantity === undefined
  )
type Options = { now?: () => string; limit?: number; after?: string }
const cte = `WITH clock AS MATERIALIZED (SELECT COALESCE(?1,strftime('%Y-%m-%dT%H:%M:%SZ','now')) now), authority AS MATERIALIZED (
 SELECT i.id actorId,s.mfa_verified mfaVerified,(i.email_verified_at IS NOT NULL AND i.email_verified_at<=(SELECT now FROM clock)) emailVerified,
 EXISTS(SELECT 1 FROM inventory_lots WHERE id=?5) lotExists,
 EXISTS(SELECT 1 FROM identity_roles r JOIN role_permissions p ON p.role_code=r.role_code WHERE r.identity_id=i.id AND p.permission_code='administration.manage' AND r.granted_at<=(SELECT now FROM clock) AND (r.expires_at IS NULL OR r.expires_at>(SELECT now FROM clock))) permitted
 FROM auth_sessions s JOIN identities i ON i.id=s.identity_id WHERE s.id=?2 AND s.identity_id=?3 AND s.session_version=?4 AND i.session_version=s.session_version AND i.status IN('pending','active') AND s.revoked_at IS NULL AND s.created_at<=(SELECT now FROM clock) AND s.expires_at>(SELECT now FROM clock))`
const allowed = 'emailVerified=1 AND mfaVerified=1 AND permitted=1 AND lotExists=1'
function fail(code: ProductRecallError['code']): never {
  throw new ProductRecallError(code)
}
function params(claims: VerifiedSessionClaims | null, lotId: string, options: Options) {
  if (
    !claims ||
    !uuid.safeParse(claims.identityId).success ||
    !uuid.safeParse(claims.sessionId).success ||
    !Number.isSafeInteger(claims.sessionVersion) ||
    claims.sessionVersion < 1
  )
    fail('unauthenticated')
  if (!uuid.safeParse(lotId).success) fail('not_found')
  const now = options.now?.() ?? null
  if (now !== null && !catalogPolicyInstantSchema.safeParse(now).success) fail('unavailable')
  return [now, claims.sessionId, claims.identityId, claims.sessionVersion, lotId]
}
async function authority(db: D1Database, claims: VerifiedSessionClaims | null, lotId: string, options: Options) {
  const row = await db
    .prepare(`${cte} SELECT * FROM authority`)
    .bind(...params(claims, lotId, options))
    .first<{ actorId: string; emailVerified: number; mfaVerified: number; permitted: number; lotExists: number }>()
  if (!row) fail('unauthenticated')
  if (!row.emailVerified) fail('email_unverified')
  if (!row.mfaVerified) fail('mfa_required')
  if (!row.permitted) fail('forbidden')
  if (!row.lotExists) fail('not_found')
  return row
}
interface Stored {
  command_id: string
  lot_id: string
  action: string
  payload_hash: string
  version: number
  created_at: string
}
async function stored(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  lotId: string,
  commandId: string,
  options: Options
) {
  return db
    .prepare(`${cte} SELECT c.* FROM product_recall_commands c,authority WHERE ${allowed} AND c.command_id=?6`)
    .bind(...params(claims, lotId, options), commandId)
    .first<Stored>()
}
function receipt(row: Stored) {
  return {
    source: 'cloudflare' as const,
    commandId: row.command_id,
    lotId: row.lot_id,
    action: row.action,
    version: row.version,
    createdAt: row.created_at
  }
}
export async function readProductRecall(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  lotId: string,
  options: Options = {}
) {
  const limit = options.limit ?? 50
  const cursor = options.after?.split(':')
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    (cursor &&
      (cursor.length !== 2 || !uuid.safeParse(cursor[0]).success || !/^(0|[1-9]\d{0,6})$/.test(cursor[1] ?? '')))
  )
    fail('invalid_input')
  await authority(db, claims, lotId, options)
  const row = await db
    .prepare(
      `${cte} SELECT c.version,c.action FROM product_recall_commands c,authority WHERE ${allowed} AND c.lot_id=?5 ORDER BY c.version DESC LIMIT 1`
    )
    .bind(...params(claims, lotId, options))
    .first<{ version: number; action: string }>()
  const affected = await db
    .prepare(
      `${cte}, progress AS MATERIALIZED (
 SELECT ol.order_id orderId,ol.line_index lineIndex,o.customer_id customerId,ol.quantity orderedQuantity,
 COALESCE(sum(CASE WHEN a.lot_id=?5 THEN a.quantity ELSE 0 END),0) confirmedQuantity,
 COALESCE(sum(CASE WHEN source.variant_id=ol.variant_id THEN a.quantity ELSE 0 END),0) assignedQuantity
 FROM order_lines ol JOIN inventory_lots recalled ON recalled.id=?5 AND recalled.variant_id=ol.variant_id
 JOIN orders o ON o.id=ol.order_id LEFT JOIN inventory_lot_allocations a ON a.order_id=ol.order_id AND a.order_line_index=ol.line_index
 LEFT JOIN inventory_lots source ON source.id=a.lot_id,authority
 WHERE ${allowed} AND (?6 IS NULL OR (ol.order_id,ol.line_index)>(?6,?7))
 GROUP BY ol.order_id,ol.line_index,o.customer_id,ol.quantity)
 SELECT orderId,lineIndex,customerId,confirmedQuantity+max(0,orderedQuantity-assignedQuantity) quantity,
 confirmedQuantity,max(0,orderedQuantity-assignedQuantity) untrackedQuantity,(assignedQuantity>orderedQuantity) traceabilityConflict
 FROM progress WHERE confirmedQuantity>0 OR assignedQuantity<>orderedQuantity ORDER BY orderId,lineIndex LIMIT ?8`
    )
    .bind(...params(claims, lotId, options), cursor?.[0] ?? null, cursor ? Number(cursor[1]) : null, limit + 1)
    .all<{
      orderId: string
      lineIndex: number
      customerId: string | null
      quantity: number
      confirmedQuantity: number
      untrackedQuantity: number
      traceabilityConflict: number
    }>()
  await authority(db, claims, lotId, options)
  const rows = affected.results.slice(0, limit)
  const last = rows[rows.length - 1]
  return {
    source: 'cloudflare' as const,
    lotId,
    version: row?.version ?? 0,
    open: row !== null && row.action !== 'resolve',
    affected: rows,
    nextCursor: affected.results.length > limit && last ? `${last.orderId}:${last.lineIndex}` : null
  }
}
export async function executeProductRecall(
  db: D1Database,
  claims: VerifiedSessionClaims | null,
  lotId: string,
  commandId: string,
  raw: unknown,
  options: Options = {}
) {
  const parsed = inputSchema.safeParse(raw)
  if (!parsed.success || !uuid.safeParse(commandId).success) fail('invalid_input')
  if (parsed.data.expectedVersion === 0 && parsed.data.action !== 'open') fail('invalid_input')
  const actor = await authority(db, claims, lotId, options),
    input = parsed.data
  const hash = await canonicalPayloadHash({ lotId, actorId: actor.actorId, ...input })
  const previous = await stored(db, claims, lotId, commandId, options)
  if (previous) {
    if (previous.payload_hash !== hash || previous.lot_id !== lotId) fail('conflict')
    await authority(db, claims, lotId, options)
    return receipt(previous)
  }
  try {
    await db.batch([
      db
        .prepare(
          `${cte} INSERT INTO product_recall_commands(command_id,lot_id,action,evidence,actor_id,session_id,session_version,payload_hash,expected_version,version,created_at,order_id,line_index,target_lot_id,trace_quantity)
 SELECT ?6,?5,?7,?8,actorId,?2,?4,?9,?10,?10+1,(SELECT now FROM clock),?11,?12,?13,?14 FROM authority WHERE ${allowed}`
        )
        .bind(
          ...params(claims, lotId, options),
          commandId,
          input.action,
          input.evidence,
          hash,
          input.expectedVersion,
          input.orderId ?? null,
          input.lineIndex ?? null,
          input.targetLotId ?? null,
          input.quantity ?? null
        )
    ])
  } catch (cause) {
    await authority(db, claims, lotId, options)
    const raced = await stored(db, claims, lotId, commandId, options)
    if (raced) {
      if (raced.payload_hash !== hash || raced.lot_id !== lotId) fail('conflict')
      await authority(db, claims, lotId, options)
      return receipt(raced)
    }
    const current = await readProductRecall(db, claims, lotId, options)
    if (
      current.version !== input.expectedVersion ||
      (cause instanceof Error && cause.message.includes('recall_transition_conflict'))
    )
      fail('conflict')
    fail('unavailable')
  }
  const result = await stored(db, claims, lotId, commandId, options)
  await authority(db, claims, lotId, options)
  if (!result) fail('unavailable')
  if (result.payload_hash !== hash || result.lot_id !== lotId) fail('conflict')
  return receipt(result)
}

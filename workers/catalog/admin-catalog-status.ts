import { z } from 'zod'
import type { PublicationIssue } from '../../server/domain/catalog-publication'
import { ADMIN_CATALOG_STATUSES, parseAdminCatalogLegacyId, type AdminCatalogStatus } from './admin-catalog'
import { authorizeD1Session, type VerifiedSessionClaims } from './authorization'

export class AdminCatalogStatusError extends Error {
  constructor(
    readonly code:
      | 'invalid_input'
      | 'unauthenticated'
      | 'email_unverified'
      | 'mfa_required'
      | 'forbidden'
      | 'not_found'
      | 'version_conflict'
      | 'idempotency_conflict'
      | 'invalid_transition'
      | 'publication_blocked'
      | 'conflict',
    readonly issues?: PublicationIssue[]
  ) {
    super(code)
  }
}

export interface PreparedCatalogPublicationGate {
  /** Audit identity only: equality to this hash is not publication authority. */
  fingerprint: string
  /** Trusted SQL predicate, with ?(parameterOffset+1) onward placeholders.
   * Must reevaluate dependency equality AND eligibility at SQL execution time;
   * never bind a captured production JavaScript clock. The predicate must not
   * depend on the product/variant status/timestamps this command changes. */
  condition(parameterOffset: number): { sql: string; parameters: readonly (string | number | null)[] }
}
export interface CatalogPublicationGate {
  prepare(
    database: D1Database,
    product: { productUuid: string; productId: number },
    claims: VerifiedSessionClaims
  ): Promise<PreparedCatalogPublicationGate>
}
export interface ProductStatusReceipt {
  source: 'cloudflare'
  productId: number
  productUuid: string
  catalogVersion: number
  status: AdminCatalogStatus
  active: boolean
  updated: true
}

/** Scalar own-data records suffice for this flat command. Never execute input
 * accessors/coercions; copying to a null prototype also prevents inherited Zod
 * optional fields. The trusted gate object is deliberately not JSON input. */
function scalarRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return undefined
  const copy = Object.create(null) as Record<string, unknown>
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') return undefined
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return undefined
    const item: unknown = descriptor.value
    if (
      item !== null &&
      typeof item !== 'string' &&
      typeof item !== 'boolean' &&
      !(typeof item === 'number' && Number.isFinite(item))
    )
      return undefined
    copy[key] = item
  }
  return copy
}
const status = z.enum(ADMIN_CATALOG_STATUSES)
const bodySchema = z
  .object({
    status,
    expectedVersion: z
      .number()
      .int()
      .min(1)
      .max(Number.MAX_SAFE_INTEGER - 1),
    reason: z
      .string()
      .refine(
        (value) => ![...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
      )
      .transform((value) => value.trim())
      .pipe(z.string().min(3).max(500))
  })
  .strict()
export const productStatusInputSchema = z.preprocess(scalarRecord, bodySchema)
export type ProductStatusInput = z.infer<typeof productStatusInputSchema>
const transitions: Record<AdminCatalogStatus, readonly AdminCatalogStatus[]> = {
  draft: ['review', 'hidden', 'discontinued'],
  review: ['draft', 'published', 'hidden'],
  published: ['hidden', 'discontinued'],
  hidden: ['draft', 'review', 'published', 'discontinued'],
  discontinued: ['draft']
}
type Permission = 'catalog.write' | 'catalog.publish'
const executionNow = "COALESCE(?1,strftime('%Y-%m-%dT%H:%M:%SZ','now'))"
function actorSql(permissionCondition = 'granted.permission_code=?5') {
  return `SELECT i.id FROM auth_sessions s JOIN identities i ON i.id=s.identity_id AND i.session_version=s.session_version
    WHERE s.id=?2 AND s.identity_id=?3 AND s.session_version=?4 AND s.revoked_at IS NULL
      AND s.created_at<=${executionNow} AND s.expires_at>${executionNow} AND s.mfa_verified=1
      AND i.status IN ('pending','active') AND i.email_verified_at IS NOT NULL AND i.email_verified_at<=${executionNow}
      AND EXISTS(SELECT 1 FROM identity_roles assigned JOIN role_permissions granted ON granted.role_code=assigned.role_code
        WHERE assigned.identity_id=i.id AND ${permissionCondition}
          AND assigned.granted_at<=${executionNow} AND (assigned.expires_at IS NULL OR assigned.expires_at>${executionNow}))`
}
const anyPermission = "granted.permission_code IN ('catalog.write','catalog.publish')"
function actorParameters(claims: VerifiedSessionClaims, permission: Permission, now?: string) {
  return [now ?? null, claims.sessionId, claims.identityId, claims.sessionVersion, permission] as const
}
async function authorize(database: D1Database, claims: VerifiedSessionClaims, permission: Permission, now?: string) {
  const result = await authorizeD1Session(database, claims, permission, {
    requireMfa: true,
    now: now ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  })
  if (!result.allowed) throw new AdminCatalogStatusError(result.code)
}
async function authorizeAny(database: D1Database, claims: VerifiedSessionClaims, now?: string) {
  try {
    await authorize(database, claims, 'catalog.write', now)
  } catch (error) {
    if (!(error instanceof AdminCatalogStatusError) || error.code !== 'forbidden') throw error
    await authorize(database, claims, 'catalog.publish', now)
  }
}
function productSnapshot(alias: string, after = false) {
  return `json_object('status',${after ? '?6' : `${alias}.status`},'publishedAt',${after ? `CASE WHEN ?6='published' THEN COALESCE(${alias}.published_at,${executionNow}) ELSE ${alias}.published_at END` : `${alias}.published_at`},'updatedAt',${after ? executionNow : `${alias}.updated_at`})`
}
function variantSnapshot(productIdSql: string, after = false) {
  return `(SELECT json_group_array(json(item)) FROM (SELECT json_object('uuid',v.id,'legacyId',v.legacy_id,
    'status',${after ? "CASE WHEN v.status='discontinued' THEN v.status ELSE ?6 END" : 'v.status'},
    'updatedAt',${after ? `CASE WHEN v.status='discontinued' THEN v.updated_at ELSE ${executionNow} END` : 'v.updated_at'}) AS item
    FROM variants v WHERE v.product_id=${productIdSql} ORDER BY v.id))`
}
const auditMatch = `audit.command_id=c.id AND audit.actor_id=c.actor_id AND audit.product_id=c.product_id
  AND audit.product_legacy_id=c.product_legacy_id AND audit.before_version=c.expected_version AND audit.after_version=c.result_version
  AND audit.before_status=c.before_status AND audit.after_status=c.after_status AND audit.required_permission=c.required_permission
  AND audit.reason=c.reason AND audit.gate_fingerprint IS c.gate_fingerprint
  AND audit.before_product=c.before_product AND audit.after_product=c.after_product
  AND audit.before_variants=c.before_variants AND audit.after_variants=c.after_variants AND audit.created_at=c.created_at`
const receiptSchema = z
  .object({
    source: z.literal('cloudflare'),
    productId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    productUuid: z.string(),
    catalogVersion: z.number().int().min(2).max(Number.MAX_SAFE_INTEGER),
    status,
    active: z.boolean(),
    updated: z.literal(true)
  })
  .strict()
function receipt(value: string): ProductStatusReceipt {
  const parsed: unknown = JSON.parse(value)
  const result = receiptSchema.safeParse(parsed)
  if (
    !result.success ||
    Object.keys(result.data).join(',') !== 'source,productId,productUuid,catalogVersion,status,active,updated' ||
    result.data.active !== (result.data.status === 'published')
  )
    throw new Error('invalid_catalog_status_receipt')
  // Return the original JSON object, not a reconstruction with current state.
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    Object.keys(parsed).join(',') !== 'source,productId,productUuid,catalogVersion,status,active,updated'
  )
    throw new Error('invalid_catalog_status_receipt')
  return parsed as ProductStatusReceipt
}
async function replay(database: D1Database, claims: VerifiedSessionClaims, key: string, hash: string, now?: string) {
  const row = await database
    .prepare(
      `WITH actor AS (${actorSql(anyPermission)})
    SELECT c.payload_hash,c.response,c.required_permission,
      EXISTS(${actorSql('granted.permission_code=c.required_permission')}) AS authorized,
      EXISTS(SELECT 1 FROM catalog_product_status_audit audit WHERE ${auditMatch}) AS completed
    FROM actor JOIN catalog_product_status_commands c ON c.actor_id=actor.id WHERE c.idempotency_key=?6`
    )
    .bind(...actorParameters(claims, 'catalog.write', now), key)
    .first<{
      payload_hash: string
      response: string
      required_permission: Permission
      authorized: number
      completed: number
    }>()
  if (!row) return null
  if (row.authorized !== 1) {
    await authorize(database, claims, row.required_permission, now)
    throw new AdminCatalogStatusError('conflict')
  }
  if (row.payload_hash !== hash) throw new AdminCatalogStatusError('idempotency_conflict')
  if (row.completed !== 1) throw new AdminCatalogStatusError('conflict')
  return receipt(row.response)
}
function isConstraint(error: unknown) {
  if (!(error instanceof Error)) return false
  const code = (error as Error & { errcode?: number }).errcode
  return (
    (typeof code === 'number' && (code & 255) === 19) ||
    /catalog_product_status_|SQLITE_CONSTRAINT|constraint failed/i.test(error.message)
  )
}

/** Exactly the existing editorial graph; no create/delete/price/stock writes.
 * Every accepted new command changes product version once and audits all
 * variant states. Publication uses the supplied authoritative dependency gate.
 */
export async function updateD1ProductStatus(
  database: D1Database,
  claimsInput: VerifiedSessionClaims | null,
  legacyId: string,
  input: unknown,
  options: { idempotencyKey: string; publicationGate?: CatalogPublicationGate; now?: string }
): Promise<ProductStatusReceipt> {
  const id = typeof legacyId === 'string' ? parseAdminCatalogLegacyId(legacyId) : null
  const body = productStatusInputSchema.safeParse(input)
  if (id === null || !body.success || !options || typeof options !== 'object' || Array.isArray(options))
    throw new AdminCatalogStatusError('invalid_input')
  const optionDescriptors = Object.getOwnPropertyDescriptors(options)
  if (
    (Object.getPrototypeOf(options) !== Object.prototype && Object.getPrototypeOf(options) !== null) ||
    Reflect.ownKeys(options).some(
      (key) =>
        typeof key !== 'string' ||
        !['idempotencyKey', 'publicationGate', 'now'].includes(key) ||
        !optionDescriptors[key]?.enumerable ||
        !Object.hasOwn(optionDescriptors[key]!, 'value')
    )
  )
    throw new AdminCatalogStatusError('invalid_input')
  const key: unknown = optionDescriptors.idempotencyKey?.value
  const now: unknown = optionDescriptors.now?.value
  if (
    typeof key !== 'string' ||
    !/^[A-Za-z0-9._:-]{1,200}$/.test(key) ||
    [...key].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
  )
    throw new AdminCatalogStatusError('invalid_input')
  if (
    now !== undefined &&
    (typeof now !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(now) ||
      !Number.isFinite(Date.parse(now)) ||
      new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z') !== now)
  )
    throw new AdminCatalogStatusError('invalid_input')
  const checkedClaims = scalarRecord(claimsInput)
  if (
    !checkedClaims ||
    !['sessionId', 'identityId', 'sessionVersion'].every((field) => Object.hasOwn(checkedClaims, field)) ||
    typeof checkedClaims.sessionId !== 'string' ||
    typeof checkedClaims.identityId !== 'string' ||
    typeof checkedClaims.sessionVersion !== 'number'
  )
    throw new AdminCatalogStatusError('unauthenticated')
  const claims: VerifiedSessionClaims = {
    sessionId: checkedClaims.sessionId,
    identityId: checkedClaims.identityId,
    sessionVersion: checkedClaims.sessionVersion
  }
  await authorizeAny(database, claims, now)
  const payload = JSON.stringify([
    'catalog.product.status.v1',
    id,
    body.data.expectedVersion,
    body.data.reason,
    body.data.status
  ])
  const hash = Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload))),
    (b) => b.toString(16).padStart(2, '0')
  ).join('')
  const completed = await replay(database, claims, key, hash, now)
  if (completed) return completed
  const target = await database
    .prepare(
      `WITH actor AS (${actorSql(anyPermission)}) SELECT p.id,p.status,p.catalog_version
    FROM actor CROSS JOIN products p WHERE p.legacy_id=?6`
    )
    .bind(...actorParameters(claims, 'catalog.write', now), id)
    .first<{ id: string; status: AdminCatalogStatus; catalog_version: number }>()
  if (!target) {
    await authorizeAny(database, claims, now)
    throw new AdminCatalogStatusError('not_found')
  }
  if (target.catalog_version !== body.data.expectedVersion) {
    const winner = await replay(database, claims, key, hash, now)
    if (winner) return winner
    throw new AdminCatalogStatusError('version_conflict')
  }
  if (!transitions[target.status]?.includes(body.data.status)) throw new AdminCatalogStatusError('invalid_transition')
  const permission: Permission =
    (target.status === 'draft' && body.data.status === 'review') ||
    (target.status === 'review' && body.data.status === 'draft')
      ? 'catalog.write'
      : 'catalog.publish'
  await authorize(database, claims, permission, now)
  let gate: { sql: string; parameters: readonly (string | number | null)[] } = { sql: '1', parameters: [] }
  let fingerprint: string | null = null
  if (body.data.status === 'published') {
    const hook: unknown = optionDescriptors.publicationGate?.value
    if (!hook || typeof hook !== 'object' || !('prepare' in hook) || typeof hook.prepare !== 'function')
      throw new AdminCatalogStatusError('publication_blocked', [
        {
          code: 'publication.gate_unavailable',
          path: 'publication',
          message: 'No se puede comprobar la autorización de publicación'
        }
      ])
    const prepared: PreparedCatalogPublicationGate = await hook.prepare(
      database,
      { productUuid: target.id, productId: id },
      claims
    )
    if (
      !prepared ||
      typeof prepared.fingerprint !== 'string' ||
      !/^[0-9a-f]{64}$/.test(prepared.fingerprint) ||
      typeof prepared.condition !== 'function'
    )
      throw new AdminCatalogStatusError('publication_blocked')
    fingerprint = prepared.fingerprint
    gate = prepared.condition(16)
    if (
      !gate ||
      typeof gate.sql !== 'string' ||
      !gate.sql.trim() ||
      !Array.isArray(gate.parameters) ||
      gate.parameters.length > 80 ||
      gate.parameters.some((p) => p !== null && typeof p !== 'string' && !(typeof p === 'number' && Number.isFinite(p)))
    )
      throw new AdminCatalogStatusError('publication_blocked')
  }
  const command = crypto.randomUUID(),
    nonce = crypto.randomUUID()
  const parameters = [
    ...actorParameters(claims, permission, now),
    body.data.status,
    id,
    body.data.expectedVersion,
    body.data.reason,
    key,
    hash,
    command,
    nonce,
    fingerprint,
    target.status,
    target.id,
    ...gate.parameters
  ]
  const owned = `c.id=?12 AND c.claim_nonce=?13 AND c.actor_id=?3 AND c.idempotency_key=?10 AND c.payload_hash=?11
    AND c.product_id=?16 AND c.required_permission=?5 AND c.expected_version=?8 AND c.after_status=?6`
  const currentProduct = `p.id=c.product_id AND p.catalog_version=c.result_version AND ${productSnapshot('p')}=c.after_product`
  const statements = [
    database
      .prepare(
        `WITH actor AS (${actorSql()}) INSERT INTO catalog_product_status_commands
      (id,claim_nonce,actor_id,product_id,product_legacy_id,idempotency_key,payload_hash,expected_version,result_version,
       before_status,after_status,required_permission,reason,gate_fingerprint,before_product,after_product,before_variants,after_variants,response,created_at)
      SELECT ?12,?13,actor.id,p.id,p.legacy_id,?10,?11,?8,?8+1,p.status,?6,?5,?9,?14,
        ${productSnapshot('p')},${productSnapshot('p', true)},${variantSnapshot('p.id')},${variantSnapshot('p.id', true)},
        json_object('source','cloudflare','productId',p.legacy_id,'productUuid',p.id,'catalogVersion',CAST(?8+1 AS INTEGER),'status',?6,
          'active',json(CASE WHEN ?6='published' THEN 'true' ELSE 'false' END),'updated',json('true')),${executionNow}
      FROM actor CROSS JOIN products p WHERE p.legacy_id=?7 AND p.id=?16 AND p.status=?15 AND p.catalog_version=?8 AND (${gate.sql})
        AND NOT EXISTS(SELECT 1 FROM catalog_product_status_commands WHERE actor_id=?3 AND idempotency_key=?10)`
      )
      .bind(...parameters),
    database
      .prepare(
        `WITH actor AS (${actorSql()}),owned AS MATERIALIZED(
      SELECT c.* FROM actor JOIN catalog_product_status_commands c ON c.actor_id=actor.id JOIN products p ON p.id=c.product_id
      WHERE ${owned} AND p.status=c.before_status AND p.catalog_version=c.expected_version
        AND ${productSnapshot('p')}=c.before_product AND ${variantSnapshot('p.id')}=c.before_variants AND (${gate.sql})
    ) UPDATE products SET status=?6,catalog_version=?8+1,updated_at=(SELECT created_at FROM owned),
      published_at=CASE WHEN ?6='published' THEN COALESCE(published_at,(SELECT created_at FROM owned)) ELSE published_at END
      WHERE id=?16 AND catalog_version=?8 AND status=?15 AND EXISTS(SELECT 1 FROM owned)`
      )
      .bind(...parameters),
    database
      .prepare(
        `WITH actor AS (${actorSql()}),owned AS MATERIALIZED(
      SELECT c.* FROM actor JOIN catalog_product_status_commands c ON c.actor_id=actor.id JOIN products p ON ${currentProduct}
      WHERE ${owned} AND ${variantSnapshot('p.id')}=c.before_variants AND (${gate.sql})
    ) UPDATE variants SET status=?6,updated_at=(SELECT created_at FROM owned)
      WHERE product_id=?16 AND status<>'discontinued' AND EXISTS(SELECT 1 FROM owned)`
      )
      .bind(...parameters),
    database
      .prepare(
        `WITH actor AS (${actorSql()}) INSERT INTO catalog_product_status_audit
      (id,command_id,actor_id,product_id,product_legacy_id,before_version,after_version,before_status,after_status,
       required_permission,reason,gate_fingerprint,before_product,after_product,before_variants,after_variants,created_at)
      SELECT c.id,c.id,c.actor_id,c.product_id,c.product_legacy_id,c.expected_version,c.result_version,c.before_status,c.after_status,
        c.required_permission,c.reason,c.gate_fingerprint,c.before_product,c.after_product,c.before_variants,c.after_variants,c.created_at
      FROM actor JOIN catalog_product_status_commands c ON c.actor_id=actor.id JOIN products p ON ${currentProduct}
      WHERE ${owned} AND ${variantSnapshot('p.id')}=c.after_variants AND (${gate.sql})`
      )
      .bind(...parameters),
    database
      .prepare(
        `WITH actor AS (${actorSql()}) SELECT c.response FROM actor JOIN catalog_product_status_commands c ON c.actor_id=actor.id
      JOIN catalog_product_status_audit audit ON ${auditMatch} WHERE ${owned}`
      )
      .bind(...parameters.slice(0, 16)),
    database
      .prepare(
        `INSERT INTO catalog_product_status_guards(id,satisfied) SELECT lower(hex(randomblob(16))),0 WHERE NOT(
      EXISTS(SELECT 1 FROM (${actorSql()}) actor JOIN catalog_product_status_commands c ON c.actor_id=actor.id
        JOIN catalog_product_status_audit audit ON ${auditMatch} JOIN products p ON ${currentProduct}
        WHERE ${owned} AND ${variantSnapshot('p.id')}=c.after_variants AND (${gate.sql})))`
      )
      .bind(...parameters)
  ]
  try {
    const result = await database.batch<{ response: string }>(statements)
    const response = result[4]?.results[0]?.response
    if (typeof response !== 'string') throw new AdminCatalogStatusError('conflict')
    return receipt(response)
  } catch (error) {
    if (!(error instanceof AdminCatalogStatusError) && !isConstraint(error)) throw error
    await authorize(database, claims, permission, now)
    const winner = await replay(database, claims, key, hash, now)
    if (winner) return winner
    const current = await database
      .prepare('SELECT status,catalog_version FROM products WHERE id=?')
      .bind(target.id)
      .first<{ status: AdminCatalogStatus; catalog_version: number }>()
    if (!current) throw new AdminCatalogStatusError('not_found')
    if (current.catalog_version !== body.data.expectedVersion) throw new AdminCatalogStatusError('version_conflict')
    if (!transitions[current.status]?.includes(body.data.status))
      throw new AdminCatalogStatusError('invalid_transition')
    if (body.data.status === 'published') throw new AdminCatalogStatusError('publication_blocked')
    throw new AdminCatalogStatusError('conflict')
  }
}

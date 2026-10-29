import { z } from 'zod'
import { authorizeD1Session, type VerifiedSessionClaims } from './authorization'
import { parseAdminCatalogLegacyId } from './admin-catalog'
import { catalogTypedAttributeValuesSchema } from '../../shared/catalog-typed-attributes'
import type { CatalogTypedAttributeValues } from '../../shared/catalog-typed-attributes'
import { catalogTypedAttributeValuesReceiptSchema } from '../../shared/catalog-typed-attribute-views'
import type { CatalogTypedAttributeValuesReceipt } from '../../shared/catalog-typed-attribute-views'
import {
  catalogTypedAttributeReplacementValidityCtes,
  validateD1CatalogTypedAttributePatch
} from './typed-attribute-values'

export class AdminCatalogMutationError extends Error {
  constructor(
    readonly code:
      | 'invalid_input'
      | 'unauthenticated'
      | 'email_unverified'
      | 'mfa_required'
      | 'forbidden'
      | 'not_found'
      | 'product_not_editable'
      | 'version_conflict'
      | 'idempotency_conflict'
      | 'invalid_typed_values'
      | 'reference_unavailable'
      | 'conflict'
  ) {
    super(code)
  }
}

const METADATA_FIELDS = [
  'name',
  'categoryId',
  'shortDesc',
  'description',
  'usage',
  'series',
  'featured',
  'badges',
  'visual',
  'attrs',
  'typed'
] as const

/** Do not execute getters/coercions or accept inherited input. Null-prototype
 * JSON records are allowed; symbols, accessors, holes and cycles are not. */
function ownJsonData(value: unknown, seen = new Set<object>(), depth = 0): boolean {
  if (depth > 12) return false
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value !== 'object' || seen.has(value)) return false
  const prototype = Object.getPrototypeOf(value)
  const array = Array.isArray(value)
  if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) return false
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const keys = Reflect.ownKeys(value)
  if (keys.some((key) => typeof key !== 'string')) return false
  if (array && keys.length !== (descriptors.length?.value as number) + 1) return false
  seen.add(value)
  for (const key of keys as string[]) {
    const descriptor = descriptors[key]!
    if (array && key === 'length') continue
    if (
      !Object.hasOwn(descriptor, 'value') ||
      !descriptor.enumerable ||
      (array && !/^(?:0|[1-9]\d*)$/.test(key)) ||
      !ownJsonData(descriptor.value, seen, depth + 1)
    )
      return false
  }
  seen.delete(value)
  return true
}

function ownJsonCopy(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Array.isArray(value))
    return Array.from({ length: value.length }, (_, index) => ownJsonCopy(descriptors[String(index)]!.value))
  const copy = Object.create(null) as Record<string, unknown>
  for (const [key, descriptor] of Object.entries(descriptors)) copy[key] = ownJsonCopy(descriptor.value)
  return copy
}

function hasInvalidControl(value: string, multiline = false) {
  return [...value].some((character) => {
    const code = character.charCodeAt(0)
    return code === 127 || (code < 32 && !(multiline && (code === 9 || code === 10 || code === 13)))
  })
}
const text = (minimum: number, maximum: number, multiline = false) =>
  z
    .string()
    .refine((value) => !hasInvalidControl(value, multiline))
    .transform((value) => value.trim())
    .pipe(z.string().min(minimum).max(maximum))
const nullableText = (maximum: number, multiline = false) =>
  text(0, maximum, multiline)
    .nullable()
    .transform((value) => value || null)
const bodySchema = z
  .object({
    expectedVersion: z
      .number()
      .int()
      .min(1)
      .max(Number.MAX_SAFE_INTEGER - 1),
    reason: text(3, 500),
    name: text(3, 160).optional(),
    categoryId: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
    shortDesc: text(5, 500).optional(),
    description: text(5, 10000, true).optional(),
    usage: nullableText(2000, true).optional(),
    series: nullableText(160).optional(),
    featured: z.boolean().optional(),
    badges: z
      .array(z.enum(['eco', 'alimentaria', 'concentrado']))
      .max(3)
      .refine((values) => new Set(values).size === values.length)
      .optional(),
    visual: z
      .object({
        type: z.enum([
          'garrafa',
          'botella',
          'spray',
          'caja',
          'saco',
          'capsulas',
          'difusor',
          'cubo',
          'rollo',
          'vaso',
          'guante'
        ]),
        color: z
          .string()
          .length(7)
          .regex(/^#[0-9a-fA-F]{6}$/)
      })
      .strict()
      .optional(),
    attrs: z
      .array(z.object({ k: text(1, 100), v: text(1, 1000) }).strict())
      .max(50)
      .optional(),
    typed: catalogTypedAttributeValuesSchema.optional()
  })
  .strict()
  .refine((value) => METADATA_FIELDS.some((field) => Object.hasOwn(value, field)))

export const draftProductMetadataSchema = z.preprocess(
  (value) => (ownJsonData(value) ? ownJsonCopy(value) : undefined),
  bodySchema
)
export type DraftProductMetadataInput = z.infer<typeof draftProductMetadataSchema>

interface Receipt {
  source: 'cloudflare'
  productId: number
  productUuid: string
  catalogVersion: number
  updated: true
}
interface CommandRow {
  payload_hash: string
  response: string
}

// Only deterministic tests may override this SQL execution clock. HTTP never
// supplies options.now; production binds NULL, not a captured JavaScript date.
const executionNow = "COALESCE(?1, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))"
const actorSql = `SELECT identity.id FROM auth_sessions session
  JOIN identities identity ON identity.id = session.identity_id AND identity.session_version = session.session_version
  WHERE session.id = ?2 AND session.identity_id = ?3 AND session.session_version = ?4
    AND session.revoked_at IS NULL AND session.created_at <= ${executionNow} AND session.expires_at > ${executionNow}
    AND session.mfa_verified = 1 AND identity.status IN ('pending', 'active')
    AND identity.email_verified_at IS NOT NULL AND identity.email_verified_at <= ${executionNow}
    AND EXISTS (SELECT 1 FROM identity_roles assigned JOIN role_permissions granted ON granted.role_code = assigned.role_code
      WHERE assigned.identity_id = identity.id AND granted.permission_code = ?5
        AND assigned.granted_at <= ${executionNow} AND (assigned.expires_at IS NULL OR assigned.expires_at > ${executionNow}))`

function actorParameters(claims: VerifiedSessionClaims, now?: string) {
  return [now ?? null, claims.sessionId, claims.identityId, claims.sessionVersion, 'catalog.write'] as const
}
async function authorize(database: D1Database, claims: VerifiedSessionClaims | null, now?: string) {
  if (
    !claims ||
    !ownJsonData(claims) ||
    !['sessionId', 'identityId', 'sessionVersion'].every((key) => Object.hasOwn(claims, key))
  )
    throw new AdminCatalogMutationError('unauthenticated')
  const authorization = await authorizeD1Session(database, claims, 'catalog.write', {
    now: now ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    requireMfa: true
  })
  if (!authorization.allowed) throw new AdminCatalogMutationError(authorization.code)
  return claims
}

export { authorize as authorizeD1CatalogMutation }

function receipt(row: CommandRow): Receipt | CatalogTypedAttributeValuesReceipt {
  const raw: unknown = JSON.parse(row.response)
  if (raw && typeof raw === 'object' && Object.hasOwn(raw, 'action'))
    return catalogTypedAttributeValuesReceiptSchema.parse(raw)
  const value = JSON.parse(row.response) as Receipt
  if (
    value?.source !== 'cloudflare' ||
    !Number.isSafeInteger(value.productId) ||
    value.productId < 1 ||
    typeof value.productUuid !== 'string' ||
    !Number.isSafeInteger(value.catalogVersion) ||
    value.catalogVersion < 2 ||
    value.updated !== true ||
    Object.keys(value).join(',') !== 'source,productId,productUuid,catalogVersion,updated'
  )
    throw new Error('invalid_catalog_draft_receipt')
  // Return the persisted object itself: replay never reconstructs a current
  // product view, changes field order, or claims the product is still a draft.
  return value
}

async function replay(
  database: D1Database,
  claims: VerifiedSessionClaims,
  key: string,
  payloadHash: string,
  now?: string
) {
  const row = await database
    .prepare(
      `WITH actor AS (${actorSql}) SELECT command.payload_hash, command.response
      FROM actor JOIN catalog_draft_commands command ON command.actor_id = actor.id
      JOIN catalog_draft_audit audit ON audit.command_id = command.id AND audit.actor_id = command.actor_id
        AND audit.product_id = command.product_id AND audit.product_legacy_id = command.product_legacy_id
        AND audit.before_version = command.expected_version AND audit.after_version = command.result_version
        AND audit.reason = command.reason AND audit.before_metadata = command.before_metadata
        AND audit.after_metadata = command.after_metadata AND audit.created_at = command.created_at
      WHERE command.idempotency_key = ?6`
    )
    .bind(...actorParameters(claims, now), key)
    .first<CommandRow>()
  if (row && row.payload_hash !== payloadHash) throw new AdminCatalogMutationError('idempotency_conflict')
  return row ? receipt(row) : null
}

function metadataSql(alias: string, after = false, includeTyped = false) {
  const column = (name: string) => `${alias}.${after ? 'next_' : ''}${name}`
  const attributes = column('attributes')
  return `json_object('name', ${column('name')}, 'categoryId', ${column('category_legacy_id')},
    'shortDesc', ${column('short_description')}, 'description', ${column('description')},
    'usage', ${column('usage')}, 'series', ${column('series')},
    'featured', json(CASE WHEN ${column('featured')} = 1 THEN 'true' ELSE 'false' END),
    'badges', json_extract(${attributes}, '$.badges'), 'visual', json_extract(${attributes}, '$.visual'),
    'attrs', json_extract(${attributes}, '$.attrs')${
      includeTyped
        ? `, 'typed', json(${attributes} -> '$.typed'),
      'typedPresent', json(CASE WHEN json_type(${attributes},'$.typed') IS NULL THEN 'false' ELSE 'true' END)`
        : ''
    })`
}

function nextAttributes(body: DraftProductMetadataInput) {
  let sql = 'p.attributes'
  if (Object.hasOwn(body, 'badges')) sql = `json_set(${sql}, '$.badges', json(json_extract(?6, '$.badges')))`
  if (Object.hasOwn(body, 'visual'))
    sql = `json_set(${sql}, '$.visual.type', json_extract(?6, '$.visual.type'), '$.visual.color', json_extract(?6, '$.visual.color'))`
  if (Object.hasOwn(body, 'attrs')) sql = `json_set(${sql}, '$.attrs', json(json_extract(?6, '$.attrs')))`
  if (Object.hasOwn(body, 'typed')) sql = `json_set(${sql}, '$.typed', json(json_extract(?6, '$.typed')))`
  return sql
}

function isConstraint(error: unknown) {
  if (!(error instanceof Error)) return false
  const code = (error as Error & { errcode?: number }).errcode
  return (
    (typeof code === 'number' && (code & 255) === 19) ||
    /catalog_draft_(?:atomic_guard|commands_|audit_)|SQLITE_CONSTRAINT|constraint failed/i.test(error.message)
  )
}

/** A narrow editorial command, never legacy full-product PUT. Every write,
 * audit and final rollback guard uses the live actor and the fresh claim nonce. */
export function updateD1DraftProductMetadata(
  database: D1Database,
  claimsInput: VerifiedSessionClaims | null,
  legacyId: string,
  input: { typed: CatalogTypedAttributeValues },
  options: { idempotencyKey: string; now?: string }
): Promise<CatalogTypedAttributeValuesReceipt>
export function updateD1DraftProductMetadata(
  database: D1Database,
  claimsInput: VerifiedSessionClaims | null,
  legacyId: string,
  input: unknown,
  options: { idempotencyKey: string; now?: string }
): Promise<Receipt>
export async function updateD1DraftProductMetadata(
  database: D1Database,
  claimsInput: VerifiedSessionClaims | null,
  legacyId: string,
  input: unknown,
  options: { idempotencyKey: string; now?: string }
): Promise<Receipt | CatalogTypedAttributeValuesReceipt> {
  if (
    typeof legacyId !== 'string' ||
    !options ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    !ownJsonData(options) ||
    !Object.hasOwn(options, 'idempotencyKey') ||
    typeof options.idempotencyKey !== 'string' ||
    hasInvalidControl(options.idempotencyKey) ||
    !/^[A-Za-z0-9._:-]{1,200}$/.test(options.idempotencyKey)
  )
    throw new AdminCatalogMutationError('invalid_input')
  options = ownJsonCopy(options) as typeof options
  const id = parseAdminCatalogLegacyId(legacyId)
  const parsed = draftProductMetadataSchema.safeParse(input)
  if (id === null || String(id) !== legacyId || !parsed.success) throw new AdminCatalogMutationError('invalid_input')
  if (
    options.now !== undefined &&
    (typeof options.now !== 'string' ||
      !Number.isFinite(Date.parse(options.now)) ||
      new Date(Date.parse(options.now)).toISOString().replace(/\.\d{3}Z$/, 'Z') !== options.now)
  )
    throw new AdminCatalogMutationError('invalid_input')
  const body = parsed.data
  const claims = await authorize(database, claimsInput, options.now)
  const patch = Object.fromEntries(
    METADATA_FIELDS.filter((field) => Object.hasOwn(body, field)).map((field) => [field, body[field]])
  )
  const patchJson = JSON.stringify(patch)
  const payload = JSON.stringify(['catalog.draft.metadata.v1', id, body.expectedVersion, body.reason, patch])
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload))
  const payloadHash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
  const previous = await replay(database, claims, options.idempotencyKey, payloadHash, options.now)
  if (previous) {
    await authorize(database, claims, options.now)
    return previous
  }
  await authorize(database, claims, options.now)
  const typedSnapshot = await validateD1CatalogTypedAttributePatch(database, claims, legacyId, body, options.now)
  const includesTyped = Object.hasOwn(body, 'typed')
  const validatesTyped = includesTyped || Object.hasOwn(body, 'categoryId')
  if (validatesTyped && !typedSnapshot) throw new AdminCatalogMutationError('conflict')
  const mutationActorSql = typedSnapshot
    ? `${actorSql} AND (?14 IS NULL OR typeof(?14)='text') AND json_valid(?15)`
    : actorSql

  const binds = [
    ...actorParameters(claims, options.now),
    patchJson,
    id,
    body.expectedVersion,
    body.reason,
    options.idempotencyKey,
    payloadHash,
    crypto.randomUUID(),
    crypto.randomUUID(),
    ...(typedSnapshot
      ? [
          typedSnapshot.rawTyped,
          JSON.stringify({ valid: typedSnapshot.previousValid, typed: typedSnapshot.canonicalPrevious })
        ]
      : [])
  ]
  const nextColumn = (column: string, field: string) =>
    `CASE WHEN json_type(?6, '$.${field}') IS NULL THEN p.${column} ELSE json_extract(?6, '$.${field}') END`
  const targetSql = `SELECT p.*, category.legacy_id AS category_legacy_id,
    CASE WHEN json_type(?6, '$.categoryId') IS NULL THEN p.category_id ELSE next_category.id END AS next_category_id,
    CASE WHEN json_type(?6, '$.categoryId') IS NULL THEN category.legacy_id ELSE next_category.legacy_id END AS next_category_legacy_id,
    ${nextColumn('name', 'name')} AS next_name,
    ${nextColumn('short_description', 'shortDesc')} AS next_short_description,
    ${nextColumn('description', 'description')} AS next_description,
    ${nextColumn('usage', 'usage')} AS next_usage,
    ${nextColumn('series', 'series')} AS next_series,
    ${nextColumn('featured', 'featured')} AS next_featured,
    ${nextAttributes(body)} AS next_attributes
    FROM products p JOIN categories category ON category.id = p.category_id
    LEFT JOIN categories next_category ON next_category.legacy_id = json_extract(?6, '$.categoryId')
    WHERE p.legacy_id = ?7 AND category.legacy_id BETWEEN 1 AND 9007199254740991
      AND json_type(p.attributes) = 'object'
      ${typedSnapshot ? "AND (p.attributes -> '$.typed') IS ?14" : ''}
      AND (json_type(?6, '$.visual') IS NULL OR json_type(p.attributes, '$.visual') IS NULL
        OR json_type(p.attributes, '$.visual') = 'object')`
  const typedTargetCtes = validatesTyped
    ? catalogTypedAttributeReplacementValidityCtes(
        'target.next_attributes',
        "json_object('typed',json_extract(?15,'$.typed'))",
        'target.next_category_id',
        'target.id',
        "json_extract(?15,'$.valid')"
      )
    : ''
  const typedTargetValidity = validatesTyped ? '(SELECT valid FROM typed_replacement_validity)' : '1'
  const responseSql = includesTyped
    ? `json_object('source','cloudflare','action','update_values','commandId',?12,'productId',target.legacy_id,
        'productUuid',target.id,'catalogVersion',CAST(?8+1 AS INTEGER),'typed',json_extract(target.next_attributes,'$.typed'),'updated',json('true'))`
    : `json_object('source', 'cloudflare', 'productId', target.legacy_id, 'productUuid', target.id,
          'catalogVersion', ?8 + 1, 'updated', json('true'))`
  const claim = database
    .prepare(
      `WITH actor AS (${mutationActorSql}), target AS (${targetSql})${typedTargetCtes} INSERT INTO catalog_draft_commands
      (id, claim_nonce, actor_id, product_id, product_legacy_id, idempotency_key, payload_hash,
       expected_version, result_version, reason, patch, before_metadata, after_metadata, response, created_at)
      SELECT ?12, ?13, actor.id, target.id, target.legacy_id, ?10, ?11,
        ?8, ?8 + 1, ?9, ?6, ${metadataSql('target', false, includesTyped)}, ${metadataSql('target', true, includesTyped)},
        ${responseSql}, ${executionNow}
      FROM actor CROSS JOIN target WHERE target.status = 'draft' AND target.catalog_version = ?8
        AND target.next_category_id IS NOT NULL AND target.next_category_legacy_id BETWEEN 1 AND 9007199254740991
        AND ${typedTargetValidity}
        AND NOT EXISTS (SELECT 1 FROM catalog_draft_commands WHERE actor_id = actor.id AND idempotency_key = ?10)`
    )
    .bind(...binds)
  const update = database
    .prepare(
      `WITH actor AS (${mutationActorSql}), target AS MATERIALIZED (${targetSql})${typedTargetCtes} UPDATE products SET
        category_id = (SELECT next_category_id FROM target), name = (SELECT next_name FROM target),
        short_description = (SELECT next_short_description FROM target), description = (SELECT next_description FROM target),
        usage = (SELECT next_usage FROM target), series = (SELECT next_series FROM target),
        featured = (SELECT next_featured FROM target), attributes = (SELECT next_attributes FROM target),
        catalog_version = catalog_version + 1, updated_at = ${executionNow}
      WHERE legacy_id = ?7 AND status = 'draft' AND catalog_version = ?8
        AND EXISTS (SELECT 1 FROM actor JOIN catalog_draft_commands command ON command.actor_id = actor.id
          WHERE command.id = ?12 AND command.claim_nonce = ?13 AND command.payload_hash = ?11 AND command.product_id = products.id
            AND command.idempotency_key = ?10 AND command.expected_version = ?8
            AND command.before_metadata = (SELECT ${metadataSql('target', false, includesTyped)} FROM target))
        AND EXISTS (SELECT 1 FROM target WHERE next_category_id IS NOT NULL AND next_category_legacy_id BETWEEN 1 AND 9007199254740991
          AND ${typedTargetValidity})`
    )
    .bind(...binds)
  const audit = database
    .prepare(
      `WITH actor AS (${mutationActorSql}) INSERT INTO catalog_draft_audit
      (id, command_id, actor_id, product_id, product_legacy_id, before_version, after_version,
        reason, before_metadata, after_metadata, created_at)
      SELECT ?${binds.length + 1}, command.id, actor.id, command.product_id, command.product_legacy_id,
        command.expected_version, command.result_version, command.reason, command.before_metadata,
        command.after_metadata, command.created_at
      FROM actor JOIN catalog_draft_commands command ON command.actor_id = actor.id
      JOIN products p ON p.id = command.product_id AND p.catalog_version = command.result_version AND p.status = 'draft'
      WHERE command.id = ?12 AND command.claim_nonce = ?13 AND command.payload_hash = ?11 AND command.idempotency_key = ?10`
    )
    .bind(...binds, crypto.randomUUID())
  const result = database
    .prepare(
      `WITH actor AS (${mutationActorSql}) SELECT command.payload_hash, command.response
      FROM actor JOIN catalog_draft_commands command ON command.actor_id = actor.id
      WHERE command.id = ?12 AND command.claim_nonce = ?13 AND command.payload_hash = ?11 AND command.idempotency_key = ?10`
    )
    .bind(...binds)
  const typedGuardCtes = validatesTyped
    ? `, target AS MATERIALIZED (
    SELECT p.*,command.before_metadata FROM products p JOIN catalog_draft_commands command ON command.product_id=p.id
    WHERE command.id=?12 AND command.claim_nonce=?13
  )${catalogTypedAttributeReplacementValidityCtes('target.attributes', "json_object('typed',json_extract(?15,'$.typed'))", 'target.category_id', 'target.id', "json_extract(?15,'$.valid')")}`
    : ''
  const guard = database
    .prepare(
      `WITH actor AS (${mutationActorSql})${typedGuardCtes} INSERT INTO catalog_draft_guards(id, satisfied)
      SELECT lower(hex(randomblob(16))), 0 WHERE NOT EXISTS (
        SELECT 1 FROM actor JOIN catalog_draft_commands command ON command.actor_id = actor.id
        JOIN catalog_draft_audit audit ON audit.command_id = command.id
          AND audit.actor_id = actor.id AND audit.product_id = command.product_id
          AND audit.before_version = command.expected_version AND audit.after_version = command.result_version
          AND audit.before_metadata = command.before_metadata AND audit.after_metadata = command.after_metadata
        JOIN products p ON p.id = command.product_id AND p.catalog_version = command.result_version AND p.status = 'draft'
        JOIN categories category ON category.id = p.category_id AND category.legacy_id BETWEEN 1 AND 9007199254740991
        WHERE command.id = ?12 AND command.claim_nonce = ?13 AND command.payload_hash = ?11 AND command.idempotency_key = ?10
          AND command.product_legacy_id = p.legacy_id AND command.result_version = ?8 + 1
          AND command.after_metadata = ${metadataSql('p', false, includesTyped).replaceAll('p.category_legacy_id', 'category.legacy_id')}
          ${
            includesTyped
              ? `AND command.response = json_object('source','cloudflare','action','update_values','commandId',command.id,
            'productId',p.legacy_id,'productUuid',p.id,'catalogVersion',p.catalog_version,
            'typed',json_extract(p.attributes,'$.typed'),'updated',json('true'))`
              : ''
          }
          ${validatesTyped ? `AND (SELECT valid FROM typed_replacement_validity)=1` : ''}
      )`
    )
    .bind(...binds)
  try {
    const results = await database.batch<CommandRow>([claim, update, audit, result, guard])
    const row = results[3]?.results[0]
    if (!row) throw new AdminCatalogMutationError('conflict')
    await authorize(database, claims, options.now)
    return receipt(row)
  } catch (error) {
    if (!isConstraint(error) && !(error instanceof AdminCatalogMutationError)) throw error
    await authorize(database, claims, options.now)
    const winner = await replay(database, claims, options.idempotencyKey, payloadHash, options.now)
    if (winner) {
      await authorize(database, claims, options.now)
      return winner
    }
    const target = await database
      .prepare(
        `WITH actor AS (${actorSql}) SELECT p.status, p.catalog_version FROM actor CROSS JOIN products p
        JOIN categories category ON category.id = p.category_id
        WHERE p.legacy_id = ?6 AND category.legacy_id BETWEEN 1 AND 9007199254740991`
      )
      .bind(...actorParameters(claims, options.now), id)
      .first<{ status: string; catalog_version: number }>()
    await authorize(database, claims, options.now)
    if (!target) throw new AdminCatalogMutationError('not_found')
    if (target.status !== 'draft') throw new AdminCatalogMutationError('product_not_editable')
    if (target.catalog_version !== body.expectedVersion) throw new AdminCatalogMutationError('version_conflict')
    if (body.categoryId !== undefined) {
      const category = await database
        .prepare('SELECT id FROM categories WHERE legacy_id = ? AND legacy_id BETWEEN 1 AND 9007199254740991')
        .bind(body.categoryId)
        .first()
      await authorize(database, claims, options.now)
      if (!category) throw new AdminCatalogMutationError('invalid_input')
    }
    await validateD1CatalogTypedAttributePatch(database, claims, legacyId, body, options.now)
    throw new AdminCatalogMutationError('conflict')
  }
}

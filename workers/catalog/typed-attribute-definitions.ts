import { z } from 'zod'
import {
  CATALOG_TYPED_ATTRIBUTE_MAX_DEFINITIONS,
  catalogTypedAttributeDefinitionSchema,
  catalogTypedAttributeReceiptSchema,
  createCatalogTypedAttributeDefinitionSchema,
  updateCatalogTypedAttributeDefinitionSchema,
  retireCatalogTypedAttributeDefinitionSchema,
  type CatalogTypedAttributeDefinition,
  type CatalogTypedAttributeDefinitionAction,
  type CatalogTypedAttributeReceipt,
  type CreateCatalogTypedAttributeDefinitionInput,
  type UpdateCatalogTypedAttributeDefinitionInput,
  type RetireCatalogTypedAttributeDefinitionInput
} from '../../shared/catalog-typed-attributes'
import {
  catalogPolicyInstantSchema,
  catalogPolicyOwnJson,
  catalogPolicyUuidSchema
} from '../../shared/catalog-publication-policy'
import { catalogCategoryClaimsSchema } from '../../shared/catalog-category-commands'
import { isD1CheckConstraintFailure } from '../runtime/d1-errors'
import { authorizeD1Session, type VerifiedSessionClaims } from './authorization'

export class CatalogTypedAttributeDefinitionError extends Error {
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
      | 'reference_unavailable'
      | 'definition_retired'
      | 'invalid_config_transition'
      | 'conflict'
  ) {
    super(code)
  }
}
export const CATALOG_TYPED_ATTRIBUTE_DEFINITION_WRITE_PERMISSION = 'administration.manage'
export const CATALOG_TYPED_ATTRIBUTE_MAX_HISTORY_READ_ROWS = 256
const positive = z
  .number()
  .int()
  .min(1)
  .max(Number.MAX_SAFE_INTEGER - 1)
type Options = { idempotencyKey: string; now?: string }
type Command =
  | { action: 'create'; body: CreateCatalogTypedAttributeDefinitionInput }
  | { action: 'update'; body: UpdateCatalogTypedAttributeDefinitionInput }
  | { action: 'retire'; body: RetireCatalogTypedAttributeDefinitionInput }
const clock = "COALESCE(?1,strftime('%Y-%m-%dT%H:%M:%SZ','now'))"
const actorSql = `SELECT i.id FROM auth_sessions s JOIN identities i ON i.id=s.identity_id AND i.session_version=s.session_version
  WHERE s.id=?2 AND s.identity_id=?3 AND s.session_version=?4 AND s.revoked_at IS NULL
  AND s.created_at<=${clock} AND s.expires_at>${clock} AND s.mfa_verified=1
  AND i.status IN ('pending','active') AND i.email_verified_at IS NOT NULL AND i.email_verified_at<=${clock}
  AND EXISTS(SELECT 1 FROM identity_roles assigned JOIN role_permissions granted ON granted.role_code=assigned.role_code
    WHERE assigned.identity_id=i.id AND granted.permission_code=?5 AND assigned.granted_at<=${clock}
    AND (assigned.expires_at IS NULL OR assigned.expires_at>${clock}))
  AND EXISTS(SELECT 1 FROM identity_roles assigned JOIN role_permissions granted ON granted.role_code=assigned.role_code
    WHERE assigned.identity_id=i.id AND granted.permission_code='catalog.write' AND assigned.granted_at<=${clock}
    AND (assigned.expires_at IS NULL OR assigned.expires_at>${clock}))`
const withActor = `WITH params AS(SELECT ?6 AS value),actor AS(${actorSql})`
const j = (field: string) => `json_extract(?6,'$.${field}')`
const auditColumns =
  'actor_id,action,definition_id,category_id,expected_revision,result_revision,reason,input,before_state,after_state,response,created_at'
const auditMatch = auditColumns
  .split(',')
  .map((field) => `a.${field} IS c.${field}`)
  .concat('a.command_id=c.id')
  .join(' AND ')
const ownership = `c.id=${j('id')} AND c.claim_nonce=${j('nonce')} AND c.actor_id=?3
  AND c.idempotency_key=${j('key')} AND c.payload_hash=${j('hash')} AND c.action=${j('action')}
  AND c.definition_id=${j('definitionId')} AND c.category_id=${j('categoryUuid')}
  AND c.expected_revision=${j('expectedVersion')} AND c.input=${j('input')}
  AND c.before_state IS ${j('before')} AND c.after_state=${j('after')} AND c.response=${j('response')}`
const owned = `${withActor},owned AS(SELECT c.* FROM actor JOIN catalog_typed_attribute_commands c ON c.actor_id=actor.id WHERE ${ownership})`
function rowObject(d = 'd', r = 'r', category = 'category') {
  // Keep the same canonical key order as the shared definition schema. Nine
  // pairs fit D1's bounded function arity without aggregate JSON snapshots.
  return `json_object('id',${d}.id,'categoryId',${category}.legacy_id,'categoryUuid',${d}.category_id,
    'code',${d}.code,'label',${r}.label,'revision',${r}.revision,'status',${r}.status,
    'kind',${d}.kind,'config',json(${r}.config))`
}
const currentState = `(SELECT ${rowObject()} FROM catalog_typed_attribute_definitions d
  JOIN catalog_typed_attribute_revisions r ON r.definition_id=d.id AND r.revision=d.current_revision
  JOIN categories category ON category.id=d.category_id WHERE d.id=${j('definitionId')})`
const categoryPresent = `EXISTS(SELECT 1 FROM categories category WHERE category.id=${j('categoryUuid')}
  AND category.legacy_id=${j('categoryId')} AND category.status<>'discontinued')`
const post = `${currentState}=c.after_state AND ${categoryPresent}
  AND EXISTS(SELECT 1 FROM catalog_typed_attribute_definitions d WHERE d.id=c.definition_id
    AND d.current_revision=c.result_revision AND d.status=json_extract(c.after_state,'$.status')
    AND d.updated_at=c.created_at AND (c.action<>'create' OR d.created_at=c.created_at))
  AND EXISTS(SELECT 1 FROM catalog_typed_attribute_revisions r WHERE r.definition_id=c.definition_id
    AND r.revision=c.result_revision AND r.command_id=c.id AND r.created_at=c.created_at)
  AND (SELECT count(*) FROM catalog_typed_attribute_definitions WHERE category_id=c.category_id)<=${CATALOG_TYPED_ATTRIBUTE_MAX_DEFINITIONS}`

function own(value: unknown): unknown {
  try {
    return catalogPolicyOwnJson(value)
  } catch {
    return undefined
  }
}
function checked<T>(
  schema: z.ZodType<T, unknown>,
  value: unknown,
  code: 'invalid_input' | 'unauthenticated' = 'invalid_input'
): T {
  const result = schema.safeParse(own(value))
  if (!result.success) throw new CatalogTypedAttributeDefinitionError(code)
  return result.data
}
async function authorize(database: D1Database, claims: VerifiedSessionClaims, now?: string) {
  for (const permission of [CATALOG_TYPED_ATTRIBUTE_DEFINITION_WRITE_PERMISSION, 'catalog.write']) {
    const result = await authorizeD1Session(database, claims, permission, {
      requireMfa: true,
      ...(now === undefined ? {} : { now })
    })
    if (!result.allowed) throw new CatalogTypedAttributeDefinitionError(result.code)
  }
}
function parameters(claims: VerifiedSessionClaims, now: string | undefined, context: unknown) {
  return [
    now ?? null,
    claims.sessionId,
    claims.identityId,
    claims.sessionVersion,
    CATALOG_TYPED_ATTRIBUTE_DEFINITION_WRITE_PERMISSION,
    JSON.stringify(context)
  ]
}
function parseDefinition(raw: unknown): CatalogTypedAttributeDefinition {
  if (typeof raw !== 'string' || new TextEncoder().encode(raw).byteLength > 262144)
    throw new Error('typed_attribute_source_unavailable')
  const result = catalogTypedAttributeDefinitionSchema.safeParse(JSON.parse(raw))
  if (!result.success) throw new Error('typed_attribute_source_unavailable')
  return result.data
}
function parseReceipt(raw: string): CatalogTypedAttributeReceipt {
  return catalogTypedAttributeReceiptSchema.parse(JSON.parse(raw))
}
async function replay(database: D1Database, claims: VerifiedSessionClaims, key: string, hash: string, now?: string) {
  const raw = await database
    .prepare(
      `${withActor} SELECT c.payload_hash,c.response,
    EXISTS(SELECT 1 FROM catalog_typed_attribute_audit a WHERE ${auditMatch}) AS completed
    FROM actor JOIN catalog_typed_attribute_commands c ON c.actor_id=actor.id WHERE c.idempotency_key=${j('key')}`
    )
    .bind(...parameters(claims, now, { key }))
    .first()
  await authorize(database, claims, now)
  if (!raw) return null
  const row = z
    .object({
      payload_hash: z.string().regex(/^[a-f0-9]{64}$/),
      response: z.string().max(262144),
      completed: z.union([z.literal(0), z.literal(1)])
    })
    .strict()
    .safeParse(own(raw))
  if (!row.success) throw new Error('typed_attribute_replay_unavailable')
  if (row.data.payload_hash !== hash) throw new CatalogTypedAttributeDefinitionError('idempotency_conflict')
  if (row.data.completed !== 1) throw new CatalogTypedAttributeDefinitionError('conflict')
  return parseReceipt(row.data.response)
}
async function current(database: D1Database, id: string): Promise<CatalogTypedAttributeDefinition | null> {
  const raw = await database
    .prepare(
      `SELECT ${rowObject()} AS state FROM catalog_typed_attribute_definitions d
    LEFT JOIN catalog_typed_attribute_revisions r ON r.definition_id=d.id AND r.revision=d.current_revision
    JOIN categories category ON category.id=d.category_id WHERE d.id=?1`
    )
    .bind(id)
    .first()
  if (!raw) return null
  const row = z.object({ state: z.string() }).strict().safeParse(own(raw))
  if (!row.success) throw new Error('typed_attribute_source_unavailable')
  return parseDefinition(row.data.state)
}
function requireTransition(before: CatalogTypedAttributeDefinition, after: CatalogTypedAttributeDefinition) {
  if (before.kind === 'list' && after.kind === 'list') {
    for (const old of before.config.options) {
      const next = after.config.options.find((option) => option.code === old.code)
      if (!next || (old.status === 'retired' && next.status !== 'retired'))
        throw new CatalogTypedAttributeDefinitionError('invalid_config_transition')
    }
  }
}
function constraint(failure: unknown): boolean {
  if (!(failure instanceof Error)) return false
  const code: unknown = Object.getOwnPropertyDescriptor(failure, 'errcode')?.value
  const message: unknown = Object.getOwnPropertyDescriptor(failure, 'message')?.value
  return (
    (typeof code === 'number' && (code & 255) === 19) ||
    isD1CheckConstraintFailure(failure) ||
    (typeof message === 'string' &&
      (/^(?:D1_ERROR: )?catalog_typed_attribute_[a-z_]+(?:: SQLITE_CONSTRAINT(?: \(extended: SQLITE_CONSTRAINT_TRIGGER\))?)?$/.test(
        message
      ) ||
        /^(?:D1_ERROR: )?(?:UNIQUE|FOREIGN KEY|NOT NULL) constraint failed(?:: [A-Za-z0-9_., ]+)?(?:: SQLITE_CONSTRAINT(?: \(extended: SQLITE_CONSTRAINT_[A-Z_]+\))?)?$/.test(
          message
        )))
  )
}
/** Internal bounded category read. The HTTP adapter owns read authorization.
 * Historical reads include retirement by default and fail rather than truncate.
 * Prefer querying only needed revisions when a category exceeds the bound. */
export async function readD1CatalogTypedAttributeDefinitions(
  database: D1Database,
  categoryId: number,
  options: { historical?: boolean; includeRetired?: boolean } = {}
): Promise<CatalogTypedAttributeDefinition[]> {
  const id = checked(positive, categoryId)
  const opts = checked(
    z.object({ historical: z.boolean().optional(), includeRetired: z.boolean().optional() }).strict(),
    options
  )
  const historical = opts.historical ?? false,
    includeRetired = opts.includeRetired ?? historical
  const maximum = historical ? CATALOG_TYPED_ATTRIBUTE_MAX_HISTORY_READ_ROWS : CATALOG_TYPED_ATTRIBUTE_MAX_DEFINITIONS
  const result = await database
    .prepare(
      `SELECT ${rowObject()} AS state FROM catalog_typed_attribute_definitions d
    JOIN categories category ON category.id=d.category_id
    LEFT JOIN catalog_typed_attribute_revisions r ON r.definition_id=d.id${historical ? '' : ' AND r.revision=d.current_revision'}
    WHERE category.legacy_id=?1 ${includeRetired ? '' : "AND d.status='active'"}
    ORDER BY d.code,r.revision LIMIT ${maximum + 1}`
    )
    .bind(id)
    .all()
  const rows = z
    .object({ success: z.literal(true), results: z.array(z.object({ state: z.string() }).strict()).max(maximum) })
    .passthrough()
    .safeParse(own(result))
  if (!rows.success) throw new Error('typed_attribute_read_unavailable')
  return rows.data.results.map((row) => parseDefinition(row.state))
}

/** Live administration.manage AND catalog.write/MFA before replay and in each D1 statement. One
 * owned transaction creates header/revision/receipt/audit; no product mutation,
 * media rights, publication authority, implicit definitions or historical delete. */
export async function executeD1CatalogTypedAttributeDefinitionCommand(
  database: D1Database,
  claimsInput: VerifiedSessionClaims | null,
  actionInput: CatalogTypedAttributeDefinitionAction,
  targetInput: { definitionId?: string },
  raw: unknown,
  options: Options
): Promise<CatalogTypedAttributeReceipt> {
  const action = checked(z.enum(['create', 'update', 'retire']), actionInput)
  const cmd: Command =
    action === 'create'
      ? { action, body: checked(createCatalogTypedAttributeDefinitionSchema, raw) }
      : action === 'update'
        ? { action, body: checked(updateCatalogTypedAttributeDefinitionSchema, raw) }
        : { action, body: checked(retireCatalogTypedAttributeDefinitionSchema, raw) }
  const target = checked(z.object({ definitionId: catalogPolicyUuidSchema.optional() }).strict(), targetInput)
  if ((action !== 'create') !== Object.hasOwn(target, 'definitionId'))
    throw new CatalogTypedAttributeDefinitionError('invalid_input')
  const opts = checked(
    z
      .object({
        idempotencyKey: z
          .string()
          .min(1)
          .max(200)
          .regex(/^[A-Za-z0-9._:-]+$/),
        now: catalogPolicyInstantSchema.optional()
      })
      .strict(),
    options
  )
  const claims = checked(catalogCategoryClaimsSchema, claimsInput, 'unauthenticated')
  await authorize(database, claims, opts.now)
  const bytes = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(['catalog.typed-attribute.definition.v1', action, target, cmd.body]))
  )
  const hash = Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('')
  const previous = await replay(database, claims, opts.idempotencyKey, hash, opts.now)
  if (previous) return previous
  const before = action === 'create' ? null : await current(database, target.definitionId!)
  await authorize(database, claims, opts.now)
  if (action !== 'create' && !before) throw new CatalogTypedAttributeDefinitionError('not_found')
  if (before && (before.revision !== cmd.body.expectedVersion || before.revision >= Number.MAX_SAFE_INTEGER - 1))
    throw new CatalogTypedAttributeDefinitionError('version_conflict')
  if (before?.status === 'retired') throw new CatalogTypedAttributeDefinitionError('definition_retired')
  const categoryId = cmd.action === 'create' ? cmd.body.categoryId : before!.categoryId
  const categoryRaw = await database
    .prepare('SELECT id,status FROM categories WHERE legacy_id=?1')
    .bind(categoryId)
    .first()
  const category = z
    .object({ id: z.string().min(1).max(200), status: z.string() })
    .strict()
    .safeParse(own(categoryRaw))
  await authorize(database, claims, opts.now)
  if (!category.success || category.data.status === 'discontinued')
    throw new CatalogTypedAttributeDefinitionError('reference_unavailable')
  if (before && before.categoryUuid !== category.data.id) throw new CatalogTypedAttributeDefinitionError('conflict')
  const id = before?.id ?? crypto.randomUUID()
  const definition = checked(
    catalogTypedAttributeDefinitionSchema,
    cmd.action === 'create'
      ? {
          id,
          categoryId,
          categoryUuid: category.data.id,
          code: cmd.body.code,
          kind: cmd.body.kind,
          label: cmd.body.label,
          config: cmd.body.config,
          revision: 1,
          status: 'active'
        }
      : {
          ...before!,
          label: cmd.action === 'update' ? cmd.body.label : before!.label,
          config: cmd.action === 'update' ? cmd.body.config : before!.config,
          revision: before!.revision + 1,
          status: cmd.action === 'retire' ? 'retired' : 'active'
        }
  )
  if (before) requireTransition(before, definition)
  const commandId = crypto.randomUUID(),
    nonce = crypto.randomUUID()
  const response = catalogTypedAttributeReceiptSchema.parse({
    source: 'cloudflare',
    action,
    commandId,
    definition,
    updated: true
  })
  const context = {
    id: commandId,
    nonce,
    action,
    definitionId: id,
    categoryId,
    categoryUuid: category.data.id,
    code: definition.code,
    kind: definition.kind,
    expectedVersion: cmd.body.expectedVersion,
    input: JSON.stringify(cmd.body),
    before: before === null ? null : JSON.stringify(before),
    after: JSON.stringify(definition),
    response: JSON.stringify(response),
    key: opts.idempotencyKey,
    hash
  }
  const bound = parameters(claims, opts.now, context)
  const pre = `${categoryPresent} AND ${
    action === 'create'
      ? `
    NOT EXISTS(SELECT 1 FROM catalog_typed_attribute_definitions WHERE id=${j('definitionId')} OR (category_id=${j('categoryUuid')} AND code=${j('code')}))
    AND (SELECT count(*) FROM catalog_typed_attribute_definitions WHERE category_id=${j('categoryUuid')})<${CATALOG_TYPED_ATTRIBUTE_MAX_DEFINITIONS}`
      : `
    ${currentState} IS ${j('before')} AND EXISTS(SELECT 1 FROM catalog_typed_attribute_definitions WHERE id=${j('definitionId')} AND current_revision=${j('expectedVersion')} AND status='active')`
  }`
  const sql: string[] = [
    `${withActor} INSERT INTO catalog_typed_attribute_commands(id,claim_nonce,${auditColumns},idempotency_key,payload_hash)
      SELECT ${j('id')},${j('nonce')},actor.id,${j('action')},${j('definitionId')},${j('categoryUuid')},${j('expectedVersion')},${j('expectedVersion')}+1,
      json_extract(${j('input')},'$.reason'),${j('input')},${j('before')},${j('after')},${j('response')},${clock},${j('key')},${j('hash')}
      FROM actor WHERE ${pre} AND NOT EXISTS(SELECT 1 FROM catalog_typed_attribute_commands WHERE actor_id=actor.id AND idempotency_key=${j('key')})`,
    `${owned} INSERT INTO catalog_typed_attribute_guards(id,satisfied) SELECT ${j('id')},0 WHERE NOT EXISTS(SELECT 1 FROM owned)`
  ]
  if (action === 'create') {
    sql.push(`${owned} INSERT INTO catalog_typed_attribute_definitions(id,category_id,code,kind,current_revision,status,created_at,updated_at)
      SELECT c.definition_id,c.category_id,json_extract(c.after_state,'$.code'),json_extract(c.after_state,'$.kind'),c.result_revision,
      json_extract(c.after_state,'$.status'),c.created_at,c.created_at FROM owned c`)
    // An ignored parent must become a semantic conflict before child FK writes.
    sql.push(`${owned} INSERT INTO catalog_typed_attribute_guards(id,satisfied) SELECT ${j('id')},0 WHERE NOT EXISTS(
      SELECT 1 FROM owned c JOIN catalog_typed_attribute_definitions d ON d.id=c.definition_id WHERE d.category_id=c.category_id
      AND d.code=${j('code')} AND d.kind=${j('kind')} AND d.current_revision=1 AND d.status='active' AND d.created_at=c.created_at AND d.updated_at=c.created_at)`)
  }
  sql.push(`${owned} INSERT INTO catalog_typed_attribute_revisions(definition_id,revision,label,status,config,created_at,command_id)
    SELECT c.definition_id,c.result_revision,json_extract(c.after_state,'$.label'),json_extract(c.after_state,'$.status'),
    json_extract(c.after_state,'$.config'),c.created_at,c.id FROM owned c`)
  if (action !== 'create')
    sql.push(`${owned} UPDATE catalog_typed_attribute_definitions SET current_revision=${j('expectedVersion')}+1,
    status=(SELECT json_extract(after_state,'$.status') FROM owned),updated_at=(SELECT created_at FROM owned)
    WHERE id=${j('definitionId')} AND current_revision=${j('expectedVersion')} AND EXISTS(SELECT 1 FROM owned)`)
  sql.push(`${owned} INSERT INTO catalog_typed_attribute_audit(id,command_id,${auditColumns})
    SELECT c.id,c.id,${auditColumns
      .split(',')
      .map((field) => `c.${field}`)
      .join(',')} FROM owned c WHERE ${post}`)
  sql.push(`${withActor} SELECT c.response FROM actor JOIN catalog_typed_attribute_commands c ON c.actor_id=actor.id
    JOIN catalog_typed_attribute_audit a ON ${auditMatch} WHERE ${ownership} AND ${post}`)
  sql.push(`${withActor} INSERT INTO catalog_typed_attribute_guards(id,satisfied) SELECT ${j('id')},0 WHERE NOT EXISTS(
    SELECT 1 FROM actor JOIN catalog_typed_attribute_commands c ON c.actor_id=actor.id
    JOIN catalog_typed_attribute_audit a ON ${auditMatch} WHERE ${ownership} AND ${post})`)
  try {
    const rawResults = await database.batch(sql.map((statement) => database.prepare(statement).bind(...bound)))
    const results = z
      .array(z.object({ success: z.literal(true), results: z.array(z.unknown()).max(1) }).passthrough())
      .length(sql.length)
      .safeParse(own(rawResults))
    if (!results.success) throw new Error('typed_attribute_write_unavailable')
    const selected = z
      .array(z.object({ response: z.string().max(262144) }).strict())
      .length(1)
      .safeParse(results.data[sql.length - 2]!.results)
    if (!selected.success) throw new Error('typed_attribute_write_unavailable')
    await authorize(database, claims, opts.now)
    return parseReceipt(selected.data[0]!.response)
  } catch (failure) {
    if (!constraint(failure)) throw failure
    const winner = await replay(database, claims, opts.idempotencyKey, hash, opts.now)
    if (winner) return winner
    const latest = await current(database, id)
    if (latest && latest.revision !== cmd.body.expectedVersion) {
      if (action !== 'create') throw new CatalogTypedAttributeDefinitionError('version_conflict')
    }
    throw new CatalogTypedAttributeDefinitionError('conflict')
  }
}

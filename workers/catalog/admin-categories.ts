import { z } from 'zod'
import {
  categoryHasControls,
  catalogCategoryActionSchema,
  catalogCategoryClaimsSchema,
  catalogCategoryReceiptSchema,
  catalogCategoryStatusSchema,
  createCategoryInputSchema,
  updateCategoryInputSchema,
  deleteCategoryInputSchema,
  type CatalogCategoryAction,
  type CatalogCategoryReceipt,
  type CreateCategoryInput,
  type UpdateCategoryInput,
  type DeleteCategoryInput
} from '../../shared/catalog-category-commands'
import { catalogPolicyOwnJson, catalogPolicyInstantSchema } from '../../shared/catalog-publication-policy'
import { slugify } from '../../server/utils/slug'
import { isD1CheckConstraintFailure } from '../runtime/d1-errors'
import { authorizeD1Session, type VerifiedSessionClaims } from './authorization'

export const CATEGORY_WRITE_PERMISSION = 'administration.manage'
export class CatalogCategoryError extends Error {
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
      | 'invalid_hierarchy'
      | 'visibility_expansion'
      | 'category_not_editable'
      | 'category_not_empty'
      | 'conflict'
  ) {
    super(code)
  }
}
const safeId = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)
const legacy = z
  .string()
  .max(16)
  .regex(/^[1-9][0-9]*$/)
  .refine((value) => Number.isSafeInteger(Number(value)) && String(Number(value)) === value)
type Command =
  | { action: 'create_category'; body: CreateCategoryInput }
  | { action: 'update_category'; body: UpdateCategoryInput }
  | { action: 'delete_category'; body: DeleteCategoryInput }
function checked<T, I>(
  schema: z.ZodType<T, z.ZodTypeDef, I>,
  value: unknown,
  code: 'invalid_input' | 'unauthenticated' = 'invalid_input'
): T {
  let plain: unknown
  try {
    plain = catalogPolicyOwnJson(value)
  } catch {
    throw new CatalogCategoryError(code)
  }
  const result = schema.safeParse(plain)
  if (!result.success) throw new CatalogCategoryError(code)
  return result.data
}
const columns = [
  'id',
  'legacy_id',
  'parent_id',
  'name',
  'slug',
  'description',
  'sort_order',
  'status',
  'seo_title',
  'seo_description',
  'source_id',
  'source_version',
  'created_at',
  'updated_at',
  'category_version'
] as const
function rowObject(alias: string, overrides: Readonly<Record<string, string>> = {}) {
  return `json_object(${columns.map((column) => `'${column}',${overrides[column] ?? `${alias}.${column}`}`).join(',')})`
}
const graphSql = `(SELECT COALESCE(json_group_array(json(state)),'[]') FROM (SELECT ${rowObject('category')} AS state FROM categories category ORDER BY category.id LIMIT 1001))`
const clock = "COALESCE(?1,strftime('%Y-%m-%dT%H:%M:%SZ','now'))"
const actorSql = `SELECT i.id FROM auth_sessions s JOIN identities i ON i.id=s.identity_id AND i.session_version=s.session_version
 WHERE s.id=?2 AND s.identity_id=?3 AND s.session_version=?4 AND s.revoked_at IS NULL
 AND s.created_at<=${clock} AND s.expires_at>${clock} AND s.mfa_verified=1
 AND i.status IN ('pending','active') AND i.email_verified_at IS NOT NULL AND i.email_verified_at<=${clock}
 AND EXISTS(SELECT 1 FROM identity_roles assigned JOIN role_permissions granted ON granted.role_code=assigned.role_code
 WHERE assigned.identity_id=i.id AND granted.permission_code=?5 AND assigned.granted_at<=${clock}
 AND (assigned.expires_at IS NULL OR assigned.expires_at>${clock}))`
const withActor = `WITH params AS (SELECT ?17 AS value),actor AS (${actorSql})`
const owned =
  'c.id=?12 AND c.claim_nonce=?13 AND c.actor_id=?3 AND c.action=?6 AND c.idempotency_key=?10 AND c.payload_hash=?11 AND c.target=?17 AND c.input=?9'
const auditColumns =
  'actor_id,action,target,input,category_id,category_uuid,expected_version,result_version,reason,before_graph,before_state,after_state,response,created_at'
const auditMatch = auditColumns
  .split(',')
  .map((column) => `a.${column} IS c.${column}`)
  .concat('a.command_id=c.id')
  .join(' AND ')
function actorParameters(claims: VerifiedSessionClaims, now?: string) {
  return [now ?? null, claims.sessionId, claims.identityId, claims.sessionVersion, CATEGORY_WRITE_PERMISSION] as const
}
async function authorize(database: D1Database, claims: VerifiedSessionClaims, now?: string) {
  const auth = await authorizeD1Session(database, claims, CATEGORY_WRITE_PERMISSION, {
    requireMfa: true,
    ...(now === undefined ? {} : { now })
  })
  if (!auth.allowed) throw new CatalogCategoryError(auth.code)
}
function receipt(raw: string): CatalogCategoryReceipt {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new Error('category_receipt_invalid')
  }
  const result = catalogCategoryReceiptSchema.safeParse(value)
  if (
    !result.success ||
    !value ||
    typeof value !== 'object' ||
    Object.keys(value).join(',') !== 'source,action,categoryId,categoryUuid,categoryVersion,slug,status,updated'
  )
    throw new Error('category_receipt_invalid')
  return result.data
}
function denseArray(value: unknown, maximum: number): unknown[] | null {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return null
  const fields = Object.getOwnPropertyDescriptors(value)
  const length: unknown = Object.getOwnPropertyDescriptor(value, 'length')?.value
  if (
    typeof length !== 'number' ||
    !Number.isSafeInteger(length) ||
    length < 0 ||
    length > maximum ||
    Reflect.ownKeys(value).length !== length + 1
  )
    return null
  const copied: unknown[] = []
  for (let index = 0; index < length; index++) {
    const field = fields[String(index)]
    if (!field || !field.enumerable || !Object.hasOwn(field, 'value')) return null
    copied.push(field.value)
  }
  return copied
}
async function replay(database: D1Database, claims: VerifiedSessionClaims, key: string, hash: string, now?: string) {
  const row = await database
    .prepare(
      `WITH actor AS (${actorSql}) SELECT c.payload_hash,c.response,
   EXISTS(SELECT 1 FROM catalog_category_audit a WHERE ${auditMatch}) AS completed
   FROM actor JOIN catalog_category_commands c ON c.actor_id=actor.id WHERE c.idempotency_key=?6`
    )
    .bind(...actorParameters(claims, now), key)
    .first<{ payload_hash: string; response: string; completed: number }>()
  await authorize(database, claims, now)
  if (!row) return null
  let plain: unknown
  try {
    plain = catalogPolicyOwnJson(row)
  } catch {
    throw new Error('category_replay_unavailable')
  }
  const source = z
    .object({
      payload_hash: z
        .string()
        .length(64)
        .regex(/^[0-9a-f]+$/),
      response: z.string().max(4096),
      completed: z.union([z.literal(0), z.literal(1)])
    })
    .strict()
    .safeParse(plain)
  if (!source.success) throw new Error('category_replay_unavailable')
  if (source.data.payload_hash !== hash) throw new CatalogCategoryError('idempotency_conflict')
  if (source.data.completed !== 1) throw new CatalogCategoryError('conflict')
  return receipt(source.data.response)
}
const sourceSchema = z
  .object({
    id: z.string().min(1).max(200),
    legacy_id: safeId.nullable(),
    parent_id: z.string().min(1).max(200).nullable(),
    name: z.string().max(10000),
    slug: z.string().min(1).max(1000),
    description: z.string().max(10000).nullable(),
    sort_order: z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
    status: catalogCategoryStatusSchema,
    seo_title: z.string().max(1000).nullable(),
    seo_description: z.string().max(10000).nullable(),
    source_id: z.string().max(200).nullable(),
    source_version: z.string().max(500).nullable(),
    created_at: z.string().max(100),
    updated_at: z.string().max(100),
    category_version: safeId
  })
  .strict()
type Source = z.infer<typeof sourceSchema>
function parseGraph(raw: unknown): Source[] {
  if (typeof raw !== 'string' || new TextEncoder().encode(raw).byteLength > 262144)
    throw new Error('category_source_invalid')
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    throw new Error('category_source_invalid')
  }
  const result = z.array(sourceSchema).max(1000).safeParse(data)
  if (!result.success) throw new Error('category_source_invalid')
  const byId = new Map(result.data.map((row) => [row.id, row])),
    ids = new Set<number>()
  for (const category of result.data) {
    if (category.legacy_id !== null) {
      if (ids.has(category.legacy_id)) throw new Error('category_source_invalid')
      ids.add(category.legacy_id)
    }
    const seen = new Set([category.id])
    let current = category,
      depth = 0
    while (current.parent_id !== null) {
      const parent = byId.get(current.parent_id)
      if (!parent || seen.has(parent.id) || ++depth > 128) throw new Error('category_source_invalid')
      seen.add(parent.id)
      current = parent
    }
  }
  return result.data
}
function publicVisible(category: Source, graph: Map<string, Source>): boolean {
  let current: Source | undefined = category,
    depth = 0
  const seen = new Set<string>()
  while (current) {
    if (seen.has(current.id) || depth++ > 128 || current.status !== 'published' || current.legacy_id === null)
      return false
    seen.add(current.id)
    if (current.parent_id === null) return true
    current = graph.get(current.parent_id)
  }
  return false
}
interface Context {
  id: number
  uuid: string
  graph: string
  before: Source | null
  parent: string | null
  slug: string
  sort: number
}
async function context(
  database: D1Database,
  claims: VerifiedSessionClaims,
  cmd: Command,
  target: { categoryId?: string },
  now?: string
): Promise<Context> {
  const row = await database.prepare(`SELECT ${graphSql} AS graph`).first<{ graph: string }>()
  await authorize(database, claims, now)
  const rawGraph: unknown =
    row && typeof row === 'object' ? Object.getOwnPropertyDescriptor(row, 'graph')?.value : undefined
  const graph = parseGraph(rawGraph),
    byId = new Map(graph.map((row) => [row.id, row]))
  const creating = cmd.action === 'create_category'
  const before = creating ? null : (graph.find((row) => row.legacy_id === Number(target.categoryId)) ?? null)
  if (!creating && !before) throw new CatalogCategoryError('not_found')
  if (before?.status === 'discontinued') throw new CatalogCategoryError('category_not_editable')
  if (before && before.category_version !== cmd.body.expectedVersion) throw new CatalogCategoryError('version_conflict')
  let parent = before?.parent_id ?? null
  if (cmd.action !== 'delete_category' && Object.hasOwn(cmd.body, 'parentId')) {
    const candidate = cmd.body.parentId === null ? null : graph.find((row) => row.legacy_id === cmd.body.parentId)
    if (cmd.body.parentId !== null && (!candidate || candidate.status === 'discontinued'))
      throw new CatalogCategoryError('reference_unavailable')
    parent = candidate?.id ?? null
  }
  if (before && parent !== before.parent_id) {
    let current = parent === null ? undefined : byId.get(parent)
    while (current) {
      if (current.id === before.id) throw new CatalogCategoryError('invalid_hierarchy')
      current = current.parent_id === null ? undefined : byId.get(current.parent_id)
    }
    const next = new Map(byId)
    next.set(before.id, { ...before, parent_id: parent })
    for (const category of graph)
      if (!publicVisible(category, byId) && publicVisible(next.get(category.id)!, next))
        throw new CatalogCategoryError('visibility_expansion')
    // Validate depth after the move, including every descendant.
    for (const category of graph) {
      let current: Source | undefined = next.get(category.id),
        depth = 0
      while (current?.parent_id !== null && current !== undefined) {
        if (++depth > 128) throw new CatalogCategoryError('invalid_hierarchy')
        current = next.get(current.parent_id)
      }
    }
  }
  if (creating && parent !== null) {
    let current: Source | undefined = byId.get(parent),
      depth = 1
    while (current?.parent_id !== null && current !== undefined) {
      if (++depth > 128) throw new CatalogCategoryError('invalid_hierarchy')
      current = byId.get(current.parent_id)
    }
  }
  if (cmd.action === 'delete_category') {
    const usage = await database
      .prepare(
        'SELECT EXISTS(SELECT 1 FROM categories WHERE parent_id=?1) AS children,EXISTS(SELECT 1 FROM products WHERE category_id=?1) AS products'
      )
      .bind(before!.id)
      .first<{ children: number; products: number }>()
    await authorize(database, claims, now)
    const children: unknown = usage && Object.getOwnPropertyDescriptor(usage, 'children')?.value,
      products: unknown = usage && Object.getOwnPropertyDescriptor(usage, 'products')?.value
    if ((children !== 0 && children !== 1) || (products !== 0 && products !== 1))
      throw new Error('category_usage_unavailable')
    if (children !== 0 || products !== 0) throw new CatalogCategoryError('category_not_empty')
  }
  let id = before?.legacy_id ?? 0
  if (creating) {
    const counter = await database
      .prepare(
        'SELECT max(last_id,COALESCE((SELECT max(legacy_id) FROM categories),999),999) AS maximum FROM catalog_category_counter WHERE id=1'
      )
      .first<{ maximum: number }>()
    const maximum: unknown = counter && Object.getOwnPropertyDescriptor(counter, 'maximum')?.value
    if (
      typeof maximum !== 'number' ||
      !Number.isSafeInteger(maximum) ||
      maximum < 999 ||
      maximum > Number.MAX_SAFE_INTEGER
    )
      throw new Error('category_counter_unavailable')
    if (maximum === Number.MAX_SAFE_INTEGER) throw new CatalogCategoryError('conflict')
    id = maximum + 1
  }
  const uuid = before?.id ?? crypto.randomUUID()
  let slug = before?.slug ?? ''
  if (cmd.action !== 'delete_category' && (!before || before.name !== cmd.body.name)) {
    const base = slugify(cmd.body.name) || 'familia'
    slug = ''
    for (const candidate of [base, `${base}-${id}`, `${base}-${uuid.slice(0, 8)}`]) {
      const occupied = await database
        .prepare(
          'SELECT EXISTS(SELECT 1 FROM categories WHERE slug=?1 AND id<>?2) OR EXISTS(SELECT 1 FROM catalog_category_aliases WHERE slug=?1 AND category_uuid<>?2) AS present'
        )
        .bind(candidate, uuid)
        .first<{ present: number }>()
      const present: unknown = occupied && Object.getOwnPropertyDescriptor(occupied, 'present')?.value
      if (present !== 0 && present !== 1) throw new Error('category_slug_lookup_unavailable')
      if (present === 0) {
        slug = candidate
        break
      }
    }
    if (!slug) throw new CatalogCategoryError('conflict')
  }
  await authorize(database, claims, now)
  const sort = creating ? Math.max(0, ...graph.map((row) => row.sort_order)) + 1 : before!.sort_order
  if (!Number.isSafeInteger(sort)) throw new CatalogCategoryError('conflict')
  if (typeof rawGraph !== 'string') throw new Error('category_source_invalid')
  return { id, uuid, graph: rawGraph, before, parent, slug, sort }
}
function plan(cmd: Command, ctx: Context) {
  const creating = cmd.action === 'create_category',
    deleting = cmd.action === 'delete_category'
  const expected = "json_extract(?9,'$.expectedVersion')"
  const overrides: Record<string, string> = {
    name: deleting ? 'category.name' : "json_extract(?9,'$.name')",
    slug: '?15',
    parent_id: '?16',
    category_version: `CAST(${expected}+1 AS INTEGER)`,
    updated_at: clock
  }
  if (deleting) overrides.status = "'discontinued'"
  if (creating)
    Object.assign(overrides, {
      id: '?8',
      legacy_id: 'CAST(?7 AS INTEGER)',
      description: 'NULL',
      sort_order: String(ctx.sort),
      status: "'draft'",
      seo_title: 'NULL',
      seo_description: 'NULL',
      source_id: 'NULL',
      source_version: "'d1-category-authoring-v1'",
      created_at: clock
    })
  const after = creating
    ? rowObject('category', overrides)
    : `(SELECT ${rowObject('category', overrides)} FROM categories category WHERE id=?8)`
  const current = `(SELECT ${rowObject('category')} FROM categories category WHERE id=?8)`
  const empty =
    'NOT EXISTS(SELECT 1 FROM categories WHERE parent_id=?8) AND NOT EXISTS(SELECT 1 FROM products WHERE category_id=?8)'
  const slugAvailable =
    'NOT EXISTS(SELECT 1 FROM categories WHERE slug=?15 AND id<>?8) AND NOT EXISTS(SELECT 1 FROM catalog_category_aliases WHERE slug=?15 AND category_uuid<>?8)'
  const pre = `${graphSql}=?14 AND ${slugAvailable} AND ${
    creating
      ? '(SELECT max(last_id,COALESCE((SELECT max(legacy_id) FROM categories),999),999)+1 FROM catalog_category_counter WHERE id=1)=?7'
      : `EXISTS(SELECT 1 FROM categories WHERE id=?8 AND legacy_id=?7 AND category_version=${expected} AND status<>'discontinued')`
  }${deleting ? ` AND ${empty}` : ''}`
  const expectedGraph = `(SELECT COALESCE(json_group_array(json(state)),'[]') FROM (SELECT state FROM (
    SELECT CASE WHEN json_extract(value,'$.id')=c.category_uuid THEN c.after_state ELSE value END AS state FROM json_each(c.before_graph)
    ${creating ? 'UNION ALL SELECT c.after_state' : ''}) ORDER BY json_extract(state,'$.id')))`
  const post = `${current}=c.after_state AND ${graphSql}=${expectedGraph}${deleting ? ` AND ${empty}` : ''}${creating ? ' AND (SELECT last_id FROM catalog_category_counter WHERE id=1)=?7' : ''}`
  const live = `${withActor},owned AS (SELECT c.* FROM actor JOIN catalog_category_commands c ON c.actor_id=actor.id WHERE ${owned})`
  const domain: string[] = []
  if (creating) {
    domain.push(
      `${live} UPDATE catalog_category_counter SET last_id=?7 WHERE id=1 AND last_id<?7 AND EXISTS(SELECT 1 FROM owned)`
    )
    domain.push(
      `${live} INSERT INTO categories(${columns.join(',')}) SELECT ${columns.map((column) => `json_extract(c.after_state,'$.${column}')`).join(',')} FROM owned c WHERE ${graphSql}=c.before_graph`
    )
  } else
    domain.push(`${live} UPDATE categories AS category SET ${['name', 'slug', 'parent_id', 'status', 'updated_at', 'category_version'].map((column) => `${column}=(SELECT json_extract(after_state,'$.${column}') FROM owned)`).join(',')}
    WHERE category.id=?8 AND category.category_version=${expected} AND EXISTS(SELECT 1 FROM owned c WHERE ${graphSql}=c.before_graph)`)
  if (cmd.action === 'update_category' && ctx.before!.slug !== ctx.slug)
    domain.push(`${live} INSERT INTO catalog_category_aliases(slug,category_uuid,created_by,reason,created_at)
    SELECT json_extract(c.before_state,'$.slug'),c.category_uuid,c.actor_id,c.reason,c.created_at FROM owned c WHERE ${post}
    AND NOT EXISTS(SELECT 1 FROM catalog_category_aliases WHERE slug=json_extract(c.before_state,'$.slug'))`)
  const aliasPost =
    cmd.action === 'update_category' && ctx.before!.slug !== ctx.slug
      ? " AND EXISTS(SELECT 1 FROM catalog_category_aliases WHERE slug=json_extract(c.before_state,'$.slug') AND category_uuid=c.category_uuid)"
      : ''
  return { after, current, pre, post: post + aliasPost, domain }
}
function constraint(error: unknown) {
  if (!(error instanceof Error)) return false
  const code: unknown = Object.getOwnPropertyDescriptor(error, 'errcode')?.value,
    message: unknown = Object.getOwnPropertyDescriptor(error, 'message')?.value
  return (
    (typeof code === 'number' && (code & 255) === 19) ||
    isD1CheckConstraintFailure(error) ||
    (typeof message === 'string' &&
      (/^(?:D1_ERROR: )?catalog_category_(?:commands_immutable|audit_immutable|audit_command|counter_immutable|alias_immutable|alias_namespace)(?:: SQLITE_CONSTRAINT(?: \(extended: SQLITE_CONSTRAINT_TRIGGER\))?)?$/.test(
        message
      ) ||
        /^(?:D1_ERROR: )?(?:UNIQUE|FOREIGN KEY|NOT NULL) constraint failed(?:: [A-Za-z0-9_., ]+)?(?:: SQLITE_CONSTRAINT(?: \(extended: SQLITE_CONSTRAINT_[A-Z_]+\))?)?$/.test(
          message
        )))
  )
}
/** Fresh administration.manage + verified email/MFA, with execution-time SQL
 * authority and one immutable owned command. No publication/status workflow. */
export async function executeD1CatalogCategoryCommand(
  database: D1Database,
  claimsInput: VerifiedSessionClaims | null,
  actionInput: CatalogCategoryAction,
  targetInput: { categoryId?: string },
  input: unknown,
  options: { idempotencyKey: string; now?: string }
): Promise<CatalogCategoryReceipt> {
  const action = checked(catalogCategoryActionSchema, actionInput)
  const cmd: Command =
    action === 'create_category'
      ? { action, body: checked(createCategoryInputSchema, input) }
      : action === 'update_category'
        ? { action, body: checked(updateCategoryInputSchema, input) }
        : { action, body: checked(deleteCategoryInputSchema, input) }
  const target = checked(z.object({ categoryId: legacy.optional() }).strict(), targetInput)
  if ((action !== 'create_category') !== Object.hasOwn(target, 'categoryId'))
    throw new CatalogCategoryError('invalid_input')
  const opts = checked(
    z
      .object({
        idempotencyKey: z
          .string()
          .min(1)
          .max(200)
          .regex(/^[A-Za-z0-9._:-]+$/)
          .refine((value) => !categoryHasControls(value)),
        now: catalogPolicyInstantSchema.optional()
      })
      .strict(),
    options
  )
  const claims = checked(catalogCategoryClaimsSchema, claimsInput, 'unauthenticated')
  await authorize(database, claims, opts.now)
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(['catalog.category.v1', action, target, cmd.body]))
  )
  const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
  const previous = await replay(database, claims, opts.idempotencyKey, hash, opts.now)
  if (previous) return previous
  for (let attempt = 0; attempt < 3; attempt++) {
    let ctx: Context
    try {
      ctx = await context(database, claims, cmd, target, opts.now)
    } catch (failure) {
      if (failure instanceof CatalogCategoryError) {
        const winner = await replay(database, claims, opts.idempotencyKey, hash, opts.now)
        if (winner) return winner
      }
      throw failure
    }
    const execution = plan(cmd, ctx)
    const parameters = [
      ...actorParameters(claims, opts.now),
      action,
      ctx.id,
      ctx.uuid,
      JSON.stringify(cmd.body),
      opts.idempotencyKey,
      hash,
      crypto.randomUUID(),
      crypto.randomUUID(),
      ctx.graph,
      ctx.slug,
      ctx.parent,
      JSON.stringify(target)
    ]
    const expected = "json_extract(?9,'$.expectedVersion')"
    const response = `json_object('source','cloudflare','action',?6,'categoryId',CAST(?7 AS INTEGER),'categoryUuid',?8,'categoryVersion',CAST(${expected}+1 AS INTEGER),'slug',?15,'status',${action === 'create_category' ? "'draft'" : action === 'delete_category' ? "'discontinued'" : '(SELECT status FROM categories WHERE id=?8)'},'updated',json('true'))`
    const statements = [
      database
        .prepare(
          `${withActor} INSERT INTO catalog_category_commands(id,claim_nonce,${auditColumns},idempotency_key,payload_hash)
      SELECT ?12,?13,actor.id,?6,?17,?9,?7,?8,CAST(${expected} AS INTEGER),CAST(${expected}+1 AS INTEGER),json_extract(?9,'$.reason'),?14,
      ${action === 'create_category' ? "'null'" : execution.current},${execution.after},${response},${clock},?10,?11 FROM actor
      WHERE ${execution.pre} AND NOT EXISTS(SELECT 1 FROM catalog_category_commands WHERE actor_id=?3 AND idempotency_key=?10)`
        )
        .bind(...parameters),
      ...execution.domain.map((sql) => database.prepare(sql).bind(...parameters)),
      database
        .prepare(
          `${withActor} INSERT INTO catalog_category_audit(id,command_id,${auditColumns}) SELECT c.id,c.id,${auditColumns
            .split(',')
            .map((column) => `c.${column}`)
            .join(',')}
      FROM actor JOIN catalog_category_commands c ON c.actor_id=actor.id WHERE ${owned} AND ${execution.post}`
        )
        .bind(...parameters),
      database
        .prepare(
          `${withActor} SELECT c.response FROM actor JOIN catalog_category_commands c ON c.actor_id=actor.id
      JOIN catalog_category_audit a ON ${auditMatch} WHERE ${owned}`
        )
        .bind(...parameters),
      database
        .prepare(
          `${withActor} INSERT INTO catalog_category_guards(id,satisfied) SELECT lower(hex(randomblob(16))),0 WHERE NOT EXISTS(
      SELECT 1 FROM actor JOIN catalog_category_commands c ON c.actor_id=actor.id JOIN catalog_category_audit a ON ${auditMatch}
      WHERE ${owned} AND ${execution.post})`
        )
        .bind(...parameters)
    ]
    try {
      const results = denseArray(await database.batch<{ response: string }>(statements), statements.length)
      if (!results || results.length !== statements.length) throw new Error('category_write_unavailable')
      const rows: unknown[][] = []
      for (let index = 0; index < results.length; index++) {
        const result: unknown = Object.getOwnPropertyDescriptor(results, String(index))?.value
        if (!result || typeof result !== 'object' || Object.getOwnPropertyDescriptor(result, 'success')?.value !== true)
          throw new Error('category_write_unavailable')
        const data = denseArray(Object.getOwnPropertyDescriptor(result, 'results')?.value, 1)
        if (!data) throw new Error('category_write_unavailable')
        rows.push(data)
      }
      const selected = rows[statements.length - 2]!
      if (selected.length !== 1) throw new Error('category_write_unavailable')
      let ownSelected: unknown
      try {
        ownSelected = catalogPolicyOwnJson(selected[0])
      } catch {
        throw new Error('category_write_unavailable')
      }
      const selectedRow = z
        .object({ response: z.string().max(4096) })
        .strict()
        .safeParse(ownSelected)
      if (!selectedRow.success) throw new Error('category_write_unavailable')
      await authorize(database, claims, opts.now)
      return receipt(selectedRow.data.response)
    } catch (failure) {
      if (!constraint(failure)) throw failure
      const winner = await replay(database, claims, opts.idempotencyKey, hash, opts.now)
      if (winner) return winner
      if (action === 'create_category' && attempt < 2) continue
      await context(database, claims, cmd, target, opts.now)
      throw new CatalogCategoryError('conflict')
    }
  }
  throw new CatalogCategoryError('conflict')
}

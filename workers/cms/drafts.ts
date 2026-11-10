import { z } from 'zod'
import {
  cmsActionSchema,
  cmsCreateInputSchema,
  cmsUpdateInputSchema,
  cmsRestoreInputSchema,
  cmsArchiveInputSchema,
  cmsDocumentSchema,
  cmsIdempotencyKeySchema,
  cmsCommandReceiptSchema,
  cmsPageListSchema,
  cmsPageDetailSchema,
  type CmsAction,
  type CmsCreateInput,
  type CmsUpdateInput,
  type CmsRestoreInput,
  type CmsArchiveInput,
  type CmsCommandReceipt,
  type CmsPage,
  type CmsVersion,
  type CmsPageList,
  type CmsPageDetail
} from '../../shared/cms-commands'
import {
  catalogPolicyOwnJson,
  catalogPolicyUuidSchema,
  catalogPolicyInstantSchema
} from '../../shared/catalog-publication-policy'
import { authorizeD1Session, type VerifiedSessionClaims } from '../catalog/authorization'
import { isD1CheckConstraintFailure } from '../runtime/d1-errors'

export const CMS_READ_PERMISSION = 'catalog.write'
export const CMS_ACTION_PERMISSIONS = {
  create_draft: 'catalog.write',
  update_draft: 'catalog.write',
  restore_draft: 'catalog.publish',
  archive_draft: 'administration.manage'
} as const
export class CmsDraftError extends Error {
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
      | 'slug_conflict'
      | 'draft_not_editable'
      | 'publication_active'
      | 'reference_unavailable'
      | 'conflict'
  ) {
    super(code)
  }
}
type Command =
  | { action: 'create_draft'; body: CmsCreateInput }
  | { action: 'update_draft'; body: CmsUpdateInput }
  | { action: 'restore_draft'; body: CmsRestoreInput }
  | { action: 'archive_draft'; body: CmsArchiveInput }
const claimsSchema = z
  .object({
    sessionId: catalogPolicyUuidSchema,
    identityId: catalogPolicyUuidSchema,
    sessionVersion: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)
  })
  .strict()
function checked<T, I>(
  schema: z.ZodType<T, I>,
  value: unknown,
  code: 'invalid_input' | 'unauthenticated' = 'invalid_input'
): T {
  let plain: unknown
  try {
    plain = catalogPolicyOwnJson(value)
  } catch {
    throw new CmsDraftError(code)
  }
  const result = schema.safeParse(plain)
  if (!result.success) throw new CmsDraftError(code)
  return result.data
}
function confirmed<T, I>(schema: z.ZodType<T, I>, value: unknown): T {
  try {
    return schema.parse(catalogPolicyOwnJson(value))
  } catch {
    throw new Error('cms_source_unconfirmed')
  }
}
const clock = "COALESCE(?1,strftime('%Y-%m-%dT%H:%M:%SZ','now'))"
const actorSql = `SELECT i.id FROM auth_sessions s JOIN identities i ON i.id=s.identity_id AND i.session_version=s.session_version
 WHERE s.id=?2 AND s.identity_id=?3 AND s.session_version=?4 AND s.revoked_at IS NULL AND s.mfa_verified=1
 AND s.created_at<=${clock} AND s.expires_at>${clock} AND i.status IN ('pending','active')
 AND i.email_verified_at IS NOT NULL AND i.email_verified_at<=${clock}
 AND EXISTS(SELECT 1 FROM identity_roles assigned JOIN role_permissions granted ON granted.role_code=assigned.role_code
 WHERE assigned.identity_id=i.id AND granted.permission_code=?5 AND assigned.granted_at<=${clock}
 AND (assigned.expires_at IS NULL OR assigned.expires_at>${clock}))`
const actorParameters = (claims: VerifiedSessionClaims, permission: string, now?: string) =>
  [now ?? null, claims.sessionId, claims.identityId, claims.sessionVersion, permission] as const
async function authorize(database: D1Database, claims: VerifiedSessionClaims, permission: string, now?: string) {
  const result = await authorizeD1Session(database, claims, permission, {
    requireMfa: true,
    ...(now === undefined ? {} : { now })
  })
  if (!result.allowed) throw new CmsDraftError(result.code)
}
const pageColumns = [
  'id',
  'slug',
  'title',
  'status',
  'page_version',
  'draft_version',
  'draft_version_id',
  'created_by',
  'created_at',
  'updated_at',
  'archived_at'
] as const
const revisionColumns = ['id', 'page_id', 'version', 'document', 'based_on_id', 'created_by', 'created_at'] as const
function object(columns: readonly string[], alias: string, overrides: Readonly<Record<string, string>> = {}) {
  return `json_object(${columns.map((column) => `'${column}',${overrides[column] ?? `${alias}.${column}`}`).join(',')})`
}
const currentPage = `(SELECT ${object(pageColumns, 'p')} FROM content_pages p WHERE p.id=?7)`
const currentDraft = `(SELECT ${object(revisionColumns, 'v')} FROM content_versions v JOIN content_pages p ON p.draft_version_id=v.id WHERE p.id=?7)`
const coherentHead = `EXISTS(SELECT 1 FROM content_pages p JOIN content_versions v ON v.id=p.draft_version_id AND v.page_id=p.id
 WHERE p.id=?7 AND p.draft_version=v.version AND p.title=json_extract(v.document,'$.title') AND p.slug=json_extract(v.document,'$.slug')
 AND p.draft_version=(SELECT count(*) FROM content_versions WHERE page_id=p.id)
 AND p.draft_version=(SELECT max(version) FROM content_versions WHERE page_id=p.id))`
const auditColumns =
  'actor_id,action,target,input,page_id,expected_version,result_version,reason,before_state,before_revision,source_revision,after_state,after_revision,response,created_at'
const auditMatch = auditColumns
  .split(',')
  .map((field) => `a.${field} IS c.${field}`)
  .concat('a.command_id=c.id')
  .join(' AND ')
const owned =
  'c.id=?8 AND c.claim_nonce=?9 AND c.actor_id=?3 AND c.action=?6 AND c.input=?10 AND c.target=?11 AND c.idempotency_key=?12 AND c.payload_hash=?13 AND c.page_id=?7'
const live = `WITH params AS (SELECT ?20 AS value),actor AS (${actorSql}),owned AS (SELECT c.* FROM actor JOIN content_draft_commands c ON c.actor_id=actor.id WHERE ${owned})`
const mediaValid = (document: string) => `NOT EXISTS(SELECT 1 FROM json_each(${document},'$.blocks') block
 WHERE json_extract(block.value,'$.type')='image' AND NOT EXISTS(SELECT 1 FROM media_uploads asset
 WHERE asset.id=json_extract(block.value,'$.assetId') AND asset.storage_status='quarantined' AND asset.content_type IN ('image/png','image/jpeg')))`
const positive = z
  .number()
  .int()
  .min(1)
  .max(Number.MAX_SAFE_INTEGER - 1)
const pageRowSchema = z
  .object({
    id: catalogPolicyUuidSchema,
    slug: z.string(),
    title: z.string(),
    status: z.enum(['draft', 'hidden']),
    page_version: positive,
    draft_version: positive,
    draft_version_id: catalogPolicyUuidSchema,
    created_by: catalogPolicyUuidSchema,
    created_at: catalogPolicyInstantSchema,
    updated_at: catalogPolicyInstantSchema,
    archived_at: catalogPolicyInstantSchema.nullable()
  })
  .strict()
const revisionRowSchema = z
  .object({
    id: catalogPolicyUuidSchema,
    page_id: catalogPolicyUuidSchema,
    version: positive,
    document: z.string().max(262144),
    based_on_id: catalogPolicyUuidSchema.nullable(),
    created_by: catalogPolicyUuidSchema,
    created_at: catalogPolicyInstantSchema
  })
  .strict()
type PageRow = z.infer<typeof pageRowSchema>
type RevisionRow = z.infer<typeof revisionRowSchema>
function source<T, I>(schema: z.ZodType<T, I>, raw: string): T {
  try {
    return schema.parse(catalogPolicyOwnJson(JSON.parse(raw)))
  } catch {
    throw new Error('cms_source_unconfirmed')
  }
}
const pageDto = (row: PageRow): CmsPage => ({
  id: row.id,
  title: row.title,
  slug: row.slug,
  status: row.status,
  pageVersion: row.page_version,
  draftVersion: row.draft_version,
  draftVersionId: row.draft_version_id,
  createdBy: row.created_by,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  archivedAt: row.archived_at
})
const revisionDto = (row: RevisionRow): CmsVersion => ({
  id: row.id,
  pageId: row.page_id,
  version: row.version,
  document: source(cmsDocumentSchema, row.document),
  basedOnId: row.based_on_id,
  createdBy: row.created_by,
  createdAt: row.created_at
})
async function context(
  database: D1Database,
  claims: VerifiedSessionClaims,
  command: Command,
  pageId: string,
  now?: string
) {
  const row = await database
    .prepare(
      `WITH actor AS (${actorSql}) SELECT ${object(pageColumns, 'p')} AS page_state,
    ${currentDraft} AS draft_state,(SELECT count(*) FROM content_versions WHERE page_id=p.id) AS version_count,
    (SELECT ${object(revisionColumns, 'v')} FROM content_versions v WHERE v.page_id=p.id AND v.id=?6) AS source_state
    FROM actor JOIN content_pages p ON p.id=?7`
    )
    .bind(
      ...actorParameters(claims, CMS_ACTION_PERMISSIONS[command.action], now),
      command.action === 'restore_draft' ? command.body.versionId : null,
      pageId
    )
    .first<{
      page_state: string
      draft_state: string
      version_count: number
      source_state: string | null
    }>()
  await authorize(database, claims, CMS_ACTION_PERMISSIONS[command.action], now)
  if (!row) throw new CmsDraftError('not_found')
  const data = confirmed(
    z
      .object({
        page_state: z.string(),
        draft_state: z.string(),
        version_count: positive,
        source_state: z.string().nullable()
      })
      .strict(),
    row
  )
  const page = source(pageRowSchema, data.page_state),
    draft = source(revisionRowSchema, data.draft_state)
  if (
    page.draft_version !== data.version_count ||
    draft.page_id !== page.id ||
    draft.id !== page.draft_version_id ||
    draft.version !== page.draft_version
  )
    throw new Error('cms_source_unconfirmed')
  const document = source(cmsDocumentSchema, draft.document)
  if (document.title !== page.title || document.slug !== page.slug) throw new Error('cms_source_unconfirmed')
  if (page.page_version !== command.body.expectedVersion) throw new CmsDraftError('version_conflict')
  if (command.action !== 'restore_draft' && page.status !== 'draft') throw new CmsDraftError('draft_not_editable')
  if (command.action === 'restore_draft' && !data.source_state) throw new CmsDraftError('not_found')
  if (command.action === 'archive_draft') {
    const active = await database
      .prepare(
        'SELECT page_id FROM content_publication_states WHERE page_id=? AND (publication_id IS NOT NULL OR schedule_id IS NOT NULL)'
      )
      .bind(pageId)
      .first()
    await authorize(database, claims, CMS_ACTION_PERMISSIONS[command.action], now)
    if (active !== null) throw new CmsDraftError('publication_active')
  }
  return { ...data, page, draft, restoring: data.source_state ? source(revisionRowSchema, data.source_state) : null }
}
function receipt(raw: string): CmsCommandReceipt {
  try {
    return cmsCommandReceiptSchema.parse(JSON.parse(raw))
  } catch {
    throw new Error('cms_receipt_unconfirmed')
  }
}
async function replay(
  database: D1Database,
  claims: VerifiedSessionClaims,
  permission: string,
  key: string,
  hash: string,
  now?: string
) {
  const row = await database
    .prepare(
      `WITH actor AS (${actorSql}) SELECT c.payload_hash,c.response,
    EXISTS(SELECT 1 FROM content_draft_audit a WHERE ${auditMatch}) AS completed
    FROM actor JOIN content_draft_commands c ON c.actor_id=actor.id WHERE c.idempotency_key=?6`
    )
    .bind(...actorParameters(claims, permission, now), key)
    .first<{ payload_hash: string; response: string; completed: number }>()
  await authorize(database, claims, permission, now)
  if (!row) return null
  const data = confirmed(
    z
      .object({
        payload_hash: z.string().regex(/^[a-f0-9]{64}$/),
        response: z.string().max(4096),
        completed: z.union([z.literal(0), z.literal(1)])
      })
      .strict(),
    row
  )
  if (data.payload_hash !== hash) throw new CmsDraftError('idempotency_conflict')
  if (data.completed !== 1) throw new CmsDraftError('conflict')
  return receipt(data.response)
}
function constraint(failure: unknown) {
  if (!(failure instanceof Error)) return false
  const code: unknown = Object.getOwnPropertyDescriptor(failure, 'errcode')?.value,
    message: unknown = Object.getOwnPropertyDescriptor(failure, 'message')?.value
  return (
    (typeof code === 'number' && (code & 255) === 19) ||
    isD1CheckConstraintFailure(failure) ||
    (typeof message === 'string' &&
      /^(?:D1_ERROR: )?(?:cms_(?:command_immutable|audit_immutable|audit_command|page_identity_immutable|page_duplicate|page_version|draft_pointer|page_immutable_history|version_immutable|version_parent|media_reference|media_in_use|slug_immutable|slug_conflict)|(?:UNIQUE|FOREIGN KEY|NOT NULL) constraint failed(?:: [A-Za-z0-9_., ]+)?)(?:: SQLITE_CONSTRAINT(?: \(extended: SQLITE_CONSTRAINT_[A-Z_]+\))?)?$/.test(
        message
      ))
  )
}
function ownRows(result: unknown, maximum: number): unknown[] {
  if (!result || typeof result !== 'object' || Object.getOwnPropertyDescriptor(result, 'success')?.value !== true)
    throw new Error('cms_result_unconfirmed')
  const raw: unknown = Object.getOwnPropertyDescriptor(result, 'results')?.value
  try {
    const copied = catalogPolicyOwnJson(raw)
    if (!Array.isArray(copied) || copied.length > maximum) throw new Error('cms_result_unconfirmed')
    return copied
  } catch {
    throw new Error('cms_result_unconfirmed')
  }
}

/** The SQL actor is reevaluated at every batch statement. Command, new immutable
 * revision, CAS pointer, slug reservation and audit commit or roll back together. */
export async function executeD1CmsDraftCommand(
  database: D1Database,
  claimsInput: VerifiedSessionClaims | null,
  actionInput: CmsAction,
  targetInput: { pageId?: string },
  input: unknown,
  options: { idempotencyKey: string; now?: string }
): Promise<CmsCommandReceipt> {
  const action = checked(cmsActionSchema, actionInput),
    command: Command =
      action === 'create_draft'
        ? { action, body: checked(cmsCreateInputSchema, input) }
        : action === 'update_draft'
          ? { action, body: checked(cmsUpdateInputSchema, input) }
          : action === 'restore_draft'
            ? { action, body: checked(cmsRestoreInputSchema, input) }
            : { action, body: checked(cmsArchiveInputSchema, input) }
  const target = checked(z.object({ pageId: catalogPolicyUuidSchema.optional() }).strict(), targetInput)
  if ((action !== 'create_draft') !== Object.hasOwn(target, 'pageId')) throw new CmsDraftError('invalid_input')
  const opts = checked(
      z.object({ idempotencyKey: cmsIdempotencyKeySchema, now: catalogPolicyInstantSchema.optional() }).strict(),
      options
    ),
    claims = checked(claimsSchema, claimsInput, 'unauthenticated'),
    permission = CMS_ACTION_PERMISSIONS[action]
  await authorize(database, claims, permission, opts.now)
  const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(JSON.stringify(['cms.draft.v1', action, target, command.body]))
    ),
    hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
  const previous = await replay(database, claims, permission, opts.idempotencyKey, hash, opts.now)
  if (previous) return previous
  const pageId = target.pageId ?? crypto.randomUUID()
  let ctx: Awaited<ReturnType<typeof context>> | null
  try {
    ctx = action === 'create_draft' ? null : await context(database, claims, command, pageId, opts.now)
  } catch (failure) {
    if (failure instanceof CmsDraftError) {
      const winner = await replay(database, claims, permission, opts.idempotencyKey, hash, opts.now)
      if (winner) return winner
    }
    throw failure
  }
  let document: z.infer<typeof cmsDocumentSchema> | null = null
  if (command.action === 'create_draft' || command.action === 'update_draft') {
    const { expectedVersion: _expectedVersion, ...fields } = command.body
    document = cmsDocumentSchema.parse(fields)
  } else if (command.action === 'restore_draft' && ctx?.restoring)
    document = cmsDocumentSchema.parse({
      ...source(cmsDocumentSchema, ctx.restoring.document),
      changeSummary: command.body.reason
    })
  const slug = document?.slug ?? ctx!.page.slug,
    title = document?.title ?? ctx!.page.title,
    revisionId = action === 'archive_draft' ? ctx!.draft.id : crypto.randomUUID()
  const available = await database
    .prepare(
      `WITH actor AS (${actorSql}) SELECT
    NOT EXISTS(SELECT 1 FROM content_pages WHERE slug=?6 AND id<>?7)
    AND NOT EXISTS(SELECT 1 FROM content_slug_claims WHERE slug=?6 AND page_id<>?7) AS available,
    ${mediaValid('?8')} AS media_valid FROM actor`
    )
    .bind(
      ...actorParameters(claims, permission, opts.now),
      slug,
      pageId,
      document ? JSON.stringify(document) : ctx!.draft.document
    )
    .first<{ available: number; media_valid: number }>()
  await authorize(database, claims, permission, opts.now)
  if (!available) throw new Error('cms_context_unconfirmed')
  const references = confirmed(
    z
      .object({ available: z.union([z.literal(0), z.literal(1)]), media_valid: z.union([z.literal(0), z.literal(1)]) })
      .strict(),
    available
  )
  if (!references.available) throw new CmsDraftError('slug_conflict')
  if (!references.media_valid) throw new CmsDraftError('reference_unavailable')
  const parameters = [
    ...actorParameters(claims, permission, opts.now),
    action,
    pageId,
    crypto.randomUUID(),
    crypto.randomUUID(),
    JSON.stringify(command.body),
    JSON.stringify(target),
    opts.idempotencyKey,
    hash,
    ctx?.page_state ?? 'null',
    ctx?.draft_state ?? 'null',
    ctx?.source_state ?? 'null',
    revisionId,
    document ? JSON.stringify(document) : 'null',
    slug,
    title
  ]
  const expected = "json_extract(?10,'$.expectedVersion')",
    nextDraft =
      action === 'create_draft' ? '1' : `json_extract(?14,'$.draft_version')+${action === 'archive_draft' ? 0 : 1}`,
    beforeField = (field: string) => `json_extract(?14,'$.${field}')`
  const afterPage = object(pageColumns, 'p', {
    id: '?7',
    slug: '?19',
    title: '?20',
    status: action === 'archive_draft' ? "'hidden'" : "'draft'",
    page_version: `${expected}+1`,
    draft_version: nextDraft,
    draft_version_id: '?17',
    created_by: action === 'create_draft' ? '?3' : beforeField('created_by'),
    created_at: action === 'create_draft' ? clock : beforeField('created_at'),
    updated_at: clock,
    archived_at: action === 'archive_draft' ? clock : 'NULL'
  })
  const afterRevision =
    action === 'archive_draft'
      ? "'null'"
      : object(revisionColumns, 'v', {
          id: '?17',
          page_id: '?7',
          version: nextDraft,
          document: '?18',
          based_on_id:
            action === 'create_draft'
              ? 'NULL'
              : action === 'restore_draft'
                ? "json_extract(?16,'$.id')"
                : "json_extract(?15,'$.id')",
          created_by: '?3',
          created_at: clock
        })
  const slugFree =
      'NOT EXISTS(SELECT 1 FROM content_pages WHERE slug=?19 AND id<>?7) AND NOT EXISTS(SELECT 1 FROM content_slug_claims WHERE slug=?19 AND page_id<>?7)',
    sourceUnchanged =
      action === 'restore_draft'
        ? ` AND (SELECT ${object(revisionColumns, 'v')} FROM content_versions v WHERE v.id=json_extract(?16,'$.id') AND v.page_id=?7)=?16`
        : '',
    pre = `${slugFree} AND ${action === 'create_draft' ? 'NOT EXISTS(SELECT 1 FROM content_pages WHERE id=?7)' : `${currentPage}=?14 AND ${currentDraft}=?15 AND ${coherentHead}`}${sourceUnchanged} AND ${mediaValid(action === 'archive_draft' ? "json_extract(?15,'$.document')" : '?18')}`,
    post = `${currentPage}=c.after_state AND ${currentDraft}=${action === 'archive_draft' ? 'c.before_revision' : 'c.after_revision'} AND ${coherentHead}
    AND EXISTS(SELECT 1 FROM content_slug_claims WHERE slug=json_extract(c.after_state,'$.slug') AND page_id=c.page_id)
    AND ${mediaValid(action === 'archive_draft' ? "json_extract(c.before_revision,'$.document')" : "json_extract(c.after_revision,'$.document')")}`
  const response = `json_object('source','cloudflare','action',?6,'pageId',?7,'pageVersion',CAST(${expected}+1 AS INTEGER),
    'versionId',?17,'draftVersion',CAST(${nextDraft} AS INTEGER),'slug',?19,'status',${action === 'archive_draft' ? "'hidden'" : "'draft'"},'updated',json('true'))`
  const statements = [
    database
      .prepare(
        `WITH actor AS (${actorSql}) INSERT INTO content_draft_commands(id,claim_nonce,${auditColumns},idempotency_key,payload_hash)
    SELECT ?8,?9,actor.id,?6,?11,?10,?7,CAST(${expected} AS INTEGER),CAST(${expected}+1 AS INTEGER),
    COALESCE(json_extract(?10,'$.changeSummary'),json_extract(?10,'$.reason')),?14,?15,?16,${afterPage},${afterRevision},${response},${clock},?12,?13
    FROM actor WHERE ${pre} AND NOT EXISTS(SELECT 1 FROM content_draft_commands WHERE actor_id=?3 AND idempotency_key=?12)`
      )
      .bind(...parameters)
  ]
  if (action === 'create_draft')
    statements.push(
      database
        .prepare(
          `${live} INSERT INTO content_pages(${pageColumns.join(',')})
    SELECT ${pageColumns.map((column) => (column === 'draft_version' ? '0' : column === 'draft_version_id' ? 'NULL' : `json_extract(c.after_state,'$.${column}')`)).join(',')}
    FROM owned c`
        )
        .bind(...parameters)
    )
  if (action !== 'archive_draft')
    statements.push(
      database
        .prepare(
          `${live} INSERT INTO content_versions(${revisionColumns.join(',')})
    SELECT ${revisionColumns.map((column) => `json_extract(c.after_revision,'$.${column}')`).join(',')}
    FROM owned c WHERE ${action === 'create_draft' ? 'EXISTS(SELECT 1 FROM content_pages WHERE id=?7 AND draft_version=0 AND page_version=1)' : `${currentPage}=c.before_state AND ${currentDraft}=c.before_revision`}`
        )
        .bind(...parameters)
    )
  statements.push(
    database
      .prepare(
        `${live} UPDATE content_pages AS p SET ${pageColumns
          .filter((column) => !['id', 'created_by', 'created_at'].includes(column))
          .map((column) => `${column}=(SELECT json_extract(after_state,'$.${column}') FROM owned)`)
          .join(',')}
    WHERE p.id=?7 AND EXISTS(SELECT 1 FROM owned c WHERE ${action === 'create_draft' ? 'p.draft_version=0 AND p.page_version=1' : `${currentPage}=c.before_state`})`
      )
      .bind(...parameters)
  )
  statements.push(
    database
      .prepare(
        `${live} INSERT INTO content_slug_claims(slug,page_id,created_by,created_at)
    SELECT json_extract(c.after_state,'$.slug'),c.page_id,c.actor_id,c.created_at FROM owned c WHERE ${currentPage}=c.after_state
    AND NOT EXISTS(SELECT 1 FROM content_slug_claims WHERE slug=json_extract(c.after_state,'$.slug'))`
      )
      .bind(...parameters)
  )
  statements.push(
    database
      .prepare(
        `${live} INSERT INTO content_draft_audit(id,command_id,${auditColumns})
    SELECT c.id,c.id,${auditColumns
      .split(',')
      .map((field) => `c.${field}`)
      .join(',')} FROM owned c WHERE ${post}`
      )
      .bind(...parameters)
  )
  statements.push(
    database
      .prepare(`${live} SELECT c.response FROM owned c JOIN content_draft_audit a ON ${auditMatch} WHERE ${post}`)
      .bind(...parameters)
  )
  statements.push(
    database
      .prepare(
        `${live} INSERT INTO content_draft_guards(id,satisfied) SELECT lower(hex(randomblob(16))),0
    WHERE NOT EXISTS(SELECT 1 FROM owned c JOIN content_draft_audit a ON ${auditMatch} WHERE ${post})`
      )
      .bind(...parameters)
  )
  try {
    const raw: unknown = await database.batch<{ response: string }>(statements)
    if (
      !Array.isArray(raw) ||
      Object.getPrototypeOf(raw) !== Array.prototype ||
      raw.length !== statements.length ||
      Reflect.ownKeys(raw).length !== raw.length + 1
    )
      throw new Error('cms_write_unconfirmed')
    const results: unknown[][] = []
    for (let index = 0; index < raw.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(raw, String(index))
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new Error('cms_write_unconfirmed')
      results.push(ownRows(descriptor.value, 1))
    }
    const result = results[statements.length - 2]!
    if (result.length !== 1) throw new Error('cms_write_unconfirmed')
    const selected = confirmed(z.object({ response: z.string().max(4096) }).strict(), result[0])
    await authorize(database, claims, permission, opts.now)
    return receipt(selected.response)
  } catch (failure) {
    if (!constraint(failure)) throw failure
    const winner = await replay(database, claims, permission, opts.idempotencyKey, hash, opts.now)
    if (winner) return winner
    if (action !== 'create_draft') await context(database, claims, command, pageId, opts.now)
    const conflict = await database
      .prepare(
        'SELECT 1 FROM content_slug_claims WHERE slug=?1 AND page_id<>?2 UNION ALL SELECT 1 FROM content_pages WHERE slug=?1 AND id<>?2 LIMIT 1'
      )
      .bind(slug, pageId)
      .first()
    await authorize(database, claims, permission, opts.now)
    if (conflict) throw new CmsDraftError('slug_conflict')
    throw new CmsDraftError('conflict')
  }
}

async function capabilities(database: D1Database, claims: VerifiedSessionClaims, now?: string) {
  const grant = (
    permission: string
  ) => `EXISTS(SELECT 1 FROM identity_roles assigned JOIN role_permissions granted ON granted.role_code=assigned.role_code
    WHERE assigned.identity_id=actor.id AND granted.permission_code='${permission}' AND assigned.granted_at<=${clock}
    AND (assigned.expires_at IS NULL OR assigned.expires_at>${clock}))`
  // One final SQL read confirms the actor and every capability at the same
  // instant. No stale role or earlier restoration/archival check is projected.
  const row = await database
    .prepare(
      `WITH actor AS (${actorSql}) SELECT ${grant('catalog.publish')} AS restoration,
    ${grant('administration.manage')} AS archival FROM actor`
    )
    .bind(...actorParameters(claims, CMS_READ_PERMISSION, now))
    .first<{ restoration: number; archival: number }>()
  if (!row) {
    await authorize(database, claims, CMS_READ_PERMISSION, now)
    throw new Error('cms_authority_unconfirmed')
  }
  const data = confirmed(
    z
      .object({ restoration: z.union([z.literal(0), z.literal(1)]), archival: z.union([z.literal(0), z.literal(1)]) })
      .strict(),
    row
  )
  return {
    contentRead: true as const,
    contentCreate: true,
    contentUpdate: true,
    contentRestore: data.restoration === 1,
    contentArchive: data.archival === 1,
    contentPublish: false as const,
    contentPreview: false as const,
    contentSchedule: false as const
  }
}
const paginationInput = z
  .object({ page: z.number().int().min(1).max(1_000_000), perPage: z.number().int().min(1).max(100) })
  .strict()
export async function listD1CmsPages(
  database: D1Database,
  claimsInput: VerifiedSessionClaims | null,
  input: { page: number; perPage: number } = { page: 1, perPage: 25 },
  options: { now?: string } = {}
): Promise<CmsPageList> {
  const claims = checked(claimsSchema, claimsInput, 'unauthenticated'),
    query = checked(paginationInput, input),
    opts = checked(z.object({ now: catalogPolicyInstantSchema.optional() }).strict(), options)
  await authorize(database, claims, CMS_READ_PERMISSION, opts.now)
  const row = await database
    .prepare(
      `WITH actor AS (${actorSql}) SELECT
    (SELECT count(*) FROM content_pages) AS total,
    (SELECT COALESCE(json_group_array(json(state)),'[]') FROM (SELECT ${object(pageColumns, 'p')} AS state FROM content_pages p
      ORDER BY p.updated_at DESC,p.id LIMIT ?6 OFFSET ?7)) AS pages FROM actor`
    )
    .bind(...actorParameters(claims, CMS_READ_PERMISSION, opts.now), query.perPage, (query.page - 1) * query.perPage)
    .first<{ total: number; pages: string }>()
  const caps = await capabilities(database, claims, opts.now)
  if (!row) throw new Error('cms_list_unconfirmed')
  const data = confirmed(z.object({ total: z.number().int().nonnegative(), pages: z.string() }).strict(), row),
    rows = source(z.array(pageRowSchema).max(100), data.pages)
  return cmsPageListSchema.parse({
    source: 'cloudflare',
    capabilities: caps,
    pages: rows.map(pageDto),
    pagination: { ...query, total: data.total, hasMore: query.page * query.perPage < data.total }
  })
}
export async function getD1CmsPage(
  database: D1Database,
  claimsInput: VerifiedSessionClaims | null,
  pageIdInput: string,
  input: { page: number; perPage: number } = { page: 1, perPage: 5 },
  options: { now?: string } = {}
): Promise<CmsPageDetail> {
  const claims = checked(claimsSchema, claimsInput, 'unauthenticated'),
    pageId = checked(catalogPolicyUuidSchema, pageIdInput),
    query = checked(paginationInput.extend({ perPage: z.number().int().min(1).max(10) }), input),
    opts = checked(z.object({ now: catalogPolicyInstantSchema.optional() }).strict(), options)
  await authorize(database, claims, CMS_READ_PERMISSION, opts.now)
  const row = await database
    .prepare(
      `WITH actor AS (${actorSql}) SELECT ${object(pageColumns, 'p')} AS page_state,${currentDraft} AS draft_state,
    (SELECT count(*) FROM content_versions WHERE page_id=p.id) AS total,
    (SELECT COALESCE(json_group_array(json(state)),'[]') FROM (SELECT ${object(revisionColumns, 'v')} AS state FROM content_versions v WHERE v.page_id=p.id
      ORDER BY v.version DESC LIMIT ?6 OFFSET ?8)) AS versions FROM actor JOIN content_pages p ON p.id=?7`
    )
    .bind(
      ...actorParameters(claims, CMS_READ_PERMISSION, opts.now),
      query.perPage,
      pageId,
      (query.page - 1) * query.perPage
    )
    .first<{ page_state: string; draft_state: string; total: number; versions: string }>()
  const caps = await capabilities(database, claims, opts.now)
  if (!row) throw new CmsDraftError('not_found')
  const data = confirmed(
    z.object({ page_state: z.string(), draft_state: z.string(), total: positive, versions: z.string() }).strict(),
    row
  )
  return cmsPageDetailSchema.parse({
    source: 'cloudflare',
    capabilities: caps,
    page: pageDto(source(pageRowSchema, data.page_state)),
    draft: revisionDto(source(revisionRowSchema, data.draft_state)),
    history: {
      versions: source(z.array(revisionRowSchema).max(10), data.versions).map(revisionDto),
      pagination: { ...query, total: data.total, hasMore: query.page * query.perPage < data.total }
    }
  })
}

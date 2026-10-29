import { z } from 'zod'
import { cmsIdempotencyKeySchema } from '../../shared/cms-commands'
import {
  cmsPublicationInputSchema,
  cmsPublicationActionSchema,
  cmsPublicationReceiptSchema,
  cmsPublicationStateSchema,
  cmsReleaseSchema,
  cmsScheduleSchema,
  type CmsPublicationReceipt
} from '../../shared/cms-publication'
import { catalogPolicyUuidSchema, catalogPolicyInstantSchema } from '../../shared/catalog-publication-policy'
import { authorizeD1Session, type VerifiedSessionClaims } from '../catalog/authorization'
import { sha256Hex } from '../catalog/inventory'
import { isD1CheckConstraintFailure } from '../runtime/d1-errors'
import {
  cmsNow,
  cmsSource,
  cmsVersion,
  cmsDocumentMedia,
  cmsLinksValidSql,
  CmsPublicationError,
  type CmsPublicationDependencies
} from './publication-gate'
import { cmsPreviewConfigured, sealCmsPreview } from './preview'
import { madridLocalDateTimeToInstant } from '../../server/utils/madrid-calendar'

const clock = "COALESCE(?1,strftime('%Y-%m-%dT%H:%M:%SZ','now'))"
/** SQL authority is checked in every guarded batch, not a cookie role snapshot. */
export const cmsActorSql = `EXISTS(SELECT 1 FROM auth_sessions s JOIN identities i ON i.id=s.identity_id AND i.session_version=s.session_version
 WHERE s.id=?2 AND i.id=?3 AND s.session_version=?4 AND s.revoked_at IS NULL AND s.mfa_verified=1
 AND s.created_at<=${clock} AND s.expires_at>${clock} AND i.status IN ('active','pending') AND i.email_verified_at<=${clock}
 AND EXISTS(SELECT 1 FROM identity_roles r JOIN role_permissions p ON p.role_code=r.role_code
 WHERE r.identity_id=i.id AND p.permission_code=?5 AND r.granted_at<=${clock} AND (r.expires_at IS NULL OR r.expires_at>${clock})))`
export async function cmsAuthorize(
  deps: CmsPublicationDependencies,
  claims: VerifiedSessionClaims,
  permission: string
) {
  const auth = await authorizeD1Session(deps.database, claims, permission, { requireMfa: true, now: cmsNow(deps) })
  if (!auth.allowed) throw new CmsPublicationError(auth.code)
}
const headSchema = z
  .object({
    revision: z
      .number()
      .int()
      .min(1)
      .max(Number.MAX_SAFE_INTEGER - 1),
    publication_id: catalogPolicyUuidSchema.nullable(),
    schedule_id: catalogPolicyUuidSchema.nullable(),
    updated_at: catalogPolicyInstantSchema
  })
  .strict()
export async function cmsHead(deps: CmsPublicationDependencies, pageId: string) {
  const raw = await deps.database
    .prepare('SELECT revision,publication_id,schedule_id,updated_at FROM content_publication_states WHERE page_id=?')
    .bind(pageId)
    .first()
  return raw === null ? null : cmsSource(headSchema, raw)
}
export async function readCmsPublicationState(
  deps: CmsPublicationDependencies,
  claims: VerifiedSessionClaims,
  pageId: string
) {
  catalogPolicyUuidSchema.parse(pageId)
  await cmsAuthorize(deps, claims, 'catalog.write')
  const raw = await deps.database
    .prepare('SELECT page_version,draft_version_id FROM content_pages WHERE id=?')
    .bind(pageId)
    .first()
  if (raw === null) throw new CmsPublicationError('not_found')
  const page = cmsSource(
      z.object({ page_version: z.number().int().min(1), draft_version_id: catalogPolicyUuidSchema }).strict(),
      raw
    ),
    head = await cmsHead(deps, pageId)
  const publication = head?.publication_id
    ? cmsSource(
        cmsReleaseSchema,
        await deps.database
          .prepare(
            'SELECT id,version_id AS versionId,slug,published_at AS publishedAt FROM content_publications WHERE id=? AND page_id=?'
          )
          .bind(head.publication_id, pageId)
          .first()
      )
    : null
  const schedule = head?.schedule_id
    ? cmsSource(
        cmsScheduleSchema,
        await deps.database
          .prepare(
            `SELECT s.id,s.version_id AS versionId,s.publish_at AS publishAt,s.unpublish_at AS unpublishAt,
 (SELECT outcome FROM content_schedule_events WHERE schedule_id=s.id AND phase='publish') AS publishOutcome,
 (SELECT outcome FROM content_schedule_events WHERE schedule_id=s.id AND phase='unpublish') AS unpublishOutcome,
 (SELECT code FROM content_schedule_events WHERE schedule_id=s.id AND outcome='blocked' ORDER BY created_at DESC LIMIT 1) AS lastError FROM content_schedules s WHERE id=? AND page_id=?`
          )
          .bind(head.schedule_id, pageId)
          .first()
      )
    : null
  const previews = await deps.database
    .prepare(
      `SELECT p.id,p.version_id AS versionId,p.device,p.expires_at AS expiresAt,
 EXISTS(SELECT 1 FROM content_preview_revocations WHERE preview_id=p.id) AS revoked FROM content_previews p WHERE page_id=? ORDER BY created_at DESC,id DESC LIMIT 20`
    )
    .bind(pageId)
    .all()
  if (previews.success !== true) throw new CmsPublicationError('read_unconfirmed')
  const rows = cmsSource(
    z.array(
      z
        .object({
          id: catalogPolicyUuidSchema,
          versionId: catalogPolicyUuidSchema,
          device: z.enum(['responsive', 'desktop', 'mobile']),
          expiresAt: catalogPolicyInstantSchema,
          revoked: z.union([z.literal(0), z.literal(1)])
        })
        .strict()
    ),
    previews.results
  )
  const authority = await authorizeD1Session(deps.database, claims, 'catalog.publish', {
    requireMfa: true,
    now: cmsNow(deps)
  })
  await cmsAuthorize(deps, claims, 'catalog.write')
  return cmsPublicationStateSchema.parse({
    source: 'cloudflare',
    pageId,
    pageVersion: page.page_version,
    draftVersionId: page.draft_version_id,
    revision: head?.revision ?? 0,
    publication,
    schedule,
    capabilities: {
      publish: deps.enabled && authority.allowed,
      withdraw: deps.enabled && authority.allowed,
      schedule: deps.enabled && authority.allowed,
      preview: deps.enabled && cmsPreviewConfigured(deps),
      revokePreview: deps.enabled
    },
    previews: rows.map((row) => ({ ...row, revoked: row.revoked === 1 }))
  })
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  return `{${Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, v]) => `${JSON.stringify(key)}:${canonical(v)}`)
    .join(',')}}`
}
async function replayPublication(
  deps: CmsPublicationDependencies,
  claims: VerifiedSessionClaims,
  permission: string,
  pageId: string,
  action: string,
  key: string,
  hash: string
): Promise<CmsPublicationReceipt | null> {
  const previous = await deps.database
    .prepare(
      `SELECT c.page_id,c.action,c.payload_hash,c.response,
 EXISTS(SELECT 1 FROM content_publication_audit a WHERE a.command_id=c.id AND a.actor_id=c.actor_id
 AND a.page_id=c.page_id AND a.action=c.action AND a.reason=c.reason AND a.before_state=c.before_state
 AND a.after_state=c.after_state AND a.response=c.response AND a.created_at=c.created_at) AS completed
 FROM content_publication_commands c WHERE c.actor_id=?3 AND c.idempotency_key=?6 AND ${cmsActorSql}`
    )
    .bind(deps.now ? cmsNow(deps) : null, claims.sessionId, claims.identityId, claims.sessionVersion, permission, key)
    .first()
  await cmsAuthorize(deps, claims, permission)
  if (previous === null) return null
  const replay = cmsSource(
    z
      .object({
        page_id: catalogPolicyUuidSchema,
        action: cmsPublicationActionSchema,
        payload_hash: z.string().regex(/^[a-f0-9]{64}$/),
        response: z.string().max(4096),
        completed: z.union([z.literal(0), z.literal(1)])
      })
      .strict(),
    previous
  )
  if (replay.completed !== 1) throw new CmsPublicationError('read_unconfirmed')
  if (replay.payload_hash !== hash) throw new CmsPublicationError('idempotency_conflict')
  let receipt: CmsPublicationReceipt
  try {
    receipt = cmsSource(cmsPublicationReceiptSchema, JSON.parse(replay.response))
  } catch {
    throw new CmsPublicationError('read_unconfirmed')
  }
  if (replay.page_id !== pageId || receipt.pageId !== pageId || replay.action !== action || receipt.action !== action)
    throw new CmsPublicationError('read_unconfirmed')
  return receipt
}
export async function executeCmsPublicationCommand(
  deps: CmsPublicationDependencies,
  claims: VerifiedSessionClaims,
  pageId: string,
  raw: unknown,
  keyValue: string
): Promise<CmsPublicationReceipt> {
  if (!deps.enabled) throw new CmsPublicationError('feature_unavailable')
  const parsed = cmsPublicationInputSchema.safeParse(raw),
    key = cmsIdempotencyKeySchema.safeParse(keyValue),
    id = catalogPolicyUuidSchema.safeParse(pageId)
  if (!parsed.success || !key.success || !id.success) throw new CmsPublicationError('invalid_input')
  const input = parsed.data,
    permission = ['preview', 'revoke_preview'].includes(input.action) ? 'catalog.write' : 'catalog.publish'
  await cmsAuthorize(deps, claims, permission)
  const hash = await sha256Hex(canonical({ pageId, input }))
  const previous = await replayPublication(deps, claims, permission, pageId, input.action, key.data, hash)
  if (previous !== null) return previous
  const pageRaw = await deps.database
    .prepare('SELECT page_version,draft_version_id,status FROM content_pages WHERE id=?')
    .bind(pageId)
    .first()
  if (pageRaw === null) throw new CmsPublicationError('not_found')
  const page = cmsSource(
      z
        .object({
          page_version: z.number().int().min(1),
          draft_version_id: catalogPolicyUuidSchema,
          status: z.enum(['draft', 'hidden'])
        })
        .strict(),
      pageRaw
    ),
    head = await cmsHead(deps, pageId)
  if (input.expectedVersion !== page.page_version || input.expectedRevision !== (head?.revision ?? 0)) {
    const winner = await replayPublication(deps, claims, permission, pageId, input.action, key.data, hash)
    if (winner !== null) return winner
    throw new CmsPublicationError('version_conflict')
  }
  if (page.status !== 'draft') throw new CmsPublicationError('draft_not_editable')
  const now = cmsNow(deps),
    commandId = crypto.randomUUID(),
    ownerId = crypto.randomUUID()
  let publicationId = head?.publication_id ?? null,
    scheduleId = head?.schedule_id ?? null,
    previewId: string | null = null,
    url: string | null = null
  const version = 'versionId' in input ? await cmsVersion(deps.database, pageId, input.versionId) : null
  if (version && version.id !== page.draft_version_id) {
    const winner = await replayPublication(deps, claims, permission, pageId, input.action, key.data, hash)
    if (winner !== null) return winner
    throw new CmsPublicationError('version_conflict')
  }
  const needsMedia = input.action !== 'schedule' || input.publishAtLocal !== null
  const media = version && needsMedia ? await cmsDocumentMedia(deps, version.document) : []
  const statements: D1PreparedStatement[] = []
  const actorParams = [
    deps.now ? cmsNow(deps) : null,
    claims.sessionId,
    claims.identityId,
    claims.sessionVersion,
    permission
  ] as const
  const before = JSON.stringify(head),
    afterRevision = (head?.revision ?? 0) + 1
  const pre = `${cmsActorSql} AND EXISTS(SELECT 1 FROM content_pages WHERE id=?6 AND page_version=?7 AND draft_version_id=?8 AND status='draft')
 AND COALESCE((SELECT revision FROM content_publication_states WHERE page_id=?6),0)=?9`
  statements.push(
    deps.database
      .prepare(`INSERT INTO content_publication_guards SELECT ?10,0 WHERE NOT(${pre})`)
      .bind(...actorParams, pageId, input.expectedVersion, page.draft_version_id, input.expectedRevision, commandId)
  )
  if (input.action === 'publish' && version) {
    publicationId = ownerId
    scheduleId = null
    statements.push(
      deps.database
        .prepare(
          'INSERT INTO content_publications(id,page_id,version_id,slug,actor_id,reason,published_at) VALUES (?,?,?,?,?,?,?)'
        )
        .bind(ownerId, pageId, version.id, version.document.slug, claims.identityId, input.reason, now)
    )
  }
  if (input.action === 'withdraw') {
    publicationId = null
    scheduleId = null
  }
  if (input.action === 'schedule' && version) {
    let publishAt: string | null, unpublishAt: string | null
    try {
      publishAt =
        input.publishAtLocal === null
          ? null
          : madridLocalDateTimeToInstant(input.publishAtLocal, input.repeatedHour)
              .toISOString()
              .replace(/\.\d{3}Z$/, 'Z')
      unpublishAt =
        input.unpublishAtLocal === null
          ? null
          : madridLocalDateTimeToInstant(input.unpublishAtLocal, input.repeatedHour)
              .toISOString()
              .replace(/\.\d{3}Z$/, 'Z')
    } catch {
      throw new CmsPublicationError('invalid_schedule')
    }
    if (
      (publishAt === null && unpublishAt === null) ||
      (publishAt !== null && publishAt <= now) ||
      (unpublishAt !== null && unpublishAt <= (publishAt ?? now)) ||
      (publishAt === null && publicationId === null)
    )
      throw new CmsPublicationError('invalid_schedule')
    scheduleId = ownerId
    statements.push(
      deps.database
        .prepare(
          'INSERT INTO content_schedules(id,page_id,version_id,actor_id,reason,approved_publication_id,publish_at,unpublish_at,created_at) VALUES (?,?,?,?,?,?,?,?,?)'
        )
        .bind(
          ownerId,
          pageId,
          version.id,
          claims.identityId,
          input.reason,
          head?.publication_id ?? null,
          publishAt,
          unpublishAt,
          now
        )
    )
  }
  if (input.action === 'cancel_schedule') {
    if (!scheduleId) throw new CmsPublicationError('not_found')
    scheduleId = null
  }
  if (
    head?.schedule_id &&
    (input.action === 'cancel_schedule' ||
      input.action === 'schedule' ||
      input.action === 'publish' ||
      input.action === 'withdraw')
  )
    statements.push(
      deps.database
        .prepare(
          "INSERT INTO content_schedule_events(id,schedule_id,phase,outcome,code,publication_id,created_at) VALUES (?,?,'cancel','cancelled',NULL,?,?)"
        )
        .bind(crypto.randomUUID(), head.schedule_id, head.publication_id, now)
    )
  if (input.action === 'preview' && version) {
    const sealed = await sealCmsPreview(deps, { id: ownerId, pageId, versionId: version.id, device: input.device })
    previewId = ownerId
    url = `/contenido/${version.document.slug}?preview=${encodeURIComponent(sealed.token)}`
    statements.push(
      deps.database
        .prepare(
          'INSERT INTO content_previews(id,page_id,version_id,actor_id,token_hash,device,segment,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?)'
        )
        .bind(
          ownerId,
          pageId,
          version.id,
          claims.identityId,
          sealed.hash,
          input.device,
          'default',
          sealed.claims.createdAt,
          sealed.claims.expiresAt
        )
    )
  }
  if (input.action === 'revoke_preview') {
    const preview = await deps.database
      .prepare('SELECT id FROM content_previews WHERE id=? AND page_id=?')
      .bind(input.previewId, pageId)
      .first()
    if (preview === null) throw new CmsPublicationError('not_found')
    cmsSource(z.object({ id: z.literal(input.previewId) }).strict(), preview)
    previewId = input.previewId
    statements.push(
      deps.database
        .prepare(
          'INSERT INTO content_preview_revocations(preview_id,actor_id,reason,created_at) VALUES (?,?,?,?) ON CONFLICT(preview_id) DO NOTHING'
        )
        .bind(input.previewId, claims.identityId, input.reason, now)
    )
  }
  for (const item of media) {
    const evidence = item.evidence
    statements.push(
      deps.database
        .prepare(
          'INSERT INTO content_media_links(id,owner_id,owner_kind,version_id,block_id,upload_id,scan_receipt_id,rights_decision_id,created_at) VALUES (?,?,?,?,?,?,?,?,?)'
        )
        .bind(
          crypto.randomUUID(),
          ownerId,
          input.action === 'schedule' ? 'schedule' : input.action === 'preview' ? 'preview' : 'publication',
          version!.id,
          item.blockId,
          evidence.upload_id,
          evidence.scan_receipt_id,
          evidence.rights_decision_id,
          now
        )
    )
  }
  if (head)
    statements.push(
      deps.database
        .prepare(
          'UPDATE content_publication_states SET revision=revision+1,publication_id=?,schedule_id=?,updated_at=? WHERE page_id=? AND revision=?'
        )
        .bind(publicationId, scheduleId, now, pageId, input.expectedRevision)
    )
  else
    statements.push(
      deps.database
        .prepare(
          'INSERT INTO content_publication_states(page_id,revision,publication_id,schedule_id,updated_at) VALUES (?,1,?,?,?)'
        )
        .bind(pageId, publicationId, scheduleId, now)
    )
  const receipt = cmsPublicationReceiptSchema.parse({
      source: 'cloudflare',
      action: input.action,
      pageId,
      revision: afterRevision,
      publicationId,
      scheduleId,
      previewId,
      url,
      expiresInSeconds: input.action === 'preview' ? 1800 : null,
      updated: true
    }),
    after = JSON.stringify({
      revision: afterRevision,
      publication_id: publicationId,
      schedule_id: scheduleId,
      updated_at: now
    })
  statements.push(
    deps.database
      .prepare(
        'INSERT INTO content_publication_commands(id,actor_id,page_id,action,idempotency_key,payload_hash,input,reason,before_state,after_state,response,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)'
      )
      .bind(
        commandId,
        claims.identityId,
        pageId,
        input.action,
        key.data,
        hash,
        canonical(input),
        input.reason,
        before,
        after,
        JSON.stringify(receipt),
        now
      )
  )
  statements.push(
    deps.database
      .prepare(
        'INSERT INTO content_publication_audit(command_id,actor_id,page_id,action,reason,before_state,after_state,response,created_at) SELECT id,actor_id,page_id,action,reason,before_state,after_state,response,created_at FROM content_publication_commands WHERE id=?'
      )
      .bind(commandId)
  )
  const post = `${cmsActorSql} AND EXISTS(SELECT 1 FROM content_pages WHERE id=?6 AND page_version=?7 AND draft_version_id=?8 AND status='draft')
 AND EXISTS(SELECT 1 FROM content_publication_states WHERE page_id=?6 AND revision=?9 AND publication_id IS ?10 AND schedule_id IS ?11)
 AND EXISTS(SELECT 1 FROM content_publication_audit WHERE command_id=?12)
 ${version && needsMedia ? `AND ${cmsLinksValidSql('?13', '?14', clock)}` : ''}`
  statements.push(
    deps.database
      .prepare(`INSERT INTO content_publication_guards SELECT ?12,0 WHERE NOT(${post})`)
      .bind(
        ...actorParams,
        pageId,
        input.expectedVersion,
        page.draft_version_id,
        afterRevision,
        publicationId,
        scheduleId,
        commandId,
        ...(version && needsMedia ? [ownerId, version.id] : [])
      )
  )
  await cmsAuthorize(deps, claims, permission)
  try {
    const results = await deps.database.batch(statements)
    if (!Array.isArray(results) || results.length !== statements.length || results.some((r) => r.success !== true))
      throw new CmsPublicationError('write_unconfirmed')
  } catch (failure) {
    await cmsAuthorize(deps, claims, permission)
    const winner = await replayPublication(deps, claims, permission, pageId, input.action, key.data, hash)
    if (winner !== null) return winner
    if (isD1CheckConstraintFailure(failure)) throw new CmsPublicationError('version_conflict')
    throw failure
  }
  await cmsAuthorize(deps, claims, permission)
  // Immutable receipt readback, not an optimistic JSON object returned after a batch.
  const saved = await deps.database
    .prepare('SELECT response FROM content_publication_commands WHERE id=? AND actor_id=? AND payload_hash=?')
    .bind(commandId, claims.identityId, hash)
    .first()
  const checked = cmsSource(z.object({ response: z.literal(JSON.stringify(receipt)) }).strict(), saved)
  await cmsAuthorize(deps, claims, permission)
  return cmsSource(cmsPublicationReceiptSchema, JSON.parse(checked.response))
}
export { CmsPublicationError }

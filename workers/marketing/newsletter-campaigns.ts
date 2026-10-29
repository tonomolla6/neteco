import { z } from 'zod'
import {
  newsletterAdminInputSchema,
  newsletterAdminSnapshotSchema,
  newsletterCampaignDocumentSchema,
  newsletterPolicyDocumentSchema,
  newsletterTopicSchema,
  type NewsletterAdminInput
} from '../../shared/newsletter-editorial'
import {
  catalogPolicyUuidSchema as uuid,
  catalogPolicyInstantSchema as instant
} from '../../shared/catalog-publication-policy'
import { madridLocalDateTimeToInstant } from '../../server/utils/madrid-calendar'
import {
  NewsletterEditorialError,
  assertEditorialEnabled,
  authorizeEditorial,
  editorialNow,
  editorialSource,
  editorialJson,
  editorialHash,
  stableJson,
  activeTopics,
  actorBinds,
  EDITORIAL_ACTOR_SQL,
  type NewsletterEditorialDependencies
} from './newsletter-editorial-core'
import { commitEditorialCommand, editorialReplay, editorialResourceId } from './newsletter-editorial-commands'
import { transportReady } from './newsletter-campaign-transport'
import { validateEditorialLinks, editorialPercent } from './newsletter-campaign-render'

const policyHeadSchema = z.object({ revision: z.number().int().min(1), policy_id: uuid.nullable() }).strict()
export async function editorialPolicyHead(deps: NewsletterEditorialDependencies) {
  const row = await deps.database
    .prepare("SELECT revision,policy_id FROM newsletter_editorial_policy_head WHERE id='global'")
    .first()
  return row === null ? null : editorialSource(policyHeadSchema, row)
}
export async function editorialPolicy(deps: NewsletterEditorialDependencies, id: string) {
  const row = await deps.database
    .prepare('SELECT document FROM newsletter_editorial_policies WHERE id=?')
    .bind(id)
    .first()
  if (row === null) throw new NewsletterEditorialError('policy_unavailable')
  return editorialJson(
    newsletterPolicyDocumentSchema,
    editorialSource(z.object({ document: z.string() }).strict(), row).document
  )
}
const campaignHeadSchema = z
  .object({
    id: uuid,
    revision: z.number().int().min(1),
    status: z.enum(['draft', 'approved', 'cancelled', 'completed']),
    draft_version_id: uuid,
    approved_version_id: uuid.nullable(),
    policy_id: uuid.nullable(),
    starts_at: instant.nullable(),
    ends_at: instant.nullable(),
    approved_at: instant.nullable(),
    cursor: uuid.nullable(),
    fanout_complete: z.union([z.literal(0), z.literal(1)])
  })
  .strict()
export async function editorialCampaignHead(deps: NewsletterEditorialDependencies, id: string) {
  const row = await deps.database
    .prepare(
      'SELECT id,revision,status,draft_version_id,approved_version_id,policy_id,starts_at,ends_at,approved_at,cursor,fanout_complete FROM newsletter_editorial_campaigns WHERE id=?'
    )
    .bind(id)
    .first()
  if (row === null) throw new NewsletterEditorialError('not_found')
  return editorialSource(campaignHeadSchema, row)
}
export async function editorialCampaignVersion(
  deps: NewsletterEditorialDependencies,
  campaignId: string,
  versionId: string
) {
  const row = await deps.database
    .prepare('SELECT document FROM newsletter_editorial_versions WHERE id=? AND campaign_id=?')
    .bind(versionId, campaignId)
    .first()
  if (row === null) throw new NewsletterEditorialError('not_found')
  return editorialJson(
    newsletterCampaignDocumentSchema,
    editorialSource(z.object({ document: z.string() }).strict(), row).document
  )
}
export async function readNewsletterEditorialAdmin(
  deps: NewsletterEditorialDependencies,
  claims: Parameters<typeof authorizeEditorial>[1],
  cursor?: string
) {
  assertEditorialEnabled(deps)
  await authorizeEditorial(deps, claims)
  if (cursor !== undefined) uuid.parse(cursor)
  const head = await editorialPolicyHead(deps),
    policy = head?.policy_id ? { id: head.policy_id, document: await editorialPolicy(deps, head.policy_id) } : null
  const topics = await deps.database
    .prepare('SELECT id,code,label,active,revision FROM newsletter_editorial_topics ORDER BY code')
    .all()
  const campaigns = await deps.database
    .prepare(
      `SELECT c.id,c.revision,c.status,c.draft_version_id AS versionId,v.document,
 c.approved_version_id AS approvedVersionId,c.policy_id AS policyId,c.starts_at AS startsAt,c.ends_at AS endsAt,c.fanout_complete AS fanoutComplete,
 (SELECT json_object('pending',sum(status='pending'),'leased',sum(status='leased'),'sending',sum(status='sending'),'accepted',sum(status='accepted'),'skipped',sum(status='skipped'),'manualReview',sum(status='manual_review'),
 'delivered',sum(feedback_status='delivered'),'bounced',sum(feedback_status='bounced'),'complained',sum(feedback_status='complained')) FROM newsletter_editorial_deliveries d WHERE d.campaign_id=c.id) AS totals
 FROM newsletter_editorial_campaigns c JOIN newsletter_editorial_versions v ON v.id=c.draft_version_id AND v.campaign_id=c.id WHERE (?1 IS NULL OR c.id>?1) ORDER BY c.id LIMIT 101`
    )
    .bind(cursor ?? null)
    .all()
  if (topics.success !== true || campaigns.success !== true) throw new NewsletterEditorialError('read_unconfirmed')
  const topicRows = editorialSource(
    z.array(
      z
        .object({
          id: uuid,
          code: z.string(),
          label: z.string(),
          active: z.union([z.literal(0), z.literal(1)]),
          revision: z.number().int().min(1)
        })
        .strict()
    ),
    topics.results
  )
  const rows = editorialSource(
    z
      .array(
        z
          .object({
            id: uuid,
            revision: z.number().int().min(1),
            status: z.string(),
            versionId: uuid,
            document: z.string(),
            approvedVersionId: uuid.nullable(),
            policyId: uuid.nullable(),
            startsAt: instant.nullable(),
            endsAt: instant.nullable(),
            fanoutComplete: z.union([z.literal(0), z.literal(1)]),
            totals: z.string()
          })
          .strict()
      )
      .max(101),
    campaigns.results
  )
  await authorizeEditorial(deps, claims)
  const counts = z
    .object({
      pending: z.number().int().min(0).nullable(),
      leased: z.number().int().min(0).nullable(),
      sending: z.number().int().min(0).nullable(),
      accepted: z.number().int().min(0).nullable(),
      skipped: z.number().int().min(0).nullable(),
      manualReview: z.number().int().min(0).nullable(),
      delivered: z.number().int().min(0).nullable(),
      bounced: z.number().int().min(0).nullable(),
      complained: z.number().int().min(0).nullable()
    })
    .strict()
  return newsletterAdminSnapshotSchema.parse({
    source: 'cloudflare',
    policyRevision: head?.revision ?? 0,
    policy,
    topics: topicRows.map((t) => newsletterTopicSchema.parse({ ...t, active: t.active === 1 })),
    campaigns: rows.slice(0, 100).map((row) => ({
      ...row,
      document: editorialJson(newsletterCampaignDocumentSchema, row.document),
      fanoutComplete: row.fanoutComplete === 1,
      totals: Object.fromEntries(Object.entries(editorialJson(counts, row.totals)).map(([k, v]) => [k, v ?? 0]))
    })),
    nextCursor: rows.length > 100 ? rows[99]!.id : null,
    capabilities: {
      manage: true,
      preview: true,
      localDispatch: deps.transport?.mode === 'local-fake' && transportReady(deps.transport, deps.publicOrigin),
      externalDelivery: deps.transport?.mode === 'cloudflare-email' && transportReady(deps.transport, deps.publicOrigin)
    }
  })
}
export async function executeNewsletterEditorialAdmin(
  deps: NewsletterEditorialDependencies,
  claims: Parameters<typeof authorizeEditorial>[1],
  targetId: string | null,
  raw: unknown,
  key: string
) {
  assertEditorialEnabled(deps)
  const parsed = newsletterAdminInputSchema.safeParse(raw)
  if (!parsed.success) throw new NewsletterEditorialError('invalid_input')
  const input = parsed.data
  const authorize = () => authorizeEditorial(deps, claims)
  await authorize()
  const create = ['create_topic', 'create_campaign', 'set_policy'].includes(input.action)
  if ((input.action === 'create_topic' || input.action === 'create_campaign') && input.expectedRevision !== 0)
    throw new NewsletterEditorialError('invalid_input')
  if (!create && targetId !== null) uuid.parse(targetId)
  const hash = await editorialHash(stableJson({ targetId, input })),
    previous = await editorialReplay(deps, 'admin', claims.identityId, key, hash, authorize)
  if (previous) return previous
  const resourceId = create ? await editorialResourceId(claims.identityId, key, input.action) : targetId
  const now = editorialNow(deps),
    statements: D1PreparedStatement[] = []
  let before: unknown = null,
    after: unknown,
    preSql = EDITORIAL_ACTOR_SQL,
    postSql = EDITORIAL_ACTOR_SQL
  let preBinds: readonly (string | number | null)[] = actorBinds(deps, claims),
    postBinds: readonly (string | number | null)[] = actorBinds(deps, claims)
  let id = resourceId
  const failCas = async () => {
    const winner = await editorialReplay(deps, 'admin', claims.identityId, key, hash, authorize)
    if (winner) return winner
    throw new NewsletterEditorialError('version_conflict')
  }
  if (input.action === 'set_policy' || input.action === 'retire_policy') {
    const head = await editorialPolicyHead(deps)
    before = head
    if ((head?.revision ?? 0) !== input.expectedRevision) return failCas()
    if (input.action === 'retire_policy') {
      if (!head?.policy_id) throw new NewsletterEditorialError('not_found')
      id = head.policy_id
    }
    if (!id) throw new NewsletterEditorialError('invalid_input')
    const policyId = input.action === 'set_policy' ? id : null
    if (input.action === 'set_policy')
      statements.push(
        deps.database
          .prepare('INSERT INTO newsletter_editorial_policies(id,document,actor_id,created_at) VALUES (?,?,?,?)')
          .bind(id, stableJson(input.policy), claims.identityId, now)
      )
    after = { revision: input.expectedRevision + 1, policy_id: policyId }
    statements.push(
      deps.database
        .prepare(
          `INSERT INTO newsletter_editorial_policy_head(id,revision,policy_id) VALUES ('global',1,?) ON CONFLICT(id) DO UPDATE SET revision=revision+1,policy_id=excluded.policy_id WHERE revision=?`
        )
        .bind(policyId, input.expectedRevision)
    )
    preSql += ` AND COALESCE((SELECT revision FROM newsletter_editorial_policy_head WHERE id='global'),0)=?5`
    preBinds = [...preBinds, input.expectedRevision]
    postSql += ` AND EXISTS(SELECT 1 FROM newsletter_editorial_policy_head WHERE id='global' AND revision=?5 AND policy_id IS ?6)`
    postBinds = [...postBinds, input.expectedRevision + 1, policyId]
  } else if (input.action === 'create_topic' || input.action === 'update_topic') {
    if (!id) throw new NewsletterEditorialError('invalid_input')
    if (input.action === 'create_topic') {
      after = { id, revision: 1, code: input.code, label: input.label, active: 1 }
      statements.push(
        deps.database
          .prepare('INSERT INTO newsletter_editorial_topics(id,code,label,active,revision) VALUES (?,?,?,1,1)')
          .bind(id, input.code, input.label)
      )
      preSql += ' AND NOT EXISTS(SELECT 1 FROM newsletter_editorial_topics WHERE id=?5 OR code=?6)'
      preBinds = [...preBinds, id, input.code]
    } else {
      const row = await deps.database
        .prepare('SELECT id,code,label,active,revision FROM newsletter_editorial_topics WHERE id=?')
        .bind(id)
        .first()
      if (row === null) throw new NewsletterEditorialError('not_found')
      before = editorialSource(
        z
          .object({
            id: uuid,
            code: z.string(),
            label: z.string(),
            active: z.number().int(),
            revision: z.number().int()
          })
          .strict(),
        row
      )
      const current = editorialSource(z.object({ revision: z.number().int() }).passthrough(), before)
      if (current.revision !== input.expectedRevision) return failCas()
      after = { id, revision: input.expectedRevision + 1, label: input.label, active: Number(input.active) }
      statements.push(
        deps.database
          .prepare(
            'UPDATE newsletter_editorial_topics SET label=?,active=?,revision=revision+1 WHERE id=? AND revision=?'
          )
          .bind(input.label, Number(input.active), id, input.expectedRevision)
      )
      preSql += ' AND EXISTS(SELECT 1 FROM newsletter_editorial_topics WHERE id=?5 AND revision=?6)'
      preBinds = [...preBinds, id, input.expectedRevision]
    }
    postSql += ' AND EXISTS(SELECT 1 FROM newsletter_editorial_topics WHERE id=?5 AND revision=?6)'
    postBinds = [...postBinds, id, input.expectedRevision + 1]
  } else {
    if (!id) throw new NewsletterEditorialError('invalid_input')
    let head: Awaited<ReturnType<typeof editorialCampaignHead>> | null = null
    if (input.action !== 'create_campaign') {
      head = await editorialCampaignHead(deps, id)
      before = head
      if (head.revision !== input.expectedRevision) return failCas()
      if (input.action === 'update_campaign' || input.action === 'approve_campaign') {
        if (head.status !== 'draft') throw new NewsletterEditorialError('not_editable')
      }
      if (input.action === 'cancel_campaign' && ['cancelled', 'completed'].includes(head.status))
        throw new NewsletterEditorialError('not_editable')
    }
    if (input.action === 'create_campaign' || input.action === 'update_campaign') {
      await activeTopics(deps, input.document.topics)
      const versionId = crypto.randomUUID()
      if (input.action === 'create_campaign')
        statements.push(
          deps.database
            .prepare(
              "INSERT INTO newsletter_editorial_campaigns(id,revision,status,draft_version_id,created_at) VALUES (?,1,'draft',NULL,?)"
            )
            .bind(id, now)
        )
      statements.push(
        deps.database
          .prepare(
            'INSERT INTO newsletter_editorial_versions(id,campaign_id,document,actor_id,created_at) VALUES (?,?,?,?,?)'
          )
          .bind(versionId, id, stableJson(input.document), claims.identityId, now)
      )
      statements.push(
        deps.database
          .prepare(`UPDATE newsletter_editorial_campaigns SET draft_version_id=?,revision=? WHERE id=? AND revision=?`)
          .bind(
            versionId,
            input.expectedRevision + 1,
            id,
            input.action === 'create_campaign' ? 1 : input.expectedRevision
          )
      )
      after = { id, revision: input.expectedRevision + 1, status: 'draft', draft_version_id: versionId }
    } else if (input.action === 'approve_campaign') {
      if (!head || head.draft_version_id !== input.versionId) throw new NewsletterEditorialError('version_conflict')
      const policyHead = await editorialPolicyHead(deps)
      if (policyHead?.policy_id !== input.policyId) throw new NewsletterEditorialError('policy_unavailable')
      const doc = await editorialCampaignVersion(deps, id, input.versionId),
        policy = await editorialPolicy(deps, input.policyId)
      await activeTopics(deps, doc.topics)
      await validateEditorialLinks(deps, doc)
      if (editorialPercent(doc) < policy.minEditorialPercent) throw new NewsletterEditorialError('editorial_ratio')
      let starts: string, ends: string
      try {
        starts = madridLocalDateTimeToInstant(input.startsAtLocal, input.repeatedHour)
          .toISOString()
          .replace(/\.\d{3}Z$/, 'Z')
        ends = madridLocalDateTimeToInstant(input.endsAtLocal, input.repeatedHour)
          .toISOString()
          .replace(/\.\d{3}Z$/, 'Z')
      } catch {
        throw new NewsletterEditorialError('invalid_window')
      }
      if (ends <= starts || ends <= editorialNow(deps)) throw new NewsletterEditorialError('invalid_window')
      after = {
        id,
        revision: input.expectedRevision + 1,
        status: 'approved',
        approved_version_id: input.versionId,
        policy_id: input.policyId,
        starts_at: starts,
        ends_at: ends
      }
      statements.push(
        deps.database
          .prepare(
            "UPDATE newsletter_editorial_campaigns SET revision=revision+1,status='approved',approved_version_id=?,policy_id=?,starts_at=?,ends_at=?,approved_at=? WHERE id=? AND revision=?"
          )
          .bind(input.versionId, input.policyId, starts, ends, now, id, input.expectedRevision)
      )
      preSql += " AND EXISTS(SELECT 1 FROM newsletter_editorial_policy_head WHERE id='global' AND policy_id=?7)"
      preBinds = [...preBinds, id, input.expectedRevision, input.policyId]
    } else {
      after = { id, revision: input.expectedRevision + 1, status: 'cancelled' }
      statements.push(
        deps.database
          .prepare(
            "UPDATE newsletter_editorial_campaigns SET revision=revision+1,status='cancelled' WHERE id=? AND revision=?"
          )
          .bind(id, input.expectedRevision)
      )
      statements.push(
        deps.database
          .prepare(
            "UPDATE newsletter_editorial_deliveries SET status='skipped',lease_token=NULL,lease_until=NULL,finished_at=?,last_error_code='campaign_cancelled' WHERE campaign_id=? AND status IN ('pending','leased')"
          )
          .bind(now, id)
      )
    }
    if (input.action === 'create_campaign') {
      preSql += ' AND NOT EXISTS(SELECT 1 FROM newsletter_editorial_campaigns WHERE id=?5)'
      preBinds = [...preBinds, id]
    } else {
      preSql += ' AND EXISTS(SELECT 1 FROM newsletter_editorial_campaigns WHERE id=?5 AND revision=?6)'
      if (input.action !== 'approve_campaign') preBinds = [...preBinds, id, input.expectedRevision]
    }
    postSql +=
      ' AND EXISTS(SELECT 1 FROM newsletter_editorial_campaigns WHERE id=?5 AND revision=?6 AND draft_version_id IS NOT NULL)'
    postBinds = [...postBinds, id, input.expectedRevision + 1]
    if (
      input.action === 'create_campaign' ||
      input.action === 'update_campaign' ||
      input.action === 'approve_campaign'
    ) {
      postSql += ` AND NOT EXISTS(SELECT 1 FROM newsletter_editorial_versions version,json_each(version.document,'$.topics') topic
 WHERE version.id=(SELECT draft_version_id FROM newsletter_editorial_campaigns WHERE id=?5)
 AND NOT EXISTS(SELECT 1 FROM newsletter_editorial_topics current WHERE current.code=topic.value AND current.active=1))`
    }
  }
  if (!id) throw new NewsletterEditorialError('invalid_input')
  return commitEditorialCommand(deps, {
    scope: 'admin',
    actor: claims.identityId,
    key,
    hash,
    action: input.action,
    resourceId: id,
    expectedRevision: input.expectedRevision,
    input,
    before,
    after,
    statements,
    preSql,
    preBinds,
    postSql,
    postBinds,
    authorize
  })
}
export type { NewsletterAdminInput }

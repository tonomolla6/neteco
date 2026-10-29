import { z } from 'zod'
import {
  catalogPolicyUuidSchema as uuid,
  catalogPolicyInstantSchema as instant
} from '../../shared/catalog-publication-policy'
import {
  cmsNow,
  cmsSource,
  cmsVersion,
  cmsDocumentMedia,
  cmsLinksValidSql,
  CmsPublicationError,
  type CmsPublicationDependencies
} from './publication-gate'
import { cmsHead } from './publication'
const scheduleRow = z
  .object({
    id: uuid,
    page_id: uuid,
    version_id: uuid,
    actor_id: uuid,
    reason: z.string(),
    approved_publication_id: uuid.nullable(),
    publish_at: instant.nullable(),
    unpublish_at: instant.nullable()
  })
  .strict()
/** Durable editorial approval, not a browser session. Explicit cancellation or
 * invalidation revokes approval. D1 CAS plus unique phase event fences concurrent
 * runners; a stale withdrawal can never hide a newer release. */
export async function runCmsSchedules(deps: CmsPublicationDependencies, options: { limit?: number } = {}) {
  const report = { applied: 0, blocked: 0, conflicts: 0, disabled: !deps.enabled }
  if (!deps.enabled) return report
  const limit = options.limit ?? 25
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('invalid_cms_schedule_limit')
  const now = cmsNow(deps),
    due = await deps.database
      .prepare(
        `SELECT s.id,s.page_id,s.version_id,s.actor_id,s.reason,s.approved_publication_id,s.publish_at,s.unpublish_at
 FROM content_schedules s JOIN content_publication_states h ON h.schedule_id=s.id
 WHERE (s.publish_at<=?1 AND NOT EXISTS(SELECT 1 FROM content_schedule_events WHERE schedule_id=s.id AND phase='publish'))
 OR (s.unpublish_at<=?1 AND NOT EXISTS(SELECT 1 FROM content_schedule_events WHERE schedule_id=s.id AND phase='unpublish'))
 ORDER BY COALESCE(s.publish_at,s.unpublish_at),s.id LIMIT ?2`
      )
      .bind(now, limit)
      .all()
  if (due.success !== true) throw new CmsPublicationError('read_unconfirmed')
  const rows = cmsSource(z.array(scheduleRow).max(limit), due.results)
  for (const schedule of rows) {
    for (const phase of ['publish', 'unpublish'] as const) {
      const at = phase === 'publish' ? schedule.publish_at : schedule.unpublish_at
      if (at === null || at > cmsNow(deps)) continue
      if (
        await deps.database
          .prepare('SELECT id FROM content_schedule_events WHERE schedule_id=? AND phase=?')
          .bind(schedule.id, phase)
          .first()
      )
        continue
      const head = await cmsHead(deps, schedule.page_id)
      if (!head || head.schedule_id !== schedule.id) continue
      let publicationId: string | null,
        blocked: string | null = null
      const statements: D1PreparedStatement[] = []
      try {
        if (phase === 'publish') {
          const version = await cmsVersion(deps.database, schedule.page_id, schedule.version_id),
            media = await cmsDocumentMedia(deps, version.document)
          publicationId = crypto.randomUUID()
          statements.push(
            deps.database
              .prepare(
                'INSERT INTO content_publications(id,page_id,version_id,slug,actor_id,reason,published_at) VALUES (?,?,?,?,?,?,?)'
              )
              .bind(
                publicationId,
                schedule.page_id,
                version.id,
                version.document.slug,
                schedule.actor_id,
                schedule.reason,
                cmsNow(deps)
              )
          )
          for (const link of media)
            statements.push(
              deps.database
                .prepare(
                  "INSERT INTO content_media_links(id,owner_id,owner_kind,version_id,block_id,upload_id,scan_receipt_id,rights_decision_id,created_at) VALUES (?,?,'publication',?,?,?,?,?,?)"
                )
                .bind(
                  crypto.randomUUID(),
                  publicationId,
                  version.id,
                  link.blockId,
                  link.evidence.upload_id,
                  link.evidence.scan_receipt_id,
                  link.evidence.rights_decision_id,
                  cmsNow(deps)
                )
            )
        } else {
          const published = await deps.database
            .prepare(
              "SELECT outcome,publication_id FROM content_schedule_events WHERE schedule_id=? AND phase='publish'"
            )
            .bind(schedule.id)
            .first()
          const previous =
            published === null
              ? null
              : cmsSource(
                  z.object({ outcome: z.enum(['applied', 'blocked']), publication_id: uuid.nullable() }).strict(),
                  published
                )
          const expected =
            schedule.publish_at === null
              ? schedule.approved_publication_id
              : previous?.outcome === 'applied'
                ? previous.publication_id
                : null
          if (expected === null || expected !== head.publication_id)
            throw new CmsPublicationError('publication_changed')
          publicationId = null
        }
      } catch (error) {
        if (!(error instanceof CmsPublicationError)) throw error
        blocked = error.code
        publicationId = head.publication_id
        statements.length = 0
      }
      const timestamp = cmsNow(deps),
        eventId = crypto.randomUUID(),
        finished = !blocked && (phase === 'unpublish' || schedule.unpublish_at === null)
      const fence = `EXISTS(SELECT 1 FROM content_publication_states WHERE page_id=?1 AND revision=?2 AND schedule_id=?3 AND publication_id IS ?4)
    AND EXISTS(SELECT 1 FROM content_pages WHERE id=?1 AND status='draft') AND NOT EXISTS(SELECT 1 FROM content_schedule_events WHERE schedule_id=?3 AND phase=?5)`
      statements.unshift(
        deps.database
          .prepare(`INSERT INTO content_publication_guards SELECT ?6,0 WHERE NOT(${fence})`)
          .bind(schedule.page_id, head.revision, schedule.id, head.publication_id, phase, eventId)
      )
      statements.push(
        deps.database
          .prepare(
            'INSERT INTO content_schedule_events(id,schedule_id,phase,outcome,code,publication_id,created_at) VALUES (?,?,?,?,?,?,?)'
          )
          .bind(eventId, schedule.id, phase, blocked ? 'blocked' : 'applied', blocked, publicationId, timestamp)
      )
      statements.push(
        deps.database
          .prepare(
            'UPDATE content_publication_states SET revision=revision+1,publication_id=?,schedule_id=?,updated_at=? WHERE page_id=? AND revision=? AND schedule_id=?'
          )
          .bind(publicationId, finished ? null : schedule.id, timestamp, schedule.page_id, head.revision, schedule.id)
      )
      if (phase === 'publish' && !blocked)
        statements.push(
          deps.database
            .prepare(
              `INSERT INTO content_publication_guards SELECT ?1,0 WHERE NOT(${cmsLinksValidSql('?2', '?3', "COALESCE(?4,strftime('%Y-%m-%dT%H:%M:%SZ','now'))")})`
            )
            .bind(eventId, publicationId, schedule.version_id, deps.now ? cmsNow(deps) : null)
        )
      try {
        const results = await deps.database.batch(statements)
        if (results.length !== statements.length || results.some((r) => r.success !== true))
          throw new CmsPublicationError('write_unconfirmed')
        if (blocked) report.blocked++
        else report.applied++
      } catch (error) {
        const current = await cmsHead(deps, schedule.page_id)
        if (current?.revision !== head.revision || current.schedule_id !== schedule.id) {
          report.conflicts++
          continue
        }
        throw error
      }
    }
  }
  return report
}

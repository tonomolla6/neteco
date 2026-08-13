import { createError } from 'h3'
import type { Sql, TransactionSql } from 'postgres'
import { applicationNow } from '../utils/application-clock'

interface ContentScheduleInput {
  pageId: string
  publishAt: Date | null
  unpublishAt: Date | null
  actorId: string
  reason: string
  correlationId: string
  now?: Date
}

export async function scheduleContentPublication(transaction: TransactionSql, input: ContentScheduleInput) {
  const now = input.now ?? applicationNow()
  if (input.publishAt && input.publishAt <= now) {
    throw createError({ statusCode: 422, statusMessage: 'La publicación programada debe estar en el futuro' })
  }
  if (input.unpublishAt && input.unpublishAt <= now) {
    throw createError({ statusCode: 422, statusMessage: 'La despublicación programada debe estar en el futuro' })
  }
  if (input.publishAt && input.unpublishAt && input.unpublishAt <= input.publishAt) {
    throw createError({ statusCode: 422, statusMessage: 'La despublicación debe ser posterior a la publicación' })
  }
  const [page] = await transaction<{ draftVersionId: string | null; status: string }[]>`
    SELECT draft_version_id AS "draftVersionId", status FROM content_pages WHERE id = ${input.pageId} FOR UPDATE
  `
  if (!page) throw createError({ statusCode: 404, statusMessage: 'Página no encontrada' })
  if (input.publishAt && !page.draftVersionId) {
    throw createError({ statusCode: 409, statusMessage: 'La página no tiene borrador publicable' })
  }
  if (!input.publishAt && input.unpublishAt && page.status !== 'published') {
    throw createError({ statusCode: 409, statusMessage: 'Solo una página publicada puede programar despublicación' })
  }
  if (input.publishAt) {
    const [media] = await transaction<{ valid: boolean }[]>`
      SELECT NOT EXISTS (
        SELECT 1 FROM content_versions version, jsonb_array_elements(version.blocks) block
        WHERE version.id = ${page.draftVersionId} AND block ->> 'type' = 'image'
          AND NOT EXISTS (
            SELECT 1 FROM media_assets asset
            WHERE asset.id = (block ->> 'assetId')::uuid
              AND asset.rights_status = 'approved' AND asset.quarantine_status = 'clean'
          )
      ) AS valid
    `
    if (!media?.valid) {
      throw createError({ statusCode: 409, statusMessage: 'La publicación contiene una imagen no aprobada' })
    }
  }
  await transaction`
    UPDATE content_pages
    SET scheduled_publish_at = ${input.publishAt},
        scheduled_publish_version_id = ${input.publishAt ? page.draftVersionId : null},
        scheduled_unpublish_at = ${input.unpublishAt}, updated_at = now()
    WHERE id = ${input.pageId}
  `
  await transaction`
    INSERT INTO audit_log (actor_type, actor_id, action, resource_type, resource_id,
      after_redacted, reason, correlation_id)
    VALUES ('staff', ${input.actorId}, 'content.publication.schedule', 'content', ${input.pageId},
      ${transaction.json({
        publishAt: input.publishAt?.toISOString() ?? null,
        unpublishAt: input.unpublishAt?.toISOString() ?? null,
        versionId: input.publishAt ? page.draftVersionId : null
      })}, ${input.reason}, ${input.correlationId})
  `
  return {
    id: input.pageId,
    publishAt: input.publishAt?.toISOString() ?? null,
    unpublishAt: input.unpublishAt?.toISOString() ?? null
  }
}

interface DuePage {
  id: string
  status: string
  publishAt: Date | null
  publishVersionId: string | null
  unpublishAt: Date | null
}

export async function runDueContentPublications(sql: Sql, now = applicationNow(), limit = 50) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)
    throw new RangeError('Publication batch limit is invalid')
  return sql.begin(async (transaction) => {
    await transaction`SELECT pg_advisory_xact_lock(hashtext('neteco:content-publication'))`
    const pages = await transaction<DuePage[]>`
      SELECT id, status, scheduled_publish_at AS "publishAt",
             scheduled_publish_version_id AS "publishVersionId",
             scheduled_unpublish_at AS "unpublishAt"
      FROM content_pages
      WHERE (scheduled_publish_at IS NOT NULL AND scheduled_publish_at <= ${now})
         OR (scheduled_unpublish_at IS NOT NULL AND scheduled_unpublish_at <= ${now})
      ORDER BY LEAST(scheduled_publish_at, scheduled_unpublish_at), id
      FOR UPDATE SKIP LOCKED LIMIT ${limit}
    `
    const actions: Array<{ pageId: string; action: 'published' | 'unpublished'; occurredAt: string }> = []
    for (const page of pages) {
      const publishDue = page.publishAt !== null && page.publishAt <= now && page.publishVersionId !== null
      const unpublishDue = page.unpublishAt !== null && page.unpublishAt <= now
      const pageActions: typeof actions = []
      if (publishDue) {
        await transaction`
          UPDATE content_pages SET status = 'published', published_version_id = ${page.publishVersionId},
            published_at = ${now}, scheduled_publish_at = NULL, scheduled_publish_version_id = NULL,
            updated_at = ${now} WHERE id = ${page.id}
        `
        pageActions.push({ pageId: page.id, action: 'published', occurredAt: now.toISOString() })
      }
      if (unpublishDue) {
        await transaction`
          UPDATE content_pages SET status = 'hidden', scheduled_publish_at = NULL,
            scheduled_publish_version_id = NULL, scheduled_unpublish_at = NULL, updated_at = ${now}
          WHERE id = ${page.id}
        `
        pageActions.push({ pageId: page.id, action: 'unpublished', occurredAt: now.toISOString() })
      }
      for (const action of pageActions) {
        await transaction`
          INSERT INTO audit_log (actor_type, action, resource_type, resource_id, after_redacted, reason, correlation_id)
          VALUES ('system', ${`content.${action.action}`}, 'content', ${page.id},
            ${transaction.json({ occurredAt: action.occurredAt })}, 'Programación editorial Europe/Madrid', gen_random_uuid())
        `
      }
      actions.push(...pageActions)
    }
    return actions
  })
}

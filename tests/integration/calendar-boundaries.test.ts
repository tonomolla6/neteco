import type { Sql } from 'postgres'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runDueContentPublications, scheduleContentPublication } from '../../server/services/content-publication'
import { deterministicTestData, type DeterministicTestData } from '../fixtures/deterministic'
import { isolatedPostgresDatabase, type IsolatedPostgresDatabase } from '../fixtures/postgres'

const baseConnection = process.env.DATABASE_URL ?? 'postgres://neteco:neteco-local@localhost:56432/neteco'
let sql: Sql
let database: IsolatedPostgresDatabase
let testData: DeterministicTestData

beforeEach(async (context) => {
  testData = deterministicTestData(`integration:calendar:${context.task.id}:${context.task.name}`)
  database = await isolatedPostgresDatabase(testData.namespace)
  process.env.DATABASE_URL = database.connection
  sql = database.sql
})

afterEach(async () => {
  try {
    await database.dispose()
  } finally {
    process.env.DATABASE_URL = baseConnection
  }
})

describe('scheduled publication calendar', () => {
  it('publishes and expires once at exact Madrid/DST instants with a frozen version', async () => {
    const actorId = testData.uuid('actor')
    const pageId = testData.uuid('page')
    const scheduledVersionId = testData.uuid('scheduled-version')
    const laterDraftId = testData.uuid('later-draft')
    const correlationId = testData.uuid('correlation')
    await sql`
      INSERT INTO identities (id, email, password_hash, email_verified_at, status)
      VALUES (${actorId}, ${testData.email('publisher')}, 'calendar-test-hash', now(), 'active')
    `
    await sql`
      INSERT INTO content_pages (id, slug, title, created_by)
      VALUES (${pageId}, ${`calendario-${testData.token('slug').slice(0, 10)}`}, 'Calendario editorial', ${actorId})
    `
    await sql`
      INSERT INTO content_versions (id, page_id, version, blocks, seo, change_summary, created_by)
      VALUES (${scheduledVersionId}, ${pageId}, 1,
        ${sql.json([{ id: testData.uuid('block-1'), type: 'paragraph', text: 'Versión programada' }])},
        ${sql.json({ title: 'Calendario', description: 'Publicación programada', noindex: false })},
        'Versión programada para la prueba', ${actorId})
    `
    await sql`UPDATE content_pages SET draft_version_id = ${scheduledVersionId} WHERE id = ${pageId}`

    const publishAt = new Date('2026-03-28T23:00:00.000Z') // 00:00 Europe/Madrid
    const unpublishAt = new Date('2026-10-25T01:30:00.000Z') // repeated 02:30, standard time
    await sql.begin((transaction) =>
      scheduleContentPublication(transaction, {
        pageId,
        publishAt,
        unpublishAt,
        actorId,
        reason: 'Calendario editorial de integración',
        correlationId,
        now: new Date('2026-03-28T22:00:00.000Z')
      })
    )

    await sql`
      INSERT INTO content_versions (id, page_id, version, blocks, seo, change_summary, based_on_id, created_by)
      VALUES (${laterDraftId}, ${pageId}, 2,
        ${sql.json([{ id: testData.uuid('block-2'), type: 'paragraph', text: 'Borrador posterior' }])},
        ${sql.json({ title: 'Posterior', description: 'No debe adelantarse', noindex: false })},
        'Borrador creado después de programar', ${scheduledVersionId}, ${actorId})
    `
    await sql`UPDATE content_pages SET draft_version_id = ${laterDraftId} WHERE id = ${pageId}`

    expect(await runDueContentPublications(sql, new Date(publishAt.getTime() - 1))).toEqual([])
    expect(await runDueContentPublications(sql, publishAt)).toEqual([
      { pageId, action: 'published', occurredAt: publishAt.toISOString() }
    ])
    expect(await runDueContentPublications(sql, publishAt)).toEqual([])
    const [published] = await sql<{ status: string; publishedVersionId: string; publishedAt: Date }[]>`
      SELECT status, published_version_id AS "publishedVersionId", published_at AS "publishedAt"
      FROM content_pages WHERE id = ${pageId}
    `
    expect(published).toEqual({ status: 'published', publishedVersionId: scheduledVersionId, publishedAt: publishAt })

    expect(await runDueContentPublications(sql, new Date(unpublishAt.getTime() - 1))).toEqual([])
    expect(await runDueContentPublications(sql, unpublishAt)).toEqual([
      { pageId, action: 'unpublished', occurredAt: unpublishAt.toISOString() }
    ])
    expect(await runDueContentPublications(sql, unpublishAt)).toEqual([])
    const [expired] = await sql<{ status: string; schedules: number; auditEvents: number }[]>`
      SELECT status,
        ((scheduled_publish_at IS NOT NULL)::int + (scheduled_unpublish_at IS NOT NULL)::int)::int AS schedules,
        (SELECT count(*) FROM audit_log log WHERE log.resource_id = ${pageId}
          AND log.action IN ('content.published', 'content.unpublished'))::int AS "auditEvents"
      FROM content_pages WHERE id = ${pageId}
    `
    expect(expired).toEqual({ status: 'hidden', schedules: 0, auditEvents: 2 })
  })

  it('rejects reversed schedules and invalid batch limits', async () => {
    await expect(
      sql.begin((transaction) =>
        scheduleContentPublication(transaction, {
          pageId: testData.uuid('missing-page'),
          publishAt: new Date('2026-10-25T01:30:00.000Z'),
          unpublishAt: new Date('2026-10-25T01:00:00.000Z'),
          actorId: testData.uuid('actor'),
          reason: 'Orden temporal inválido',
          correlationId: testData.uuid('correlation'),
          now: new Date('2026-10-24T00:00:00.000Z')
        })
      )
    ).rejects.toMatchObject({ statusCode: 422 })
    await expect(runDueContentPublications(sql, new Date('2026-08-13T12:00:00Z'), 0)).rejects.toThrow('limit')
  })

  it('preserves publish then unpublish transitions when the scheduler catches up late', async () => {
    const actorId = testData.uuid('late-actor')
    const pageId = testData.uuid('late-page')
    const versionId = testData.uuid('late-version')
    await sql`
      INSERT INTO identities (id, email, password_hash, email_verified_at, status)
      VALUES (${actorId}, ${testData.email('late-publisher')}, 'calendar-test-hash', now(), 'active')
    `
    await sql`
      INSERT INTO content_pages (id, slug, title, created_by)
      VALUES (${pageId}, ${`atrasada-${testData.token('late-slug').slice(0, 10)}`}, 'Publicación atrasada', ${actorId})
    `
    await sql`
      INSERT INTO content_versions (id, page_id, version, blocks, seo, change_summary, created_by)
      VALUES (${versionId}, ${pageId}, 1,
        ${sql.json([{ id: testData.uuid('late-block'), type: 'paragraph', text: 'Contenido atrasado' }])},
        ${sql.json({ title: 'Atrasada', description: 'Transición completa', noindex: false })},
        'Versión para catch-up', ${actorId})
    `
    await sql`
      UPDATE content_pages SET draft_version_id = ${versionId},
        scheduled_publish_at = '2026-03-28T23:00:00.000Z', scheduled_publish_version_id = ${versionId},
        scheduled_unpublish_at = '2026-10-25T01:30:00.000Z'
      WHERE id = ${pageId}
    `

    const caughtUpAt = new Date('2026-10-25T02:00:00.000Z')
    expect(await runDueContentPublications(sql, caughtUpAt)).toEqual([
      { pageId, action: 'published', occurredAt: caughtUpAt.toISOString() },
      { pageId, action: 'unpublished', occurredAt: caughtUpAt.toISOString() }
    ])
    const [result] = await sql<{ status: string; publishedVersionId: string; auditActions: string[] }[]>`
      SELECT status, published_version_id AS "publishedVersionId",
        ARRAY(SELECT action FROM audit_log WHERE resource_id = ${pageId} ORDER BY action) AS "auditActions"
      FROM content_pages WHERE id = ${pageId}
    `
    expect(result).toEqual({
      status: 'hidden',
      publishedVersionId: versionId,
      auditActions: ['content.published', 'content.unpublished']
    })
    expect(await runDueContentPublications(sql, caughtUpAt)).toEqual([])
  })
})

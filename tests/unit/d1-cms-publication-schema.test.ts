import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import { cmsPublicationFixture } from './d1-cms-publication-fixture'
import { CMS_CLAIMS, CMS_IDENTITY, cmsUtc, cmsDocument } from './d1-cms-fixture'
import { executeCmsPublicationCommand } from '../../workers/cms/publication'
import { executeD1CmsDraftCommand } from '../../workers/cms/drafts'
import { testUuid } from '../support/deterministic'
describe('CMS publication D1 schema refuses NULL-passing and foreign-version corruption', () => {
  let f: Awaited<ReturnType<typeof cmsPublicationFixture>>
  beforeEach(async () => {
    f = await cmsPublicationFixture()
  })
  afterEach(() => f.sqlite.close())
  const preview = (f: Awaited<ReturnType<typeof cmsPublicationFixture>>, fields: Record<string, unknown> = {}) => ({
    id: testUuid(),
    page_id: f.created.pageId,
    version_id: f.created.versionId,
    actor_id: CMS_IDENTITY,
    token_hash: 'a'.repeat(64),
    device: 'mobile',
    segment: 'default',
    created_at: cmsUtc(),
    expires_at: cmsUtc(1800000),
    ...fields
  })
  function insert(table: string, data: Record<string, unknown>) {
    const fields = Object.keys(data)
    f.sqlite
      .prepare(`INSERT INTO ${table}(${fields.join(',')}) VALUES (${fields.map(() => '?').join(',')})`)
      .run(...(Object.values(data) as never[]))
  }
  it.each([
    { created_at: null },
    { created_at: 'not-a-date' },
    { created_at: '2026-02-30T00:00:00Z' },
    { created_at: '2026-01-01T00:00:00.000Z' },
    { expires_at: null },
    { expires_at: 'invalid' },
    { expires_at: cmsUtc(1900000) },
    { token_hash: null },
    { token_hash: 'G'.repeat(64) },
    { token_hash: 'abc' },
    { segment: 'vip' }
  ])('rejects malformed preview %j', (fields) => {
    expect(() => insert('content_previews', preview(f, fields))).toThrow()
  })
  it('preview/schedule/release cannot attach a different page version', async () => {
    const other = await executeD1CmsDraftCommand(
      f.database,
      CMS_CLAIMS,
      'create_draft',
      {},
      { ...cmsDocument({ slug: 'other-page' }), expectedVersion: 0 },
      { idempotencyKey: 'other' }
    )
    expect(() => insert('content_previews', preview(f, { version_id: other.versionId }))).toThrow(/cms_preview_version/)
    expect(() =>
      insert('content_schedules', {
        id: testUuid(),
        page_id: f.created.pageId,
        version_id: other.versionId,
        actor_id: CMS_IDENTITY,
        reason: 'Explicit synthetic approval',
        approved_publication_id: null,
        publish_at: cmsUtc(60000),
        unpublish_at: null,
        created_at: cmsUtc()
      })
    ).toThrow(/cms_schedule_version/)
    expect(() =>
      insert('content_publications', {
        id: testUuid(),
        page_id: f.created.pageId,
        version_id: other.versionId,
        slug: 'other-page',
        actor_id: CMS_IDENTITY,
        reason: 'Explicit synthetic approval',
        published_at: cmsUtc()
      })
    ).toThrow(/cms_publication_version/)
  })
  it.each(['bad', null, '2026-02-30T00:00:00Z', '2026-01-01T00:00:00.000Z'])(
    'schedule dates cannot pass with created_at %s',
    (date) => {
      expect(() =>
        insert('content_schedules', {
          id: testUuid(),
          page_id: f.created.pageId,
          version_id: f.created.versionId,
          actor_id: CMS_IDENTITY,
          reason: 'Explicit approval',
          approved_publication_id: null,
          publish_at: cmsUtc(60000),
          unpublish_at: null,
          created_at: date
        })
      ).toThrow()
    }
  )
  it.each([
    { input: 'null' },
    { input: '[]' },
    { input: '{}' },
    { input: '{"action":"publish","reason":null,"expectedRevision":0,"expectedVersion":1}' },
    { response: '{}' },
    { response: '[]' },
    { after_state: 'null' },
    { after_state: '{}' },
    { payload_hash: 'g'.repeat(64) },
    { created_at: 'not-a-date' },
    { idempotency_key: ' ' },
    { reason: null }
  ])('immutable command rejects missing typed evidence %j', async (fields) => {
    await executeCmsPublicationCommand(
      f.deps,
      CMS_CLAIMS,
      f.created.pageId,
      {
        action: 'publish',
        expectedVersion: 1,
        expectedRevision: 0,
        versionId: f.created.versionId,
        reason: 'Explicit approval'
      },
      'seed'
    )
    const row = f.sqlite.prepare('SELECT * FROM content_publication_commands').get()!
    expect(() =>
      insert('content_publication_commands', {
        ...row,
        id: testUuid(),
        idempotency_key: testUuid(),
        ...fields
      })
    ).toThrow()
  })
  it('revocation, event and media timestamps reject invalid UTC values', async () => {
    const receipt = await executeCmsPublicationCommand(
      f.deps,
      CMS_CLAIMS,
      f.created.pageId,
      {
        action: 'preview',
        expectedRevision: 0,
        expectedVersion: 1,
        versionId: f.created.versionId,
        device: 'mobile',
        reason: 'Explicit preview'
      },
      'preview'
    )
    for (const date of [null, 'bad', '2026-02-30T00:00:00Z'])
      expect(() =>
        insert('content_preview_revocations', {
          preview_id: receipt.previewId,
          actor_id: CMS_IDENTITY,
          reason: 'Explicit revocation',
          created_at: date
        })
      ).toThrow()
    await executeCmsPublicationCommand(
      f.deps,
      CMS_CLAIMS,
      f.created.pageId,
      {
        action: 'schedule',
        expectedRevision: 1,
        expectedVersion: 1,
        versionId: f.created.versionId,
        publishAtLocal: '2030-01-01T10:00',
        unpublishAtLocal: null,
        reason: 'Explicit schedule'
      },
      'schedule'
    )
    const schedule = f.sqlite.prepare('SELECT id FROM content_schedules').get()!
    for (const date of [null, 'bad', '2026-02-30T00:00:00Z'])
      expect(() =>
        insert('content_schedule_events', {
          id: testUuid(),
          schedule_id: schedule.id,
          phase: 'publish',
          outcome: 'blocked',
          code: 'media_blocked',
          publication_id: null,
          created_at: date
        })
      ).toThrow()
  })
})

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cmsPublicationFixture } from './d1-cms-publication-fixture'
import { CMS_CLAIMS, CMS_SESSION, cmsDocument, cmsUtc } from './d1-cms-fixture'
import { executeCmsPublicationCommand, readCmsPublicationState } from '../../workers/cms/publication'
import { executeD1CmsDraftCommand } from '../../workers/cms/drafts'
import { readCmsPublicPage } from '../../workers/cms/public-http'
import { runCmsSchedules } from '../../workers/cms/schedules'
import { madridDateTimeParts } from '../../server/utils/madrid-calendar'
const local = (utc: string) => {
  const v = madridDateTimeParts(new Date(utc))
  return `${v.year}-${String(v.month).padStart(2, '0')}-${String(v.day).padStart(2, '0')}T${String(v.hour).padStart(2, '0')}:${String(v.minute).padStart(2, '0')}:${String(v.second).padStart(2, '0')}`
}
describe('CMS sealed preview and durable Madrid schedule', () => {
  let f: Awaited<ReturnType<typeof cmsPublicationFixture>>
  beforeEach(async () => {
    f = await cmsPublicationFixture()
  })
  afterEach(() => f.sqlite.close())
  const common = (f: Awaited<ReturnType<typeof cmsPublicationFixture>>) => ({
    expectedRevision: 0,
    expectedVersion: 1,
    versionId: f.created.versionId,
    reason: 'Explicit editorial synthetic approval'
  })
  it.each(['responsive', 'desktop', 'mobile'] as const)(
    'preview pins version and device %s without making anything public',
    async (device) => {
      const input = { ...common(f), action: 'preview', device }
      const receipt = await executeCmsPublicationCommand(f.deps, CMS_CLAIMS, f.created.pageId, input, 'preview')
      const token = new URL(receipt.url!, 'https://cms.neteco.invalid').searchParams.get('preview')!
      const page = await readCmsPublicPage(f.deps, 'guia-editorial', token)
      expect(page.previewDevice).toBe(device)
      expect(page.previewSegment).toBe('default')
      await expect(readCmsPublicPage(f.deps, 'guia-editorial')).rejects.toMatchObject({ code: 'not_found' })
      await executeD1CmsDraftCommand(
        f.database,
        CMS_CLAIMS,
        'update_draft',
        { pageId: f.created.pageId },
        { ...cmsDocument({ title: 'Private changed title' }), expectedVersion: 1 },
        { idempotencyKey: 'update' }
      )
      expect((await readCmsPublicPage(f.deps, 'guia-editorial', token)).title).toBe('Guía editorial')
      expect(await executeCmsPublicationCommand(f.deps, CMS_CLAIMS, f.created.pageId, input, 'preview')).toEqual(
        receipt
      )
    }
  )
  it('rejects tampering, wrong audience origin, wrong slug, expired/revoked token and default-disabled secret', async () => {
    await expect(
      executeCmsPublicationCommand(
        { ...f.deps, preview: undefined },
        CMS_CLAIMS,
        f.created.pageId,
        { ...common(f), action: 'preview', device: 'mobile' },
        'off'
      )
    ).rejects.toMatchObject({ code: 'preview_unavailable' })
    const receipt = await executeCmsPublicationCommand(
        f.deps,
        CMS_CLAIMS,
        f.created.pageId,
        { ...common(f), action: 'preview', device: 'mobile' },
        'preview'
      ),
      token = new URL(receipt.url!, 'https://cms.neteco.invalid').searchParams.get('preview')!
    await expect(readCmsPublicPage(f.deps, 'guia-editorial', token.slice(0, -1) + 'x')).rejects.toMatchObject({
      code: 'not_found'
    })
    await expect(
      readCmsPublicPage(
        { ...f.deps, preview: { ...f.deps.preview!, origin: 'https://other.invalid' } },
        'guia-editorial',
        token
      )
    ).rejects.toMatchObject({ code: 'not_found' })
    await expect(readCmsPublicPage(f.deps, 'wrong-slug', token)).rejects.toMatchObject({ code: 'not_found' })
    await expect(
      readCmsPublicPage({ ...f.deps, now: () => cmsUtc(1801000) }, 'guia-editorial', token)
    ).rejects.toMatchObject({ code: 'not_found' })
    await executeCmsPublicationCommand(
      f.deps,
      CMS_CLAIMS,
      f.created.pageId,
      {
        action: 'revoke_preview',
        expectedRevision: 1,
        expectedVersion: 1,
        previewId: receipt.previewId,
        reason: 'Revoke private bearer'
      },
      'revoke'
    )
    await expect(readCmsPublicPage(f.deps, 'guia-editorial', token)).rejects.toMatchObject({ code: 'not_found' })
    expect((await readCmsPublicationState(f.deps, CMS_CLAIMS, f.created.pageId)).previews[0]?.revoked).toBe(true)
  })
  it('non-default segments are rejected, not represented as personalized content', async () => {
    await expect(
      executeCmsPublicationCommand(
        f.deps,
        CMS_CLAIMS,
        f.created.pageId,
        { ...common(f), action: 'preview', device: 'mobile', segment: 'vip' },
        'segment'
      )
    ).rejects.toMatchObject({ code: 'invalid_input' })
  })
  it('schedule fixes approved version; revoked/expired author session does not erase approval; runner exactly once', async () => {
    const publish = cmsUtc(60000),
      unpublish = cmsUtc(120000)
    await executeCmsPublicationCommand(
      f.deps,
      CMS_CLAIMS,
      f.created.pageId,
      { ...common(f), action: 'schedule', publishAtLocal: local(publish), unpublishAtLocal: local(unpublish) },
      'schedule'
    )
    await executeD1CmsDraftCommand(
      f.database,
      CMS_CLAIMS,
      'update_draft',
      { pageId: f.created.pageId },
      { ...cmsDocument({ title: 'Changed draft not scheduled' }), expectedVersion: 1 },
      { idempotencyKey: 'edit' }
    )
    f.sqlite.prepare('UPDATE auth_sessions SET revoked_at=created_at WHERE id=?').run(CMS_SESSION)
    const deps = { ...f.deps, now: () => publish }
    expect((await runCmsSchedules(deps)).applied).toBe(1)
    expect((await runCmsSchedules(deps)).applied).toBe(0)
    expect((await readCmsPublicPage(deps, 'guia-editorial')).title).toBe('Guía editorial')
    expect((await runCmsSchedules({ ...f.deps, now: () => unpublish })).applied).toBe(1)
    await expect(readCmsPublicPage({ ...f.deps, now: () => unpublish }, 'guia-editorial')).rejects.toMatchObject({
      code: 'not_found'
    })
    expect(f.sqlite.prepare('SELECT count(*) AS n FROM content_schedule_events').get()?.n).toBe(2)
  })
  it('explicit cancellation prevents due job; manual publish invalidates prior schedule', async () => {
    const publish = cmsUtc(60000)
    await executeCmsPublicationCommand(
      f.deps,
      CMS_CLAIMS,
      f.created.pageId,
      { ...common(f), action: 'schedule', publishAtLocal: local(publish), unpublishAtLocal: null },
      'schedule'
    )
    await executeCmsPublicationCommand(
      f.deps,
      CMS_CLAIMS,
      f.created.pageId,
      { action: 'cancel_schedule', expectedRevision: 1, expectedVersion: 1, reason: 'Cancel approved schedule' },
      'cancel'
    )
    expect((await runCmsSchedules({ ...f.deps, now: () => publish })).applied).toBe(0)
    await executeCmsPublicationCommand(
      f.deps,
      CMS_CLAIMS,
      f.created.pageId,
      { ...common(f), expectedRevision: 2, action: 'schedule', publishAtLocal: local(publish), unpublishAtLocal: null },
      'schedule-again'
    )
    await executeCmsPublicationCommand(
      f.deps,
      CMS_CLAIMS,
      f.created.pageId,
      { ...common(f), expectedRevision: 3, action: 'publish' },
      'publish'
    )
    expect((await runCmsSchedules({ ...f.deps, now: () => publish })).applied).toBe(0)
  })
  it.each([
    { publishAtLocal: null, unpublishAtLocal: null },
    { publishAtLocal: '2025-01-01T10:00', unpublishAtLocal: null },
    { publishAtLocal: '2030-03-31T02:30', unpublishAtLocal: null },
    { publishAtLocal: '2030-01-01T10:00', unpublishAtLocal: '2029-01-01T10:00' },
    { publishAtLocal: null, unpublishAtLocal: '2030-01-01T10:00' }
  ])('rejects invalid local schedule %j', async (values) => {
    await expect(
      executeCmsPublicationCommand(
        f.deps,
        CMS_CLAIMS,
        f.created.pageId,
        { ...common(f), action: 'schedule', ...values },
        'bad'
      )
    ).rejects.toMatchObject({ code: 'invalid_schedule' })
    expect(f.sqlite.prepare('SELECT count(*) AS n FROM content_schedules').get()?.n).toBe(0)
  })
  it('Madrid repeated hour keeps explicit earlier/later distinction', async () => {
    const make = async (repeatedHour: 'earlier' | 'later', revision: number) =>
      executeCmsPublicationCommand(
        f.deps,
        CMS_CLAIMS,
        f.created.pageId,
        {
          ...common(f),
          expectedRevision: revision,
          action: 'schedule',
          publishAtLocal: '2030-10-27T02:30',
          unpublishAtLocal: null,
          repeatedHour
        },
        repeatedHour
      )
    await make('earlier', 0)
    await make('later', 1)
    const rows = f.sqlite.prepare('SELECT publish_at FROM content_schedules ORDER BY publish_at').all()
    expect(rows).toEqual([{ publish_at: '2030-10-27T00:30:00Z' }, { publish_at: '2030-10-27T01:30:00Z' }])
  })
})

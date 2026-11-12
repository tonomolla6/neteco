import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import { cmsImageFixture, cmsPublicationFixture } from './d1-cms-publication-fixture'
import { CMS_CLAIMS, CMS_IDENTITY, cmsUtc } from './d1-cms-fixture'
import { executeCmsPublicationCommand, readCmsPublicationState } from '../../workers/cms/publication'
import { runCmsSchedules } from '../../workers/cms/schedules'
import { madridDateTimeParts } from '../../server/utils/madrid-calendar'
import { readCmsPublicPage } from '../../workers/cms/public-http'
import { handleCmsMediaHttp } from '../../workers/cms/media-delivery'
import { testUuid } from '../support/deterministic'
describe('independent CMS media associations and owned bytes', () => {
  let f: Awaited<ReturnType<typeof cmsImageFixture>>
  beforeEach(async () => {
    f = await cmsImageFixture(await cmsPublicationFixture())
  })
  afterEach(() => f.sqlite.close())
  const publish = (f: Awaited<ReturnType<typeof cmsImageFixture>>) => ({
    action: 'publish',
    expectedRevision: 0,
    expectedVersion: 2,
    versionId: f.updated.versionId,
    reason: 'Explicit synthetic CMS image approval'
  })
  const local = (date: string) => {
    const p = madridDateTimeParts(new Date(date))
    return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}T${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}:${String(p.second).padStart(2, '0')}`
  }
  it('schedule-only withdrawal remains possible after media bytes/rights become unavailable', async () => {
    await executeCmsPublicationCommand(f.deps, CMS_CLAIMS, f.created.pageId, publish(f), 'pub')
    const at = cmsUtc(60000),
      deps = { ...f.deps, bucket: { get: async () => null } }
    await executeCmsPublicationCommand(
      deps,
      CMS_CLAIMS,
      f.created.pageId,
      { ...publish(f), action: 'schedule', expectedRevision: 1, publishAtLocal: null, unpublishAtLocal: local(at) },
      'retire'
    )
    expect((await runCmsSchedules({ ...deps, now: () => at })).applied).toBe(1)
    expect(f.sqlite.prepare('SELECT publication_id FROM content_publication_states').get()?.publication_id).toBe(null)
  })
  it('job revalidates media at execution and durable blocked approval remains visible, not silently empty', async () => {
    const at = cmsUtc(60000)
    await executeCmsPublicationCommand(
      f.deps,
      CMS_CLAIMS,
      f.created.pageId,
      { ...publish(f), action: 'schedule', publishAtLocal: local(at), unpublishAtLocal: null },
      'schedule'
    )
    const deps = { ...f.deps, bucket: { get: async () => null }, now: () => at }
    expect((await runCmsSchedules(deps)).blocked).toBe(1)
    expect((await runCmsSchedules(deps)).blocked).toBe(0)
    const state = await readCmsPublicationState(deps, CMS_CLAIMS, f.created.pageId)
    expect(state.publication).toBe(null)
    expect(state.schedule?.publishOutcome).toBe('blocked')
    expect(state.schedule?.lastError).toBe('media_blocked')
    await executeCmsPublicationCommand(
      deps,
      CMS_CLAIMS,
      f.created.pageId,
      {
        action: 'cancel_schedule',
        expectedRevision: state.revision,
        expectedVersion: 2,
        reason: 'Cancel explicitly blocked approval'
      },
      'cancel'
    )
    expect((await readCmsPublicationState(deps, CMS_CLAIMS, f.created.pageId)).schedule).toBe(null)
  })
  it('publishes independent CMS association and governed derivative, never a product grant', async () => {
    await executeCmsPublicationCommand(f.deps, CMS_CLAIMS, f.created.pageId, publish(f), 'pub')
    expect(f.sqlite.prepare('SELECT count(*) AS n FROM product_media_publications').get()?.n).toBe(0)
    const page = await readCmsPublicPage(f.deps, 'guia-editorial'),
      url = Object.values(page.media)[0]!
    const response = await handleCmsMediaHttp(new Request('https://cms.neteco.invalid' + url), f.deps)
    expect(response?.status).toBe(200)
    expect(response?.headers.get('cache-control')).toBe('private, no-store')
    expect(response?.headers.get('content-type')).toBe('image/webp')
    expect((await response?.arrayBuffer())?.byteLength).toBe(f.bytes.length)
  })
  it.each(['missing_bytes', 'wrong_bytes', 'wrong_etag', 'no_scanner', 'no_rights', 'expired_scan'])(
    'blocks publication without confirmed %s',
    async (kind) => {
      const deps = { ...f.deps }
      if (kind === 'missing_bytes') deps.bucket = { get: async () => null }
      if (kind === 'wrong_bytes')
        deps.bucket = {
          get: async () =>
            ({
              etag: 'cms-etag',
              size: f.bytes.length,
              body: new Blob([new Uint8Array(f.bytes.length)]).stream()
            }) as R2ObjectBody
        }
      if (kind === 'wrong_etag')
        deps.bucket = {
          get: async () => ({ etag: 'wrong', size: f.bytes.length, body: new Blob([f.bytes]).stream() }) as R2ObjectBody
        }
      if (kind === 'no_scanner')
        f.sqlite.exec('DROP TRIGGER media_scan_receipts_no_delete;DELETE FROM media_scan_receipts')
      if (kind === 'no_rights')
        f.sqlite.exec('DROP TRIGGER media_rights_decisions_no_delete;DELETE FROM media_rights_decisions')
      if (kind === 'expired_scan') deps.now = () => cmsUtc(3700000)
      await expect(
        executeCmsPublicationCommand(deps, CMS_CLAIMS, f.created.pageId, publish(f), 'pub')
      ).rejects.toBeDefined()
      expect(f.sqlite.prepare('SELECT count(*) AS n FROM content_publications').get()?.n).toBe(0)
    }
  )
  it('fresh infected verdict withdraws page and derivative without modifying historical release', async () => {
    await executeCmsPublicationCommand(f.deps, CMS_CLAIMS, f.created.pageId, publish(f), 'pub')
    const page = await readCmsPublicPage(f.deps, 'guia-editorial'),
      url = Object.values(page.media)[0]!
    const scan = f.sqlite.prepare('SELECT * FROM media_scan_receipts').get()!
    f.sqlite
      .prepare(
        "INSERT INTO media_scan_receipts(id,upload_id,checksum,object_key,byte_size,verdict,scanner_version,scanned_at,expires_at,received_at,payload_hash) VALUES (?,?,?,?,?,'infected',?,?,?,?,?)"
      )
      .run(
        testUuid(),
        scan.upload_id,
        scan.checksum,
        scan.object_key,
        scan.byte_size,
        'new-synthetic-verdict',
        cmsUtc(),
        cmsUtc(3600000),
        cmsUtc(),
        scan.payload_hash
      )
    await expect(readCmsPublicPage(f.deps, 'guia-editorial')).rejects.toMatchObject({ code: 'not_found' })
    expect((await handleCmsMediaHttp(new Request('https://cms.neteco.invalid' + url), f.deps))?.status).toBe(404)
  })
  it('rights rejection and explicit release withdrawal both close previously issued derivative URLs', async () => {
    await executeCmsPublicationCommand(f.deps, CMS_CLAIMS, f.created.pageId, publish(f), 'pub')
    const url = Object.values((await readCmsPublicPage(f.deps, 'guia-editorial')).media)[0]!
    const old = f.sqlite.prepare('SELECT payload_hash FROM media_rights_decisions').get()!
    f.sqlite
      .prepare(
        "INSERT INTO media_rights_decisions(id,upload_id,decision,reason,actor_id,rights_owner,rights_license,created_at,idempotency_key,payload_hash) VALUES (?,?,'rejected','Rights explicitly denied',?,'','',?,?,?)"
      )
      .run(testUuid(), f.id, CMS_IDENTITY, cmsUtc(), testUuid(), old.payload_hash)
    expect((await handleCmsMediaHttp(new Request('https://cms.neteco.invalid' + url), f.deps))?.status).toBe(404)
    await executeCmsPublicationCommand(
      f.deps,
      CMS_CLAIMS,
      f.created.pageId,
      { action: 'withdraw', expectedRevision: 1, expectedVersion: 2, reason: 'Withdraw image publication' },
      'withdraw'
    )
    expect((await handleCmsMediaHttp(new Request('https://cms.neteco.invalid' + url), f.deps))?.status).toBe(404)
  })
  it('preview image URL requires exact live bearer and is revoked independently of public releases', async () => {
    const receipt = await executeCmsPublicationCommand(
        f.deps,
        CMS_CLAIMS,
        f.created.pageId,
        { ...publish(f), action: 'preview', device: 'mobile' },
        'preview'
      ),
      token = new URL(receipt.url!, 'https://cms.neteco.invalid').searchParams.get('preview')!
    const page = await readCmsPublicPage(f.deps, 'guia-editorial', token),
      url = Object.values(page.media)[0]!
    expect((await handleCmsMediaHttp(new Request('https://cms.neteco.invalid' + url), f.deps))?.status).toBe(200)
    const noToken = new URL(url, 'https://cms.neteco.invalid')
    noToken.searchParams.delete('preview')
    expect((await handleCmsMediaHttp(new Request(noToken), f.deps))?.status).toBe(404)
    await executeCmsPublicationCommand(
      f.deps,
      CMS_CLAIMS,
      f.created.pageId,
      {
        action: 'revoke_preview',
        expectedRevision: 1,
        expectedVersion: 2,
        previewId: receipt.previewId,
        reason: 'Revoke private image'
      },
      'revoke'
    )
    expect((await handleCmsMediaHttp(new Request('https://cms.neteco.invalid' + url), f.deps))?.status).toBe(404)
  })
})

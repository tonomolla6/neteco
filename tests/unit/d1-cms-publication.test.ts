import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cmsPublicationFixture } from './d1-cms-publication-fixture'
import { CMS_CLAIMS, CMS_SESSION, cmsDocument } from './d1-cms-fixture'
import { executeCmsPublicationCommand, readCmsPublicationState } from '../../workers/cms/publication'
import { executeD1CmsDraftCommand } from '../../workers/cms/drafts'
import { readCmsPublicPage, handleCmsPublicHttp } from '../../workers/cms/public-http'
import { testUuid } from '../support/deterministic'
describe('CMS publication immutable snapshots and actor commands', () => {
  let f: Awaited<ReturnType<typeof cmsPublicationFixture>>
  beforeEach(async () => {
    f = await cmsPublicationFixture()
  })
  afterEach(() => f.sqlite.close())
  const input = (f: Awaited<ReturnType<typeof cmsPublicationFixture>>) => ({
    action: 'publish',
    expectedRevision: 0,
    expectedVersion: 1,
    versionId: f.created.versionId,
    reason: 'Editorial approval synthetic'
  })
  it('publishes whole immutable document; editing title/slug never changes live projection', async () => {
    const receipt = await executeCmsPublicationCommand(f.deps, CMS_CLAIMS, f.created.pageId, input(f), 'publish-first')
    expect(receipt.revision).toBe(1)
    expect((await readCmsPublicPage(f.deps, 'guia-editorial')).title).toBe('Guía editorial')
    await executeD1CmsDraftCommand(
      f.database,
      CMS_CLAIMS,
      'update_draft',
      { pageId: f.created.pageId },
      { ...cmsDocument({ title: 'Private title', slug: 'private-slug' }), expectedVersion: 1 },
      { idempotencyKey: 'draft-edit' }
    )
    expect((await readCmsPublicPage(f.deps, 'guia-editorial')).title).toBe('Guía editorial')
    await expect(readCmsPublicPage(f.deps, 'private-slug')).rejects.toMatchObject({ code: 'not_found' })
    expect(await executeCmsPublicationCommand(f.deps, CMS_CLAIMS, f.created.pageId, input(f), 'publish-first')).toEqual(
      receipt
    )
    expect(f.sqlite.prepare('SELECT count(*) AS n FROM content_publications').get()?.n).toBe(1)
  })
  it('rejects changed key payload, stale head, stale draft, wrong page or historical version', async () => {
    await executeCmsPublicationCommand(f.deps, CMS_CLAIMS, f.created.pageId, input(f), 'same')
    await expect(
      executeCmsPublicationCommand(
        f.deps,
        CMS_CLAIMS,
        f.created.pageId,
        { ...input(f), reason: 'Changed reason' },
        'same'
      )
    ).rejects.toMatchObject({ code: 'idempotency_conflict' })
    await expect(
      executeCmsPublicationCommand(f.deps, CMS_CLAIMS, f.created.pageId, input(f), 'new')
    ).rejects.toMatchObject({ code: 'version_conflict' })
    await expect(
      executeCmsPublicationCommand(
        f.deps,
        CMS_CLAIMS,
        f.created.pageId,
        { ...input(f), expectedRevision: 1, versionId: testUuid() },
        'wrong'
      )
    ).rejects.toMatchObject({ code: 'not_found' })
    expect(f.sqlite.prepare('SELECT count(*) AS n FROM content_publication_audit').get()?.n).toBe(1)
  })
  it('requires explicit withdraw/cancel before recoverable draft archive', async () => {
    await executeCmsPublicationCommand(f.deps, CMS_CLAIMS, f.created.pageId, input(f), 'pub')
    await expect(
      executeD1CmsDraftCommand(
        f.database,
        CMS_CLAIMS,
        'archive_draft',
        { pageId: f.created.pageId },
        { expectedVersion: 1, reason: 'Archive context' },
        { idempotencyKey: 'archive' }
      )
    ).rejects.toMatchObject({ code: 'publication_active' })
    await executeCmsPublicationCommand(
      f.deps,
      CMS_CLAIMS,
      f.created.pageId,
      { action: 'withdraw', expectedRevision: 1, expectedVersion: 1, reason: 'Withdraw explicitly' },
      'withdraw'
    )
    await expect(readCmsPublicPage(f.deps, 'guia-editorial')).rejects.toMatchObject({ code: 'not_found' })
    await executeD1CmsDraftCommand(
      f.database,
      CMS_CLAIMS,
      'archive_draft',
      { pageId: f.created.pageId },
      { expectedVersion: 1, reason: 'Archive context' },
      { idempotencyKey: 'archive' }
    )
    expect(f.sqlite.prepare('SELECT count(*) AS n FROM content_versions').get()?.n).toBe(1)
  })
  it.each(['revoke', 'mfa', 'permission'])('historical replay requires current %s authority', async (kind) => {
    await executeCmsPublicationCommand(f.deps, CMS_CLAIMS, f.created.pageId, input(f), 'pub')
    if (kind === 'revoke')
      f.sqlite.prepare('UPDATE auth_sessions SET revoked_at=created_at WHERE id=?').run(CMS_SESSION)
    if (kind === 'mfa') f.sqlite.prepare('UPDATE auth_sessions SET mfa_verified=0 WHERE id=?').run(CMS_SESSION)
    if (kind === 'permission') f.sqlite.exec("DELETE FROM role_permissions WHERE permission_code='catalog.publish'")
    await expect(
      executeCmsPublicationCommand(f.deps, CMS_CLAIMS, f.created.pageId, input(f), 'pub')
    ).rejects.toMatchObject({
      code: kind === 'revoke' ? 'unauthenticated' : kind === 'mfa' ? 'mfa_required' : 'forbidden'
    })
  })
  it('read capabilities are actor/configuration dependent and strict inputs reject extra own data', async () => {
    expect(
      (await readCmsPublicationState({ ...f.deps, preview: undefined }, CMS_CLAIMS, f.created.pageId)).capabilities
        .preview
    ).toBe(false)
    f.sqlite.exec("DELETE FROM role_permissions WHERE permission_code='catalog.publish'")
    expect((await readCmsPublicationState(f.deps, CMS_CLAIMS, f.created.pageId)).capabilities.publish).toBe(false)
    await expect(
      executeCmsPublicationCommand(f.deps, CMS_CLAIMS, f.created.pageId, { ...input(f), unexpected: true }, 'bad')
    ).rejects.toMatchObject({ code: 'invalid_input' })
  })
  it('release/audit/media associations remain append-only and guards leave no rows', async () => {
    await executeCmsPublicationCommand(f.deps, CMS_CLAIMS, f.created.pageId, input(f), 'pub')
    for (const table of ['content_publications', 'content_publication_commands', 'content_publication_audit']) {
      expect(() => f.sqlite.exec(`DELETE FROM ${table}`)).toThrow()
      expect(() =>
        f.sqlite.exec(`UPDATE ${table} SET ${table === 'content_publications' ? 'reason' : 'action'}='changed'`)
      ).toThrow()
    }
    expect(f.sqlite.prepare('SELECT count(*) AS n FROM content_publication_guards').get()?.n).toBe(0)
  })
  it('public HTTP claims aliases, rejects unsupported query/method and never leaks a draft', async () => {
    for (const path of ['/api/content/guia-editorial', '/api/content/%67uia-editorial'])
      expect((await handleCmsPublicHttp(new Request('https://cms.neteco.invalid' + path), f.deps))?.status).toBe(404)
    expect(
      (
        await handleCmsPublicHttp(
          new Request('https://cms.neteco.invalid/api/content/guia-editorial?preview=x&preview=y'),
          f.deps
        )
      )?.status
    ).toBe(400)
    expect(
      (
        await handleCmsPublicHttp(
          new Request('https://cms.neteco.invalid/api/content/guia-editorial', { method: 'POST' }),
          f.deps
        )
      )?.status
    ).toBe(405)
  })
})

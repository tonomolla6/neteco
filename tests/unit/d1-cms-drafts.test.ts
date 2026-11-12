import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { executeD1CmsDraftCommand, getD1CmsPage, listD1CmsPages } from '../../workers/cms/drafts'
import {
  cmsCreateInputSchema,
  cmsCommandReceiptSchema,
  cmsPageDetailSchema,
  cmsPageListSchema,
  type CmsAction
} from '../../shared/cms-commands'
import { cmsFixture, cmsDocument, CMS_CLAIMS, CMS_SESSION, CMS_IDENTITY, CMS_BLOCK, cmsUtc } from './d1-cms-fixture'
import { testUuid } from '../support/deterministic'

describe('D1 CMS draft port commits versions, CAS and audit without publication', () => {
  let sqlite: DatabaseSync, database: D1Database
  beforeEach(async () => {
    ;({ sqlite, database } = await cmsFixture())
  })
  afterEach(() => {
    sqlite.close()
    vi.restoreAllMocks()
  })
  function execute(
    action: CmsAction,
    target: { pageId?: string },
    input: unknown,
    options: { key?: string; db?: D1Database; claims?: typeof CMS_CLAIMS | null } = {}
  ) {
    return executeD1CmsDraftCommand(
      options.db ?? database,
      options.claims === undefined ? CMS_CLAIMS : options.claims,
      action,
      target,
      input,
      { idempotencyKey: options.key ?? testUuid() }
    )
  }
  const create = (
    input: unknown = { ...cmsDocument(), expectedVersion: 0 },
    options: { key?: string; db?: D1Database } = {}
  ) => execute('create_draft', {}, input, options)
  const update = (
    id: string,
    version = 1,
    extra: Record<string, unknown> = {},
    options: { key?: string; db?: D1Database } = {}
  ) =>
    execute(
      'update_draft',
      { pageId: id },
      {
        ...cmsDocument({ title: 'Guía renovada', changeSummary: 'Cambio editorial sintético', ...extra }),
        expectedVersion: version
      },
      options
    )
  const state = () =>
    [
      'content_pages',
      'content_versions',
      'content_slug_claims',
      'content_draft_commands',
      'content_draft_audit',
      'content_draft_guards'
    ].map((table) => sqlite.prepare(`SELECT * FROM ${table} ORDER BY 1`).all())
  function beforeBatch(effect: () => void) {
    return new Proxy(database, {
      get(target, key, receiver) {
        if (key === 'batch')
          return async <T>(statements: D1PreparedStatement[]) => {
            effect()
            return target.batch<T>(statements)
          }
        return Reflect.get(target, key, receiver)
      }
    })
  }
  it('creates one private page and immutable v1 with exact durable receipt/audit', async () => {
    const result = await create()
    expect(cmsCommandReceiptSchema.parse(result)).toMatchObject({
      source: 'cloudflare',
      action: 'create_draft',
      pageVersion: 1,
      draftVersion: 1,
      status: 'draft',
      slug: 'guia-editorial',
      updated: true
    })
    const detail = cmsPageDetailSchema.parse(await getD1CmsPage(database, CMS_CLAIMS, result.pageId))
    expect(detail.page.draftVersionId).toBe(result.versionId)
    expect(detail.draft.document).toEqual(cmsDocument())
    expect(detail.history.versions).toHaveLength(1)
    expect(detail.capabilities).toEqual({
      contentRead: true,
      contentCreate: true,
      contentUpdate: true,
      contentRestore: true,
      contentArchive: true,
      contentPublish: false,
      contentPreview: false,
      contentSchedule: false
    })
    const command = sqlite.prepare('SELECT * FROM content_draft_commands').get()!,
      audit = sqlite.prepare('SELECT * FROM content_draft_audit').get()!
    for (const key of Object.keys(audit).filter((field) => field !== 'command_id'))
      expect(audit[key]).toEqual(command[key])
    expect(sqlite.prepare('SELECT count(*) AS total FROM content_draft_guards').get()).toEqual({ total: 0 })
  })
  it('appends versions, preserves authorship, reserves old slugs and restores full snapshots as new', async () => {
    const first = await create(),
      second = await update(first.pageId, 1, { slug: 'guia-renovada' })
    const restored = await execute(
      'restore_draft',
      { pageId: first.pageId },
      { expectedVersion: 2, versionId: first.versionId, reason: 'Restauración contextual sintética' }
    )
    expect(restored).toMatchObject({ pageVersion: 3, draftVersion: 3, slug: 'guia-editorial', status: 'draft' })
    expect(restored.versionId).not.toBe(first.versionId)
    const data = await getD1CmsPage(database, CMS_CLAIMS, first.pageId)
    expect(data.history.versions.map((v) => v.version)).toEqual([3, 2, 1])
    expect(data.draft.document.title).toBe('Guía editorial')
    expect(data.draft.basedOnId).toBe(first.versionId)
    expect(data.history.versions[1]!.id).toBe(second.versionId)
    expect(sqlite.prepare('SELECT count(*) AS total FROM content_slug_claims').get()).toEqual({ total: 2 })
    await expect(create({ ...cmsDocument({ slug: 'guia-renovada' }), expectedVersion: 0 })).rejects.toMatchObject({
      code: 'slug_conflict'
    })
  })
  it('archives recoverably without deleting a version and restores the archived page with CAS', async () => {
    const first = await create(),
      archived = await execute(
        'archive_draft',
        { pageId: first.pageId },
        { expectedVersion: 1, reason: 'Retirada contextual sintética' }
      )
    expect(archived).toMatchObject({ status: 'hidden', pageVersion: 2, draftVersion: 1, versionId: first.versionId })
    expect((await getD1CmsPage(database, CMS_CLAIMS, first.pageId)).page.archivedAt).not.toBeNull()
    await expect(update(first.pageId, 2)).rejects.toMatchObject({ code: 'draft_not_editable' })
    await expect(create()).rejects.toMatchObject({ code: 'slug_conflict' })
    const restored = await execute(
      'restore_draft',
      { pageId: first.pageId },
      { expectedVersion: 2, versionId: first.versionId, reason: 'Recuperar borrador archivado' }
    )
    expect(restored).toMatchObject({ status: 'draft', pageVersion: 3, draftVersion: 2 })
    expect((await getD1CmsPage(database, CMS_CLAIMS, first.pageId)).page.archivedAt).toBeNull()
  })
  it('exact same-key replay remains historical after editing and archival and does not create versions', async () => {
    const first = await create(undefined, { key: 'create-exact' })
    await update(first.pageId)
    await execute(
      'archive_draft',
      { pageId: first.pageId },
      { expectedVersion: 2, reason: 'Retirada contextual sintética' }
    )
    const before = state()
    expect(await create(undefined, { key: 'create-exact' })).toEqual(first)
    expect(state()).toEqual(before)
    await expect(
      create({ ...cmsDocument({ title: 'Otra guía' }), expectedVersion: 0 }, { key: 'create-exact' })
    ).rejects.toMatchObject({ code: 'idempotency_conflict' })
  })
  it('rejects stale CAS and a restore source belonging to another page without mutations', async () => {
    const first = await create(),
      other = await create({ ...cmsDocument({ slug: 'otra-guia' }), expectedVersion: 0 })
    await update(first.pageId)
    const before = state()
    await expect(update(first.pageId)).rejects.toMatchObject({ code: 'version_conflict' })
    await expect(
      execute(
        'restore_draft',
        { pageId: first.pageId },
        { expectedVersion: 2, versionId: other.versionId, reason: 'Restauración contextual sintética' }
      )
    ).rejects.toMatchObject({ code: 'not_found' })
    expect(state()).toEqual(before)
  })
  it.each(['session', 'email', 'mfa', 'grant', 'locked', 'role-future', 'role-expired'])(
    'denies current %s authority before writing',
    async (cause) => {
      if (cause === 'session')
        sqlite.prepare('UPDATE auth_sessions SET revoked_at=? WHERE id=?').run(cmsUtc(), CMS_SESSION)
      if (cause === 'email') sqlite.prepare('UPDATE identities SET email_verified_at=NULL WHERE id=?').run(CMS_IDENTITY)
      if (cause === 'mfa') sqlite.prepare('UPDATE auth_sessions SET mfa_verified=0 WHERE id=?').run(CMS_SESSION)
      if (cause === 'grant') sqlite.exec("DELETE FROM role_permissions WHERE permission_code='catalog.write'")
      if (cause === 'locked') sqlite.prepare("UPDATE identities SET status='locked' WHERE id=?").run(CMS_IDENTITY)
      if (cause === 'role-future')
        sqlite.prepare('UPDATE identity_roles SET granted_at=? WHERE identity_id=?').run(cmsUtc(3600000), CMS_IDENTITY)
      if (cause === 'role-expired')
        sqlite.prepare('UPDATE identity_roles SET expires_at=? WHERE identity_id=?').run(cmsUtc(-1000), CMS_IDENTITY)
      const before = state()
      await expect(create()).rejects.toMatchObject({
        code:
          cause === 'session' || cause === 'locked'
            ? 'unauthenticated'
            : cause === 'email'
              ? 'email_unverified'
              : cause === 'mfa'
                ? 'mfa_required'
                : 'forbidden'
      })
      expect(state()).toEqual(before)
    }
  )
  it('uses the exact existing permissions for authoring, restoration and archival', async () => {
    sqlite.exec("DELETE FROM role_permissions WHERE permission_code IN ('catalog.publish','administration.manage')")
    const first = await create()
    await update(first.pageId)
    expect((await listD1CmsPages(database, CMS_CLAIMS)).capabilities).toMatchObject({
      contentRestore: false,
      contentArchive: false,
      contentCreate: true
    })
    await expect(
      execute(
        'restore_draft',
        { pageId: first.pageId },
        { expectedVersion: 2, versionId: first.versionId, reason: 'Restauración contextual sintética' }
      )
    ).rejects.toMatchObject({ code: 'forbidden' })
    await expect(
      execute(
        'archive_draft',
        { pageId: first.pageId },
        { expectedVersion: 2, reason: 'Retirada contextual sintética' }
      )
    ).rejects.toMatchObject({ code: 'forbidden' })
  })
  it.each(['session', 'grant', 'cas'])(
    'revalidates %s at batch execution and rolls back owned commands',
    async (cause) => {
      const first = await create()
      const db = beforeBatch(() => {
        if (cause === 'session')
          sqlite.prepare('UPDATE auth_sessions SET revoked_at=? WHERE id=?').run(cmsUtc(), CMS_SESSION)
        if (cause === 'grant') sqlite.exec("DELETE FROM role_permissions WHERE permission_code='catalog.write'")
        if (cause === 'cas') sqlite.prepare('UPDATE content_pages SET page_version=2 WHERE id=?').run(first.pageId)
      })
      await expect(update(first.pageId, 1, {}, { db })).rejects.toMatchObject({
        code: cause === 'session' ? 'unauthenticated' : cause === 'grant' ? 'forbidden' : 'version_conflict'
      })
      expect(sqlite.prepare('SELECT count(*) AS total FROM content_draft_commands').get()).toEqual({ total: 1 })
      expect(sqlite.prepare('SELECT count(*) AS total FROM content_versions').get()).toEqual({ total: 1 })
    }
  )
  it('rolls back all writes if audit cannot be inserted', async () => {
    sqlite.exec(
      "CREATE TRIGGER cms_test_audit_failure BEFORE INSERT ON content_draft_audit BEGIN SELECT RAISE(ABORT,'synthetic_audit_failure'); END;"
    )
    await expect(create()).rejects.toMatchObject({ code: 'conflict' })
    expect(state().every((rows) => rows.length === 0)).toBe(true)
  })
  it.each(['content_versions', 'content_slug_claims', 'content_draft_commands', 'content_draft_audit'])(
    'makes %s immutable against update/delete/replacement',
    async (table) => {
      await create()
      const before = state()
      const firstColumn = table === 'content_slug_claims' ? 'slug' : 'id'
      expect(() => sqlite.exec(`UPDATE ${table} SET ${firstColumn}=${firstColumn}`)).toThrow()
      expect(() => sqlite.exec(`DELETE FROM ${table}`)).toThrow()
      const columns = Object.keys(sqlite.prepare(`SELECT * FROM ${table}`).get()!)
      expect(() =>
        sqlite.exec(`INSERT OR REPLACE INTO ${table}(${columns.join(',')}) SELECT ${columns.join(',')} FROM ${table}`)
      ).toThrow()
      expect(state()).toEqual(before)
    }
  )
  it('never treats missing or malformed batch envelopes as a confirmed mutation, then allows exact recovery', async () => {
    const db = new Proxy(database, {
      get(target, key, receiver) {
        if (key === 'batch')
          return async (statements: D1PreparedStatement[]) => {
            await target.batch(statements)
            return []
          }
        return Reflect.get(target, key, receiver)
      }
    })
    await expect(create(undefined, { key: 'ambiguous-create', db })).rejects.toThrow('cms_write_unconfirmed')
    const recovered = await create(undefined, { key: 'ambiguous-create' })
    expect(recovered.pageVersion).toBe(1)
    expect(sqlite.prepare('SELECT count(*) AS total FROM content_versions').get()).toEqual({ total: 1 })
  })
  it('lists and pages immutable history with explicit confirmed totals', async () => {
    const first = await create()
    for (let n = 1; n < 4; n++) await update(first.pageId, n)
    const list = cmsPageListSchema.parse(await listD1CmsPages(database, CMS_CLAIMS, { page: 2, perPage: 1 }))
    expect(list.pages).toEqual([])
    expect(list.pagination).toEqual({ page: 2, perPage: 1, total: 1, hasMore: false })
    const detail = await getD1CmsPage(database, CMS_CLAIMS, first.pageId, { page: 2, perPage: 2 })
    expect(detail.history.versions.map((v) => v.version)).toEqual([2, 1])
    expect(detail.draft.version).toBe(4)
  })
  it.each([
    '//hostile.invalid',
    '/\\hostile.invalid',
    'https://user:password@hostile.invalid',
    'javascript:alert(1)',
    '/ruta%0aerror'
  ])('rejects unsafe typed CTA %j', async (href) => {
    await expect(
      create({ ...cmsDocument({ blocks: [{ id: CMS_BLOCK, type: 'cta', label: 'Ir', href }] }), expectedVersion: 0 })
    ).rejects.toMatchObject({ code: 'invalid_input' })
  })
  it.each(['html', 'duplicate', 'getter', 'sparse', 'too-large', 'unknown', 'missing-image'])(
    'rejects malformed or ungoverned draft %s',
    async (shape) => {
      const input = { ...cmsDocument(), expectedVersion: 0 }
      if (shape === 'html') Object.assign(input, { html: '<script>' })
      if (shape === 'duplicate') input.blocks = [...input.blocks, ...input.blocks]
      if (shape === 'getter')
        Object.defineProperty(input, 'title', {
          enumerable: true,
          get() {
            throw new Error('must never invoke')
          }
        })
      if (shape === 'sparse') input.blocks = Array(2)
      if (shape === 'too-large')
        input.blocks = Array.from({ length: 80 }, (_, n) => ({
          id: `30000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
          type: 'paragraph',
          text: 'a'.repeat(5000)
        }))
      if (shape === 'unknown') Object.assign(input, { expectedVersion: '0' })
      if (shape === 'missing-image')
        Object.assign(input, {
          blocks: [{ id: CMS_BLOCK, type: 'image', assetId: CMS_BLOCK, alt: 'Imagen pendiente', caption: '' }]
        })
      await expect(create(input)).rejects.toMatchObject({
        code: shape === 'missing-image' ? 'reference_unavailable' : 'invalid_input'
      })
      expect(state().every((rows) => rows.length === 0)).toBe(true)
    }
  )
  it('accepts literal script text and safe internal/HTTPS CTAs but no arbitrary renderer primitive', () => {
    expect(
      cmsCreateInputSchema.safeParse({
        ...cmsDocument({ blocks: [{ id: CMS_BLOCK, type: 'paragraph', text: '<script>literal</script>' }] }),
        expectedVersion: 0
      }).success
    ).toBe(true)
    for (const href of ['/catalogo?familia=limpieza', 'https://neteco.invalid/guia'])
      expect(
        cmsCreateInputSchema.safeParse({
          ...cmsDocument({ blocks: [{ id: CMS_BLOCK, type: 'cta', label: 'Ir', href }] }),
          expectedVersion: 0
        }).success
      ).toBe(true)
  })
})

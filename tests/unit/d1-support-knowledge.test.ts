import { readFile } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { deterministicTestData } from '../fixtures/deterministic'
import { CMS_CLAIMS, cmsDocument, cmsUtc, cmsFixture } from './d1-cms-fixture'
import { executeD1CmsDraftCommand as draftCommand } from '../../workers/cms/drafts'
import { executeCmsPublicationCommand } from '../../workers/cms/publication'
import { cmsDocumentSchema } from '../../shared/cms-commands'
import {
  listSupportKnowledge,
  recordSupportKnowledgeFeedback,
  readSupportKnowledgeFeedback
} from '../../workers/support/knowledge'
import { testNow } from '../support/deterministic'

// support_knowledge_feedback_current compares reviewDueAt with SQLite's real clock, so the
// frozen JS clock must be anchored at the real present (a fixed past date would age out).
const ANCHOR = new Date(Math.floor(testNow() / 1000) * 1000).toISOString()

describe('published CMS help knowledge and anonymous bounded feedback', () => {
  let f: Awaited<ReturnType<typeof cmsFixture>> & {
    deps: { database: D1Database; enabled: boolean; now: () => string }
  }
  const now = () => data.date().toISOString().replace('.000Z', 'Z')
  const executeD1CmsDraftCommand: typeof draftCommand = (database, claims, action, target, body, options) =>
    draftCommand(database, claims, action, target, body, { ...options, now: now() })
  let data = deterministicTestData('support-knowledge', ANCHOR)
  beforeEach(async () => {
    data = deterministicTestData('support-knowledge', ANCHOR)
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(data.date())
    const fixture = await cmsFixture()
    f = { ...fixture, deps: { database: fixture.database, enabled: true, now } }
    if (!f.sqlite.prepare("SELECT 1 FROM sqlite_master WHERE name='support_knowledge_feedback'").get())
      f.sqlite.exec(
        await readFile(new URL('../../db/d1/migrations/0062_support_knowledge_feedback.sql', import.meta.url), 'utf8')
      )
  })
  afterEach(() => {
    f?.sqlite.close()
    vi.useRealTimers()
  })
  async function article(extra: Record<string, unknown> = {}, publish = true) {
    const created = await executeD1CmsDraftCommand(
      f.database,
      CMS_CLAIMS,
      'create_draft',
      {},
      {
        ...cmsDocument({
          title: 'Cómo consultar una factura',
          slug: 'ayuda-facturas',
          blocks: [{ id: data.uuid(), type: 'paragraph', text: 'Guía sintética para descargar documentos de prueba.' }],
          seo: {
            title: 'Ayuda con facturas',
            description: 'Orientación editorial sintética de facturación.',
            noindex: false
          },
          supportKnowledge: { category: 'facturas', reviewDueAt: cmsUtc(86400000) },
          ...extra
        }),
        expectedVersion: 0
      },
      { idempotencyKey: data.uuid() }
    )
    if (publish)
      await executeCmsPublicationCommand(
        f.deps,
        CMS_CLAIMS,
        created.pageId,
        {
          action: 'publish',
          expectedRevision: 0,
          expectedVersion: 1,
          versionId: created.versionId,
          reason: 'Revisión editorial sintética explícita'
        },
        data.uuid()
      )
    return created
  }
  const deps = () => ({ ...f.deps, feedbackEnabled: true })
  it('preserves optional metadata in the actual CMS version, indexes only public opted-in help and exposes real review dates', async () => {
    const a = await article()
    const stored = JSON.parse(
      String(f.sqlite.prepare('SELECT document FROM content_versions WHERE id=?').get(a.versionId)!.document)
    )
    expect(stored.supportKnowledge.category).toBe('facturas')
    const result = await listSupportKnowledge(deps(), { q: 'FACTURACIÓN', page: 1, perPage: 10 })
    expect(result).toMatchObject({
      source: 'cloudflare',
      total: 1,
      page: 1,
      perPage: 10,
      feedbackEnabled: true,
      categories: [{ id: 'facturas', label: 'Facturas' }]
    })
    expect(result.items).toEqual([
      expect.objectContaining({
        id: a.pageId,
        versionId: a.versionId,
        slug: 'ayuda-facturas',
        category: 'facturas',
        reviewedAt: expect.any(String),
        reviewDueAt: stored.supportKnowledge.reviewDueAt
      })
    ])
  })
  it('searches body text and escapes SQL/LIKE syntax without broad matches', async () => {
    await article()
    expect((await listSupportKnowledge(deps(), { q: 'DESCARGAR documentos', page: 1, perPage: 10 })).total).toBe(1)
    for (const q of ['%', '_', "' OR 1=1 --", 'no existe'])
      expect((await listSupportKnowledge(deps(), { q, page: 1, perPage: 10 })).items).toEqual([])
  })
  it.each(['draft', 'noindex', 'no-metadata', 'expired'])(
    'never exposes %s content or private snippets',
    async (kind) => {
      const extra: Record<string, unknown> = {}
      if (kind === 'noindex') extra.seo = { title: 'Privado', description: 'Secreto privado', noindex: true }
      if (kind === 'no-metadata') extra.supportKnowledge = undefined
      if (kind === 'expired') extra.supportKnowledge = { category: 'facturas', reviewDueAt: cmsUtc(-60000) }
      if (kind === 'no-metadata') {
        const document = cmsDocument({
          title: 'Sin metadata',
          slug: 'sin-metadata',
          seo: { title: 'Sin metadata', description: 'No pertenece a ayuda', noindex: false }
        })
        const created = await executeD1CmsDraftCommand(
          f.database,
          CMS_CLAIMS,
          'create_draft',
          {},
          { ...document, expectedVersion: 0 },
          { idempotencyKey: data.uuid() }
        )
        await executeCmsPublicationCommand(
          f.deps,
          CMS_CLAIMS,
          created.pageId,
          {
            action: 'publish',
            expectedRevision: 0,
            expectedVersion: 1,
            versionId: created.versionId,
            reason: 'Publicación no ayuda'
          },
          data.uuid()
        )
      } else await article(extra, kind !== 'draft')
      expect((await listSupportKnowledge(deps(), { q: '', page: 1, perPage: 10 })).items).toEqual([])
    }
  )
  it('uses the published revision rather than a newer draft and removes withdrawn articles', async () => {
    const a = await article()
    await executeD1CmsDraftCommand(
      f.database,
      CMS_CLAIMS,
      'update_draft',
      { pageId: a.pageId },
      { ...cmsDocument({ title: 'Texto privado nuevo', slug: 'privado-nuevo' }), expectedVersion: 1 },
      { idempotencyKey: data.uuid() }
    )
    expect((await listSupportKnowledge(deps(), { q: 'privado nuevo', page: 1, perPage: 10 })).total).toBe(0)
    expect((await listSupportKnowledge(deps(), { q: '', page: 1, perPage: 10 })).items[0]!.slug).toBe('ayuda-facturas')
    await executeCmsPublicationCommand(
      f.deps,
      CMS_CLAIMS,
      a.pageId,
      { action: 'withdraw', expectedRevision: 1, expectedVersion: 2, reason: 'Retirada editorial sintética' },
      data.uuid()
    )
    expect((await listSupportKnowledge(deps(), { q: '', page: 1, perPage: 10 })).items).toEqual([])
  })
  it('paginates deterministically and provides only eligible populated categories', async () => {
    await article({ title: 'A ayuda', slug: 'a-ayuda' })
    await article({
      title: 'B ayuda',
      slug: 'b-ayuda',
      supportKnowledge: { category: 'envios', reviewDueAt: cmsUtc(86400000) }
    })
    const first = await listSupportKnowledge(deps(), { q: '', page: 1, perPage: 1 }),
      second = await listSupportKnowledge(deps(), { q: '', page: 2, perPage: 1 })
    expect(first.total).toBe(2)
    expect(first.items[0]!.slug).toBe('a-ayuda')
    expect(second.items[0]!.slug).toBe('b-ayuda')
    expect(
      (await listSupportKnowledge(deps(), { q: '', page: 1, perPage: 10, category: 'envios' })).items.map(
        (item) => item.slug
      )
    ).toEqual(['b-ayuda'])
    expect(first.categories.map((category) => category.id).sort()).toEqual(['envios', 'facturas'])
  })
  it.each([
    { category: 'inventada', reviewDueAt: '2099-01-01T00:00:00Z' },
    { category: 'facturas' },
    { category: 'facturas', reviewDueAt: 'tomorrow' },
    { category: 'facturas', reviewDueAt: '2099-01-01T00:00:00Z', legalApproved: true }
  ])('rejects invalid optional CMS metadata %j', (supportKnowledge) =>
    expect(cmsDocumentSchema.safeParse(cmsDocument({ supportKnowledge })).success).toBe(false)
  )
  it('keeps legacy CMS documents valid without adding synthetic metadata', () => {
    const document = cmsDocumentSchema.parse(cmsDocument())
    expect(Object.hasOwn(document, 'supportKnowledge')).toBe(false)
  })
  it('rejects partial SQL receipts even when absent JSON members evaluate NULL', async () => {
    const a = await article(),
      publication = f.sqlite
        .prepare('SELECT publication_id FROM content_publication_states WHERE page_id=?')
        .get(a.pageId)!
    const id = data.uuid()
    expect(() =>
      f.sqlite
        .prepare(
          'INSERT INTO support_knowledge_feedback(id,idempotency_key,page_id,version_id,publication_id,helpful,response,created_at) VALUES (?,?,?,?,?,1,?,?)'
        )
        .run(
          id,
          'a'.repeat(64),
          a.pageId,
          a.versionId,
          publication.publication_id,
          JSON.stringify({ feedbackId: id }),
          now()
        )
    ).toThrow(/CHECK/)
  })
  it('records one anonymous useful/not-useful feedback, replays exactly and rejects changed payload', async () => {
    const a = await article(),
      body = { pageId: a.pageId, versionId: a.versionId, helpful: false },
      key = data.uuid()
    const receipt = await recordSupportKnowledgeFeedback(deps(), body, key)
    expect(receipt).toMatchObject({ source: 'cloudflare', ...body, recorded: true })
    expect(await recordSupportKnowledgeFeedback(deps(), body, key)).toEqual(receipt)
    expect(await readSupportKnowledgeFeedback(deps(), key)).toEqual(receipt)
    await expect(recordSupportKnowledgeFeedback(deps(), { ...body, helpful: true }, key)).rejects.toMatchObject({
      code: 'idempotency_conflict'
    })
    expect(f.sqlite.prepare('SELECT count(*) n FROM support_knowledge_feedback').get()).toEqual({ n: 1 })
    const stored = f.sqlite.prepare('SELECT idempotency_key,response FROM support_knowledge_feedback').get()!
    expect(stored.idempotency_key).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(stored)).not.toContain(key)
    const columns = f.sqlite
      .prepare('PRAGMA table_info(support_knowledge_feedback)')
      .all()
      .map((row) => row.name)
    expect(columns.some((name) => /email|address|ip_hash|identity|user_agent|comment/.test(String(name)))).toBe(false)
  })
  it('rejects feedback for drafts and unknown keys stay absent', async () => {
    const a = await article({}, false)
    await expect(
      recordSupportKnowledgeFeedback(deps(), { pageId: a.pageId, versionId: a.versionId, helpful: true }, data.uuid())
    ).rejects.toMatchObject({ code: 'article_unavailable' })
    expect(await readSupportKnowledgeFeedback(deps(), data.uuid())).toBeNull()
    expect(f.sqlite.prepare('SELECT count(*) n FROM support_knowledge_feedback').get()).toEqual({ n: 0 })
  })
  it('keeps committed receipts recoverable after withdrawal but rejects every new vote', async () => {
    const a = await article(),
      body = { pageId: a.pageId, versionId: a.versionId, helpful: true },
      key = data.uuid()
    const receipt = await recordSupportKnowledgeFeedback(deps(), body, key)
    await executeCmsPublicationCommand(
      f.deps,
      CMS_CLAIMS,
      a.pageId,
      { action: 'withdraw', expectedRevision: 1, expectedVersion: 1, reason: 'Retirada editorial sintética' },
      data.uuid()
    )
    expect(await readSupportKnowledgeFeedback(deps(), key)).toEqual(receipt)
    expect(await recordSupportKnowledgeFeedback(deps(), body, key)).toEqual(receipt)
    await expect(recordSupportKnowledgeFeedback(deps(), body, data.uuid())).rejects.toMatchObject({
      code: 'article_unavailable'
    })
  })
  it('rejects expired help and unknown versions without creating feedback', async () => {
    const a = await article()
    const future = { ...deps(), now: () => data.date(86400000).toISOString().replace('.000Z', 'Z') }
    await expect(
      recordSupportKnowledgeFeedback(future, { pageId: a.pageId, versionId: a.versionId, helpful: true }, data.uuid())
    ).rejects.toMatchObject({ code: 'article_unavailable' })
    await expect(
      recordSupportKnowledgeFeedback(deps(), { pageId: a.pageId, versionId: data.uuid(), helpful: true }, data.uuid())
    ).rejects.toMatchObject({ code: 'article_unavailable' })
    expect(f.sqlite.prepare('SELECT count(*) n FROM support_knowledge_feedback').get()).toEqual({ n: 0 })
  })
  it('recovers a committed feedback when the adapter loses its write response', async () => {
    const a = await article(),
      body = { pageId: a.pageId, versionId: a.versionId, helpful: true },
      key = data.uuid()
    const raced = new Proxy(f.database, {
      get(target, property, receiver) {
        if (property === 'prepare')
          return (sql: string) => {
            const statement = f.database.prepare(sql)
            if (!sql.startsWith('INSERT INTO support_knowledge_feedback')) return statement
            return new Proxy(statement, {
              get(inner, operation) {
                if (operation === 'bind')
                  return (...args: unknown[]) => {
                    const bound = statement.bind(...args)
                    return new Proxy(bound, {
                      get(value, method) {
                        if (method === 'first')
                          return async () => {
                            await bound.first()
                            throw new Error('lost_write_response')
                          }
                        const member = Reflect.get(value, method)
                        return typeof member === 'function' ? member.bind(value) : member
                      }
                    })
                  }
                const member = Reflect.get(inner, operation)
                return typeof member === 'function' ? member.bind(inner) : member
              }
            })
          }
        return Reflect.get(target, property, receiver)
      }
    })
    const receipt = await recordSupportKnowledgeFeedback({ ...deps(), database: raced }, body, key)
    expect(await readSupportKnowledgeFeedback(deps(), key)).toEqual(receipt)
    expect(f.sqlite.prepare('SELECT count(*) n FROM support_knowledge_feedback').get()).toEqual({ n: 1 })
  })
  it('fails closed when the publication is withdrawn during the last response validation', async () => {
    const a = await article()
    let reads = 0
    const raced = new Proxy(f.database, {
      get(target, key, receiver) {
        if (key === 'batch')
          return async (statements: D1PreparedStatement[]) => {
            const result = await f.database.batch(statements)
            if (++reads === 1)
              f.sqlite
                .prepare(
                  'UPDATE content_publication_states SET publication_id=NULL,revision=revision+1 WHERE page_id=?'
                )
                .run(a.pageId)
            return result
          }
        return Reflect.get(target, key, receiver)
      }
    })
    await expect(
      listSupportKnowledge({ ...deps(), database: raced }, { q: '', page: 1, perPage: 10 })
    ).rejects.toBeInstanceOf(Error)
  })
})

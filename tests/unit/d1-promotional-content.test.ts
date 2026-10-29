import { afterEach, beforeEach, expect, it } from 'vitest'
import { cmsPublicationFixture } from './d1-cms-publication-fixture'
import { CMS_CLAIMS, cmsDocument } from './d1-cms-fixture'
import { executeD1CmsDraftCommand } from '../../workers/cms/drafts'
import { executeCmsPublicationCommand } from '../../workers/cms/publication'
import { readCmsPublicPage } from '../../workers/cms/public-http'
import { readD1PromotionalContent } from '../../workers/cms/promotional-content'
import { cmsDocumentSchema } from '../../shared/cms-commands'
import {
  promotionalContextSchema,
  promotionalContentSchema,
  type PromotionalMetadata
} from '../../shared/promotional-content'

let f: Awaited<ReturnType<typeof cmsPublicationFixture>>
beforeEach(async () => {
  f = await cmsPublicationFixture()
})
afterEach(() => f?.sqlite.close())
const home = { placement: 'home', path: '/' }
const metadata = (extra: Partial<PromotionalMetadata> = {}): PromotionalMetadata => ({
  format: 'banner',
  placements: ['home'],
  priority: 0,
  paths: [],
  categorySlugs: [],
  productSlugs: [],
  ...extra
})
async function publish(slug: string, promotional = metadata()) {
  const created = await executeD1CmsDraftCommand(
    f.database,
    CMS_CLAIMS,
    'create_draft',
    {},
    {
      ...cmsDocument({ slug, title: slug, promotional }),
      expectedVersion: 0
    },
    { idempotencyKey: crypto.randomUUID() }
  )
  const receipt = await executeCmsPublicationCommand(
    f.deps,
    CMS_CLAIMS,
    created.pageId,
    {
      action: 'publish',
      expectedRevision: 0,
      expectedVersion: 1,
      versionId: created.versionId,
      reason: 'Synthetic manual editorial approval'
    },
    crypto.randomUUID()
  )
  return { created, receipt }
}
it('selects only current published contextual promotions, not ordinary pages or private drafts', async () => {
  const selected = await publish('home-promo')
  await publish('catalog-promo', metadata({ placements: ['catalog'] }))
  const ordinary = await executeD1CmsDraftCommand(
    f.database,
    CMS_CLAIMS,
    'create_draft',
    {},
    {
      ...cmsDocument({ slug: 'ordinary-page' }),
      expectedVersion: 0
    },
    { idempotencyKey: crypto.randomUUID() }
  )
  await executeCmsPublicationCommand(
    f.deps,
    CMS_CLAIMS,
    ordinary.pageId,
    {
      action: 'publish',
      expectedRevision: 0,
      expectedVersion: 1,
      versionId: ordinary.versionId,
      reason: 'Synthetic ordinary page approval'
    },
    crypto.randomUUID()
  )
  const result = promotionalContentSchema.parse(await readD1PromotionalContent(f.deps, home))
  expect(result.items.map((item) => item.pageId)).toEqual([selected.created.pageId])
  expect(result.items[0]?.publicationId).toBe(selected.receipt.publicationId)
  expect(JSON.stringify(result)).not.toContain('actor_id')
})
it('orders priority deterministically and caps the response at six without writes', async () => {
  const rows = []
  for (let n = 0; n < 8; n++) rows.push(await publish(`promo-${n}`, metadata({ priority: n < 4 ? 5 : 10 })))
  const before = f.sqlite.prepare('SELECT count(*) n FROM content_publication_audit').get()
  const expected = rows
    .sort((a, b) => {
      const pa = Number(a.created.slug.slice(-1)) < 4 ? 5 : 10,
        pb = Number(b.created.slug.slice(-1)) < 4 ? 5 : 10
      return pb - pa || a.created.pageId.localeCompare(b.created.pageId)
    })
    .slice(0, 6)
    .map((row) => row.created.pageId)
  expect((await readD1PromotionalContent(f.deps, home)).items.map((item) => item.pageId)).toEqual(expected)
  expect(f.sqlite.prepare('SELECT count(*) n FROM content_publication_audit').get()).toEqual(before)
})
it('intersects surface, exact route, category and product selectors without personal targeting', async () => {
  const row = await publish(
    'targeted-promo',
    metadata({
      placements: ['product'],
      paths: ['/producto/limpiador'],
      categorySlugs: ['limpieza'],
      productSlugs: ['limpiador']
    })
  )
  const context = {
    placement: 'product',
    path: '/producto/limpiador',
    productSlug: 'limpiador',
    categorySlug: 'limpieza'
  }
  expect((await readD1PromotionalContent(f.deps, context)).items[0]?.pageId).toBe(row.created.pageId)
  expect((await readD1PromotionalContent(f.deps, { ...context, categorySlug: 'otra' })).items).toEqual([])
  expect((await readD1PromotionalContent(f.deps, home)).items).toEqual([])
})
it('never projects an unpublished edit instead of the immutable published version', async () => {
  const row = await publish('immutable-promo')
  await executeD1CmsDraftCommand(
    f.database,
    CMS_CLAIMS,
    'update_draft',
    { pageId: row.created.pageId },
    {
      ...cmsDocument({ slug: 'immutable-promo', promotional: metadata(), title: 'Unpublished private replacement' }),
      expectedVersion: 1
    },
    { idempotencyKey: crypto.randomUUID() }
  )
  const result = await readD1PromotionalContent(f.deps, home)
  expect(result.items[0]?.version).toBe(1)
  expect(JSON.stringify(result)).not.toContain('Unpublished private replacement')
})
it('withdrawal immediately removes the promotional block', async () => {
  const row = await publish('withdrawn-promo')
  await executeCmsPublicationCommand(
    f.deps,
    CMS_CLAIMS,
    row.created.pageId,
    {
      action: 'withdraw',
      expectedRevision: 1,
      expectedVersion: 1,
      reason: 'Synthetic explicit withdrawal'
    },
    crypto.randomUUID()
  )
  expect((await readD1PromotionalContent(f.deps, home)).items).toEqual([])
})
it('discards a release withdrawn during the selection await before returning public content', async () => {
  const row = await publish('raced-promo')
  const prepare = f.database.prepare.bind(f.database)
  let removed = false
  const database = {
    ...f.database,
    prepare(sql: string) {
      const statement = prepare(sql),
        bind = statement.bind.bind(statement)
      statement.bind = (...values: unknown[]) => {
        const bound = bind(...values),
          all = bound.all.bind(bound)
        bound.all = async (...args: Parameters<typeof all>) => {
          const result = await all(...args)
          if (!removed && sql.includes('content_publications')) {
            removed = true
            await executeCmsPublicationCommand(
              f.deps,
              CMS_CLAIMS,
              row.created.pageId,
              {
                action: 'withdraw',
                expectedRevision: 1,
                expectedVersion: 1,
                reason: 'Synthetic concurrent withdrawal'
              },
              crypto.randomUUID()
            )
          }
          return result
        }
        return bound
      }
      return statement
    }
  } as D1Database
  expect((await readD1PromotionalContent({ ...f.deps, database }, home)).items).toEqual([])
  expect(removed).toBe(true)
})
it('fails closed on database outages instead of an apparently healthy empty response', async () => {
  const database = {
    ...f.database,
    prepare() {
      throw Error('synthetic_read_failure')
    }
  } as D1Database
  await expect(readD1PromotionalContent({ ...f.deps, database }, home)).rejects.toMatchObject({
    code: 'service_unavailable'
  })
})
it('preserves old documents and rejects private-route or personalized promotional metadata', () => {
  expect(cmsDocumentSchema.safeParse(cmsDocument()).success).toBe(true)
  expect(cmsDocumentSchema.safeParse(cmsDocument({ promotional: metadata() })).success).toBe(true)
  expect(
    cmsDocumentSchema.safeParse(cmsDocument({ promotional: { ...metadata(), customerId: crypto.randomUUID() } }))
      .success
  ).toBe(false)
  expect(cmsDocumentSchema.safeParse(cmsDocument({ promotional: metadata({ paths: ['/cuenta'] }) })).success).toBe(
    false
  )
  expect(
    promotionalContextSchema.safeParse({ placement: 'product', path: '/producto/otro', productSlug: 'limpiador' })
      .success
  ).toBe(false)
})
it('rejects unsafe promotional DTO links with the same strong canonical CMS CTA policy', () => {
  for (const href of ['//foreign.invalid', '/%5cforeign.invalid', 'https://user:password@foreign.invalid']) {
    expect(
      promotionalContentSchema.safeParse({
        source: 'cloudflare',
        placement: 'home',
        evaluatedAt: '2026-10-09T12:00:00Z',
        items: [
          {
            pageId: crypto.randomUUID(),
            publicationId: crypto.randomUUID(),
            version: 1,
            title: 'Unsafe synthetic content',
            format: 'bar',
            media: {},
            blocks: [{ id: crypto.randomUUID(), type: 'cta', label: 'Untrusted link', href }]
          }
        ]
      }).success
    ).toBe(false)
  }
})
it('returns promotional presentation only through the existing version-pinned preview grant without publishing', async () => {
  const created = await executeD1CmsDraftCommand(
    f.database,
    CMS_CLAIMS,
    'create_draft',
    {},
    {
      ...cmsDocument({ slug: 'private-promotional-preview', promotional: metadata({ format: 'card' }) }),
      expectedVersion: 0
    },
    { idempotencyKey: crypto.randomUUID() }
  )
  const receipt = await executeCmsPublicationCommand(
    f.deps,
    CMS_CLAIMS,
    created.pageId,
    {
      action: 'preview',
      expectedRevision: 0,
      expectedVersion: 1,
      versionId: created.versionId,
      device: 'mobile',
      reason: 'Synthetic private promotional preview'
    },
    crypto.randomUUID()
  )
  const token = new URL(receipt.url!, 'https://cms.neteco.invalid').searchParams.get('preview')!
  expect(await readCmsPublicPage(f.deps, 'private-promotional-preview', token)).toMatchObject({
    preview: true,
    previewDevice: 'mobile',
    promotional: metadata({ format: 'card' }),
    version: 1
  })
  await expect(readCmsPublicPage(f.deps, 'private-promotional-preview')).rejects.toMatchObject({ code: 'not_found' })
})

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resourceHubFixture, editorial } from './resource-hub-fixture'
import { CMS_CLAIMS, cmsUtc } from './d1-cms-fixture'
import { executeCmsPublicationCommand } from '../../workers/cms/publication'
import { readCmsPublicPage } from '../../workers/cms/public-http'
import { listD1ResourceHub, readD1ResourceHub } from '../../workers/content/resource-hub'
import { testUuid } from '../support/deterministic'
describe('resource hub uses canonical CMS publication authority', () => {
  let f: Awaited<ReturnType<typeof resourceHubFixture>>
  beforeEach(async () => {
    f = await resourceHubFixture()
  })
  afterEach(() => f.sqlite.close())
  it('returns an empty public hub when only unrelated CMS drafts exist', async () => {
    expect(await listD1ResourceHub(f.deps, {})).toMatchObject({ source: 'cloudflare', items: [], total: 0 })
  })
  it('publishes reviewed author experience, dates and resource canonical from a real CMS release', async () => {
    await f.resource({ slug: 'recurso-profesional' })
    expect(await readD1ResourceHub(f.deps, 'recurso-profesional')).toMatchObject({
      source: 'cloudflare',
      canonicalPath: '/recursos/recurso-profesional',
      editorial: { author: { name: 'Autora sintética' } },
      preview: false
    })
  })
  it('does not expose drafts, preview capabilities or ordinary CMS documents as resources', async () => {
    await f.resource({ slug: 'recurso-privado' }, false)
    expect((await listD1ResourceHub(f.deps, {})).items).toEqual([])
    await expect(readD1ResourceHub(f.deps, 'recurso-privado')).rejects.toMatchObject({ code: 'not_found' })
    await expect(readD1ResourceHub(f.deps, 'guia-editorial')).rejects.toMatchObject({ code: 'not_found' })
  })
  it('withdraws a resource immediately through the existing publication command', async () => {
    const r = await f.resource({ slug: 'recurso-retirado' })
    await executeCmsPublicationCommand(
      f.deps,
      CMS_CLAIMS,
      r.pageId,
      { action: 'withdraw', expectedRevision: 1, expectedVersion: 1, reason: 'Retirada editorial sintética' },
      testUuid()
    )
    expect((await listD1ResourceHub(f.deps, {})).items).toEqual([])
    await expect(readD1ResourceHub(f.deps, 'recurso-retirado')).rejects.toMatchObject({ code: 'not_found' })
  })
  it('excludes an expired editorial review rather than trusting a published flag alone', async () => {
    await f.resource({
      slug: 'revision-caducada',
      resourceHub: editorial({ reviewedAt: cmsUtc(-86400000), reviewDueAt: cmsUtc(-60000) })
    })
    await expect(readD1ResourceHub(f.deps, 'revision-caducada')).rejects.toMatchObject({ code: 'not_found' })
  })
  it.each(['expired', 'future'])(
    'does not bypass %s resource review validity through the ordinary CMS public route',
    async (kind) => {
      const interval =
        kind === 'expired'
          ? { reviewedAt: cmsUtc(-86400000), reviewDueAt: cmsUtc(-60000) }
          : { reviewedAt: cmsUtc(60000), reviewDueAt: cmsUtc(86400000) }
      await f.resource({ slug: 'revision-ruta-cms', resourceHub: editorial(interval) })
      await expect(readCmsPublicPage(f.deps, 'revision-ruta-cms')).rejects.toMatchObject({ code: 'not_found' })
    }
  )
  it('searches title and category with bounded pagination and noindex for search results', async () => {
    await f.resource({ title: 'Tratamiento profesional sintético', slug: 'tratamiento-sintetico' })
    expect(
      await listD1ResourceHub(f.deps, { q: 'Tratamiento', category: 'limpieza-profesional', perPage: 1 })
    ).toMatchObject({ total: 1, noindex: true, items: [{ slug: 'tratamiento-sintetico' }] })
    expect((await listD1ResourceHub(f.deps, { q: 'inexistente' })).total).toBe(0)
  })
  it('never creates hyperlinks to absent products, categories or resources', async () => {
    await f.resource({
      slug: 'enlaces-filtrados',
      resourceHub: editorial({
        relatedProducts: [999999],
        relatedCategories: ['categoria-inexistente'],
        relatedResources: ['recurso-inexistente']
      })
    })
    expect(await readD1ResourceHub(f.deps, 'enlaces-filtrados')).toMatchObject({
      relatedProducts: [],
      relatedCategories: [],
      relatedResources: []
    })
  })
  it('rejects excessive pagination, unknown fields and preview tokens at the public boundary', async () => {
    for (const q of [{ perPage: 21 }, { page: 0 }, { preview: 'secret' }, { q: 'x'.repeat(81) }])
      await expect(listD1ResourceHub(f.deps, q)).rejects.toMatchObject({ code: 'invalid_input' })
  })
  it('filters internal commerce CTA links to unpublished targets but preserves safe external citations', async () => {
    await f.resource({
      slug: 'cta-filtradas',
      blocks: [
        { id: testUuid(), type: 'paragraph', text: 'Contenido editorial sintético.' },
        { id: testUuid(), type: 'cta', label: 'Destino externo', href: 'https://example.invalid/private' },
        { id: testUuid(), type: 'cta', label: 'Producto inexistente', href: '/producto/no-publicado' }
      ]
    })
    const dto = await readD1ResourceHub(f.deps, 'cta-filtradas')
    expect(dto.blocks.filter((block) => block.type === 'cta')).toEqual([
      { id: expect.any(String), type: 'cta', label: 'Destino externo', href: 'https://example.invalid/private' }
    ])
  })
  it('fails unavailable instead of returning an empty hub when the source is missing', async () => {
    f.sqlite.exec('DROP TABLE content_publications')
    await expect(listD1ResourceHub(f.deps, {})).rejects.toMatchObject({ code: 'content_unavailable' })
  })
  it('keeps disabled publication fail closed without leaking drafts', async () => {
    await expect(listD1ResourceHub({ ...f.deps, enabled: false }, {})).rejects.toMatchObject({ code: 'not_found' })
  })
})

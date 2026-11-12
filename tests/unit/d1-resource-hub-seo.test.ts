import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { handleD1SeoRequest, type D1SeoDependencies } from '../../workers/catalog/seo-http'
import { resourceHubFixture, editorial } from './resource-hub-fixture'
import { CMS_CLAIMS, cmsDocument, cmsUtc } from './d1-cms-fixture'
import { executeD1CmsDraftCommand } from '../../workers/cms/drafts'
import { executeCmsPublicationCommand } from '../../workers/cms/publication'
import { testUuid } from '../support/deterministic'

const ORIGIN = 'https://neteco.es'
const indexed = {
  title: 'Guía sintética',
  description: 'Contenido sintético revisado para el sitemap.',
  noindex: false
}
const locations = (body: string) => [...body.matchAll(/<loc>(.*?)<\/loc>/g)].map((match) => match[1]!)

describe('resource hub shares the canonical CMS sitemap authority', () => {
  let f: Awaited<ReturnType<typeof resourceHubFixture>>
  let deps: D1SeoDependencies
  beforeEach(async () => {
    f = await resourceHubFixture()
    deps = { database: f.database, origin: ORIGIN, environment: 'production', cmsPublication: f.deps }
  })
  afterEach(() => {
    f.sqlite.close()
  })
  async function handle(path = '/sitemaps/content.xml') {
    const response = await handleD1SeoRequest(new Request(`https://untrusted.invalid${path}`), deps)
    if (!response) throw Error('Expected owned CMS sitemap')
    return response
  }
  it('indexes the resource canonical exactly once while preserving legacy CMS paths and excluding drafts/noindex', async () => {
    await f.resource({ slug: 'recurso-vigente', seo: indexed })
    const legacy = await executeD1CmsDraftCommand(
      f.database,
      CMS_CLAIMS,
      'create_draft',
      {},
      {
        ...cmsDocument({ slug: 'contenido-legacy', seo: indexed }),
        expectedVersion: 0
      },
      { idempotencyKey: testUuid() }
    )
    await executeCmsPublicationCommand(
      f.deps,
      CMS_CLAIMS,
      legacy.pageId,
      {
        action: 'publish',
        expectedRevision: 0,
        expectedVersion: 1,
        versionId: legacy.versionId,
        reason: 'Publicación legacy sintética explícita para sitemap'
      },
      testUuid()
    )
    await f.resource({ slug: 'recurso-noindex', seo: { ...indexed, noindex: true } })
    await f.resource({ slug: 'recurso-borrador', seo: indexed }, false)
    const response = await handle(),
      body = await response.text()
    expect(response.status).toBe(200)
    expect(locations(body)).toEqual([`${ORIGIN}/contenido/contenido-legacy`, `${ORIGIN}/recursos/recurso-vigente`])
    expect(body).not.toMatch(/untrusted|\/contenido\/recurso-vigente|recurso-noindex|recurso-borrador|preview/)
  })
  it.each(['future', 'expired'] as const)(
    'excludes a resource whose review is %s from rows and shard counts',
    async (kind) => {
      const now = cmsUtc(),
        metadata =
          kind === 'future'
            ? editorial({ reviewedAt: cmsUtc(60_000), reviewDueAt: cmsUtc(120_000) })
            : editorial({ reviewedAt: cmsUtc(-120_000), reviewDueAt: now })
      await f.resource({ slug: 'revision-no-vigente', seo: indexed, resourceHub: metadata })
      deps.cmsPublication = { ...f.deps, now: () => now }
      expect(locations(await (await handle()).text())).toEqual([])
      // Existing CMS contract keeps its first shard even for an empty dataset.
      expect(
        locations(await (await handle('/sitemap.xml')).text()).filter((path) => path.includes('/sitemaps/content.xml'))
      ).toEqual([`${ORIGIN}/sitemaps/content.xml`])
      expect((await handle('/sitemaps/content.xml?page=2')).status).toBe(404)
    }
  )
  it('removes withdrawn resource heads rather than indexing an old release', async () => {
    const created = await f.resource({ slug: 'recurso-retirado', seo: indexed })
    await executeCmsPublicationCommand(
      f.deps,
      CMS_CLAIMS,
      created.pageId,
      {
        action: 'withdraw',
        expectedRevision: 1,
        expectedVersion: 1,
        reason: 'Retirada editorial sintética explícita'
      },
      testUuid()
    )
    expect(locations(await (await handle()).text())).toEqual([])
  })
  it('fails closed if review expires after the row snapshot but before final revalidation', async () => {
    const before = cmsUtc(),
      after = cmsUtc(120_000)
    await f.resource({
      slug: 'caduca-durante-lectura',
      seo: indexed,
      resourceHub: editorial({ reviewedAt: cmsUtc(-60_000), reviewDueAt: cmsUtc(60_000) })
    })
    let now = before
    deps.cmsPublication = { ...f.deps, now: () => now }
    const batch = f.database.batch
    deps.database = {
      ...f.database,
      batch: async (statements) => {
        const result = await batch(statements)
        now = after
        return result
      }
    }
    const response = await handle()
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: { code: 'service_unavailable' } })
  })
  it('keeps absent/disabled CMS outside route ownership and the existing five-route contract', async () => {
    await f.resource({ slug: 'desactivado', seo: indexed })
    for (const cmsPublication of [undefined, { ...f.deps, enabled: false }]) {
      deps.cmsPublication = cmsPublication
      expect(await handleD1SeoRequest(new Request(`${ORIGIN}/sitemaps/content.xml`), deps)).toBeNull()
      expect(locations(await (await handle('/sitemap.xml')).text())).toEqual([
        `${ORIGIN}/sitemaps/pages.xml`,
        `${ORIGIN}/sitemaps/categories.xml`,
        `${ORIGIN}/sitemaps/products.xml`
      ])
    }
  })
})

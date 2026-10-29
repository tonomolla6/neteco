import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { handleD1SeoRequest, ownsD1SeoNamespace, type D1SeoDependencies } from '../../workers/catalog/seo-http'
import { executeD1CmsDraftCommand } from '../../workers/cms/drafts'
import { executeCmsPublicationCommand } from '../../workers/cms/publication'
import { cmsPublicationFixture, cmsImageFixture } from './d1-cms-publication-fixture'
import { CMS_CLAIMS, CMS_IDENTITY, cmsDocument, cmsUtc } from './d1-cms-fixture'

const ORIGIN = 'https://neteco.es'
const locations = (body: string) => [...body.matchAll(/<loc>(.*?)<\/loc>/g)].map((match) => match[1]!)
const seo = { title: 'Synthetic indexed CMS', description: 'Migrated SQLite sitemap fixture only.', noindex: false }

describe('SEO namespace ownership before environment normalization', () => {
  it('owns the five existing exact routes and opts into only the CMS content shard', () => {
    for (const path of [
      '/robots.txt',
      '/sitemap.xml',
      '/sitemaps/pages.xml',
      '/sitemaps/categories.xml',
      '/sitemaps/products.xml'
    ]) {
      expect(ownsD1SeoNamespace(path)).toBe(true)
      expect(ownsD1SeoNamespace(path, false)).toBe(true)
      expect(ownsD1SeoNamespace(path, true)).toBe(true)
    }
    expect(ownsD1SeoNamespace('/sitemaps/content.xml')).toBe(false)
    expect(ownsD1SeoNamespace('/sitemaps/content.xml', false)).toBe(false)
    expect(ownsD1SeoNamespace('/sitemaps/content.xml', true)).toBe(true)
    for (const path of [
      '/api/admin/products',
      '/robots.txtx',
      '/sitemap.xml/extra',
      '/sitemaps/content.xml/extra',
      '/sitemaps/unknown.xml'
    ]) {
      expect(ownsD1SeoNamespace(path)).toBe(false)
      expect(ownsD1SeoNamespace(path, true)).toBe(false)
    }
  })
})

describe('native CMS sitemap against migrated real SQLite', () => {
  let f: Awaited<ReturnType<typeof cmsPublicationFixture>>
  let deps: D1SeoDependencies
  beforeEach(async () => {
    f = await cmsPublicationFixture()
    deps = { database: f.database, origin: ORIGIN, environment: 'production', cmsPublication: f.deps }
  })
  afterEach(() => f.sqlite.close())
  const request = (path: string, method = 'GET', headers: Record<string, string> = {}) =>
    new Request(`https://untrusted.invalid${path}`, { method, headers })
  const handle = async (path: string, method = 'GET', headers: Record<string, string> = {}) =>
    (await handleD1SeoRequest(request(path, method, headers), deps))!

  // Scalable migration-constrained fixtures, not fabricated D1 query results.
  function seedPage(slug: string, options: { publish?: boolean; noindex?: boolean; publishedAt?: string } = {}) {
    const pageId = crypto.randomUUID(),
      versionId = crypto.randomUUID(),
      publicationId = crypto.randomUUID()
    const now = cmsUtc(-1000),
      document = cmsDocument({ slug, seo: { ...seo, noindex: options.noindex ?? false } })
    f.sqlite
      .prepare(
        `INSERT INTO content_pages(id,slug,title,status,page_version,draft_version,created_by,created_at,updated_at)
 VALUES (?,?,'Guía editorial','draft',1,0,?,?,?)`
      )
      .run(pageId, slug, CMS_IDENTITY, now, now)
    f.sqlite
      .prepare('INSERT INTO content_versions(id,page_id,version,document,created_by,created_at) VALUES (?,?,1,?,?,?)')
      .run(versionId, pageId, JSON.stringify(document), CMS_IDENTITY, now)
    f.sqlite.prepare('UPDATE content_pages SET draft_version=1,draft_version_id=? WHERE id=?').run(versionId, pageId)
    if (options.publish !== false) {
      f.sqlite
        .prepare(
          `INSERT INTO content_publications(id,page_id,version_id,slug,actor_id,reason,published_at)
 VALUES (?,?,?,?,?,'Explicit synthetic editorial fixture',?)`
        )
        .run(publicationId, pageId, versionId, slug, CMS_IDENTITY, options.publishedAt ?? now)
      f.sqlite
        .prepare('INSERT INTO content_publication_states(page_id,revision,publication_id,updated_at) VALUES (?,1,?,?)')
        .run(pageId, publicationId, now)
    }
    return { pageId, versionId, publicationId, publishedAt: options.publishedAt ?? now }
  }
  async function indexedImage() {
    const image = await cmsImageFixture(f)
    const changed = await executeD1CmsDraftCommand(
      f.database,
      CMS_CLAIMS,
      'update_draft',
      { pageId: f.created.pageId },
      {
        ...cmsDocument({
          seo,
          blocks: [
            { id: crypto.randomUUID(), type: 'image', assetId: image.id, alt: 'Synthetic CMS image', caption: '' }
          ]
        }),
        expectedVersion: 2
      },
      { idempotencyKey: 'index-image' }
    )
    await executeCmsPublicationCommand(
      image.deps,
      CMS_CLAIMS,
      f.created.pageId,
      {
        action: 'publish',
        expectedRevision: 0,
        expectedVersion: 3,
        versionId: changed.versionId,
        reason: 'Explicit synthetic indexed media approval'
      },
      'image-publish'
    )
    return image
  }
  function denyRights(uploadId: string) {
    const hash = f.sqlite
      .prepare('SELECT payload_hash FROM media_rights_decisions WHERE upload_id=?')
      .get(uploadId)?.payload_hash
    if (typeof hash !== 'string') throw new Error('fixture_rights_missing')
    f.sqlite
      .prepare(
        `INSERT INTO media_rights_decisions(id,upload_id,decision,reason,actor_id,rights_owner,rights_license,created_at,idempotency_key,payload_hash)
 VALUES (?,?,'rejected','Explicit synthetic rights denial',?,'','',?,?,?)`
      )
      .run(crypto.randomUUID(), uploadId, CMS_IDENTITY, cmsUtc(), crypto.randomUUID(), hash)
  }

  it('absent/disabled CMS preserves the previous index and route ownership exactly', async () => {
    seedPage('published-but-disabled')
    deps.cmsPublication = undefined
    const baseline = await (await handle('/sitemap.xml')).text()
    expect(locations(baseline)).toEqual([
      `${ORIGIN}/sitemaps/pages.xml`,
      `${ORIGIN}/sitemaps/categories.xml`,
      `${ORIGIN}/sitemaps/products.xml`
    ])
    expect(await handleD1SeoRequest(request('/sitemaps/content.xml'), deps)).toBeNull()
    deps.cmsPublication = { ...f.deps, enabled: false }
    expect(await (await handle('/sitemap.xml')).text()).toBe(baseline)
    expect(await handleD1SeoRequest(request('/sitemaps/content.xml'), deps)).toBeNull()
    expect(await (await handle('/sitemaps/pages.xml')).text()).not.toContain('/contenido/')
  })

  it('discovers 1001 real current releases in truthful 1000+1 shards without overlap or truncation', async () => {
    f.sqlite.exec('BEGIN')
    for (let index = 0; index < 1001; index++) seedPage(`cms-${String(index).padStart(4, '0')}`)
    f.sqlite.exec('COMMIT')
    const first = await handle('/sitemaps/content.xml'),
      second = await handle('/sitemaps/content.xml?page=2')
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    const one = locations(await first.text()),
      two = locations(await second.text())
    expect(one).toHaveLength(1000)
    expect(two).toEqual([`${ORIGIN}/contenido/cms-1000`])
    expect(new Set([...one, ...two]).size).toBe(1001)
    expect(one[0]).toBe(`${ORIGIN}/contenido/cms-0000`)
    const index = locations(await (await handle('/sitemap.xml')).text())
    expect(index.slice(-2)).toEqual([`${ORIGIN}/sitemaps/content.xml`, `${ORIGIN}/sitemaps/content.xml?page=2`])
    expect((await handle('/sitemaps/content.xml?page=3')).status).toBe(404)
  })

  it('excludes unpublished drafts, noindex releases, future release dates and previously withdrawn heads', async () => {
    const live = seedPage('live-default')
    seedPage('private-draft', { publish: false })
    seedPage('editorial-noindex', { noindex: true })
    seedPage('future-release', { publishedAt: cmsUtc(60000) })
    const withdrawn = seedPage('withdrawn-release')
    f.sqlite
      .prepare('UPDATE content_publication_states SET revision=revision+1,publication_id=NULL WHERE page_id=?')
      .run(withdrawn.pageId)
    const response = await handle('/sitemaps/content.xml')
    const body = await response.text()
    expect(locations(body)).toEqual([`${ORIGIN}/contenido/live-default`])
    expect(body).toContain(`<lastmod>${live.publishedAt}</lastmod>`)
    expect(body).not.toMatch(/private-draft|editorial-noindex|future-release|withdrawn-release|preview|session|actor/)
    for (const id of [live.pageId, live.versionId, live.publicationId]) expect(body).not.toContain(id)
  })

  it('never indexes a preview or pending schedule even when that approved draft is indexable', async () => {
    const changed = await executeD1CmsDraftCommand(
      f.database,
      CMS_CLAIMS,
      'update_draft',
      { pageId: f.created.pageId },
      { ...cmsDocument({ seo }), expectedVersion: 1 },
      { idempotencyKey: 'indexed-draft' }
    )
    const preview = await executeCmsPublicationCommand(
      f.deps,
      CMS_CLAIMS,
      f.created.pageId,
      {
        action: 'preview',
        expectedRevision: 0,
        expectedVersion: 2,
        versionId: changed.versionId,
        reason: 'Explicit synthetic private preview',
        device: 'mobile'
      },
      'preview'
    )
    await executeCmsPublicationCommand(
      f.deps,
      CMS_CLAIMS,
      f.created.pageId,
      {
        action: 'schedule',
        expectedRevision: preview.revision,
        expectedVersion: 2,
        versionId: changed.versionId,
        reason: 'Explicit synthetic future approval',
        publishAtLocal: '2090-01-01T10:00',
        unpublishAtLocal: null
      },
      'schedule'
    )
    expect(locations(await (await handle('/sitemaps/content.xml')).text())).toEqual([])
    expect(f.sqlite.prepare('SELECT count(*) AS n FROM content_previews').get()?.n).toBe(1)
    expect(f.sqlite.prepare('SELECT count(*) AS n FROM content_schedules').get()?.n).toBe(1)
  })

  it('uses the published immutable slug/document, not later draft metadata or SEO', async () => {
    const original = seedPage('original-public')
    const changed = await executeD1CmsDraftCommand(
      f.database,
      CMS_CLAIMS,
      'update_draft',
      { pageId: original.pageId },
      { ...cmsDocument({ slug: 'later-private', seo: { ...seo, noindex: true } }), expectedVersion: 1 },
      { idempotencyKey: 'private-edit' }
    )
    expect(locations(await (await handle('/sitemaps/content.xml')).text())).toEqual([
      `${ORIGIN}/contenido/original-public`
    ])
    await executeCmsPublicationCommand(
      f.deps,
      CMS_CLAIMS,
      original.pageId,
      {
        action: 'publish',
        expectedRevision: 1,
        expectedVersion: 2,
        versionId: changed.versionId,
        reason: 'Publish explicit noindex revision'
      },
      'replacement'
    )
    expect(locations(await (await handle('/sitemaps/content.xml')).text())).toEqual([])
  })

  it('withdrawal as the real batch resolves fails closed and the next page omits it', async () => {
    const live = seedPage('withdraw-during-read')
    const original = f.database.batch
    deps.database = {
      ...f.database,
      batch: async (statements: D1PreparedStatement[]) => {
        const result = await original(statements)
        await executeCmsPublicationCommand(
          f.deps,
          CMS_CLAIMS,
          live.pageId,
          {
            action: 'withdraw',
            expectedRevision: 1,
            expectedVersion: 1,
            reason: 'Concurrent explicit editorial withdrawal'
          },
          'withdraw-race'
        )
        return result
      }
    }
    const response = await handle('/sitemaps/content.xml')
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: { code: 'service_unavailable' } })
    deps.database = f.database
    expect(locations(await (await handle('/sitemaps/content.xml')).text())).toEqual([])
  })

  it('media pages require delivery bindings and latest unexpired independent scan/rights evidence', async () => {
    const image = await indexedImage()
    expect(locations(await (await handle('/sitemaps/content.xml')).text())).toEqual([])
    deps.cmsPublication = image.deps
    expect(locations(await (await handle('/sitemaps/content.xml')).text())).toEqual([
      `${ORIGIN}/contenido/guia-editorial`
    ])
    deps.cmsPublication = { ...image.deps, now: () => cmsUtc(3700000) }
    expect(locations(await (await handle('/sitemaps/content.xml')).text())).toEqual([])
    deps.cmsPublication = image.deps
    denyRights(image.id)
    expect(locations(await (await handle('/sitemaps/content.xml')).text())).toEqual([])
  })

  it.each(['scan', 'rights'] as const)(
    'a fresh %s denial at real batch resolution cannot leak a stale sitemap URL',
    async (kind) => {
      const image = await indexedImage()
      deps.cmsPublication = image.deps
      const original = f.database.batch
      deps.database = {
        ...f.database,
        batch: async (statements: D1PreparedStatement[]) => {
          const result = await original(statements)
          if (kind === 'rights') denyRights(image.id)
          else {
            const checksum = f.sqlite.prepare('SELECT checksum FROM media_uploads WHERE id=?').get(image.id)?.checksum
            if (typeof checksum !== 'string') throw new Error('fixture_checksum_missing')
            f.sqlite
              .prepare(
                `INSERT INTO media_scan_receipts(id,upload_id,checksum,object_key,byte_size,verdict,scanner_version,scanned_at,expires_at,received_at,payload_hash)
 VALUES (?,?,?,?,?,'infected','synthetic-new-denial',?,?,?,?)`
              )
              .run(
                crypto.randomUUID(),
                image.id,
                checksum,
                image.key,
                image.bytes.length,
                cmsUtc(),
                cmsUtc(3600000),
                cmsUtc(),
                checksum
              )
          }
          return result
        }
      }
      const response = await handle('/sitemaps/content.xml')
      expect(response.status).toBe(503)
      expect(await response.json()).toEqual({ error: { code: 'service_unavailable' } })
      deps.database = f.database
      expect(locations(await (await handle('/sitemaps/content.xml')).text())).toEqual([])
    }
  )

  it('keeps GET/HEAD, canonical origin, no-store and preprod noindex contracts', async () => {
    seedPage('canonical-page')
    const normal = await handle('/sitemaps/content.xml')
    const hostile = await handle('/sitemaps/content.xml', 'GET', {
      host: 'evil.invalid',
      'x-forwarded-host': 'evil.invalid',
      origin: 'https://evil.invalid',
      cookie: 'private=secret'
    })
    expect(await hostile.text()).toBe(await normal.text())
    const head = await handle('/sitemaps/content.xml', 'HEAD')
    expect(head.status).toBe(normal.status)
    expect([...head.headers]).toEqual([...normal.headers])
    expect(await head.text()).toBe('')
    expect(normal.headers.get('cache-control')).toBe('private, no-store')
    expect(normal.headers.get('cdn-cache-control')).toBe('no-store')
    expect(normal.headers.get('set-cookie')).toBeNull()
    deps.environment = 'preprod'
    expect((await handle('/sitemaps/content.xml')).headers.get('x-robots-tag')).toBe('noindex, nofollow, noarchive')
  })

  it.each(['?preview=secret', '?segment=customer', '?page=0', '?page=01', '?page=1&page=2', '?page=50001'])(
    'rejects non-public query or malformed pagination %s',
    async (query) => {
      const response = await handle(`/sitemaps/content.xml${query}`)
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({ error: { code: 'invalid_query' } })
    }
  )
  it('returns private generic errors for invalid internal CMS clocks', async () => {
    deps.cmsPublication = { ...f.deps, now: () => '2026-02-30T00:00:00Z' }
    for (const path of ['/sitemap.xml', '/sitemaps/content.xml']) {
      const response = await handle(path)
      expect(response.status).toBe(503)
      expect(await response.json()).toEqual({ error: { code: 'service_unavailable' } })
    }
  })
})

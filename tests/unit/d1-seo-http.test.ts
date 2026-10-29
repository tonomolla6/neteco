import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { handleD1SeoRequest, type D1SeoDependencies } from '../../workers/catalog/seo-http'
import { d1OverSqlite, openMigratedDatabase, seedInventoryFixture } from '../support/d1-sqlite'
import { provisionPublicationValidityFixture } from '../support/publication-validity-fixture'

const ORIGIN = 'https://neteco.es'
const NOW = '2026-09-30T10:00:00Z'
const UPDATED = '2026-09-29T09:30:00Z'
const locs = (body: string) => [...body.matchAll(/<loc>(.*?)<\/loc>/g)].map((match) => match[1]!)

describe('Cloudflare-native public SEO HTTP on migrated SQLite', () => {
  let sqlite: DatabaseSync
  let deps: D1SeoDependencies
  beforeEach(async () => {
    sqlite = await openMigratedDatabase()
    seedInventoryFixture(sqlite)
    await provisionPublicationValidityFixture(d1OverSqlite(sqlite), {
      productIds: ['p-1', 'p-2', 'p-3', 'p-4', 'p-5', 'p-6'],
      now: '2026-08-19T00:00:00Z',
      validUntil: '2099-01-01T00:00:00Z'
    })
    sqlite.prepare('UPDATE products SET updated_at=?').run(UPDATED)
    sqlite.prepare('UPDATE categories SET updated_at=?').run(UPDATED)
    deps = { database: d1OverSqlite(sqlite), origin: ORIGIN, environment: 'production', now: NOW }
  })
  afterEach(() => sqlite.close())

  function request(path: string, method = 'GET', headers: Record<string, string> = {}) {
    return new Request(`https://untrusted.example.invalid${path}`, { method, headers })
  }
  async function handle(path: string, method = 'GET', headers: Record<string, string> = {}) {
    return (await handleD1SeoRequest(request(path, method, headers), deps))!
  }

  it('only owns the five exact routes, without hijacking unknown XML or UI routes', async () => {
    for (const path of [
      '/',
      '/sitemaps/unknown.xml',
      '/sitemaps/products.xml/extra',
      '/robots.txtx',
      '/feeds/products.xml'
    ]) {
      expect(await handleD1SeoRequest(request(path), deps)).toBeNull()
    }
  })

  it('advertises only production canonical pages and blocks all private route families', async () => {
    const robots = await handle('/robots.txt')
    expect(robots.status).toBe(200)
    expect(robots.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    expect(robots.headers.get('cache-control')).toBe('public, max-age=300')
    const text = await robots.text()
    expect(text).toContain(`Sitemap: ${ORIGIN}/sitemap.xml`)
    expect(text).toContain('Allow: /\n')
    for (const path of [
      '/admin',
      '/cuenta',
      '/carrito',
      '/checkout',
      '/pedido',
      '/auth',
      '/buscar',
      '/api',
      '/newsletter'
    ])
      expect(text).toContain(`Disallow: ${path}\n`)
    const pages = await handle('/sitemaps/pages.xml')
    const xml = await pages.text()
    expect(locs(xml)).toEqual(
      ['/', '/catalogo', '/envios', '/formas-de-pago', '/devoluciones', '/ayuda', '/accesibilidad', '/contacto'].map(
        (path) => `${ORIGIN}${path}`
      )
    )
    expect(xml).not.toContain('<lastmod>')
    expect(xml).not.toMatch(/\/contenido|\/buscar|\/cuenta|\/carrito|\/checkout/)
  })

  it.each(['local', 'preprod'] as const)(
    'disallows indexing everywhere in %s and does not advertise a crawl directive',
    async (environment) => {
      deps.environment = environment
      deps.origin = 'https://neteco.invalid'
      for (const path of [
        '/robots.txt',
        '/sitemap.xml',
        '/sitemaps/pages.xml',
        '/sitemaps/categories.xml',
        '/sitemaps/products.xml'
      ]) {
        const response = await handle(path)
        expect(response.status).toBe(200)
        expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow, noarchive')
        expect(response.headers.get('cache-control')).toBe('private, no-store')
        if (path === '/robots.txt') expect(await response.text()).toBe('User-agent: *\nDisallow: /\n')
      }
    }
  )

  it('uses only configured canonical origin and is independent of cookies and hostile proxy/origin headers', async () => {
    const baseline = await handle('/sitemaps/products.xml')
    const hostile = await handle('/sitemaps/products.xml', 'GET', {
      host: 'attacker.example.invalid',
      'x-forwarded-host': 'attacker.example.invalid',
      origin: 'https://attacker.example.invalid',
      cookie: 'neteco-session=private; cart=secret'
    })
    expect(await hostile.text()).toBe(await baseline.text())
    expect(hostile.headers.get('set-cookie')).toBeNull()
    expect(hostile.headers.get('vary')).toBeNull()
  })

  it('includes only published usable product details and no private identifiers or data', async () => {
    sqlite.prepare("UPDATE products SET status='draft' WHERE id='p-1'").run()
    sqlite.prepare("UPDATE products SET status='hidden' WHERE id='p-2'").run()
    sqlite.prepare("UPDATE variants SET status='draft' WHERE product_id='p-3'").run()
    sqlite.prepare("UPDATE variants SET legacy_id=NULL WHERE product_id='p-4'").run()
    sqlite.prepare("UPDATE products SET legacy_id=NULL WHERE id='p-5'").run()
    const response = await handle('/sitemaps/products.xml')
    const body = await response.text()
    expect(locs(body)).toEqual([`${ORIGIN}/producto/producto-6`])
    expect(body).toContain(`<lastmod>${UPDATED}</lastmod>`)
    expect(body).not.toMatch(/p-6|v-6-1|SKU-|customer|session|email/)
    sqlite.prepare("UPDATE categories SET status='hidden' WHERE id='c1'").run()
    expect(locs(await (await handle('/sitemaps/products.xml')).text())).toEqual([])
  })

  it('matches category API ancestor visibility and never includes descendants of hidden/draft parents', async () => {
    const insert = sqlite.prepare(
      'INSERT INTO categories(id,legacy_id,parent_id,name,slug,status,updated_at) VALUES (?,?,?,?,?,?,?)'
    )
    insert.run('visible-child', 101, 'c1', 'Visible', 'visible-child', 'published', UPDATED)
    insert.run('hidden-parent', 102, null, 'Hidden', 'hidden-parent', 'hidden', UPDATED)
    insert.run('hidden-child', 103, 'hidden-parent', 'Hidden child', 'hidden-child', 'published', UPDATED)
    insert.run('draft-child', 104, 'c1', 'Draft child', 'draft-child', 'draft', UPDATED)
    insert.run('nested', 105, 'visible-child', 'Nested', 'nested', 'published', UPDATED)
    expect(locs(await (await handle('/sitemaps/categories.xml')).text())).toEqual([
      `${ORIGIN}/categoria/nested`,
      `${ORIGIN}/categoria/quimicos`,
      `${ORIGIN}/categoria/visible-child`
    ])
  })

  it('encodes slugs as single URL segments and XML-escapes their remaining characters', async () => {
    // Category pages resolve a decoded segment against the category API. Product
    // detail routes instead enforce ASCII slugs and cannot serve this value.
    sqlite.prepare("UPDATE categories SET slug=? WHERE id='c1'").run('espáña/a &"<>\'')
    const body = await (await handle('/sitemaps/categories.xml')).text()
    expect(body).toContain(`${ORIGIN}/categoria/espa%C3%B1a%2Fa%20%26%22%3C%3E&apos;`.replace('espa', 'esp%C3%A1'))
    expect(body).not.toContain('<>')
    expect(body).not.toContain('https://untrusted')
  })

  it('omits invalid, timezone-ambiguous and future lastmod values instead of fabricating timestamps', async () => {
    const update = sqlite.prepare('UPDATE products SET updated_at=? WHERE id=?')
    update.run('2026-09-29 09:30:00', 'p-1')
    update.run('2026-13-45T99:99:99Z', 'p-2')
    update.run('2026-10-01T00:00:00Z', 'p-3')
    update.run('2026-09-29T10:30:00+01:00', 'p-4')
    update.run('2026-09-29T09:30:00.500Z', 'p-5')
    const body = await (await handle('/sitemaps/products.xml')).text()
    expect(body.match(/<lastmod>/g)).toHaveLength(2)
    expect(body).toContain('<lastmod>2026-09-29T09:30:00.500Z</lastmod>')
    expect(body).toContain(`<lastmod>${UPDATED}</lastmod>`)
    expect(body).not.toContain(NOW)
  })

  it('paginates 1001 real published products into truthful 1000+1 shards discovered by the index', async () => {
    const product = sqlite.prepare(
      "INSERT INTO products(id,legacy_id,category_id,name,slug,status,updated_at) VALUES (?,?,'c1',?,?,'published',?)"
    )
    const variant = sqlite.prepare(
      "INSERT INTO variants(id,legacy_id,product_id,tax_class_id,shipping_profile_id,sku,format,status,price_gross_cents) VALUES (?, ?, ?, 't21', 'sp1', ?, 'Unit', 'published', 500)"
    )
    sqlite.exec('BEGIN')
    for (let index = 0; index < 995; index++) {
      const id = `bulk-${String(index).padStart(4, '0')}`
      product.run(id, index + 1000, `Bulk ${index}`, id, UPDATED)
      variant.run(`variant-${id}`, index + 1000, id, `sku-${id}`)
    }
    sqlite.exec('COMMIT')
    await provisionPublicationValidityFixture(deps.database, {
      productIds: Array.from({ length: 995 }, (_, index) => `bulk-${String(index).padStart(4, '0')}`),
      now: '2026-08-19T00:00:00Z',
      validUntil: '2099-01-01T00:00:00Z'
    })
    const first = locs(await (await handle('/sitemaps/products.xml')).text())
    const second = locs(await (await handle('/sitemaps/products.xml?page=2')).text())
    expect(first).toHaveLength(1000)
    expect(second).toHaveLength(1)
    expect(new Set([...first, ...second]).size).toBe(1001)
    expect(locs(await (await handle('/sitemap.xml')).text())).toEqual([
      `${ORIGIN}/sitemaps/pages.xml`,
      `${ORIGIN}/sitemaps/categories.xml`,
      `${ORIGIN}/sitemaps/products.xml`,
      `${ORIGIN}/sitemaps/products.xml?page=2`
    ])
    expect((await handle('/sitemaps/products.xml?page=3')).status).toBe(404)
  })

  it('paginates real category URLs as well, without truncating discovery at the first thousand', async () => {
    const insert = sqlite.prepare(
      "INSERT INTO categories(id,legacy_id,name,slug,status,updated_at) VALUES (?,?,?,?,'published',?)"
    )
    for (let index = 0; index < 1000; index++)
      insert.run(`c-${index}`, index + 1000, `Category ${index}`, `category-${String(index).padStart(4, '0')}`, UPDATED)
    expect(locs(await (await handle('/sitemaps/categories.xml')).text())).toHaveLength(1000)
    expect(locs(await (await handle('/sitemaps/categories.xml?page=2')).text())).toHaveLength(1)
    expect(locs(await (await handle('/sitemap.xml')).text())).toContain(`${ORIGIN}/sitemaps/categories.xml?page=2`)
  })

  it('returns matching GET and HEAD status/headers with an empty HEAD body', async () => {
    for (const path of [
      '/robots.txt',
      '/sitemap.xml',
      '/sitemaps/pages.xml',
      '/sitemaps/categories.xml',
      '/sitemaps/products.xml',
      '/sitemaps/products.xml?page=99'
    ]) {
      const get = await handle(path)
      const head = await handle(path, 'HEAD')
      expect(head.status).toBe(get.status)
      expect([...head.headers]).toEqual([...get.headers])
      expect(await head.text()).toBe('')
    }
  })

  it('rejects unsupported methods before consuming a streaming body or touching D1', async () => {
    const batch = vi.fn()
    deps.database = { batch } as unknown as D1Database
    const req = new Request(`${ORIGIN}/sitemaps/products.xml`, { method: 'POST', body: 'untrusted' })
    const response = await handleD1SeoRequest(req, deps)
    expect(response?.status).toBe(405)
    expect(response?.headers.get('allow')).toBe('GET, HEAD')
    expect(req.bodyUsed).toBe(false)
    expect(batch).not.toHaveBeenCalled()
  })

  it.each([
    '?q=x',
    '?page=0',
    '?page=-1',
    '?page=1.5',
    '?page=01',
    '?page=1&page=1',
    '?page=',
    '?page=50001',
    '?page=1%27%3BDELETE'
  ])('rejects malformed, duplicate or unknown pagination %s before D1', async (query) => {
    const batch = vi.fn()
    deps.database = { batch } as unknown as D1Database
    const response = await handle(`/sitemaps/products.xml${query}`)
    expect(response.status).toBe(400)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(batch).not.toHaveBeenCalled()
  })

  it.each(['/robots.txt?page=1', '/sitemap.xml?page=1', '/sitemaps/pages.xml?page=1'])(
    'rejects pagination where it is not part of the contract: %s',
    async (path) => {
      expect((await handle(path)).status).toBe(400)
    }
  )

  it.each([
    '',
    'http://neteco.es',
    'https://neteco.es/',
    'https://neteco.es/other',
    'https://user:secret@neteco.es',
    'https://neteco.es?attack=1',
    ' https://neteco.es',
    'https://neteco.invalid'
  ])('fails closed on invalid production canonical origin %s', async (origin) => {
    deps.origin = origin
    const batch = vi.fn()
    deps.database = { batch } as unknown as D1Database
    const response = await handle('/sitemap.xml')
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: { code: 'service_unavailable' } })
    expect(batch).not.toHaveBeenCalled()
  })

  it('fails closed on unknown environments and invalid server instants', async () => {
    deps.environment = 'audit' as D1SeoDependencies['environment']
    expect((await handle('/robots.txt')).status).toBe(503)
    deps.environment = 'production'
    deps.now = '2026-02-30T00:00:00Z'
    expect((await handle('/sitemap.xml')).status).toBe(503)
  })

  it('uses generic private errors for D1 outages without exposing SQL, stack or state', async () => {
    deps.database = {
      batch: vi.fn(async () => {
        throw new Error('SQL SELECT secret_session_token FROM private_customer')
      })
    } as unknown as D1Database
    for (const path of ['/sitemap.xml', '/sitemaps/products.xml', '/sitemaps/categories.xml']) {
      const response = await handle(path)
      expect(response.status).toBe(503)
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(await response.json()).toEqual({ error: { code: 'service_unavailable' } })
    }
  })

  it('fails closed rather than silently truncating an oversized index or an invalid overlong public URL', async () => {
    const actual = deps.database
    deps.database = {
      prepare: vi.fn(() => ({})),
      batch: vi.fn(async () => [{ results: [{ total: 0 }] }, { results: [{ total: 50_000_000 }] }])
    } as unknown as D1Database
    expect((await handle('/sitemap.xml')).status).toBe(503)
    deps.database = actual
    sqlite.prepare("UPDATE categories SET slug=? WHERE id='c1'").run('x'.repeat(2050))
    expect((await handle('/sitemaps/categories.xml')).status).toBe(503)
  })
})

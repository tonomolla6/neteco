import { randomBytes } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import canary from '../../workers/canary'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import { createShopIngress, type ShopRenderer } from '../../workers/runtime/shop-ingress'
import { d1OverSqlite, openMigratedDatabase, seedInventoryFixture } from '../support/d1-sqlite'
import { provisionPublicationValidityFixture } from '../support/publication-validity-fixture'

const ORIGIN = 'https://neteco.es'
const ROUTES = [
  '/robots.txt',
  '/sitemap.xml',
  '/sitemaps/pages.xml',
  '/sitemaps/categories.xml',
  '/sitemaps/products.xml'
]
const locations = (body: string) => [...body.matchAll(/<loc>(.*?)<\/loc>/g)].map((match) => match[1]!)

describe('SEO privacy and public-route parity through the real shop ingress and D1 Worker', () => {
  let sqlite: DatabaseSync
  let env: CloudflareEnv
  let renderer: { fetch: Mock<ShopRenderer['fetch']> }
  let ingress: ReturnType<typeof createShopIngress>
  const context = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext

  beforeEach(async () => {
    sqlite = await openMigratedDatabase()
    seedInventoryFixture(sqlite)
    env = {
      DB: d1OverSqlite(sqlite),
      APP_ENV: 'production',
      PUBLIC_SITE_ORIGIN: ORIGIN,
      AUTH_ENABLED: 'false'
    } as CloudflareEnv
    await provisionPublicationValidityFixture(env.DB, {
      productIds: ['p-1', 'p-2', 'p-3', 'p-4', 'p-5', 'p-6'],
      now: '2026-08-19T00:00:00Z',
      validUntil: '2099-01-01T00:00:00Z'
    })
    // The real canary must answer SEO before any renderer or legacy handler.
    renderer = {
      fetch: vi.fn<ShopRenderer['fetch']>(async () => new Response('renderer must not answer SEO', { status: 599 }))
    }
    ingress = createShopIngress(canary, renderer)
  })
  afterEach(() => sqlite.close())

  function fetch(path: string, init: RequestInit = {}) {
    return ingress.fetch(new Request(`https://attacker.example.invalid${path}`, init), env, context)
  }

  it('keeps every discovery response identical with a real valid session and sensitive D1 rows', async () => {
    const privateEmail = 'seo-private-customer@example.invalid'
    const privateIdentity = 'seo-private-identity'
    const privateSession = 'seo-private-session'
    sqlite
      .prepare(
        "INSERT INTO identities(id,email,password_hash,status,created_at,updated_at) VALUES (?,?,?,'active','2020-01-01T00:00:00Z','2020-01-01T00:00:00Z')"
      )
      .run(privateIdentity, privateEmail, 'synthetic-private-password-hash')
    sqlite
      .prepare(
        "INSERT INTO auth_sessions(id,identity_id,session_version,created_at,expires_at) VALUES (?,?,1,'2020-01-01T00:00:00Z','2099-01-01T00:00:00Z')"
      )
      .run(privateSession, privateIdentity)
    const password = randomBytes(32).toString('hex')
    const issued = await issueD1SessionCookie(
      env.DB,
      { identityId: privateIdentity, sessionId: privateSession, sessionVersion: 1 },
      { password, maxAgeSeconds: 3600 }
    )
    expect(issued).toBeTruthy()
    const cookie = issued!.split(';')[0]!
    env.AUTH_ENABLED = 'true'
    env.AUTH_ORIGIN = ORIGIN
    env.NUXT_SESSION_PASSWORD = password
    env.AUTH_TOKEN_PEPPER = randomBytes(32).toString('hex')
    const prepare = vi.spyOn(env.DB, 'prepare')

    for (const path of ROUTES) {
      const baseline = await fetch(path)
      const authenticated = await fetch(path, {
        headers: {
          cookie,
          authorization: 'Bearer synthetic-private-access-token',
          origin: 'https://malicious-origin.example.invalid',
          host: 'malicious-host.example.invalid',
          'x-forwarded-host': 'malicious-proxy.example.invalid',
          'x-forwarded-proto': 'http'
        }
      })
      expect(authenticated.status).toBe(200)
      const body = await authenticated.text()
      expect(body).toBe(await baseline.text())
      expect([...authenticated.headers]).toEqual([...baseline.headers])
      expect(authenticated.headers.get('cache-control')).toBe(
        path === '/robots.txt' || path === '/sitemaps/pages.xml' ? 'public, max-age=300' : 'private, no-store'
      )
      expect(authenticated.headers.get('cdn-cache-control')).toBe('no-store')
      expect(authenticated.headers.has('set-cookie')).toBe(false)
      expect(authenticated.headers.has('vary')).toBe(false)
      for (const secret of [privateEmail, privateIdentity, privateSession, cookie, password, 'synthetic-private'])
        expect(body).not.toContain(secret)
      expect(body).not.toContain('malicious-')
      expect(body).not.toContain('attacker.example.invalid')
    }
    expect(prepare.mock.calls.flat().join('\n')).not.toMatch(
      /identities|auth_sessions|newsletter|customers|checkout|orders|cart_commands/i
    )
    expect(renderer.fetch).not.toHaveBeenCalled()
  })

  it('preserves GET status and headers for HEAD across all SEO routes without rendering or leaking a body', async () => {
    for (const path of ROUTES) {
      const get = await fetch(path)
      const head = await fetch(path, { method: 'HEAD', headers: { cookie: 'neteco-session=private' } })
      expect(head.status).toBe(get.status)
      expect([...head.headers]).toEqual([...get.headers])
      expect(await head.text()).toBe('')
    }
    expect(renderer.fetch).not.toHaveBeenCalled()
  })

  it('rejects four-round encoded discovery aliases before consuming writes or invoking any D1 handler', async () => {
    const prepare = vi.spyOn(env.DB, 'prepare')
    for (const path of ['/%25252573itemap.xml', '/%25252572obots.txt', '/%25252573itemaps/products.xml']) {
      const request = new Request(`https://attacker.example.invalid${path}`, {
        method: 'POST',
        body: 'synthetic-private-body-token'
      })
      const response = await ingress.fetch(request, env, context)
      expect(response.status).toBe(400)
      expect(response.headers.get('cache-control')).toContain('no-store')
      expect(await response.json()).toEqual({ error: { code: 'invalid_path' } })
      expect(request.bodyUsed).toBe(false)
    }
    expect(prepare).not.toHaveBeenCalled()
    expect(renderer.fetch).not.toHaveBeenCalled()
  })

  it('never advertises a published product slug which the real public PDP endpoint rejects', async () => {
    for (const slug of [
      '',
      '-leading',
      'Uppercase',
      'has_underscore',
      'espáña',
      '../cuenta',
      'auth?token=private',
      'a#private',
      'a%2fadmin',
      'a\u0000private',
      'a'.repeat(181)
    ]) {
      sqlite.prepare("UPDATE products SET slug=? WHERE id='p-1'").run(slug)
      const sitemap = await fetch('/sitemaps/products.xml')
      expect(sitemap.status).toBe(200)
      const urls = locations(await sitemap.text())
      expect(urls).toHaveLength(5)
      expect(urls).not.toContain(`${ORIGIN}/producto/${encodeURIComponent(slug)}`)
      expect((await fetch(`/api/products/${encodeURIComponent(slug)}`)).status).toBe(404)
    }
    // Include the exact one-character, trailing-hyphen and 180-character edges
    // accepted by the authoritative HTTP regex, not a stricter made-up policy.
    for (const slug of ['a', '9', 'trailing-', 'a'.repeat(180)]) {
      sqlite.prepare("UPDATE products SET slug=? WHERE id='p-1'").run(slug)
      expect(locations(await (await fetch('/sitemaps/products.xml')).text())).toContain(`${ORIGIN}/producto/${slug}`)
      expect((await fetch(`/api/products/${slug}`)).status).toBe(200)
    }
    expect(renderer.fetch).not.toHaveBeenCalled()
  })

  it('excludes unservable slugs from index counts and pages, not only from the returned XML rows', async () => {
    sqlite.exec(`
      WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<1001)
      INSERT INTO products(id,legacy_id,category_id,name,slug,status)
      SELECT 'unservable-'||i,10000+i,'c1','Unservable '||i,'invalid_'||i,'published' FROM n;
      INSERT INTO variants(id,legacy_id,product_id,tax_class_id,shipping_profile_id,sku,format,status,price_gross_cents)
      SELECT 'variant-'||id,20000+legacy_id,id,'t21','sp1','SKU-'||id,'Unit','published',500
      FROM products WHERE id LIKE 'unservable-%';
    `)
    // Only the slug is invalid: all other publication evidence is explicit.
    await provisionPublicationValidityFixture(env.DB, {
      productIds: Array.from({ length: 1001 }, (_, index) => `unservable-${index + 1}`),
      now: '2026-08-19T00:00:00Z',
      validUntil: '2099-01-01T00:00:00Z'
    })
    const index = await fetch('/sitemap.xml')
    expect(index.status).toBe(200)
    expect(locations(await index.text()).filter((url) => url.includes('/sitemaps/products.xml'))).toEqual([
      `${ORIGIN}/sitemaps/products.xml`
    ])
    const first = await fetch('/sitemaps/products.xml')
    expect(first.status).toBe(200)
    expect(locations(await first.text())).toHaveLength(6)
    const absent = await fetch('/sitemaps/products.xml?page=2')
    expect(absent.status).toBe(404)
    expect(absent.headers.get('cache-control')).toContain('no-store')
    expect(renderer.fetch).not.toHaveBeenCalled()
  })

  it('omits unstable null-ID categories but retains mapped descendants exposed by the real category API', async () => {
    sqlite.exec(`
      INSERT INTO categories(id,name,slug,status)
      VALUES ('unmapped-one','Unmapped one','unmapped-one','published'),
        ('unmapped-two','Unmapped two','unmapped-two','published'),
        ('hidden-parent','Hidden parent','hidden-parent','hidden');
      INSERT INTO categories(id,legacy_id,parent_id,name,slug,status)
      VALUES ('mapped-child',81,'unmapped-one','Mapped child','mapped-child','published'),
        ('hidden-child',82,'hidden-parent','Hidden child','hidden-child','published');
    `)
    const categoryApi = await fetch('/api/categories')
    expect(categoryApi.status).toBe(200)
    const data = (await categoryApi.json()) as {
      flat: Array<{ id: number | null; slug: string; parentId: number | null }>
    }
    expect(data.flat).toContainEqual(expect.objectContaining({ id: 81, slug: 'mapped-child', parentId: null }))
    const publicMapped = data.flat.filter((category) => category.id !== null).map((category) => category.slug)
    const sitemap = await fetch('/sitemaps/categories.xml')
    expect(sitemap.status).toBe(200)
    expect(locations(await sitemap.text())).toEqual(
      publicMapped.sort().map((slug) => `${ORIGIN}/categoria/${encodeURIComponent(slug)}`)
    )
    expect(renderer.fetch).not.toHaveBeenCalled()
  })
})

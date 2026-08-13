import type { APIRequestContext, Page } from '@playwright/test'
import postgres from 'postgres'
import { expect, test } from '../fixtures/playwright'

interface CatalogItem {
  slug: string
  name: string
}

async function catalogFixtures(request: APIRequestContext) {
  const productsResponse = await request.get('/api/products?limit=1')
  expect(productsResponse.ok()).toBe(true)
  const products = (await productsResponse.json()) as { items: CatalogItem[] }
  const categoriesResponse = await request.get('/api/categories')
  expect(categoriesResponse.ok()).toBe(true)
  const categories = (await categoriesResponse.json()) as { flat: Array<{ slug: string; count: number }> }
  const product = products.items[0]
  const category = categories.flat.find((item) => item.count > 0)
  expect(product).toBeTruthy()
  expect(category).toBeTruthy()
  return { product: product!, category: category! }
}

async function expectCanonical(page: Page, path: string) {
  const origin = new URL(page.url()).origin
  const canonical = page.locator('link[rel="canonical"]')
  await expect(canonical).toHaveCount(1)
  await expect(canonical).toHaveAttribute('href', `${origin}${path}`)
  await expect(page.locator('link[rel="alternate"][hreflang="es-ES"]')).toHaveAttribute('href', `${origin}${path}`)
  await expect(page.locator('link[rel="alternate"][hreflang="x-default"]')).toHaveAttribute('href', `${origin}${path}`)
}

function escapedPattern(value: string) {
  return new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
}

test('returns correct public statuses, canonical URLs, metadata and non-production noindex', async ({
  page,
  request
}) => {
  const { product, category } = await catalogFixtures(request)
  const routes = [
    { path: '/', title: /NETECO/, description: /Tienda online de NETECO/ },
    { path: '/catalogo', title: /Todo el catálogo/, description: /Catálogo completo de NETECO/ },
    {
      path: `/categoria/${category.slug}`,
      title: /NETECO/,
      description: /Compra .+ de uso profesional/
    },
    { path: `/producto/${product.slug}`, title: escapedPattern(product.name), description: /.+/ }
  ]
  for (const route of routes) {
    const response = await page.goto(route.path)
    expect(response?.status()).toBe(200)
    await expect(page).toHaveTitle(route.title)
    await expect(page.locator('meta[name="description"]')).toHaveAttribute('content', route.description)
    await expectCanonical(page, route.path)
    expect(response?.headers()['x-robots-tag']).toContain('noindex, nofollow, noarchive')
  }

  expect((await request.get('/producto/seo-producto-inexistente')).status()).toBe(404)
  expect((await request.get('/categoria/seo-categoria-inexistente')).status()).toBe(404)
})

test('canonicalizes SKU and faceted pagination while keeping index bloat out', async ({ page, request }) => {
  const { product, category } = await catalogFixtures(request)
  const detailResponse = await request.get(`/api/products/${product.slug}`)
  const detail = (await detailResponse.json()) as { variants: Array<{ sku: string }> }
  const sku = detail.variants[0]!.sku

  await page.goto(`/producto/${product.slug}?sku=${encodeURIComponent(sku)}`)
  await expectCanonical(page, `/producto/${product.slug}`)

  await page.goto('/catalogo?page=2&sort=price_asc')
  await expectCanonical(page, '/catalogo?page=2')
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex, follow')

  await page.goto(`/categoria/${category.slug}?brand=NETECO&page=2`)
  await expectCanonical(page, `/categoria/${category.slug}?page=2`)
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex, follow')

  await page.goto('/buscar?q=detergente&page=2')
  await expectCanonical(page, '/buscar')
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex, follow')
})

test('exposes crawlable, self-canonical catalog pagination', async ({ page, request }) => {
  const firstResponse = await request.get('/api/products?page=1&limit=12')
  const secondResponse = await request.get('/api/products?page=2&limit=12')
  const first = (await firstResponse.json()) as { items: CatalogItem[]; pages: number }
  const second = (await secondResponse.json()) as { items: CatalogItem[] }
  expect(first.pages).toBeGreaterThan(1)
  expect(second.items.length).toBeGreaterThan(0)
  expect(second.items.some((item) => first.items.some((candidate) => candidate.slug === item.slug))).toBe(false)

  await page.goto('/catalogo')
  await expect(page.locator('head link[rel="next"]')).toHaveAttribute('href', '/catalogo?page=2')
  await expect(page.getByRole('link', { name: 'Página siguiente' })).toHaveAttribute('href', '/catalogo?page=2')

  await page.goto('/catalogo?page=2')
  await expectCanonical(page, '/catalogo?page=2')
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'index, follow')
  await expect(page.locator('head link[rel="prev"]')).toHaveAttribute('href', '/catalogo')
  await expect(page.getByRole('link', { name: 'Página anterior' })).toHaveAttribute('href', '/catalogo')
})

test('preserves canonical redirects without chains or query loss', async ({ request, deterministic }) => {
  const { product } = await catalogFixtures(request)
  const source = `/producto/seo-anterior-${deterministic.suffix}`
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 })
  try {
    await sql`
      INSERT INTO canonical_redirects (source_path, destination_path, status_code, resource_type, reason)
      VALUES (${source}, ${`/producto/${product.slug}`}, 301, 'product', 'SEO automated test')
    `
    const redirect = await request.get(`${source}?utm_source=test`, { maxRedirects: 0 })
    expect(redirect.status()).toBe(301)
    expect(redirect.headers().location).toBe(`/producto/${product.slug}?utm_source=test`)
    expect((await request.get(`${source}?utm_source=test`)).status()).toBe(200)
  } finally {
    await sql`DELETE FROM canonical_redirects WHERE source_path = ${source}`
    await sql.end({ timeout: 5 })
  }
})

test('publishes valid Organization, Product, Offer and breadcrumb schema', async ({ page, request }) => {
  const { product } = await catalogFixtures(request)
  await page.goto(`/producto/${product.slug}`)
  const schemas = await page.locator('script[type="application/ld+json"]').allTextContents()
  const documents = schemas.map((source) => JSON.parse(source) as Record<string, unknown>)
  expect(documents).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ '@context': 'https://schema.org', '@type': 'Organization', name: 'NETECO' }),
      expect.objectContaining({
        '@context': 'https://schema.org',
        '@type': 'Product',
        name: product.name,
        offers: expect.objectContaining({ '@type': 'Offer', priceCurrency: 'EUR' })
      }),
      expect.objectContaining({
        '@context': 'https://schema.org',
        '@type': 'BreadcrumbList',
        itemListElement: expect.arrayContaining([expect.objectContaining({ position: 1, name: 'Inicio' })])
      })
    ])
  )
})

test('keeps robots and every sitemap canonical, unique, public and reachable', async ({ request }) => {
  const robotsResponse = await request.get('/robots.txt')
  expect(robotsResponse.status()).toBe(200)
  expect(robotsResponse.headers()['content-type']).toContain('text/plain')
  const robots = await robotsResponse.text()
  for (const path of ['/admin', '/cuenta', '/checkout', '/pedido', '/buscar']) {
    expect(robots).toContain(`Disallow: ${path}`)
  }
  expect(robots).toMatch(/Sitemap: http:\/\/[^\s]+\/sitemap\.xml/)

  const indexResponse = await request.get('/sitemap.xml')
  expect(indexResponse.status()).toBe(200)
  const index = await indexResponse.text()
  const childUrls = [...index.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]!)
  expect(childUrls).toHaveLength(3)
  expect(new Set(childUrls).size).toBe(childUrls.length)

  const allUrls: string[] = []
  for (const childUrl of childUrls) {
    const response = await request.get(childUrl)
    expect(response.status()).toBe(200)
    expect(response.headers()['content-type']).toContain('application/xml')
    const body = await response.text()
    expect(body).toContain('<urlset')
    const urls = [...body.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]!)
    const lastModified = [...body.matchAll(/<lastmod>([^<]+)<\/lastmod>/g)].map((match) => match[1]!)
    if (!childUrl.endsWith('/pages.xml')) expect(lastModified).toHaveLength(urls.length)
    for (const value of lastModified) expect(Number.isNaN(Date.parse(value))).toBe(false)
    allUrls.push(...urls)
  }
  expect(allUrls.length).toBeGreaterThan(10)
  expect(new Set(allUrls).size).toBe(allUrls.length)
  expect(allUrls.some((url) => url.includes('/producto/'))).toBe(true)
  expect(allUrls.some((url) => url.includes('/categoria/'))).toBe(true)
  expect(allUrls.every((url) => !/\/(admin|cuenta|checkout|pedido|buscar)(?:\/|$)/.test(new URL(url).pathname))).toBe(
    true
  )
  for (const url of allUrls) expect((await request.get(url)).status(), url).toBe(200)
})

test('has no broken internal links in the crawlable storefront sample', async ({ page, request }) => {
  const { product, category } = await catalogFixtures(request)
  const links = new Set<string>()
  for (const path of ['/', '/catalogo', `/categoria/${category.slug}`, `/producto/${product.slug}`]) {
    await page.goto(path)
    for (const href of await page
      .locator('a[href]')
      .evaluateAll((anchors) => anchors.map((anchor) => anchor.getAttribute('href')))) {
      if (!href || href.startsWith('#') || /^(?:mailto|tel):/.test(href)) continue
      const url = new URL(href, page.url())
      if (url.origin === new URL(page.url()).origin) links.add(`${url.pathname}${url.search}`)
    }
  }
  for (const href of links) expect((await request.get(href)).status(), href).toBeLessThan(400)
})

import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '../fixtures/playwright'

test('publishes a live health check with security headers', async ({ request }) => {
  const response = await request.get('/api/health/live')
  expect(response.ok()).toBe(true)
  expect(await response.json()).toEqual({ status: 'ok', service: 'neteco', version: 'dev' })
  expect(response.headers()['x-content-type-options']).toBe('nosniff')
  expect(response.headers()['x-correlation-id']).toBeTruthy()
})

test('publishes crawl policy and a catalog sitemap without private routes', async ({ request }) => {
  const robots = await request.get('/robots.txt')
  expect(robots.ok()).toBe(true)
  expect(robots.headers()['content-type']).toContain('text/plain')
  expect(await robots.text()).toContain('Disallow: /checkout')

  const sitemap = await request.get('/sitemap.xml')
  expect(sitemap.ok()).toBe(true)
  expect(sitemap.headers()['content-type']).toContain('application/xml')
  const body = await sitemap.text()
  expect(body).toContain('<sitemapindex')
  expect(body).toContain('/sitemaps/products.xml')
  expect(body).not.toContain('/pedido/')

  const products = await request.get('/sitemaps/products.xml')
  expect(products.ok()).toBeTruthy()
  expect(products.headers()['content-type']).toContain('application/xml')
  const productsBody = await products.text()
  expect(productsBody).toContain('<urlset')
  expect(productsBody).toContain('/producto/')
  expect(productsBody).not.toContain('/pedido/')
})

test('storefront purchase path is keyboard-accessible and keeps a server cart', async ({ page, request }) => {
  const catalogResponse = await request.get('/api/products?limit=1')
  expect(catalogResponse.ok()).toBe(true)
  const catalog = (await catalogResponse.json()) as { items: Array<{ slug: string; name: string }> }
  const product = catalog.items[0]
  expect(product).toBeTruthy()

  await page.goto('/')
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Todo lo que tu negocio necesita')
  const homeA11y = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()
  expect(homeA11y.violations.filter((violation) => ['serious', 'critical'].includes(violation.impact ?? ''))).toEqual(
    []
  )

  await page.goto(`/producto/${product!.slug}`)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(product!.name)
  await page.getByRole('button', { name: 'Añadir al carrito' }).first().click()
  await expect(page.getByText('Añadido al carrito', { exact: true })).toBeVisible()

  await page.goto('/carrito')
  await expect(page.getByText(product!.name).first()).toBeVisible()
  await expect(page.getByRole('link', { name: /tramitar pedido/i })).toBeVisible()
})

test('private administration is not indexable and requires a session', async ({ page, request }) => {
  const response = await request.get('/admin', { maxRedirects: 0 })
  expect(response.status()).toBe(302)
  expect(response.headers()['x-robots-tag']).toContain('noindex')

  await page.goto('/admin')
  await expect(page).toHaveURL(/\/login\?redirect=/)
})

test('keeps the selected product variant in a shareable SKU URL', async ({ page, request }) => {
  const catalogResponse = await request.get('/api/products?limit=1')
  const catalog = (await catalogResponse.json()) as { items: Array<{ slug: string }> }
  const productResponse = await request.get(`/api/products/${catalog.items[0]!.slug}`)
  const product = (await productResponse.json()) as {
    slug: string
    variants: Array<{ sku: string; format: string }>
  }
  expect(product.variants.length).toBeGreaterThan(1)
  const first = product.variants[0]!
  const second = product.variants[1]!

  await page.goto(`/producto/${product.slug}?sku=${encodeURIComponent(second.sku)}`)
  await expect(page.locator('button[aria-pressed="true"]').filter({ hasText: second.sku })).toBeVisible()

  await page.getByRole('button').filter({ hasText: first.sku }).first().click()
  await expect(page).toHaveURL(new RegExp(`[?&]sku=${encodeURIComponent(first.sku)}(?:&|$)`))
})

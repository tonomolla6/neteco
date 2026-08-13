import { expect, test } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

test('publishes a live health check with security headers', async ({ request }) => {
  const response = await request.get('/api/health/live')
  expect(response.ok()).toBe(true)
  expect(await response.json()).toEqual({ status: 'ok', service: 'neteco' })
  expect(response.headers()['x-content-type-options']).toBe('nosniff')
  expect(response.headers()['x-correlation-id']).toBeTruthy()
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

import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/playwright'

const mobileProjects = new Set(['mobile-chrome', 'mobile-safari'])

async function dismissConsent(page: Page) {
  const dialog = page.getByRole('dialog', { name: 'Tu privacidad, bajo tu control' })
  if (await dialog.isVisible()) await dialog.getByRole('button', { name: 'Rechazar opcionales' }).click()
}

test('critical storefront smoke works in the supported browser and device profile', async ({
  page,
  request
}, testInfo) => {
  const live = await request.get('/api/health/live')
  expect(live.ok()).toBe(true)

  const catalogResponse = await request.get('/api/products?limit=1')
  expect(catalogResponse.ok()).toBe(true)
  const catalog = (await catalogResponse.json()) as { items: Array<{ slug: string; name: string }> }
  const product = catalog.items[0]
  expect(product).toBeTruthy()

  await page.goto('/')
  await dismissConsent(page)
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Todo lo que tu negocio necesita')

  if (mobileProjects.has(testInfo.project.name)) {
    await page.getByRole('button', { name: 'Abrir menú' }).click()
    const navigation = page.getByRole('dialog', { name: 'Menú de navegación' })
    await expect(navigation).toBeVisible()
    await navigation.getByRole('button', { name: 'Cerrar' }).click()
    await expect(navigation).toBeHidden()
  }

  await page.goto(`/producto/${product!.slug}`)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(product!.name)
  await page.getByRole('button', { name: 'Añadir al carrito' }).first().click()
  await expect(page.getByText('Añadido al carrito', { exact: true })).toBeVisible()

  await page.goto('/carrito')
  await expect(page.getByText(product!.name).first()).toBeVisible()
  await expect(page.getByRole('link', { name: /tramitar pedido/i })).toBeVisible()

  await page.goto('/admin')
  await expect(page).toHaveURL(/\/login\?redirect=/)
  await expect(page.getByRole('heading', { level: 1, name: 'Inicia sesión' })).toBeVisible()
})

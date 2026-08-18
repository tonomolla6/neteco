import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/playwright'

async function stabilize(page: Page) {
  await page.mouse.move(0, 0)
  await page.addStyleTag({
    content: `
      *, *::before, *::after {
        animation-delay: 0s !important;
        animation-duration: 0s !important;
        caret-color: transparent !important;
        scroll-behavior: auto !important;
        transition-delay: 0s !important;
        transition-duration: 0s !important;
      }
    `
  })
  await page.evaluate(async () => {
    await document.fonts.ready
    await Promise.all(
      [...document.images]
        .filter((image) => !image.complete)
        .map((image) => new Promise<void>((resolve) => image.addEventListener('load', () => resolve(), { once: true })))
    )
  })
  await expect(page.locator('body')).toBeVisible()
}

async function dismissConsent(page: Page) {
  const dialog = page.getByRole('dialog', { name: 'Tu privacidad, bajo tu control' })
  if (await dialog.isVisible()) await dialog.getByRole('button', { name: 'Rechazar opcionales' }).click()
}

test.beforeEach(async ({ page }) => {
  await page.clock.install({ time: new Date('2026-08-13T12:00:00.000Z') })
  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'light' })
})

test('public templates remain visually reviewed at stable breakpoints', async ({ page, request }) => {
  const response = await request.get('/api/products?limit=1')
  expect(response.status()).toBe(200)
  const body = (await response.json()) as { items: Array<{ slug: string }> }
  const product = body.items[0]
  expect(product).toBeTruthy()

  const templates = [
    { name: 'home', path: '/' },
    { name: 'catalog', path: '/catalogo' },
    { name: 'search', path: '/buscar?q=guante' },
    { name: 'product', path: `/producto/${product!.slug}` },
    { name: 'cart-empty', path: '/carrito' },
    { name: 'login', path: '/login' }
  ]

  for (const template of templates) {
    await test.step(template.name, async () => {
      await page.goto(template.path, { waitUntil: 'networkidle' })
      await dismissConsent(page)
      await stabilize(page)
      await expect(page).toHaveScreenshot(`${template.name}.png`, { fullPage: true })
    })
  }
})

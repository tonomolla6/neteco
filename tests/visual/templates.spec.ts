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
  const broken = await page.evaluate(async () => {
    await document.fonts.ready
    const images = [...document.images]
    // A full-page reference needs the below-fold assets too. Waiting only for
    // load events leaves native lazy images pending forever and misses errors.
    for (const image of images) image.loading = 'eager'
    await Promise.all(images.map((image) => image.decode().catch(() => undefined)))
    return images.filter((image) => image.isConnected && image.naturalWidth === 0).length
  })
  expect(broken, 'Rendered images must decode or present their real fallback').toBe(0)
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

const templates = [
  { name: 'home', path: '/' },
  { name: 'catalog', path: '/catalogo' },
  { name: 'search', path: '/buscar?q=guante' },
  { name: 'product', path: null },
  { name: 'cart-empty', path: '/carrito' },
  { name: 'login', path: '/login' }
] as const

// Each existing page/breakpoint comparison gets its own isolated browser
// context and result, so a home mismatch cannot hide the other five templates.
for (const template of templates)
  test(`public templates: ${template.name} remains visually reviewed at stable breakpoints`, async ({
    page,
    request
  }) => {
    let path: string
    if (template.path === null) {
      const response = await request.get('/api/products?limit=1')
      expect(response.status()).toBe(200)
      const body = (await response.json()) as { items: Array<{ slug: string }> }
      const product = body.items[0]
      expect(product).toBeTruthy()
      path = `/producto/${product!.slug}`
    } else path = template.path
    await page.goto(path, { waitUntil: 'networkidle' })
    await dismissConsent(page)
    await stabilize(page)
    await expect(page).toHaveScreenshot(`${template.name}.png`, { fullPage: true })
  })

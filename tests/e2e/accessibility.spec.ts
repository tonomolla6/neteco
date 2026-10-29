import AxeBuilder from '@axe-core/playwright'
import type { APIRequestContext, Page } from '@playwright/test'
import * as OTPAuth from 'otpauth'
import postgres, { type Sql } from 'postgres'
import { decryptSecret } from '../../server/utils/secrets'
import { expect, test } from '../fixtures/playwright'
import type { DeterministicTestData } from '../fixtures/deterministic'

const ORIGIN = new URL(process.env.PLAYWRIGHT_BASE_URL ?? `http://127.0.0.1:${process.env.PLAYWRIGHT_PORT ?? '3100'}`)
  .origin
const PASSWORD = 'Neteco-accessibility-2026'

async function databaseQuery<T>(query: (sql: Sql) => Promise<T>) {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 })
  try {
    return await query(sql)
  } finally {
    await sql.end({ timeout: 5 })
  }
}

async function expectNoBlockingAccessibilityViolations(page: Page, surface: string) {
  const report = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze()
  const blocking = report.violations
    .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
    .map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      help: violation.help,
      nodes: violation.nodes.map((node) => ({
        target: node.target.join(' '),
        html: node.html,
        failureSummary: node.failureSummary,
        checks: node.any.map((check) => check.data)
      }))
    }))
  if (blocking.length) {
    await test.info().attach(`axe-${surface.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.json`, {
      body: Buffer.from(JSON.stringify({ surface, url: page.url(), blocking }, null, 2)),
      contentType: 'application/json'
    })
  }
  expect(blocking, `${surface} has serious or critical WCAG violations`).toEqual([])
}

async function dismissConsent(page: Page) {
  const dialog = page.getByRole('dialog', { name: 'Tu privacidad, bajo tu control' })
  if (await dialog.isVisible()) await dialog.getByRole('button', { name: 'Rechazar opcionales' }).click()
}

async function verificationToken(email: string) {
  const envelope = await databaseQuery(async (sql) => {
    const [event] = await sql<{ tokenEnvelope: string }[]>`
      SELECT outbox.payload ->> 'tokenEnvelope' AS "tokenEnvelope"
      FROM outbox_events outbox
      JOIN identities identity ON identity.id = outbox.aggregate_id
      WHERE identity.email = ${email} AND outbox.event_type = 'identity.verification.requested'
      ORDER BY outbox.created_at DESC LIMIT 1
    `
    return event?.tokenEnvelope
  })
  expect(envelope).toBeTruthy()
  return decryptSecret(envelope!, process.env.AUTH_ENCRYPTION_KEY!)
}

async function responseOk(response: Awaited<ReturnType<APIRequestContext['post']>>, expected: number, label: string) {
  const body = await response.text()
  expect(response.status(), `${label}: ${body}`).toBe(expected)
  return response
}

/** Cliente identificado y verificado, sin MFA: es el perfil que usa el área de cliente. */
async function signInAsCustomer(request: APIRequestContext, deterministic: DeterministicTestData) {
  const email = deterministic.email('accessible-customer')
  await responseOk(
    await request.post('/api/auth/register', {
      data: {
        name: 'Clienta accesible',
        email,
        password: PASSWORD,
        phone: '600000001',
        company: 'Hostelería accesible',
        termsAccepted: true,
        newsletter: false
      },
      headers: { origin: ORIGIN }
    }),
    201,
    'registro cliente'
  )
  await responseOk(
    await request.post('/api/auth/verify-email', {
      data: { token: await verificationToken(email) },
      headers: { origin: ORIGIN }
    }),
    200,
    'verificación cliente'
  )
}

async function provisionAdministrator(request: APIRequestContext, deterministic: DeterministicTestData) {
  const email = deterministic.email('accessible-administrator')
  await responseOk(
    await request.post('/api/auth/register', {
      data: {
        name: 'Administración accesible',
        email,
        password: PASSWORD,
        phone: '600000000',
        company: 'NETECO accesibilidad',
        termsAccepted: true,
        newsletter: false
      },
      headers: { origin: ORIGIN }
    }),
    201,
    'registro admin'
  )
  await responseOk(
    await request.post('/api/auth/verify-email', {
      data: { token: await verificationToken(email) },
      headers: { origin: ORIGIN }
    }),
    200,
    'verificación admin'
  )
  await databaseQuery(async (sql) => {
    await sql`
      INSERT INTO identity_roles (identity_id, role_code)
      SELECT id, 'admin' FROM identities WHERE email = ${email}
      ON CONFLICT (identity_id, role_code) DO NOTHING
    `
  })
  const setup = await responseOk(
    await request.post('/api/auth/mfa/setup', { data: {}, headers: { origin: ORIGIN } }),
    200,
    'alta MFA admin'
  )
  const enrollment = (await setup.json()) as { manualKey: string }
  const totp = new OTPAuth.TOTP({
    issuer: 'NETECO',
    label: email,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(enrollment.manualKey)
  })
  await responseOk(
    await request.post('/api/auth/mfa/verify-setup', {
      data: { code: totp.generate() },
      headers: { origin: ORIGIN }
    }),
    200,
    'verificación MFA admin'
  )
}

test('blocks serious accessibility regressions in public templates and the consent modal', async ({
  page,
  request
}) => {
  const catalogResponse = await request.get('/api/products?limit=1')
  expect(catalogResponse.status()).toBe(200)
  const catalog = (await catalogResponse.json()) as { items: Array<{ slug: string; name: string }> }
  const product = catalog.items[0]
  expect(product).toBeTruthy()

  await page.goto('/')
  const consent = page.getByRole('dialog', { name: 'Tu privacidad, bajo tu control' })
  await expect(consent).toBeVisible()
  await expect(consent.getByRole('button', { name: 'Rechazar opcionales' })).toBeFocused()
  await expectNoBlockingAccessibilityViolations(page, 'consent-modal-initial')
  await consent.getByRole('button', { name: 'Configurar' }).click()
  await expect(consent.getByRole('checkbox', { name: 'Medición' })).toBeVisible()
  await expectNoBlockingAccessibilityViolations(page, 'consent-modal-configured')
  await consent.getByRole('button', { name: 'Rechazar opcionales' }).click()
  await expectNoBlockingAccessibilityViolations(page, 'home-template')

  await page.goto('/catalogo')
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  await expectNoBlockingAccessibilityViolations(page, 'catalog-template')

  await page.goto(`/producto/${product!.slug}`)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(product!.name)
  await expectNoBlockingAccessibilityViolations(page, 'product-template')
  await page.getByRole('button', { name: 'Ver la imagen a pantalla completa' }).click()
  const lightbox = page.getByRole('dialog', { name: `Imagen de ${product!.name}` })
  await expect(lightbox).toBeVisible()
  await expectNoBlockingAccessibilityViolations(page, 'product-lightbox-dialog')
  await lightbox.getByRole('button', { name: 'Cerrar la imagen' }).click()
  await expect(lightbox).toBeHidden()

  await page.goto('/login')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Inicia sesión')
  await expectNoBlockingAccessibilityViolations(page, 'authentication-template')
})

test('blocks serious accessibility regressions in responsive navigation and filter dialogs', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  await dismissConsent(page)

  await page.getByRole('button', { name: 'Abrir menú' }).click()
  const navigation = page.getByRole('dialog', { name: 'Menú de navegación' })
  await expect(navigation).toBeVisible()
  await expect(navigation.getByRole('button', { name: 'Cerrar' })).toBeFocused()
  await expectNoBlockingAccessibilityViolations(page, 'mobile-navigation-dialog')
  await navigation.getByRole('button', { name: 'Cerrar' }).click()
  await expect(page.getByRole('button', { name: 'Abrir menú' })).toBeFocused()

  await page.goto('/catalogo')
  await page.getByRole('button', { name: /Filtros/ }).click()
  const filters = page.getByRole('dialog', { name: 'Filtros' })
  await expect(filters).toBeVisible()
  await expectNoBlockingAccessibilityViolations(page, 'catalog-mobile-filter-dialog')
  await filters.getByRole('button', { name: 'Cerrar' }).click()

  await page.goto('/buscar?q=guante')
  await page.getByRole('button', { name: /Filtros/ }).click()
  const searchFilters = page.getByRole('dialog', { name: 'Filtros' })
  await expect(searchFilters).toBeVisible()
  await expectNoBlockingAccessibilityViolations(page, 'search-mobile-filter-dialog')
})

test('blocks serious accessibility regressions in empty and validation states', async ({ page }) => {
  await page.goto('/carrito')
  await dismissConsent(page)
  await expect(page.getByText('Tu carrito está vacío')).toBeVisible()
  await expectNoBlockingAccessibilityViolations(page, 'empty-cart-state')

  await page.goto('/checkout')
  await expect(page.getByText('Tu carrito está vacío')).toBeVisible()
  await expectNoBlockingAccessibilityViolations(page, 'empty-checkout-state')

  await page.goto('/buscar?q=zzzz-accessibility-no-results')
  await dismissConsent(page)
  await expect(page.getByText(/No hemos encontrado nada/i)).toBeVisible()
  await expectNoBlockingAccessibilityViolations(page, 'empty-search-state')

  await page.goto('/login')
  await page.getByRole('button', { name: 'Iniciar sesión' }).click()
  await expect(page.getByRole('alert')).toContainText('Introduce tu email y contraseña')
  await expectNoBlockingAccessibilityViolations(page, 'authentication-error-state')
})

test('blocks serious accessibility regressions in checkout form and errors', async ({ page, request }) => {
  const catalogResponse = await request.get('/api/products?limit=1')
  const catalog = (await catalogResponse.json()) as { items: Array<{ slug: string; name: string }> }
  const product = catalog.items[0]
  expect(product).toBeTruthy()

  await page.goto(`/producto/${product!.slug}`)
  await dismissConsent(page)
  await page.getByRole('button', { name: 'Añadir al carrito' }).first().click()
  await expect(page.getByText('Añadido al carrito', { exact: true })).toBeVisible()
  await page.goto('/checkout')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Tramitar pedido')
  await expect(page.getByLabel('Nombre y apellidos')).toBeVisible()
  await expectNoBlockingAccessibilityViolations(page, 'checkout-form')

  await page.getByRole('button', { name: /Pagar|Confirmar pedido/ }).click()
  await expect(page.getByRole('alert')).toContainText('Revisa los campos marcados')
  await expectNoBlockingAccessibilityViolations(page, 'checkout-validation-state')
})

test('blocks serious accessibility regressions in the authenticated administration panel', async ({
  page,
  deterministic
}) => {
  test.setTimeout(60_000)
  await provisionAdministrator(page.context().request, deterministic)
  await page.goto('/admin')
  await expect(page).toHaveURL(/\/admin$/)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Hoy')
  await expectNoBlockingAccessibilityViolations(page, 'admin-dashboard')

  await page.goto('/admin/productos')
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  await expectNoBlockingAccessibilityViolations(page, 'admin-list-template')

  await page.goto('/cuenta')
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  await expectNoBlockingAccessibilityViolations(page, 'authenticated-account-template')
})

/**
 * El área de cliente pasó de una ruta a siete y el panel se rehizo pantalla a pantalla; sin
 * cubrirlas aquí, la comprobación automática dejaba de mirar justo donde más cambió la
 * interfaz. La ronda manual que encontró estas rutas detectó cuatro incidencias reales:
 * contraste 1,78:1 en los distintivos de estado, dos controles sin nombre accesible y los
 * puntos del carrusel por debajo del tamaño mínimo de destino táctil de WCAG 2.2.
 */
const ACCOUNT_ROUTES = [
  ['/cuenta', 'account-summary'],
  ['/cuenta/pedidos', 'account-orders'],
  ['/cuenta/direcciones', 'account-addresses'],
  ['/cuenta/datos', 'account-profile'],
  ['/cuenta/seguridad', 'account-security'],
  ['/cuenta/comunicaciones', 'account-communications'],
  ['/cuenta/favoritos', 'account-lists']
] as const

const ADMIN_ROUTES = [
  ['/admin/pedidos', 'admin-orders'],
  ['/admin/categorias', 'admin-families'],
  ['/admin/precios', 'admin-prices'],
  ['/admin/clientes', 'admin-companies'],
  ['/admin/devoluciones', 'admin-returns'],
  ['/admin/medios', 'admin-media'],
  // Un número que no existe: la ficha tiene que seguir teniendo su h1 y su salida.
  ['/admin/pedidos/NE00000000AA', 'admin-order-detail-missing']
] as const

test('blocks serious accessibility regressions across the customer account area', async ({ page, deterministic }) => {
  test.setTimeout(90_000)
  await signInAsCustomer(page.context().request, deterministic)
  for (const [route, surface] of ACCOUNT_ROUTES) {
    await page.goto(route)
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    await expectNoBlockingAccessibilityViolations(page, surface)
  }
})

test('blocks serious accessibility regressions across the rebuilt administration screens', async ({
  page,
  deterministic
}) => {
  test.setTimeout(90_000)
  await provisionAdministrator(page.context().request, deterministic)
  for (const [route, surface] of ADMIN_ROUTES) {
    await page.goto(route)
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    await expectNoBlockingAccessibilityViolations(page, surface)
  }
})

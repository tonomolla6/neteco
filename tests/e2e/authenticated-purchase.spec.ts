import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { APIRequestContext, Page } from '@playwright/test'
import postgres, { type Sql } from 'postgres'
import {
  encodeMerchantParameters,
  signMerchantParameters,
  REDSYS_REDIRECT_URLS
} from '../../server/integrations/redsys'
import { decryptSecret } from '../../server/utils/secrets'
import { expect, test } from '../fixtures/playwright'
import type { DeterministicTestData } from '../fixtures/deterministic'
import { REDSYS_OFFICIAL_CONTRACT } from '../fixtures/redsys-official'

const execFileAsync = promisify(execFile)
const REDSYS_SECRET = REDSYS_OFFICIAL_CONTRACT.sandbox.secretKey
const STOREFRONT_ORIGIN = new URL(
  process.env.PLAYWRIGHT_BASE_URL ?? `http://127.0.0.1:${process.env.PLAYWRIGHT_PORT ?? '3100'}`
).origin

async function databaseQuery<T>(query: (sql: Sql) => Promise<T>) {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 })
  try {
    return await query(sql)
  } finally {
    await sql.end({ timeout: 5 })
  }
}

async function identityToken(email: string, eventType: string) {
  const envelope = await databaseQuery(async (sql) => {
    const [event] = await sql<{ tokenEnvelope: string }[]>`
      SELECT outbox.payload ->> 'tokenEnvelope' AS "tokenEnvelope"
      FROM outbox_events outbox
      JOIN identities identity ON identity.id = outbox.aggregate_id
      WHERE identity.email = ${email} AND outbox.event_type = ${eventType}
      ORDER BY outbox.created_at DESC
      LIMIT 1
    `
    return event?.tokenEnvelope
  })
  expect(envelope).toBeTruthy()
  return decryptSecret(envelope!, process.env.AUTH_ENCRYPTION_KEY!)
}

async function registerAndVerify(page: Page, email: string, password: string) {
  await page.goto('/registro')
  await page.getByLabel('Nombre y apellidos').fill('Cliente E2E autenticado')
  await page.getByLabel('Teléfono').fill('600000000')
  await page.getByLabel('Email', { exact: true }).fill(email)
  await page.getByLabel('Contraseña', { exact: true }).fill(password)
  await page.getByLabel('Repite la contraseña', { exact: true }).fill(password)
  await page.getByRole('checkbox', { name: 'Acepto las condiciones de la cuenta' }).check()
  const registration = page.waitForResponse((response) => response.url().endsWith('/api/auth/register'))
  await page.getByRole('button', { name: 'Crear cuenta' }).click()
  expect((await registration).status()).toBe(201)

  const token = await identityToken(email, 'identity.verification.requested')
  await page.goto(`/verificar-email?token=${encodeURIComponent(token)}`)
  await expect(page.getByRole('heading', { name: 'Email verificado' })).toBeVisible()
  await page.getByRole('link', { name: 'Continuar' }).click()
  await expect(page).toHaveURL(/\/cuenta$/)
}

async function login(page: Page, email: string, password: string) {
  await page.goto('/login')
  await page.getByRole('textbox', { name: 'Email', exact: true }).fill(email)
  await page.getByLabel('Contraseña', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Iniciar sesión' }).click()
}

async function logout(page: Page) {
  await page.goto('/cuenta')
  await page.getByRole('button', { name: 'Cerrar sesión' }).click()
  await expect(page).toHaveURL(`${STOREFRONT_ORIGIN}/`)
}

async function addAddress(page: Page, label: string) {
  await page.goto('/cuenta/direcciones')
  await page
    .getByRole('button', { name: /^Añadir (la primera )?dirección$/ })
    .first()
    .click()
  const dialog = page.getByRole('dialog', { name: 'Añadir dirección' })
  await dialog.getByLabel('Etiqueta').fill(label)
  await dialog.getByLabel('Destinatario').fill('Cliente E2E autenticado')
  await dialog.getByLabel('Teléfono de contacto').fill('600000000')
  await dialog.getByLabel('Dirección', { exact: true }).fill('Calle autenticada 12')
  await dialog.getByLabel('Código postal').fill('46800')
  await dialog.getByLabel('Población').fill('Xàtiva')
  await dialog.getByLabel('Provincia', { exact: true }).fill('Valencia')
  await dialog.getByRole('checkbox', { name: 'Usar como dirección predeterminada' }).check()
  await dialog.getByRole('button', { name: 'Guardar dirección' }).click()
  await expect(page.getByRole('heading', { name: label, exact: true })).toBeVisible()
}

async function fillCheckout(page: Page, email: string) {
  await expect(page.getByLabel('Nombre y apellidos')).toHaveValue('Cliente E2E autenticado')
  await page.getByRole('textbox', { name: /^Email/ }).fill(email)
  await page.getByLabel('Teléfono', { exact: true }).first().fill('600000000')
  await page.getByLabel('Destinatario').fill('Cliente E2E autenticado')
  await page.getByLabel('Teléfono de entrega').fill('600000000')
  await page.getByLabel('Dirección', { exact: true }).fill('Calle autenticada 12')
  await page.getByLabel('Código postal', { exact: true }).fill('46800')
  await page.getByLabel('Población', { exact: true }).fill('Xàtiva')
  await page.getByLabel('Provincia', { exact: true }).fill('Valencia')
  await page.getByRole('radio', { name: /Recogida en almacén/ }).check()
  await page.getByRole('checkbox', { name: /Acepto las condiciones de compra/ }).check()
}

async function addCatalogProduct(page: Page) {
  const response = await page.context().request.get('/api/products?limit=1')
  expect(response.ok()).toBe(true)
  const catalog = (await response.json()) as { items: Array<{ slug: string }> }
  await page.goto(`/producto/${catalog.items[0]!.slug}`)
  await page.getByRole('button', { name: 'Añadir al carrito' }).first().click()
  await expect(page.getByText('Añadido al carrito', { exact: true })).toBeVisible()
}

function signedSuccess(orderId: string, amountCents: number) {
  const merchantParameters = encodeMerchantParameters({
    Ds_Order: orderId,
    Ds_Amount: String(amountCents),
    Ds_Currency: '978',
    Ds_MerchantCode: '999008881',
    Ds_Terminal: '1',
    Ds_TransactionType: '0',
    Ds_Response: '0000',
    Ds_AuthorisationCode: `A${orderId.slice(-5)}`,
    Ds_Date: '13/08/2026',
    Ds_Hour: '12:00'
  })
  return {
    Ds_SignatureVersion: 'HMAC_SHA512_V2',
    Ds_MerchantParameters: merchantParameters,
    Ds_Signature: signMerchantParameters(merchantParameters, REDSYS_SECRET, orderId)
  }
}

async function authenticatedPurchase(page: Page) {
  const sandboxPosts: string[] = []
  await page.route(REDSYS_REDIRECT_URLS.sandbox, async (route) => {
    sandboxPosts.push(route.request().postData() ?? '')
    await route.fulfill({ contentType: 'text/html', body: '<h1>Redsys cuenta simulada</h1>' })
  })
  await addCatalogProduct(page)
  await page.goto('/checkout')
  await fillCheckout(page, await page.getByRole('textbox', { name: /^Email/ }).inputValue())
  const orderCreation = page.waitForResponse(
    (response) => response.url().endsWith('/api/orders') && response.request().method() === 'POST'
  )
  const paymentCreation = page.waitForResponse(
    (response) => response.url().endsWith('/api/checkout/pay') && response.request().method() === 'POST'
  )
  await page.getByRole('button', { name: /^Pagar / }).click()
  const created = await orderCreation
  expect(created.status(), await created.text()).toBe(201)
  const payment = await paymentCreation
  expect(payment.status()).toBe(200)
  await expect(page.getByRole('heading', { name: 'Redsys cuenta simulada' })).toBeVisible()

  const hostedFields = new URLSearchParams(sandboxPosts[0])
  const parameters = JSON.parse(
    Buffer.from(hostedFields.get('Ds_MerchantParameters')!, 'base64url').toString('utf8')
  ) as {
    DS_MERCHANT_ORDER: string
    DS_MERCHANT_AMOUNT: string
  }
  const orderId = parameters.DS_MERCHANT_ORDER
  const amountCents = Number(parameters.DS_MERCHANT_AMOUNT)
  const callback = await page.context().request.post('/api/payments/redsys/notification', {
    data: signedSuccess(orderId, amountCents),
    headers: { origin: STOREFRONT_ORIGIN }
  })
  expect(callback.status()).toBe(200)
  await page.goto(`/pago/retorno?order=${orderId}&payment=returned`)
  await expect(page.getByRole('heading', { name: '¡Gracias por tu pedido!' })).toBeVisible()
  return orderId
}

async function issueInvoice(orderId: string) {
  const internalId = await databaseQuery(async (sql) => {
    const [order] = await sql<{ id: string }[]>`SELECT id FROM orders WHERE public_number = ${orderId}`
    return order?.id
  })
  expect(internalId).toBeTruthy()
  await execFileAsync(
    'node_modules/.bin/tsx',
    ['scripts/invoice-worker.ts', '--once', `--aggregate-id=${internalId}`],
    {
      cwd: process.cwd(),
      env: { ...process.env, INVOICE_PROVIDER: 'mock' }
    }
  )
}

function post(request: APIRequestContext, url: string, data: Record<string, unknown>) {
  return request.post(url, { data, headers: { origin: STOREFRONT_ORIGIN } })
}

test('covers the isolated authenticated account, purchase, invoice and password lifecycle', async ({
  page,
  deterministic
}: {
  page: Page
  deterministic: DeterministicTestData
}) => {
  test.setTimeout(90_000)
  const firstEmail = deterministic.email('account:first')
  const secondEmail = deterministic.email('account:second')
  const firstPassword = 'Neteco-E2E-original-2026'
  const newPassword = 'Neteco-E2E-renovada-2026'
  const secondPassword = 'Neteco-E2E-secondary-2026'
  const addressLabel = 'Oficina autenticada E2E'

  await registerAndVerify(page, firstEmail, firstPassword)
  await logout(page)
  await page.goto('/cuenta')
  await expect(page).toHaveURL(/\/login\?redirect=/)

  await login(page, firstEmail, firstPassword)
  await expect(page).toHaveURL(/\/cuenta$/)
  await addAddress(page, addressLabel)
  const orderId = await authenticatedPurchase(page)
  await issueInvoice(orderId)
  await page.reload()
  await expect(page.getByRole('link', { name: 'Descargar factura' })).toBeVisible()
  const invoice = await page.context().request.get(`/api/orders/${orderId}/invoice`)
  expect(invoice.ok()).toBe(true)
  expect(invoice.headers()['content-type']).toContain('application/pdf')
  expect(
    Buffer.from(await invoice.body())
      .subarray(0, 4)
      .toString('ascii')
  ).toBe('%PDF')

  const staleOrderCookie = (await page.context().cookies()).find((cookie) => cookie.name === 'neteco-order-access')
  expect(staleOrderCookie).toBeTruthy()
  await logout(page)
  await registerAndVerify(page, secondEmail, secondPassword)
  await expect(page.getByText(addressLabel, { exact: true })).toHaveCount(0)
  await expect(page.getByText(orderId, { exact: true })).toHaveCount(0)
  await page.context().addCookies([staleOrderCookie!])
  expect((await page.context().request.get(`/api/orders/${orderId}`)).status()).toBe(404)
  expect((await page.context().request.get(`/api/orders/${orderId}/invoice`)).status()).toBe(404)
  await page.context().clearCookies({ name: 'neteco-order-access' })
  expect((await page.context().request.get('/api/cart')).status()).toBe(200)
  expect(((await (await page.context().request.get('/api/cart')).json()) as { count: number }).count).toBe(0)

  await addCatalogProduct(page)
  await page.goto('/checkout')
  await fillCheckout(page, firstEmail)
  const mismatch = page.waitForResponse(
    (response) => response.url().endsWith('/api/orders') && response.request().method() === 'POST'
  )
  await page.getByRole('button', { name: /^Pagar / }).click()
  // The server rejects the foreign email with 422; the legacy (non-Cloudflare) checkout contract
  // deliberately keeps any failed command "uncertain" instead of interpreting server codes.
  const mismatchResponse = await mismatch
  expect(mismatchResponse.status()).toBe(422)
  expect(await mismatchResponse.text()).toContain('El email del pedido debe coincidir con tu cuenta')
  await expect(page.getByRole('alert')).toContainText('No hemos podido confirmar si se creó el pedido')

  const staleCartCookie = (await page.context().cookies()).find((cookie) => cookie.name === 'neteco-cart')
  expect(staleCartCookie).toBeTruthy()
  await logout(page)
  await page.context().addCookies([staleCartCookie!])
  const staleCart = await page.context().request.get('/api/cart')
  expect(staleCart.status()).toBe(200)
  expect(((await staleCart.json()) as { count: number }).count).toBe(0)
  await page.context().clearCookies({ name: 'neteco-cart' })

  await login(page, firstEmail, firstPassword)
  await expect(page).toHaveURL(/\/cuenta$/)
  await page.goto('/recuperar-clave')
  await page.getByRole('textbox', { name: /^Email/ }).fill(firstEmail)
  const resetRequest = page.waitForResponse((response) => response.url().endsWith('/api/auth/forgot-password'))
  await page.getByRole('button', { name: 'Enviar enlace' }).click()
  expect((await resetRequest).status()).toBe(202)
  await expect(page.getByText('Revisa tu correo')).toBeVisible()

  const resetToken = await identityToken(firstEmail, 'identity.password_reset.requested')
  await page.goto(`/restablecer-clave?token=${encodeURIComponent(resetToken)}`)
  await page.getByLabel('Nueva contraseña', { exact: true }).fill(newPassword)
  await page.getByLabel('Repite la contraseña', { exact: true }).fill(newPassword)
  await page.getByRole('button', { name: 'Guardar contraseña' }).click()
  await expect(page.getByText('Contraseña actualizada')).toBeVisible()
  expect((await page.context().request.get('/api/account')).status()).toBe(401)

  await login(page, firstEmail, firstPassword)
  await expect(page.getByRole('alert')).toContainText('Email o contraseña incorrectos')
  await login(page, firstEmail, newPassword)
  await expect(page).toHaveURL(/\/cuenta$/)
  await expect(page.getByText(orderId, { exact: true })).toBeVisible()

  await logout(page)
  expect((await page.context().request.get('/api/account')).status()).toBe(401)
  expect((await post(page.context().request, '/api/auth/logout', {})).status()).toBe(200)
  await page.goto('/cuenta')
  await expect(page).toHaveURL(/\/login\?redirect=/)
})

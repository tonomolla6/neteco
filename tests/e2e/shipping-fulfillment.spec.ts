import type { Page } from '@playwright/test'
import * as OTPAuth from 'otpauth'
import postgres, { type Sql } from 'postgres'
import {
  encodeMerchantParameters,
  REDSYS_REDIRECT_URLS,
  signMerchantParameters
} from '../../server/integrations/redsys'
import { decryptSecret } from '../../server/utils/secrets'
import { expect, test } from '../fixtures/playwright'
import type { DeterministicTestData } from '../fixtures/deterministic'

const REDSYS_SECRET = 'sq7HjrUOBfKmC576ILgskD5srU870gJ7'
const STOREFRONT_ORIGIN = new URL(
  process.env.PLAYWRIGHT_BASE_URL ?? `http://127.0.0.1:${process.env.PLAYWRIGHT_PORT ?? '3100'}`
).origin

async function databaseQuery<T>(query: (sql: Sql) => Promise<T>) {
  const sql = postgres(process.env.DATABASE_URL ?? 'postgres://neteco:neteco-local@localhost:56432/neteco', { max: 2 })
  try {
    return await query(sql)
  } finally {
    await sql.end({ timeout: 5 })
  }
}

async function identityToken(email: string) {
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
  return decryptSecret(envelope!, process.env.AUTH_ENCRYPTION_KEY ?? 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=')
}

async function registerAndVerify(page: Page, email: string, password: string) {
  await page.goto('/registro')
  await page.getByRole('dialog').getByRole('button', { name: 'Rechazar opcionales' }).click()
  await page.getByLabel('Nombre y apellidos').fill('Logística E2E')
  await page.getByLabel('Teléfono').fill('600000002')
  await page.getByLabel('Email', { exact: true }).fill(email)
  await page.getByLabel('Contraseña', { exact: true }).fill(password)
  await page.getByLabel('Repite la contraseña').fill(password)
  await page.getByRole('checkbox', { name: 'Acepto las condiciones de la cuenta' }).check()
  const registration = page.waitForResponse(
    (response) => response.url().endsWith('/api/auth/register') && response.request().method() === 'POST'
  )
  await page.getByRole('button', { name: 'Crear cuenta' }).click()
  expect((await registration).status()).toBe(201)
  await page.goto(`/verificar-email?token=${encodeURIComponent(await identityToken(email))}`)
  await expect(page.getByRole('heading', { name: 'Email verificado' })).toBeVisible()
  await page.getByRole('link', { name: 'Continuar' }).click()
  await expect(page).toHaveURL(/\/cuenta$/)
}

async function addCatalogProduct(page: Page) {
  const response = await page.context().request.get('/api/products?limit=1')
  expect(response.ok(), await response.text()).toBe(true)
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
    Ds_AuthorisationCode: `S${orderId.slice(-5)}`,
    Ds_Date: '13/08/2026',
    Ds_Hour: '12:00'
  })
  return {
    Ds_SignatureVersion: 'HMAC_SHA512_V2',
    Ds_MerchantParameters: merchantParameters,
    Ds_Signature: signMerchantParameters(merchantParameters, REDSYS_SECRET, orderId)
  }
}

type ShippingMethod = 'reparto' | 'envio' | 'recogida'

const delivery = {
  reparto: { postalCode: '46800', city: 'Xàtiva', radio: /Reparto propio NETECO/, profile: 'own_delivery' },
  envio: { postalCode: '28001', city: 'Madrid', radio: /Envío por agencia/, profile: 'parcel' },
  recogida: { postalCode: '46800', city: 'Xàtiva', radio: /Recogida en almacén/, profile: 'pickup' }
} as const

async function purchase(page: Page, email: string, method: ShippingMethod, hostedPaymentBodies: string[]) {
  await addCatalogProduct(page)
  await page.goto('/checkout')
  await page.getByLabel('Nombre y apellidos').fill('Logística E2E')
  await page.getByRole('textbox', { name: /^Email/ }).fill(email)
  await page.getByLabel('Teléfono', { exact: true }).first().fill('600000002')
  await page.getByLabel('Destinatario').fill('Logística E2E')
  await page.getByLabel('Teléfono de entrega').fill('600000002')
  await page.getByLabel('Dirección', { exact: true }).fill('Calle de la Entrega 14')
  const rateResponse = page.waitForResponse(
    (response) => response.url().endsWith('/api/shipping/rates') && response.request().method() === 'POST'
  )
  await page.getByLabel('Código postal', { exact: true }).fill(delivery[method].postalCode)
  await page.getByLabel('Población', { exact: true }).fill(delivery[method].city)
  await page.getByLabel('Provincia', { exact: true }).fill(method === 'envio' ? 'Madrid' : 'Valencia')
  const ratesHttp = await rateResponse
  expect(ratesHttp.status(), await ratesHttp.text()).toBe(200)
  const quote = (await ratesHttp.json()) as {
    rates: Array<{
      serviceCode: string
      profile: string
      netCents: number
      estimatedDeliveryFrom: string
      estimatedDeliveryTo: string
    }>
  }
  const rate = quote.rates.find((candidate) => candidate.profile === delivery[method].profile)
  expect(rate).toBeTruthy()
  if (method === 'envio') expect(quote.rates.some((candidate) => candidate.profile === 'own_delivery')).toBe(false)
  expect(Date.parse(rate!.estimatedDeliveryTo)).toBeGreaterThanOrEqual(Date.parse(rate!.estimatedDeliveryFrom))
  expect(rate!.netCents === 0).toBe(method !== 'envio')

  const radio = page.getByRole('radio', { name: delivery[method].radio })
  await expect(radio).toBeVisible()
  await expect(radio.locator('xpath=ancestor::label')).toContainText(/antes del|Gratis/)
  await radio.check()
  await page.getByRole('checkbox', { name: /Acepto las condiciones de compra/ }).check()
  const orderCreation = page.waitForResponse(
    (response) => response.url().endsWith('/api/orders') && response.request().method() === 'POST'
  )
  const paymentCreation = page.waitForResponse(
    (response) => response.url().endsWith('/api/checkout/pay') && response.request().method() === 'POST'
  )
  await page.getByRole('button', { name: /^Pagar / }).click()
  const orderHttp = await orderCreation
  expect(orderHttp.status(), await orderHttp.text()).toBe(201)
  const paymentHttp = await paymentCreation
  expect(paymentHttp.status()).toBe(200)
  await expect(page.getByRole('heading', { name: 'Redsys logística simulada' })).toBeVisible()

  const hostedFields = new URLSearchParams(hostedPaymentBodies.shift())
  const parameters = JSON.parse(
    Buffer.from(hostedFields.get('Ds_MerchantParameters')!, 'base64url').toString('utf8')
  ) as { DS_MERCHANT_ORDER: string; DS_MERCHANT_AMOUNT: string }
  const callback = await page.context().request.post('/api/payments/redsys/notification', {
    data: signedSuccess(parameters.DS_MERCHANT_ORDER, Number(parameters.DS_MERCHANT_AMOUNT)),
    headers: { origin: STOREFRONT_ORIGIN }
  })
  expect(callback.status(), await callback.text()).toBe(200)
  await page.goto(`/pago/retorno?order=${parameters.DS_MERCHANT_ORDER}&payment=returned`)
  await expect(page.getByRole('heading', { name: '¡Gracias por tu pedido!' })).toBeVisible()
  return { id: parameters.DS_MERCHANT_ORDER, rate: rate! }
}

async function makeAdministrator(page: Page, email: string) {
  await page.goto('/cuenta')
  const setup = page.waitForResponse(
    (response) => response.url().endsWith('/api/auth/mfa/setup') && response.request().method() === 'POST'
  )
  await page.getByRole('button', { name: 'Activar MFA' }).click()
  const setupHttp = await setup
  expect(setupHttp.status(), await setupHttp.text()).toBe(200)
  const enrollment = (await setupHttp.json()) as { manualKey: string; recoveryCodes: string[] }
  const totp = new OTPAuth.TOTP({
    issuer: 'NETECO',
    label: email,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(enrollment.manualKey)
  })
  await page.getByPlaceholder('Código de 6 cifras').fill(totp.generate())
  await page.getByRole('button', { name: 'Confirmar', exact: true }).click()
  await expect(page.getByText('Autenticación multifactor activada.')).toBeVisible()
  await databaseQuery(async (sql) => {
    const [identity] = await sql<{ id: string }[]>`SELECT id FROM identities WHERE email = ${email}`
    expect(identity).toBeTruthy()
    await sql`
      INSERT INTO identity_roles (identity_id, role_code) VALUES (${identity!.id}, 'admin')
      ON CONFLICT (identity_id, role_code) DO NOTHING
    `
  })
  await page.getByRole('button', { name: 'Cerrar sesión' }).click()
  await expect(page).toHaveURL(`${STOREFRONT_ORIGIN}/`)
  await page.goto('/login?redirect=/admin/pedidos')
  await page.getByRole('textbox', { name: 'Email', exact: true }).fill(email)
  await page.getByLabel('Contraseña', { exact: true }).fill('Neteco-Logistica-E2E-2026')
  await page.getByRole('button', { name: 'Iniciar sesión' }).click()
  await page.getByLabel('Código de autenticación').fill(enrollment.recoveryCodes[0]!)
  await page.getByRole('button', { name: 'Confirmar código' }).click()
  await expect(page).toHaveURL(/\/admin\/pedidos$/)
  await expect(page.getByRole('heading', { name: 'Pedidos' })).toBeVisible()
}

function adminPost(page: Page, url: string, data: Record<string, unknown>) {
  return page.context().request.post(url, { data, headers: { origin: STOREFRONT_ORIGIN } })
}

async function transitionOrder(page: Page, orderId: string, status: string, reason: string) {
  const row = page.getByRole('row').filter({ hasText: orderId })
  page.once('dialog', (dialog) => dialog.accept(reason))
  const response = page.waitForResponse(
    (candidate) => candidate.url().endsWith(`/api/admin/orders/${orderId}`) && candidate.request().method() === 'PUT'
  )
  await row.getByLabel(`Estado del pedido ${orderId}`).selectOption(status)
  const http = await response
  expect(http.status(), await http.text()).toBe(200)
  await expect.poll(async () => row.getByLabel(`Estado del pedido ${orderId}`).inputValue()).toBe(status)
}

test.describe.configure({ mode: 'serial' })

test('covers own delivery, carrier and warehouse pickup fulfillment end to end', async ({
  page,
  deterministic
}: {
  page: Page
  deterministic: DeterministicTestData
}) => {
  test.setTimeout(150_000)
  const email = deterministic.email('shipping-administrator')
  const password = 'Neteco-Logistica-E2E-2026'
  const hostedPaymentBodies: string[] = []
  await page.route(REDSYS_REDIRECT_URLS.sandbox, async (route) => {
    hostedPaymentBodies.push(route.request().postData() ?? '')
    await route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: '<h1>Redsys logística simulada</h1>'
    })
  })

  await registerAndVerify(page, email, password)
  const own = await purchase(page, email, 'reparto', hostedPaymentBodies)
  const carrier = await purchase(page, email, 'envio', hostedPaymentBodies)
  const pickup = await purchase(page, email, 'recogida', hostedPaymentBodies)

  const checkoutEvidence = await databaseQuery(
    async (sql) =>
      sql<
        Array<{
          publicNumber: string
          shippingMethod: string
          shippingNetCents: number
          profile: string
          serviceCode: string
          etaFrom: string
          etaTo: string
        }>
      >`
      SELECT public_number AS "publicNumber", shipping_method AS "shippingMethod",
             shipping_net_cents AS "shippingNetCents", shipping_snapshot ->> 'shippingProfile' AS profile,
             shipping_snapshot ->> 'serviceCode' AS "serviceCode",
             shipping_snapshot ->> 'estimatedDeliveryFrom' AS "etaFrom",
             shipping_snapshot ->> 'estimatedDeliveryTo' AS "etaTo"
      FROM orders WHERE public_number IN (${own.id}, ${carrier.id}, ${pickup.id})
    `
  )
  expect(checkoutEvidence).toHaveLength(3)
  expect(checkoutEvidence).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ publicNumber: own.id, shippingMethod: 'reparto', profile: 'own_delivery' }),
      expect.objectContaining({ publicNumber: carrier.id, shippingMethod: 'envio', profile: 'parcel' }),
      expect.objectContaining({ publicNumber: pickup.id, shippingMethod: 'recogida', profile: 'pickup' })
    ])
  )

  await makeAdministrator(page, email)

  const incompatible = await adminPost(page, `/api/admin/orders/${own.id}/shipment`, {
    serviceCode: 'STANDARD-PARCEL'
  })
  expect(incompatible.status()).toBe(422)
  expect(await incompatible.text()).toContain('no corresponde al método')

  const ownCreations = await Promise.all([
    adminPost(page, `/api/admin/orders/${own.id}/shipment`, { serviceCode: 'OWN-DAY' }),
    adminPost(page, `/api/admin/orders/${own.id}/shipment`, { serviceCode: 'OWN-DAY' })
  ])
  expect(ownCreations.map((response) => response.status())).toEqual([200, 200])
  const ownCreationBodies = await Promise.all(
    ownCreations.map((response) => response.json() as Promise<{ duplicate: boolean }>)
  )
  expect(ownCreationBodies.filter((result) => result.duplicate)).toHaveLength(1)

  await page.reload()
  const carrierRow = page.getByRole('row').filter({ hasText: carrier.id })
  page.once('dialog', (dialog) => dialog.accept('STANDARD-PARCEL'))
  const creation = page.waitForResponse((response) =>
    response.url().endsWith(`/api/admin/orders/${carrier.id}/shipment`)
  )
  await carrierRow.getByRole('button', { name: 'Crear' }).click()
  const creationHttp = await creation
  expect(creationHttp.status(), await creationHttp.text()).toBe(200)
  const created = (await creationHttp.json()) as { id: string; trackingNumber: string; duplicate: boolean }
  expect(created.duplicate).toBe(false)
  await expect(carrierRow.getByText(created.trackingNumber, { exact: true })).toBeVisible()

  const label = await page.context().request.get(`/api/admin/shipments/${created.id}/label`)
  expect(label.status()).toBe(200)
  expect(label.headers()['content-type']).toContain('application/pdf')
  expect((await label.body()).subarray(0, 8).toString()).toBe('%PDF-1.4')

  const firstTracking = page.waitForResponse((response) =>
    response.url().endsWith(`/api/admin/shipments/${created.id}/tracking`)
  )
  await carrierRow.getByRole('button', { name: 'Sincronizar tracking' }).click()
  expect((await firstTracking).status()).toBe(200)
  await expect
    .poll(() =>
      databaseQuery(async (sql) => {
        const [shipment] = await sql<{ status: string; fulfillmentStatus: string }[]>`
          SELECT shipment.status, fulfillment.status AS "fulfillmentStatus"
          FROM shipments shipment JOIN fulfillments fulfillment ON fulfillment.id = shipment.fulfillment_id
          WHERE shipment.id = ${created.id}
        `
        return shipment
      })
    )
    .toEqual({ status: 'exception', fulfillmentStatus: 'exception' })

  const secondTracking = page.waitForResponse((response) =>
    response.url().endsWith(`/api/admin/shipments/${created.id}/tracking`)
  )
  await carrierRow.getByRole('button', { name: 'Sincronizar tracking' }).click()
  expect((await secondTracking).status()).toBe(200)
  const delivered = await databaseQuery(async (sql) => {
    const [state] = await sql<
      Array<{ shipmentStatus: string; fulfillmentStatus: string; orderStatus: string; deliveredAt: Date | null }>
    >`
      SELECT shipment.status AS "shipmentStatus", fulfillment.status AS "fulfillmentStatus",
             orders.order_status AS "orderStatus", orders.delivered_at AS "deliveredAt"
      FROM shipments shipment
      JOIN fulfillments fulfillment ON fulfillment.id = shipment.fulfillment_id
      JOIN orders ON orders.id = fulfillment.order_id
      WHERE shipment.id = ${created.id}
    `
    return state
  })
  expect(delivered).toMatchObject({
    shipmentStatus: 'delivered',
    fulfillmentStatus: 'delivered',
    orderStatus: 'completed'
  })
  expect(delivered!.deliveredAt).toBeTruthy()
  const deliveredCancellation = await adminPost(page, `/api/admin/shipments/${created.id}/cancel`, {
    reason: 'No se debe cancelar una entrega completada'
  })
  expect(deliveredCancellation.status()).toBe(409)

  await page.reload()
  const ownRow = page.getByRole('row').filter({ hasText: own.id })
  page.once('dialog', (dialog) => dialog.accept('Cancelación logística E2E'))
  const cancellation = page.waitForResponse(
    (response) => response.url().includes('/api/admin/shipments/') && response.url().endsWith('/cancel')
  )
  await ownRow.getByRole('button', { name: `Cancelar expedición ${own.id}` }).click()
  const cancellationHttp = await cancellation
  expect(cancellationHttp.status(), await cancellationHttp.text()).toBe(200)
  const cancelled = (await cancellationHttp.json()) as { id: string; duplicate: boolean }
  expect(cancelled.duplicate).toBe(false)
  const cancellationReplay = await adminPost(page, `/api/admin/shipments/${cancelled.id}/cancel`, {
    reason: 'Repetición de cancelación E2E'
  })
  expect(cancellationReplay.status()).toBe(200)
  expect(await cancellationReplay.json()).toMatchObject({ status: 'cancelled', duplicate: true })

  const pickupShipment = await adminPost(page, `/api/admin/orders/${pickup.id}/shipment`, {
    serviceCode: 'WAREHOUSE-PICKUP'
  })
  expect(pickupShipment.status()).toBe(409)
  await page.reload()
  await transitionOrder(page, pickup.id, 'preparando', 'Preparación de recogida E2E')
  await transitionOrder(page, pickup.id, 'listo_recogida', 'Pedido listo para recogida E2E')
  await transitionOrder(page, pickup.id, 'entregado', 'Identidad comprobada en almacén')

  const finalEvidence = await databaseQuery(async (sql) => {
    const [pickupState] = await sql<
      Array<{ orderStatus: string; orderFulfillment: string; fulfillmentStatus: string; shipmentCount: number }>
    >`
      SELECT orders.order_status AS "orderStatus", orders.fulfillment_status AS "orderFulfillment",
             fulfillment.status AS "fulfillmentStatus", count(shipment.id)::int AS "shipmentCount"
      FROM orders
      JOIN fulfillments fulfillment ON fulfillment.order_id = orders.id
      LEFT JOIN shipments shipment ON shipment.fulfillment_id = fulfillment.id
      WHERE orders.public_number = ${pickup.id}
      GROUP BY orders.id, fulfillment.id
    `
    const readyNotifications = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM outbox_events outbox
      JOIN orders ON orders.id = outbox.aggregate_id
      WHERE orders.public_number = ${pickup.id}
        AND outbox.event_type = 'order.status.updated'
        AND outbox.payload ->> 'statusLabel' = 'listo para recoger'
    `
    const [ownCancellation] = await sql<{ shipmentStatus: string; eventCount: number }[]>`
      SELECT shipment.status AS "shipmentStatus",
             count(events.id) FILTER (WHERE events.event_type = 'shipment.cancelled')::int AS "eventCount"
      FROM orders
      JOIN fulfillments fulfillment ON fulfillment.order_id = orders.id
      JOIN shipments shipment ON shipment.fulfillment_id = fulfillment.id
      LEFT JOIN order_events events ON events.order_id = orders.id
      WHERE orders.public_number = ${own.id}
      GROUP BY shipment.id
    `
    return { pickupState, readyNotifications: readyNotifications[0]?.count, ownCancellation }
  })
  expect(finalEvidence.pickupState).toEqual({
    orderStatus: 'completed',
    orderFulfillment: 'delivered',
    fulfillmentStatus: 'delivered',
    shipmentCount: 0
  })
  expect(finalEvidence.readyNotifications).toBe(1)
  expect(finalEvidence.ownCancellation).toEqual({ shipmentStatus: 'cancelled', eventCount: 1 })
})

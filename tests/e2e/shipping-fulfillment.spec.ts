import type { Dialog, Page } from '@playwright/test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
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
const execFileAsync = promisify(execFile)
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

async function addCatalogProduct(page: Page, quantity = 1) {
  const response = await page.context().request.get('/api/products?limit=1')
  expect(response.ok(), await response.text()).toBe(true)
  const catalog = (await response.json()) as { items: Array<{ slug: string }> }
  await page.goto(`/producto/${catalog.items[0]!.slug}`)
  while (Number(await page.getByRole('status', { name: 'Cantidad' }).textContent()) < quantity) {
    await page.getByRole('button', { name: 'Más unidades' }).click()
  }
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

async function purchase(
  page: Page,
  email: string,
  method: ShippingMethod,
  hostedPaymentBodies: string[],
  options: { capture?: boolean; quantity?: number } = {}
) {
  await addCatalogProduct(page, options.quantity)
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
  if (options.capture === false) {
    return {
      id: parameters.DS_MERCHANT_ORDER,
      amountCents: Number(parameters.DS_MERCHANT_AMOUNT),
      rate: rate!
    }
  }
  const callback = await page.context().request.post('/api/payments/redsys/notification', {
    data: signedSuccess(parameters.DS_MERCHANT_ORDER, Number(parameters.DS_MERCHANT_AMOUNT)),
    headers: { origin: STOREFRONT_ORIGIN }
  })
  expect(callback.status(), await callback.text()).toBe(200)
  await page.goto(`/pago/retorno?order=${parameters.DS_MERCHANT_ORDER}&payment=returned`)
  await expect(page.getByRole('heading', { name: '¡Gracias por tu pedido!' })).toBeVisible()
  return { id: parameters.DS_MERCHANT_ORDER, amountCents: Number(parameters.DS_MERCHANT_AMOUNT), rate: rate! }
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

function adminPut(page: Page, url: string, data: Record<string, unknown>) {
  return page.context().request.put(url, { data, headers: { origin: STOREFRONT_ORIGIN } })
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
  return http.json()
}

async function cancelOrderFromPanel(page: Page, orderId: string, reason: string) {
  const row = page.getByRole('row').filter({ hasText: orderId })
  page.once('dialog', (dialog) => dialog.accept(reason))
  const response = page.waitForResponse(
    (candidate) => candidate.url().endsWith(`/api/admin/orders/${orderId}`) && candidate.request().method() === 'PUT'
  )
  await row.getByLabel(`Estado del pedido ${orderId}`).selectOption('cancelado')
  const http = await response
  expect(http.status(), await http.text()).toBe(200)
  return http.json() as Promise<{
    id: string
    orderStatus: string
    refundId?: string | null
    duplicate: boolean
  }>
}

async function runWorker(script: string, aggregateId: string) {
  await execFileAsync('node_modules/.bin/tsx', [script, `--aggregate-id=${aggregateId}`], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      APP_ENV: 'test',
      APP_BASE_URL: STOREFRONT_ORIGIN,
      AUTH_ENCRYPTION_KEY: process.env.AUTH_ENCRYPTION_KEY ?? 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      PAYMENT_PROVIDER: 'mock',
      INVOICE_PROVIDER: 'mock',
      EMAIL_PROVIDER: 'log',
      MARKETING_EMAIL_PROVIDER: 'log'
    }
  })
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

test('reconciles cancellation, return and refund lifecycles before and after capture and shipment', async ({
  page,
  deterministic
}: {
  page: Page
  deterministic: DeterministicTestData
}) => {
  test.setTimeout(240_000)
  const email = deterministic.email('returns-administrator')
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
  const beforeCapture = await purchase(page, email, 'recogida', hostedPaymentBodies, { capture: false })
  const capturedBeforeShipment = await purchase(page, email, 'recogida', hostedPaymentBodies)
  const deliveredPartial = await purchase(page, email, 'envio', hostedPaymentBodies, { quantity: 2 })

  const orderEvidence = await databaseQuery(async (sql) => {
    const rows = await sql<
      Array<{
        publicNumber: string
        internalId: string
        orderLineId: string
        variantId: string
        locationId: string
        lineQuantity: number
        lineGrossCents: number
        physical: number
      }>
    >`
      SELECT orders.public_number AS "publicNumber", orders.id AS "internalId",
             line.id AS "orderLineId", line.variant_id AS "variantId",
             reservation.location_id AS "locationId", line.quantity AS "lineQuantity",
             line.total_gross_cents AS "lineGrossCents", balance.physical_quantity::int AS physical
      FROM orders
      JOIN order_lines line ON line.order_id = orders.id
      JOIN inventory_reservations reservation ON reservation.order_id = orders.id
        AND reservation.variant_id = line.variant_id
      JOIN inventory_balances balance ON balance.variant_id = line.variant_id
        AND balance.location_id = reservation.location_id
      WHERE orders.public_number IN (${beforeCapture.id}, ${capturedBeforeShipment.id}, ${deliveredPartial.id})
      ORDER BY orders.public_number
    `
    return new Map(rows.map((row) => [row.publicNumber, row]))
  })
  const unpaidRecord = orderEvidence.get(beforeCapture.id)!
  const fullRecord = orderEvidence.get(capturedBeforeShipment.id)!
  const partialRecord = orderEvidence.get(deliveredPartial.id)!
  expect(partialRecord.lineQuantity).toBe(2)
  const physicalAfterCaptures = partialRecord.physical
  const partialRefundCents = Math.floor(partialRecord.lineGrossCents / partialRecord.lineQuantity)

  await runWorker('scripts/invoice-worker.ts', fullRecord.internalId)
  await runWorker('scripts/invoice-worker.ts', partialRecord.internalId)
  await makeAdministrator(page, email)

  const unpaidCancellation = await cancelOrderFromPanel(page, beforeCapture.id, 'Cancelación E2E antes de captura')
  expect(unpaidCancellation).toMatchObject({ orderStatus: 'cancelled', duplicate: false })
  const unpaidReplay = await adminPut(page, `/api/admin/orders/${beforeCapture.id}`, {
    status: 'cancelado',
    reason: 'Repetición antes de captura'
  })
  expect(unpaidReplay.status(), await unpaidReplay.text()).toBe(200)
  expect(await unpaidReplay.json()).toMatchObject({ orderStatus: 'cancelled', duplicate: true })

  await page.reload()
  const fullCancellation = await cancelOrderFromPanel(
    page,
    capturedBeforeShipment.id,
    'Cancelación E2E después de captura y antes de envío'
  )
  expect(fullCancellation).toMatchObject({ orderStatus: 'on_hold', duplicate: false })
  expect(fullCancellation.refundId).toMatch(/^[0-9a-f-]{36}$/)
  const fullReplay = await adminPut(page, `/api/admin/orders/${capturedBeforeShipment.id}`, {
    status: 'cancelado',
    reason: 'Repetición después de captura'
  })
  expect(fullReplay.status(), await fullReplay.text()).toBe(200)
  expect(await fullReplay.json()).toMatchObject({ refundId: fullCancellation.refundId, duplicate: true })

  await runWorker('scripts/refund-worker.ts', fullCancellation.refundId!)
  await runWorker('scripts/credit-note-worker.ts', fullCancellation.refundId!)
  await runWorker('scripts/outbox-worker.ts', unpaidRecord.internalId)
  await runWorker('scripts/outbox-worker.ts', fullRecord.internalId)
  await runWorker('scripts/outbox-worker.ts', fullCancellation.refundId!)

  const stockAfterFullCancellation = await databaseQuery(async (sql) => {
    const [state] = await sql<Array<{ physical: number; reservationStatus: string; restockMovements: number }>>`
      SELECT balance.physical_quantity::int AS physical, reservation.status AS "reservationStatus",
             (SELECT count(*) FROM inventory_movements movement
              WHERE movement.reference_type = 'order' AND movement.reference_id = ${fullRecord.internalId}
                AND movement.movement_type = 'return')::int AS "restockMovements"
      FROM inventory_balances balance
      JOIN inventory_reservations reservation ON reservation.variant_id = balance.variant_id
        AND reservation.location_id = balance.location_id
      WHERE reservation.order_id = ${fullRecord.internalId}
    `
    return state!
  })
  expect(stockAfterFullCancellation).toEqual({
    physical: physicalAfterCaptures + 1,
    reservationStatus: 'released',
    restockMovements: 1
  })

  const shipmentResponse = await adminPost(page, `/api/admin/orders/${deliveredPartial.id}/shipment`, {
    serviceCode: 'STANDARD-PARCEL'
  })
  expect(shipmentResponse.status(), await shipmentResponse.text()).toBe(200)
  const shipment = (await shipmentResponse.json()) as { id: string; duplicate: boolean }
  expect(shipment.duplicate).toBe(false)

  const shippedCancellation = await adminPut(page, `/api/admin/orders/${deliveredPartial.id}`, {
    status: 'cancelado',
    reason: 'Intento de cancelar después del envío'
  })
  expect(shippedCancellation.status()).toBe(409)
  expect(await shippedCancellation.text()).toContain('devolución')
  const prematureReturn = await page.context().request.post(`/api/orders/${deliveredPartial.id}/returns`, {
    data: {
      reason: 'Intento antes de que conste la entrega',
      lines: [{ orderLineId: partialRecord.orderLineId, quantity: 1 }],
      idempotencyKey: deterministic.uuid('premature-return')
    },
    headers: { origin: STOREFRONT_ORIGIN }
  })
  expect(prematureReturn.status()).toBe(409)
  expect(await prematureReturn.text()).toContain('después de la entrega')

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const tracking = await adminPost(page, `/api/admin/shipments/${shipment.id}/tracking`, {})
    expect(tracking.status(), await tracking.text()).toBe(200)
  }
  await expect
    .poll(() =>
      databaseQuery(async (sql) => {
        const [order] = await sql<{ fulfillmentStatus: string }[]>`
          SELECT fulfillment_status AS "fulfillmentStatus" FROM orders
          WHERE id = ${partialRecord.internalId}
        `
        return order?.fulfillmentStatus
      })
    )
    .toBe('delivered')

  await page.goto(`/devoluciones?pedido=${encodeURIComponent(deliveredPartial.id)}`)
  await page.getByLabel(/^Cantidad a devolver de /).fill('1')
  await page.getByLabel('Motivo').fill('Devolución parcial E2E tras entrega')
  const returnCreation = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/orders/${deliveredPartial.id}/returns`) && response.request().method() === 'POST'
  )
  await page.getByRole('button', { name: 'Enviar solicitud' }).click()
  const returnHttp = await returnCreation
  expect(returnHttp.status(), await returnHttp.text()).toBe(201)
  const returned = (await returnHttp.json()) as { id: string; status: string; duplicate: boolean }
  expect(returned).toMatchObject({ status: 'requested', duplicate: false })
  await expect(page.getByText(`Referencia ${returned.id}.`, { exact: false })).toBeVisible()
  const internalReturnId = await databaseQuery(async (sql) => {
    const [record] = await sql<{ id: string }[]>`SELECT id FROM returns WHERE public_number = ${returned.id}`
    return record!.id
  })
  const submittedReturn = returnHttp.request().postDataJSON() as {
    reason: string
    lines: Array<{ orderLineId: string; quantity: number }>
    idempotencyKey: string
  }
  const returnReplay = await page.context().request.post(`/api/orders/${deliveredPartial.id}/returns`, {
    data: submittedReturn,
    headers: { origin: STOREFRONT_ORIGIN }
  })
  expect(returnReplay.status(), await returnReplay.text()).toBe(200)
  expect(await returnReplay.json()).toMatchObject({ id: returned.id, duplicate: true })

  for (const status of ['approved', 'in_transit', 'received', 'inspected']) {
    const transition = await adminPut(page, `/api/admin/returns/${returned.id}`, {
      status,
      reason: `Transición ${status} E2E`
    })
    expect(transition.status(), await transition.text()).toBe(200)
  }
  const excessiveRefund = await adminPut(page, `/api/admin/returns/${returned.id}`, {
    status: 'resolved',
    reason: 'Importe excesivo E2E',
    resolution: 'Producto aceptado',
    refundAmountCents: partialRefundCents + 1
  })
  expect(excessiveRefund.status()).toBe(422)
  expect(await excessiveRefund.text()).toContain('valor de las líneas')

  await page.goto('/admin/devoluciones')
  const returnRow = page.getByRole('row').filter({ hasText: returned.id })
  const promptAnswers = [
    'resolved',
    'Resolución parcial conciliada E2E',
    'Unidad inspeccionada y aceptada',
    (partialRefundCents / 100).toFixed(2).replace('.', ',')
  ]
  const dialogHandler = (dialog: Dialog) => dialog.accept(promptAnswers.shift() ?? '')
  page.on('dialog', dialogHandler)
  const resolutionResponse = page.waitForResponse(
    (response) => response.url().endsWith(`/api/admin/returns/${returned.id}`) && response.request().method() === 'PUT'
  )
  await returnRow.getByRole('button', { name: 'Cambiar estado' }).click()
  const resolutionHttp = await resolutionResponse
  page.off('dialog', dialogHandler)
  expect(resolutionHttp.status(), await resolutionHttp.text()).toBe(200)
  const resolution = (await resolutionHttp.json()) as { refundId: string; duplicate: boolean }
  expect(resolution.refundId).toMatch(/^[0-9a-f-]{36}$/)
  expect(resolution.duplicate).toBe(false)

  await runWorker('scripts/refund-worker.ts', resolution.refundId)
  await runWorker('scripts/credit-note-worker.ts', resolution.refundId)
  await runWorker('scripts/outbox-worker.ts', internalReturnId)
  await runWorker('scripts/outbox-worker.ts', resolution.refundId)
  await databaseQuery(
    (sql) => sql`
    UPDATE outbox_events
    SET status = 'pending', available_at = now(), completed_at = NULL,
        locked_at = NULL, locked_by = NULL
    WHERE aggregate_id = ${resolution.refundId}
      AND event_type IN ('refund.execute.requested', 'invoice.credit.requested')
  `
  )
  await Promise.all([
    runWorker('scripts/refund-worker.ts', resolution.refundId),
    runWorker('scripts/refund-worker.ts', resolution.refundId)
  ])
  await Promise.all([
    runWorker('scripts/credit-note-worker.ts', resolution.refundId),
    runWorker('scripts/credit-note-worker.ts', resolution.refundId)
  ])

  const reconciled = await databaseQuery(async (sql) => {
    const [unpaid] = await sql<
      Array<{ orderStatus: string; paymentStatus: string; inventoryStatus: string; refunds: number }>
    >`
      SELECT orders.order_status AS "orderStatus", orders.payment_status AS "paymentStatus",
             orders.inventory_status AS "inventoryStatus",
             (SELECT count(*) FROM refunds WHERE order_id = orders.id)::int AS refunds
      FROM orders WHERE orders.id = ${unpaidRecord.internalId}
    `
    const [full] = await sql<
      Array<{
        orderStatus: string
        paymentStatus: string
        refundAmount: number
        refundEvents: number
        creditAmount: number
        sourceInvoice: string | null
        creditChecksum: string | null
      }>
    >`
      SELECT orders.order_status AS "orderStatus", orders.payment_status AS "paymentStatus",
             refund.amount_cents AS "refundAmount",
             (SELECT count(*) FROM payment_events event
              WHERE event.payment_intent_id = refund.payment_intent_id
                AND event.event_type = 'refund.succeeded')::int AS "refundEvents",
             credit.amount_cents AS "creditAmount", credit.source_invoice_id AS "sourceInvoice",
             credit.pdf_checksum AS "creditChecksum"
      FROM orders
      JOIN refunds refund ON refund.order_id = orders.id
      JOIN invoices credit ON credit.refund_id = refund.id AND credit.kind = 'credit_note'
      WHERE orders.id = ${fullRecord.internalId}
    `
    const [partial] = await sql<
      Array<{
        orderStatus: string
        paymentStatus: string
        inventoryStatus: string
        fulfillmentStatus: string
        returnStatus: string
        refundAmount: number
        refundLineQuantity: number
        refundLineGross: number
        refundEvents: number
        returnMovements: number
        creditAmount: number
        creditDocuments: number
        sourceInvoice: string | null
        physical: number
      }>
    >`
      SELECT orders.order_status AS "orderStatus", orders.payment_status AS "paymentStatus",
             orders.inventory_status AS "inventoryStatus", orders.fulfillment_status AS "fulfillmentStatus",
             return_record.status AS "returnStatus", refund.amount_cents AS "refundAmount",
             refund_line.quantity AS "refundLineQuantity", refund_line.gross_cents AS "refundLineGross",
             (SELECT count(*) FROM payment_events event
              WHERE event.payment_intent_id = refund.payment_intent_id
                AND event.event_type = 'refund.succeeded')::int AS "refundEvents",
             (SELECT count(*) FROM inventory_movements movement
              WHERE movement.reference_type = 'return' AND movement.reference_id = return_record.id)::int
               AS "returnMovements",
             credit.amount_cents AS "creditAmount", credit.source_invoice_id AS "sourceInvoice",
             (SELECT count(*) FROM invoices document WHERE document.refund_id = refund.id)::int
               AS "creditDocuments",
             balance.physical_quantity::int AS physical
      FROM orders
      JOIN returns return_record ON return_record.order_id = orders.id
      JOIN refunds refund ON refund.return_id = return_record.id
      JOIN refund_lines refund_line ON refund_line.refund_id = refund.id
      JOIN invoices credit ON credit.refund_id = refund.id AND credit.kind = 'credit_note'
      JOIN inventory_balances balance ON balance.variant_id = ${partialRecord.variantId}
        AND balance.location_id = ${partialRecord.locationId}
      WHERE orders.id = ${partialRecord.internalId}
    `
    const [communications] = await sql<
      Array<{
        unpaidCancellation: number
        fullCancellation: number
        fullRefund: number
        returnRequested: number
        returnUpdates: number
        partialRefund: number
      }>
    >`
      SELECT
        count(*) FILTER (WHERE event.aggregate_id = ${unpaidRecord.internalId}
          AND event.event_type = 'order.cancelled')::int AS "unpaidCancellation",
        count(*) FILTER (WHERE event.aggregate_id = ${fullRecord.internalId}
          AND event.event_type = 'order.cancellation.requested')::int AS "fullCancellation",
        count(*) FILTER (WHERE event.aggregate_id = ${fullCancellation.refundId}
          AND event.event_type = 'refund.succeeded.email')::int AS "fullRefund",
        count(*) FILTER (WHERE event.aggregate_id = (
          SELECT id FROM returns WHERE public_number = ${returned.id}
        ) AND event.event_type = 'return.requested')::int AS "returnRequested",
        count(*) FILTER (WHERE event.aggregate_id = (
          SELECT id FROM returns WHERE public_number = ${returned.id}
        ) AND event.event_type = 'return.status.updated')::int AS "returnUpdates",
        count(*) FILTER (WHERE event.aggregate_id = ${resolution.refundId}
          AND event.event_type = 'refund.succeeded.email')::int AS "partialRefund"
      FROM outbox_events event
      JOIN communication_deliveries delivery ON delivery.outbox_event_id = event.id
      WHERE delivery.status = 'accepted'
    `
    return { unpaid, full, partial, communications }
  })

  expect(reconciled.unpaid).toEqual({
    orderStatus: 'cancelled',
    paymentStatus: 'cancelled',
    inventoryStatus: 'released',
    refunds: 0
  })
  expect(reconciled.full).toMatchObject({
    orderStatus: 'cancelled',
    paymentStatus: 'refunded',
    refundAmount: capturedBeforeShipment.amountCents,
    refundEvents: 1,
    creditAmount: capturedBeforeShipment.amountCents
  })
  expect(reconciled.full!.sourceInvoice).toMatch(/^[0-9a-f-]{36}$/)
  expect(reconciled.full!.creditChecksum).toMatch(/^[a-f0-9]{64}$/)
  expect(reconciled.partial).toMatchObject({
    orderStatus: 'completed',
    paymentStatus: 'partially_refunded',
    inventoryStatus: 'allocated',
    fulfillmentStatus: 'delivered',
    returnStatus: 'resolved',
    refundAmount: partialRefundCents,
    refundLineQuantity: 1,
    refundLineGross: partialRefundCents,
    refundEvents: 1,
    returnMovements: 1,
    creditAmount: partialRefundCents,
    creditDocuments: 1,
    physical: stockAfterFullCancellation.physical + 1
  })
  expect(reconciled.partial!.sourceInvoice).toMatch(/^[0-9a-f-]{36}$/)
  expect(reconciled.communications).toEqual({
    unpaidCancellation: 1,
    fullCancellation: 1,
    fullRefund: 1,
    returnRequested: 1,
    returnUpdates: 5,
    partialRefund: 1
  })
})

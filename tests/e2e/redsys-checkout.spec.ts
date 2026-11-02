import { createHash } from 'node:crypto'
import type { APIRequestContext, APIResponse, Page } from '@playwright/test'
import postgres, { type Sql } from 'postgres'
import {
  decodeMerchantParameters,
  encodeMerchantParameters,
  REDSYS_REDIRECT_URLS,
  signMerchantParameters
} from '../../server/integrations/redsys'
import { expect, test } from '../fixtures/playwright'
import type { DeterministicTestData } from '../fixtures/deterministic'
import { REDSYS_OFFICIAL_CONTRACT } from '../fixtures/redsys-official'

const REDSYS_SECRET = REDSYS_OFFICIAL_CONTRACT.sandbox.secretKey
const STOREFRONT_ORIGIN = new URL(
  process.env.PLAYWRIGHT_BASE_URL ?? `http://127.0.0.1:${process.env.PLAYWRIGHT_PORT ?? '3100'}`
).origin

interface GuestOrder {
  id: string
  amountCents: number
  sandboxPosts: string[]
}

async function json<T>(response: APIResponse) {
  expect(response.ok(), await response.text()).toBe(true)
  return response.json() as Promise<T>
}

function post(request: APIRequestContext, url: string, data: Record<string, unknown>) {
  return request.post(url, { data, headers: { origin: STOREFRONT_ORIGIN } })
}

async function createGuestRedsysOrder(page: Page, namespace: string, deterministic: DeterministicTestData) {
  const request = page.context().request
  const catalog = await json<{ items: Array<{ slug: string }> }>(await request.get('/api/products?limit=1'))
  const product = catalog.items[0]
  expect(product).toBeTruthy()

  const sandboxPosts: string[] = []
  await page.route(REDSYS_REDIRECT_URLS.sandbox, async (route) => {
    sandboxPosts.push(route.request().postData() ?? '')
    await route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: '<!doctype html><html><body><h1>Redsys sandbox simulado</h1></body></html>'
    })
  })

  await page.goto(`/producto/${product!.slug}`)
  await page.getByRole('button', { name: 'Añadir al carrito' }).first().click()
  await expect(page.getByText('Añadido al carrito', { exact: true })).toBeVisible()
  await page.goto('/checkout')
  await expect(page.getByRole('heading', { name: 'Tramitar pedido' })).toBeVisible()

  await page.getByLabel('Nombre y apellidos').fill('Compra invitada Redsys')
  await page.getByLabel('Teléfono', { exact: true }).first().fill('600000000')
  await page.getByRole('textbox', { name: /^Email/ }).fill(deterministic.email(`${namespace}:customer`))
  await page.getByLabel('Destinatario').fill('Compra invitada Redsys')
  await page.getByLabel('Teléfono de entrega').fill('600000000')
  await page.getByLabel('Dirección', { exact: true }).fill('Calle de pruebas 11')
  await page.getByLabel('Código postal', { exact: true }).fill('46800')
  await page.getByLabel('Población', { exact: true }).fill('Xàtiva')
  await page.getByLabel('Provincia', { exact: true }).fill('Valencia')
  await page.getByRole('radio', { name: /Recogida en almacén/ }).check()
  await page.getByRole('checkbox', { name: /Acepto las condiciones de compra/ }).check()
  await page.getByRole('button', { name: /^Pagar / }).click()
  await expect(page.getByRole('heading', { name: 'Redsys sandbox simulado' })).toBeVisible()
  expect(sandboxPosts).toHaveLength(1)

  const fields = new URLSearchParams(sandboxPosts[0])
  const merchantParameters = fields.get('Ds_MerchantParameters')
  const signature = fields.get('Ds_Signature')
  expect(fields.get('Ds_SignatureVersion')).toBe('HMAC_SHA512_V2')
  expect(merchantParameters).toBeTruthy()
  expect(signature).toBeTruthy()
  const redirectParameters = decodeMerchantParameters(merchantParameters!)
  const orderId = String(redirectParameters.DS_MERCHANT_ORDER)
  const amountCents = Number(redirectParameters.DS_MERCHANT_AMOUNT)
  expect(redirectParameters).toMatchObject({
    DS_MERCHANT_CURRENCY: '978'
  })
  expect(orderId).toMatch(/^[A-Za-z0-9]{5,12}$/)
  expect(amountCents).toBeGreaterThan(0)
  expect(signature).toBe(signMerchantParameters(merchantParameters!, REDSYS_SECRET, orderId))
  return { id: orderId, amountCents, sandboxPosts } satisfies GuestOrder
}

function signedCallback(
  order: GuestOrder,
  responseCode: string,
  options: { amountCents?: number; authorization?: string } = {}
) {
  const merchantParameters = encodeMerchantParameters({
    Ds_Order: order.id,
    Ds_Amount: String(options.amountCents ?? order.amountCents),
    Ds_Currency: '978',
    Ds_MerchantCode: '999008881',
    Ds_Terminal: '1',
    Ds_TransactionType: '0',
    Ds_Response: responseCode,
    Ds_AuthorisationCode: options.authorization ?? `A${order.id.slice(-5)}`,
    Ds_Date: '13/08/2026',
    Ds_Hour: '12:00'
  })
  return {
    Ds_SignatureVersion: 'HMAC_SHA512_V2',
    Ds_MerchantParameters: merchantParameters,
    Ds_Signature: signMerchantParameters(merchantParameters, REDSYS_SECRET, order.id)
  }
}

async function callback(request: APIRequestContext, payload: Record<string, string>) {
  return post(request, '/api/payments/redsys/notification', payload)
}

async function orderState(request: APIRequestContext, order: GuestOrder) {
  return json<{ paymentStatus: string; status: string }>(await request.get(`/api/orders/${order.id}`))
}

async function databaseQuery<T>(query: (sql: Sql) => Promise<T>) {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 })
  try {
    return await query(sql)
  } finally {
    await sql.end({ timeout: 5 })
  }
}

test.describe.configure({ mode: 'serial', timeout: 60_000 })

test('confirms a guest purchase when the signed callback arrives before the browser return', async ({
  page,
  deterministic
}) => {
  const order = await createGuestRedsysOrder(page, 'success-before-return', deterministic)
  const response = await callback(page.context().request, signedCallback(order, '0000'))
  expect(response.status()).toBe(200)
  expect(await response.text()).toBe('OK')

  await page.goto(`/pago/retorno?order=${order.id}&payment=returned`)
  await expect(page).toHaveURL(new RegExp(`/pedido/${order.id}$`))
  await expect(page.getByRole('heading', { name: '¡Gracias por tu pedido!' })).toBeVisible()
})

test('keeps the order pending until a callback arrives after the browser return', async ({ page, deterministic }) => {
  const order = await createGuestRedsysOrder(page, 'success-after-return', deterministic)
  await page.goto(`/pago/retorno?order=${order.id}&payment=returned`)
  await expect(page.getByRole('heading', { name: 'Pedido pendiente de pago' })).toBeVisible()
  expect(await orderState(page.context().request, order)).toMatchObject({ paymentStatus: 'pending' })

  expect((await callback(page.context().request, signedCallback(order, '0000'))).status()).toBe(200)
  await page.reload()
  await expect(page.getByRole('heading', { name: '¡Gracias por tu pedido!' })).toBeVisible()
})

test('treats closing Redsys without a callback as abandonment, not payment failure', async ({
  page,
  deterministic
}) => {
  const order = await createGuestRedsysOrder(page, 'abandoned', deterministic)
  const request = page.context().request
  await page.close()
  expect(await orderState(request, order)).toMatchObject({
    paymentStatus: 'pending',
    status: 'pendiente_pago'
  })
})

test('records a signed bank rejection and offers a hosted payment retry', async ({ page, deterministic }) => {
  const order = await createGuestRedsysOrder(page, 'rejection-retry', deterministic)
  expect((await callback(page.context().request, signedCallback(order, '0101'))).status()).toBe(200)
  expect(await orderState(page.context().request, order)).toMatchObject({ paymentStatus: 'failed' })

  const accessCookies = await page.context().cookies()
  const orderAccess = accessCookies.find((cookie) => cookie.name === 'neteco-order-access')
  expect(orderAccess).toBeTruthy()
  const token = orderAccess!.value.slice(orderAccess!.value.indexOf('.') + 1)
  await page.context().clearCookies()
  expect(
    (await post(page.context().request, '/api/checkout/pay', { orderId: order.id, method: 'tarjeta' })).status()
  ).toBe(404)
  await page.context().addCookies(accessCookies)

  await page.context().addCookies([{ ...orderAccess!, value: `NEOTHER0000.${token}` }])
  expect(
    (await post(page.context().request, '/api/checkout/pay', { orderId: order.id, method: 'tarjeta' })).status()
  ).toBe(404)

  await page
    .context()
    .addCookies([{ ...orderAccess!, value: `${order.id}.${deterministic.uuid('rejection-retry:forged-token')}` }])
  expect(
    (await post(page.context().request, '/api/checkout/pay', { orderId: order.id, method: 'tarjeta' })).status()
  ).toBe(404)
  await page.context().addCookies([orderAccess!])
  await page.goto(`/pedido/${order.id}`)
  await expect(page.getByRole('button', { name: 'Reintentar el pago' })).toBeVisible()

  await page.getByRole('button', { name: 'Reintentar el pago' }).click()
  await expect(page.getByRole('heading', { name: 'Redsys sandbox simulado' })).toBeVisible()
  expect(order.sandboxPosts).toHaveLength(2)
  expect(order.sandboxPosts[1]).toContain('Ds_MerchantParameters=')
  expect(order.sandboxPosts[1]).toContain('Ds_Signature=')

  expect(
    (await callback(page.context().request, signedCallback(order, '0000', { authorization: 'RETRY1' }))).status()
  ).toBe(200)
  await page.goto(`/pago/retorno?order=${order.id}&payment=returned`)
  await expect(page.getByRole('heading', { name: '¡Gracias por tu pedido!' })).toBeVisible()
})

test('accepts concurrent identical callbacks without duplicating payment side effects', async ({
  page,
  deterministic
}) => {
  const order = await createGuestRedsysOrder(page, 'duplicate', deterministic)
  const payload = signedCallback(order, '0000')
  const responses = await Promise.all([
    callback(page.context().request, payload),
    callback(page.context().request, payload)
  ])
  expect(responses.map((response) => response.status())).toEqual([200, 200])
  const state = await databaseQuery(async (sql) => {
    const [row] = await sql<
      Array<{ paymentEvents: number; webhookEvents: number; allocations: number; invoicesQueued: number }>
    >`
      SELECT
        (SELECT count(*) FROM payment_events event
         JOIN payment_intents intent ON intent.id = event.payment_intent_id
         WHERE intent.order_id = purchase.id)::int AS "paymentEvents",
        (SELECT count(*) FROM webhook_inbox inbox
         WHERE inbox.provider = 'redsys'
           AND inbox.sanitized_payload ->> 'orderReference' = purchase.public_number)::int AS "webhookEvents",
        (SELECT count(*) FROM inventory_movements movement
         WHERE movement.reference_id = purchase.id AND movement.movement_type = 'allocate')::int AS allocations,
        (SELECT count(*) FROM outbox_events event
         WHERE event.aggregate_id = purchase.id AND event.event_type = 'invoice.issue.requested')::int AS "invoicesQueued"
      FROM orders purchase
      WHERE purchase.public_number = ${order.id}
    `
    return row
  })
  expect(state).toEqual({ paymentEvents: 1, webhookEvents: 1, allocations: 1, invoicesQueued: 1 })
})

test('rejects a correctly signed callback whose amount differs from the order', async ({ page, deterministic }) => {
  const order = await createGuestRedsysOrder(page, 'amount-mismatch', deterministic)
  const response = await callback(
    page.context().request,
    signedCallback(order, '0000', { amountCents: order.amountCents + 1 })
  )
  expect(response.status()).toBe(422)
  expect(await orderState(page.context().request, order)).toMatchObject({ paymentStatus: 'pending' })
})

test('rejects and audits an invalid callback signature without changing payment state', async ({
  page,
  deterministic
}) => {
  const order = await createGuestRedsysOrder(page, 'invalid-signature', deterministic)
  const payload = signedCallback(order, '0000')
  payload.Ds_Signature = `${payload.Ds_Signature.startsWith('A') ? 'B' : 'A'}${payload.Ds_Signature.slice(1)}`
  const response = await callback(page.context().request, payload)
  expect(response.status()).toBe(400)
  expect(await orderState(page.context().request, order)).toMatchObject({ paymentStatus: 'pending' })

  const canonical = Object.keys(payload)
    .sort()
    .map((key) => `${key}=${payload[key as keyof typeof payload]}`)
    .join('&')
  const hash = createHash('sha256').update(canonical, 'utf8').digest('hex')
  const rejected = await databaseQuery(async (sql) => {
    const [row] = await sql<{ signatureValid: boolean; status: string }[]>`
      SELECT signature_valid AS "signatureValid", status FROM webhook_inbox WHERE payload_hash = ${hash}
    `
    return row
  })
  expect(rejected).toEqual({ signatureValid: false, status: 'rejected' })
})

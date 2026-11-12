import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { Page } from '@playwright/test'
import * as OTPAuth from 'otpauth'
import postgres, { type Sql } from 'postgres'
import { decryptSecret } from '../../server/utils/secrets'
import { expect, test } from '../fixtures/playwright'
import type { DeterministicTestData } from '../fixtures/deterministic'

const execFileAsync = promisify(execFile)

async function databaseQuery<T>(query: (sql: Sql) => Promise<T>) {
  const sql = postgres(process.env.DATABASE_URL!, { max: 2 })
  try {
    return await query(sql)
  } finally {
    await sql.end({ timeout: 5 })
  }
}

async function addCatalogProduct(page: Page) {
  const response = await page.context().request.get('/api/products?limit=1')
  expect(response.ok(), await response.text()).toBe(true)
  const catalog = (await response.json()) as { items: Array<{ slug: string }> }
  await page.goto(`/producto/${catalog.items[0]!.slug}`)
  await page.getByRole('button', { name: 'Añadir al carrito' }).first().click()
  await expect(page.getByText('Añadido al carrito', { exact: true })).toBeVisible()
}

async function createGuestTransferOrder(page: Page, email: string) {
  await addCatalogProduct(page)
  await page.goto('/checkout')
  await page.getByLabel('Nombre y apellidos').fill('Compra por transferencia')
  await page.getByLabel('Teléfono', { exact: true }).first().fill('600000000')
  await page.getByRole('textbox', { name: /^Email/ }).fill(email)
  await page.getByLabel('Destinatario').fill('Compra por transferencia')
  await page.getByLabel('Teléfono de entrega').fill('600000000')
  await page.getByLabel('Dirección', { exact: true }).fill('Calle Bancaria 72')
  await page.getByLabel('Código postal', { exact: true }).fill('46800')
  await page.getByLabel('Población', { exact: true }).fill('Xàtiva')
  await page.getByLabel('Provincia', { exact: true }).fill('Valencia')
  await page.getByRole('radio', { name: /Recogida en almacén/ }).check()
  await page.getByRole('radio', { name: 'Transferencia bancaria' }).check()
  await page.getByRole('checkbox', { name: /Acepto las condiciones de compra/ }).check()
  const responsePromise = page.waitForResponse(
    (response) => response.url().endsWith('/api/orders') && response.request().method() === 'POST'
  )
  await page.getByRole('button', { name: 'Confirmar pedido con obligación de pago' }).click()
  const response = await responsePromise
  expect(response.status(), await response.text()).toBe(201)
  const order = (await response.json()) as { id: string; total: number; expiresAt: string }
  await expect(page).toHaveURL(new RegExp(`/pedido/${order.id}$`))
  await expect(page.getByText('Datos para la transferencia')).toBeVisible()
  await expect(page.getByText('Concepto', { exact: true })).toBeVisible()
  await expect(page.locator('dt', { hasText: 'Concepto' }).locator('xpath=following-sibling::dd[1]')).toHaveText(
    order.id
  )
  await expect(page.getByText('ES91 2100 0418 4502 0005 1332', { exact: true })).toBeVisible()
  return order
}

async function runStatement(
  directory: string,
  filename: string,
  movements: Array<{
    externalId: string
    bookedAt: string
    amountCents: number
    currency: string
    reference: string
  }>
) {
  const statement = join(directory, filename)
  await writeFile(statement, JSON.stringify(movements), { encoding: 'utf8', flag: 'wx' })
  return execFileAsync('node_modules/.bin/tsx', ['scripts/bank-transfer-reconcile.ts', `--file=${statement}`], {
    cwd: process.cwd(),
    env: { ...process.env, APP_ENV: 'test', BANK_TRANSFER_STATEMENT_PROVIDER: 'e2e-bank' }
  })
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
  return decryptSecret(envelope!, process.env.AUTH_ENCRYPTION_KEY!)
}

async function createFinanceAdministrator(
  page: Page,
  email: string,
  password: string,
  unauthorizedAttempt: { movementId: string; orderNumber: string }
) {
  await page.goto('/registro')
  await page.getByLabel('Nombre y apellidos').fill('Finanzas E2E')
  await page.getByLabel('Teléfono').fill('600000001')
  await page.getByLabel('Email', { exact: true }).fill(email)
  await page.getByLabel('Contraseña', { exact: true }).fill(password)
  await page.getByLabel('Repite la contraseña', { exact: true }).fill(password)
  await page.getByRole('checkbox', { name: 'Acepto las condiciones de la cuenta' }).check()
  const registrationPromise = page.waitForResponse(
    (response) => response.url().endsWith('/api/auth/register') && response.request().method() === 'POST'
  )
  await page.getByRole('button', { name: 'Crear cuenta' }).click()
  const registration = await registrationPromise
  expect(registration.status(), await registration.text()).toBe(201)
  await page.goto(`/verificar-email?token=${encodeURIComponent(await identityToken(email))}`)
  await expect(page.getByRole('heading', { name: 'Email verificado' })).toBeVisible()

  const withoutMfa = await page
    .context()
    .request.post(`/api/admin/operations/bank-transfers/${unauthorizedAttempt.movementId}/reconcile`, {
      data: { orderNumber: unauthorizedAttempt.orderNumber, reason: 'Intento sin MFA' },
      headers: { origin: new URL(page.url()).origin }
    })
  expect(withoutMfa.status()).toBe(403)

  await page.goto('/cuenta/seguridad')
  // The field is server-rendered before hydration; a value typed too early is reset by Vue, so retry
  // until the model is bound (the submit button only enables once it holds the password).
  await expect(async () => {
    await page.locator('#account-mfa-current-password').fill(password)
    await expect(page.getByRole('button', { name: 'Activar verificación en dos pasos' })).toBeEnabled({ timeout: 1000 })
  }).toPass({ timeout: 15_000 })
  const setupPromise = page.waitForResponse(
    (response) => response.url().endsWith('/api/auth/mfa/setup') && response.request().method() === 'POST'
  )
  await page.getByRole('button', { name: 'Activar verificación en dos pasos' }).click()
  const setupResponse = await setupPromise
  expect(setupResponse.status(), await setupResponse.text()).toBe(200)
  const enrollment = (await setupResponse.json()) as { manualKey: string; recoveryCodes: string[] }
  const totp = new OTPAuth.TOTP({
    issuer: 'NETECO',
    label: email,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(enrollment.manualKey)
  })
  await page.getByRole('checkbox', { name: 'He guardado los códigos en un sitio seguro' }).check()
  await page.getByPlaceholder('000000').fill(totp.generate())
  await page.getByRole('button', { name: 'Activar', exact: true }).click()
  await expect(page.getByText('Verificación en dos pasos activada.')).toBeVisible()

  const withoutPermission = await page
    .context()
    .request.post(`/api/admin/operations/bank-transfers/${unauthorizedAttempt.movementId}/reconcile`, {
      data: { orderNumber: unauthorizedAttempt.orderNumber, reason: 'Intento sin permiso financiero' },
      headers: { origin: new URL(page.url()).origin }
    })
  expect(withoutPermission.status()).toBe(403)
  await databaseQuery(async (sql) => {
    const [identity] = await sql<{ id: string }[]>`SELECT id FROM identities WHERE email = ${email}`
    expect(identity).toBeTruthy()
    await sql`
      INSERT INTO identity_roles (identity_id, role_code) VALUES
        (${identity!.id}, 'admin'),
        (${identity!.id}, 'finance')
      ON CONFLICT (identity_id, role_code) DO NOTHING
    `
  })
  await page.goto('/cuenta')
  await page.getByRole('button', { name: 'Cerrar sesión' }).click()
  await expect(page).toHaveURL(new URL('/', page.url()).toString())
  await page.goto('/login?redirect=/admin/operaciones')
  await page.getByRole('textbox', { name: 'Email', exact: true }).fill(email)
  await page.getByLabel('Contraseña', { exact: true }).fill(password)
  const loginPromise = page.waitForResponse(
    (response) => response.url().endsWith('/api/auth/login') && response.request().method() === 'POST'
  )
  await page.getByRole('button', { name: 'Iniciar sesión' }).click()
  const login = await loginPromise
  expect(login.status(), await login.text()).toBe(200)
  await page.getByLabel('Código de autenticación').fill(enrollment.recoveryCodes[0]!)
  await page.getByRole('button', { name: 'Confirmar código' }).click()
  await expect(page).toHaveURL(/\/admin\/operaciones$/)
  await expect(page.getByRole('heading', { name: 'Operaciones y colas' })).toBeVisible()
}

test.describe.configure({ mode: 'serial' })

test('covers bank-transfer reservation, automatic/manual reconciliation and idempotent expiry', async ({
  page,
  deterministic
}: {
  page: Page
  deterministic: DeterministicTestData
}) => {
  test.setTimeout(120_000)
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'neteco-bank-transfer-'))
  try {
    const automatic = await createGuestTransferOrder(page, deterministic.email('automatic'))
    const initial = await databaseQuery(async (sql) => {
      const [row] = await sql<
        Array<{
          orderStatus: string
          paymentStatus: string
          inventoryStatus: string
          reservationStatus: string
          reservationHours: number
        }>
      >`
        SELECT orders.order_status AS "orderStatus", orders.payment_status AS "paymentStatus",
               orders.inventory_status AS "inventoryStatus", reservation.status AS "reservationStatus",
               (extract(epoch FROM (orders.expires_at - orders.created_at)) / 3600)::float8 AS "reservationHours"
        FROM orders JOIN inventory_reservations reservation ON reservation.order_id = orders.id
        WHERE orders.public_number = ${automatic.id}
      `
      return row
    })
    expect(initial).toMatchObject({
      orderStatus: 'awaiting_payment',
      paymentStatus: 'pending',
      inventoryStatus: 'reserved',
      reservationStatus: 'active'
    })
    expect(initial!.reservationHours).toBeCloseTo(72, 4)

    const automaticMovement = {
      externalId: deterministic.token('automatic-movement'),
      bookedAt: deterministic.date().toISOString(),
      amountCents: automatic.total,
      currency: 'EUR',
      reference: automatic.id
    }
    const [firstImport, replayImport] = await Promise.all([
      runStatement(temporaryDirectory, 'automatic-first.json', [automaticMovement]),
      runStatement(temporaryDirectory, 'automatic-replay.json', [automaticMovement])
    ])
    const importResults = [JSON.parse(firstImport.stdout), JSON.parse(replayImport.stdout)] as Array<{
      matched: number
      duplicates: number
    }>
    expect(importResults.reduce((total, result) => total + result.matched, 0)).toBe(1)
    expect(importResults.reduce((total, result) => total + result.duplicates, 0)).toBe(1)
    await page.reload()
    await expect(page.getByRole('heading', { name: '¡Gracias por tu pedido!' })).toBeVisible()

    const automaticState = await databaseQuery(async (sql) => {
      const [row] = await sql`
        SELECT orders.order_status AS "orderStatus", orders.payment_status AS "paymentStatus",
          orders.inventory_status AS "inventoryStatus",
          (SELECT count(*)::int FROM bank_transfer_movements movement WHERE movement.matched_order_id = orders.id) AS "matches",
          (SELECT count(*)::int FROM payment_events event JOIN payment_intents intent ON intent.id = event.payment_intent_id
            WHERE intent.order_id = orders.id) AS "paymentEvents",
          (SELECT count(*)::int FROM inventory_movements movement WHERE movement.reference_id = orders.id
            AND movement.movement_type = 'allocate') AS "allocations",
          (SELECT count(*)::int FROM order_events event WHERE event.order_id = orders.id
            AND event.event_type = 'payment.captured') AS "captureTransitions"
        FROM orders WHERE orders.public_number = ${automatic.id}
      `
      return row
    })
    expect(automaticState).toMatchObject({
      orderStatus: 'confirmed',
      paymentStatus: 'captured',
      inventoryStatus: 'allocated',
      matches: 1,
      paymentEvents: 1,
      allocations: 1,
      captureTransitions: 1
    })

    const secondMovement = {
      ...automaticMovement,
      externalId: deterministic.token('second-movement-for-paid-order'),
      bookedAt: deterministic.date(500).toISOString()
    }
    const secondImport = await runStatement(temporaryDirectory, 'automatic-second.json', [secondMovement])
    expect(JSON.parse(secondImport.stdout)).toMatchObject({ matched: 0, needsReview: 1, duplicates: 0 })
    const afterSecondMovement = await databaseQuery(async (sql) => {
      const [row] = await sql`
        SELECT
          (SELECT count(*)::int FROM bank_transfer_movements movement WHERE movement.matched_order_id = orders.id) AS "matches",
          (SELECT count(*)::int FROM payment_events event JOIN payment_intents intent ON intent.id = event.payment_intent_id
            WHERE intent.order_id = orders.id) AS "paymentEvents",
          (SELECT count(*)::int FROM order_events event WHERE event.order_id = orders.id
            AND event.event_type = 'payment.captured') AS "captureTransitions"
        FROM orders WHERE orders.public_number = ${automatic.id}
      `
      return row
    })
    expect(afterSecondMovement).toEqual({ matches: 1, paymentEvents: 1, captureTransitions: 1 })

    await page.context().clearCookies()
    const manual = await createGuestTransferOrder(page, deterministic.email('manual'))
    const manualMovement = {
      externalId: deterministic.token('manual-movement'),
      bookedAt: deterministic.date(1_000).toISOString(),
      amountCents: manual.total,
      currency: 'EUR',
      reference: 'REFERENCIA BANCARIA INCOMPLETA'
    }
    const wrongAmountMovement = {
      externalId: deterministic.token('wrong-amount-movement'),
      bookedAt: deterministic.date(2_000).toISOString(),
      amountCents: manual.total + 1,
      currency: 'EUR',
      reference: manual.id
    }
    const pendingImport = await runStatement(temporaryDirectory, 'manual.json', [manualMovement, wrongAmountMovement])
    expect(JSON.parse(pendingImport.stdout)).toMatchObject({ matched: 0, needsReview: 2, duplicates: 0 })

    await page.context().clearCookies()
    const movementIds = await databaseQuery(async (sql) => {
      const movements = await sql<{ id: string; externalId: string }[]>`
        SELECT id, external_id AS "externalId" FROM bank_transfer_movements
        WHERE provider = 'e2e-bank' AND external_id IN (${manualMovement.externalId}, ${wrongAmountMovement.externalId})
      `
      return {
        manual: movements.find((movement) => movement.externalId === manualMovement.externalId)!.id,
        wrongAmount: movements.find((movement) => movement.externalId === wrongAmountMovement.externalId)!.id
      }
    })
    const administratorEmail = deterministic.email('finance-administrator')
    await createFinanceAdministrator(page, administratorEmail, 'Neteco-Finance-E2E-2026', {
      movementId: movementIds.manual,
      orderNumber: manual.id
    })
    // The pending-review list shows amount, received reference and review reason (not the provider
    // id). The manual movement has an unmatchable reference; the divergent one has the order reference.
    const manualRow = page.getByRole('listitem').filter({ hasText: 'reference_not_found' })
    await expect(manualRow).toHaveCount(1)
    await manualRow.getByRole('button', { name: 'Conciliar' }).click()
    const reconcileDialog = page.getByRole('dialog', { name: 'Conciliar la transferencia' })
    await reconcileDialog.getByLabel('Número de pedido').fill(manual.id)
    await reconcileDialog.getByLabel('Motivo').fill('Ingreso bancario comprobado por Finanzas')
    await reconcileDialog.getByRole('button', { name: 'Conciliar', exact: true }).click()
    await expect(manualRow).toHaveCount(0)

    const rejected = await page
      .context()
      .request.post(`/api/admin/operations/bank-transfers/${movementIds.wrongAmount}/reconcile`, {
        data: { orderNumber: manual.id, reason: 'Comprobación de importe divergente' },
        headers: { origin: new URL(page.url()).origin }
      })
    expect(rejected.status()).toBe(409)
    const replay = await page
      .context()
      .request.post(`/api/admin/operations/bank-transfers/${movementIds.manual}/reconcile`, {
        data: { orderNumber: manual.id, reason: 'Replay manual deliberado' },
        headers: { origin: new URL(page.url()).origin }
      })
    expect(replay.status(), await replay.text()).toBe(200)
    expect(await replay.json()).toMatchObject({ duplicate: true, status: 'matched', orderNumber: manual.id })
    const manualState = await databaseQuery(async (sql) => {
      const [row] = await sql`
        SELECT orders.order_status AS "orderStatus", orders.payment_status AS "paymentStatus",
          movement.match_mode AS "matchMode",
          (SELECT count(*)::int FROM order_events event WHERE event.order_id = orders.id
            AND event.event_type = 'payment.captured') AS "captureTransitions",
          (SELECT count(*)::int FROM audit_log audit WHERE audit.resource_id = movement.id::text
            AND audit.action = 'payment.bank_transfer.reconcile') AS "audits"
        FROM orders JOIN bank_transfer_movements movement ON movement.matched_order_id = orders.id
        WHERE orders.public_number = ${manual.id}
      `
      return row
    })
    expect(manualState).toMatchObject({
      orderStatus: 'confirmed',
      paymentStatus: 'captured',
      matchMode: 'manual',
      captureTransitions: 1,
      audits: 1
    })

    await page.context().clearCookies()
    const expiring = await createGuestTransferOrder(page, deterministic.email('expiry'))
    await databaseQuery(async (sql) => {
      await sql.begin(async (transaction) => {
        await transaction`UPDATE orders SET expires_at = now() - interval '1 minute' WHERE public_number = ${expiring.id}`
        await transaction`
          UPDATE inventory_reservations SET expires_at = now() - interval '1 minute'
          WHERE order_id = (SELECT id FROM orders WHERE public_number = ${expiring.id})
        `
      })
    })
    const workerEnvironment = { ...process.env, APP_ENV: 'test' }
    const [firstExpiry, secondExpiry] = await Promise.all([
      execFileAsync('node_modules/.bin/tsx', ['scripts/reservation-worker.ts'], {
        cwd: process.cwd(),
        env: workerEnvironment
      }),
      execFileAsync('node_modules/.bin/tsx', ['scripts/reservation-worker.ts'], {
        cwd: process.cwd(),
        env: workerEnvironment
      })
    ])
    const expiryResults = [JSON.parse(firstExpiry.stdout), JSON.parse(secondExpiry.stdout)] as Array<{
      expiredOrders: number
    }>
    expect(expiryResults.reduce((total, result) => total + result.expiredOrders, 0)).toBe(1)
    await page.reload()
    await expect(page.getByRole('heading', { name: 'Pedido cancelado', level: 1 })).toBeVisible()
    await expect(page.getByText('Datos para la transferencia')).toBeHidden()

    const expiredState = await databaseQuery(async (sql) => {
      const [row] = await sql`
        SELECT orders.order_status AS "orderStatus", orders.payment_status AS "paymentStatus",
          orders.inventory_status AS "inventoryStatus", reservation.status AS "reservationStatus",
          (SELECT count(*)::int FROM inventory_movements movement WHERE movement.reference_id = orders.id
            AND movement.movement_type = 'release') AS "releases",
          (SELECT count(*)::int FROM order_events event WHERE event.order_id = orders.id
            AND event.event_type = 'reservation.expired') AS "expiryTransitions",
          (SELECT count(*)::int FROM outbox_events outbox WHERE outbox.aggregate_id = orders.id
            AND outbox.event_type = 'order.reservation.expired') AS "expiryMessages"
        FROM orders JOIN inventory_reservations reservation ON reservation.order_id = orders.id
        WHERE orders.public_number = ${expiring.id}
      `
      return row
    })
    expect(expiredState).toMatchObject({
      orderStatus: 'cancelled',
      paymentStatus: 'cancelled',
      inventoryStatus: 'released',
      reservationStatus: 'expired',
      releases: 1,
      expiryTransitions: 1,
      expiryMessages: 1
    })
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true })
  }
})

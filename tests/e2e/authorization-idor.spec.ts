import type { APIRequestContext, APIResponse, Page } from '@playwright/test'
import { readFile, unlink } from 'node:fs/promises'
import { resolve, relative } from 'node:path'
import * as OTPAuth from 'otpauth'
import postgres, { type Sql } from 'postgres'
import { decryptSecret } from '../../server/utils/secrets'
import { expect, test } from '../fixtures/playwright'
import type { DeterministicTestData } from '../fixtures/deterministic'

const ORIGIN = new URL(process.env.PLAYWRIGHT_BASE_URL ?? `http://127.0.0.1:${process.env.PLAYWRIGHT_PORT ?? '3100'}`)
  .origin

const PASSWORD = 'Neteco-IDOR-matrix-2026'
const ADDRESS = {
  kind: 'both',
  label: 'Sede de autorización',
  recipientName: 'Propietario del recurso',
  companyName: '',
  taxId: '',
  line1: 'Calle Privada 12',
  line2: '',
  postalCode: '46800',
  city: 'Xàtiva',
  region: 'Valencia',
  countryCode: 'ES',
  phone: '600000000',
  instructions: '',
  isDefault: true
}

function pngChunk(type: string, data = Buffer.alloc(0)) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  return Buffer.concat([length, Buffer.from(type), data, Buffer.alloc(4)])
}

function uploadPng() {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(800, 0)
  header.writeUInt32BE(600, 4)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('tEXt', Buffer.from('private metadata')),
    pngChunk('IDAT'),
    pngChunk('IEND')
  ])
}

async function databaseQuery<T>(query: (sql: Sql) => Promise<T>) {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 })
  try {
    return await query(sql)
  } finally {
    await sql.end({ timeout: 5 })
  }
}

async function responseStatus(response: Pick<APIResponse, 'status' | 'text'>, expected: number, label: string) {
  const body = await response.text()
  expect(response.status(), `${label}: ${body}`).toBe(expected)
  return body
}

function requestHeaders(correlationId?: string) {
  return { origin: ORIGIN, ...(correlationId ? { 'x-correlation-id': correlationId } : {}) }
}

function get(request: APIRequestContext, url: string, correlationId?: string) {
  return request.get(url, { headers: requestHeaders(correlationId) })
}

function post(request: APIRequestContext, url: string, data: Record<string, unknown>, correlationId?: string) {
  return request.post(url, { data, headers: requestHeaders(correlationId) })
}

function put(request: APIRequestContext, url: string, data: Record<string, unknown>, correlationId?: string) {
  return request.put(url, { data, headers: requestHeaders(correlationId) })
}

function remove(request: APIRequestContext, url: string, correlationId?: string) {
  return request.delete(url, { headers: requestHeaders(correlationId) })
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

async function registerAndVerify(request: APIRequestContext, email: string, company: string) {
  const registration = await post(request, '/api/auth/register', {
    name: `Cuenta ${company}`,
    email,
    password: PASSWORD,
    phone: '600000000',
    company,
    termsAccepted: true,
    newsletter: false
  })
  await responseStatus(registration, 201, `registro de ${email}`)
  const verification = await post(request, '/api/auth/verify-email', {
    token: await verificationToken(email)
  })
  await responseStatus(verification, 200, `verificación de ${email}`)
  return databaseQuery(async (sql) => {
    const [identity] = await sql<{ id: string }[]>`SELECT id FROM identities WHERE email = ${email}`
    expect(identity).toBeTruthy()
    return identity!.id
  })
}

async function enableMfa(request: APIRequestContext, email: string) {
  const setup = await post(request, '/api/auth/mfa/setup', {})
  await responseStatus(setup, 200, 'alta MFA')
  const enrollment = (await setup.json()) as { manualKey: string }
  const totp = new OTPAuth.TOTP({
    issuer: 'NETECO',
    label: email,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(enrollment.manualKey)
  })
  const verification = await post(request, '/api/auth/mfa/verify-setup', { code: totp.generate() })
  await responseStatus(verification, 200, 'verificación MFA')
}

async function createTransferOrder(page: Page, email: string) {
  const catalogResponse = await page.context().request.get('/api/products?limit=1')
  await responseStatus(catalogResponse, 200, 'catálogo para pedido propietario')
  const catalog = (await catalogResponse.json()) as { items: Array<{ slug: string }> }
  await page.goto(`/producto/${catalog.items[0]!.slug}`)
  await page.getByRole('button', { name: 'Añadir al carrito' }).first().click()
  await expect(page.getByText('Añadido al carrito', { exact: true })).toBeVisible()
  await page.goto('/checkout')
  await page.getByLabel('Nombre y apellidos').fill('Propietario del pedido')
  await page.getByLabel('Teléfono', { exact: true }).first().fill('600000000')
  await page.getByRole('textbox', { name: /^Email/ }).fill(email)
  await page.getByLabel('Destinatario').fill('Propietario del pedido')
  await page.getByLabel('Teléfono de entrega').fill('600000000')
  await page.getByLabel('Dirección', { exact: true }).fill('Calle Privada 12')
  await page.getByLabel('Código postal', { exact: true }).fill('46800')
  await page.getByLabel('Población', { exact: true }).fill('Xàtiva')
  await page.getByLabel('Provincia', { exact: true }).fill('Valencia')
  await page.getByRole('radio', { name: /Recogida en almacén/ }).check()
  await page.getByRole('radio', { name: 'Transferencia bancaria' }).check()
  await page.getByRole('checkbox', { name: /Acepto las condiciones de compra/ }).check()
  const creation = page.waitForResponse(
    (response) => response.url().endsWith('/api/orders') && response.request().method() === 'POST'
  )
  await page.getByRole('button', { name: 'Confirmar pedido' }).click()
  const response = await creation
  await responseStatus(response, 201, 'pedido propietario')
  const orderCookie = await response.headerValue('set-cookie')
  expect(orderCookie).toContain('neteco-order-access=')
  expect(orderCookie).toContain('HttpOnly')
  expect(orderCookie).toContain('SameSite=Lax')
  expect(orderCookie).toContain('Path=/')
  return ((await response.json()) as { id: string }).id
}

async function setInternalRole(identityId: string, role: 'support' | 'warehouse' | 'finance', enabled: boolean) {
  await databaseQuery(async (sql) => {
    if (enabled) {
      await sql`
        INSERT INTO identity_roles (identity_id, role_code) VALUES (${identityId}, ${role})
        ON CONFLICT (identity_id, role_code) DO NOTHING
      `
      return
    }
    await sql`DELETE FROM identity_roles WHERE identity_id = ${identityId} AND role_code = ${role}`
  })
}

async function protectedState(input: {
  addressId: string
  privacyRequestId: string
  sessionId: string
  companyId: string
  actorId: string
  guessedReturn: string
}) {
  return databaseQuery(async (sql) => {
    const [state] = await sql<
      Array<{
        address: Record<string, unknown>
        privacyRequest: Record<string, unknown>
        sessionRevokedAt: Date | null
        company: Record<string, unknown>
        mediaCount: number
        refundCount: number
      }>
    >`
      SELECT
        (SELECT to_jsonb(address) FROM addresses address WHERE id = ${input.addressId}) AS address,
        (SELECT to_jsonb(request) FROM privacy_requests request WHERE id = ${input.privacyRequestId}) AS "privacyRequest",
        (SELECT revoked_at FROM auth_sessions WHERE id = ${input.sessionId}) AS "sessionRevokedAt",
        (SELECT to_jsonb(company) FROM companies company WHERE id = ${input.companyId}) AS company,
        (
          SELECT count(*)::int FROM media_assets
          WHERE metadata ->> 'uploadedBy' = ${input.actorId}
        ) AS "mediaCount",
        (
          SELECT count(*)::int FROM refunds refund
          JOIN returns returned ON returned.id = refund.return_id
          WHERE returned.public_number = ${input.guessedReturn}
        ) AS "refundCount"
    `
    return state
  })
}

async function correlationSideEffects(correlationId: string) {
  return databaseQuery(async (sql) => {
    const [state] = await sql<{ audits: number; outbox: number }[]>`
      SELECT
        (SELECT count(*)::int FROM audit_log WHERE correlation_id = ${correlationId}) AS audits,
        (SELECT count(*)::int FROM outbox_events WHERE correlation_id = ${correlationId}) AS outbox
    `
    return state
  })
}

test('enforces the anonymous, customer, company and administrator IDOR matrix', async ({
  page,
  deterministic
}: {
  page: Page
  deterministic: DeterministicTestData
}) => {
  test.setTimeout(90_000)
  const request = page.context().request
  const guessedUuid = deterministic.uuid('guessed-resource')
  const guessedOrder = 'NEFFFFFFFFFF'
  const guessedReturn = 'REFFFFFFFFFF'

  await test.step('anonymous callers cannot cross an authentication boundary', async () => {
    const attempts = [
      ['account address', remove(request, `/api/account/addresses/${guessedUuid}`)],
      ['privacy export', get(request, `/api/account/privacy/${guessedUuid}/download`)],
      ['financial action', post(request, `/api/admin/invoices/${guessedOrder}/retry`, { reason: 'IDOR anónimo' })],
      ['shipment PDF', get(request, `/api/admin/shipments/${guessedUuid}/label`)]
    ] as const
    for (const [label, attempt] of attempts) await responseStatus(await attempt, 401, label)
  })

  const ownerEmail = deterministic.email('resource-owner')
  const ownerIdentityId = await registerAndVerify(request, ownerEmail, 'Empresa propietaria IDOR')
  const addressResponse = await post(request, '/api/account/addresses', ADDRESS)
  await responseStatus(addressResponse, 201, 'alta de dirección propietaria')
  const addressId = ((await addressResponse.json()) as { id: string }).id
  const privacyResponse = await post(request, '/api/account/privacy', {
    requestType: 'export',
    idempotencyKey: deterministic.uuid('privacy-export')
  })
  await responseStatus(privacyResponse, 202, 'alta de exportación propietaria')
  const privacyRequestId = ((await privacyResponse.json()) as { id: string }).id
  const sessionsResponse = await get(request, '/api/account/sessions')
  await responseStatus(sessionsResponse, 200, 'sesiones propietarias')
  const sessions = (await sessionsResponse.json()) as { sessions: Array<{ id: string; current: boolean }> }
  const foreignSessionId = sessions.sessions.find((session) => !session.current)?.id
  expect(foreignSessionId, 'el registro y la verificación deben dejar una sesión secundaria activa').toBeTruthy()
  const ownerCompanyResponse = await put(request, '/api/account/company', {
    legalName: 'Empresa propietaria IDOR SL',
    tradeName: 'Propietaria IDOR',
    taxId: 'B12345674',
    countryCode: 'ES',
    currentPassword: PASSWORD
  })
  await responseStatus(ownerCompanyResponse, 200, 'edición por company_admin')
  const ownerCompanyId = ((await ownerCompanyResponse.json()) as { companyId: string }).companyId
  const ownerOrderId = await createTransferOrder(page, ownerEmail)
  await responseStatus(await post(request, '/api/auth/logout', {}), 200, 'logout de propietario')

  const attackerEmail = deterministic.email('foreign-company-member')
  const attackerIdentityId = await registerAndVerify(request, attackerEmail, 'Empresa atacante IDOR')
  await databaseQuery(async (sql) => {
    await sql`
      UPDATE company_members SET role = 'buyer'
      WHERE identity_id = ${attackerIdentityId} AND role = 'company_admin'
    `
  })

  const ownerState = {
    addressId,
    privacyRequestId,
    sessionId: foreignSessionId!,
    companyId: ownerCompanyId,
    actorId: attackerIdentityId,
    guessedReturn
  }
  const beforeForeignAttempts = await protectedState(ownerState)
  const foreignCorrelationId = deterministic.uuid('foreign-attempts')

  await test.step('a customer and company member cannot use foreign or guessed identifiers', async () => {
    const attempts: Array<[string, Promise<APIResponse>, number]> = [
      [
        'foreign address update',
        put(request, `/api/account/addresses/${addressId}`, ADDRESS, foreignCorrelationId),
        404
      ],
      ['foreign address delete', remove(request, `/api/account/addresses/${addressId}`, foreignCorrelationId), 404],
      [
        'foreign privacy export',
        get(request, `/api/account/privacy/${privacyRequestId}/download`, foreignCorrelationId),
        404
      ],
      [
        'foreign session revoke',
        remove(request, `/api/account/sessions/${foreignSessionId}`, foreignCorrelationId),
        404
      ],
      ['foreign company order', get(request, `/api/orders/${ownerOrderId}`, foreignCorrelationId), 404],
      ['guessed order', get(request, `/api/orders/${guessedOrder}`, foreignCorrelationId), 404],
      ['guessed invoice PDF', get(request, `/api/orders/${guessedOrder}/invoice`, foreignCorrelationId), 404],
      [
        'foreign company administration',
        put(
          request,
          `/api/admin/companies/${ownerCompanyId}`,
          { status: 'approved', reason: 'IDOR empresa' },
          foreignCorrelationId
        ),
        403
      ],
      [
        'financial reconciliation',
        post(
          request,
          `/api/admin/operations/bank-transfers/${guessedUuid}/reconcile`,
          {
            orderNumber: guessedOrder,
            reason: 'IDOR financiero'
          },
          foreignCorrelationId
        ),
        403
      ],
      [
        'media approval',
        put(
          request,
          `/api/admin/media/${guessedUuid}`,
          { decision: 'reject', reason: 'IDOR media' },
          foreignCorrelationId
        ),
        403
      ],
      ['shipment PDF', get(request, `/api/admin/shipments/${guessedUuid}/label`, foreignCorrelationId), 403]
    ]
    for (const [label, attempt, status] of attempts) await responseStatus(await attempt, status, label)

    const companyMemberAttempt = await put(
      request,
      '/api/account/company',
      {
        legalName: 'Empresa atacante alterada SL',
        tradeName: 'Ataque',
        taxId: 'B12345682',
        countryCode: 'ES',
        currentPassword: PASSWORD
      },
      foreignCorrelationId
    )
    await responseStatus(companyMemberAttempt, 403, 'un buyer no administra los datos fiscales')
  })
  expect(await protectedState(ownerState)).toEqual(beforeForeignAttempts)
  expect(await correlationSideEffects(foreignCorrelationId)).toEqual({ audits: 0, outbox: 0 })

  await enableMfa(request, attackerEmail)
  await test.step('MFA alone does not grant catalog or financial permissions', async () => {
    await responseStatus(
      await get(request, `/api/orders/${ownerOrderId}`),
      404,
      'MFA de cliente no permite leer pedidos de otra empresa'
    )
    await responseStatus(
      await post(request, `/api/admin/operations/bank-transfers/${guessedUuid}/reconcile`, {
        orderNumber: guessedOrder,
        reason: 'MFA sin rol'
      }),
      403,
      'MFA sin permiso financiero'
    )
    const unauthorizedUpload = await request.post('/api/admin/media', {
      multipart: { probe: 'authorization-only' },
      headers: { origin: ORIGIN }
    })
    await responseStatus(unauthorizedUpload, 403, 'MFA sin permiso de catálogo')
  })

  await test.step('internal roles keep their explicit store-wide least-privilege scope', async () => {
    await setInternalRole(attackerIdentityId, 'support', true)
    await responseStatus(await get(request, `/api/orders/${ownerOrderId}`), 200, 'support puede leer pedidos')
    await responseStatus(
      await post(request, `/api/admin/invoices/${ownerOrderId}/retry`, { reason: 'Support sin finanzas' }),
      403,
      'support no reintenta facturas'
    )
    await setInternalRole(attackerIdentityId, 'support', false)

    await setInternalRole(attackerIdentityId, 'warehouse', true)
    await responseStatus(await get(request, `/api/orders/${ownerOrderId}`), 200, 'warehouse puede leer pedidos')
    await responseStatus(
      await put(request, `/api/admin/orders/${ownerOrderId}`, {
        status: 'cancelado',
        reason: 'Warehouse sin administración'
      }),
      403,
      'warehouse no usa acciones reservadas al administrador'
    )
    await setInternalRole(attackerIdentityId, 'warehouse', false)

    await setInternalRole(attackerIdentityId, 'finance', true)
    await responseStatus(await get(request, `/api/orders/${ownerOrderId}`), 200, 'finance puede leer pedidos')
    await responseStatus(
      await post(request, `/api/admin/invoices/${ownerOrderId}/retry`, { reason: 'Validación de scope financiero' }),
      409,
      'finance atraviesa autorización pero no factura un pago pendiente'
    )
    await responseStatus(
      await put(request, `/api/admin/media/${guessedUuid}`, { decision: 'reject', reason: 'Finance sin catálogo' }),
      403,
      'finance no aprueba media'
    )
    await setInternalRole(attackerIdentityId, 'finance', false)
  })

  await databaseQuery(async (sql) => {
    await sql`
      INSERT INTO identity_roles (identity_id, role_code)
      VALUES (${attackerIdentityId}, 'admin')
      ON CONFLICT (identity_id, role_code) DO NOTHING
    `
  })
  const adminCompanyCorrelationId = deterministic.uuid('admin-company-success')
  await responseStatus(
    await put(
      request,
      `/api/admin/companies/${ownerCompanyId}`,
      {
        status: 'approved',
        reason: 'Revisión administrativa E2E'
      },
      adminCompanyCorrelationId
    ),
    200,
    'administrador MFA puede gestionar otra empresa'
  )
  const companyAudit = await databaseQuery(async (sql) => {
    const [row] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM audit_log
      WHERE actor_id = ${attackerIdentityId}
        AND action = 'company.status.changed'
        AND resource_id = ${ownerCompanyId}
        AND correlation_id = ${adminCompanyCorrelationId}
    `
    return row?.count ?? 0
  })
  expect(companyAudit).toBe(1)

  const beforeGuessedAdminAttempts = await protectedState(ownerState)
  const adminGuessCorrelationId = deterministic.uuid('admin-guessed-attempts')
  await test.step('an administrator gets no object or side effect from guessed identifiers', async () => {
    const attempts: Array<[string, Promise<APIResponse>, number]> = [
      [
        'guessed company',
        put(
          request,
          `/api/admin/companies/${guessedUuid}`,
          { status: 'approved', reason: 'ID inventado' },
          adminGuessCorrelationId
        ),
        404
      ],
      [
        'guessed order transition',
        put(
          request,
          `/api/admin/orders/${guessedOrder}`,
          { status: 'cancelado', reason: 'ID inventado' },
          adminGuessCorrelationId
        ),
        404
      ],
      [
        'guessed return/refund',
        put(
          request,
          `/api/admin/returns/${guessedReturn}`,
          {
            status: 'resolved',
            reason: 'ID inventado',
            resolution: 'No existe',
            refundAmountCents: 1
          },
          adminGuessCorrelationId
        ),
        404
      ],
      [
        'guessed invoice retry',
        post(request, `/api/admin/invoices/${guessedOrder}/retry`, { reason: 'ID inventado' }, adminGuessCorrelationId),
        404
      ],
      [
        'guessed bank movement',
        post(
          request,
          `/api/admin/operations/bank-transfers/${guessedUuid}/reconcile`,
          {
            orderNumber: guessedOrder,
            reason: 'ID inventado'
          },
          adminGuessCorrelationId
        ),
        404
      ],
      [
        'guessed media approval',
        put(
          request,
          `/api/admin/media/${guessedUuid}`,
          { decision: 'reject', reason: 'ID inventado' },
          adminGuessCorrelationId
        ),
        404
      ],
      ['guessed shipment PDF', get(request, `/api/admin/shipments/${guessedUuid}/label`, adminGuessCorrelationId), 404],
      [
        'guessed outbox retry',
        post(
          request,
          `/api/admin/operations/outbox/${guessedUuid}/retry`,
          { reason: 'ID inventado' },
          adminGuessCorrelationId
        ),
        409
      ]
    ]
    for (const [label, attempt, status] of attempts) await responseStatus(await attempt, status, label)

    const authorizedUpload = await request.post('/api/admin/media', {
      multipart: { probe: 'authorization-only' },
      headers: requestHeaders(adminGuessCorrelationId)
    })
    await responseStatus(authorizedUpload, 400, 'el admin atraviesa autorización pero no crea un upload inválido')
    await responseStatus(
      await get(request, `/api/account/privacy/${privacyRequestId}/download`, adminGuessCorrelationId),
      404,
      'el rol admin no permite descargar la exportación privada de otro cliente'
    )
  })
  expect(await protectedState(ownerState)).toEqual(beforeGuessedAdminAttempts)
  expect(await correlationSideEffects(adminGuessCorrelationId)).toEqual({ audits: 0, outbox: 0 })

  await test.step('the authorized upload endpoint confines and quarantines hostile files', async () => {
    const before = await databaseQuery(async (sql) => {
      const [row] = await sql<{ count: number }[]>`
        SELECT count(*)::int AS count FROM media_assets
        WHERE metadata ->> 'uploadedBy' = ${attackerIdentityId}
      `
      return row?.count ?? 0
    })
    const mismatched = await request.post('/api/admin/media', {
      multipart: {
        file: { name: '../../mismatch.png', mimeType: 'image/jpeg', buffer: uploadPng() },
        ownerName: 'NETECO E2E',
        license: 'Propia',
        altText: 'Imagen de seguridad',
        authorizedAt: '2026-08-13'
      },
      headers: requestHeaders()
    })
    await responseStatus(mismatched, 415, 'MIME falso')
    const oversized = await request.post('/api/admin/media', {
      multipart: {
        file: { name: '../../oversized.png', mimeType: 'image/png', buffer: Buffer.alloc(1001) },
        ownerName: 'NETECO E2E',
        license: 'Propia',
        altText: 'Imagen de seguridad',
        authorizedAt: '2026-08-13'
      },
      headers: requestHeaders()
    })
    await responseStatus(oversized, 413, 'upload sobredimensionado')
    expect(
      await databaseQuery(async (sql) => {
        const [row] = await sql<{ count: number }[]>`
          SELECT count(*)::int AS count FROM media_assets
          WHERE metadata ->> 'uploadedBy' = ${attackerIdentityId}
        `
        return row?.count ?? 0
      })
    ).toBe(before)

    const accepted = await request.post('/api/admin/media', {
      multipart: {
        file: { name: '../../escape.png', mimeType: 'image/png', buffer: uploadPng() },
        ownerName: 'NETECO E2E',
        license: 'Propia',
        altText: 'Imagen de seguridad',
        authorizedAt: '2026-08-13'
      },
      headers: requestHeaders()
    })
    await responseStatus(accepted, 201, 'upload confinado')
    const result = (await accepted.json()) as { id: string; quarantineStatus: string; canApprove: boolean }
    expect(result).toMatchObject({ quarantineStatus: 'pending', canApprove: false })
    const asset = await databaseQuery(async (sql) => {
      const [row] = await sql<{ storageKey: string; originalName: string; rightsStatus: string }[]>`
        SELECT storage_key AS "storageKey", original_name AS "originalName", rights_status AS "rightsStatus"
        FROM media_assets WHERE id = ${result.id}
      `
      return row
    })
    expect(asset).toMatchObject({ originalName: '../../escape.png', rightsStatus: 'pending' })
    expect(asset!.storageKey).toMatch(/^quarantine\/[0-9a-f-]+-escape-png\.png$/)
    const storageRoot = resolve('.data/e2e-media')
    const storedPath = resolve(storageRoot, asset!.storageKey)
    expect(relative(storageRoot, storedPath)).not.toMatch(/^\.\.(?:\/|$)/)
    expect((await readFile(storedPath)).includes(Buffer.from('private metadata'))).toBe(false)
    await unlink(storedPath)
    await databaseQuery((sql) => sql`DELETE FROM media_assets WHERE id = ${result.id}`)
  })

  expect(ownerIdentityId).not.toBe(attackerIdentityId)
})

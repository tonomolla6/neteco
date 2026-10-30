import { readFile, readdir } from 'node:fs/promises'
import { expect, it, vi } from 'vitest'
import { returnsFixture, CLAIMS, BUYER_CLAIMS, CUSTOMER, utc } from './d1-returns-fixture'
import { splitDemoSql } from '../../scripts/lib/d1-demo-sql'
import {
  executeD1SalesQuoteCommand,
  readD1AdminSalesQuote,
  convertD1SalesQuote
} from '../../workers/catalog/sales-quotes'
import { createCart, setCartLine, quoteCart } from '../../workers/catalog/cart'
import { deriveOrderToken, requestShippingOptions } from '../../workers/catalog/checkout'
import { processRedsysNotification } from '../../workers/catalog/payments'
import {
  decodeMerchantParameters,
  encodeMerchantParameters,
  signMerchantParameters,
  verifyMerchantSignature
} from '../../workers/payments/redsys'
import { configuredPayGoldIssue } from '../../workers/payments/paygold-runtime'
import { REDSYS_OFFICIAL_CONTRACT } from '../fixtures/redsys-official'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import worker from '../../workers/canary'
import { createFakePayGoldService } from './paygold-fake-fixture'

it('links an approved quote to the real checkout intent and reconciles its signed callback through checkout', async () => {
  const f = await returnsFixture()
  try {
    const dir = new URL('../../db/d1/migrations/', import.meta.url)
    const migrations = (await readdir(dir))
      .filter(
        (name) =>
          /^\d{4}_[a-z0-9_]+\.sql$/.test(name) && Number(name.slice(0, 4)) >= 63 && Number(name.slice(0, 4)) <= 89
      )
      .sort()
    for (const name of migrations)
      await f.database.batch(
        splitDemoSql(await readFile(new URL(name, dir), 'utf8')).map((sql) => f.database.prepare(sql))
      )
    f.sqlite.exec(await readFile('db/d1/migrations/0126_payment_extended.sql', 'utf8'))
    f.sqlite.exec(
      "INSERT INTO permissions VALUES('catalog.write','catalog','write','Synthetic commercial review'); INSERT INTO role_permissions VALUES('operator','catalog.write')"
    )
    f.sqlite
      .prepare(
        "INSERT INTO identity_mfa(identity_id,encrypted_secret,recovery_code_hashes,verified_at,updated_at) VALUES(?,'synthetic','[]',?,?)"
      )
      .run(CLAIMS.identityId, utc(-60000), utc(-60000))
    const reason = 'Synthetic commercial draft reviewed explicitly'
    const definition = {
      customerId: CUSTOMER,
      lines: [{ variantId: 'v-1-1', quantity: 2 }],
      destination: { city: 'Ontinyent', postalCode: '46870' },
      shippingMethod: 'pickup' as const,
      validUntil: utc(1800000),
      reason
    }
    const created = await executeD1SalesQuoteCommand(f.database, CLAIMS, 'create', null, definition, {
      idempotencyKey: crypto.randomUUID()
    })
    const reviewed = await executeD1SalesQuoteCommand(
      f.database,
      CLAIMS,
      'review',
      created.quoteId,
      { expectedVersion: created.version, reason },
      { idempotencyKey: crypto.randomUUID() }
    )
    const review = await readD1AdminSalesQuote(f.database, CLAIMS, created.quoteId)
    await executeD1SalesQuoteCommand(
      f.database,
      CLAIMS,
      'approve',
      created.quoteId,
      { expectedVersion: reviewed.version, reviewedHash: review.reviewedHash, reason },
      { idempotencyKey: crypto.randomUUID() }
    )
    const approved = await readD1AdminSalesQuote(f.database, CLAIMS, created.quoteId)
    if (!approved.approvedHash || !approved.total) throw new Error('missing quote approval')
    const now = utc(),
      cart = await createCart(f.database, { now, correlationId: 'paygold-integration' }),
      common = { cartId: cart.cartId, token: cart.token, now, correlationId: 'paygold-integration' }
    await setCartLine(f.database, {
      ...common,
      expectedVersion: 1,
      variantId: 'v-1-1',
      quantity: 2,
      idempotencyKey: crypto.randomUUID()
    })
    const cartQuote = await quoteCart(f.database, {
      ...common,
      expectedVersion: 2,
      idempotencyKey: crypto.randomUUID()
    })
    const shipping = await requestShippingOptions(f.database, {
      ...common,
      expectedVersion: 2,
      destination: definition.destination,
      idempotencyKey: crypto.randomUUID()
    })
    if (cartQuote.outcome !== 'quoted' || shipping.outcome !== 'options') throw new Error('checkout fixture')
    const option = (
      shipping.body.options as Array<{ methodCode: string; optionIndex: number; optionHash: string }>
    ).find((x) => x.methodCode === 'pickup')!
    const converted = await convertD1SalesQuote(
      f.database,
      BUYER_CLAIMS,
      created.quoteId,
      {
        expectedVersion: approved.version,
        approvedHash: approved.approvedHash,
        checkout: {
          ...common,
          expectedVersion: 2,
          quoteId: cartQuote.quote.quoteId,
          shippingQuoteId: String(shipping.body.shippingQuoteId),
          selectedOptionIndex: option.optionIndex,
          selectedOptionHash: option.optionHash,
          expectedTotalGrossCents: approved.total.grossCents,
          contactEmail: 'buyer@example.invalid',
          shippingAddress: {
            recipientName: 'Synthetic buyer',
            line1: 'Synthetic street 1',
            city: 'Ontinyent',
            province: 'Valencia',
            postalCode: '46870',
            phone: '+34600111222'
          },
          consentTos: true,
          consentPrivacy: true,
          ownerSession: BUYER_CLAIMS,
          idempotencyKey: crypto.randomUUID()
        }
      },
      { idempotencyKey: crypto.randomUUID() }
    )
    const orderId = converted.orderId!,
      orderToken = await deriveOrderToken(cart.token, orderId),
      expiresAt = utc(120000),
      commandId = crypto.randomUUID()
    const configuration = {
      environment: 'sandbox' as const,
      merchantCode: REDSYS_OFFICIAL_CONTRACT.sandbox.merchantCode,
      terminal: '1',
      secretKey: REDSYS_OFFICIAL_CONTRACT.sandbox.secretKey,
      merchantName: 'NETECO',
      publicBaseUrl: 'https://shop.example.test'
    }
    const fake = createFakePayGoldService('https://paygold.example.test')
    const service = vi.fn(async (request: Request) => {
      const body = (await request.clone().json()) as {
        redirect: { fields: { Ds_MerchantParameters: string; Ds_Signature: string } }
        expiresAt: string
        amountCents: number
      }
      expect(
        await verifyMerchantSignature(
          body.redirect.fields.Ds_MerchantParameters,
          body.redirect.fields.Ds_Signature,
          configuration.secretKey
        )
      ).toBe(true)
      expect(Number(decodeMerchantParameters(body.redirect.fields.Ds_MerchantParameters).DS_MERCHANT_AMOUNT)).toBe(
        approved.total!.grossCents
      )
      return fake.fetch(request)
    })
    const issue = configuredPayGoldIssue(
      {
        DB: f.database,
        PAYGOLD_ENABLED: 'true',
        PAYGOLD_PROVIDER_ORIGIN: 'https://paygold.example.test',
        PAYGOLD_SERVICE: { fetch: service }
      },
      configuration,
      utc
    )!
    const input = {
      quoteId: created.quoteId,
      expectedVersion: converted.version,
      orderId,
      orderToken,
      commandId,
      expiresAt
    }
    const cookieConfig = { password: 'synthetic-paygold-cookie-password-over-32-characters', maxAgeSeconds: 3600 }
    const cookie = (await issueD1SessionCookie(f.database, BUYER_CLAIMS, cookieConfig))!.split(';')[0]!
    const runtime = {
      APP_ENV: 'local',
      AUTH_ENABLED: 'true',
      AUTH_ORIGIN: configuration.publicBaseUrl,
      NUXT_SESSION_PASSWORD: cookieConfig.password,
      CART_EDGE_LIMIT: { limit: async () => ({ success: true }) },
      AUTH_RATE_LIMIT_PEPPER: 'synthetic-paygold-edge-pepper-over-32-characters',
      DB: f.database,
      REDSYS_ENABLED: 'true',
      REDSYS_ENVIRONMENT: configuration.environment,
      REDSYS_SECRET_KEY: configuration.secretKey,
      REDSYS_MERCHANT_CODE: configuration.merchantCode,
      REDSYS_TERMINAL: configuration.terminal,
      PAYMENT_PUBLIC_BASE_URL: configuration.publicBaseUrl,
      PAYGOLD_ENABLED: 'true',
      PAYGOLD_PROVIDER_ORIGIN: 'https://paygold.example.test',
      PAYGOLD_SERVICE: { fetch: service }
    } as unknown as CloudflareEnv
    const orderResponse = await worker.fetch(
      new Request(`${configuration.publicBaseUrl}/api/orders/${orderId}`, {
        headers: { cookie, 'cf-connecting-ip': '192.0.2.10' }
      }),
      runtime
    )
    expect(orderResponse.status).toBe(200)
    expect(await orderResponse.json()).toMatchObject({
      id: orderId,
      orderStatus: 'awaiting_payment',
      inventoryStatus: 'reserved',
      reservationExpiresAt: expect.any(String),
      total: approved.total.grossCents
    })
    const createRequest = () =>
      new Request(`${configuration.publicBaseUrl}/api/account/paygold-links`, {
        method: 'POST',
        headers: {
          origin: configuration.publicBaseUrl,
          cookie: `${cookie}; neteco-cart-v2=v1.${cart.cartId}.${cart.token}`,
          'content-type': 'application/json',
          'idempotency-key': commandId
        },
        body: JSON.stringify({
          quoteId: created.quoteId,
          expectedVersion: converted.version,
          orderId,
          commandId,
          expiresAt
        })
      })
    // The fake accepted the command but the client did not receive its reply.
    // A new page must find the same command and retry without a second charge.
    service.mockImplementationOnce(async (request) => {
      await fake.fetch(request)
      throw new Error('synthetic interruption')
    })
    expect((await worker.fetch(createRequest(), runtime)).status).toBe(503)
    const recovery = await worker.fetch(
      new Request(
        `${configuration.publicBaseUrl}/api/account/paygold-links/recover?quoteId=${created.quoteId}&orderId=${orderId}`,
        {
          headers: { cookie: `${cookie}; neteco-cart-v2=v1.${cart.cartId}.${cart.token}` }
        }
      ),
      runtime
    )
    expect(recovery.status).toBe(200)
    expect(await recovery.json()).toEqual({
      attempt: {
        quoteId: created.quoteId,
        orderId,
        expectedVersion: converted.version,
        commandId,
        expiresAt
      }
    })
    const response = await worker.fetch(createRequest(), runtime)
    expect(response.status).toBe(201)
    const result = (await response.json()) as Awaited<ReturnType<typeof issue>>
    expect(await issue(BUYER_CLAIMS, input)).toEqual(result)
    expect(service).toHaveBeenCalledTimes(2)
    expect(fake.redeem(result.url, utc())).toMatchObject({ method: 'POST' })
    expect(fake.redeem(result.url, expiresAt)).toBeNull()
    const intent = f.sqlite
      .prepare('SELECT merchant_order,amount_gross_cents FROM payment_intents WHERE id=?')
      .get(result.paymentIntentId) as { merchant_order: string; amount_gross_cents: number }
    const fields = {
      Ds_Order: intent.merchant_order,
      Ds_Amount: String(intent.amount_gross_cents),
      Ds_Currency: '978',
      Ds_MerchantCode: configuration.merchantCode,
      Ds_Terminal: '1',
      Ds_TransactionType: '0',
      Ds_Response: '0000'
    }
    const wrong = encodeMerchantParameters({ ...fields, Ds_Amount: String(intent.amount_gross_cents + 1) })
    const mismatch = {
      Ds_MerchantParameters: wrong,
      Ds_SignatureVersion: 'HMAC_SHA512_V2',
      Ds_Signature: await signMerchantParameters(wrong, configuration.secretKey)
    }
    expect(
      await processRedsysNotification(f.database, mismatch, configuration, {
        correlationId: 'paygold-mismatch-test',
        now: utc()
      })
    ).toEqual({ outcome: 'mismatch' })
    expect(
      f.sqlite
        .prepare('SELECT status FROM inventory_reservations WHERE id=(SELECT reservation_id FROM orders WHERE id=?)')
        .get(orderId)
    ).toMatchObject({ status: 'reserved' })
    const parameters = encodeMerchantParameters(fields)
    const notification = {
      Ds_MerchantParameters: parameters,
      Ds_SignatureVersion: 'HMAC_SHA512_V2',
      Ds_Signature: await signMerchantParameters(parameters, configuration.secretKey)
    }
    expect(
      await processRedsysNotification(f.database, notification, configuration, {
        correlationId: 'paygold-webhook-test',
        now: utc()
      })
    ).toEqual({ outcome: 'captured' })
    expect(
      await processRedsysNotification(f.database, notification, configuration, {
        correlationId: 'paygold-webhook-replay',
        now: utc()
      })
    ).toEqual({ outcome: 'captured' })
    expect(
      f.sqlite.prepare("SELECT count(*) n FROM payment_events WHERE order_id=? AND event_type='captured'").get(orderId)
    ).toMatchObject({ n: 1 })
    expect(
      f.sqlite.prepare('SELECT status,paid_gross_cents FROM order_payment_states WHERE order_id=?').get(orderId)
    ).toMatchObject({ status: 'paid', paid_gross_cents: approved.total.grossCents })
    expect(
      f.sqlite
        .prepare('SELECT status FROM inventory_reservations WHERE id=(SELECT reservation_id FROM orders WHERE id=?)')
        .get(orderId)
    ).toMatchObject({ status: 'assigned' })
    await expect(issue(BUYER_CLAIMS, input)).rejects.toMatchObject({ code: 'already_paid' })
  } finally {
    f.sqlite.close()
  }
})

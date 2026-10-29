import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { expect, it, vi } from 'vitest'
import { Miniflare, convertV4MiniflareOptions, NoOpLog } from 'miniflare'
import worker from '../../workers/canary'
import { splitDemoSql } from '../../scripts/lib/d1-demo-sql'
import { seedInventoryFixture } from '../support/d1-sqlite'
import { provisionPublicationValidityFixture } from '../support/publication-validity-fixture'
import { createCart, setCartLine, quoteCart } from '../../workers/catalog/cart'
import { requestShippingOptions, placeOrder } from '../../workers/catalog/checkout'
import { initiateRedsysPayment, processRedsysNotification } from '../../workers/catalog/payments'
import { assignReservation } from '../../workers/catalog/inventory'
import { executeD1AdminFulfillmentCommand } from '../../workers/fulfillment/admin'
import { encodeMerchantParameters, signMerchantParameters } from '../../workers/payments/redsys'
import { REDSYS_OFFICIAL_CONTRACT } from '../fixtures/redsys-official'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import {
  createSupportTicket,
  executeSupportAdminCommand,
  supportActor,
  supportClock
} from '../../workers/support/operations'
import {
  satisfactionIntentHash,
  satisfactionReceiptSchema,
  customerSatisfactionSchema,
  adminSatisfactionResponseSchema
} from '../../shared/support-satisfaction'
import { GUEST_ORDER_COOKIE } from '../../workers/catalog/guest-order-access'
import { CONTACT, POLICY } from './d1-support-fixture'

it('executes resolved support and delivered order CSAT through actual canary.fetch and workerd D1, with no economic effects', async () => {
  const outbound = vi.fn(() => {
    throw new Error('unexpected_outbound')
  })
  const runtime = new Miniflare(
    convertV4MiniflareOptions({
      name: 'support-satisfaction-native',
      modules: true,
      script: 'export default {fetch(){return new Response("isolated")}}',
      compatibilityDate: '2026-08-15',
      compatibilityFlags: ['nodejs_compat'],
      cf: false,
      telemetry: { enabled: false },
      log: new NoOpLog(),
      d1Databases: { DB: '00000000-0000-4000-8000-000000000068' },
      outboundService: outbound
    })
  )
  try {
    const database = (await runtime.getD1Database('DB')) as unknown as D1Database
    for (const name of (await readdir('db/d1/migrations')).filter((name) => /^\d+.*\.sql$/.test(name)).sort()) {
      const statements = splitDemoSql(await readFile(join('db/d1/migrations', name), 'utf8'))
      for (let offset = 0; offset < statements.length; offset += 50)
        await database.batch(statements.slice(offset, offset + 50).map((sql) => database.prepare(sql)))
    }
    const seeds: D1PreparedStatement[] = []
    seedInventoryFixture({
      exec(sql: string) {
        for (const text of splitDemoSql(sql)) seeds.push(database.prepare(text))
      },
      prepare(sql: string) {
        return {
          run(...args: unknown[]) {
            seeds.push(database.prepare(sql).bind(...args))
          }
        }
      }
    } as unknown as DatabaseSync)
    await database.batch(seeds)
    const identity = crypto.randomUUID(),
      customer = crypto.randomUUID(),
      session = crypto.randomUUID()
    const claims = { identityId: identity, sessionId: session, sessionVersion: 1 }
    const instant = (await database
      .prepare("SELECT strftime('%Y-%m-%dT%H:%M:%SZ','now') AS now")
      .first<{ now: string }>())!.now
    await database.batch([
      database
        .prepare(
          "INSERT INTO customers(id,created_at,updated_at) VALUES(?,'2020-01-01T00:00:00Z','2020-01-01T00:00:00Z')"
        )
        .bind(customer),
      database
        .prepare(
          "INSERT INTO identities(id,email,password_hash,email_verified_at,status,customer_id,created_at,updated_at) VALUES(?,'native-csat@example.invalid','synthetic','2020-01-01T00:00:00Z','active',?,'2020-01-01T00:00:00Z','2020-01-01T00:00:00Z')"
        )
        .bind(identity, customer),
      database
        .prepare(
          "INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at) VALUES(?,?,1,1,'2020-01-01T00:00:00Z','2099-01-01T00:00:00Z')"
        )
        .bind(session, identity),
      database.prepare("INSERT INTO roles VALUES('csat-native','Synthetic','Synthetic')"),
      database.prepare(
        "INSERT INTO permissions VALUES('administration.manage','administration','manage','Synthetic'),('support.manage','support','manage','Synthetic')"
      ),
      database.prepare(
        "INSERT INTO role_permissions VALUES('csat-native','administration.manage'),('csat-native','support.manage')"
      ),
      database
        .prepare(
          "INSERT INTO identity_roles(identity_id,role_code,granted_at) VALUES(?,'csat-native','2020-01-01T00:00:00Z')"
        )
        .bind(identity),
      database.prepare(
        "INSERT INTO shipping_zones(id,code,name,kind,postal_prefixes,active,created_at) VALUES('csat-pickup','csat-pickup','Synthetic','warehouse_pickup','[]',1,'2020-01-01T00:00:00Z')"
      ),
      database.prepare(
        "INSERT INTO shipping_rates(id,zone_id,method_code,service_profile,net_cents,tax_rate_basis_points,eta_min_days,eta_max_days,rate_version,active,created_at) VALUES('csat-rate','csat-pickup','pickup','parcel',0,2100,0,0,1,1,'2020-01-01T00:00:00Z')"
      )
    ])
    await provisionPublicationValidityFixture(database, {
      productIds: ['p-1'],
      now: '2020-01-01T00:00:00Z',
      validUntil: '2099-01-01T00:00:00Z'
    })
    const cart = await createCart(database, { correlationId: 'csat-native', now: instant })
    await setCartLine(database, {
      cartId: cart.cartId,
      token: cart.token,
      variantId: 'v-1-1',
      quantity: 1,
      expectedVersion: 1,
      idempotencyKey: 'csat-add',
      correlationId: 'csat-native',
      now: instant
    })
    const shipping = await requestShippingOptions(database, {
      cartId: cart.cartId,
      token: cart.token,
      expectedVersion: 2,
      idempotencyKey: 'csat-shipping',
      correlationId: 'csat-native',
      now: instant,
      destination: { city: 'Ontinyent', postalCode: '46870' }
    })
    const quote = await quoteCart(database, {
      cartId: cart.cartId,
      token: cart.token,
      expectedVersion: 2,
      idempotencyKey: 'csat-quote',
      correlationId: 'csat-native',
      now: instant
    })
    if (shipping.outcome !== 'options' || quote.outcome !== 'quoted')
      throw new Error('native_csat_checkout_unconfirmed')
    const option = (shipping.body.options as Array<{ optionIndex: number; optionHash: string }>)[0]!
    const placed = await placeOrder(database, {
      cartId: cart.cartId,
      token: cart.token,
      expectedVersion: 2,
      quoteId: quote.quote.quoteId,
      shippingQuoteId: String(shipping.body.shippingQuoteId),
      selectedOptionIndex: option.optionIndex,
      selectedOptionHash: option.optionHash,
      contactEmail: 'native-csat@example.invalid',
      shippingAddress: {
        recipientName: 'Synthetic Person',
        line1: 'Synthetic Street 1',
        city: 'Ontinyent',
        province: 'València',
        postalCode: '46870',
        phone: '+34600000000',
        countryCode: 'ES'
      },
      consentTos: true,
      consentPrivacy: true,
      idempotencyKey: 'csat-checkout',
      correlationId: 'csat-native',
      now: instant,
      ownerSession: claims
    })
    if (placed.outcome !== 'order_created') throw new Error('native_csat_order_missing')
    const orderId = String(placed.body.id),
      orderToken = String(placed.body.orderToken)
    // Same offline signed sandbox-notification fixture as returnsFixture. No
    // provider is contacted; delivery is produced by real governed commands.
    const paymentConfiguration = {
      environment: 'sandbox' as const,
      merchantCode: REDSYS_OFFICIAL_CONTRACT.sandbox.merchantCode,
      terminal: REDSYS_OFFICIAL_CONTRACT.sandbox.terminal,
      secretKey: REDSYS_OFFICIAL_CONTRACT.sandbox.secretKey,
      merchantName: 'NETECO',
      bizumEnabled: false,
      publicBaseUrl: 'https://csat.neteco.test'
    }
    await initiateRedsysPayment(
      database,
      { orderId, orderToken, method: 'card', now: instant, correlationId: 'csat-native', idempotencyKey: 'csat-pay' },
      paymentConfiguration
    )
    const intent = (await database
      .prepare('SELECT merchant_order,amount_gross_cents FROM payment_intents WHERE order_id=?')
      .bind(orderId)
      .first<{ merchant_order: string; amount_gross_cents: number }>())!
    const parameters = encodeMerchantParameters({
      Ds_Order: intent.merchant_order,
      Ds_Amount: String(intent.amount_gross_cents),
      Ds_Currency: '978',
      Ds_MerchantCode: paymentConfiguration.merchantCode,
      Ds_Terminal: paymentConfiguration.terminal,
      Ds_TransactionType: '0',
      Ds_Response: '0000'
    })
    await processRedsysNotification(
      database,
      {
        Ds_MerchantParameters: parameters,
        Ds_SignatureVersion: 'HMAC_SHA512_V2',
        Ds_Signature: await signMerchantParameters(parameters, paymentConfiguration.secretKey)
      },
      paymentConfiguration,
      { correlationId: 'csat-native', now: instant },
      { assign: (payload) => assignReservation(database, payload) }
    )
    for (const [expectedVersion, action] of ['picking', 'packed', 'ready_for_pickup', 'delivered'].entries())
      await executeD1AdminFulfillmentCommand(
        database,
        claims,
        orderId,
        {
          action,
          expectedVersion,
          reason: 'Entrega sintética documentada',
          ...(action === 'delivered' ? { evidence: 'Recogida sintética confirmada' } : {})
        },
        { idempotencyKey: `csat:${action}` }
      )
    const ticket = await createSupportTicket(
      database,
      await supportActor(database, claims, 'customer', supportClock()),
      { ...CONTACT, orderId },
      { idempotencyKey: crypto.randomUUID(), policy: POLICY }
    )
    await executeSupportAdminCommand(
      database,
      claims,
      ticket.publicRef,
      {
        action: 'update',
        expectedVersion: 1,
        state: 'resolved',
        priority: 'normal',
        ownerId: null,
        nextActionAt: null,
        slaDueAt: null,
        reason: 'Resolución sintética revisada',
        resolution: 'Respuesta sintética completa al caso.'
      },
      { idempotencyKey: crypto.randomUUID() }
    )
    const origin = 'https://csat.neteco.test',
      password = 'synthetic-csat-cookie-password-more-than-32'
    const cookie = (await issueD1SessionCookie(database, claims, { password, maxAgeSeconds: 3600 }))!.split(';')[0]!
    const otherIdentity = crypto.randomUUID(),
      otherCustomer = crypto.randomUUID(),
      otherSession = crypto.randomUUID()
    await database.batch([
      database
        .prepare(
          "INSERT INTO customers(id,created_at,updated_at) VALUES(?,'2020-01-01T00:00:00Z','2020-01-01T00:00:00Z')"
        )
        .bind(otherCustomer),
      database
        .prepare(
          "INSERT INTO identities(id,email,password_hash,email_verified_at,status,customer_id,created_at,updated_at) VALUES(?,'native-other-csat@example.invalid','synthetic','2020-01-01T00:00:00Z','active',?,'2020-01-01T00:00:00Z','2020-01-01T00:00:00Z')"
        )
        .bind(otherIdentity, otherCustomer),
      database
        .prepare(
          "INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at) VALUES(?,?,1,0,'2020-01-01T00:00:00Z','2099-01-01T00:00:00Z')"
        )
        .bind(otherSession, otherIdentity)
    ])
    const otherCookie = (await issueD1SessionCookie(
      database,
      { identityId: otherIdentity, sessionId: otherSession, sessionVersion: 1 },
      { password, maxAgeSeconds: 3600 }
    ))!.split(';')[0]!
    const env = {
      APP_ENV: 'local',
      AUTH_ENABLED: 'true',
      SUPPORT_ENABLED: 'true',
      SUPPORT_POLICY: JSON.stringify(POLICY),
      DB: database,
      AUTH_ORIGIN: origin,
      NUXT_SESSION_PASSWORD: password,
      AUTH_RATE_LIMIT_PEPPER: 'synthetic-csat-rate-pepper-more-than-32',
      CART_EDGE_LIMIT: { limit: async () => ({ success: true }) },
      ADMIN_EDGE_LIMIT: { limit: async () => ({ success: true }) }
    } as unknown as CloudflareEnv
    const context = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext
    const dispatch = (path: string, init: RequestInit = {}) =>
      worker.fetch(
        new Request(origin + path, {
          ...init,
          headers: { cookie, 'CF-Connecting-IP': '192.0.2.149', ...Object.fromEntries(new Headers(init.headers)) }
        }),
        env,
        context
      )
    const tables = [
      'orders',
      'order_lines',
      'order_events',
      'order_fulfillments',
      'order_fulfillment_commands',
      'order_fulfillment_audit',
      'inventory_balances',
      'inventory_movements',
      'inventory_reservations',
      'inventory_reservation_lines',
      'payment_intents',
      'order_payment_states',
      'payment_events',
      'auth_sessions',
      'identities',
      'identity_roles',
      'role_permissions'
    ]
    const snapshot = () =>
      Promise.all(
        tables.map(async (table) => (await database.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()).results)
      )
    const before = await snapshot()
    for (const [kind, id] of [
      ['support', ticket.publicRef],
      ['delivery', orderId]
    ] as const) {
      const path = `/api/account/satisfaction/${kind}/${id}`
      const read = await dispatch(path)
      expect(read.status).toBe(200)
      const state = customerSatisfactionSchema.parse(await read.json())
      expect(state.eligible).toBe(true)
      const body = {
        score: 4,
        comment: 'Comentario privado sintético',
        privacyAcknowledged: true as const,
        expectedSourceVersion: state.target.version,
        expectedPolicyHash: state.privacy!.policyHash
      }
      const key = crypto.randomUUID(),
        hash = await satisfactionIntentHash(kind, id, body)
      const init = {
        method: 'POST',
        headers: { origin, 'Content-Type': 'application/json', 'Idempotency-Key': key },
        body: JSON.stringify(body)
      }
      const posted = await dispatch(path, init)
      expect(posted.status).toBe(201)
      const receipt = satisfactionReceiptSchema.parse(await posted.json())
      expect(receipt).toMatchObject({
        commandId: key,
        payloadHash: hash,
        target: { kind, id },
        score: 4,
        inventoryEffect: 'none',
        economicEffect: 'none'
      })
      expect(JSON.stringify(receipt)).not.toContain(body.comment)
      const replay = await dispatch(path, init)
      expect(replay.status).toBe(201)
      expect(await replay.json()).toEqual(receipt)
      const recovery = await dispatch(`${path}/commands/${key}`, { headers: { 'X-Neteco-Command-Payload-Hash': hash } })
      expect(recovery.status).toBe(200)
      expect(await recovery.json()).toEqual({ source: 'cloudflare', outcome: 'applied', receipt })
      expect((await dispatch(path, { headers: { cookie: otherCookie } })).status).toBe(404)
      expect(
        (
          await dispatch(`${path}/commands/${key}`, {
            headers: { cookie: otherCookie, 'X-Neteco-Command-Payload-Hash': hash }
          })
        ).status
      ).toBe(404)
      const unknown = await dispatch(`${path}/commands/${crypto.randomUUID()}`, {
        headers: { 'X-Neteco-Command-Payload-Hash': hash }
      })
      expect(unknown.status).toBe(200)
      expect(await unknown.json()).toEqual({ source: 'cloudflare', outcome: 'unknown' })
    }
    const summary = await dispatch('/api/admin/support/satisfaction')
    expect(summary.status).toBe(200)
    const result = adminSatisfactionResponseSchema.parse(await summary.json())
    expect(result).toMatchObject({ total: 2, commentsIncluded: false })
    expect(result.items.every((item) => item.comment === null)).toBe(true)
    expect(await snapshot()).toEqual(before)
    expect(await database.prepare('SELECT count(*) AS n FROM support_satisfaction_commands').first()).toEqual({ n: 2 })
    const guest = await dispatch(`/api/account/satisfaction/delivery/${orderId}`, {
      method: 'POST',
      headers: {
        cookie: `${GUEST_ORDER_COOKIE}=synthetic-view-only`,
        origin,
        'Content-Type': 'application/json',
        'Idempotency-Key': crypto.randomUUID()
      },
      body: JSON.stringify({ score: 5, expectedSourceVersion: 4, privacyAcknowledged: true })
    })
    expect([401, 403]).toContain(guest.status)
    expect(await database.prepare('SELECT count(*) AS n FROM support_satisfaction_commands').first()).toEqual({ n: 2 })
    expect(outbound).not.toHaveBeenCalled()
  } finally {
    await runtime.dispose()
  }
}, 30000)

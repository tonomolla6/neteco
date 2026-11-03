import { randomBytes, randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { build } from 'esbuild'
import { Miniflare, convertV4MiniflareOptions, NoOpLog } from 'miniflare'
import { expect, it, vi } from 'vitest'
import { splitDemoSql } from '../../scripts/lib/d1-demo-sql'
import { seedInventoryFixture } from '../support/d1-sqlite'
import { provisionPublicationValidityFixture } from '../support/publication-validity-fixture'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import { createCart, setCartLine } from '../../workers/catalog/cart'
import { adminPromotionReceiptSchema } from '../../shared/admin-promotions'
import { promotionBasketPreviewResponseSchema } from '../../shared/promotion-basket-preview'
import { REDSYS_OFFICIAL_CONTRACT } from '../fixtures/redsys-official'
import { returnsFixture, BUYER_CLAIMS, REQUEST } from './d1-returns-fixture'
import { requestD1CustomerReturn } from '../../workers/returns/operations'

it('preserves a real pre-coupon order and RMA when SQLite upgrades the contractual line tables', async () => {
  const fixture = await returnsFixture()
  try {
    const orderId = await fixture.order()
    await requestD1CustomerReturn(fixture.database, BUYER_CLAIMS, orderId, REQUEST, { idempotencyKey: randomUUID() })
    const tables = [
      'orders',
      'order_lines',
      'checkout_quote_lines',
      'order_returns',
      'order_return_lines',
      'order_return_commands'
    ]
    const before = tables.map((table) => fixture.sqlite.prepare('SELECT * FROM ' + table + ' ORDER BY 1,2').all())
    const triggers = [
      'order_return_lines_insert_budget',
      'order_return_lines_update_budget',
      'order_return_commands_transition',
      'refund_allocation_line_budget'
    ]
    const definitions = triggers.map(
      (name) => fixture.sqlite.prepare('SELECT sql FROM sqlite_schema WHERE name=?').get(name)?.sql
    )
    expect(definitions.every((sql) => typeof sql === 'string')).toBe(true)
    await fixture.database.batch(
      splitDemoSql(await readFile('db/d1/migrations/0072_promotions.sql', 'utf8')).map((sql) =>
        fixture.database.prepare(sql)
      )
    )
    for (const [index, table] of tables.entries()) {
      const after = fixture.sqlite.prepare('SELECT * FROM ' + table + ' ORDER BY 1,2').all()
      if (table === 'order_lines' || table === 'checkout_quote_lines') {
        expect(
          after.map(({ discount_gross_cents, ...historical }) => {
            expect(discount_gross_cents).toBe(0)
            return historical
          })
        ).toEqual(before[index])
      } else expect(after).toEqual(before[index])
    }
    expect(fixture.sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    for (const name of triggers)
      expect(fixture.sqlite.prepare('SELECT sql FROM sqlite_schema WHERE name=?').get(name)?.sql).toEqual(
        expect.any(String)
      )
    // The rebuilt budget trigger must still reject a real overclaim, not just exist by name.
    expect(() =>
      fixture.sqlite.prepare('UPDATE order_return_lines SET claimed_quantity=999 WHERE order_id=?').run(orderId)
    ).toThrow('order_return_quantity_unavailable')
    expect(() =>
      fixture.sqlite.prepare('UPDATE order_lines SET gross_cents=gross_cents WHERE order_id=?').run(orderId)
    ).toThrow('contractual snapshots')
  } finally {
    fixture.sqlite.close()
  }
})

it('executes governed promotions, buyer PO and coupon checkout through actual canary, workerd D1/all74 and the real cart DO', async () => {
  const origin = 'https://promotions-native.neteco.test',
    password = randomBytes(32).toString('hex')
  const outbound = vi.fn(() => {
    throw new Error('unexpected_outbound')
  })
  const bundle = await build({
    stdin: {
      resolveDir: process.cwd(),
      sourcefile: 'promotions-native-entry.ts',
      loader: 'ts',
      contents: "export { default, CartCoordinator } from './workers/canary'"
    },
    bundle: true,
    platform: 'browser',
    format: 'esm',
    external: ['node:*', 'cloudflare:*'],
    write: false,
    logLevel: 'silent'
  })
  const runtime = new Miniflare(
    convertV4MiniflareOptions({
      name: 'promotions-native',
      modules: true,
      script: bundle.outputFiles[0]!.text,
      compatibilityDate: '2026-08-15',
      compatibilityFlags: ['nodejs_compat'],
      cf: false,
      telemetry: { enabled: false },
      log: new NoOpLog(),
      bindings: {
        APP_ENV: 'local',
        FREE_SHIPPING_THRESHOLD_CENTS: '1000',
        AUTH_ENABLED: 'true',
        AUTH_ORIGIN: origin,
        NUXT_SESSION_PASSWORD: password,
        AUTH_TOKEN_PEPPER: randomBytes(32).toString('hex'),
        AUTH_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
        AUTH_RATE_LIMIT_PEPPER: randomBytes(32).toString('hex'),
        REDSYS_ENABLED: 'true',
        REDSYS_ENVIRONMENT: 'sandbox',
        REDSYS_SECRET_KEY: REDSYS_OFFICIAL_CONTRACT.sandbox.secretKey,
        REDSYS_MERCHANT_CODE: REDSYS_OFFICIAL_CONTRACT.sandbox.merchantCode,
        REDSYS_TERMINAL: REDSYS_OFFICIAL_CONTRACT.sandbox.terminal,
        REDSYS_BIZUM_ENABLED: 'false',
        PAYMENT_PUBLIC_BASE_URL: origin
      },
      durableObjects: { CARTS: { className: 'CartCoordinator', useSQLite: true } },
      ratelimits: Object.fromEntries(
        ['AUTH_EDGE_LIMIT', 'ADMIN_EDGE_LIMIT', 'CART_EDGE_LIMIT'].map((name, index) => [
          name,
          { namespace_id: String(900730 + index), simple: { limit: 100, period: 60 } }
        ])
      ),
      d1Databases: { DB: '00000000-0000-4000-8000-000000000073' },
      outboundService: outbound
    })
  )
  try {
    const database = (await runtime.getD1Database('DB')) as unknown as D1Database
    const migrations = (await readdir('db/d1/migrations')).filter((name) => /^\d{4}_.*\.sql$/.test(name)).sort()
    expect(migrations.map((name) => Number(name.slice(0, 4)))).toEqual(
      Array.from({ length: 154 }, (_, index) => index + 1)
    )
    for (const name of migrations)
      await database.batch(
        splitDemoSql(await readFile('db/d1/migrations/' + name, 'utf8')).map((sql) => database.prepare(sql))
      )
    expect((await database.prepare('PRAGMA foreign_key_check').all()).results).toEqual([])
    const seeds: D1PreparedStatement[] = []
    seedInventoryFixture({
      exec(sql: string) {
        seeds.push(...splitDemoSql(sql).map((text) => database.prepare(text)))
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
    const now = (await database.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%SZ','now') AS now").first<{ now: string }>())!
      .now
    await provisionPublicationValidityFixture(database, { productIds: ['p-1'], now })
    const adminId = randomUUID(),
      adminSession = randomUUID(),
      buyerId = randomUUID(),
      buyerSession = randomUUID(),
      customerId = randomUUID()
    await database.batch([
      database
        .prepare(
          "INSERT INTO shipping_zones(id,code,name,kind,postal_prefixes,active,created_at) VALUES('native-pickup','native-pickup','Synthetic pickup','warehouse_pickup','[]',1,?)"
        )
        .bind(now),
      database
        .prepare(
          "INSERT INTO shipping_rates(id,zone_id,method_code,service_profile,net_cents,tax_rate_basis_points,eta_min_days,eta_max_days,rate_version,active,created_at) VALUES('native-pickup','native-pickup','pickup','parcel',0,2100,0,0,1,1,?)"
        )
        .bind(now),
      database
        .prepare(
          "INSERT INTO shipping_zones(id,code,name,kind,postal_prefixes,active,created_at) VALUES('native-parcel','native-parcel','Synthetic parcel','parcel_peninsular','[\"peninsular\"]',1,?)"
        )
        .bind(now),
      database
        .prepare(
          "INSERT INTO shipping_rates(id,zone_id,method_code,service_profile,net_cents,tax_rate_basis_points,eta_min_days,eta_max_days,rate_version,active,created_at) VALUES('native-parcel','native-parcel','parcel','parcel',600,2100,1,3,1,1,?)"
        )
        .bind(now),
      database
        .prepare("INSERT INTO customers(id,name,created_at,updated_at) VALUES(?,'Synthetic coupon buyer',?,?)")
        .bind(customerId, now, now),
      database
        .prepare(
          "INSERT INTO identities(id,email,password_hash,email_verified_at,status,created_at,updated_at) VALUES(?,'native-admin@example.invalid','synthetic',?,'active',?,?)"
        )
        .bind(adminId, now, now, now),
      database
        .prepare(
          "INSERT INTO identities(id,email,password_hash,email_verified_at,status,customer_id,created_at,updated_at) VALUES(?,'native-buyer@example.invalid','synthetic',?,'active',?,?,?)"
        )
        .bind(buyerId, now, customerId, now, now),
      ...[
        [adminId, adminSession, 1],
        [buyerId, buyerSession, 0]
      ].map(([id, session, mfa]) =>
        database
          .prepare(
            "INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at) VALUES(?,?,1,?,?,strftime('%Y-%m-%dT%H:%M:%SZ',?,'+1 hour'))"
          )
          .bind(session, id, mfa, now, now)
      ),
      database.prepare(
        "INSERT OR IGNORE INTO permissions VALUES('administration.manage','administration','manage','Synthetic')"
      ),
      database.prepare("INSERT OR IGNORE INTO permissions VALUES('catalog.write','catalog','write','Synthetic')"),
      database.prepare("INSERT INTO roles VALUES('native_promotions','Synthetic promotions','Synthetic')"),
      database.prepare("INSERT INTO role_permissions VALUES('native_promotions','administration.manage')"),
      database.prepare("INSERT INTO role_permissions VALUES('native_promotions','catalog.write')"),
      database.prepare("UPDATE variants SET cost_net_cents=250 WHERE id='v-1-1'"),
      database
        .prepare("INSERT INTO identity_roles(identity_id,role_code,granted_at) VALUES(?,'native_promotions',?)")
        .bind(adminId, now)
    ])
    const sessionCookie = async (identityId: string, sessionId: string) =>
      (await issueD1SessionCookie(
        database,
        { identityId, sessionId, sessionVersion: 1 },
        { password, maxAgeSeconds: 3600 }
      ))!.split(';')[0]!
    const adminCookie = await sessionCookie(adminId, adminSession),
      buyerCookie = await sessionCookie(buyerId, buyerSession)
    const call = (
      path: string,
      method = 'GET',
      body?: unknown,
      cookie = adminCookie,
      key = randomUUID(),
      requestOrigin = origin
    ) =>
      runtime.dispatchFetch(origin + path, {
        method,
        headers: {
          Origin: requestOrigin,
          Cookie: cookie,
          'Content-Type': 'application/json',
          'Idempotency-Key': key,
          'CF-Connecting-IP': '192.0.2.73'
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      })
    const rule = {
      id: randomUUID(),
      version: 1,
      code: 'NATIVE101',
      status: 'paused',
      channel: 'online',
      startsAt: '2020-01-01T00:00:00Z',
      endsAt: null,
      benefit: { kind: 'fixed', grossCents: 101 },
      scope: { kind: 'all' },
      segment: 'registered',
      totalLimit: 1,
      perCustomerLimit: 1,
      volumeMode: 'stack_volume'
    }
    const input = { expectedVersion: 0, rule, reason: 'Synthetic governed native campaign' }
    const basketInput = {
      lines: [{ variantId: 'v-1-1', quantity: 2 }],
      destination: { postalCode: '46870', city: 'Ontinyent' },
      customerId,
      rule
    }
    const simulationTables = [
      'variants',
      'inventory_balances',
      'inventory_movements',
      'inventory_reservations',
      'carts',
      'cart_lines',
      'checkout_quotes',
      'checkout_quote_lines',
      'orders',
      'promotion_rules',
      'promotion_rule_versions',
      'promotion_admin_commands',
      'promotion_redemptions'
    ]
    const simulationSnapshot = async () =>
      (
        await database.batch(
          simulationTables.map((table) => database.prepare('SELECT * FROM ' + table + ' ORDER BY 1,2'))
        )
      ).map((result) => result.results)
    const beforeSimulation = await simulationSnapshot()
    expect((await call('/api/admin/promotions/basket-preview', 'POST', basketInput, buyerCookie)).status).toBe(403)
    expect(
      (
        await call(
          '/api/admin/promotions/basket-preview',
          'POST',
          basketInput,
          adminCookie,
          randomUUID(),
          'https://foreign.invalid'
        )
      ).status
    ).toBe(403)
    const basketPreview = await call('/api/admin/promotions/basket-preview', 'POST', basketInput)
    expect(basketPreview.status).toBe(200)
    expect(basketPreview.headers.get('cache-control')).toContain('no-store')
    const simulated = promotionBasketPreviewResponseSchema.parse(await basketPreview.json())
    expect(simulated).toMatchObject({
      source: 'cloudflare',
      simulation: true,
      ruleEvaluation: 'proposed_active',
      eligible: true,
      totals: {
        proposed: { grossCents: 899, netCents: 743, taxCents: 156, costNetCents: 500, marginNetCents: 243, loss: false }
      },
      shipping: { operationalCostNetCents: null },
      totalMarginNetCents: null
    })
    expect(simulated.shipping.options.find((option) => option.methodCode === 'parcel')).toMatchObject({
      netCents: 0,
      taxCents: 0,
      grossCents: 0
    })
    expect(await simulationSnapshot()).toEqual(beforeSimulation)
    expect(
      (await call('/api/admin/promotions', 'POST', input, adminCookie, randomUUID(), 'https://foreign.invalid')).status
    ).toBe(403)
    expect((await database.prepare('SELECT count(*) AS n FROM promotion_rules').first<{ n: number }>())!.n).toBe(0)
    const creationKey = randomUUID(),
      created = await call('/api/admin/promotions', 'POST', input, adminCookie, creationKey)
    expect(created.status).toBe(201)
    const receipt = adminPromotionReceiptSchema.parse(await created.json())
    expect(await (await call('/api/admin/promotions', 'POST', input, adminCookie, creationKey)).json()).toEqual(receipt)
    const active = { ...input, expectedVersion: 1, rule: { ...rule, version: 2, status: 'active' } }
    expect((await call('/api/admin/promotions/' + rule.id, 'PUT', active)).status).toBe(201)
    expect((await call('/api/admin/promotions/' + rule.id, 'PUT', active)).status).toBe(409)
    expect(await (await call('/api/admin/promotions/' + rule.id)).json()).toMatchObject({
      rule: { version: 2, status: 'active' },
      historyTotal: 2
    })
    async function quote() {
      const cart = await createCart(database, { now, correlationId: 'native-promotions' })
      await setCartLine(database, {
        ...cart,
        variantId: 'v-1-1',
        quantity: 2,
        expectedVersion: 1,
        idempotencyKey: randomUUID(),
        now,
        correlationId: 'native-promotions'
      })
      const cookie = `neteco-cart-v2=v1.${cart.cartId}.${cart.token}; ${buyerCookie}`
      const response = await call(
        '/api/shipping/rates',
        'POST',
        { postalCode: '46870', city: 'Ontinyent', couponCode: 'native101' },
        cookie
      )
      expect(response.status).toBe(200)
      const body = (await response.json()) as {
        cartVersion: number
        promotion: unknown
        rates: Array<{
          serviceCode: string
          totalGrossCents: number
          quoteId: string
          shippingQuoteId: string
          optionIndex: number
          optionHash: string
        }>
      }
      expect(body.promotion).toMatchObject({ applied: true, discountGrossCents: 101 })
      const option = body.rates.find((rate) => rate.serviceCode === 'pickup')!
      expect(option.totalGrossCents).toBe(899)
      const address = {
        recipientName: 'Synthetic buyer',
        line1: 'Synthetic street 1',
        postalCode: '46870',
        city: 'Ontinyent',
        region: 'Valencia',
        countryCode: 'ES',
        phone: '600000000'
      }
      return {
        cookie,
        key: randomUUID(),
        body: {
          cartId: cart.cartId,
          cartVersion: body.cartVersion,
          quoteId: option.quoteId,
          shippingQuoteId: option.shippingQuoteId,
          optionIndex: option.optionIndex,
          optionHash: option.optionHash,
          expectedTotalGrossCents: 899,
          customer: { name: 'Synthetic buyer', email: 'native-buyer@example.invalid', phone: '600000000' },
          shippingAddress: address,
          billingAddress: address,
          paymentMethod: 'tarjeta',
          termsAccepted: true,
          privacyNoticePresented: true,
          marketingConsent: false
        }
      }
    }
    const first = await quote(),
      second = await quote()
    const firstPurchase = {
      ...first.body,
      purchaseOrderReference: '  PO-Cafe\u0301-2026/74  ',
      shippingAddress: { ...first.body.shippingAddress, instructions: 'Recepción de 9 a 13' }
    }
    const checkout = await call('/api/orders', 'POST', firstPurchase, first.cookie, first.key)
    expect(checkout.status).toBe(201)
    const order = (await checkout.json()) as { id: string }
    const replay = await call('/api/orders', 'POST', firstPurchase, first.cookie, first.key)
    expect(replay.status).toBe(201)
    expect(await replay.json()).toEqual(order)
    expect(
      (
        await call(
          '/api/orders',
          'POST',
          { ...firstPurchase, purchaseOrderReference: 'PO-OTHER' },
          first.cookie,
          first.key
        )
      ).status
    ).toBe(409)
    const customerDetail = await call('/api/orders/' + order.id, 'GET', undefined, buyerCookie)
    expect(customerDetail.status).toBe(200)
    expect(customerDetail.headers.get('cache-control')).toContain('no-store')
    expect(await customerDetail.json()).toMatchObject({
      purchaseOrderReference: 'PO-Café-2026/74',
      notes: 'Recepción de 9 a 13',
      nif: null,
      total: 899
    })
    const adminDetail = await call('/api/admin/orders/' + order.id + '/detail')
    expect(adminDetail.status).toBe(200)
    expect(await adminDetail.json()).toMatchObject({ order: { purchaseOrderReference: 'PO-Café-2026/74' } })
    const preparation = await call('/api/admin/orders/' + order.id + '/fulfillment')
    expect(preparation.status).toBe(200)
    expect(await preparation.json()).toMatchObject({ purchaseOrderReference: 'PO-Café-2026/74' })
    expect(
      await database.prepare('SELECT purchase_order_reference FROM orders WHERE id=?').bind(order.id).first()
    ).toEqual({ purchase_order_reference: 'PO-Café-2026/74' })
    await expect(
      database.prepare('UPDATE orders SET purchase_order_reference=? WHERE id=?').bind('changed', order.id).run()
    ).rejects.toThrow()
    expect((await call('/api/orders', 'POST', second.body, second.cookie, second.key)).status).toBe(409)
    expect((await database.prepare('SELECT count(*) AS n FROM orders').first<{ n: number }>())!.n).toBe(1)
    expect(
      (await database.prepare('SELECT customer_id,discount_gross_cents FROM promotion_redemptions').all()).results
    ).toEqual([{ customer_id: customerId, discount_gross_cents: 101 }])
    expect(
      (
        await database
          .prepare('SELECT unit_gross_cents,discount_gross_cents,net_cents,tax_cents,gross_cents FROM order_lines')
          .all()
      ).results
    ).toEqual([{ unit_gross_cents: 500, discount_gross_cents: 101, net_cents: 743, tax_cents: 156, gross_cents: 899 }])
    expect((await database.prepare('PRAGMA foreign_key_check').all()).results).toEqual([])
    expect(outbound).not.toHaveBeenCalled()
  } finally {
    await runtime.dispose()
  }
}, 60_000)

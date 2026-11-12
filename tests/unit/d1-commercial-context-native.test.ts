import { randomBytes } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { buildNativeCanary as build } from '../support/native-canary-build'
import { Miniflare, convertV4MiniflareOptions, NoOpLog } from 'miniflare'
import { expect, it, vi } from 'vitest'
import { splitDemoSql } from '../../scripts/lib/d1-demo-sql'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import { createCart, setCartLine } from '../../workers/catalog/cart'
import { scheduleD1VariantPrice } from '../../workers/catalog/admin-price-commands'
import { provisionPublicationValidityFixture } from '../support/publication-validity-fixture'
import { returnsFixture, CLAIMS, BUYER_CLAIMS, CUSTOMER, utc } from './d1-returns-fixture'
import {
  salesQuoteAdminSnapshotSchema,
  salesQuoteReceiptSchema,
  salesQuoteCommandSchema,
  salesQuoteConversionIntentHash
} from '../../shared/sales-quotes'
import { customer360Schema } from '../../shared/customer-360'
import { testUuid } from '../support/deterministic'
import { syncNativeTestClock } from '../support/native-runtime-clock'

// SOURCE/workerd acceptance, not Nuxt SSR, Chromium, deployment or provider acceptance.
it('converts a price-locked parcel quote through actual canary and InventoryCoordinator, and redacts live customer context', async () => {
  let fixture: Awaited<ReturnType<typeof returnsFixture>> | undefined
  const outbound = vi.fn(() => {
    throw new Error('unexpected_outbound')
  })
  let runtime: Miniflare | undefined
  const origin = 'https://commercial-context-native.neteco.test'
  const variantId = '89000000-0000-4000-8000-000000000091'
  const support = {
    identityId: '89000000-0000-4000-8000-000000000092',
    sessionId: '89000000-0000-4000-8000-000000000093',
    sessionVersion: 1
  }
  const reason = 'Synthetic explicit commercial price review, no discount override'
  try {
    const bundle = await build({
      stdin: {
        contents: "export { default, CartCoordinator, InventoryCoordinator } from './workers/canary'",
        resolveDir: process.cwd(),
        sourcefile: 'commercial-context-native-entry.ts',
        loader: 'ts'
      },
      bundle: true,
      platform: 'browser',
      format: 'esm',
      external: ['node:*', 'cloudflare:*'],
      write: false,
      logLevel: 'silent'
    })
    const password = randomBytes(32).toString('hex')
    runtime = new Miniflare(
      convertV4MiniflareOptions({
        name: 'commercial-context-native',
        ...bundle.nativeSource,
        compatibilityDate: '2026-08-15',
        compatibilityFlags: ['nodejs_compat'],
        cf: false,
        telemetry: { enabled: false },
        log: new NoOpLog(),
        bindings: {
          APP_ENV: 'local',
          AUTH_ENABLED: 'true',
          SALES_QUOTES_ENABLED: 'true',
          CUSTOMER_360_ENABLED: 'true',
          EMAIL_ENABLED: 'false',
          AUTH_ORIGIN: origin,
          NUXT_SESSION_PASSWORD: password,
          AUTH_TOKEN_PEPPER: randomBytes(32).toString('hex'),
          AUTH_RATE_LIMIT_PEPPER: randomBytes(32).toString('hex'),
          AUTH_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
          FREE_SHIPPING_THRESHOLD_CENTS: '1200'
        },
        durableObjects: {
          CARTS: { className: 'CartCoordinator', useSQLite: true },
          INVENTORY: { className: 'InventoryCoordinator', useSQLite: true }
        },
        ratelimits: {
          ADMIN_EDGE_LIMIT: { namespace_id: '900089', simple: { limit: 100, period: 60 } },
          CART_EDGE_LIMIT: { namespace_id: '910089', simple: { limit: 100, period: 60 } },
          AUTH_EDGE_LIMIT: { namespace_id: '920089', simple: { limit: 100, period: 60 } }
        },
        d1Databases: { DB: testUuid() },
        outboundService: outbound
      })
    )
    const db = (await runtime.getD1Database('DB')) as unknown as D1Database
    await syncNativeTestClock(db)
    fixture = await returnsFixture()
    const migrations = (await readdir('db/d1/migrations'))
      .filter((name) => /^\d{4}_.*\.sql$/.test(name) && Number(name.slice(0, 4)) <= 89)
      .sort()
    expect(migrations.map((name) => Number(name.slice(0, 4)))).toEqual(Array.from({ length: 89 }, (_, i) => i + 1))
    for (const file of migrations)
      await db.batch(splitDemoSql(await readFile('db/d1/migrations/' + file, 'utf8')).map((sql) => db.prepare(sql)))
    // Portable initial catalog/identity/warehouse setup only. No orders,
    // reservations, commercial approvals or payment authority are copied.
    for (const table of [
      'brands',
      'categories',
      'tax_classes',
      'shipping_profiles',
      'products',
      'variants',
      'inventory_locations',
      'inventory_balances',
      'inventory_movements',
      'shipping_zones',
      'shipping_rates',
      'customers',
      'roles',
      'permissions',
      'role_permissions',
      'identities',
      'auth_sessions',
      'identity_roles'
    ]) {
      const rows = fixture.sqlite.prepare(`SELECT * FROM ${table}`).all() as Record<string, string | number | null>[]
      for (const row of rows) {
        // These are new catalog records, not a copied governed projection.
        // The real DDL defaults start at 1; publication below advances them
        // through the normal triggers rather than transplanting a latest head.
        const columns = Object.keys(row).filter(
          (column) =>
            !(table === 'products' && column === 'catalog_version') &&
            !(table === 'categories' && column === 'category_version')
        )
        await db
          .prepare(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`)
          .bind(...columns.map((column) => row[column]))
          .run()
      }
    }
    const now = utc(-60000)
    await db.batch([
      db
        .prepare(
          "INSERT INTO variants(id,legacy_id,product_id,tax_class_id,shipping_profile_id,sku,format,status,price_gross_cents,backorder_allowed,safety_stock,created_at,updated_at) VALUES(?,89091,'p-1','t21','sp1','SYNTHETIC-NATIVE-QUOTE','Botella 1 L','published',500,0,0,?,?)"
        )
        .bind(variantId, now, now),
      db
        .prepare(
          "INSERT INTO inventory_balances(variant_id,location_id,physical_quantity,blocked_quantity,version,created_at,updated_at) VALUES(?,'loc-main',25,0,1,?,?)"
        )
        .bind(variantId, now, now),
      db
        .prepare(
          "INSERT INTO inventory_movements(id,variant_id,location_id,movement_type,physical_delta,reserved_delta,reference_type,idempotency_key,correlation_id,reason,created_at) VALUES(?,?,'loc-main','initial',25,0,'seed',?,'commercial-native','Synthetic initial stock',?)"
        )
        .bind(testUuid(), variantId, testUuid(), now),
      db
        .prepare(
          "INSERT INTO shipping_zones(id,code,name,kind,postal_prefixes,active,created_at) VALUES('native-quote-zone','native-quote','Synthetic parcel','parcel_peninsular','[\"peninsular\"]',1,?)"
        )
        .bind(now),
      db
        .prepare(
          "INSERT INTO shipping_rates(id,zone_id,method_code,service_profile,net_cents,tax_rate_basis_points,eta_min_days,eta_max_days,rate_version,active,created_at) VALUES('native-quote-rate','native-quote-zone','parcel','parcel',500,2100,1,2,1,1,?)"
        )
        .bind(now)
    ])
    await provisionPublicationValidityFixture(db, { productIds: ['p-1'], now })
    for (const [code, resource, action] of [
      ['catalog.write', 'catalog', 'write'],
      ['orders.read', 'orders', 'read'],
      ['support.manage', 'support', 'manage']
    ])
      await db
        .prepare('INSERT OR IGNORE INTO permissions(code,resource,action,description) VALUES(?,?,?,?)')
        .bind(code, resource, action, 'Synthetic native scoped permission')
        .run()
    await db.batch([
      db.prepare("INSERT INTO role_permissions VALUES('operator','catalog.write')"),
      db.prepare("INSERT INTO role_permissions VALUES('operator','orders.read')"),
      db.prepare("INSERT INTO roles VALUES('native-support','Synthetic support','Synthetic isolated role')"),
      db.prepare("INSERT INTO role_permissions VALUES('native-support','support.manage')"),
      db
        .prepare(
          "INSERT INTO identities(id,email,password_hash,email_verified_at,status,created_at,updated_at) VALUES(?,'native-support@example.invalid','synthetic-not-login',?,'active',?,?)"
        )
        .bind(support.identityId, now, now, now),
      db
        .prepare(
          'INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at) VALUES(?,?,1,1,?,?)'
        )
        .bind(support.sessionId, support.identityId, now, utc(3600000)),
      db
        .prepare("INSERT INTO identity_roles(identity_id,role_code,granted_at) VALUES(?,'native-support',?)")
        .bind(support.identityId, now),
      ...[CLAIMS.identityId, support.identityId].map((id) =>
        db
          .prepare(
            "INSERT INTO identity_mfa(identity_id,encrypted_secret,recovery_code_hashes,verified_at,updated_at) VALUES(?,'synthetic-not-production','[]',?,?)"
          )
          .bind(id, now, now)
      )
    ])
    const configuration = { password, maxAgeSeconds: 3600 }
    const adminCookie = (await issueD1SessionCookie(db, CLAIMS, configuration))!.split(';')[0]!
    const buyerCookie = (await issueD1SessionCookie(db, BUYER_CLAIMS, configuration))!.split(';')[0]!
    const supportCookie = (await issueD1SessionCookie(db, support, configuration))!.split(';')[0]!
    async function send(path: string, body?: unknown, cookie = adminCookie, key = testUuid(), hash?: string) {
      const response = await runtime!.dispatchFetch(origin + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          Cookie: cookie,
          Origin: origin,
          'CF-Connecting-IP': '192.0.2.89',
          'Content-Type': 'application/json',
          'Idempotency-Key': key,
          ...(hash ? { 'X-Neteco-Command-Payload-Hash': hash } : {})
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      })
      expect(response.headers.get('cache-control')).toContain('no-store')
      return { status: response.status, body: (await response.json()) as unknown }
    }
    const base = '/api/admin/sales-quotes'
    const createdResponse = await send(base, {
      customerId: CUSTOMER,
      lines: [{ variantId, quantity: 2 }],
      destination: { city: 'Ontinyent', postalCode: '46870' },
      shippingMethod: 'parcel',
      validUntil: utc(1800000),
      reason
    })
    expect(createdResponse.status).toBe(201)
    const created = salesQuoteReceiptSchema.parse(createdResponse.body)
    expect(
      (await send(`${base}/${created.quoteId}/commands`, { action: 'review', expectedVersion: 1, reason })).status
    ).toBe(201)
    const reviewed = salesQuoteAdminSnapshotSchema.parse((await send(`${base}/${created.quoteId}`)).body)
    expect(
      (
        await send(`${base}/${created.quoteId}/commands`, {
          action: 'approve',
          expectedVersion: 2,
          reviewedHash: reviewed.reviewedHash,
          reason
        })
      ).status
    ).toBe(201)
    const approved = salesQuoteAdminSnapshotSchema.parse((await send(`${base}/${created.quoteId}`)).body)
    expect(approved.shipping?.grossCents).toBe(605)
    expect(approved.total?.grossCents).toBe(1605)
    const product = await db
      .prepare("SELECT catalog_version AS version FROM products WHERE id='p-1'")
      .first<{ version: number }>()
    await scheduleD1VariantPrice(
      db,
      CLAIMS,
      {
        variantId,
        grossCents: 700,
        compareAtGrossCents: null,
        volumeTiers: [],
        validFrom: utc(),
        expectedCatalogVersion: product!.version,
        expectedLatestApprovedId: null,
        reason
      },
      { idempotencyKey: testUuid() }
    )
    const cart = await createCart(db, { now: utc(), correlationId: 'commercial-native' })
    expect(
      (
        await setCartLine(db, {
          ...cart,
          now: utc(),
          correlationId: 'commercial-native',
          expectedVersion: 1,
          variantId,
          quantity: 2,
          idempotencyKey: testUuid()
        })
      ).outcome
    ).toBe('applied')
    const cookie = `${buyerCookie}; neteco-cart-v2=v1.${cart.cartId}.${cart.token}`
    const customerPath = `/api/account/sales-quotes/${approved.id}`
    const shippingResponse = await send(
      customerPath + '/shipping-options',
      { expectedVersion: approved.version, approvedHash: approved.approvedHash },
      cookie
    )
    expect(shippingResponse.status).toBe(200)
    const shipping = shippingResponse.body as {
      cartVersion: number
      rates: { quoteId: string; shippingQuoteId: string; optionIndex: number; optionHash: string }[]
    }
    expect(shipping.cartVersion).toBe(2)
    expect(shipping.rates).toHaveLength(1)
    const option = shipping.rates[0]!
    const input = {
      expectedVersion: approved.version,
      approvedHash: approved.approvedHash,
      checkout: {
        expectedVersion: 2,
        quoteId: option.quoteId,
        shippingQuoteId: option.shippingQuoteId,
        selectedOptionIndex: option.optionIndex,
        selectedOptionHash: option.optionHash,
        expectedTotalGrossCents: 1605,
        contactEmail: 'buyer@example.invalid',
        shippingAddress: {
          recipientName: 'Synthetic quote recipient',
          line1: 'Synthetic street 1',
          city: 'Ontinyent',
          province: 'Valencia',
          postalCode: '46870',
          phone: '+34600111222'
        },
        consentTos: true,
        consentPrivacy: true
      }
    }
    const key = testUuid(),
      hash = await salesQuoteConversionIntentHash(approved.id, cart.cartId, input)
    const converted = await send(customerPath + '/convert', input, cookie, key)
    expect(converted.status).toBe(201)
    const receipt = salesQuoteReceiptSchema.parse(converted.body)
    expect(receipt.payloadHash).toBe(hash)
    expect((await send(customerPath + '/convert', input, cookie, key)).body).toEqual(receipt)
    const recovered = await send(`/api/account/sales-quotes/commands/${key}`, undefined, buyerCookie, undefined, hash)
    expect(recovered.status).toBe(200)
    expect(salesQuoteCommandSchema.parse(recovered.body)).toEqual({ source: 'cloudflare', outcome: 'applied', receipt })
    expect(await db.prepare('SELECT count(*) AS n FROM orders').first()).toEqual({ n: 1 })
    expect(await db.prepare('SELECT count(*) AS n FROM inventory_reservations').first()).toEqual({ n: 1 })
    expect(
      await db
        .prepare("SELECT count(*) AS n FROM inventory_movements WHERE variant_id=? AND movement_type='reserve'")
        .bind(variantId)
        .first()
    ).toEqual({ n: 1 })
    expect(
      await db
        .prepare(
          'SELECT physical_quantity AS physical,blocked_quantity AS blocked FROM inventory_balances WHERE variant_id=?'
        )
        .bind(variantId)
        .first()
    ).toEqual({ physical: 25, blocked: 0 })
    expect(
      await db
        .prepare(
          "SELECT sum(reserved_delta) AS reserved, sum(physical_delta) AS physical FROM inventory_movements WHERE variant_id=? AND movement_type<>'initial'"
        )
        .bind(variantId)
        .first()
    ).toEqual({ reserved: 2, physical: 0 })
    expect(
      await db
        .prepare('SELECT unit_gross_cents AS unit FROM order_lines WHERE order_id=?')
        .bind(receipt.orderId)
        .first()
    ).toEqual({ unit: 500 })
    expect(
      await db
        .prepare('SELECT shipping_gross_cents AS shipping,total_gross_cents AS total,status FROM orders WHERE id=?')
        .bind(receipt.orderId)
        .first()
    ).toEqual({ shipping: 605, total: 1605, status: 'awaiting_payment' })
    const protectedTables = [
      'orders',
      'order_lines',
      'inventory_balances',
      'inventory_movements',
      'inventory_reservations',
      'payment_intents',
      'payment_events',
      'fiscal_invoice_intents',
      'sales_quote_commands'
    ]
    const snapshot = () =>
      Promise.all(
        protectedTables.map(async (table) => (await db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()).results)
      )
    const beforeReads = await snapshot()
    const contextPath = `/api/admin/customer-context/${CUSTOMER}`
    const fullResponse = await send(contextPath)
    expect(fullResponse.status).toBe(200)
    const full = customer360Schema.parse(fullResponse.body)
    expect(full.orders).toMatchObject({ visibility: 'visible', data: { total: 1, items: [{ id: receipt.orderId }] } })
    expect(full.invoices).toEqual({ visibility: 'redacted', data: null })
    expect(full.value).toEqual({ visibility: 'redacted', data: null })
    const limitedResponse = await send(contextPath, undefined, supportCookie)
    expect(limitedResponse.status).toBe(200)
    const limited = customer360Schema.parse(limitedResponse.body)
    for (const section of ['orders', 'invoices', 'value', 'consent'] as const)
      expect(limited[section]).toEqual({ visibility: 'redacted', data: null })
    expect(limited.tickets.visibility).toBe('visible')
    expect(JSON.stringify(limited)).not.toContain(receipt.orderId!)
    expect(await snapshot()).toEqual(beforeReads)
    for (const table of ['payment_intents', 'payment_events', 'fiscal_invoice_intents'])
      expect(await db.prepare(`SELECT count(*) AS n FROM ${table}`).first()).toEqual({ n: 0 })
    await db.prepare('UPDATE auth_sessions SET revoked_at=? WHERE id=?').bind(utc(), BUYER_CLAIMS.sessionId).run()
    expect((await send(customerPath + '/convert', input, cookie, key)).status).toBe(401)
    expect(
      (await send(`/api/account/sales-quotes/commands/${key}`, undefined, buyerCookie, undefined, hash)).status
    ).toBe(401)
    await db.prepare('UPDATE auth_sessions SET revoked_at=? WHERE id=?').bind(utc(), CLAIMS.sessionId).run()
    const denied = await send(contextPath)
    expect(denied.status).toBe(401)
    expect(JSON.stringify(denied.body)).not.toContain(CUSTOMER)
    expect(JSON.stringify(denied.body)).not.toContain(receipt.orderId!)
    expect(await snapshot()).toEqual(beforeReads)
    expect(outbound).not.toHaveBeenCalled()
  } finally {
    fixture?.sqlite.close()
    await runtime?.dispose()
  }
}, 60000)

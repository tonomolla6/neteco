import { readFile, readdir } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import { returnsFixture, CLAIMS, BUYER_CLAIMS, CUSTOMER, utc } from './d1-returns-fixture'
import { splitDemoSql } from '../../scripts/lib/d1-demo-sql'
import { provisionPublicationValidityFixture } from '../support/publication-validity-fixture'
import { createCart, setCartLine, quoteCart } from '../../workers/catalog/cart'
import { placeOrder, requestShippingOptions, type PlaceOrderInput } from '../../workers/catalog/checkout'
import { reserveInventory, releaseReservation } from '../../workers/catalog/inventory'
import { scheduleD1VariantPrice } from '../../workers/catalog/admin-price-commands'
import {
  executeD1SalesQuoteCommand,
  readD1AdminSalesQuote,
  listD1SalesQuotes,
  convertD1SalesQuote,
  readD1SalesQuoteCommand,
  type SalesQuoteConversionInput
} from '../../workers/catalog/sales-quotes'
import {
  salesQuoteCreateInputSchema,
  salesQuoteIntentHash,
  salesQuoteConversionIntentHash,
  salesQuoteConvertInputSchema
} from '../../shared/sales-quotes'
import { testUuid } from '../support/deterministic'

const REASON = 'Synthetic commercial review, no discount override'
const VARIANT = '89000000-0000-4000-8000-000000000001'
const FOREIGN_CLAIMS = {
  identityId: '89000000-0000-4000-8000-000000000002',
  sessionId: '89000000-0000-4000-8000-000000000003',
  sessionVersion: 1
}
const address = {
  recipientName: 'Synthetic quote buyer',
  line1: 'Synthetic street 1',
  city: 'Ontinyent',
  province: 'Valencia',
  postalCode: '46870',
  phone: '+34600111222'
}

async function fixture() {
  const f = await returnsFixture()
  try {
    // Apply existing files atomically and in order. 0089 does not exist for RED;
    // the behavioral service baseline fails before attempting missing DDL.
    const directory = new URL('../../db/d1/migrations/', import.meta.url)
    const files = (await readdir(directory))
      .filter(
        (name) =>
          /^\d{4}_[a-z0-9_]+\.sql$/.test(name) && Number(name.slice(0, 4)) >= 63 && Number(name.slice(0, 4)) <= 89
      )
      .sort()
    for (const name of files)
      await f.database.batch(
        splitDemoSql(await readFile(new URL(name, directory), 'utf8')).map((sql) => f.database.prepare(sql))
      )
    const now = utc(-60000)
    f.sqlite
      .prepare('INSERT INTO customers(id,name,created_at,updated_at) VALUES(?,?,?,?)')
      .run('89000000-0000-4000-8000-000000000004', 'Synthetic unrelated customer', now, now)
    f.sqlite
      .prepare(
        "INSERT INTO identities(id,email,password_hash,email_verified_at,status,customer_id,created_at,updated_at) VALUES(?,?,'synthetic',?,'active',?,?,?)"
      )
      .run(
        FOREIGN_CLAIMS.identityId,
        'foreign-quote@example.invalid',
        now,
        '89000000-0000-4000-8000-000000000004',
        now,
        now
      )
    f.sqlite
      .prepare(
        'INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at) VALUES(?,?,1,0,?,?)'
      )
      .run(FOREIGN_CLAIMS.sessionId, FOREIGN_CLAIMS.identityId, now, utc(3600000))
    // Isolated catalog/stock initialization only; no quote approval, order,
    // reservation or public price-change authority is fabricated by this seed.
    f.sqlite
      .prepare(
        `INSERT INTO variants(id,legacy_id,product_id,tax_class_id,shipping_profile_id,sku,format,status,
      price_gross_cents,backorder_allowed,safety_stock,created_at,updated_at)
      VALUES(?,89001,'p-1','t21','sp1','SYNTHETIC-QUOTE-89001','Botella 1 L','published',500,0,0,?,?)`
      )
      .run(VARIANT, now, now)
    f.sqlite
      .prepare(
        `INSERT INTO inventory_balances(variant_id,location_id,physical_quantity,blocked_quantity,version,created_at,updated_at)
      VALUES(?,'loc-main',25,0,1,?,?)`
      )
      .run(VARIANT, now, now)
    f.sqlite
      .prepare(
        `INSERT INTO inventory_movements(id,variant_id,location_id,movement_type,physical_delta,reserved_delta,reference_type,
      idempotency_key,correlation_id,reason,created_at) VALUES(?,?,'loc-main','initial',25,0,'seed',?,'sales-quote-fixture','Synthetic initial stock',?)`
      )
      .run(testUuid(), VARIANT, testUuid(), now)
    await provisionPublicationValidityFixture(f.database, { productIds: ['p-1'], now })
    f.sqlite.exec(
      "INSERT INTO permissions VALUES('catalog.write','catalog','write','Synthetic commercial costs permission'); INSERT INTO role_permissions VALUES('operator','catalog.write')"
    )
    // Explicit synthetic enrollment, not an invented commercial approval.
    f.sqlite
      .prepare(
        "INSERT INTO identity_mfa(identity_id,encrypted_secret,recovery_code_hashes,verified_at,updated_at) VALUES(?,'synthetic-not-production','[]',?,?)"
      )
      .run(CLAIMS.identityId, now, now)
    const product = f.sqlite.prepare("SELECT catalog_version AS version FROM products WHERE id='p-1'").get() as {
      version: number
    }
    await scheduleD1VariantPrice(
      f.database,
      CLAIMS,
      {
        variantId: VARIANT,
        grossCents: 500,
        compareAtGrossCents: null,
        volumeTiers: [],
        validFrom: utc(-5000),
        expectedCatalogVersion: product.version,
        expectedLatestApprovedId: null,
        reason: REASON
      },
      { idempotencyKey: testUuid() }
    )
    return f
  } catch (error) {
    f.sqlite.close()
    throw error
  }
}
type Fixture = Awaited<ReturnType<typeof fixture>>
function economic(f: Fixture) {
  return Object.fromEntries(
    [
      'orders',
      'order_lines',
      'inventory_reservations',
      'inventory_reservation_lines',
      'inventory_balances',
      'inventory_movements',
      'email_outbox_events',
      'payment_intents',
      'payment_events'
    ].map((table) => [table, f.sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])
  )
}
async function checkout(
  f: Fixture,
  quantity = 2,
  shippingOptions: {
    method?: 'pickup' | 'parcel'
    freeShippingThresholdCents?: number
    salesQuote?: { quoteId: string; version: number; approvedHash: string }
  } = {}
): Promise<PlaceOrderInput> {
  const now = utc(),
    cart = await createCart(f.database, { correlationId: 'sales-quote-test', now })
  const common = { cartId: cart.cartId, token: cart.token, correlationId: 'sales-quote-test', now }
  const added = await setCartLine(f.database, {
    ...common,
    expectedVersion: 1,
    variantId: VARIANT,
    quantity,
    idempotencyKey: testUuid()
  })
  if (added.outcome !== 'applied') throw new Error('sales_quote_fixture_add_failed')
  const quote = await quoteCart(f.database, { ...common, expectedVersion: 2, idempotencyKey: testUuid() })
  const shipping = await requestShippingOptions(f.database, {
    ...common,
    ...shippingOptions,
    ...{ ownerSession: BUYER_CLAIMS },
    expectedVersion: 2,
    destination: { city: address.city, postalCode: address.postalCode },
    idempotencyKey: testUuid()
  })
  if (quote.outcome !== 'quoted' || shipping.outcome !== 'options') throw new Error('sales_quote_fixture_quote_failed')
  const option = (shipping.body.options as Array<{ methodCode: string; optionIndex: number; optionHash: string }>).find(
    (item) => item.methodCode === (shippingOptions.method ?? 'pickup')
  )
  if (!option) throw new Error('sales_quote_fixture_shipping_failed')
  return {
    ...common,
    expectedVersion: 2,
    quoteId: quote.quote.quoteId,
    shippingQuoteId: String(shipping.body.shippingQuoteId),
    selectedOptionIndex: option.optionIndex,
    selectedOptionHash: option.optionHash,
    contactEmail: 'buyer@example.invalid',
    shippingAddress: address,
    consentTos: true,
    consentPrivacy: true,
    ownerSession: BUYER_CLAIMS,
    idempotencyKey: testUuid()
  }
}
async function approved(
  f: Fixture,
  validUntil = utc(1800000),
  options: {
    shippingMethod?: 'pickup' | 'parcel'
    freeShippingThresholdCents?: number
  } = {}
) {
  const input = {
    customerId: CUSTOMER,
    lines: [{ variantId: VARIANT, quantity: 2 }],
    destination: { city: address.city, postalCode: address.postalCode },
    shippingMethod: options.shippingMethod ?? ('pickup' as const),
    validUntil,
    reason: REASON
  }
  const before = economic(f)
  const created = await executeD1SalesQuoteCommand(f.database, CLAIMS, 'create', null, input, {
    ...options,
    idempotencyKey: testUuid()
  })
  const reviewed = await executeD1SalesQuoteCommand(
    f.database,
    CLAIMS,
    'review',
    created.quoteId,
    { expectedVersion: created.version, reason: REASON },
    { ...options, idempotencyKey: testUuid() }
  )
  const review = await readD1AdminSalesQuote(f.database, CLAIMS, created.quoteId)
  expect(review.status).toBe('reviewed')
  expect(review.reviewedHash).toMatch(/^[a-f0-9]{64}$/)
  const receipt = await executeD1SalesQuoteCommand(
    f.database,
    CLAIMS,
    'approve',
    created.quoteId,
    { expectedVersion: reviewed.version, reviewedHash: review.reviewedHash, reason: REASON },
    { ...options, idempotencyKey: testUuid() }
  )
  const snapshot = await readD1AdminSalesQuote(f.database, CLAIMS, created.quoteId)
  expect(snapshot).toMatchObject({ status: 'approved', version: receipt.version })
  expect(snapshot.approvedHash).toMatch(/^[a-f0-9]{64}$/)
  expect(economic(f)).toEqual(before) // Approval is not a reservation, sale, payment or email.
  return snapshot
}
function conversion(snapshot: Awaited<ReturnType<typeof approved>>, input: PlaceOrderInput): SalesQuoteConversionInput {
  if (!snapshot.approvedHash || !snapshot.total) throw new Error('sales_quote_fixture_approval_missing')
  return {
    expectedVersion: snapshot.version,
    approvedHash: snapshot.approvedHash,
    checkout: { ...input, expectedTotalGrossCents: snapshot.total.grossCents }
  }
}
function counts(f: Fixture) {
  return ['orders', 'inventory_reservations'].map((table) =>
    Number((f.sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n)
  )
}
function beforeOrderBatch(database: D1Database, change: () => Promise<void>) {
  const sql = new WeakMap<object, string>()
  let fired = false
  return new Proxy(database, {
    get(target, key) {
      if (key === 'prepare')
        return (text: string) => {
          const statement = target.prepare(text),
            bind = statement.bind.bind(statement)
          statement.bind = (...values: unknown[]) => {
            const bound = bind(...values)
            sql.set(bound, text)
            return bound
          }
          sql.set(statement, text)
          return statement
        }
      if (key === 'batch')
        return async (statements: D1PreparedStatement[]) => {
          if (!fired && statements.some((statement) => sql.get(statement)?.includes('INSERT INTO orders'))) {
            fired = true
            await change()
          }
          return target.batch(statements)
        }
      const value: unknown = Reflect.get(target, key)
      return typeof value === 'function' ? value.bind(target) : value
    }
  })
}

describe('commercial quote conversion through canonical D1 checkout', () => {
  it('rejects incomplete canonical shipping addresses in the shared conversion contract', () => {
    const input = {
      expectedVersion: 3,
      approvedHash: 'a'.repeat(64),
      checkout: {
        expectedVersion: 2,
        quoteId: testUuid(),
        shippingQuoteId: testUuid(),
        selectedOptionIndex: 0,
        selectedOptionHash: 'b'.repeat(64),
        contactEmail: 'buyer@example.invalid',
        shippingAddress: { ...address },
        consentTos: true,
        consentPrivacy: true
      }
    }
    expect(salesQuoteConvertInputSchema.safeParse(input).success).toBe(true)
    for (const field of ['phone', 'province'] as const) {
      const invalid: Record<string, unknown> = { ...address }
      Reflect.deleteProperty(invalid, field)
      expect(
        salesQuoteConvertInputSchema.safeParse({ ...input, checkout: { ...input.checkout, shippingAddress: invalid } })
          .success
      ).toBe(false)
    }
  })
  it('rejects a core conversion with an invalid address before binding or creating any checkout attempt', async () => {
    const f = await fixture()
    try {
      const snapshot = await approved(f)
      const input = conversion(snapshot, await checkout(f))
      input.checkout.shippingAddress = { ...input.checkout.shippingAddress, phone: undefined }
      await expect(
        convertD1SalesQuote(f.database, BUYER_CLAIMS, snapshot.id, input, { idempotencyKey: testUuid() })
      ).rejects.toMatchObject({ code: 'invalid_input' })
      expect(f.sqlite.prepare('SELECT count(*) AS n FROM sales_quote_conversions').get()).toEqual({ n: 0 })
      expect(f.sqlite.prepare('SELECT count(*) AS n FROM checkout_attempts').get()).toEqual({ n: 0 })
      expect(counts(f)).toEqual([0, 0])
    } finally {
      f.sqlite.close()
    }
  })
  it.each([
    { threshold: 1200, changedUnitPrice: 700, approvedShippingGross: 605 },
    { threshold: 900, changedUnitPrice: 400, approvedShippingGross: 0 }
  ])(
    'honors approved parcel charges when public prices cross the free-shipping threshold $threshold',
    async ({ threshold, changedUnitPrice, approvedShippingGross }) => {
      const f = await fixture()
      try {
        // Isolated shipping catalog initialization; approval and conversion remain real commands.
        f.sqlite
          .prepare(
            "INSERT INTO shipping_zones(id,code,name,kind,postal_prefixes,active,created_at) VALUES('quote-parcel-zone','quote-parcel','Synthetic parcel','parcel_peninsular','[\"peninsular\"]',1,?)"
          )
          .run(utc())
        f.sqlite
          .prepare(
            "INSERT INTO shipping_rates(id,zone_id,method_code,service_profile,net_cents,tax_rate_basis_points,eta_min_days,eta_max_days,rate_version,active,created_at) VALUES('quote-parcel-rate','quote-parcel-zone','parcel','parcel',500,2100,1,2,1,1,?)"
          )
          .run(utc())
        const snapshot = await approved(f, utc(1800000), {
          shippingMethod: 'parcel',
          freeShippingThresholdCents: threshold
        })
        expect(snapshot.shipping?.grossCents).toBe(approvedShippingGross)
        const product = f.sqlite.prepare("SELECT catalog_version AS version FROM products WHERE id='p-1'").get() as {
          version: number
        }
        const latest = f.sqlite
          .prepare(
            "SELECT id FROM variant_price_versions WHERE variant_id=? AND status='approved' ORDER BY valid_from DESC,created_at DESC,id DESC LIMIT 1"
          )
          .get(VARIANT) as { id: string }
        await scheduleD1VariantPrice(
          f.database,
          CLAIMS,
          {
            variantId: VARIANT,
            grossCents: changedUnitPrice,
            compareAtGrossCents: null,
            volumeTiers: [],
            validFrom: utc(),
            expectedCatalogVersion: product.version,
            expectedLatestApprovedId: latest.id,
            reason: REASON
          },
          { idempotencyKey: testUuid() }
        )
        const input = await checkout(f, 2, {
          method: 'parcel',
          freeShippingThresholdCents: threshold,
          salesQuote: { quoteId: snapshot.id, version: snapshot.version, approvedHash: snapshot.approvedHash! }
        })
        const key = testUuid()
        const receipt = await convertD1SalesQuote(f.database, BUYER_CLAIMS, snapshot.id, conversion(snapshot, input), {
          idempotencyKey: key,
          freeShippingThresholdCents: threshold
        })
        expect(
          await convertD1SalesQuote(f.database, BUYER_CLAIMS, snapshot.id, conversion(snapshot, input), {
            idempotencyKey: key,
            freeShippingThresholdCents: threshold
          })
        ).toEqual(receipt)
        expect(
          f.sqlite
            .prepare('SELECT shipping_gross_cents AS shipping, total_gross_cents AS total FROM orders WHERE id=?')
            .get(receipt.orderId)
        ).toEqual({
          shipping: approvedShippingGross,
          total: snapshot.total!.grossCents
        })
        expect(counts(f)).toEqual([1, 1])
        expect(
          f.sqlite.prepare("SELECT count(*) AS n FROM inventory_reservations WHERE status='reserved'").get()
        ).toEqual({ n: 1 })
      } finally {
        f.sqlite.close()
      }
    }
  )
  it('rejects null claims as unauthenticated for direct administrative detail and list reads', async () => {
    const f = await fixture()
    try {
      await expect(readD1AdminSalesQuote(f.database, null, testUuid())).rejects.toMatchObject({
        code: 'unauthenticated'
      })
      await expect(listD1SalesQuotes(f.database, null, 'admin')).rejects.toMatchObject({
        code: 'unauthenticated'
      })
    } finally {
      f.sqlite.close()
    }
  })
  it('correlates conversion recovery with the shared strict intent hash computed before sending without transport credentials', async () => {
    const f = await fixture()
    try {
      const snapshot = await approved(f),
        input = conversion(snapshot, await checkout(f))
      const { cartId, token, ownerSession, now, idempotencyKey, correlationId, ...body } = input.checkout
      void [token, ownerSession, now, idempotencyKey, correlationId]
      const expectedHash = await salesQuoteConversionIntentHash(snapshot.id, cartId, {
        expectedVersion: input.expectedVersion,
        approvedHash: input.approvedHash,
        checkout: body
      })
      const key = testUuid(),
        receipt = await convertD1SalesQuote(f.database, BUYER_CLAIMS, snapshot.id, input, { idempotencyKey: key })
      expect(receipt.payloadHash).toBe(expectedHash)
      expect(await readD1SalesQuoteCommand(f.database, BUYER_CLAIMS, key, expectedHash)).toEqual({
        source: 'cloudflare',
        outcome: 'applied',
        receipt
      })
    } finally {
      f.sqlite.close()
    }
  })
  it('allows a commercial administrator without catalog.write to review and approve while withholding private costs and margins', async () => {
    const f = await fixture()
    try {
      f.sqlite.prepare('UPDATE variants SET cost_net_cents=200 WHERE id=?').run(VARIANT)
      f.sqlite.exec("DELETE FROM role_permissions WHERE role_code='operator' AND permission_code='catalog.write'")
      const snapshot = await approved(f)
      expect(snapshot).toMatchObject({ status: 'approved', goodsCostNetCents: null, goodsMarginNetCents: null })
      expect(snapshot.lines.every((line) => line.costUnitNetCents === null)).toBe(true)
      expect(counts(f)).toEqual([0, 0])
    } finally {
      f.sqlite.close()
    }
  })
  it('rejects quote revocation immediately before the real reservation and leaves no active stock hold or order', async () => {
    const f = await fixture()
    try {
      const snapshot = await approved(f),
        input = conversion(snapshot, await checkout(f))
      const reserve = vi.fn(async (value: Parameters<typeof reserveInventory>[1]) => {
        await executeD1SalesQuoteCommand(
          f.database,
          CLAIMS,
          'revoke',
          snapshot.id,
          { expectedVersion: snapshot.version, reason: REASON },
          { idempotencyKey: testUuid() }
        )
        return reserveInventory(f.database, value)
      })
      await expect(
        convertD1SalesQuote(f.database, BUYER_CLAIMS, snapshot.id, input, {
          idempotencyKey: testUuid(),
          inventory: { reserve, release: (value) => releaseReservation(f.database, value) }
        })
      ).rejects.toMatchObject({ code: 'quote_not_approved' })
      expect(reserve).toHaveBeenCalledTimes(1)
      expect(counts(f)[0]).toBe(0)
      expect(
        f.sqlite.prepare("SELECT count(*) AS n FROM inventory_reservations WHERE status='reserved'").get()
      ).toEqual({ n: 0 })
      expect(f.sqlite.prepare('SELECT count(*) AS n FROM email_outbox_events').get()).toEqual({ n: 0 })
    } finally {
      f.sqlite.close()
    }
  })
  it.each(['session_created_at', 'email_verified_at'] as const)(
    'rejects future %s inside the real reservation batch before creating any hold',
    async (field) => {
      const f = await fixture()
      try {
        const snapshot = await approved(f),
          input = conversion(snapshot, await checkout(f))
        let reservationSucceeded = false
        const reserve = vi.fn(async (value: Parameters<typeof reserveInventory>[1]) => {
          if (field === 'session_created_at')
            f.sqlite.prepare('UPDATE auth_sessions SET created_at=? WHERE id=?').run(utc(60000), BUYER_CLAIMS.sessionId)
          else
            f.sqlite
              .prepare('UPDATE identities SET email_verified_at=? WHERE id=?')
              .run(utc(60000), BUYER_CLAIMS.identityId)
          const result = await reserveInventory(f.database, value)
          reservationSucceeded = true
          return result
        })
        await expect(
          convertD1SalesQuote(f.database, BUYER_CLAIMS, snapshot.id, input, {
            idempotencyKey: testUuid(),
            inventory: { reserve, release: (value) => releaseReservation(f.database, value) }
          })
        ).rejects.toBeDefined()
        expect(reserve).toHaveBeenCalledTimes(1)
        expect(reservationSucceeded).toBe(false)
        expect(counts(f)).toEqual([0, 0])
        expect(f.sqlite.prepare('SELECT count(*) AS n FROM email_outbox_events').get()).toEqual({ n: 0 })
      } finally {
        f.sqlite.close()
      }
    }
  )
  it('keeps the approved governed price after a public price change and converts repeated keys/carts into exactly one order and reservation', async () => {
    const f = await fixture()
    try {
      const snapshot = await approved(f)
      const product = f.sqlite.prepare("SELECT catalog_version AS version FROM products WHERE id='p-1'").get() as {
        version: number
      }
      const latest = f.sqlite
        .prepare(
          "SELECT id FROM variant_price_versions WHERE variant_id=? AND status='approved' ORDER BY valid_from DESC,created_at DESC,id DESC LIMIT 1"
        )
        .get(VARIANT) as { id: string } | undefined
      await scheduleD1VariantPrice(
        f.database,
        CLAIMS,
        {
          variantId: VARIANT,
          grossCents: snapshot.lines[0]!.unitGrossCents + 125,
          compareAtGrossCents: null,
          volumeTiers: [],
          validFrom: utc(),
          expectedCatalogVersion: product.version,
          expectedLatestApprovedId: latest?.id ?? null,
          reason: REASON
        },
        { idempotencyKey: testUuid() }
      )
      const input = await checkout(f),
        key = testUuid()
      const fresh = await quoteCart(f.database, {
        cartId: input.cartId,
        token: input.token,
        expectedVersion: 2,
        correlationId: 'new-price-proof',
        now: utc(),
        idempotencyKey: testUuid()
      })
      expect(fresh.outcome).toBe('quoted')
      if (fresh.outcome !== 'quoted') throw new Error('sales_quote_fresh_price_missing')
      expect(fresh.quote.lines[0]!.unitGrossCents).not.toBe(snapshot.lines[0]!.unitGrossCents)
      const first = await convertD1SalesQuote(f.database, BUYER_CLAIMS, snapshot.id, conversion(snapshot, input), {
        idempotencyKey: key
      })
      const second = await convertD1SalesQuote(f.database, BUYER_CLAIMS, snapshot.id, conversion(snapshot, input), {
        idempotencyKey: key
      })
      const otherCart = await checkout(f)
      const third = await convertD1SalesQuote(f.database, BUYER_CLAIMS, snapshot.id, conversion(snapshot, otherCart), {
        idempotencyKey: testUuid()
      })
      expect(second).toEqual(first)
      expect(third.orderId).toBe(first.orderId)
      expect(counts(f)).toEqual([1, 1])
      expect(
        f.sqlite.prepare('SELECT unit_gross_cents AS price FROM order_lines WHERE order_id=?').get(first.orderId)
      ).toEqual({ price: snapshot.lines[0]!.unitGrossCents })
      expect(f.sqlite.prepare('SELECT total_gross_cents AS total FROM orders WHERE id=?').get(first.orderId)).toEqual({
        total: snapshot.total!.grossCents
      })
    } finally {
      f.sqlite.close()
    }
  })
  it.each(['expired', 'altered_hash', 'foreign', 'wrong_quantity'] as const)(
    'rejects %s with zero order, stock or payment effects',
    async (mode) => {
      const f = await fixture()
      try {
        const snapshot = await approved(f),
          input = conversion(snapshot, await checkout(f, mode === 'wrong_quantity' ? 3 : 2))
        if (mode === 'altered_hash') input.approvedHash = '0'.repeat(64)
        const before = economic(f)
        await expect(
          convertD1SalesQuote(f.database, mode === 'foreign' ? FOREIGN_CLAIMS : BUYER_CLAIMS, snapshot.id, input, {
            idempotencyKey: testUuid(),
            ...(mode === 'expired' ? { now: snapshot.definition.validUntil } : {})
          })
        ).rejects.toMatchObject({
          code: mode === 'expired' ? 'quote_expired' : mode === 'foreign' ? 'not_found' : 'quote_changed'
        })
        expect(economic(f)).toEqual(before)
      } finally {
        f.sqlite.close()
      }
    }
  )
  it('rechecks owner session before replaying a completed conversion', async () => {
    const f = await fixture()
    try {
      const snapshot = await approved(f),
        input = conversion(snapshot, await checkout(f)),
        key = testUuid()
      await convertD1SalesQuote(f.database, BUYER_CLAIMS, snapshot.id, input, { idempotencyKey: key })
      f.sqlite.prepare('UPDATE auth_sessions SET revoked_at=? WHERE id=?').run(utc(), BUYER_CLAIMS.sessionId)
      const before = economic(f)
      await expect(
        convertD1SalesQuote(f.database, BUYER_CLAIMS, snapshot.id, input, { idempotencyKey: key })
      ).rejects.toMatchObject({ code: 'unauthenticated' })
      expect(economic(f)).toEqual(before)
    } finally {
      f.sqlite.close()
    }
  })
  it('serializes concurrent conversions from two different carts and keys by the quote, not by either cart', async () => {
    const f = await fixture()
    try {
      const snapshot = await approved(f),
        first = conversion(snapshot, await checkout(f)),
        second = conversion(snapshot, await checkout(f))
      const results = await Promise.all([
        convertD1SalesQuote(f.database, BUYER_CLAIMS, snapshot.id, first, { idempotencyKey: testUuid() }),
        convertD1SalesQuote(f.database, BUYER_CLAIMS, snapshot.id, second, { idempotencyKey: testUuid() })
      ])
      expect(results[0]!.orderId).toBeTruthy()
      expect(results[1]!.orderId).toBe(results[0]!.orderId)
      expect(counts(f)).toEqual([1, 1])
      expect(f.sqlite.prepare('SELECT count(DISTINCT attempt_id) AS n FROM orders').get()).toEqual({ n: 1 })
    } finally {
      f.sqlite.close()
    }
  })
  it('rejects revocation between reservation and final order batch, without retaining a live reservation or order', async () => {
    const f = await fixture()
    try {
      const snapshot = await approved(f),
        input = conversion(snapshot, await checkout(f))
      const observed = beforeOrderBatch(f.database, async () => {
        await executeD1SalesQuoteCommand(
          f.database,
          CLAIMS,
          'revoke',
          snapshot.id,
          { expectedVersion: snapshot.version, reason: REASON },
          { idempotencyKey: testUuid() }
        )
      })
      await expect(
        convertD1SalesQuote(observed, BUYER_CLAIMS, snapshot.id, input, { idempotencyKey: testUuid() })
      ).rejects.toMatchObject({ code: 'quote_not_approved' })
      expect(counts(f)[0]).toBe(0)
      expect(
        f.sqlite.prepare("SELECT count(*) AS n FROM inventory_reservations WHERE status='reserved'").get()
      ).toEqual({ n: 0 })
      expect(f.sqlite.prepare('SELECT count(*) AS n FROM email_outbox_events').get()).toEqual({ n: 0 })
    } finally {
      f.sqlite.close()
    }
  })
  it('retains one recoverable conversion after an outbox rollback and confirms it by manual exact receipt GET', async () => {
    const f = await fixture()
    try {
      const snapshot = await approved(f),
        input = conversion(snapshot, await checkout(f)),
        key = testUuid()
      f.sqlite.exec(
        "CREATE TRIGGER synthetic_sales_quote_email_failure BEFORE INSERT ON email_outbox_events BEGIN SELECT RAISE(ABORT,'synthetic_outbox_failure'); END"
      )
      await expect(
        convertD1SalesQuote(f.database, BUYER_CLAIMS, snapshot.id, input, { idempotencyKey: key })
      ).rejects.toBeDefined()
      expect(counts(f)[0]).toBe(0)
      expect(f.sqlite.prepare('SELECT count(*) AS n FROM email_outbox_events').get()).toEqual({ n: 0 })
      f.sqlite.exec('DROP TRIGGER synthetic_sales_quote_email_failure')
      const receipt = await convertD1SalesQuote(f.database, BUYER_CLAIMS, snapshot.id, input, { idempotencyKey: key })
      const before = economic(f)
      expect(await readD1SalesQuoteCommand(f.database, BUYER_CLAIMS, key, receipt.payloadHash)).toEqual({
        source: 'cloudflare',
        outcome: 'applied',
        receipt
      })
      expect(economic(f)).toEqual(before)
      expect(counts(f)).toEqual([1, 1])
    } finally {
      f.sqlite.close()
    }
  })
  it('preserves the existing checkout primitive without sales quote authority', async () => {
    const f = await fixture()
    const outbound = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('synthetic_network_forbidden'))
    try {
      const input = await checkout(f)
      const result = await placeOrder(f.database, input, {
        reserve: (value) => reserveInventory(f.database, value),
        release: (value) => releaseReservation(f.database, value)
      })
      expect(result.outcome).toBe('order_created')
      expect(counts(f)).toEqual([1, 1])
      expect(outbound).not.toHaveBeenCalled()
    } finally {
      outbound.mockRestore()
      f.sqlite.close()
    }
  })
  it('normalizes command intent and never accepts client money as draft authority', async () => {
    const input = {
      customerId: CUSTOMER,
      lines: [{ variantId: 'v-1-1', quantity: 2 }],
      destination: { postalCode: '46870', city: 'Ontinyent' },
      shippingMethod: 'pickup',
      validUntil: utc(1800000),
      reason: REASON
    }
    expect(salesQuoteCreateInputSchema.safeParse({ ...input, unitGrossCents: 1 }).success).toBe(false)
    expect(await salesQuoteIntentHash('create', null, input)).toBe(
      await salesQuoteIntentHash('create', null, { ...input, reason: ` ${REASON} ` })
    )
  })
})

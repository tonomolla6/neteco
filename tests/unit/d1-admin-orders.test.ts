import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { readFile } from 'node:fs/promises'
import { createCart, quoteCart, setCartLine } from '../../workers/catalog/cart'
import { placeOrder, requestShippingOptions } from '../../workers/catalog/checkout'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import { handleD1AdminOrdersRequest, parseAdminOrderQuery } from '../../workers/catalog/admin-orders-http'
import {
  listD1AdminOrders,
  readD1AdminOrder,
  readD1AdminOperations,
  readD1AdminStats,
  type AdminOrderList,
  type D1AdminOrderDetail,
  type D1AdminStats
} from '../../workers/catalog/admin-orders'
import { d1OverSqlite, openMigratedDatabase, seedInventoryFixture } from '../support/d1-sqlite'
import { provisionPublicationValidityFixture } from '../support/publication-validity-fixture'
import { afterPublicMediaRead, publishMediaFixture, type JsonTestResponse } from '../support/media-publication-fixture'
import { createSupportTicket, executeSupportAdminCommand } from '../../workers/support/operations'

const NOW = '2026-08-25T09:00:00Z'
const IDENTITY = '10000000-0000-4000-8000-000000000001'
const SESSION = '20000000-0000-4000-8000-000000000001'
const CUSTOMER = '30000000-0000-4000-8000-000000000001'
const CLAIMS = { identityId: IDENTITY, sessionId: SESSION, sessionVersion: 1 }
const COOKIE = { password: 'admin-order-test-secret-32-characters-or-more', maxAgeSeconds: 3600 }
type OperationsBody = Extract<Awaited<ReturnType<typeof readD1AdminOperations>>, { outcome: 'found' }>['data']
type AdminTestBody<Path extends string> = Path extends '/api/admin/stats'
  ? D1AdminStats
  : Path extends '/api/admin/operations'
    ? OperationsBody
    : Path extends `/api/admin/orders/${string}/detail`
      ? D1AdminOrderDetail
      : AdminOrderList

describe('D1 administrative order reads and frontend contract', () => {
  let sqlite: DatabaseSync
  let database: D1Database
  let cookie: string
  let pending: string
  let paid: string
  let cancelled: string
  let incident: string

  async function order(
    index: number,
    business = false,
    owner = false,
    contactName = `Buyer ${index}`,
    variantIds = ['v-1-1'],
    taxSource: 'contract' | 'billing-only' = 'contract'
  ) {
    const cart = await createCart(database, { correlationId: 'admin-test', now: NOW })
    for (const [lineIndex, variantId] of variantIds.entries())
      await setCartLine(database, {
        cartId: cart.cartId,
        token: cart.token,
        variantId,
        quantity: index,
        expectedVersion: lineIndex + 1,
        idempotencyKey: `line-${lineIndex}`,
        correlationId: 'admin-test',
        now: NOW
      })
    const shipping = await requestShippingOptions(database, {
      cartId: cart.cartId,
      token: cart.token,
      expectedVersion: variantIds.length + 1,
      idempotencyKey: 'shipping',
      correlationId: 'admin-test',
      now: NOW,
      destination: { city: 'Ontinyent', postalCode: '46870' }
    })
    if (shipping.outcome !== 'options') throw new Error(shipping.outcome)
    const quote = await quoteCart(database, {
      cartId: cart.cartId,
      token: cart.token,
      expectedVersion: variantIds.length + 1,
      idempotencyKey: 'quote',
      correlationId: 'admin-test',
      now: NOW
    })
    if (quote.outcome !== 'quoted') throw new Error(quote.outcome)
    const option = (shipping.body.options as Array<{ optionIndex: number; optionHash: string }>)[0]!
    const result = await placeOrder(database, {
      cartId: cart.cartId,
      token: cart.token,
      expectedVersion: quote.quote.cartVersion,
      quoteId: quote.quote.quoteId,
      shippingQuoteId: shipping.body.shippingQuoteId as string,
      selectedOptionIndex: option.optionIndex,
      selectedOptionHash: option.optionHash,
      contactEmail: `buyer${index}@example.invalid`,
      contactName,
      contactPhone: '+34600111222',
      buyerCompanyName: business ? 'Empresa contractual SL' : undefined,
      buyerTaxId: business && taxSource === 'contract' ? 'B12345674' : undefined,
      ownerSession: owner ? CLAIMS : undefined,
      shippingAddress: {
        recipientName: `Recipient ${index}`,
        line1: 'Carrer Major 1',
        city: 'Ontinyent',
        province: 'València',
        postalCode: '46870',
        countryCode: 'ES',
        phone: '+34600111222',
        instructions: 'Entregar por la mañana'
      },
      billingAddress: {
        recipientName: `Buyer ${index}`,
        line1: 'Carrer Major 2',
        city: 'Ontinyent',
        province: 'València',
        postalCode: '46870',
        countryCode: 'ES',
        nif: business ? 'B12345674' : undefined
      },
      consentTos: true,
      consentPrivacy: true,
      idempotencyKey: 'checkout',
      correlationId: 'admin-test',
      now: NOW
    })
    if (result.outcome !== 'order_created') throw new Error(result.outcome)
    return (result.body as { id: string }).id
  }

  function payment(orderId: string, status: 'paid' | 'stock_exception', merchantOrder: string) {
    const id = crypto.randomUUID()
    const total = (
      sqlite.prepare('SELECT total_gross_cents AS total FROM orders WHERE id = ?').get(orderId) as { total: number }
    ).total
    sqlite
      .prepare(
        `INSERT INTO payment_intents(id, order_id, provider, merchant_order, method, status, amount_gross_cents,
      currency, request_hash, redirect_envelope_hash, provider_reference, response_code, expires_at, correlation_id, created_at, updated_at)
      VALUES (?, ?, 'redsys', ?, 'card', ?, ?, 'EUR', ?, ?, 'SAFE-REFERENCE', '0000', '2026-08-25T10:00:00Z', 'private-correlation', ?, ?)`
      )
      .run(
        id,
        orderId,
        merchantOrder,
        status === 'paid' ? 'captured' : status,
        total,
        'a'.repeat(64),
        'b'.repeat(64),
        NOW,
        NOW
      )
    sqlite
      .prepare(
        `INSERT INTO order_payment_states(order_id, status, active_intent_id, paid_gross_cents, updated_at)
      VALUES (?, ?, ?, ?, ?)`
      )
      .run(orderId, status, id, status === 'paid' ? total : 0, NOW)
    sqlite
      .prepare(
        `INSERT INTO payment_events(id, payment_intent_id, order_id, provider_event_id, event_type,
      payload_hash, response_code, provider_reference, correlation_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, '0000', 'SAFE-REFERENCE', 'private-correlation', ?)`
      )
      .run(
        crypto.randomUUID(),
        id,
        orderId,
        `private-provider-event-${merchantOrder}`,
        status === 'paid' ? 'captured' : 'stock_exception',
        'c'.repeat(64),
        NOW
      )
    return id
  }

  beforeEach(async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(NOW))
    sqlite = await openMigratedDatabase()
    // Checkout pricing resolves contractual B2B prices, which needs the B2B schema.
    sqlite.exec(await readFile('db/d1/migrations/0101_b2b_price_lists_credit.sql', 'utf8'))
    // This local SQL clock reads the current fake Date for each statement; no
    // captured instant or scanner lifetime extension enters production code.
    sqlite.function('synthetic_admin_order_clock', () => {
      const milliseconds = Date.now(),
        instant = new Date(milliseconds).toISOString()
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(instant) || Date.parse(instant) !== milliseconds)
        throw new Error('invalid_synthetic_admin_order_clock')
      return instant
    })
    const nativeDatabase = d1OverSqlite(sqlite),
      nativePrepare = nativeDatabase.prepare.bind(nativeDatabase)
    database = new Proxy(nativeDatabase, {})
    database.prepare = (sql: string) => nativePrepare(sql.replaceAll("'now'", 'synthetic_admin_order_clock()'))
    seedInventoryFixture(sqlite)
    await provisionPublicationValidityFixture(database, {
      productIds: ['p-1', 'p-2', 'p-3', 'p-4', 'p-5', 'p-6'],
      now: '2026-01-01T00:00:00Z'
    })
    sqlite.exec(`
      INSERT INTO shipping_zones(id, code, name, kind, postal_prefixes, active, created_at)
        VALUES ('pickup-zone', 'pickup', 'Pickup', 'warehouse_pickup', '[]', 1, '${NOW}');
      INSERT INTO shipping_rates(id, zone_id, method_code, service_profile, net_cents, tax_rate_basis_points,
        eta_min_days, eta_max_days, rate_version, active, created_at)
        VALUES ('pickup-rate', 'pickup-zone', 'pickup', 'parcel', 0, 2100, 0, 0, 1, 1, '${NOW}');
      INSERT INTO customers(id, name, created_at, updated_at) VALUES ('${CUSTOMER}', 'Current profile', '${NOW}', '${NOW}');
      INSERT INTO identities(id, email, password_hash, email_verified_at, status, customer_id, created_at, updated_at)
        VALUES ('${IDENTITY}', 'admin@example.invalid', 'private-password-hash', '${NOW}', 'active', '${CUSTOMER}', '${NOW}', '${NOW}');
      INSERT INTO auth_sessions(id, identity_id, session_version, mfa_verified, created_at, expires_at)
        VALUES ('${SESSION}', '${IDENTITY}', 1, 1, '2026-08-25T08:00:00Z', '2026-08-25T11:00:00Z');
      INSERT INTO roles VALUES ('admin', 'Admin', 'fixture');
      INSERT INTO permissions VALUES ('administration.manage', 'administration', 'manage', 'fixture');
      INSERT INTO role_permissions VALUES ('admin', 'administration.manage');
      INSERT INTO identity_roles(identity_id, role_code, granted_at) VALUES ('${IDENTITY}', 'admin', '${NOW}');
      INSERT INTO companies(id, customer_id, legal_name, tax_id, status, created_at, updated_at)
        VALUES ('company-test', '${CUSTOMER}', 'Changed current company', 'B87654321', 'approved', '${NOW}', '${NOW}');
      UPDATE products SET attributes = '{"image":"/img/fixture.webp","visual":{"type":"botella","color":"#123456"}}' WHERE id = 'p-1';
    `)
    pending = await order(1)
    paid = await order(2, true, true)
    cancelled = await order(3)
    incident = await order(4, false, true)
    sqlite.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ?").run(cancelled)
    payment(paid, 'paid', '12340001')
    payment(incident, 'stock_exception', '12340002')
    cookie = (await issueD1SessionCookie(database, CLAIMS, COOKIE))!.split(';')[0]!
  })

  afterEach(() => {
    sqlite.close()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  async function request<Path extends string = '/api/admin/orders'>(
    path: Path = '/api/admin/orders' as Path,
    headers: Record<string, string | undefined> = { cookie },
    method = 'GET',
    db = database
  ): Promise<JsonTestResponse<AdminTestBody<Path>>> {
    const definedHeaders = Object.fromEntries(
      Object.entries(headers).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    )
    return (await handleD1AdminOrdersRequest(
      new Request(`https://neteco.invalid${path}`, { headers: definedHeaders, method }),
      {
        database: db,
        sessionCookieConfiguration: COOKIE,
        origin: 'https://neteco.invalid',
        now: NOW
      }
    ))! as JsonTestResponse<AdminTestBody<Path>>
  }

  async function supportTicket(
    index: number,
    state = 'open',
    slaDueAt: string | null = NOW,
    nextActionAt: string | null = null
  ) {
    sqlite.exec(
      "INSERT OR IGNORE INTO permissions VALUES ('support.manage','support','manage','Synthetic'); INSERT OR IGNORE INTO role_permissions VALUES ('admin','support.manage')"
    )
    const ticket = await createSupportTicket(
      database,
      { kind: 'anonymous', claims: null, customerId: null, key: 'anonymous:' + 'a'.repeat(64) },
      {
        name: 'Private requester',
        email: `private-support-${index}@example.invalid`,
        category: 'other',
        subject: 'Private support subject marker',
        message: 'Private support initial message marker',
        privacyAcknowledged: true,
        website: ''
      },
      { idempotencyKey: `support-create-${index}`, now: NOW }
    )
    await executeSupportAdminCommand(
      database,
      CLAIMS,
      ticket.publicRef,
      {
        action: 'update',
        expectedVersion: 1,
        reason: 'Synthetic operational deadline',
        state: state === 'closed' ? 'resolved' : state,
        priority: 'normal',
        ownerId: null,
        slaDueAt,
        nextActionAt,
        ...(['resolved', 'closed'].includes(state) ? { resolution: 'Synthetic support resolution marker' } : {})
      },
      { idempotencyKey: `support-update-${index}`, now: NOW }
    )
    if (state === 'closed')
      await executeSupportAdminCommand(
        database,
        CLAIMS,
        ticket.publicRef,
        {
          action: 'update',
          expectedVersion: 2,
          reason: 'Synthetic close operation',
          state: 'closed',
          priority: 'normal',
          ownerId: null,
          slaDueAt,
          nextActionAt,
          resolution: 'Synthetic closed support marker'
        },
        { idempotencyKey: `support-close-${index}`, now: NOW }
      )
    return ticket
  }

  it('counts only active support SLA and explicit follow-ups strictly before the authoritative snapshot instant', async () => {
    const past = '2026-08-25T08:59:59Z',
      future = '2026-08-25T09:00:01Z'
    await supportTicket(1, 'open', past, past)
    await supportTicket(2, 'waiting_customer', past, null)
    await supportTicket(3, 'waiting_provider', past, past)
    await supportTicket(4, 'resolved', past, past)
    await supportTicket(5, 'closed', past, past)
    await supportTicket(6, 'open', NOW, NOW)
    await supportTicket(7, 'open', future, future)
    await supportTicket(8, 'open', null, past)
    const before = sqlite.prepare('SELECT total_changes() AS n').get()
    const response = await request('/api/admin/operations')
    const body = await response.json()
    expect(body.summary).toMatchObject({ supportOverdue: 3, supportNextActionOverdue: 3 })
    expect(body.capabilities).toMatchObject({ supportOverdue: true, supportNextActionOverdue: true })
    expect(body.generatedAt).toBe(NOW)
    expect(response.headers.get('cache-control')).toContain('no-store')
    expect(sqlite.prepare('SELECT total_changes() AS n').get()).toEqual(before)
    for (const sensitive of [
      'Private requester',
      'private-support-',
      'Private support subject',
      'Private support initial',
      'Synthetic support resolution',
      'SOP-'
    ])
      expect(JSON.stringify(body)).not.toContain(sensitive)
    vi.setSystemTime(new Date(future))
    const next = await readD1AdminOperations(database, CLAIMS, future)
    expect(next).toMatchObject({
      outcome: 'found',
      data: { generatedAt: future, summary: { supportOverdue: 4, supportNextActionOverdue: 4 } }
    })
  })

  it('aggregates all support tickets rather than an administrative list page and withholds revoked reads', async () => {
    await supportTicket(1, 'open', '2026-08-25T08:59:59Z', null)
    // Duplicate the genuine immutable creation proof into independent synthetic
    // tickets without bypassing any schema constraint, FK or projection trigger.
    for (let index = 2; index <= 106; index++) {
      const id = `70000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        command = `80000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        ref = 'SOP-' + String(index).padStart(24, '0')
      const snapshot = JSON.stringify({ priority: 'normal', customerId: null, orderId: null })
      sqlite
        .prepare(
          `INSERT INTO support_commands(id,nonce,actor_key,actor_type,ticket_id,public_ref,action,idempotency_key,payload_hash,input,snapshot,expected_version,result_version,to_state,response,created_at)
        VALUES (?,?,'anonymous:synthetic','anonymous',?,?,'created',?,?,'{}',?,0,1,'open',?,?)`
        )
        .run(
          command,
          command,
          id,
          ref,
          `scale-${index}`,
          'a'.repeat(64),
          snapshot,
          JSON.stringify({
            commandId: command,
            publicRef: ref,
            version: 1,
            state: 'open',
            inventoryEffect: 'none',
            economicEffect: 'none'
          }),
          NOW
        )
      sqlite
        .prepare(
          `INSERT INTO support_tickets(id,public_ref,category,subject,requester,state,priority,sla_due_at,version,last_command_id,created_at,updated_at)
        VALUES (?,?,'other','Synthetic aggregate fixture','{}','open','normal',?,1,?,?,?)`
        )
        .run(id, ref, '2026-08-25T08:59:59Z', command, NOW, NOW)
    }
    const sqls: string[] = []
    const wrapped = {
      ...database,
      prepare(sql: string) {
        sqls.push(sql)
        return database.prepare(sql)
      }
    } as D1Database
    expect(await readD1AdminOperations(wrapped, CLAIMS, NOW)).toMatchObject({
      outcome: 'found',
      data: { summary: { supportOverdue: 106, supportNextActionOverdue: 0 } }
    })
    expect(sqls).toHaveLength(3) // authorization before/after, one complete aggregate snapshot
    sqlite.prepare("DELETE FROM role_permissions WHERE permission_code='administration.manage'").run()
    expect(await readD1AdminOperations(database, CLAIMS, NOW)).toEqual({ outcome: 'denied', code: 'forbidden' })
  })

  it('uses only the exact historical SKU publication without altering contractual totals, customer or payment facts', async () => {
    sqlite.exec(`UPDATE products SET attributes = '{"image":"https://unapproved.example.invalid/product.jpg"}' WHERE id = 'p-1';
      UPDATE variants SET image = '/img/products/unapproved.webp' WHERE id = 'v-1-1';
      INSERT INTO variants(id, legacy_id, product_id, sku, format, status, price_gross_cents, tax_class_id, shipping_profile_id, mpn)
      VALUES ('v-1-2', 12, 'p-1', 'SKU-1-2', 'Otro color', 'published', 900, 't21', 'sp1', 'FIXTURE-SKU-1-2')`)
    await publishMediaFixture(database, { now: NOW, productId: 'p-1' })
    await publishMediaFixture(database, { now: NOW, productId: 'p-1', variantId: 'v-1-2' })
    const snapshots = sqlite.prepare('SELECT * FROM order_lines WHERE order_id = ?').all(paid)
    const baseline = await (await request(`/api/admin/orders/${paid}/detail`)).json()
    expect(baseline.lines[0]).toMatchObject({ image: null, imageAlt: null, lineGross: 1000 })
    const photo = await publishMediaFixture(database, { now: NOW, productId: 'p-1', variantId: 'v-1-1' })
    const published = await (await request(`/api/admin/orders/${paid}/detail`)).json()
    expect(published).toEqual({
      ...baseline,
      lines: [{ ...baseline.lines[0], image: photo.image, imageAlt: photo.imageAlt }]
    })
    for (const forbidden of [
      'unapproved',
      'productUuid',
      'variantUuid',
      'currentSku',
      photo.uploadId,
      'object_key',
      'scannerVersion'
    ])
      expect(JSON.stringify(published)).not.toContain(forbidden)
    sqlite.exec(
      "UPDATE variants SET price_gross_cents = 900, format = 'Formato actual cambiado' WHERE id = 'v-1-1'; UPDATE products SET name = 'Nombre actual cambiado' WHERE id = 'p-1'"
    )
    expect(await (await request(`/api/admin/orders/${paid}/detail`)).json()).toEqual(published)
    await photo.withdraw()
    expect(await (await request(`/api/admin/orders/${paid}/detail`)).json()).toEqual(baseline)
    expect(sqlite.prepare('SELECT * FROM order_lines WHERE order_id = ?').all(paid)).toEqual(snapshots)
  })

  it('does not attach a current photo when the contractual SKU no longer matches', async () => {
    const baseline = await readD1AdminOrder(database, CLAIMS, NOW, paid)
    await publishMediaFixture(database, { now: NOW, productId: 'p-1', variantId: 'v-1-1' })
    sqlite.exec("UPDATE variants SET sku = 'REUSED-DIFFERENT-SKU' WHERE id = 'v-1-1'")
    expect(await readD1AdminOrder(database, CLAIMS, NOW, paid)).toEqual(baseline)
  })

  it.each([1, 6])('batches media for %i administrative order lines without N+1 queries', async (count) => {
    const orderId = await order(
      1,
      false,
      false,
      'Multi-line buyer',
      Array.from({ length: count }, (_, i) => `v-${i + 1}-1`)
    )
    const prepare = vi.spyOn(database, 'prepare')
    const result = await readD1AdminOrder(database, CLAIMS, NOW, orderId)
    expect(result).toMatchObject({
      outcome: 'found',
      data: { lines: Array.from({ length: count }, () => expect.objectContaining({ image: null, imageAlt: null })) }
    })
    expect(prepare).toHaveBeenCalledTimes(13)
    expect(
      prepare.mock.calls.filter(([sql]) => /^SELECT\s+\*\s+FROM\s+orders\s+WHERE\s+id\s*=\s*\?1$/i.test(sql.trim()))
    ).toHaveLength(1)
    expect(prepare.mock.calls.filter(([sql]) => sql.includes('WITH supplied_now AS'))).toHaveLength(1)
  })

  it.each([
    ['revoked', 'unauthenticated'],
    ['permission', 'forbidden'],
    ['mfa', 'mfa_required'],
    ['email_unverified', 'email_unverified']
  ] as const)(
    'rechecks %s after media enrichment before returning private administrative detail',
    async (change, code) => {
      const wrapped = afterPublicMediaRead(database, () => {
        if (change === 'revoked')
          sqlite.prepare('UPDATE auth_sessions SET revoked_at = ? WHERE id = ?').run(NOW, SESSION)
        if (change === 'permission')
          sqlite
            .prepare(
              "DELETE FROM role_permissions WHERE role_code = 'admin' AND permission_code = 'administration.manage'"
            )
            .run()
        if (change === 'mfa') sqlite.prepare('UPDATE auth_sessions SET mfa_verified = 0 WHERE id = ?').run(SESSION)
        if (change === 'email_unverified')
          sqlite.prepare('UPDATE identities SET email_verified_at = NULL WHERE id = ?').run(IDENTITY)
      })
      expect(await readD1AdminOrder(wrapped, CLAIMS, NOW, paid)).toEqual({ outcome: 'denied', code })
    }
  )

  it.each(['session', 'grant'] as const)(
    'withholds administrative detail when the %s expires naturally during media enrichment',
    async (kind) => {
      const expiresAt = '2026-08-25T09:00:01Z'
      if (kind === 'session')
        sqlite.prepare('UPDATE auth_sessions SET expires_at = ? WHERE id = ?').run(expiresAt, SESSION)
      else
        sqlite
          .prepare("UPDATE identity_roles SET expires_at = ? WHERE identity_id = ? AND role_code = 'admin'")
          .run(expiresAt, IDENTITY)
      const wrapped = afterPublicMediaRead(database, () => {
        vi.setSystemTime(new Date(expiresAt))
      })
      expect(await readD1AdminOrder(wrapped, CLAIMS, NOW, paid)).toEqual({
        outcome: 'denied',
        code: kind === 'session' ? 'unauthenticated' : 'forbidden'
      })
      expect(sqlite.prepare('SELECT revoked_at FROM auth_sessions WHERE id = ?').get(SESSION)).toEqual({
        revoked_at: null
      })
    }
  )

  it('paginates all D1 orders deterministically and preserves frontend summary fields', async () => {
    const first = await request('/api/admin/orders?perPage=2&sortKey=total&sortDir=asc')
    expect(first.status).toBe(200)
    const body = await first.json()
    expect(body.pagination).toEqual({ page: 1, perPage: 2, total: 4, pages: 2 })
    expect(body.items.map((item: { id: string }) => item.id)).toEqual([pending, paid])
    expect(body.items[1]).toMatchObject({
      status: 'pagado',
      orderStatus: 'awaiting_payment',
      paymentStatus: 'captured',
      fulfillmentStatus: 'pending',
      invoiceStatus: 'unavailable',
      name: 'Buyer 2',
      company: 'Empresa contractual SL',
      email: 'buyer2@example.invalid',
      city: 'Ontinyent',
      paymentMethod: 'card',
      shippingMethod: 'recogida',
      total: 1000,
      lines: 1,
      shipmentId: null,
      trackingNumber: null,
      shipmentStatus: null
    })
    const second = await (await request('/api/admin/orders?perPage=2&page=2&sortKey=total&sortDir=asc')).json()
    expect(second.items.map((item: { id: string }) => item.id)).toEqual([cancelled, incident])
    expect((await (await request('/api/admin/orders?page=999')).json()).items).toEqual([])
    expect(first.headers.get('cache-control')).toBe('private, no-store')
    expect(first.headers.get('vary')).toBe('Cookie')
  })

  it('filters and searches contractual buyer data without wildcard/SQL interpolation', async () => {
    for (const [query, ids] of [
      ['q=EMPRESA', [paid]],
      ['q=buyer1%40example.invalid', [pending]],
      ['q=b12345674', [paid]],
      ['customerType=b2b', [paid]],
      ['bucket=por_cobrar', [pending]],
      ['paymentStatus=captured', [paid]],
      ['orderStatus=cancelled', [cancelled]],
      ['bucket=incidencia&sortKey=total&sortDir=asc', [cancelled, incident]],
      ['bucket=por_preparar', [paid]],
      ['from=2026-08-25&to=2026-08-25&shippingMethod=pickup&customerType=b2b', [paid]],
      ['from=2026-08-26', []],
      ['q=%25', []],
      ["q=' OR 1=1 --", []]
    ] as const) {
      const response = await request(`/api/admin/orders?${query}`)
      expect(response.status, query).toBe(200)
      const data = await response.json()
      expect(
        data.items.map((item: { id: string }) => item.id),
        query
      ).toEqual(ids)
      expect(data.pagination.total).toBe(ids.length)
    }
  })

  it('searches the contractual billing NIF when the buyer-level tax ID is absent, without adding it to rows', async () => {
    const billingOnly = await order(5, true, false, 'Billing-only buyer', ['v-1-1'], 'billing-only')
    expect(sqlite.prepare('SELECT buyer_tax_id FROM orders WHERE id=?').get(billingOnly)).toEqual({
      buyer_tax_id: null
    })
    const response = await request('/api/admin/orders?q=b12345674&perPage=1&sortKey=total&sortDir=asc')
    expect(response.status).toBe(200)
    const first = await response.json()
    expect(first.pagination.total).toBe(2)
    expect(first.items.map((item) => item.id)).toEqual([paid])
    const second = await (
      await request('/api/admin/orders?q=b12345674&perPage=1&page=2&sortKey=total&sortDir=asc')
    ).json()
    expect(second.items.map((item) => item.id)).toEqual([billingOnly])
    expect(JSON.stringify([first.items, second.items])).not.toContain('B12345674')
    expect((await (await request('/api/admin/orders?q=B12345674%25')).json()).items).toEqual([])
  })

  it('searches Spanish accented names and Ñ with the same SQL folding before counting and paginating', async () => {
    const spanish = await order(5, false, false, 'Ángel Ñandú')
    for (const term of ['Ángel', 'ángel', 'ANGEL', 'Ñandú', 'ñandú', 'nandu']) {
      const response = await request(`/api/admin/orders?q=${encodeURIComponent(term)}&perPage=1`)
      expect(response.status, term).toBe(200)
      const body = await response.json()
      expect(
        body.items.map((item: { id: string }) => item.id),
        term
      ).toEqual([spanish])
      expect(body.pagination).toEqual({ page: 1, perPage: 1, total: 1, pages: 1 })
      const next = await (await request(`/api/admin/orders?q=${encodeURIComponent(term)}&perPage=1&page=2`)).json()
      expect(next.pagination.total).toBe(1)
      expect(next.items).toEqual([])
    }
  })

  it('reads immutable B2B snapshots, safe payment facts and bounded customer history', async () => {
    const response = await request(`/api/admin/orders/${paid}/detail`)
    expect(response.status).toBe(200)
    const detail = await response.json()
    expect(detail.customer).toEqual({
      name: 'Buyer 2',
      email: 'buyer2@example.invalid',
      phone: '+34600111222',
      company: 'Empresa contractual SL',
      companyStatus: null,
      taxId: 'B12345674',
      isGuest: false
    })
    expect(detail.shippingAddress).toMatchObject({
      recipientName: 'Recipient 2',
      line1: 'Carrer Major 1',
      instructions: 'Entregar por la mañana'
    })
    expect(detail.billingAddress).toMatchObject({ line1: 'Carrer Major 2', taxId: 'B12345674' })
    expect(detail.lines[0]).toMatchObject({
      id: `${paid}:0`,
      sku: 'SKU-1-1',
      name: 'Producto 1',
      quantity: 2,
      format: 'Botella 1 L',
      lineGross: 1000,
      taxRate: 2100,
      slug: 'producto-1',
      image: null,
      imageAlt: null,
      inCatalog: true
    })
    expect(detail.order.totals.subtotalNet + detail.order.totals.shippingNet + detail.order.totals.tax).toBe(
      detail.order.totals.total
    )
    expect(detail.payments[0]).toMatchObject({
      status: 'captured',
      amount: 1000,
      reference: 'SAFE-REFERENCE',
      lastEvent: 'captured',
      lastResponseCode: '0000',
      refunded: null
    })
    expect(detail.history.map((item: { id: string }) => item.id)).toEqual([incident])
    expect(detail.capabilities).toMatchObject({
      shipments: false,
      refunds: false,
      invoices: false,
      orderStatusUpdate: false
    })
    expect(detail.shipments).toEqual([])
    expect(detail.invoices).toEqual([])
    const text = JSON.stringify(detail)
    for (const privateField of [
      'payload_json',
      'token_hash',
      'payload_hash',
      'request_hash',
      'redirect_envelope_hash',
      'private-provider-event',
      'private-correlation',
      'private-password-hash',
      'attemptId',
      'reservationId'
    ])
      expect(text).not.toContain(privateField)
    expect(text).not.toContain('Changed current company')
    sqlite.exec("UPDATE variants SET status = 'hidden' WHERE id = 'v-1-1'")
    const unpublished = await (await request(`/api/admin/orders/${paid}/detail`)).json()
    expect(unpublished.lines[0]).toMatchObject({
      sku: 'SKU-1-1',
      name: 'Producto 1',
      slug: null,
      image: null,
      inCatalog: false
    })
    sqlite.exec(
      "UPDATE variants SET status = 'published' WHERE id = 'v-1-1'; UPDATE categories SET status = 'hidden' WHERE id = 'c1'"
    )
    const hiddenCategory = await (await request(`/api/admin/orders/${paid}/detail`)).json()
    expect(hiddenCategory.lines[0]).toMatchObject({
      sku: 'SKU-1-1',
      name: 'Producto 1',
      slug: null,
      image: null,
      visual: null,
      inCatalog: false
    })
  })

  it('does not link guest history by matching email or claim unavailable processes are working', async () => {
    const detail = await (await request(`/api/admin/orders/${pending}/detail`)).json()
    expect(detail.customer.isGuest).toBe(true)
    expect(detail.history).toEqual([])
    expect(detail.payments).toEqual([])
    expect(detail.order.paymentMethod).toBe('')
    expect(detail.order.fulfillmentStatus).toBe('pending')
    expect(detail.capabilities.fulfillmentRead).toBe(true)
    expect(detail.capabilities.shipments).toBe(false)
    expect(detail.order.invoiceStatus).toBe('unavailable')
    expect(detail.order.confirmedAt).toBeNull()
  })

  it('derives global dashboard counts independently of list pagination', async () => {
    const stats = await (await request('/api/admin/stats')).json()
    expect(stats).toMatchObject({
      products: 6,
      variants: 6,
      categories: 1,
      users: 2, // Administrative account plus the explicit synthetic publication reviewer.
      orders: 4,
      openOrders: 3,
      awaitingPayment: 1,
      paidOrders: 1,
      readyToShip: null
    })
    const operations = await (await request('/api/admin/operations')).json()
    expect(operations.summary).toMatchObject({
      inventoryExceptions: 1,
      queueDepth: 4,
      fiscalExceptions: 0,
      supportOverdue: 0,
      staleShipments: null,
      communicationFailures: null
    })
    expect(operations.capabilities).toMatchObject({
      inventoryExceptions: true,
      supportOverdue: true,
      staleRefunds: false
    })
    expect(operations.generatedAt).toBe(NOW)
  })

  it('counts one blocked fiscal obligation once across delivery and receipt without pretending an invoice exists', async () => {
    const intent = (sqlite.prepare('SELECT id FROM payment_intents WHERE order_id = ?').get(paid) as { id: string }).id
    sqlite
      .prepare(
        `INSERT INTO fiscal_outbox_events(id, order_id, payment_intent_id, event_type, schema_version,
      amount_gross_cents, currency, created_at) VALUES ('fiscal-test', ?, ?, 'invoice.evaluate.requested', 1, 1000, 'EUR', ?)`
      )
      .run(paid, intent, NOW)
    sqlite
      .prepare("INSERT INTO fiscal_evaluation_inbox(event_id, order_id, received_at) VALUES ('fiscal-test', ?, ?)")
      .run(paid, NOW)
    expect((await (await request('/api/admin/operations')).json()).summary.fiscalExceptions).toBe(1)
    const detail = await (await request(`/api/admin/orders/${paid}/detail`)).json()
    expect(detail.fiscalEvaluation).toEqual({ status: 'blocked_policy', createdAt: NOW })
    expect(detail.order.invoiceStatus).toBe('unavailable')
    expect(detail.invoices).toEqual([])
    expect(detail.capabilities.invoices).toBe(false)
  })

  it.each([
    ['DELETE FROM identity_roles', 'forbidden', 403],
    ['DELETE FROM role_permissions', 'forbidden', 403],
    ["UPDATE auth_sessions SET revoked_at = '2026-08-25T09:00:00Z'", 'unauthenticated', 401],
    ['UPDATE identities SET session_version = 2', 'unauthenticated', 401],
    ["UPDATE auth_sessions SET expires_at = '2026-08-25T09:00:00Z'", 'unauthenticated', 401],
    ["UPDATE identities SET status = 'disabled'", 'unauthenticated', 401],
    ['UPDATE identities SET email_verified_at = NULL', 'email_unverified', 403],
    ['UPDATE auth_sessions SET mfa_verified = 0', 'mfa_required', 403],
    [
      "UPDATE identity_roles SET expires_at = '2026-08-25T09:00:00Z', granted_at = '2026-08-25T08:00:00Z'",
      'forbidden',
      403
    ]
  ])('rechecks live authorization (%s) on every administrative read', async (mutation, code, status) => {
    sqlite.exec(mutation)
    for (const path of [
      '/api/admin/orders',
      `/api/admin/orders/${paid}/detail`,
      '/api/admin/stats',
      '/api/admin/operations'
    ]) {
      const response = await request(path)
      expect(response.status, path).toBe(status)
      expect(await response.json()).toEqual({ error: { code } })
      expect(response.headers.get('cache-control')).toContain('no-store')
    }
  })

  it('requires a sealed cookie, not forged headers, UUIDs or role claims', async () => {
    for (const headers of [
      {},
      { cookie: 'neteco-session=forged' },
      { cookie: `${cookie}; ${cookie}` },
      { 'x-session-id': SESSION, 'x-identity-id': IDENTITY, 'x-role': 'admin' }
    ]) {
      expect((await request('/api/admin/orders', headers)).status).toBe(401)
    }
    const other = { ...CLAIMS, identityId: crypto.randomUUID() }
    expect(await readD1AdminOrder(database, other, NOW, paid)).toEqual({ outcome: 'denied', code: 'unauthenticated' })
    expect(await listD1AdminOrders(database, null, NOW, parseAdminOrderQuery(new URLSearchParams())!)).toEqual({
      outcome: 'denied',
      code: 'unauthenticated'
    })
  })

  it('withholds data if a session is revoked during the read, including direct callers', async () => {
    let reads = 0
    const wrapped = {
      ...database,
      prepare(sql: string) {
        const statement = database.prepare(sql)
        if (sql.includes('SELECT count(*) AS total')) {
          const original = statement.first.bind(statement)
          statement.first = async <T>(column?: string): Promise<T | null> => {
            const result = column === undefined ? await original<T>() : await original<T>(column)
            reads++
            sqlite.exec(`UPDATE auth_sessions SET revoked_at = '${NOW}'`)
            return result
          }
        }
        return statement
      }
    } as D1Database
    const response = await request('/api/admin/orders', { cookie }, 'GET', wrapped)
    expect(reads).toBe(1)
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: { code: 'unauthenticated' } })
  })

  it('rejects invalid filters, ambiguous duplicate parameters and non-GET requests safely', async () => {
    for (const query of [
      'page=0',
      'page=1.5',
      'perPage=101',
      'page=1000001',
      'sortKey=token_hash',
      'sortDir=DESC%3BDROP',
      'bucket=unknown',
      'page=1&page=2',
      'from=2026-02-30',
      'from=2026-08-26&to=2026-08-25',
      'q=%00',
      `q=${'a'.repeat(121)}`,
      'token=secret',
      'paymentStatus=refunded'
    ]) {
      expect((await request(`/api/admin/orders?${query}`)).status, query).toBe(400)
    }
    for (const id of ['invalid', crypto.randomUUID()])
      expect((await request(`/api/admin/orders/${id}/detail`)).status).toBe(404)
    const mutation = await request('/api/admin/orders', { cookie }, 'POST')
    expect(mutation.status).toBe(405)
    expect(mutation.headers.get('allow')).toBe('GET')
    expect(
      await handleD1AdminOrdersRequest(new Request('https://neteco.invalid/api/products'), {
        database,
        sessionCookieConfiguration: COOKIE,
        origin: 'https://neteco.invalid'
      })
    ).toBeNull()
  })

  it('returns sanitized no-store failures for D1 outages and invalid deployment configuration', async () => {
    const unavailable = {
      prepare() {
        throw new Error('private database/token diagnostics')
      }
    } as unknown as D1Database
    const response = await request('/api/admin/stats', { cookie }, 'GET', unavailable)
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: { code: 'service_unavailable' } })
    const config = await handleD1AdminOrdersRequest(
      new Request('https://neteco.invalid/api/admin/orders', { headers: { cookie } }),
      { database, sessionCookieConfiguration: { ...COOKIE, password: 'short' }, origin: 'https://neteco.invalid' }
    )
    expect(config?.status).toBe(503)
    expect(await readD1AdminStats(database, null, NOW)).toMatchObject({ outcome: 'denied' })
    expect(await readD1AdminOperations(database, null, NOW)).toMatchObject({ outcome: 'denied' })
  })

  it('keeps the Shopify-like UI server-paginated and gates unsupported administrative actions', async () => {
    const list = await readFile(new URL('../../app/pages/admin/pedidos/index.vue', import.meta.url), 'utf8')
    const detail = await readFile(new URL('../../app/pages/admin/pedidos/[id].vue', import.meta.url), 'utf8')
    const dashboard = await readFile(new URL('../../app/pages/admin/index.vue', import.meta.url), 'utf8')
    expect(list).toContain('query: requestQuery')
    expect(list).toContain('pagination?.total')
    expect(list).toContain('v-if="canChangeState"')
    expect(detail).toContain('capabilities?.customerPreview')
    expect(detail).toContain('canShip && !data.shipments.length')
    expect(dashboard).toContain("statCount('awaitingPayment')")
    expect(dashboard).toContain('statsVerified')
    expect(dashboard).toContain('shipments === false')
  })
})

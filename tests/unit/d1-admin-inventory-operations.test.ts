import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { issueD1SessionCookie } from '../../workers/auth/session-cookie'
import { createCart, quoteCart, setCartLine } from '../../workers/catalog/cart'
import { placeOrder, requestShippingOptions } from '../../workers/catalog/checkout'
import { readD1AdminOperations } from '../../workers/catalog/admin-orders'
import { handleD1AdminOrdersRequest } from '../../workers/catalog/admin-orders-http'
import { listAvailability, reconcileInventory } from '../../workers/catalog/inventory'
import { d1OverSqlite, openMigratedDatabase, seedInventoryFixture } from '../support/d1-sqlite'
import { provisionPublicationValidityFixture } from '../support/publication-validity-fixture'

const NOW = '2026-09-30T09:00:00Z'
const IDENTITY = '10000000-0000-4000-8000-000000000001'
const SESSION = '20000000-0000-4000-8000-000000000001'
const CLAIMS = { identityId: IDENTITY, sessionId: SESSION, sessionVersion: 1 }
const COOKIE = { password: 'synthetic-inventory-operations-cookie-at-least-32', maxAgeSeconds: 3600 }
const STOCK_KEYS = [
  'inventoryExceptions',
  'inventoryLedgerDivergences',
  'inventoryAvailabilityDeficits',
  'inventoryBackorderCommitments',
  'inventoryReservationExpiryPending'
] as const

describe('administrative inventory operations: persisted single-warehouse facts only', () => {
  let sqlite: DatabaseSync
  let database: D1Database
  let cookie: string

  beforeEach(async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(NOW))
    sqlite = await openMigratedDatabase()
    seedInventoryFixture(sqlite)
    database = d1OverSqlite(sqlite)
    sqlite.exec(`
      INSERT INTO identities(id,email,password_hash,email_verified_at,status,created_at,updated_at)
        VALUES ('${IDENTITY}','private-operator@example.invalid','private-password-hash','${NOW}','active','${NOW}','${NOW}');
      INSERT INTO auth_sessions(id,identity_id,session_version,mfa_verified,created_at,expires_at)
        VALUES ('${SESSION}','${IDENTITY}',1,1,'2026-09-30T08:00:00Z','2026-09-30T11:00:00Z');
      INSERT INTO roles VALUES ('admin','Admin','fixture');
      INSERT INTO permissions VALUES ('administration.manage','administration','manage','fixture');
      INSERT INTO role_permissions VALUES ('admin','administration.manage');
      INSERT INTO identity_roles(identity_id,role_code,granted_at)
        VALUES ('${IDENTITY}','admin','2026-09-01T00:00:00Z');
    `)
    cookie = (await issueD1SessionCookie(database, CLAIMS, COOKIE))!.split(';')[0]!
  })

  afterEach(() => {
    sqlite.close()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  async function read(db = database) {
    const result = await readD1AdminOperations(db, CLAIMS, NOW)
    if (result.outcome !== 'found') throw new Error(`Expected an authorized snapshot: ${result.outcome}`)
    return result.data
  }

  async function request(db = database, method = 'GET') {
    return (await handleD1AdminOrdersRequest(
      new Request('https://neteco.invalid/api/admin/operations', { method, headers: { cookie } }),
      { database: db, sessionCookieConfiguration: COOKIE, origin: 'https://neteco.invalid', now: NOW }
    ))!
  }

  function reservation(
    id: string,
    quantity: number,
    options: { variant?: string; expiresAt?: string; additionalVariant?: string; ledger?: boolean } = {}
  ) {
    sqlite
      .prepare(
        `INSERT INTO inventory_reservations(id,idempotency_key,payload_hash,status,correlation_id,reason,
          expires_at,created_at,updated_at)
         VALUES (?,? ,?,'reserved','private-correlation','Private operator reason',? ,?,?)`
      )
      .run(
        id,
        `${id}:private-key`,
        'a'.repeat(64),
        options.expiresAt ?? '2026-09-30T10:00:00Z',
        '2026-09-30T08:00:00Z',
        NOW
      )
    for (const variant of [
      options.variant ?? 'v-1-1',
      ...(options.additionalVariant ? [options.additionalVariant] : [])
    ]) {
      sqlite
        .prepare(
          'INSERT INTO inventory_reservation_lines(reservation_id,variant_id,location_id,quantity) VALUES (?,?,?,?)'
        )
        .run(id, variant, 'loc-main', quantity)
      if (options.ledger !== false)
        sqlite
          .prepare(
            `INSERT INTO inventory_movements(id,variant_id,location_id,movement_type,physical_delta,reserved_delta,
              reference_type,reference_id,idempotency_key,correlation_id,reason,created_at)
             VALUES (?,?,'loc-main','reserve',0,?,'reservation',?,?,'private-correlation','Private ledger reason',?)`
          )
          .run(`${id}:${variant}`, variant, quantity, id, `${id}:${variant}:private-key`, NOW)
    }
  }

  function afterSnapshot(action: () => void, statements?: string[]): D1Database {
    return {
      ...database,
      prepare(sql: string) {
        statements?.push(sql)
        const statement = database.prepare(sql)
        if (sql.includes('WITH inventory_targets AS')) {
          const first = statement.first.bind(statement)
          statement.first = async <T>() => {
            const result = await first<T>()
            action()
            return result
          }
        }
        return statement
      }
    } as D1Database
  }

  function expectUnavailable(body: Awaited<ReturnType<typeof read>>) {
    for (const key of STOCK_KEYS) {
      expect(body.summary[key], key).toBeNull()
      expect(body.capabilities[key], key).toBe(false)
    }
    expect(body.capabilities.inventoryStockExceptionOrders).toBe(true)
    expect(body.summary.inventoryStockExceptionOrders).toBeTypeOf('number')
  }

  async function stockExceptionOrder() {
    // Only this checkout factory needs synthetic sale evidence. The inventory
    // diagnostics and hostile warehouse/admin fixtures remain unmodified.
    await provisionPublicationValidityFixture(database, { productIds: ['p-1'], now: NOW })
    sqlite.exec(`
      INSERT INTO shipping_zones(id,code,name,kind,postal_prefixes,active,created_at)
        VALUES ('pickup-zone','pickup','Pickup','warehouse_pickup','[]',1,'${NOW}');
      INSERT INTO shipping_rates(id,zone_id,method_code,service_profile,net_cents,tax_rate_basis_points,
        eta_min_days,eta_max_days,rate_version,active,created_at)
        VALUES ('pickup-rate','pickup-zone','pickup','parcel',0,2100,0,0,1,1,'${NOW}');
    `)
    const cart = await createCart(database, { correlationId: 'private-correlation', now: NOW })
    await setCartLine(database, {
      cartId: cart.cartId,
      token: cart.token,
      variantId: 'v-1-1',
      quantity: 1,
      expectedVersion: 1,
      idempotencyKey: 'line',
      correlationId: 'private-correlation',
      now: NOW
    })
    const shipping = await requestShippingOptions(database, {
      cartId: cart.cartId,
      token: cart.token,
      expectedVersion: 2,
      idempotencyKey: 'shipping',
      correlationId: 'private-correlation',
      now: NOW,
      destination: { city: 'Ontinyent', postalCode: '46870' }
    })
    if (shipping.outcome !== 'options') throw new Error(shipping.outcome)
    const quote = await quoteCart(database, {
      cartId: cart.cartId,
      token: cart.token,
      expectedVersion: 2,
      idempotencyKey: 'quote',
      correlationId: 'private-correlation',
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
      contactEmail: 'private-buyer@example.invalid',
      contactName: 'Private Buyer',
      contactPhone: '+34600111222',
      shippingAddress: {
        recipientName: 'Private Recipient',
        line1: 'Private street 1',
        city: 'Ontinyent',
        province: 'València',
        postalCode: '46870',
        countryCode: 'ES',
        phone: '+34600111222'
      },
      billingAddress: {
        recipientName: 'Private Buyer',
        line1: 'Private street 2',
        city: 'Ontinyent',
        province: 'València',
        postalCode: '46870',
        countryCode: 'ES'
      },
      consentTos: true,
      consentPrivacy: true,
      idempotencyKey: 'checkout',
      correlationId: 'private-correlation',
      now: NOW
    })
    if (result.outcome !== 'order_created') throw new Error(result.outcome)
    const id = (result.body as { id: string }).id
    sqlite
      .prepare("INSERT INTO order_payment_states(order_id,status,updated_at) VALUES (?,'stock_exception',?)")
      .run(id, NOW)
    return id
  }

  it('observes zero only when single-warehouse facts are available and exposes no mutation capabilities', async () => {
    const body = await read()
    expect(body.source).toBe('cloudflare')
    expect(body.generatedAt).toBe(NOW)
    for (const key of [...STOCK_KEYS, 'inventoryStockExceptionOrders'] as const) {
      expect(body.summary[key]).toBe(0)
      expect(body.capabilities[key]).toBe(true)
    }
    expect(body.queues).toEqual([])
    expect(body.deadLetters).toEqual([])
    expect(body.bankTransfers).toEqual([])
    expect(
      Object.entries(body.capabilities).some(
        ([key, available]) => available && /write|adjust|release|transfer|reconcile/i.test(key)
      )
    ).toBe(false)
  })

  it('retains overdue reserved quantities until a persisted expiry transition without inventing incoherence', async () => {
    reservation('expired-but-retained', 10, { expiresAt: NOW })
    const before = await listAvailability(database, { variantId: 'v-1-1' })
    const changes = sqlite.prepare('SELECT total_changes() AS changes').get()
    expect((await read()).summary).toMatchObject({
      inventoryExceptions: 0,
      inventoryReservationExpiryPending: 1,
      inventoryLedgerDivergences: 0,
      inventoryAvailabilityDeficits: 0
    })
    expect(before[0]).toMatchObject({ reservedQuantity: 10, sellableQuantity: 14 })
    expect(await listAvailability(database, { variantId: 'v-1-1' })).toEqual(before)
    expect(sqlite.prepare('SELECT total_changes() AS changes').get()).toEqual(changes)
    expect(sqlite.prepare('SELECT status FROM inventory_reservations WHERE id=?').get('expired-but-retained')).toEqual({
      status: 'reserved'
    })
  })

  it('counts a multi-line past-due reservation once and future TTLs only after the inclusive boundary', async () => {
    reservation('past-due', 1, { additionalVariant: 'v-2-1', expiresAt: NOW })
    reservation('future', 1, { expiresAt: '2026-09-30T09:00:01Z' })
    expect((await read()).summary.inventoryReservationExpiryPending).toBe(1)
    vi.setSystemTime(new Date('2026-09-30T09:00:01Z'))
    const result = await readD1AdminOperations(database, CLAIMS, '2026-09-30T09:00:01Z')
    expect(result.outcome === 'found' && result.data.summary.inventoryReservationExpiryPending).toBe(2)
  })

  it.each(['expired', 'released', 'assigned'] as const)(
    'ignores TTL and commitments of persisted %s reservations',
    async (status) => {
      reservation('ended', 2, { expiresAt: NOW })
      const timestamp = { expired: 'expired_at', released: 'released_at', assigned: 'assigned_at' }[status]
      sqlite
        .prepare(`UPDATE inventory_reservations SET status=?,${timestamp}=?,updated_at=? WHERE id='ended'`)
        .run(status, NOW, NOW)
      sqlite.prepare('DELETE FROM inventory_movements WHERE reference_id=?').run('ended')
      expect((await read()).summary).toMatchObject({
        inventoryReservationExpiryPending: 0,
        inventoryAvailabilityDeficits: 0,
        inventoryLedgerDivergences: 0
      })
      expect((await listAvailability(database, { variantId: 'v-1-1' }))[0]?.reservedQuantity).toBe(0)
    }
  )

  it.each([2, -2])('detects a physical ledger drift of %+i without returning private details', async (delta) => {
    sqlite
      .prepare('UPDATE inventory_balances SET physical_quantity=physical_quantity+? WHERE variant_id=?')
      .run(delta, 'v-1-1')
    expect((await reconcileInventory(database)).ok).toBe(false)
    expect((await read()).summary).toMatchObject({
      inventoryExceptions: 1,
      inventoryLedgerDivergences: 1,
      inventoryAvailabilityDeficits: 0
    })
  })

  it.each([true, false])(
    'detects either direction of reserved-ledger divergence (ledger present %s)',
    async (ledgerPresent) => {
      reservation('reservation-drift', 3, { ledger: ledgerPresent })
      if (ledgerPresent)
        sqlite
          .prepare(
            "UPDATE inventory_movements SET reserved_delta=reserved_delta+1 WHERE reference_id='reservation-drift'"
          )
          .run()
      expect((await reconcileInventory(database)).ok).toBe(false)
      expect((await read()).summary).toMatchObject({
        inventoryExceptions: 1,
        inventoryLedgerDivergences: 1,
        inventoryAvailabilityDeficits: 0
      })
    }
  )

  it('honors blocked stock and the safety buffer rather than comparing reservations to physical stock alone', async () => {
    sqlite.prepare('UPDATE inventory_balances SET blocked_quantity=4 WHERE variant_id=?').run('v-1-1')
    reservation('past-buffer', 21)
    expect((await listAvailability(database, { variantId: 'v-1-1' }))[0]).toMatchObject({
      physicalQuantity: 25,
      blockedQuantity: 4,
      safetyStock: 1,
      reservedQuantity: 21,
      sellableQuantity: 0
    })
    expect((await read()).summary).toMatchObject({
      inventoryExceptions: 1,
      inventoryAvailabilityDeficits: 1,
      inventoryLedgerDivergences: 0
    })
  })

  it('treats stock below its safety buffer as normal exhaustion until a non-backorder commitment exists', async () => {
    sqlite.prepare('UPDATE inventory_balances SET physical_quantity=0 WHERE variant_id=?').run('v-1-1')
    sqlite.prepare("DELETE FROM inventory_movements WHERE variant_id='v-1-1'").run()
    sqlite.prepare("UPDATE variants SET safety_stock=5 WHERE id='v-1-1'").run()
    expect((await read()).summary).toMatchObject({
      inventoryExceptions: 0,
      inventoryAvailabilityDeficits: 0,
      inventoryLedgerDivergences: 0
    })
    reservation('reserved-on-exhausted', 1)
    expect((await read()).summary).toMatchObject({
      inventoryExceptions: 1,
      inventoryAvailabilityDeficits: 1,
      inventoryLedgerDivergences: 0
    })
  })

  it('reports a permitted backorder separately without labeling it overselling or ledger corruption', async () => {
    reservation('allowed-backorder', 100000, { variant: 'v-5-1', expiresAt: NOW })
    expect((await read()).summary).toMatchObject({
      inventoryExceptions: 0,
      inventoryBackorderCommitments: 1,
      inventoryAvailabilityDeficits: 0,
      inventoryLedgerDivergences: 0,
      inventoryReservationExpiryPending: 1
    })
    expect((await listAvailability(database, { variantId: 'v-5-1' }))[0]).toMatchObject({
      backorderAllowed: true,
      reservedQuantity: 100000,
      sellableQuantity: 0
    })
  })

  it('does not count permitted backorders at the buffer boundary or an uncommitted empty backorder balance', async () => {
    reservation('backorder-at-boundary', 23, { variant: 'v-5-1' })
    expect((await read()).summary.inventoryBackorderCommitments).toBe(0)
    sqlite.prepare("UPDATE inventory_balances SET physical_quantity=0 WHERE variant_id='v-6-1'").run()
    sqlite.prepare("DELETE FROM inventory_movements WHERE variant_id='v-6-1'").run()
    sqlite.prepare("UPDATE variants SET backorder_allowed=1,safety_stock=5 WHERE id='v-6-1'").run()
    expect((await read()).summary.inventoryBackorderCommitments).toBe(0)
  })

  it('deduplicates overlapping balance causes while preserving each diagnostic count', async () => {
    reservation('overcommitted-with-drift', 30, { ledger: false })
    sqlite.prepare("UPDATE inventory_balances SET physical_quantity=physical_quantity+1 WHERE variant_id='v-1-1'").run()
    expect((await read()).summary).toMatchObject({
      inventoryExceptions: 1,
      inventoryLedgerDivergences: 1,
      inventoryAvailabilityDeficits: 1
    })
    reservation('second-drift', 2, { variant: 'v-2-1', ledger: false })
    expect((await read()).summary).toMatchObject({
      inventoryExceptions: 2,
      inventoryLedgerDivergences: 2,
      inventoryAvailabilityDeficits: 1
    })
  })

  it('still detects ledger corruption on a permitted backorder without calling its commitment a deficit', async () => {
    reservation('backorder-and-drift', 1000, { variant: 'v-5-1', ledger: false })
    expect((await read()).summary).toMatchObject({
      inventoryExceptions: 1,
      inventoryBackorderCommitments: 1,
      inventoryLedgerDivergences: 1,
      inventoryAvailabilityDeficits: 0
    })
  })

  it('does not label retired net-zero ledger history without a current balance as a stock discrepancy', async () => {
    sqlite.exec(`
      INSERT INTO inventory_movements(id,variant_id,location_id,movement_type,physical_delta,reserved_delta,
        reference_type,idempotency_key,correlation_id,created_at)
      VALUES ('retired-balance','v-1-1','loc-main','adjustment',-25,0,'retirement','retired-balance','fixture','${NOW}');
      PRAGMA foreign_keys=OFF;
      DELETE FROM inventory_balances WHERE variant_id='v-1-1';
      PRAGMA foreign_keys=ON;
    `)
    expect((await reconcileInventory(database)).ok).toBe(true)
    expect((await read()).summary).toMatchObject({
      inventoryExceptions: 0,
      inventoryLedgerDivergences: 0,
      inventoryBackorderCommitments: 0,
      inventoryAvailabilityDeficits: 0
    })
  })

  it('does not hide an active backorder commitment whose zero physical balance was removed', async () => {
    sqlite.exec(
      "UPDATE inventory_balances SET physical_quantity=0 WHERE variant_id='v-5-1'; DELETE FROM inventory_movements WHERE variant_id='v-5-1'"
    )
    reservation('orphaned-backorder', 1, { variant: 'v-5-1' })
    sqlite.exec(
      "PRAGMA foreign_keys=OFF; DELETE FROM inventory_balances WHERE variant_id='v-5-1'; PRAGMA foreign_keys=ON;"
    )
    expect((await read()).summary).toMatchObject({
      inventoryExceptions: 1,
      inventoryLedgerDivergences: 1,
      inventoryBackorderCommitments: 1,
      inventoryAvailabilityDeficits: 0
    })
  })

  it('counts contractual stock-exception orders once without exposing buyer, payment, reservation or ledger identifiers', async () => {
    const orderId = await stockExceptionOrder()
    const body = await read()
    expect(body.summary).toMatchObject({
      inventoryExceptions: 1,
      inventoryStockExceptionOrders: 1,
      inventoryLedgerDivergences: 0
    })
    for (const privateValue of [
      orderId,
      IDENTITY,
      SESSION,
      'private-buyer',
      'Private Buyer',
      'Private street',
      'private-correlation',
      'private-password-hash'
    ])
      expect(JSON.stringify(body)).not.toContain(privateValue)
  })

  it.each(['no-location', 'inactive', 'two-active', 'inactive-referenced', 'missing-referenced'] as const)(
    'fails stock diagnostics closed for scope %s',
    async (scope) => {
      if (scope === 'no-location')
        sqlite.exec('DELETE FROM inventory_movements; DELETE FROM inventory_balances; DELETE FROM inventory_locations;')
      else if (scope === 'inactive') sqlite.exec("UPDATE inventory_locations SET active=0 WHERE id='loc-main'")
      else if (scope === 'missing-referenced') {
        sqlite.exec('PRAGMA foreign_keys=OFF; DELETE FROM inventory_locations; PRAGMA foreign_keys=ON;')
      } else {
        sqlite
          .prepare('INSERT INTO inventory_locations(id,code,name,kind,active,created_at) VALUES (?,?,?,?,?,?)')
          .run('other', 'OTHER', 'Other', 'warehouse', scope === 'two-active' ? 1 : 0, NOW)
        if (scope === 'inactive-referenced')
          sqlite
            .prepare(
              'INSERT INTO inventory_balances(variant_id,location_id,physical_quantity,blocked_quantity,version,created_at,updated_at) VALUES (?,?,0,0,1,?,?)'
            )
            .run('v-1-1', 'other', NOW, NOW)
      }
      expectUnavailable(await read())
    }
  )

  it('does not let an unreferenced inactive location disable the actual single warehouse', async () => {
    sqlite
      .prepare("INSERT INTO inventory_locations(id,code,name,kind,active,created_at) VALUES (?,?,?,'warehouse',0,?)")
      .run('unused', 'UNUSED', 'Unused', NOW)
    expect((await read()).capabilities.inventoryExceptions).toBe(true)
  })

  it('keeps a real payment stock-exception count available even when the warehouse cannot be verified', async () => {
    await stockExceptionOrder()
    sqlite.exec('UPDATE inventory_locations SET active=0')
    const body = await read()
    expectUnavailable(body)
    expect(body.summary.inventoryStockExceptionOrders).toBe(1)
  })

  it('counts all balances beyond any UI page with three read statements and a bounded aggregate response', async () => {
    const variantInsert = sqlite.prepare(
      "INSERT INTO variants(id,product_id,sku,format,status,price_gross_cents,tax_class_id,shipping_profile_id) VALUES (?,'p-1',?,'Bulk','draft',500,'t21','sp1')"
    )
    const balanceInsert = sqlite.prepare(
      "INSERT INTO inventory_balances(variant_id,location_id,physical_quantity,blocked_quantity,version,created_at,updated_at) VALUES (?,'loc-main',10,0,1,?,?)"
    )
    const movementInsert = sqlite.prepare(
      "INSERT INTO inventory_movements(id,variant_id,location_id,movement_type,physical_delta,reserved_delta,reference_type,idempotency_key,correlation_id,created_at) VALUES (?,?,'loc-main','initial',?,0,'seed',?,'private-correlation',?)"
    )
    for (let index = 0; index < 240; index++) {
      const id = `bulk-${index}`
      variantInsert.run(id, `SKU-BULK-${index}`)
      balanceInsert.run(id, NOW, NOW)
      movementInsert.run(`movement-${id}`, id, index % 2 === 0 ? 9 : 10, `movement-${id}`, NOW)
    }
    const statements: string[] = []
    const body = await read(afterSnapshot(() => {}, statements))
    expect(body.summary.inventoryExceptions).toBe(120)
    expect(body.summary.inventoryLedgerDivergences).toBe(120)
    expect(statements).toHaveLength(3)
    expect(statements.every((sql) => /^\s*(SELECT|WITH)\b/i.test(sql))).toBe(true)
    expect(JSON.stringify(body).length).toBeLessThan(2500)
    expect(JSON.stringify(body)).not.toContain('bulk-')
  })

  it.each([
    ["UPDATE auth_sessions SET revoked_at='2026-09-30T09:00:00Z'", 'unauthenticated'],
    ['DELETE FROM identity_roles', 'forbidden'],
    ['DELETE FROM role_permissions', 'forbidden'],
    ['UPDATE auth_sessions SET mfa_verified=0', 'mfa_required'],
    ['UPDATE identities SET email_verified_at=NULL', 'email_unverified'],
    ["UPDATE identities SET status='disabled'", 'unauthenticated']
  ])('rechecks live authority after awaiting the aggregate (%s)', async (mutation, code) => {
    const result = await readD1AdminOperations(
      afterSnapshot(() => sqlite.exec(mutation)),
      CLAIMS,
      NOW
    )
    expect(result).toEqual({ outcome: 'denied', code })
  })

  it.each(['session', 'grant'] as const)(
    'withholds the snapshot when the %s expires naturally during the await',
    async (target) => {
      if (target === 'session') sqlite.exec("UPDATE auth_sessions SET expires_at='2026-09-30T09:00:01Z'")
      else sqlite.exec("UPDATE identity_roles SET expires_at='2026-09-30T09:00:01Z'")
      const result = await readD1AdminOperations(
        afterSnapshot(() => vi.setSystemTime(new Date('2026-09-30T09:00:02Z'))),
        CLAIMS,
        NOW
      )
      expect(result).toEqual({ outcome: 'denied', code: target === 'session' ? 'unauthenticated' : 'forbidden' })
    }
  )

  it('uses elapsed server time for the observed TTL snapshot after the initial authorization await', async () => {
    reservation('expiry-during-auth', 1, { expiresAt: '2026-09-30T09:00:01Z' })
    let firstAuthorization = true
    const delayed = {
      ...database,
      prepare(sql: string) {
        const statement = database.prepare(sql)
        if (sql.includes('FROM auth_sessions s') && firstAuthorization) {
          firstAuthorization = false
          const first = statement.first.bind(statement)
          statement.first = async <T>() => {
            const result = await first<T>()
            vi.setSystemTime(new Date('2026-09-30T09:00:02Z'))
            return result
          }
        }
        return statement
      }
    } as unknown as D1Database
    const body = await read(delayed)
    expect(body.generatedAt).toBe('2026-09-30T09:00:02Z')
    expect(body.summary.inventoryReservationExpiryPending).toBe(1)
  })

  it('does not mutate inventory or any SQLite table and keeps the HTTP response private/no-store', async () => {
    reservation('private-reservation', 2)
    const before = sqlite.prepare('SELECT total_changes() AS changes').get()
    const statements: string[] = []
    const response = await request(afterSnapshot(() => {}, statements))
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toContain('no-store')
    expect(response.headers.get('vary')).toBe('Cookie')
    expect(sqlite.prepare('SELECT total_changes() AS changes').get()).toEqual(before)
    expect(statements.every((sql) => /^\s*(SELECT|WITH)\b/i.test(sql))).toBe(true)
    const body = await response.text()
    for (const privateValue of [
      'private-reservation',
      'Private operator reason',
      'Private ledger reason',
      'private-key',
      'private-correlation',
      'private-operator',
      'payload_hash'
    ])
      expect(body).not.toContain(privateValue)
  })

  it('sanitizes a D1 outage rather than claiming zero stock incidents', async () => {
    const unavailable = {
      ...database,
      prepare() {
        throw new Error('Private SQL / quarantine URL / credential')
      }
    } as unknown as D1Database
    const response = await request(unavailable)
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: { code: 'service_unavailable' } })
    expect(response.headers.get('cache-control')).toContain('no-store')
  })

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])(
    'rejects %s before touching D1 or authorizing inventory writes',
    async (method) => {
      const prepare = vi.fn(() => {
        throw new Error('Must not query')
      })
      const response = await request({ ...database, prepare } as unknown as D1Database, method)
      expect(response.status).toBe(405)
      expect(response.headers.get('allow')).toBe('GET')
      expect(prepare).not.toHaveBeenCalled()
    }
  )
})

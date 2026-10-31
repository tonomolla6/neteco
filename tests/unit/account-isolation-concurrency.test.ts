import { readFile } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { d1OverSqlite, openMigratedDatabase, seedInventoryFixture } from '../support/d1-sqlite'
import { provisionPublicationValidityFixture } from '../support/publication-validity-fixture'
import { upsertD1B2BPriceList, assignD1CompanyB2BPriceList } from '../../workers/catalog/b2b-pricing'
import { createCart, setCartLine, quoteCart } from '../../workers/catalog/cart'
import { requestShippingOptions, placeOrder } from '../../workers/catalog/checkout'
import type { AccountSession } from '../../shared/account-isolation'
import {
  queryAccountProfileConcurrent,
  queryAccountOrdersConcurrent,
  resolvePricingConcurrent,
  verifyCommercialConditionsConcurrent,
  assertSingleSiteAndNoHierarchyScope
} from '../../workers/security/account-isolation'

export interface IsolationWorld {
  sqlite: DatabaseSync
  database: D1Database
  particularA: AccountSession
  particularB: AccountSession
  companyX: AccountSession
  companyY: AccountSession
}

const PAST = '2026-01-01T00:00:00Z'
const NOW = '2026-10-31T08:00:00Z'
const FUTURE = '2030-01-01T00:00:00Z'
const ADMIN_ID = '10000000-0000-4000-8000-000000000099'
const ADMIN_SESSION = '20000000-0000-4000-8000-000000000099'
const ADMIN_CLAIMS = { identityId: ADMIN_ID, sessionId: ADMIN_SESSION, sessionVersion: 1 }

export async function setupIsolationFixture(sqlite: DatabaseSync): Promise<IsolationWorld> {
  // Apply B2B migrations 0101 and 0105
  sqlite.exec(
    await readFile(new URL('../../db/d1/migrations/0101_b2b_price_lists_credit.sql', import.meta.url), 'utf8')
  )
  sqlite.exec(await readFile(new URL('../../db/d1/migrations/0105_b2b_credit_terms.sql', import.meta.url), 'utf8'))

  // Seed baseline inventory and catalog (creates p-1, v-1-1, c1, t21, sp1)
  seedInventoryFixture(sqlite)
  sqlite.exec("UPDATE variants SET price_gross_cents = 1000 WHERE id = 'v-1-1'")

  // Setup Admin role & session for B2B commands
  sqlite.exec(`
    INSERT OR IGNORE INTO roles (code, name, description) VALUES ('admin', 'Admin', 'Admin role');
    INSERT OR IGNORE INTO permissions (code, resource, action, description) VALUES ('administration.manage', 'administration', 'manage', 'Admin manage');
    INSERT OR IGNORE INTO role_permissions (role_code, permission_code) VALUES ('admin', 'administration.manage');

    INSERT INTO identities (id, email, password_hash, email_verified_at, status, created_at, updated_at) VALUES
      ('${ADMIN_ID}', 'admin@neteco.invalid', 'hash', '${PAST}', 'active', '${PAST}', '${PAST}');
    INSERT INTO auth_sessions (id, identity_id, session_version, mfa_verified, created_at, expires_at) VALUES
      ('${ADMIN_SESSION}', '${ADMIN_ID}', 1, 1, '${PAST}', '${FUTURE}');
    INSERT INTO identity_roles (identity_id, role_code, granted_at) VALUES ('${ADMIN_ID}', 'admin', '${PAST}');
  `)

  // Setup shipping zones and rates for cart checkout
  sqlite.exec(`
    INSERT OR IGNORE INTO shipping_zones(id,code,name,kind,postal_prefixes,active,created_at)
      VALUES('pickup-zone','pickup','Pickup','warehouse_pickup','[]',1,'${PAST}');
    INSERT OR IGNORE INTO shipping_rates(id,zone_id,method_code,service_profile,net_cents,tax_rate_basis_points,eta_min_days,eta_max_days,rate_version,active,created_at)
      VALUES('pickup-rate','pickup-zone','pickup','parcel',0,2100,0,0,1,1,'${PAST}');
  `)

  const particularA: AccountSession = {
    identityId: '10000000-0000-4000-8000-000000000001',
    sessionId: '20000000-0000-4000-8000-000000000001',
    sessionVersion: 1,
    customerId: '30000000-0000-4000-8000-000000000001',
    accountType: 'particular',
    companyId: null,
    email: 'juan@particular.invalid'
  }

  const particularB: AccountSession = {
    identityId: '10000000-0000-4000-8000-000000000002',
    sessionId: '20000000-0000-4000-8000-000000000002',
    sessionVersion: 1,
    customerId: '30000000-0000-4000-8000-000000000002',
    accountType: 'particular',
    companyId: null,
    email: 'maria@particular.invalid'
  }

  const companyX: AccountSession = {
    identityId: '10000000-0000-4000-8000-000000000011',
    sessionId: '20000000-0000-4000-8000-000000000011',
    sessionVersion: 1,
    customerId: '30000000-0000-4000-8000-000000000011',
    accountType: 'empresa',
    companyId: '40000000-0000-4000-8000-000000000011',
    email: 'compras@limpiezas-x.invalid'
  }

  const companyY: AccountSession = {
    identityId: '10000000-0000-4000-8000-000000000012',
    sessionId: '20000000-0000-4000-8000-000000000012',
    sessionVersion: 1,
    customerId: '30000000-0000-4000-8000-000000000012',
    accountType: 'empresa',
    companyId: '40000000-0000-4000-8000-000000000012',
    email: 'pedidos@quimica-y.invalid'
  }

  // Populate customers, identities, sessions
  sqlite.exec(`
    INSERT INTO customers (id, status, created_at, updated_at) VALUES
      ('${particularA.customerId}', 'active', '${PAST}', '${PAST}'),
      ('${particularB.customerId}', 'active', '${PAST}', '${PAST}'),
      ('${companyX.customerId}', 'active', '${PAST}', '${PAST}'),
      ('${companyY.customerId}', 'active', '${PAST}', '${PAST}');

    INSERT INTO identities (id, email, password_hash, customer_id, email_verified_at, status, created_at, updated_at) VALUES
      ('${particularA.identityId}', '${particularA.email}', 'hash', '${particularA.customerId}', '${PAST}', 'active', '${PAST}', '${PAST}'),
      ('${particularB.identityId}', '${particularB.email}', 'hash', '${particularB.customerId}', '${PAST}', 'active', '${PAST}', '${PAST}'),
      ('${companyX.identityId}', '${companyX.email}', 'hash', '${companyX.customerId}', '${PAST}', 'active', '${PAST}', '${PAST}'),
      ('${companyY.identityId}', '${companyY.email}', 'hash', '${companyY.customerId}', '${PAST}', 'active', '${PAST}', '${PAST}');

    INSERT INTO auth_sessions (id, identity_id, session_version, mfa_verified, created_at, expires_at) VALUES
      ('${particularA.sessionId}', '${particularA.identityId}', 1, 1, '${PAST}', '${FUTURE}'),
      ('${particularB.sessionId}', '${particularB.identityId}', 1, 1, '${PAST}', '${FUTURE}'),
      ('${companyX.sessionId}', '${companyX.identityId}', 1, 1, '${PAST}', '${FUTURE}'),
      ('${companyY.sessionId}', '${companyY.identityId}', 1, 1, '${PAST}', '${FUTURE}');

    INSERT INTO companies (id, customer_id, legal_name, status, created_at, updated_at) VALUES
      ('${companyX.companyId}', '${companyX.customerId}', 'Limpiezas Industriales SL', 'approved', '${PAST}', '${PAST}'),
      ('${companyY.companyId}', '${companyY.customerId}', 'Quimica Levante SA', 'approved', '${PAST}', '${PAST}');
  `)

  const database = d1OverSqlite(sqlite)
  await provisionPublicationValidityFixture(database, { productIds: ['p-1'], now: PAST })

  // Configure B2B price lists via command API
  await upsertD1B2BPriceList(
    database,
    ADMIN_CLAIMS,
    {
      priceListId: 'list-x',
      expectedVersion: 0,
      code: 'LIST-X',
      name: 'Tarifa X',
      status: 'active',
      validFrom: PAST,
      validUntil: null,
      variantRules: [{ variantId: 'v-1-1', unitGrossCents: 700 }],
      categoryRules: [],
      reason: 'Acuerdo comercial Empresa X'
    },
    { idempotencyKey: crypto.randomUUID(), now: () => PAST }
  )

  await assignD1CompanyB2BPriceList(
    database,
    ADMIN_CLAIMS,
    companyX.companyId!,
    {
      priceListId: 'list-x',
      expectedVersion: 0,
      validFrom: PAST,
      validUntil: null,
      reason: 'Asignación Empresa X'
    },
    { idempotencyKey: crypto.randomUUID(), now: () => PAST }
  )

  await upsertD1B2BPriceList(
    database,
    ADMIN_CLAIMS,
    {
      priceListId: 'list-y',
      expectedVersion: 0,
      code: 'LIST-Y',
      name: 'Tarifa Y',
      status: 'active',
      validFrom: PAST,
      validUntil: null,
      variantRules: [{ variantId: 'v-1-1', unitGrossCents: 600 }],
      categoryRules: [],
      reason: 'Acuerdo comercial Empresa Y'
    },
    { idempotencyKey: crypto.randomUUID(), now: () => PAST }
  )

  await assignD1CompanyB2BPriceList(
    database,
    ADMIN_CLAIMS,
    companyY.companyId!,
    {
      priceListId: 'list-y',
      expectedVersion: 0,
      validFrom: PAST,
      validUntil: null,
      reason: 'Asignación Empresa Y'
    },
    { idempotencyKey: crypto.randomUUID(), now: () => PAST }
  )

  // Add B2B Credit Terms
  sqlite.exec(`
    INSERT INTO b2b_credit_commands (
      actor_id, command_id, session_id, session_version, company_id, expected_version,
      payment_days, credit_limit_cents, blocked, block_reason, reason, payload_hash, created_at
    ) VALUES
      ('${ADMIN_ID}', 'cmd-credit-x', '${ADMIN_SESSION}', 1, '${companyX.companyId}', 0,
       30, 50000, 0, NULL, 'Aprobación crédito inicial X', '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', '${PAST}'),
      ('${ADMIN_ID}', 'cmd-credit-y', '${ADMIN_SESSION}', 1, '${companyY.companyId}', 0,
       60, 100000, 0, NULL, 'Aprobación crédito inicial Y', '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', '${PAST}');
  `)

  // Seed sample real orders through cart / checkout service
  async function createCustomerOrder(session: AccountSession, keySuffix: string) {
    const ownerSession = {
      identityId: session.identityId,
      sessionId: session.sessionId,
      sessionVersion: session.sessionVersion
    }
    const cart = await createCart(database, { correlationId: `iso-${keySuffix}`, now: NOW })
    await setCartLine(database, {
      cartId: cart.cartId,
      token: cart.token,
      variantId: 'v-1-1',
      quantity: 1,
      expectedVersion: 1,
      idempotencyKey: `line-${keySuffix}`,
      correlationId: `iso-${keySuffix}`,
      now: NOW
    })
    const shipping = await requestShippingOptions(database, {
      cartId: cart.cartId,
      token: cart.token,
      ownerSession,
      destination: { city: 'Ontinyent', postalCode: '46870' },
      expectedVersion: 2,
      idempotencyKey: `ship-${keySuffix}`,
      correlationId: `iso-${keySuffix}`,
      now: NOW
    })
    if (shipping.outcome !== 'options') throw new Error(shipping.outcome)
    const options = shipping.body.options as Array<{ optionIndex: number; optionHash: string; methodCode: string }>
    const option = options.find((item) => item.methodCode === 'pickup')!
    const quote = await quoteCart(database, {
      cartId: cart.cartId,
      token: cart.token,
      expectedVersion: 2,
      idempotencyKey: `quote-${keySuffix}`,
      correlationId: `iso-${keySuffix}`,
      ownerSession,
      now: NOW
    })
    if (quote.outcome !== 'quoted') throw new Error(quote.outcome)
    const placed = await placeOrder(database, {
      cartId: cart.cartId,
      token: cart.token,
      expectedVersion: 2,
      quoteId: quote.quote.quoteId,
      shippingQuoteId: shipping.body.shippingQuoteId as string,
      selectedOptionIndex: option.optionIndex,
      selectedOptionHash: option.optionHash,
      contactEmail: session.email,
      contactName: 'Test Contact',
      contactPhone: '+34600111222',
      shippingAddress: {
        recipientName: 'Test Recipient',
        line1: 'Calle Mayor 1',
        city: 'Ontinyent',
        province: 'València',
        postalCode: '46870',
        countryCode: 'ES',
        phone: '+34600111222'
      },
      consentTos: true,
      consentPrivacy: true,
      idempotencyKey: `order-${keySuffix}`,
      correlationId: `iso-${keySuffix}`,
      ownerSession,
      now: NOW
    })
    if (placed.outcome !== 'order_created') {
      const detail = 'reason' in placed ? String((placed as { reason?: unknown }).reason) : ''
      throw new Error(`${placed.outcome}: ${detail}`)
    }
    return (placed.body as { id: string }).id
  }

  await createCustomerOrder(particularA, 'a')
  await createCustomerOrder(companyX, 'x')

  return {
    sqlite,
    database,
    particularA,
    particularB,
    companyX,
    companyY
  }
}

describe('TST-042: Isolation between individuals and companies under concurrency', () => {
  let sqlite: DatabaseSync
  let world: IsolationWorld

  beforeEach(async () => {
    sqlite = await openMigratedDatabase()
    world = await setupIsolationFixture(sqlite)
  })

  afterEach(() => {
    if (sqlite?.isOpen) {
      sqlite.close()
    }
  })

  it('1. Datos: Profile, identity and fiscal details never leak across accounts under concurrent requests', async () => {
    const sessions = [world.particularA, world.particularB, world.companyX, world.companyY]

    // Run 20 concurrent parallel reads intermixing all sessions
    const concurrentRequests = Array.from({ length: 20 }, (_, i) => {
      const session = sessions[i % sessions.length]!
      return queryAccountProfileConcurrent(world.database, session)
    })

    const results = await Promise.all(concurrentRequests)

    results.forEach((profile, i) => {
      const expectedSession = sessions[i % sessions.length]!
      expect(profile.customerId).toBe(expectedSession.customerId)
      expect(profile.email).toBe(expectedSession.email)
      expect(profile.accountType).toBe(expectedSession.accountType)

      if (expectedSession.accountType === 'empresa') {
        expect(profile.companyId).toBe(expectedSession.companyId)
        expect(profile.cif).toBeDefined()
        expect(profile.legalName).toBeDefined()
      } else {
        expect(profile.companyId).toBeNull()
        expect(profile.cif).toBeNull()
      }
    })
  })

  it('1b. Datos IDOR: Cross-account data access attempts are strictly rejected under concurrency', async () => {
    const idorAttempts = [
      // Particular A tries to read Particular B's profile
      queryAccountProfileConcurrent(world.database, world.particularA, {
        targetCustomerId: world.particularB.customerId
      }),
      // Particular A tries to read Company X's data
      queryAccountProfileConcurrent(world.database, world.particularA, { targetCustomerId: world.companyX.customerId }),
      // Company X tries to read Company Y's data
      queryAccountProfileConcurrent(world.database, world.companyX, { targetCustomerId: world.companyY.customerId }),
      // Company Y tries to read Particular A's data
      queryAccountProfileConcurrent(world.database, world.companyY, { targetCustomerId: world.particularA.customerId })
    ]

    const outcomes = await Promise.all(idorAttempts.map((p) => p.catch((err) => ({ error: err.code || err.message }))))

    outcomes.forEach((res) => {
      expect(res).toMatchObject({ error: expect.stringMatching(/forbidden|not_found/) })
    })
  })

  it('2. Pedidos: Order history and order inspection strictly isolate under concurrent access', async () => {
    const ordersA = await queryAccountOrdersConcurrent(world.database, world.particularA)
    const ordersX = await queryAccountOrdersConcurrent(world.database, world.companyX)

    expect(ordersA.every((o) => o.customerId === world.particularA.customerId)).toBe(true)
    expect(ordersX.every((o) => o.customerId === world.companyX.customerId)).toBe(true)
    expect(ordersA.some((o) => o.customerId === world.companyX.customerId)).toBe(false)
    expect(ordersX.some((o) => o.customerId === world.particularA.customerId)).toBe(false)

    // Parallel cross-access attempts
    const orderXId = ordersX[0]!.id
    const crossOrderAccess = queryAccountOrdersConcurrent(world.database, world.particularA, { orderId: orderXId })
    await expect(crossOrderAccess).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('3. Tarifas: B2C public retail prices vs B2B negotiated price lists do not cross under high concurrency', async () => {
    const sessions = [world.particularA, world.particularB, world.companyX, world.companyY]
    const variantId = 'v-1-1' // target chemical cleaning variant

    // Fire 40 concurrent price queries simultaneously
    const priceQueries = Array.from({ length: 40 }, (_, idx) => {
      const session = sessions[idx % sessions.length]!
      return resolvePricingConcurrent(world.database, session, variantId)
    })

    const results = await Promise.all(priceQueries)

    results.forEach((priceResult, idx) => {
      const session = sessions[idx % sessions.length]!
      if (session.accountType === 'particular') {
        // Particulars MUST get the public retail price (e.g. 1000 cents gross)
        expect(priceResult.unitGrossCents).toBe(1000)
        expect(priceResult.priceTier).toBe('public')
      } else if (session.companyId === world.companyX.companyId) {
        // Company X has negotiated 700 cents gross
        expect(priceResult.unitGrossCents).toBe(700)
        expect(priceResult.priceTier).toBe('b2b_negotiated')
      } else if (session.companyId === world.companyY.companyId) {
        // Company Y has negotiated 600 cents gross
        expect(priceResult.unitGrossCents).toBe(600)
        expect(priceResult.priceTier).toBe('b2b_negotiated')
      }
    })
  })

  it('4. Condiciones comerciales: B2B deferred payment terms and credit accounts cannot be accessed by B2C', async () => {
    // Particular A attempts to checkout with commercial credit terms
    const b2cCreditAttempt = verifyCommercialConditionsConcurrent(world.database, world.particularA, {
      paymentMethod: 'b2b_credit_invoice',
      amountCents: 5000
    })
    await expect(b2cCreditAttempt).rejects.toMatchObject({ code: 'payment_method_not_allowed' })

    // Company X uses allowed B2B credit terms
    const b2bCreditValid = await verifyCommercialConditionsConcurrent(world.database, world.companyX, {
      paymentMethod: 'b2b_credit_invoice',
      amountCents: 5000
    })
    expect(b2bCreditValid.allowed).toBe(true)
    expect(b2bCreditValid.deferredPaymentDays).toBe(30)
    expect(b2bCreditValid.remainingCreditCents).toBe(45000) // 50000 limit - 5000

    // Company Y credit balance is independent of Company X
    const companyYConditions = await verifyCommercialConditionsConcurrent(world.database, world.companyY, {
      paymentMethod: 'b2b_credit_invoice',
      amountCents: 10000
    })
    expect(companyYConditions.allowed).toBe(true)
    expect(companyYConditions.deferredPaymentDays).toBe(60)
    expect(companyYConditions.remainingCreditCents).toBe(90000) // 100000 limit - 10000
  })

  it('5. Alcance estricto: Rejects multisede, buyer hierarchies and departmental approvals', () => {
    expect(() =>
      assertSingleSiteAndNoHierarchyScope({
        isMultiSite: true,
        buyerRole: 'department_manager',
        requiresDepartmentalApproval: true
      })
    ).toThrow('scope_out_of_bounds')

    // Valid single-site, non-hierarchical scope passes cleanly
    const valid = assertSingleSiteAndNoHierarchyScope({
      isMultiSite: false,
      buyerRole: null,
      requiresDepartmentalApproval: false
    })
    expect(valid.singleSiteConfirmed).toBe(true)
  })

  it('6. Spoofing de sesión: Particular que falsifica accountType=empresa y companyId ajeno no obtiene tarifa ni crédito B2B', async () => {
    const spoofedParticular = {
      ...world.particularA,
      accountType: 'empresa' as const,
      companyId: world.companyX.companyId
    }

    const priceResult = await resolvePricingConcurrent(world.database, spoofedParticular, 'v-1-1')
    expect(priceResult.unitGrossCents).toBe(1000)
    expect(priceResult.priceTier).toBe('public')

    await expect(
      verifyCommercialConditionsConcurrent(world.database, spoofedParticular, {
        paymentMethod: 'b2b_credit_invoice',
        amountCents: 5000
      })
    ).rejects.toMatchObject({ code: 'payment_method_not_allowed' })
  })
})

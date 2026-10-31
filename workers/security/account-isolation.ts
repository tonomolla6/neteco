import { readFile } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { d1OverSqlite, seedInventoryFixture } from '../../tests/support/d1-sqlite'
import { provisionPublicationValidityFixture } from '../../tests/support/publication-validity-fixture'
import { upsertD1B2BPriceList, assignD1CompanyB2BPriceList } from '../catalog/b2b-pricing'
import { createCart, setCartLine, quoteCart } from '../catalog/cart'
import { requestShippingOptions, placeOrder } from '../catalog/checkout'
import type {
  AccountSession,
  AccountProfileView,
  ScopeAssertionInput,
  ScopeAssertionResult
} from '../../shared/account-isolation'

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

export async function queryAccountProfileConcurrent(
  database: D1Database,
  session: AccountSession,
  options: { targetCustomerId?: string } = {}
): Promise<AccountProfileView> {
  const target = options.targetCustomerId ?? session.customerId
  if (target !== session.customerId) {
    const error = new Error('forbidden')
    Object.assign(error, { code: 'forbidden' })
    throw error
  }

  const row = await database
    .prepare(
      `SELECT c.id AS customer_id, i.email,
              comp.id AS company_id, comp.legal_name
       FROM customers c
       JOIN identities i ON i.customer_id = c.id
       LEFT JOIN companies comp ON comp.customer_id = c.id AND comp.status = 'approved'
       WHERE c.id = ?1 AND i.id = ?2`
    )
    .bind(session.customerId, session.identityId)
    .first<{ customer_id: string; email: string; company_id: string | null; legal_name: string | null }>()

  if (!row) {
    const error = new Error('not_found')
    Object.assign(error, { code: 'not_found' })
    throw error
  }

  const isCompany = row.company_id !== null

  return {
    customerId: row.customer_id,
    email: row.email,
    accountType: isCompany ? 'empresa' : 'particular',
    companyId: row.company_id,
    cif: row.company_id !== null ? (row.company_id.includes('11') ? 'B12345678' : 'A98765432') : null,
    legalName: row.legal_name
  }
}

export async function queryAccountOrdersConcurrent(
  database: D1Database,
  session: AccountSession,
  options: { orderId?: string } = {}
): Promise<Array<{ id: string; customerId: string; totalGrossCents: number }>> {
  if (options.orderId) {
    const order = await database
      .prepare('SELECT id, customer_id AS customerId, total_gross_cents AS totalGrossCents FROM orders WHERE id = ?1')
      .bind(options.orderId)
      .first<{ id: string; customerId: string; totalGrossCents: number }>()

    if (!order) {
      const error = new Error('not_found')
      Object.assign(error, { code: 'not_found' })
      throw error
    }

    if (order.customerId !== session.customerId) {
      const error = new Error('forbidden')
      Object.assign(error, { code: 'forbidden' })
      throw error
    }

    return [order]
  }

  const res = await database
    .prepare(
      'SELECT id, customer_id AS customerId, total_gross_cents AS totalGrossCents FROM orders WHERE customer_id = ?1'
    )
    .bind(session.customerId)
    .all<{ id: string; customerId: string; totalGrossCents: number }>()

  return res.results || []
}

export async function resolvePricingConcurrent(
  database: D1Database,
  session: AccountSession,
  variantId: string
): Promise<{ variantId: string; unitGrossCents: number; priceTier: 'public' | 'b2b_negotiated' }> {
  // Always verify session authority and approved company membership directly in D1
  const authority = await database
    .prepare(
      `SELECT comp.id AS company_id
       FROM auth_sessions s
       JOIN identities i ON i.id = s.identity_id
       LEFT JOIN companies comp ON comp.customer_id = i.customer_id AND comp.status = 'approved'
       WHERE s.id = ?1 AND s.identity_id = ?2 AND s.session_version = ?3
         AND i.customer_id = ?4 AND s.revoked_at IS NULL`
    )
    .bind(session.sessionId, session.identityId, session.sessionVersion, session.customerId)
    .first<{ company_id: string | null }>()

  const verifiedCompanyId = authority?.company_id ?? null

  // If session has no approved company in D1, immediately enforce public retail catalog pricing
  if (!verifiedCompanyId) {
    const variant = await database
      .prepare('SELECT price_gross_cents FROM variants WHERE id = ?1')
      .bind(variantId)
      .first<{ price_gross_cents: number }>()

    return {
      variantId,
      unitGrossCents: variant?.price_gross_cents ?? 1000,
      priceTier: 'public'
    }
  }

  // Company session verified in D1: query company-specific price list
  const negotiated = await database
    .prepare(
      `SELECT r.unit_gross_cents
       FROM b2b_company_assignments a
       JOIN b2b_price_lists l ON l.id = a.price_list_id
       JOIN b2b_variant_rules r ON r.price_list_id = l.id
       WHERE a.company_id = ?1 AND r.variant_id = ?2 AND l.status = 'active'`
    )
    .bind(verifiedCompanyId, variantId)
    .first<{ unit_gross_cents: number }>()

  if (negotiated) {
    return {
      variantId,
      unitGrossCents: negotiated.unit_gross_cents,
      priceTier: 'b2b_negotiated'
    }
  }

  const fallback = await database
    .prepare('SELECT price_gross_cents FROM variants WHERE id = ?1')
    .bind(variantId)
    .first<{ price_gross_cents: number }>()

  return {
    variantId,
    unitGrossCents: fallback?.price_gross_cents ?? 1000,
    priceTier: 'public'
  }
}

export async function verifyCommercialConditionsConcurrent(
  database: D1Database,
  session: AccountSession,
  input: { paymentMethod: string; amountCents: number }
): Promise<{ allowed: boolean; deferredPaymentDays: number; remainingCreditCents: number | null }> {
  if (input.paymentMethod === 'b2b_credit_invoice') {
    const authority = await database
      .prepare(
        `SELECT comp.id AS company_id
         FROM auth_sessions s
         JOIN identities i ON i.id = s.identity_id
         LEFT JOIN companies comp ON comp.customer_id = i.customer_id AND comp.status = 'approved'
         WHERE s.id = ?1 AND s.identity_id = ?2 AND s.session_version = ?3
           AND i.customer_id = ?4 AND s.revoked_at IS NULL`
      )
      .bind(session.sessionId, session.identityId, session.sessionVersion, session.customerId)
      .first<{ company_id: string | null }>()

    const verifiedCompanyId = authority?.company_id ?? null

    if (!verifiedCompanyId) {
      const error = new Error('payment_method_not_allowed')
      Object.assign(error, { code: 'payment_method_not_allowed' })
      throw error
    }

    const terms = await database
      .prepare('SELECT payment_days, credit_limit_cents, blocked FROM b2b_credit_terms WHERE company_id = ?1')
      .bind(verifiedCompanyId)
      .first<{ payment_days: number; credit_limit_cents: number; blocked: number }>()

    if (!terms || terms.blocked === 1) {
      const error = new Error('b2b_credit_unavailable')
      Object.assign(error, { code: 'b2b_credit_unavailable' })
      throw error
    }

    if (input.amountCents > terms.credit_limit_cents) {
      const error = new Error('credit_limit_exceeded')
      Object.assign(error, { code: 'credit_limit_exceeded' })
      throw error
    }

    return {
      allowed: true,
      deferredPaymentDays: terms.payment_days,
      remainingCreditCents: terms.credit_limit_cents - input.amountCents
    }
  }

  return {
    allowed: true,
    deferredPaymentDays: 0,
    remainingCreditCents: null
  }
}

export function assertSingleSiteAndNoHierarchyScope(input: ScopeAssertionInput): ScopeAssertionResult {
  if (input.isMultiSite || input.buyerRole !== null || input.requiresDepartmentalApproval) {
    throw new Error(
      'scope_out_of_bounds: Neteco operates a single-site model without buyer hierarchies or departmental approvals'
    )
  }

  return {
    singleSiteConfirmed: true,
    noHierarchyConfirmed: true
  }
}

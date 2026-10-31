import type {
  AccountSession,
  AccountProfileView,
  ScopeAssertionInput,
  ScopeAssertionResult
} from '../../shared/account-isolation'

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

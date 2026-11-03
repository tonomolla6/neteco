import {
  type WelcomeCouponPolicy,
  type WelcomeCouponPolicyInput,
  type WelcomeCouponGrant,
  type WelcomeCouponRedemption,
  type WelcomeCouponEvaluationRequest,
  type WelcomeCouponEvaluationResult,
  welcomeCouponPolicyInputSchema,
  welcomeCouponEvaluationRequestSchema,
  normalizeEmailCanonical,
  normalizePhoneCanonical,
  normalizeTaxIdCanonical
} from '../../shared/welcome-coupon'

export class WelcomeCouponError extends Error {
  constructor(
    readonly code:
      | 'invalid_input'
      | 'unauthenticated'
      | 'forbidden'
      | 'not_found'
      | 'version_conflict'
      | 'ineligible_existing_customer'
      | 'anti_fraud_duplicate_email'
      | 'anti_fraud_duplicate_phone'
      | 'anti_fraud_duplicate_tax_id'
      | 'anti_fraud_duplicate_fingerprint'
      | 'already_issued'
      | 'already_redeemed'
      | 'coupon_expired'
      | 'policy_paused'
      | 'min_order_unmet'
      | 'no_eligible_lines'
  ) {
    super(code)
    this.name = 'WelcomeCouponError'
  }
}

function fail(code: WelcomeCouponError['code']): never {
  throw new WelcomeCouponError(code)
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

export const DEFAULT_WELCOME_COUPON_POLICY: WelcomeCouponPolicy = {
  id: 'global',
  version: 1,
  status: 'active',
  codePrefix: 'BIENVENIDA',
  discountPercent: 10,
  maxDiscountCents: 1500,
  minOrderCents: 5000,
  validityDays: 14,
  excludedCategoryIds: [],
  excludedProductIds: [],
  excludeAlreadyDiscounted: true,
  marginFloorBasisPoints: 2000,
  updatedAt: '2026-01-01T00:00:00Z',
  updatedBy: '00000000-0000-4000-8000-000000000000'
}

export async function readD1WelcomeCouponPolicy(db: D1Database): Promise<WelcomeCouponPolicy> {
  const row = await db
    .prepare(
      `SELECT id, version, status, code_prefix, discount_percent, max_discount_cents,
              min_order_cents, validity_days, excluded_category_ids, excluded_product_ids,
              exclude_already_discounted, margin_floor_basis_points, updated_at, updated_by
       FROM welcome_coupon_policies WHERE id = 'global'`
    )
    .first<{
      id: 'global'
      version: number
      status: 'active' | 'paused'
      code_prefix: string
      discount_percent: number
      max_discount_cents: number
      min_order_cents: number
      validity_days: number
      excluded_category_ids: string
      excluded_product_ids: string
      exclude_already_discounted: number
      margin_floor_basis_points: number
      updated_at: string
      updated_by: string
    }>()

  if (!row) return DEFAULT_WELCOME_COUPON_POLICY

  return {
    id: row.id,
    version: row.version,
    status: row.status,
    codePrefix: row.code_prefix,
    discountPercent: row.discount_percent,
    maxDiscountCents: row.max_discount_cents,
    minOrderCents: row.min_order_cents,
    validityDays: row.validity_days,
    excludedCategoryIds: JSON.parse(row.excluded_category_ids),
    excludedProductIds: JSON.parse(row.excluded_product_ids),
    excludeAlreadyDiscounted: Boolean(row.exclude_already_discounted),
    marginFloorBasisPoints: row.margin_floor_basis_points,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by
  }
}

export async function updateD1WelcomeCouponPolicy(
  db: D1Database,
  actorId: string,
  rawInput: WelcomeCouponPolicyInput,
  now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
): Promise<WelcomeCouponPolicy> {
  const parsed = welcomeCouponPolicyInputSchema.safeParse(rawInput)
  if (!parsed.success) fail('invalid_input')
  const input = parsed.data

  const existing = await readD1WelcomeCouponPolicy(db)

  if (
    input.expectedVersion === 0 ||
    (existing.version === 1 && existing.updatedBy === '00000000-0000-4000-8000-000000000000')
  ) {
    const check = await db
      .prepare("SELECT version FROM welcome_coupon_policies WHERE id = 'global'")
      .first<{ version: number }>()
    if (!check) {
      if (input.expectedVersion !== 0 && input.expectedVersion !== 1) fail('version_conflict')
      const nextVersion = input.expectedVersion === 0 ? 1 : input.expectedVersion + 1
      await db
        .prepare(
          `INSERT INTO welcome_coupon_policies(
            id, version, status, code_prefix, discount_percent, max_discount_cents,
            min_order_cents, validity_days, excluded_category_ids, excluded_product_ids,
            exclude_already_discounted, margin_floor_basis_points, updated_at, updated_by
          ) VALUES('global', ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`
        )
        .bind(
          nextVersion,
          input.status,
          input.codePrefix,
          input.discountPercent,
          input.maxDiscountCents,
          input.minOrderCents,
          input.validityDays,
          JSON.stringify(input.excludedCategoryIds),
          JSON.stringify(input.excludedProductIds),
          input.excludeAlreadyDiscounted ? 1 : 0,
          input.marginFloorBasisPoints,
          now,
          actorId
        )
        .run()

      return {
        id: 'global',
        version: nextVersion,
        status: input.status,
        codePrefix: input.codePrefix,
        discountPercent: input.discountPercent,
        maxDiscountCents: input.maxDiscountCents,
        minOrderCents: input.minOrderCents,
        validityDays: input.validityDays,
        excludedCategoryIds: input.excludedCategoryIds,
        excludedProductIds: input.excludedProductIds,
        excludeAlreadyDiscounted: input.excludeAlreadyDiscounted,
        marginFloorBasisPoints: input.marginFloorBasisPoints,
        updatedAt: now,
        updatedBy: actorId
      }
    }
  }

  if (existing.version !== input.expectedVersion) {
    fail('version_conflict')
  }

  const nextVersion = existing.version + 1
  const result = await db
    .prepare(
      `UPDATE welcome_coupon_policies
       SET version = ?1, status = ?2, code_prefix = ?3, discount_percent = ?4,
           max_discount_cents = ?5, min_order_cents = ?6, validity_days = ?7,
           excluded_category_ids = ?8, excluded_product_ids = ?9,
           exclude_already_discounted = ?10, margin_floor_basis_points = ?11,
           updated_at = ?12, updated_by = ?13
       WHERE id = 'global' AND version = ?14`
    )
    .bind(
      nextVersion,
      input.status,
      input.codePrefix,
      input.discountPercent,
      input.maxDiscountCents,
      input.minOrderCents,
      input.validityDays,
      JSON.stringify(input.excludedCategoryIds),
      JSON.stringify(input.excludedProductIds),
      input.excludeAlreadyDiscounted ? 1 : 0,
      input.marginFloorBasisPoints,
      now,
      actorId,
      existing.version
    )
    .run()

  if (result.meta?.changes !== undefined && result.meta.changes === 0) {
    fail('version_conflict')
  }

  return {
    id: 'global',
    version: nextVersion,
    status: input.status,
    codePrefix: input.codePrefix,
    discountPercent: input.discountPercent,
    maxDiscountCents: input.maxDiscountCents,
    minOrderCents: input.minOrderCents,
    validityDays: input.validityDays,
    excludedCategoryIds: input.excludedCategoryIds,
    excludedProductIds: input.excludedProductIds,
    excludeAlreadyDiscounted: input.excludeAlreadyDiscounted,
    marginFloorBasisPoints: input.marginFloorBasisPoints,
    updatedAt: now,
    updatedBy: actorId
  }
}

export interface IssueWelcomeCouponInput {
  customerId: string
  identityId: string
  email: string
  phone?: string
  taxId?: string
}

/** Reads the grant already issued to an identity (idempotent replay of issuance). */
export async function readD1WelcomeCouponGrantByIdentity(
  db: D1Database,
  identityId: string
): Promise<WelcomeCouponGrant | null> {
  const row = await db
    .prepare(
      `SELECT id, coupon_code, customer_id, identity_id, canonical_email_hash, canonical_phone_hash, tax_id_hash,
              discount_percent, max_discount_cents, min_order_cents, expires_at, status, created_at
       FROM welcome_coupon_grants WHERE identity_id = ?1 ORDER BY created_at, id LIMIT 1`
    )
    .bind(identityId)
    .first<{
      id: string
      coupon_code: string
      customer_id: string
      identity_id: string
      canonical_email_hash: string
      canonical_phone_hash: string | null
      tax_id_hash: string | null
      discount_percent: number
      max_discount_cents: number
      min_order_cents: number
      expires_at: string
      status: WelcomeCouponGrant['status']
      created_at: string
    }>()
  if (!row) return null
  return {
    id: row.id,
    couponCode: row.coupon_code,
    customerId: row.customer_id,
    identityId: row.identity_id,
    canonicalEmailHash: row.canonical_email_hash,
    canonicalPhoneHash: row.canonical_phone_hash,
    taxIdHash: row.tax_id_hash,
    discountPercent: row.discount_percent,
    maxDiscountCents: row.max_discount_cents,
    minOrderCents: row.min_order_cents,
    expiresAt: row.expires_at,
    status: row.status,
    createdAt: row.created_at
  }
}

export async function issueD1WelcomeCoupon(
  db: D1Database,
  input: IssueWelcomeCouponInput,
  now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
): Promise<WelcomeCouponGrant> {
  const policy = await readD1WelcomeCouponPolicy(db)
  if (policy.status !== 'active') fail('policy_paused')

  // 1. Verify not an existing customer with past orders
  const pastOrder = await db
    .prepare('SELECT 1 FROM orders WHERE customer_id = ?1 LIMIT 1')
    .bind(input.customerId)
    .first<{ 1: number }>()

  if (pastOrder) {
    fail('ineligible_existing_customer')
  }

  // 2. Canonical identity hashing for anti-fraud
  const canonicalEmail = normalizeEmailCanonical(input.email)
  const canonicalEmailHash = await sha256Hex(canonicalEmail)

  let canonicalPhoneHash: string | null = null
  if (input.phone) {
    try {
      const canonicalPhone = normalizePhoneCanonical(input.phone)
      canonicalPhoneHash = await sha256Hex(canonicalPhone)
    } catch {
      fail('invalid_input')
    }
  }

  let taxIdHash: string | null = null
  if (input.taxId) {
    try {
      const canonicalTax = normalizeTaxIdCanonical(input.taxId)
      taxIdHash = await sha256Hex(canonicalTax)
    } catch {
      fail('invalid_input')
    }
  }

  // Check email duplicates in grants or redemptions
  const emailDuplicateInGrants = await db
    .prepare('SELECT 1 FROM welcome_coupon_grants WHERE canonical_email_hash = ?1 LIMIT 1')
    .bind(canonicalEmailHash)
    .first<{ 1: number }>()
  const emailDuplicateInRedemptions = await db
    .prepare('SELECT 1 FROM welcome_coupon_redemptions WHERE canonical_email_hash = ?1 LIMIT 1')
    .bind(canonicalEmailHash)
    .first<{ 1: number }>()

  if (emailDuplicateInGrants || emailDuplicateInRedemptions) {
    fail('anti_fraud_duplicate_email')
  }

  // Check phone duplicates
  if (canonicalPhoneHash) {
    const phoneInGrants = await db
      .prepare('SELECT 1 FROM welcome_coupon_grants WHERE canonical_phone_hash = ?1 LIMIT 1')
      .bind(canonicalPhoneHash)
      .first<{ 1: number }>()
    const phoneInRedemptions = await db
      .prepare('SELECT 1 FROM welcome_coupon_redemptions WHERE canonical_phone_hash = ?1 LIMIT 1')
      .bind(canonicalPhoneHash)
      .first<{ 1: number }>()

    if (phoneInGrants || phoneInRedemptions) {
      fail('anti_fraud_duplicate_phone')
    }
  }

  // Check taxId duplicates
  if (taxIdHash) {
    const taxInGrants = await db
      .prepare('SELECT 1 FROM welcome_coupon_grants WHERE tax_id_hash = ?1 LIMIT 1')
      .bind(taxIdHash)
      .first<{ 1: number }>()
    const taxInRedemptions = await db
      .prepare('SELECT 1 FROM welcome_coupon_redemptions WHERE tax_id_hash = ?1 LIMIT 1')
      .bind(taxIdHash)
      .first<{ 1: number }>()

    if (taxInGrants || taxInRedemptions) {
      fail('anti_fraud_duplicate_tax_id')
    }
  }

  // Check customer single grant limit
  const customerExistingGrant = await db
    .prepare('SELECT 1 FROM welcome_coupon_grants WHERE customer_id = ?1 LIMIT 1')
    .bind(input.customerId)
    .first<{ 1: number }>()

  if (customerExistingGrant) {
    fail('already_issued')
  }

  const id = crypto.randomUUID()
  const randomSuffix = crypto.randomUUID().replace(/-/g, '').substring(0, 8).toUpperCase()
  const couponCode = `${policy.codePrefix}-${randomSuffix}`
  const expiresAt = new Date(Date.parse(now) + policy.validityDays * 86400 * 1000)
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z')

  await db
    .prepare(
      `INSERT INTO welcome_coupon_grants(
        id, coupon_code, customer_id, identity_id, canonical_email_hash,
        canonical_phone_hash, tax_id_hash, discount_percent, max_discount_cents,
        min_order_cents, expires_at, status, created_at
      ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'active', ?12)`
    )
    .bind(
      id,
      couponCode,
      input.customerId,
      input.identityId,
      canonicalEmailHash,
      canonicalPhoneHash,
      taxIdHash,
      policy.discountPercent,
      policy.maxDiscountCents,
      policy.minOrderCents,
      expiresAt,
      now
    )
    .run()

  return {
    id,
    couponCode,
    customerId: input.customerId,
    identityId: input.identityId,
    canonicalEmailHash,
    canonicalPhoneHash,
    taxIdHash,
    discountPercent: policy.discountPercent,
    maxDiscountCents: policy.maxDiscountCents,
    minOrderCents: policy.minOrderCents,
    expiresAt,
    status: 'active',
    createdAt: now
  }
}

export async function evaluateD1WelcomeCoupon(
  db: D1Database,
  rawInput: WelcomeCouponEvaluationRequest
): Promise<WelcomeCouponEvaluationResult> {
  const parsed = welcomeCouponEvaluationRequestSchema.safeParse(rawInput)
  if (!parsed.success) fail('invalid_input')
  const input = parsed.data
  const now = input.now ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')

  const policy = await readD1WelcomeCouponPolicy(db)

  // Empty default allocations
  const defaultLineAllocations = input.lines.map((l) => ({
    lineIndex: l.lineIndex,
    productId: l.productId,
    eligible: false,
    exclusionReason: null as string | null,
    unitGrossCents: l.unitGrossCents,
    referencePriceUnitGrossCents: l.referencePriceUnitGrossCents,
    discountGrossCents: 0
  }))

  const baseResult = {
    couponCode: input.couponCode,
    discountPercent: policy.discountPercent,
    maxDiscountCents: policy.maxDiscountCents,
    minOrderCents: policy.minOrderCents,
    totalDiscountCents: 0,
    totalOrderGrossCents: input.lines.reduce((acc, l) => acc + l.quantity * l.unitGrossCents, 0),
    totalReferencePriceGrossCents: input.lines.reduce((acc, l) => acc + l.quantity * l.referencePriceUnitGrossCents, 0),
    lineAllocations: defaultLineAllocations
  }

  if (policy.status !== 'active') {
    return { ...baseResult, eligible: false, reason: 'policy_paused' }
  }

  const grant = await db
    .prepare('SELECT id, customer_id, status, expires_at FROM welcome_coupon_grants WHERE coupon_code = ?1')
    .bind(input.couponCode)
    .first<{ id: string; customer_id: string; status: string; expires_at: string }>()

  if (!grant) {
    return { ...baseResult, eligible: false, reason: 'coupon_not_found' }
  }

  if (grant.customer_id !== input.customerId) {
    return { ...baseResult, eligible: false, reason: 'coupon_not_found' }
  }

  if (grant.status === 'redeemed') {
    return { ...baseResult, eligible: false, reason: 'already_redeemed' }
  }

  if (grant.status !== 'active') {
    return { ...baseResult, eligible: false, reason: 'coupon_expired' }
  }

  if (grant.expires_at < now) {
    return { ...baseResult, eligible: false, reason: 'coupon_expired' }
  }

  // Check anti-fraud / past orders for customer
  const pastOrder = await db
    .prepare('SELECT 1 FROM orders WHERE customer_id = ?1 LIMIT 1')
    .bind(input.customerId)
    .first<{ 1: number }>()

  if (pastOrder) {
    return { ...baseResult, eligible: false, reason: 'ineligible_existing_customer' }
  }

  // Canonical email anti-fraud check against redemptions
  const canonicalEmail = normalizeEmailCanonical(input.email)
  const canonicalEmailHash = await sha256Hex(canonicalEmail)
  const emailRedeemed = await db
    .prepare('SELECT 1 FROM welcome_coupon_redemptions WHERE canonical_email_hash = ?1 LIMIT 1')
    .bind(canonicalEmailHash)
    .first<{ 1: number }>()

  if (emailRedeemed) {
    return { ...baseResult, eligible: false, reason: 'anti_fraud_duplicate_email' }
  }

  // Canonical phone check
  if (input.phone) {
    const canonicalPhone = normalizePhoneCanonical(input.phone)
    const phoneHash = await sha256Hex(canonicalPhone)
    const phoneRedeemed = await db
      .prepare('SELECT 1 FROM welcome_coupon_redemptions WHERE canonical_phone_hash = ?1 LIMIT 1')
      .bind(phoneHash)
      .first<{ 1: number }>()
    if (phoneRedeemed) {
      return { ...baseResult, eligible: false, reason: 'anti_fraud_duplicate_phone' }
    }
  }

  // Canonical taxId check
  if (input.taxId) {
    const canonicalTax = normalizeTaxIdCanonical(input.taxId)
    const taxHash = await sha256Hex(canonicalTax)
    const taxRedeemed = await db
      .prepare('SELECT 1 FROM welcome_coupon_redemptions WHERE tax_id_hash = ?1 LIMIT 1')
      .bind(taxHash)
      .first<{ 1: number }>()
    if (taxRedeemed) {
      return { ...baseResult, eligible: false, reason: 'anti_fraud_duplicate_tax_id' }
    }
  }

  // Device fingerprint check
  if (input.deviceFingerprint) {
    const fpHash = await sha256Hex(input.deviceFingerprint)
    const fpRedeemed = await db
      .prepare('SELECT 1 FROM welcome_coupon_redemptions WHERE device_fingerprint_hash = ?1 LIMIT 1')
      .bind(fpHash)
      .first<{ 1: number }>()
    if (fpRedeemed) {
      return { ...baseResult, eligible: false, reason: 'anti_fraud_duplicate_fingerprint' }
    }
  }

  // Min order check
  if (baseResult.totalOrderGrossCents < policy.minOrderCents) {
    return { ...baseResult, eligible: false, reason: 'min_order_unmet' }
  }

  // Evaluate lines
  const excludedCategorySet = new Set(policy.excludedCategoryIds)
  const excludedProductSet = new Set(policy.excludedProductIds)

  let totalRawDiscount = 0
  const evaluatedLines = input.lines.map((l) => {
    let eligible = true
    let exclusionReason: string | null = null

    if (excludedCategorySet.has(l.categoryId)) {
      eligible = false
      exclusionReason = 'category_excluded'
    } else if (excludedProductSet.has(l.productId)) {
      eligible = false
      exclusionReason = 'product_excluded'
    } else if (policy.excludeAlreadyDiscounted && l.hasVolumeDiscount) {
      eligible = false
      exclusionReason = 'already_volume_discounted'
    }

    let lineDiscount = 0
    if (eligible) {
      // Calculate discount based on reference price or actual price (Omnibus compliance)
      const basePrice = Math.min(l.unitGrossCents, l.referencePriceUnitGrossCents)
      const lineGross = l.quantity * basePrice
      lineDiscount = Math.round(lineGross * (policy.discountPercent / 100))
      totalRawDiscount += lineDiscount
    }

    return {
      lineIndex: l.lineIndex,
      productId: l.productId,
      eligible,
      exclusionReason,
      unitGrossCents: l.unitGrossCents,
      referencePriceUnitGrossCents: l.referencePriceUnitGrossCents,
      discountGrossCents: lineDiscount
    }
  })

  const eligibleCount = evaluatedLines.filter((l) => l.eligible).length
  if (eligibleCount === 0) {
    return {
      ...baseResult,
      eligible: false,
      reason: 'no_eligible_lines',
      lineAllocations: evaluatedLines
    }
  }

  // Cap total discount
  const finalTotalDiscount = Math.min(totalRawDiscount, policy.maxDiscountCents)
  if (totalRawDiscount > policy.maxDiscountCents && totalRawDiscount > 0) {
    const scale = policy.maxDiscountCents / totalRawDiscount
    for (const line of evaluatedLines) {
      if (line.eligible) {
        line.discountGrossCents = Math.round(line.discountGrossCents * scale)
      }
    }
  }

  return {
    eligible: true,
    reason: null,
    couponCode: input.couponCode,
    discountPercent: policy.discountPercent,
    maxDiscountCents: policy.maxDiscountCents,
    minOrderCents: policy.minOrderCents,
    totalDiscountCents: finalTotalDiscount,
    totalOrderGrossCents: baseResult.totalOrderGrossCents,
    totalReferencePriceGrossCents: baseResult.totalReferencePriceGrossCents,
    lineAllocations: evaluatedLines
  }
}

export interface RedeemWelcomeCouponInput {
  grantId: string
  couponCode: string
  customerId: string
  orderId: string
  identityId: string
  email: string
  phone?: string
  taxId?: string
  deviceFingerprint?: string
  discountAppliedCents: number
  grossOrderCents: number
  referencePriceGrossCents: number
}

export async function redeemD1WelcomeCoupon(
  db: D1Database,
  input: RedeemWelcomeCouponInput,
  now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
): Promise<WelcomeCouponRedemption> {
  const grant = await db
    .prepare('SELECT id, status, expires_at FROM welcome_coupon_grants WHERE id = ?1')
    .bind(input.grantId)
    .first<{ id: string; status: string; expires_at: string }>()

  if (!grant || grant.status !== 'active') {
    fail('already_redeemed')
  }

  if (grant.expires_at < now) {
    fail('coupon_expired')
  }

  const canonicalEmail = normalizeEmailCanonical(input.email)
  const canonicalEmailHash = await sha256Hex(canonicalEmail)

  let canonicalPhoneHash: string | null = null
  if (input.phone) {
    canonicalPhoneHash = await sha256Hex(normalizePhoneCanonical(input.phone))
  }

  let taxIdHash: string | null = null
  if (input.taxId) {
    taxIdHash = await sha256Hex(normalizeTaxIdCanonical(input.taxId))
  }

  let deviceFingerprintHash: string | null = null
  if (input.deviceFingerprint) {
    deviceFingerprintHash = await sha256Hex(input.deviceFingerprint)
  }

  // Check if grant already redeemed in redemptions table
  const alreadyRedeemed = await db
    .prepare('SELECT 1 FROM welcome_coupon_redemptions WHERE grant_id = ?1 OR canonical_email_hash = ?2 LIMIT 1')
    .bind(input.grantId, canonicalEmailHash)
    .first<{ 1: number }>()

  if (alreadyRedeemed) {
    fail('already_redeemed')
  }

  // Mark grant redeemed
  await db
    .prepare("UPDATE welcome_coupon_grants SET status = 'redeemed' WHERE id = ?1 AND status = 'active'")
    .bind(input.grantId)
    .run()

  const redemptionId = crypto.randomUUID()
  await db
    .prepare(
      `INSERT INTO welcome_coupon_redemptions(
        id, grant_id, coupon_code, customer_id, order_id, identity_id,
        canonical_email_hash, canonical_phone_hash, tax_id_hash, device_fingerprint_hash,
        discount_applied_cents, gross_order_cents, reference_price_gross_cents, redeemed_at, created_at
      ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)`
    )
    .bind(
      redemptionId,
      input.grantId,
      input.couponCode,
      input.customerId,
      input.orderId,
      input.identityId,
      canonicalEmailHash,
      canonicalPhoneHash,
      taxIdHash,
      deviceFingerprintHash,
      input.discountAppliedCents,
      input.grossOrderCents,
      input.referencePriceGrossCents,
      now,
      now
    )
    .run()

  return {
    id: redemptionId,
    grantId: input.grantId,
    couponCode: input.couponCode,
    customerId: input.customerId,
    orderId: input.orderId,
    identityId: input.identityId,
    canonicalEmailHash,
    canonicalPhoneHash,
    taxIdHash,
    deviceFingerprintHash,
    discountAppliedCents: input.discountAppliedCents,
    grossOrderCents: input.grossOrderCents,
    referencePriceGrossCents: input.referencePriceGrossCents,
    redeemedAt: now,
    createdAt: now
  }
}

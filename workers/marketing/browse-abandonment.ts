import {
  type BrowseRecoveryPolicy,
  type BrowseRecoveryPolicyInput,
  type BrowsePreferences,
  type BrowsePreferencesInput,
  type RecordBrowseEventInput,
  type BrowseDispatch,
  type BrowseIncrementalityMetrics,
  browseRecoveryPolicyInputSchema,
  browsePreferencesInputSchema,
  recordBrowseEventInputSchema,
  isSensitiveCategoryOrProduct,
  assignBrowseExperimentGroup,
  calculateBrowseIncrementality
} from '../../shared/browse-abandonment'

export class BrowseAbandonmentError extends Error {
  constructor(
    readonly code:
      | 'invalid_input'
      | 'unauthenticated'
      | 'email_unverified'
      | 'forbidden'
      | 'not_found'
      | 'version_conflict'
      | 'service_unavailable'
      | 'suppressed_sensitive'
      | 'suppressed_cooldown'
      | 'suppressed_active_cart'
      | 'suppressed_recent_purchase'
      | 'suppressed_opt_out'
      | 'suppressed_inactive'
  ) {
    super(code)
    this.name = 'BrowseAbandonmentError'
  }
}

function fail(code: BrowseAbandonmentError['code']): never {
  throw new BrowseAbandonmentError(code)
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

export const DEFAULT_BROWSE_POLICY: BrowseRecoveryPolicy = {
  id: 'global',
  version: 1,
  enabled: true,
  abandonmentWindowMinutes: 120,
  cooldownHours: 72,
  holdoutPercent: 20,
  attributionWindowDays: 7,
  updatedAt: '2026-01-01T00:00:00Z',
  updatedBy: '00000000-0000-4000-8000-000000000000'
}

export async function readD1BrowsePolicy(db: D1Database): Promise<BrowseRecoveryPolicy> {
  const row = await db
    .prepare(
      `SELECT id, version, enabled, abandonment_window_minutes, cooldown_hours,
              holdout_percent, attribution_window_days, updated_at, updated_by
       FROM marketing_browse_recovery_policies WHERE id = 'global'`
    )
    .first<{
      id: 'global'
      version: number
      enabled: number
      abandonment_window_minutes: number
      cooldown_hours: number
      holdout_percent: number
      attribution_window_days: number
      updated_at: string
      updated_by: string
    }>()

  if (!row) return DEFAULT_BROWSE_POLICY

  return {
    id: row.id,
    version: row.version,
    enabled: Boolean(row.enabled),
    abandonmentWindowMinutes: row.abandonment_window_minutes,
    cooldownHours: row.cooldown_hours,
    holdoutPercent: row.holdout_percent,
    attributionWindowDays: row.attribution_window_days,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by
  }
}

export async function updateD1BrowsePolicy(
  db: D1Database,
  actorId: string,
  rawInput: BrowseRecoveryPolicyInput,
  now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
): Promise<BrowseRecoveryPolicy> {
  const parsed = browseRecoveryPolicyInputSchema.safeParse(rawInput)
  if (!parsed.success) fail('invalid_input')
  const input = parsed.data

  const existing = await readD1BrowsePolicy(db)

  if (
    input.expectedVersion === 0 ||
    (existing.version === 1 && existing.updatedBy === '00000000-0000-4000-8000-000000000000')
  ) {
    // Check if row exists in table
    const check = await db
      .prepare("SELECT version FROM marketing_browse_recovery_policies WHERE id = 'global'")
      .first<{ version: number }>()
    if (!check) {
      if (input.expectedVersion !== 0 && input.expectedVersion !== 1) fail('version_conflict')
      const nextVersion = input.expectedVersion === 0 ? 1 : input.expectedVersion + 1
      await db
        .prepare(
          `INSERT INTO marketing_browse_recovery_policies(
            id, version, enabled, abandonment_window_minutes, cooldown_hours,
            holdout_percent, attribution_window_days, updated_at, updated_by
          ) VALUES('global', ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
        )
        .bind(
          nextVersion,
          input.enabled ? 1 : 0,
          input.abandonmentWindowMinutes,
          input.cooldownHours,
          input.holdoutPercent,
          input.attributionWindowDays,
          now,
          actorId
        )
        .run()

      return {
        id: 'global',
        version: nextVersion,
        enabled: input.enabled,
        abandonmentWindowMinutes: input.abandonmentWindowMinutes,
        cooldownHours: input.cooldownHours,
        holdoutPercent: input.holdoutPercent,
        attributionWindowDays: input.attributionWindowDays,
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
      `UPDATE marketing_browse_recovery_policies
       SET version = ?1, enabled = ?2, abandonment_window_minutes = ?3,
           cooldown_hours = ?4, holdout_percent = ?5, attribution_window_days = ?6,
           updated_at = ?7, updated_by = ?8
       WHERE id = 'global' AND version = ?9`
    )
    .bind(
      nextVersion,
      input.enabled ? 1 : 0,
      input.abandonmentWindowMinutes,
      input.cooldownHours,
      input.holdoutPercent,
      input.attributionWindowDays,
      now,
      actorId,
      existing.version
    )
    .run()

  if ((result.meta?.changes ?? 0) === 0) {
    fail('version_conflict')
  }

  return {
    id: 'global',
    version: nextVersion,
    enabled: input.enabled,
    abandonmentWindowMinutes: input.abandonmentWindowMinutes,
    cooldownHours: input.cooldownHours,
    holdoutPercent: input.holdoutPercent,
    attributionWindowDays: input.attributionWindowDays,
    updatedAt: now,
    updatedBy: actorId
  }
}

export async function readD1BrowsePreferences(db: D1Database, customerId: string): Promise<BrowsePreferences> {
  const row = await db
    .prepare(
      `SELECT customer_id, browse_recovery_opt_in, version, updated_at
       FROM marketing_browse_preferences WHERE customer_id = ?1`
    )
    .bind(customerId)
    .first<{
      customer_id: string
      browse_recovery_opt_in: number
      version: number
      updated_at: string
    }>()

  if (!row) {
    return {
      customerId,
      browseRecoveryOptIn: false,
      version: 1,
      updatedAt: '2026-01-01T00:00:00Z'
    }
  }

  return {
    customerId: row.customer_id,
    browseRecoveryOptIn: Boolean(row.browse_recovery_opt_in),
    version: row.version,
    updatedAt: row.updated_at
  }
}

export async function updateD1BrowsePreferences(
  db: D1Database,
  customerId: string,
  rawInput: BrowsePreferencesInput,
  now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
): Promise<BrowsePreferences> {
  const parsed = browsePreferencesInputSchema.safeParse(rawInput)
  if (!parsed.success) fail('invalid_input')
  const input = parsed.data

  const existsInDb = await db
    .prepare('SELECT version FROM marketing_browse_preferences WHERE customer_id = ?1')
    .bind(customerId)
    .first<{ version: number }>()

  if (!existsInDb) {
    if (input.expectedVersion !== 0 && input.expectedVersion !== 1) fail('version_conflict')
    const nextVersion = input.expectedVersion === 0 ? 1 : input.expectedVersion + 1
    await db
      .prepare(
        `INSERT INTO marketing_browse_preferences(customer_id, browse_recovery_opt_in, version, updated_at)
         VALUES(?1, ?2, ?3, ?4)`
      )
      .bind(customerId, input.browseRecoveryOptIn ? 1 : 0, nextVersion, now)
      .run()

    return {
      customerId,
      browseRecoveryOptIn: input.browseRecoveryOptIn,
      version: nextVersion,
      updatedAt: now
    }
  }

  if (existsInDb.version !== input.expectedVersion) {
    fail('version_conflict')
  }

  const nextVersion = existsInDb.version + 1
  const result = await db
    .prepare(
      `UPDATE marketing_browse_preferences
       SET browse_recovery_opt_in = ?1, version = ?2, updated_at = ?3
       WHERE customer_id = ?4 AND version = ?5`
    )
    .bind(input.browseRecoveryOptIn ? 1 : 0, nextVersion, now, customerId, existsInDb.version)
    .run()

  if ((result.meta?.changes ?? 0) === 0) {
    fail('version_conflict')
  }

  return {
    customerId,
    browseRecoveryOptIn: input.browseRecoveryOptIn,
    version: nextVersion,
    updatedAt: now
  }
}

export async function recordD1BrowseEvent(
  db: D1Database,
  customerId: string,
  rawInput: RecordBrowseEventInput,
  now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
) {
  const { customerId: _cid, ...rest } = rawInput as Record<string, unknown>
  const parsed = recordBrowseEventInputSchema.safeParse(rest)
  if (!parsed.success) fail('invalid_input')
  const input = parsed.data

  const id = crypto.randomUUID()
  await db
    .prepare(
      `INSERT INTO marketing_browse_events(id, customer_id, product_id, category_id, view_duration_seconds, event_at, created_at)
       VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7)`
    )
    .bind(id, customerId, input.productId, input.categoryId, input.viewDurationSeconds, now, now)
    .run()

  return {
    id,
    customerId,
    productId: input.productId,
    categoryId: input.categoryId,
    viewDurationSeconds: input.viewDurationSeconds,
    eventAt: now,
    createdAt: now
  }
}

export interface BrowseEvaluationOutcome {
  eligible: boolean
  status: BrowseDispatch['status']
  groupType: BrowseDispatch['groupType']
  dispatch?: BrowseDispatch
  reason?: string
}

export async function evaluateD1BrowseAbandonment(
  db: D1Database,
  customerId: string,
  productId: string,
  now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
): Promise<BrowseEvaluationOutcome> {
  const policy = await readD1BrowsePolicy(db)
  if (!policy.enabled) {
    return { eligible: false, status: 'suppressed_inactive', groupType: 'treatment', reason: 'policy_disabled' }
  }

  // 1. Identity & Email Verification
  const customerIdentity = await db
    .prepare(
      `SELECT c.status as customer_status, i.email, i.email_verified_at, i.status as identity_status
       FROM customers c
       JOIN identities i ON i.customer_id = c.id
       WHERE c.id = ?1`
    )
    .bind(customerId)
    .first<{ customer_status: string; email: string; email_verified_at: string | null; identity_status: string }>()

  if (!customerIdentity || customerIdentity.customer_status !== 'active' || !customerIdentity.email_verified_at) {
    return {
      eligible: false,
      status: 'suppressed_inactive',
      groupType: 'treatment',
      reason: 'email_unverified_or_inactive'
    }
  }

  // 2. Preferences / Opt-in
  const preferences = await readD1BrowsePreferences(db, customerId)
  if (!preferences.browseRecoveryOptIn) {
    return { eligible: false, status: 'suppressed_opt_out', groupType: 'treatment', reason: 'consent_missing' }
  }

  // 3. Sensitive Category / Product Check (Zero behavioral surveillance leakage)
  const productInfo = await db
    .prepare(
      `SELECT p.name as product_name, c.name as category_name, c.slug as category_slug
       FROM products p
       JOIN categories c ON c.id = p.category_id
       WHERE p.id = ?1`
    )
    .bind(productId)
    .first<{ product_name: string; category_name: string; category_slug: string }>()

  if (!productInfo) {
    return { eligible: false, status: 'suppressed_inactive', groupType: 'treatment', reason: 'product_not_found' }
  }

  if (
    isSensitiveCategoryOrProduct(productInfo.category_name) ||
    isSensitiveCategoryOrProduct(productInfo.category_slug) ||
    isSensitiveCategoryOrProduct(productInfo.product_name)
  ) {
    return {
      eligible: false,
      status: 'suppressed_sensitive',
      groupType: 'treatment',
      reason: 'sensitive_category_forbidden'
    }
  }

  // 4. Cooldown Check (Frequency Cap)
  const cooldownWindowStart = new Date(Date.parse(now) - policy.cooldownHours * 3600 * 1000)
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z')
  const recentDispatch = await db
    .prepare(
      `SELECT 1 FROM marketing_browse_dispatches
       WHERE customer_id = ?1 AND dispatched_at >= ?2
       LIMIT 1`
    )
    .bind(customerId, cooldownWindowStart)
    .first<{ 1: number }>()

  if (recentDispatch) {
    return { eligible: false, status: 'suppressed_cooldown', groupType: 'treatment', reason: 'cooldown_active' }
  }

  // 5. Active Cart Check (Cart recovery priority)
  try {
    const activeCart = await db
      .prepare(
        `SELECT 1 FROM cart_recovery_associations a
         JOIN carts c ON c.id = a.cart_id
         WHERE a.customer_id = ?1 AND c.status = 'active'
         LIMIT 1`
      )
      .bind(customerId)
      .first<{ 1: number }>()

    if (activeCart) {
      return {
        eligible: false,
        status: 'suppressed_active_cart',
        groupType: 'treatment',
        reason: 'cart_abandonment_takes_priority'
      }
    }
  } catch {
    // Graceful fallback if cart recovery associations table is not present
  }

  // 6. Recent Purchase Check
  const recentOrderThreshold = new Date(Date.parse(now) - 7 * 86400 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')
  const recentOrder = await db
    .prepare(
      `SELECT 1 FROM orders
       WHERE customer_id = ?1 AND created_at >= ?2
       LIMIT 1`
    )
    .bind(customerId, recentOrderThreshold)
    .first<{ 1: number }>()

  if (recentOrder) {
    return {
      eligible: false,
      status: 'suppressed_recent_purchase',
      groupType: 'treatment',
      reason: 'recent_order_placed'
    }
  }

  // Eligible! Assign to Treatment vs Control holdout
  const groupType = assignBrowseExperimentGroup(customerId, policy.holdoutPercent)
  const status: BrowseDispatch['status'] = groupType === 'treatment' ? 'delivered' : 'control_holdout'

  const emailHash = await sha256Hex(customerIdentity.email)
  const attributionExpiresAt = new Date(Date.parse(now) + policy.attributionWindowDays * 86400 * 1000)
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z')
  const dispatchId = crypto.randomUUID()

  await db
    .prepare(
      `INSERT INTO marketing_browse_dispatches(
        id, customer_id, product_id, group_type, status,
        recipient_email_hash, attribution_expires_at, dispatched_at, created_at
      ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`
    )
    .bind(dispatchId, customerId, productId, groupType, status, emailHash, attributionExpiresAt, now, now)
    .run()

  const dispatchRecord: BrowseDispatch = {
    id: dispatchId,
    customerId,
    productId,
    groupType,
    status,
    recipientEmailHash: emailHash,
    attributionExpiresAt,
    dispatchedAt: now,
    createdAt: now
  }

  return {
    eligible: true,
    status,
    groupType,
    dispatch: dispatchRecord
  }
}

export async function attributeD1BrowseConversion(
  db: D1Database,
  orderId: string,
  customerId: string,
  grossCents: number,
  now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
): Promise<boolean> {
  const activeDispatch = await db
    .prepare(
      `SELECT id, group_type FROM marketing_browse_dispatches
       WHERE customer_id = ?1 AND attribution_expires_at >= ?2
       ORDER BY dispatched_at DESC
       LIMIT 1`
    )
    .bind(customerId, now)
    .first<{ id: string; group_type: 'treatment' | 'control' }>()

  if (!activeDispatch) return false

  const conversionId = crypto.randomUUID()
  try {
    await db
      .prepare(
        `INSERT INTO marketing_browse_conversions(id, dispatch_id, customer_id, order_id, group_type, gross_cents, converted_at, created_at)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
      )
      .bind(conversionId, activeDispatch.id, customerId, orderId, activeDispatch.group_type, grossCents, now, now)
      .run()
    return true
  } catch {
    return false
  }
}

export async function getD1BrowseIncrementalityMetrics(
  db: D1Database,
  now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
): Promise<BrowseIncrementalityMetrics> {
  const dispatchRows = await db
    .prepare(
      `SELECT group_type, COUNT(*) as count
       FROM marketing_browse_dispatches
       GROUP BY group_type`
    )
    .all<{ group_type: string; count: number }>()

  let treatmentExposures = 0
  let controlExposures = 0
  for (const row of dispatchRows.results ?? []) {
    if (row.group_type === 'treatment') treatmentExposures = row.count
    if (row.group_type === 'control') controlExposures = row.count
  }

  const conversionRows = await db
    .prepare(
      `SELECT group_type, COUNT(*) as count, SUM(gross_cents) as total_gross
       FROM marketing_browse_conversions
       GROUP BY group_type`
    )
    .all<{ group_type: string; count: number; total_gross: number }>()

  let treatmentConversions = 0
  let treatmentRevenue = 0
  let controlConversions = 0
  let controlRevenue = 0

  for (const row of conversionRows.results ?? []) {
    if (row.group_type === 'treatment') {
      treatmentConversions = row.count
      treatmentRevenue = row.total_gross ?? 0
    }
    if (row.group_type === 'control') {
      controlConversions = row.count
      controlRevenue = row.total_gross ?? 0
    }
  }

  return calculateBrowseIncrementality(
    treatmentExposures,
    treatmentConversions,
    treatmentRevenue,
    controlExposures,
    controlConversions,
    controlRevenue,
    now
  )
}

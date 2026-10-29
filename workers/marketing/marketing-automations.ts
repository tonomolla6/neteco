import { authorizeD1Session, type VerifiedSessionClaims } from '../catalog/authorization'
import {
  type AutomationReceipt,
  type AutomationsOverview,
  type CustomerPreferences,
  type CustomerPreferencesInput,
  type MarketingAutomationPolicy,
  type MarketingAutomationPolicyInput,
  type PostpurchaseDispatch,
  type WelcomeDispatch,
  type WelcomeDispatchInput,
  type WinbackEvaluation,
  automationIntentHash,
  calculateReplenishmentDays,
  customerPreferencesInputSchema,
  customerPreferencesSchema,
  marketingAutomationPolicyInputSchema,
  marketingAutomationPolicySchema,
  postpurchaseDispatchSchema,
  welcomeDispatchInputSchema,
  welcomeDispatchSchema,
  winbackEvaluationSchema,
  WELCOME_STEPS,
  WINBACK_STATUSES,
  POSTPURCHASE_STREAMS
} from '../../shared/marketing-automations'

export class MarketingAutomationError extends Error {
  constructor(
    readonly code:
      | 'invalid_input'
      | 'unauthenticated'
      | 'email_unverified'
      | 'mfa_required'
      | 'forbidden'
      | 'not_found'
      | 'conflict'
      | 'version_conflict'
      | 'service_unavailable'
      | 'suppressed'
      | 'cooldown_active'
      | 'margin_floor_breached'
  ) {
    super(code)
    this.name = 'MarketingAutomationError'
  }
}

function fail(code: MarketingAutomationError['code']): never {
  throw new MarketingAutomationError(code)
}

const DEFAULT_POLICY: MarketingAutomationPolicy = {
  id: 'global',
  version: 1,
  welcomeSeriesEnabled: true,
  welcomeDiscountEnabled: true,
  welcomeDiscountPercent: 10,
  welcomeDiscountMaxCents: 1500,
  welcomeMinOrderCents: 5000,
  welcomeMarginFloorBasisPoints: 2000,
  winbackEnabled: true,
  winbackInactivityDays: 90,
  winbackCooldownDays: 90,
  winbackDiscountPercent: 10,
  winbackDiscountMaxCents: 2000,
  winbackMarginFloorBasisPoints: 2000,
  postpurchaseEnabled: true,
  postpurchaseDelayHours: 12,
  updatedAt: '2026-01-01T00:00:00Z',
  updatedBy: '00000000-0000-4000-8000-000000000000'
}

export async function readD1AutomationsPolicy(
  db: D1Database
): Promise<MarketingAutomationPolicy> {
  const row = await db
    .prepare(
      `SELECT id, version, welcome_series_enabled, welcome_discount_enabled,
              welcome_discount_percent, welcome_discount_max_cents, welcome_min_order_cents,
              welcome_margin_floor_basis_points, winback_enabled, winback_inactivity_days,
              winback_cooldown_days, winback_discount_percent, winback_discount_max_cents,
              winback_margin_floor_basis_points, postpurchase_enabled, postpurchase_delay_hours,
              updated_at, updated_by
       FROM marketing_automation_policies
       WHERE id = 'global'`
    )
    .first<Record<string, unknown>>()

  if (!row) {
    return DEFAULT_POLICY
  }

  return marketingAutomationPolicySchema.parse({
    id: row.id,
    version: row.version,
    welcomeSeriesEnabled: row.welcome_series_enabled === 1,
    welcomeDiscountEnabled: row.welcome_discount_enabled === 1,
    welcomeDiscountPercent: row.welcome_discount_percent,
    welcomeDiscountMaxCents: row.welcome_discount_max_cents,
    welcomeMinOrderCents: row.welcome_min_order_cents,
    welcomeMarginFloorBasisPoints: row.welcome_margin_floor_basis_points,
    winbackEnabled: row.winback_enabled === 1,
    winbackInactivityDays: row.winback_inactivity_days,
    winbackCooldownDays: row.winback_cooldown_days,
    winbackDiscountPercent: row.winback_discount_percent,
    winbackDiscountMaxCents: row.winback_discount_max_cents,
    winbackMarginFloorBasisPoints: row.winback_margin_floor_basis_points,
    postpurchaseEnabled: row.postpurchase_enabled === 1,
    postpurchaseDelayHours: row.postpurchase_delay_hours,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by
  })
}

async function authorizeAdmin(
  db: D1Database,
  claims: VerifiedSessionClaims,
  now: string
): Promise<void> {
  const auth = await authorizeD1Session(db, claims, 'administration.manage', {
    requireMfa: true,
    now
  })
  if (!auth.allowed) {
    if (auth.code === 'mfa_required') fail('mfa_required')
    if (auth.code === 'unauthenticated') fail('unauthenticated')
    if (auth.code === 'email_unverified') fail('email_unverified')
    fail('forbidden')
  }
}

export async function updateD1AutomationsPolicy(
  db: D1Database,
  claims: VerifiedSessionClaims,
  input: MarketingAutomationPolicyInput,
  idempotencyKey: string,
  now: string
): Promise<AutomationReceipt> {
  await authorizeAdmin(db, claims, now)
  const parsed = marketingAutomationPolicyInputSchema.parse(input)

  // Check idempotency
  const existingCommand = await db
    .prepare(
      `SELECT receipt_json FROM marketing_automation_commands
       WHERE actor_id = ? AND idempotency_key = ?`
    )
    .bind(claims.identityId, idempotencyKey)
    .first<{ receipt_json: string }>()

  if (existingCommand) {
    return JSON.parse(existingCommand.receipt_json) as AutomationReceipt
  }

  const current = await readD1AutomationsPolicy(db)
  if (current.version !== parsed.expectedVersion) {
    fail('version_conflict')
  }

  const newVersion = parsed.expectedVersion + 1
  const commandId = crypto.randomUUID()
  const payloadHash = await automationIntentHash({ action: 'update_policy', input: parsed })

  const receipt: AutomationReceipt = {
    commandId,
    action: 'update_policy',
    appliedVersion: newVersion,
    payloadHash,
    recordedAt: now
  }

  const statements: D1PreparedStatement[] = []

  // Check if initial row exists
  const exists = await db
    .prepare(`SELECT 1 FROM marketing_automation_policies WHERE id = 'global'`)
    .first()

  if (!exists) {
    statements.push(
      db
        .prepare(
          `INSERT INTO marketing_automation_policies (
             id, version, welcome_series_enabled, welcome_discount_enabled,
             welcome_discount_percent, welcome_discount_max_cents, welcome_min_order_cents,
             welcome_margin_floor_basis_points, winback_enabled, winback_inactivity_days,
             winback_cooldown_days, winback_discount_percent, winback_discount_max_cents,
             winback_margin_floor_basis_points, postpurchase_enabled, postpurchase_delay_hours,
             updated_at, updated_by
           ) VALUES (
             'global', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
           )`
        )
        .bind(
          newVersion,
          parsed.welcomeSeriesEnabled ? 1 : 0,
          parsed.welcomeDiscountEnabled ? 1 : 0,
          parsed.welcomeDiscountPercent,
          parsed.welcomeDiscountMaxCents,
          parsed.welcomeMinOrderCents,
          parsed.welcomeMarginFloorBasisPoints,
          parsed.winbackEnabled ? 1 : 0,
          parsed.winbackInactivityDays,
          parsed.winbackCooldownDays,
          parsed.winbackDiscountPercent,
          parsed.winbackDiscountMaxCents,
          parsed.winbackMarginFloorBasisPoints,
          parsed.postpurchaseEnabled ? 1 : 0,
          parsed.postpurchaseDelayHours,
          now,
          claims.identityId
        )
    )
  } else {
    statements.push(
      db
        .prepare(
          `UPDATE marketing_automation_policies
           SET version = ?, welcome_series_enabled = ?, welcome_discount_enabled = ?,
               welcome_discount_percent = ?, welcome_discount_max_cents = ?,
               welcome_min_order_cents = ?, welcome_margin_floor_basis_points = ?,
               winback_enabled = ?, winback_inactivity_days = ?, winback_cooldown_days = ?,
               winback_discount_percent = ?, winback_discount_max_cents = ?,
               winback_margin_floor_basis_points = ?, postpurchase_enabled = ?,
               postpurchase_delay_hours = ?, updated_at = ?, updated_by = ?
           WHERE id = 'global' AND version = ?`
        )
        .bind(
          newVersion,
          parsed.welcomeSeriesEnabled ? 1 : 0,
          parsed.welcomeDiscountEnabled ? 1 : 0,
          parsed.welcomeDiscountPercent,
          parsed.welcomeDiscountMaxCents,
          parsed.welcomeMinOrderCents,
          parsed.welcomeMarginFloorBasisPoints,
          parsed.winbackEnabled ? 1 : 0,
          parsed.winbackInactivityDays,
          parsed.winbackCooldownDays,
          parsed.winbackDiscountPercent,
          parsed.winbackDiscountMaxCents,
          parsed.winbackMarginFloorBasisPoints,
          parsed.postpurchaseEnabled ? 1 : 0,
          parsed.postpurchaseDelayHours,
          now,
          claims.identityId,
          parsed.expectedVersion
        )
    )
  }

  statements.push(
    db
      .prepare(
        `INSERT INTO marketing_automation_commands (
           command_id, actor_id, action, idempotency_key, expected_version,
           applied_version, payload_hash, input_json, receipt_json, created_at
         ) VALUES (?, ?, 'update_policy', ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        commandId,
        claims.identityId,
        idempotencyKey,
        parsed.expectedVersion,
        newVersion,
        payloadHash,
        JSON.stringify(parsed),
        JSON.stringify(receipt),
        now
      )
  )

  await db.batch(statements)
  return receipt
}

export async function dispatchD1WelcomeStep(
  db: D1Database,
  claims: VerifiedSessionClaims,
  input: WelcomeDispatchInput,
  now: string
): Promise<WelcomeDispatch> {
  await authorizeAdmin(db, claims, now)
  const parsed = welcomeDispatchInputSchema.parse(input)
  const policy = await readD1AutomationsPolicy(db)

  // Check customer exists
  const customer = await db
    .prepare(
      `SELECT c.id, c.status, i.email
       FROM customers c
       LEFT JOIN identities i ON i.customer_id = c.id
       WHERE c.id = ?`
    )
    .bind(parsed.customerId)
    .first<{ id: string; status: string; email: string | null }>()

  if (!customer) {
    fail('not_found')
  }

  // Check if step was already dispatched
  const alreadyDispatched = await db
    .prepare(
      `SELECT 1 FROM marketing_welcome_dispatches WHERE customer_id = ? AND step = ?`
    )
    .bind(parsed.customerId, parsed.step)
    .first()

  if (alreadyDispatched) {
    fail('conflict')
  }

  // Determine email hash and suppression state
  const email = (customer.email ?? `customer-${parsed.customerId}@neteco.local`).toLowerCase().trim()
  const emailDigest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(email))
  const recipientEmailHash = Array.from(new Uint8Array(emailDigest), (b) =>
    b.toString(16).padStart(2, '0')
  ).join('')

  const suppression = await db
    .prepare(`SELECT 1 FROM newsletter_suppressions WHERE email_hash = ?`)
    .bind(recipientEmailHash)
    .first()

  const sub = await db
    .prepare(`SELECT status FROM newsletter_subscriptions WHERE email_hash = ?`)
    .bind(recipientEmailHash)
    .first<{ status: string }>()

  const isSuppressed =
    customer.status !== 'active' ||
    Boolean(suppression) ||
    sub?.status === 'unsubscribed' ||
    sub?.status === 'suppressed'

  let status: 'delivered' | 'skipped' | 'suppressed' = isSuppressed ? 'suppressed' : 'delivered'

  let discountCode: string | null = null
  let discountCentsCap: number | null = null
  let minOrderCents: number | null = null
  let marginFloorBasisPoints: number | null = null

  if (parsed.step === 'welcome_discount') {
    if (!policy.welcomeDiscountEnabled || isSuppressed) {
      status = isSuppressed ? 'suppressed' : 'skipped'
    } else {
      discountCode = `BIENVENIDA-${parsed.customerId.slice(0, 8).toUpperCase()}`
      discountCentsCap = policy.welcomeDiscountMaxCents
      minOrderCents = policy.welcomeMinOrderCents
      marginFloorBasisPoints = policy.welcomeMarginFloorBasisPoints
    }
  }

  const dispatchId = crypto.randomUUID()
  const dispatch: WelcomeDispatch = {
    id: dispatchId,
    customerId: parsed.customerId,
    step: parsed.step,
    discountCode,
    discountCentsCap,
    minOrderCents,
    marginFloorBasisPoints,
    status,
    recipientEmailHash,
    dispatchedAt: now,
    createdAt: now
  }

  const commandId = crypto.randomUUID()
  const payloadHash = await automationIntentHash({ action: 'dispatch_welcome', input: parsed })

  await db.batch([
    db
      .prepare(
        `INSERT INTO marketing_welcome_dispatches (
           id, customer_id, step, discount_code, discount_cents_cap, min_order_cents,
           margin_floor_basis_points, status, recipient_email_hash, dispatched_at, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        dispatch.id,
        dispatch.customerId,
        dispatch.step,
        dispatch.discountCode,
        dispatch.discountCentsCap,
        dispatch.minOrderCents,
        dispatch.marginFloorBasisPoints,
        dispatch.status,
        dispatch.recipientEmailHash,
        dispatch.dispatchedAt,
        dispatch.createdAt
      ),
    db
      .prepare(
        `INSERT INTO marketing_automation_commands (
           command_id, actor_id, action, idempotency_key, expected_version,
           applied_version, payload_hash, input_json, receipt_json, created_at
         ) VALUES (?, ?, 'dispatch_welcome', ?, 0, 1, ?, ?, ?, ?)`
      )
      .bind(
        commandId,
        claims.identityId,
        parsed.idempotencyKey,
        payloadHash,
        JSON.stringify(parsed),
        JSON.stringify(dispatch),
        now
      )
  ])

  return dispatch
}

export async function saveD1CustomerPreferences(
  db: D1Database,
  claims: VerifiedSessionClaims,
  customerId: string,
  input: CustomerPreferencesInput,
  idempotencyKey: string,
  now: string
): Promise<AutomationReceipt> {
  const parsed = customerPreferencesInputSchema.parse(input)

  // Verify identity is authorized for this customer
  const identity = await db
    .prepare(`SELECT customer_id FROM identities WHERE id = ?`)
    .bind(claims.identityId)
    .first<{ customer_id: string | null }>()

  const isAdmin = await authorizeD1Session(db, claims, 'administration.manage', { now })
  if (identity?.customer_id !== customerId && !isAdmin.allowed) {
    fail('forbidden')
  }

  // Check idempotency
  const existingCommand = await db
    .prepare(
      `SELECT receipt_json FROM marketing_automation_commands
       WHERE actor_id = ? AND idempotency_key = ?`
    )
    .bind(claims.identityId, idempotencyKey)
    .first<{ receipt_json: string }>()

  if (existingCommand) {
    return JSON.parse(existingCommand.receipt_json) as AutomationReceipt
  }

  const existingPref = await db
    .prepare(`SELECT version FROM marketing_customer_preferences WHERE customer_id = ?`)
    .bind(customerId)
    .first<{ version: number }>()

  const currentVersion = existingPref?.version ?? 0
  if (currentVersion !== parsed.expectedVersion) {
    fail('version_conflict')
  }

  const newVersion = currentVersion + 1
  const commandId = crypto.randomUUID()
  const payloadHash = await automationIntentHash({ action: 'save_preferences', customerId, input: parsed })

  const receipt: AutomationReceipt = {
    commandId,
    action: 'save_preferences',
    appliedVersion: newVersion,
    payloadHash,
    recordedAt: now
  }

  const statements: D1PreparedStatement[] = []

  if (!existingPref) {
    statements.push(
      db
        .prepare(
          `INSERT INTO marketing_customer_preferences (
             customer_id, preferred_categories, frequency, channel,
             technical_content_opt_in, version, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          customerId,
          JSON.stringify(parsed.preferredCategories),
          parsed.frequency,
          parsed.channel,
          parsed.technicalContentOptIn ? 1 : 0,
          newVersion,
          now
        )
    )
  } else {
    statements.push(
      db
        .prepare(
          `UPDATE marketing_customer_preferences
           SET preferred_categories = ?, frequency = ?, channel = ?,
               technical_content_opt_in = ?, version = ?, updated_at = ?
           WHERE customer_id = ? AND version = ?`
        )
        .bind(
          JSON.stringify(parsed.preferredCategories),
          parsed.frequency,
          parsed.channel,
          parsed.technicalContentOptIn ? 1 : 0,
          newVersion,
          now,
          customerId,
          parsed.expectedVersion
        )
    )
  }

  statements.push(
    db
      .prepare(
        `INSERT INTO marketing_automation_commands (
           command_id, actor_id, action, idempotency_key, expected_version,
           applied_version, payload_hash, input_json, receipt_json, created_at
         ) VALUES (?, ?, 'save_preferences', ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        commandId,
        claims.identityId,
        idempotencyKey,
        parsed.expectedVersion,
        newVersion,
        payloadHash,
        JSON.stringify(parsed),
        JSON.stringify(receipt),
        now
      )
  )

  await db.batch(statements)
  return receipt
}

export async function readD1CustomerPreferences(
  db: D1Database,
  customerId: string
): Promise<CustomerPreferences | null> {
  const row = await db
    .prepare(
      `SELECT customer_id, preferred_categories, frequency, channel,
              technical_content_opt_in, version, updated_at
       FROM marketing_customer_preferences
       WHERE customer_id = ?`
    )
    .bind(customerId)
    .first<Record<string, unknown>>()

  if (!row) return null

  return customerPreferencesSchema.parse({
    customerId: row.customer_id,
    preferredCategories: JSON.parse(row.preferred_categories as string),
    frequency: row.frequency,
    channel: row.channel,
    technicalContentOptIn: row.technical_content_opt_in === 1,
    version: row.version,
    updatedAt: row.updated_at
  })
}

export async function evaluateD1Winback(
  db: D1Database,
  claims: VerifiedSessionClaims,
  customerId: string,
  idempotencyKey: string,
  now: string
): Promise<WinbackEvaluation> {
  await authorizeAdmin(db, claims, now)
  const policy = await readD1AutomationsPolicy(db)

  const customer = await db
    .prepare(
      `SELECT c.id, c.status, i.email
       FROM customers c
       LEFT JOIN identities i ON i.customer_id = c.id
       WHERE c.id = ?`
    )
    .bind(customerId)
    .first<{ id: string; status: string; email: string | null }>()

  if (!customer) {
    fail('not_found')
  }

  const email = (customer.email ?? `customer-${customerId}@neteco.local`).toLowerCase().trim()
  const emailDigest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(email))
  const recipientEmailHash = Array.from(new Uint8Array(emailDigest), (b) =>
    b.toString(16).padStart(2, '0')
  ).join('')

  // 1. Exclude bajas / suppressions
  const suppression = await db
    .prepare(`SELECT 1 FROM newsletter_suppressions WHERE email_hash = ?`)
    .bind(recipientEmailHash)
    .first()

  const sub = await db
    .prepare(`SELECT status FROM newsletter_subscriptions WHERE email_hash = ?`)
    .bind(recipientEmailHash)
    .first<{ status: string }>()

  const isBaja =
    customer.status !== 'active' ||
    Boolean(suppression) ||
    sub?.status === 'unsubscribed' ||
    sub?.status === 'suppressed'

  if (isBaja) {
    const evalId = crypto.randomUUID()
    const result: WinbackEvaluation = {
      id: evalId,
      customerId,
      lastOrderId: null,
      lastOrderAt: null,
      daysInactive: 0,
      eligibilityStatus: 'excluded_suppressed',
      exclusionReason: 'Cliente dado de baja o con comunicaciones comerciales suprimidas',
      discountCode: null,
      discountPercent: null,
      discountMaxCents: null,
      marginFloorBasisPoints: null,
      dispatchedAt: null,
      createdAt: now
    }
    await recordWinbackEvaluation(db, claims.identityId, idempotencyKey, result, now)
    return result
  }

  // 2. Exclude active support incidents (tickets open or waiting)
  const incident = await db
    .prepare(
      `SELECT 1 FROM support_tickets
       WHERE customer_id = ? AND state IN ('open', 'waiting_customer', 'waiting_provider')`
    )
    .bind(customerId)
    .first()

  if (incident) {
    const evalId = crypto.randomUUID()
    const result: WinbackEvaluation = {
      id: evalId,
      customerId,
      lastOrderId: null,
      lastOrderAt: null,
      daysInactive: 0,
      eligibilityStatus: 'excluded_incidents',
      exclusionReason: 'Cliente con incidencia de soporte abierta o pendiente de resolución',
      discountCode: null,
      discountPercent: null,
      discountMaxCents: null,
      marginFloorBasisPoints: null,
      dispatchedAt: null,
      createdAt: now
    }
    await recordWinbackEvaluation(db, claims.identityId, idempotencyKey, result, now)
    return result
  }

  // 3. Exclude pending debt or failed order payments
  const debt = await db
    .prepare(
      `SELECT 1 FROM orders o
       JOIN order_payment_states p ON p.order_id = o.id
       WHERE o.customer_id = ? AND p.status IN ('failed', 'awaiting_payment', 'stock_exception')`
    )
    .bind(customerId)
    .first()

  if (debt) {
    const evalId = crypto.randomUUID()
    const result: WinbackEvaluation = {
      id: evalId,
      customerId,
      lastOrderId: null,
      lastOrderAt: null,
      daysInactive: 0,
      eligibilityStatus: 'excluded_debt',
      exclusionReason: 'Cliente con deuda pendiente o pagos fallidos en pedidos',
      discountCode: null,
      discountPercent: null,
      discountMaxCents: null,
      marginFloorBasisPoints: null,
      dispatchedAt: null,
      createdAt: now
    }
    await recordWinbackEvaluation(db, claims.identityId, idempotencyKey, result, now)
    return result
  }

  // 4. Exclude if within cooldown window
  const recentWinback = await db
    .prepare(
      `SELECT dispatched_at FROM marketing_winback_evaluations
       WHERE customer_id = ? AND eligibility_status = 'eligible' AND dispatched_at IS NOT NULL
       ORDER BY dispatched_at DESC LIMIT 1`
    )
    .bind(customerId)
    .first<{ dispatched_at: string }>()

  if (recentWinback) {
    const lastDispatchedMs = Date.parse(recentWinback.dispatched_at)
    const nowMs = Date.parse(now)
    const daysSince = Math.floor((nowMs - lastDispatchedMs) / (86400 * 1000))
    if (daysSince < policy.winbackCooldownDays) {
      const evalId = crypto.randomUUID()
      const result: WinbackEvaluation = {
        id: evalId,
        customerId,
        lastOrderId: null,
        lastOrderAt: null,
        daysInactive: daysSince,
        eligibilityStatus: 'excluded_cooldown',
        exclusionReason: `Cliente en periodo de cooldown (${daysSince}/${policy.winbackCooldownDays} días)`,
        discountCode: null,
        discountPercent: null,
        discountMaxCents: null,
        marginFloorBasisPoints: null,
        dispatchedAt: null,
        createdAt: now
      }
      await recordWinbackEvaluation(db, claims.identityId, idempotencyKey, result, now)
      return result
    }
  }

  // 5. Inactivity calculation
  const lastOrder = await db
    .prepare(
      `SELECT o.id, o.created_at FROM orders o
       JOIN order_payment_states p ON p.order_id = o.id
       WHERE o.customer_id = ? AND p.status = 'paid'
       ORDER BY o.created_at DESC LIMIT 1`
    )
    .bind(customerId)
    .first<{ id: string; created_at: string }>()

  let daysInactive = 999
  if (lastOrder) {
    const orderMs = Date.parse(lastOrder.created_at)
    const nowMs = Date.parse(now)
    daysInactive = Math.max(0, Math.floor((nowMs - orderMs) / (86400 * 1000)))
  }

  if (daysInactive < policy.winbackInactivityDays) {
    const evalId = crypto.randomUUID()
    const result: WinbackEvaluation = {
      id: evalId,
      customerId,
      lastOrderId: lastOrder?.id ?? null,
      lastOrderAt: lastOrder?.created_at ?? null,
      daysInactive,
      eligibilityStatus: 'dispatched',
      exclusionReason: 'Cliente activo recientemente; no requiere winback',
      discountCode: null,
      discountPercent: null,
      discountMaxCents: null,
      marginFloorBasisPoints: null,
      dispatchedAt: null,
      createdAt: now
    }
    await recordWinbackEvaluation(db, claims.identityId, idempotencyKey, result, now)
    return result
  }

  // Customer is eligible!
  const evalId = crypto.randomUUID()
  const discountCode = `VUELVE-${customerId.slice(0, 8).toUpperCase()}`
  const result: WinbackEvaluation = {
    id: evalId,
    customerId,
    lastOrderId: lastOrder?.id ?? null,
    lastOrderAt: lastOrder?.created_at ?? null,
    daysInactive,
    eligibilityStatus: 'eligible',
    exclusionReason: null,
    discountCode,
    discountPercent: policy.winbackDiscountPercent,
    discountMaxCents: policy.winbackDiscountMaxCents,
    marginFloorBasisPoints: policy.winbackMarginFloorBasisPoints,
    dispatchedAt: now,
    createdAt: now
  }

  await recordWinbackEvaluation(db, claims.identityId, idempotencyKey, result, now)
  return result
}

async function recordWinbackEvaluation(
  db: D1Database,
  actorId: string,
  idempotencyKey: string,
  evaluation: WinbackEvaluation,
  now: string
): Promise<void> {
  const commandId = crypto.randomUUID()
  const payloadHash = await automationIntentHash({
    action: 'evaluate_winback',
    customerId: evaluation.customerId,
    idempotencyKey
  })

  await db.batch([
    db
      .prepare(
        `INSERT INTO marketing_winback_evaluations (
           id, customer_id, last_order_id, last_order_at, days_inactive,
           eligibility_status, exclusion_reason, discount_code, discount_percent,
           discount_max_cents, margin_floor_basis_points, dispatched_at, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        evaluation.id,
        evaluation.customerId,
        evaluation.lastOrderId,
        evaluation.lastOrderAt,
        evaluation.daysInactive,
        evaluation.eligibilityStatus,
        evaluation.exclusionReason,
        evaluation.discountCode,
        evaluation.discountPercent,
        evaluation.discountMaxCents,
        evaluation.marginFloorBasisPoints,
        evaluation.dispatchedAt,
        evaluation.createdAt
      ),
    db
      .prepare(
        `INSERT INTO marketing_automation_commands (
           command_id, actor_id, action, idempotency_key, expected_version,
           applied_version, payload_hash, input_json, receipt_json, created_at
         ) VALUES (?, ?, 'evaluate_winback', ?, 0, 1, ?, ?, ?, ?)`
      )
      .bind(
        commandId,
        actorId,
        idempotencyKey,
        payloadHash,
        JSON.stringify({ customerId: evaluation.customerId }),
        JSON.stringify(evaluation),
        now
      )
  ])
}

export async function dispatchD1Postpurchase(
  db: D1Database,
  claims: VerifiedSessionClaims,
  orderId: string,
  idempotencyKey: string,
  now: string
): Promise<PostpurchaseDispatch[]> {
  await authorizeAdmin(db, claims, now)
  const policy = await readD1AutomationsPolicy(db)

  const order = await db
    .prepare(
      `SELECT o.id, o.customer_id, o.contact_email_hash, o.total_net_cents
       FROM orders o
       WHERE o.id = ?`
    )
    .bind(orderId)
    .first<{
      id: string
      customer_id: string | null
      contact_email_hash: string
      total_net_cents: number
    }>()

  if (!order) {
    fail('not_found')
  }

  // Check marketing consent
  const sub = await db
    .prepare(`SELECT status FROM newsletter_subscriptions WHERE email_hash = ?`)
    .bind(order.contact_email_hash)
    .first<{ status: string }>()

  const hasMarketingConsent = sub?.status === 'confirmed'

  // 1. Transactional Stream: Usage, Safety Protocols, FDS, PPE, Support
  // Strictly independent of marketing consent.
  const transactionalContent = {
    orderId,
    dilutionProtocol:
      'Protocolo de dilución profesional: 1:20 para desengrase intensivo y maquinaria; 1:50 para desinfección y mantenimiento diario de suelos y superficies. Aclarar con agua potable en superficies alimentarias.',
    applicationGuide:
      'Aplicar uniformemente con pulverizador o mopa de microfibra, dejar actuar 5 minutos y retirar. No mezclar nunca con productos clorados ni ácidos.',
    sdsUrl: `https://shop.neteco.es/documentacion/seguridad/${orderId}`,
    ppeRequirements: [
      'Guantes de nitrilo homologados EN 374',
      'Gafas protectoras de montura integral EN 166',
      'Ventilación adecuada del recinto'
    ],
    supportContact: 'soporte-tecnico@neteco.es / 960 000 000 (L-V 8:00 - 18:00)'
  }

  const txId = crypto.randomUUID()
  const txDispatch: PostpurchaseDispatch = {
    id: txId,
    orderId,
    customerId: order.customer_id,
    streamType: 'transactional_safety_usage',
    status: 'delivered',
    contentJson: JSON.stringify(transactionalContent),
    hasMarketingConsent,
    dispatchedAt: now,
    createdAt: now
  }

  // 2. Commercial Stream: Replenishment cadence & accessories recommendations
  // Strictly requires consent. If no consent, marked skipped_no_consent.
  const replenishmentDays = calculateReplenishmentDays(25) // Professional 25L canister default
  const replenishmentDate = new Date(Date.parse(now) + replenishmentDays * 86400 * 1000)
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z')

  const commercialContent = {
    orderId,
    estimatedReplenishmentDays: replenishmentDays,
    replenishmentDate,
    recommendedAccessories: [
      {
        sku: 'ACC-GRIFO-25L',
        name: 'Grifo dosificador estanco DIN-60 para bidón 25L',
        reason: 'Evita derrames y facilita la dosificación precisa sin salpicaduras.'
      },
      {
        sku: 'ACC-PULV-PRO',
        name: 'Pulverizador industrial resistente a químicos 1000ml',
        reason: 'Ideal para la dilución lista para usar en puestos de trabajo.'
      }
    ]
  }

  const commId = crypto.randomUUID()
  const commDispatch: PostpurchaseDispatch = {
    id: commId,
    orderId,
    customerId: order.customer_id,
    streamType: 'commercial_replenishment',
    status: hasMarketingConsent ? 'delivered' : 'skipped_no_consent',
    contentJson: hasMarketingConsent ? JSON.stringify(commercialContent) : '{}',
    hasMarketingConsent,
    dispatchedAt: now,
    createdAt: now
  }

  const commandId = crypto.randomUUID()
  const payloadHash = await automationIntentHash({
    action: 'dispatch_postpurchase',
    orderId,
    idempotencyKey
  })

  await db.batch([
    db
      .prepare(
        `INSERT INTO marketing_postpurchase_dispatches (
           id, order_id, customer_id, stream_type, status, content_json,
           has_marketing_consent, dispatched_at, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        txDispatch.id,
        txDispatch.orderId,
        txDispatch.customerId,
        txDispatch.streamType,
        txDispatch.status,
        txDispatch.contentJson,
        txDispatch.hasMarketingConsent ? 1 : 0,
        txDispatch.dispatchedAt,
        txDispatch.createdAt
      ),
    db
      .prepare(
        `INSERT INTO marketing_postpurchase_dispatches (
           id, order_id, customer_id, stream_type, status, content_json,
           has_marketing_consent, dispatched_at, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        commDispatch.id,
        commDispatch.orderId,
        commDispatch.customerId,
        commDispatch.streamType,
        commDispatch.status,
        commDispatch.contentJson,
        commDispatch.hasMarketingConsent ? 1 : 0,
        commDispatch.dispatchedAt,
        commDispatch.createdAt
      ),
    db
      .prepare(
        `INSERT INTO marketing_automation_commands (
           command_id, actor_id, action, idempotency_key, expected_version,
           applied_version, payload_hash, input_json, receipt_json, created_at
         ) VALUES (?, ?, 'dispatch_postpurchase', ?, 0, 1, ?, ?, ?, ?)`
      )
      .bind(
        commandId,
        claims.identityId,
        idempotencyKey,
        payloadHash,
        JSON.stringify({ orderId }),
        JSON.stringify([txDispatch, commDispatch]),
        now
      )
  ])

  return [txDispatch, commDispatch]
}

export async function getD1AutomationsOverview(
  db: D1Database
): Promise<AutomationsOverview> {
  const policy = await readD1AutomationsPolicy(db)

  // Welcome counts
  const welcomeRows = await db
    .prepare(
      `SELECT step, COUNT(*) as count FROM marketing_welcome_dispatches GROUP BY step`
    )
    .all<{ step: string; count: number }>()

  const welcomeCounts: Record<string, number> = {}
  for (const step of WELCOME_STEPS) welcomeCounts[step] = 0
  for (const row of welcomeRows.results) {
    welcomeCounts[row.step] = row.count
  }

  // Winback counts
  const winbackRows = await db
    .prepare(
      `SELECT eligibility_status, COUNT(*) as count FROM marketing_winback_evaluations GROUP BY eligibility_status`
    )
    .all<{ eligibility_status: string; count: number }>()

  const winbackCounts: Record<string, number> = {}
  for (const s of WINBACK_STATUSES) winbackCounts[s] = 0
  for (const row of winbackRows.results) {
    winbackCounts[row.eligibility_status] = row.count
  }

  // Postpurchase counts
  const postRows = await db
    .prepare(
      `SELECT stream_type, COUNT(*) as count FROM marketing_postpurchase_dispatches GROUP BY stream_type`
    )
    .all<{ stream_type: string; count: number }>()

  const postCounts: Record<string, number> = {}
  for (const st of POSTPURCHASE_STREAMS) postCounts[st] = 0
  for (const row of postRows.results) {
    postCounts[row.stream_type] = row.count
  }

  return {
    policy,
    counts: {
      welcomeDispatches: welcomeCounts as Record<WelcomeStep, number>,
      winbackEvaluations: winbackCounts as Record<any, number>,
      postpurchaseDispatches: postCounts as Record<any, number>
    }
  }
}

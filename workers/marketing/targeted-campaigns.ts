import {
  computeCampaignMetrics,
  createTargetedCampaignSchema,
  validateStrictNoSedeNoHierarchy,
  type CampaignDispatchItem,
  type CampaignReportingMetrics,
  type CreateTargetedCampaignInput,
  type TargetedCampaign
} from '../../shared/targeted-campaigns'

export class TargetedCampaignError extends Error {
  constructor(
    readonly code:
      | 'forbidden'
      | 'unauthorized'
      | 'not_found'
      | 'code_conflict'
      | 'sede_or_hierarchy_targeting_forbidden'
      | 'consent_missing_or_suppressed'
      | 'already_dispatched'
      | 'invalid_input'
  ) {
    super(code)
    this.name = 'TargetedCampaignError'
  }
}

export async function requireAdmin(db: D1Database, actorId: string): Promise<void> {
  const row = await db
    .prepare(
      `SELECT 1 as ok FROM identities i
       JOIN identity_roles ir ON ir.identity_id = i.id
       JOIN role_permissions rp ON rp.role_code = ir.role_code
       WHERE i.id = ?1 AND i.status = 'active' AND rp.permission_code = 'administration.manage'
         AND (ir.expires_at IS NULL OR ir.expires_at > strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`
    )
    .bind(actorId)
    .first<{ ok: number }>()

  if (!row?.ok) throw new TargetedCampaignError('forbidden')
}

export async function createTargetedCampaignAdmin(
  db: D1Database,
  args: { actorId: string; input: CreateTargetedCampaignInput; now: string }
): Promise<TargetedCampaign> {
  await requireAdmin(db, args.actorId)

  // Verify strict no sede and no hierarchy
  const check = validateStrictNoSedeNoHierarchy(args.input as unknown as Record<string, unknown>)
  if (!check.valid) {
    throw new TargetedCampaignError('sede_or_hierarchy_targeting_forbidden')
  }

  const parsed = createTargetedCampaignSchema.safeParse(args.input)
  if (!parsed.success) throw new TargetedCampaignError('invalid_input')

  const existing = await db
    .prepare(`SELECT id FROM marketing_targeted_campaigns WHERE code = ?1`)
    .bind(parsed.data.code)
    .first<{ id: string }>()

  if (existing) throw new TargetedCampaignError('code_conflict')

  const id = `cmp-${crypto.randomUUID()}`
  await db
    .prepare(
      `INSERT INTO marketing_targeted_campaigns (
        id, code, name, description, target_type, target_id,
        tariff_type, discount_percent, fixed_price_cents, rate_table_code,
        min_order_net_cents, margin_floor_basis_points, start_at, end_at, status, version, created_at, updated_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, 1, ?16, ?17)`
    )
    .bind(
      id,
      parsed.data.code,
      parsed.data.name,
      parsed.data.description,
      parsed.data.targetType,
      parsed.data.targetId,
      parsed.data.tariffType,
      parsed.data.discountPercent ?? null,
      parsed.data.fixedPriceCents ?? null,
      parsed.data.rateTableCode ?? null,
      parsed.data.minOrderNetCents ?? 0,
      parsed.data.marginFloorBasisPoints ?? 1500,
      parsed.data.startAt,
      parsed.data.endAt,
      parsed.data.status ?? 'draft',
      args.now,
      args.now
    )
    .run()

  return {
    id,
    code: parsed.data.code,
    name: parsed.data.name,
    description: parsed.data.description,
    targetType: parsed.data.targetType,
    targetId: parsed.data.targetId,
    tariffType: parsed.data.tariffType,
    discountPercent: parsed.data.discountPercent ?? null,
    fixedPriceCents: parsed.data.fixedPriceCents ?? null,
    rateTableCode: parsed.data.rateTableCode ?? null,
    minOrderNetCents: parsed.data.minOrderNetCents ?? 0,
    marginFloorBasisPoints: parsed.data.marginFloorBasisPoints ?? 1500,
    startAt: parsed.data.startAt,
    endAt: parsed.data.endAt,
    status: parsed.data.status ?? 'draft',
    version: 1,
    createdAt: args.now,
    updatedAt: args.now
  }
}

export async function listTargetedCampaignsAdmin(
  db: D1Database,
  args: { actorId: string; filter?: { targetType?: string; status?: string } }
): Promise<TargetedCampaign[]> {
  await requireAdmin(db, args.actorId)

  let sql = `SELECT id, code, name, description, target_type, target_id, tariff_type, discount_percent,
                    fixed_price_cents, rate_table_code, min_order_net_cents, margin_floor_basis_points,
                    start_at, end_at, status, version, created_at, updated_at
             FROM marketing_targeted_campaigns WHERE 1=1`
  const params: unknown[] = []

  if (args.filter?.targetType) {
    params.push(args.filter.targetType)
    sql += ` AND target_type = ?${params.length}`
  }
  if (args.filter?.status) {
    params.push(args.filter.status)
    sql += ` AND status = ?${params.length}`
  }
  sql += ` ORDER BY created_at DESC`

  const rows = await db
    .prepare(sql)
    .bind(...params)
    .all<{
      id: string
      code: string
      name: string
      description: string
      target_type: 'customer' | 'company' | 'sector'
      target_id: string
      tariff_type: 'percentage_discount' | 'fixed_price' | 'rate_table' | 'rebate_bonus'
      discount_percent: number | null
      fixed_price_cents: number | null
      rate_table_code: string | null
      min_order_net_cents: number
      margin_floor_basis_points: number
      start_at: string
      end_at: string
      status: 'draft' | 'active' | 'paused' | 'completed'
      version: number
      created_at: string
      updated_at: string
    }>()

  return (rows.results ?? []).map((r) => ({
    id: r.id,
    code: r.code,
    name: r.name,
    description: r.description,
    targetType: r.target_type,
    targetId: r.target_id,
    tariffType: r.tariff_type,
    discountPercent: r.discount_percent,
    fixedPriceCents: r.fixed_price_cents,
    rateTableCode: r.rate_table_code,
    minOrderNetCents: r.min_order_net_cents,
    marginFloorBasisPoints: r.margin_floor_basis_points,
    startAt: r.start_at,
    endAt: r.end_at,
    status: r.status,
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }))
}

export interface RecipientEligibility {
  customerId: string
  hasConsent: boolean
  exclusionReason: string | null
  consentVersion: string | null
}

export async function checkCustomerConsent(
  db: D1Database,
  customerId: string
): Promise<{ hasConsent: boolean; exclusionReason: string | null; consentVersion: string | null }> {
  const identity = await db
    .prepare(`SELECT email FROM identities WHERE customer_id = ?1`)
    .bind(customerId)
    .first<{ email: string }>()

  if (!identity?.email) {
    return { hasConsent: false, exclusionReason: 'no_email_identity', consentVersion: null }
  }

  const sub = await db
    .prepare(
      `SELECT ns.status, ns.consent_version, ns.email_hash,
              EXISTS(SELECT 1 FROM newsletter_suppressions WHERE email_hash = ns.email_hash) as is_suppressed
       FROM newsletter_subscriptions ns
       WHERE ns.email_normalized = lower(?1)`
    )
    .bind(identity.email)
    .first<{ status: string; consent_version: string; email_hash: string; is_suppressed: number }>()

  if (!sub) {
    return { hasConsent: false, exclusionReason: 'no_subscription_found', consentVersion: null }
  }

  if (sub.is_suppressed === 1 || sub.status !== 'confirmed') {
    return { hasConsent: false, exclusionReason: 'unsubscribed_or_suppressed', consentVersion: sub.consent_version }
  }

  return { hasConsent: true, exclusionReason: null, consentVersion: sub.consent_version }
}

export async function evaluateEligibleRecipients(db: D1Database, campaignId: string): Promise<RecipientEligibility[]> {
  const camp = await db
    .prepare(`SELECT id, target_type, target_id FROM marketing_targeted_campaigns WHERE id = ?1`)
    .bind(campaignId)
    .first<{ id: string; target_type: string; target_id: string }>()

  if (!camp) throw new TargetedCampaignError('not_found')

  let candidateCustomerIds: string[] = []

  if (camp.target_type === 'customer') {
    candidateCustomerIds = [camp.target_id]
  } else if (camp.target_type === 'company') {
    const comp = await db
      .prepare(`SELECT customer_id FROM companies WHERE id = ?1`)
      .bind(camp.target_id)
      .first<{ customer_id: string }>()
    if (comp?.customer_id) candidateCustomerIds = [comp.customer_id]
  } else {
    // Sector targeting: all active customers
    const rows = await db.prepare(`SELECT id FROM customers WHERE status = 'active'`).all<{ id: string }>()
    candidateCustomerIds = (rows.results ?? []).map((r) => r.id)
  }

  const results: RecipientEligibility[] = []
  for (const cid of candidateCustomerIds) {
    const consent = await checkCustomerConsent(db, cid)
    results.push({
      customerId: cid,
      hasConsent: consent.hasConsent,
      exclusionReason: consent.exclusionReason,
      consentVersion: consent.consentVersion
    })
  }

  return results
}

export async function dispatchCampaignToRecipient(
  db: D1Database,
  args: { campaignId: string; customerId: string; channel?: 'email' | 'portal' | 'account_manager'; now: string }
): Promise<CampaignDispatchItem & { consentVerified: boolean }> {
  const consent = await checkCustomerConsent(db, args.customerId)
  if (!consent.hasConsent) {
    throw new TargetedCampaignError('consent_missing_or_suppressed')
  }

  const existing = await db
    .prepare(`SELECT id FROM marketing_campaign_dispatches WHERE campaign_id = ?1 AND customer_id = ?2`)
    .bind(args.campaignId, args.customerId)
    .first<{ id: string }>()

  if (existing) throw new TargetedCampaignError('already_dispatched')

  const id = `dsp-${crypto.randomUUID()}`
  const channel = args.channel ?? 'email'
  const consentVersion = consent.consentVersion || '2026-v1'

  await db
    .prepare(
      `INSERT INTO marketing_campaign_dispatches (
        id, campaign_id, customer_id, consent_verified, consent_version,
        channel, status, dispatched_at, revenue_net_cents
      ) VALUES (?1, ?2, ?3, 1, ?4, ?5, 'dispatched', ?6, 0)`
    )
    .bind(id, args.campaignId, args.customerId, consentVersion, channel, args.now)
    .run()

  return {
    id,
    campaignId: args.campaignId,
    customerId: args.customerId,
    status: 'dispatched',
    openedAt: null,
    clickedAt: null,
    convertedAt: null,
    convertedOrderId: null,
    revenueNetCents: 0,
    consentVerified: true
  }
}

export async function recordCampaignInteraction(
  db: D1Database,
  args: {
    campaignId: string
    customerId: string
    interactionType: 'open' | 'click' | 'conversion'
    orderId?: string
    revenueNetCents?: number
    now: string
  }
): Promise<void> {
  const dispatch = await db
    .prepare(
      `SELECT id, status, opened_at, clicked_at, converted_at FROM marketing_campaign_dispatches
       WHERE campaign_id = ?1 AND customer_id = ?2`
    )
    .bind(args.campaignId, args.customerId)
    .first<{
      id: string
      status: string
      opened_at: string | null
      clicked_at: string | null
      converted_at: string | null
    }>()

  if (!dispatch) throw new TargetedCampaignError('not_found')

  if (args.interactionType === 'open') {
    const nextStatus = dispatch.status === 'dispatched' ? 'opened' : dispatch.status
    await db
      .prepare(
        `UPDATE marketing_campaign_dispatches
         SET status = ?1, opened_at = COALESCE(opened_at, ?2)
         WHERE id = ?3`
      )
      .bind(nextStatus, args.now, dispatch.id)
      .run()
  } else if (args.interactionType === 'click') {
    const nextStatus = ['dispatched', 'opened'].includes(dispatch.status) ? 'clicked' : dispatch.status
    await db
      .prepare(
        `UPDATE marketing_campaign_dispatches
         SET status = ?1, clicked_at = COALESCE(clicked_at, ?2), opened_at = COALESCE(opened_at, ?2)
         WHERE id = ?3`
      )
      .bind(nextStatus, args.now, dispatch.id)
      .run()
  } else if (args.interactionType === 'conversion') {
    await db
      .prepare(
        `UPDATE marketing_campaign_dispatches
         SET status = 'converted', converted_at = ?1, converted_order_id = ?2, revenue_net_cents = ?3,
             opened_at = COALESCE(opened_at, ?1), clicked_at = COALESCE(clicked_at, ?1)
         WHERE id = ?4`
      )
      .bind(args.now, args.orderId ?? null, args.revenueNetCents ?? 0, dispatch.id)
      .run()
  }
}

export async function getCampaignReporting(
  db: D1Database,
  args: { actorId: string; campaignId: string }
): Promise<{ campaign: TargetedCampaign; metrics: CampaignReportingMetrics }> {
  await requireAdmin(db, args.actorId)

  const camp = await db
    .prepare(
      `SELECT id, code, name, description, target_type, target_id, tariff_type, discount_percent,
              fixed_price_cents, rate_table_code, min_order_net_cents, margin_floor_basis_points,
              start_at, end_at, status, version, created_at, updated_at
       FROM marketing_targeted_campaigns WHERE id = ?1`
    )
    .bind(args.campaignId)
    .first<{
      id: string
      code: string
      name: string
      description: string
      target_type: 'customer' | 'company' | 'sector'
      target_id: string
      tariff_type: 'percentage_discount' | 'fixed_price' | 'rate_table' | 'rebate_bonus'
      discount_percent: number | null
      fixed_price_cents: number | null
      rate_table_code: string | null
      min_order_net_cents: number
      margin_floor_basis_points: number
      start_at: string
      end_at: string
      status: 'draft' | 'active' | 'paused' | 'completed'
      version: number
      created_at: string
      updated_at: string
    }>()

  if (!camp) throw new TargetedCampaignError('not_found')

  const dispatches = await db
    .prepare(
      `SELECT id, campaign_id, customer_id, status, opened_at, clicked_at, converted_at,
              converted_order_id, revenue_net_cents
       FROM marketing_campaign_dispatches WHERE campaign_id = ?1`
    )
    .bind(args.campaignId)
    .all<{
      id: string
      campaign_id: string
      customer_id: string
      status: 'dispatched' | 'opened' | 'clicked' | 'converted' | 'bounced' | 'suppressed'
      opened_at: string | null
      clicked_at: string | null
      converted_at: string | null
      converted_order_id: string | null
      revenue_net_cents: number
    }>()

  const items: CampaignDispatchItem[] = (dispatches.results ?? []).map((d) => ({
    id: d.id,
    campaignId: d.campaign_id,
    customerId: d.customer_id,
    status: d.status,
    openedAt: d.opened_at,
    clickedAt: d.clicked_at,
    convertedAt: d.converted_at,
    convertedOrderId: d.converted_order_id,
    revenueNetCents: d.revenue_net_cents
  }))

  const metrics = computeCampaignMetrics(items)

  return {
    campaign: {
      id: camp.id,
      code: camp.code,
      name: camp.name,
      description: camp.description,
      targetType: camp.target_type,
      targetId: camp.target_id,
      tariffType: camp.tariff_type,
      discountPercent: camp.discount_percent,
      fixedPriceCents: camp.fixed_price_cents,
      rateTableCode: camp.rate_table_code,
      minOrderNetCents: camp.min_order_net_cents,
      marginFloorBasisPoints: camp.margin_floor_basis_points,
      startAt: camp.start_at,
      endAt: camp.end_at,
      status: camp.status,
      version: camp.version,
      createdAt: camp.created_at,
      updatedAt: camp.updated_at
    },
    metrics
  }
}

export async function listActiveCustomerCampaigns(
  db: D1Database,
  args: { customerId: string; now: string }
): Promise<TargetedCampaign[]> {
  // Check consent first! If customer has no active consent, return empty list!
  const consent = await checkCustomerConsent(db, args.customerId)
  if (!consent.hasConsent) return []

  const company = await db
    .prepare(`SELECT id FROM companies WHERE customer_id = ?1`)
    .bind(args.customerId)
    .first<{ id: string }>()

  const rows = await db
    .prepare(
      `SELECT id, code, name, description, target_type, target_id, tariff_type, discount_percent,
              fixed_price_cents, rate_table_code, min_order_net_cents, margin_floor_basis_points,
              start_at, end_at, status, version, created_at, updated_at
       FROM marketing_targeted_campaigns
       WHERE status = 'active' AND start_at <= ?1 AND end_at >= ?1
         AND (
           (target_type = 'customer' AND target_id = ?2)
           OR (target_type = 'company' AND target_id = ?3)
           OR (target_type = 'sector')
         )
       ORDER BY created_at DESC`
    )
    .bind(args.now, args.customerId, company?.id ?? '')
    .all<{
      id: string
      code: string
      name: string
      description: string
      target_type: 'customer' | 'company' | 'sector'
      target_id: string
      tariff_type: 'percentage_discount' | 'fixed_price' | 'rate_table' | 'rebate_bonus'
      discount_percent: number | null
      fixed_price_cents: number | null
      rate_table_code: string | null
      min_order_net_cents: number
      margin_floor_basis_points: number
      start_at: string
      end_at: string
      status: 'draft' | 'active' | 'paused' | 'completed'
      version: number
      created_at: string
      updated_at: string
    }>()

  return (rows.results ?? []).map((r) => ({
    id: r.id,
    code: r.code,
    name: r.name,
    description: r.description,
    targetType: r.target_type,
    targetId: r.target_id,
    tariffType: r.tariff_type,
    discountPercent: r.discount_percent,
    fixedPriceCents: r.fixed_price_cents,
    rateTableCode: r.rate_table_code,
    minOrderNetCents: r.min_order_net_cents,
    marginFloorBasisPoints: r.margin_floor_basis_points,
    startAt: r.start_at,
    endAt: r.end_at,
    status: r.status,
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }))
}

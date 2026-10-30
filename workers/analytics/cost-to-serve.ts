import {
  type CalculateCostToServeInput,
  type CostToServeDashboardResponse,
  type CostToServeFilter,
  type CostToServeSummary,
  type OrderCostToServeRecord,
  CostToServeError,
  calculateCostToServeInputSchema,
  classifyProfitabilityTier,
  costToServeFilterSchema
} from '../../shared/cost-to-serve'
import { authorizeD1Session, type VerifiedSessionClaims } from '../catalog/authorization'

async function sha256Hex(data: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data))
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('')
}

async function assertAdmin(database: D1Database, claims: VerifiedSessionClaims, now: string): Promise<void> {
  const result = await authorizeD1Session(database, claims, 'administration.manage', {
    now,
    requireMfa: true
  })
  if (!result.allowed) {
    if (result.code === 'unauthenticated') {
      throw new CostToServeError('unauthenticated', 'Session is unauthenticated or expired')
    }
    throw new CostToServeError('forbidden', 'Requires administration.manage permission')
  }
}

export async function calculateOrderCostToServe(
  database: D1Database,
  claims: VerifiedSessionClaims,
  input: unknown,
  options: { now?: () => string } = {}
): Promise<OrderCostToServeRecord> {
  const now = options.now?.() ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  await assertAdmin(database, claims, now)

  const parsed = calculateCostToServeInputSchema.safeParse(input)
  if (!parsed.success) {
    throw new CostToServeError('invalid_input', parsed.error.message)
  }
  const data: CalculateCostToServeInput = parsed.data
  const commandId = data.commandId ?? `cmd-cts-${data.orderId}-${Date.now()}`
  const payloadHash = await sha256Hex(JSON.stringify(data))

  // 1. Check idempotency
  const existingCmd = await database
    .prepare(
      `SELECT snapshot_json FROM order_cost_to_serve_commands
       WHERE actor_id = ? AND command_id = ?`
    )
    .bind(claims.identityId, commandId)
    .first<{ snapshot_json: string }>()

  if (existingCmd) {
    const record = JSON.parse(existingCmd.snapshot_json) as OrderCostToServeRecord
    return { ...record, idempotentReplay: true }
  }

  // 2. Fetch order revenue details
  const order = await database
    .prepare(
      `SELECT id, currency, total_net_cents, total_gross_cents, total_tax_cents
       FROM orders WHERE id = ?`
    )
    .bind(data.orderId)
    .first<{
      id: string
      currency: string
      total_net_cents: number
      total_gross_cents: number
      total_tax_cents: number
    }>()

  if (!order) {
    throw new CostToServeError('not_found', `Order ${data.orderId} not found`)
  }

  // 3. Fetch current cost-to-serve record for CAS
  const existingRecord = await database
    .prepare(`SELECT id, version FROM order_cost_to_serve WHERE order_id = ?`)
    .bind(data.orderId)
    .first<{ id: string; version: number }>()

  if (existingRecord) {
    if (existingRecord.version !== data.expectedVersion) {
      throw new CostToServeError(
        'conflict',
        `Version conflict on order ${data.orderId}: expected ${data.expectedVersion}, found ${existingRecord.version}`
      )
    }
  } else if (data.expectedVersion !== 0) {
    throw new CostToServeError(
      'conflict',
      `Expected version 0 for new order cost-to-serve, but got ${data.expectedVersion}`
    )
  }

  const nextVersion = data.expectedVersion + 1
  const grossRevenueCents = order.total_gross_cents
  const netRevenueCents = order.total_net_cents
  const taxCents = order.total_tax_cents

  // 7 cost factors
  const cogsCents = data.cogsCents
  const discountCents = data.discountCents
  const paymentFeeCents = data.paymentFeeCents
  const pickingCostCents = data.pickingCostCents
  const shippingRealCostCents = data.shippingRealCostCents
  const returnsCostCents = data.returnsCostCents
  const supportCostCents = data.supportCostCents

  // Totals & contribution margin
  const totalCostToServeCents =
    cogsCents + paymentFeeCents + pickingCostCents + shippingRealCostCents + returnsCostCents + supportCostCents
  const contributionMarginCents = netRevenueCents - totalCostToServeCents
  const marginRatio = netRevenueCents > 0 ? contributionMarginCents / netRevenueCents : 0
  const profitabilityTier = classifyProfitabilityTier(marginRatio)

  const costBreakdownJson = JSON.stringify({
    cogsCents,
    discountCents,
    paymentFeeCents,
    pickingCostCents,
    shippingRealCostCents,
    returnsCostCents,
    supportCostCents,
    notes: data.notes ?? ''
  })

  const recordId = existingRecord?.id ?? crypto.randomUUID()
  const cmdId = crypto.randomUUID()

  const resultRecord: OrderCostToServeRecord = {
    id: recordId,
    orderId: data.orderId,
    currency: order.currency ?? 'EUR',
    grossRevenueCents,
    netRevenueCents,
    taxCents,
    cogsCents,
    discountCents,
    paymentFeeCents,
    pickingCostCents,
    shippingRealCostCents,
    returnsCostCents,
    supportCostCents,
    totalCostToServeCents,
    contributionMarginCents,
    marginRatio,
    profitabilityTier,
    costBreakdownJson,
    version: nextVersion,
    createdAt: now,
    updatedAt: now
  }

  const snapshotJson = JSON.stringify(resultRecord)

  const statements: D1PreparedStatement[] = []

  if (existingRecord) {
    statements.push(
      database
        .prepare(
          `UPDATE order_cost_to_serve SET
            cogs_cents = ?,
            discount_cents = ?,
            payment_fee_cents = ?,
            picking_cost_cents = ?,
            shipping_real_cost_cents = ?,
            returns_cost_cents = ?,
            support_cost_cents = ?,
            total_cost_to_serve_cents = ?,
            contribution_margin_cents = ?,
            margin_ratio = ?,
            profitability_tier = ?,
            cost_breakdown_json = ?,
            version = ?,
            updated_at = ?
          WHERE order_id = ? AND version = ?`
        )
        .bind(
          cogsCents,
          discountCents,
          paymentFeeCents,
          pickingCostCents,
          shippingRealCostCents,
          returnsCostCents,
          supportCostCents,
          totalCostToServeCents,
          contributionMarginCents,
          marginRatio,
          profitabilityTier,
          costBreakdownJson,
          nextVersion,
          now,
          data.orderId,
          data.expectedVersion
        )
    )
  } else {
    statements.push(
      database
        .prepare(
          `INSERT INTO order_cost_to_serve (
            id, order_id, currency, gross_revenue_cents, net_revenue_cents, tax_cents,
            cogs_cents, discount_cents, payment_fee_cents, picking_cost_cents,
            shipping_real_cost_cents, returns_cost_cents, support_cost_cents,
            total_cost_to_serve_cents, contribution_margin_cents, margin_ratio,
            profitability_tier, cost_breakdown_json, version, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          recordId,
          data.orderId,
          order.currency ?? 'EUR',
          grossRevenueCents,
          netRevenueCents,
          taxCents,
          cogsCents,
          discountCents,
          paymentFeeCents,
          pickingCostCents,
          shippingRealCostCents,
          returnsCostCents,
          supportCostCents,
          totalCostToServeCents,
          contributionMarginCents,
          marginRatio,
          profitabilityTier,
          costBreakdownJson,
          nextVersion,
          now,
          now
        )
    )
  }

  statements.push(
    database
      .prepare(
        `INSERT INTO order_cost_to_serve_commands (
          id, actor_id, command_id, session_id, session_version,
          order_id, expected_version, version, payload_hash, snapshot_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        cmdId,
        claims.identityId,
        commandId,
        claims.sessionId,
        claims.sessionVersion,
        data.orderId,
        data.expectedVersion,
        nextVersion,
        payloadHash,
        snapshotJson,
        now
      )
  )

  await database.batch(statements)

  return resultRecord
}

export async function getOrderCostToServe(
  database: D1Database,
  claims: VerifiedSessionClaims,
  orderId: string,
  options: { now?: () => string } = {}
): Promise<OrderCostToServeRecord | null> {
  const now = options.now?.() ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  await assertAdmin(database, claims, now)

  const row = await database
    .prepare(
      `SELECT
        id, order_id, currency, gross_revenue_cents, net_revenue_cents, tax_cents,
        cogs_cents, discount_cents, payment_fee_cents, picking_cost_cents,
        shipping_real_cost_cents, returns_cost_cents, support_cost_cents,
        total_cost_to_serve_cents, contribution_margin_cents, margin_ratio,
        profitability_tier, cost_breakdown_json, version, created_at, updated_at
      FROM order_cost_to_serve
      WHERE order_id = ?`
    )
    .bind(orderId)
    .first<{
      id: string
      order_id: string
      currency: string
      gross_revenue_cents: number
      net_revenue_cents: number
      tax_cents: number
      cogs_cents: number
      discount_cents: number
      payment_fee_cents: number
      picking_cost_cents: number
      shipping_real_cost_cents: number
      returns_cost_cents: number
      support_cost_cents: number
      total_cost_to_serve_cents: number
      contribution_margin_cents: number
      margin_ratio: number
      profitability_tier: string
      cost_breakdown_json: string
      version: number
      created_at: string
      updated_at: string
    }>()

  if (!row) return null

  return {
    id: row.id,
    orderId: row.order_id,
    currency: row.currency,
    grossRevenueCents: row.gross_revenue_cents,
    netRevenueCents: row.net_revenue_cents,
    taxCents: row.tax_cents,
    cogsCents: row.cogs_cents,
    discountCents: row.discount_cents,
    paymentFeeCents: row.payment_fee_cents,
    pickingCostCents: row.picking_cost_cents,
    shippingRealCostCents: row.shipping_real_cost_cents,
    returnsCostCents: row.returns_cost_cents,
    supportCostCents: row.support_cost_cents,
    totalCostToServeCents: row.total_cost_to_serve_cents,
    contributionMarginCents: row.contribution_margin_cents,
    marginRatio: row.margin_ratio,
    profitabilityTier: row.profitability_tier as OrderCostToServeRecord['profitabilityTier'],
    costBreakdownJson: row.cost_breakdown_json,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export async function readCostToServeSummary(
  database: D1Database,
  claims: VerifiedSessionClaims,
  filter: unknown = {},
  options: { now?: () => string } = {}
): Promise<CostToServeSummary> {
  const now = options.now?.() ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  await assertAdmin(database, claims, now)

  const parsed = costToServeFilterSchema.safeParse(filter)
  if (!parsed.success) {
    throw new CostToServeError('invalid_input', parsed.error.message)
  }
  const f: CostToServeFilter = parsed.data

  const conditions: string[] = []
  const binds: (string | number)[] = []

  if (f.from) {
    conditions.push('created_at >= ?')
    binds.push(`${f.from}T00:00:00Z`)
  }
  if (f.to) {
    conditions.push('created_at <= ?')
    binds.push(`${f.to}T23:59:59Z`)
  }
  if (f.profitabilityTier) {
    conditions.push('profitability_tier = ?')
    binds.push(f.profitabilityTier)
  }
  if (f.orderId) {
    conditions.push('order_id = ?')
    binds.push(f.orderId)
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

  const row = await database
    .prepare(
      `SELECT
        COUNT(*) as total_orders,
        COALESCE(SUM(gross_revenue_cents), 0) as total_gross,
        COALESCE(SUM(net_revenue_cents), 0) as total_net,
        COALESCE(SUM(tax_cents), 0) as total_tax,
        COALESCE(SUM(cogs_cents), 0) as total_cogs,
        COALESCE(SUM(discount_cents), 0) as total_discount,
        COALESCE(SUM(payment_fee_cents), 0) as total_payment_fee,
        COALESCE(SUM(picking_cost_cents), 0) as total_picking,
        COALESCE(SUM(shipping_real_cost_cents), 0) as total_shipping_real,
        COALESCE(SUM(returns_cost_cents), 0) as total_returns,
        COALESCE(SUM(support_cost_cents), 0) as total_support,
        COALESCE(SUM(total_cost_to_serve_cents), 0) as total_cost_to_serve,
        COALESCE(SUM(contribution_margin_cents), 0) as total_cm,
        COALESCE(SUM(CASE WHEN contribution_margin_cents >= 0 THEN 1 ELSE 0 END), 0) as profitable_count,
        COALESCE(SUM(CASE WHEN contribution_margin_cents < 0 THEN 1 ELSE 0 END), 0) as loss_making_count,
        COALESCE(SUM(CASE WHEN profitability_tier = 'high_margin' THEN 1 ELSE 0 END), 0) as high_margin_count,
        COALESCE(SUM(CASE WHEN profitability_tier = 'healthy_margin' THEN 1 ELSE 0 END), 0) as healthy_margin_count,
        COALESCE(SUM(CASE WHEN profitability_tier = 'low_margin' THEN 1 ELSE 0 END), 0) as low_margin_count,
        COALESCE(SUM(CASE WHEN profitability_tier = 'loss_making' THEN 1 ELSE 0 END), 0) as loss_making_tier_count
      FROM order_cost_to_serve
      ${whereClause}`
    )
    .bind(...binds)
    .first<{
      total_orders: number
      total_gross: number
      total_net: number
      total_tax: number
      total_cogs: number
      total_discount: number
      total_payment_fee: number
      total_picking: number
      total_shipping_real: number
      total_returns: number
      total_support: number
      total_cost_to_serve: number
      total_cm: number
      profitable_count: number
      loss_making_count: number
      high_margin_count: number
      healthy_margin_count: number
      low_margin_count: number
      loss_making_tier_count: number
    }>()

  const totalOrdersAnalyzed = row?.total_orders ?? 0
  const totalNetRevenueCents = row?.total_net ?? 0
  const totalContributionMarginCents = row?.total_cm ?? 0
  const overallMarginRatio = totalNetRevenueCents > 0 ? totalContributionMarginCents / totalNetRevenueCents : 0

  const profitableOrdersCount = row?.profitable_count ?? 0
  const lossMakingOrdersCount = row?.loss_making_count ?? 0
  const lossMakingRate = totalOrdersAnalyzed > 0 ? lossMakingOrdersCount / totalOrdersAnalyzed : 0

  return {
    totalOrdersAnalyzed,
    totalGrossRevenueCents: row?.total_gross ?? 0,
    totalNetRevenueCents,
    totalTaxCents: row?.total_tax ?? 0,
    totalCogsCents: row?.total_cogs ?? 0,
    totalDiscountCents: row?.total_discount ?? 0,
    totalPaymentFeeCents: row?.total_payment_fee ?? 0,
    totalPickingCostCents: row?.total_picking ?? 0,
    totalShippingRealCostCents: row?.total_shipping_real ?? 0,
    totalReturnsCostCents: row?.total_returns ?? 0,
    totalSupportCostCents: row?.total_support ?? 0,
    totalCostToServeCents: row?.total_cost_to_serve ?? 0,
    totalContributionMarginCents,
    overallMarginRatio,
    profitableOrdersCount,
    lossMakingOrdersCount,
    lossMakingRate,
    tiersBreakdown: {
      highMarginCount: row?.high_margin_count ?? 0,
      healthyMarginCount: row?.healthy_margin_count ?? 0,
      lowMarginCount: row?.low_margin_count ?? 0,
      lossMakingCount: row?.loss_making_tier_count ?? 0
    }
  }
}

export async function listOrderCostToServe(
  database: D1Database,
  claims: VerifiedSessionClaims,
  filter: unknown = {},
  options: { now?: () => string } = {}
): Promise<CostToServeDashboardResponse> {
  const now = options.now?.() ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  await assertAdmin(database, claims, now)

  const summary = await readCostToServeSummary(database, claims, filter, options)

  const parsed = costToServeFilterSchema.safeParse(filter)
  const f: CostToServeFilter = parsed.success ? parsed.data : { limit: 50, offset: 0 }

  const conditions: string[] = []
  const binds: (string | number)[] = []

  if (f.from) {
    conditions.push('created_at >= ?')
    binds.push(`${f.from}T00:00:00Z`)
  }
  if (f.to) {
    conditions.push('created_at <= ?')
    binds.push(`${f.to}T23:59:59Z`)
  }
  if (f.profitabilityTier) {
    conditions.push('profitability_tier = ?')
    binds.push(f.profitabilityTier)
  }
  if (f.orderId) {
    conditions.push('order_id = ?')
    binds.push(f.orderId)
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

  const rows = await database
    .prepare(
      `SELECT
        id, order_id, currency, gross_revenue_cents, net_revenue_cents, tax_cents,
        cogs_cents, discount_cents, payment_fee_cents, picking_cost_cents,
        shipping_real_cost_cents, returns_cost_cents, support_cost_cents,
        total_cost_to_serve_cents, contribution_margin_cents, margin_ratio,
        profitability_tier, cost_breakdown_json, version, created_at, updated_at
      FROM order_cost_to_serve
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?`
    )
    .bind(...binds, f.limit, f.offset)
    .all<{
      id: string
      order_id: string
      currency: string
      gross_revenue_cents: number
      net_revenue_cents: number
      tax_cents: number
      cogs_cents: number
      discount_cents: number
      payment_fee_cents: number
      picking_cost_cents: number
      shipping_real_cost_cents: number
      returns_cost_cents: number
      support_cost_cents: number
      total_cost_to_serve_cents: number
      contribution_margin_cents: number
      margin_ratio: number
      profitability_tier: string
      cost_breakdown_json: string
      version: number
      created_at: string
      updated_at: string
    }>()

  const orders: OrderCostToServeRecord[] = (rows.results ?? []).map((r) => ({
    id: r.id,
    orderId: r.order_id,
    currency: r.currency,
    grossRevenueCents: r.gross_revenue_cents,
    netRevenueCents: r.net_revenue_cents,
    taxCents: r.tax_cents,
    cogsCents: r.cogs_cents,
    discountCents: r.discount_cents,
    paymentFeeCents: r.payment_fee_cents,
    pickingCostCents: r.picking_cost_cents,
    shippingRealCostCents: r.shipping_real_cost_cents,
    returnsCostCents: r.returns_cost_cents,
    supportCostCents: r.support_cost_cents,
    totalCostToServeCents: r.total_cost_to_serve_cents,
    contributionMarginCents: r.contribution_margin_cents,
    marginRatio: r.margin_ratio,
    profitabilityTier: r.profitability_tier as OrderCostToServeRecord['profitabilityTier'],
    costBreakdownJson: r.cost_breakdown_json,
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }))

  return { summary, orders }
}

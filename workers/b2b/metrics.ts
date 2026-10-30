import {
  type B2bActivationMetrics,
  type B2bCommercialTermsMetrics,
  type B2bConversionMetrics,
  type B2bMetricsFilter,
  type B2bPaymentTermsDistributionItem,
  type B2bPricingTierDistributionItem,
  type B2bRecurrenceMetrics,
  type B2bSalesMetricsResponse,
  type B2bTopCompanyItem,
  type RecordB2bDailySnapshotInput,
  B2bSalesMetricsError,
  b2bMetricsFilterSchema,
  recordB2bDailySnapshotSchema
} from '../../shared/b2b-sales-metrics'
import { authorizeD1Session, type VerifiedSessionClaims } from '../catalog/authorization'

async function assertAdmin(database: D1Database, claims: VerifiedSessionClaims, now: string): Promise<void> {
  const result = await authorizeD1Session(database, claims, 'administration.manage', {
    now,
    requireMfa: true
  })
  if (!result.allowed) {
    if (result.code === 'unauthenticated') {
      throw new B2bSalesMetricsError('unauthenticated', 'Session is unauthenticated or expired')
    }
    throw new B2bSalesMetricsError('forbidden', 'Requires administration.manage permission')
  }
}

export async function readB2bSalesMetrics(
  database: D1Database,
  claims: VerifiedSessionClaims,
  filter: unknown = {},
  options: { now?: () => string } = {}
): Promise<B2bSalesMetricsResponse> {
  const now = options.now?.() ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  await assertAdmin(database, claims, now)

  const parsed = b2bMetricsFilterSchema.safeParse(filter)
  if (!parsed.success) {
    throw new B2bSalesMetricsError('invalid_input', parsed.error.message)
  }
  const f: B2bMetricsFilter = parsed.data
  const nowTs = Date.parse(now)

  // 1. Fetch all companies
  const companyRows = await database
    .prepare('SELECT id, customer_id, legal_name, status, created_at FROM companies ORDER BY created_at ASC')
    .all<{
      id: string
      customer_id: string
      legal_name: string
      status: string
      created_at: string
    }>()

  const allCompanies = companyRows.results ?? []
  const totalRegisteredCompanies = allCompanies.length
  const approvedCompaniesList = allCompanies.filter((c) => c.status === 'approved')
  const approvedCompanies = approvedCompaniesList.length

  // Build map of customerId -> company
  const customerToCompany = new Map<string, (typeof allCompanies)[0]>()
  for (const c of allCompanies) {
    customerToCompany.set(c.customer_id, c)
  }

  // 2. Fetch orders placed by B2B customers
  // Orders can be linked via order_customer_ownership or orders.customer_id
  const orderRows = await database
    .prepare(
      `SELECT
        o.id as order_id,
        COALESCE(oco.customer_id, o.customer_id) as customer_id,
        o.total_net_cents,
        o.total_gross_cents,
        o.created_at,
        COALESCE(ops.status, o.status) as payment_status
      FROM orders o
      LEFT JOIN order_customer_ownership oco ON oco.order_id = o.id
      LEFT JOIN order_payment_states ops ON ops.order_id = o.id
      WHERE (oco.customer_id IS NOT NULL OR o.customer_id IS NOT NULL)
      ORDER BY o.created_at ASC`
    )
    .all<{
      order_id: string
      customer_id: string
      total_net_cents: number
      total_gross_cents: number
      created_at: string
      payment_status: string
    }>()

  // Filter orders by date if requested
  const validOrders = (orderRows.results ?? []).filter((o) => {
    if (!customerToCompany.has(o.customer_id)) return false
    if (f.from && o.created_at < `${f.from}T00:00:00Z`) return false
    if (f.to && o.created_at > `${f.to}T23:59:59Z`) return false
    // Only count non-cancelled paid/awaiting orders
    return o.payment_status === 'paid' || o.payment_status === 'awaiting_payment'
  })

  // Group orders by companyId
  const companyOrders = new Map<string, typeof validOrders>()
  for (const o of validOrders) {
    const comp = customerToCompany.get(o.customer_id)
    if (!comp) continue
    const list = companyOrders.get(comp.id) ?? []
    list.push(o)
    companyOrders.set(comp.id, list)
  }

  // Calculate Activation
  let activatedCompanies = 0
  const daysToFirstOrderList: number[] = []
  let pendingUnder30 = 0
  let pending30to90 = 0
  let pendingOver90 = 0

  for (const comp of approvedCompaniesList) {
    const orders = companyOrders.get(comp.id)
    if (orders && orders.length > 0) {
      activatedCompanies++
      const firstOrder = orders[0]!
      const compCreated = Date.parse(comp.created_at)
      const orderCreated = Date.parse(firstOrder.created_at)
      const days = Math.round((orderCreated - compCreated) / 86400000)
      daysToFirstOrderList.push(days)
    } else {
      // Pending activation aging
      const compCreated = Date.parse(comp.created_at)
      const ageDays = (nowTs - compCreated) / 86400000
      if (ageDays < 30) {
        pendingUnder30++
      } else if (ageDays <= 90) {
        pending30to90++
      } else {
        pendingOver90++
      }
    }
  }

  const activationRate = approvedCompanies > 0 ? activatedCompanies / approvedCompanies : 0
  const avgDaysToFirstOrder =
    daysToFirstOrderList.length > 0
      ? daysToFirstOrderList.reduce((acc, d) => acc + d, 0) / daysToFirstOrderList.length
      : 0

  const activation: B2bActivationMetrics = {
    totalRegisteredCompanies,
    approvedCompanies,
    activatedCompanies,
    activationRate,
    avgDaysToFirstOrder,
    pendingActivationAging: {
      under30Days: pendingUnder30,
      days30to90: pending30to90,
      over90Days: pendingOver90
    }
  }

  // Calculate Conversion
  const ordersCount = validOrders.length
  const revenueNetCents = validOrders.reduce((sum, o) => sum + o.total_net_cents, 0)
  const averageOrderValueCents = ordersCount > 0 ? Math.round(revenueNetCents / ordersCount) : 0

  const conversion: B2bConversionMetrics = {
    ordersCount,
    revenueNetCents,
    averageOrderValueCents,
    checkoutsCompleted: ordersCount
  }

  // Calculate Recurrence
  let oneTimeBuyers = 0
  let repeatBuyers = 0
  const intervalsDays: number[] = []

  for (const [_, orders] of companyOrders.entries()) {
    if (orders.length === 1) {
      oneTimeBuyers++
    } else if (orders.length >= 2) {
      repeatBuyers++
      // Calculate intervals between consecutive orders
      for (let i = 1; i < orders.length; i++) {
        const prev = Date.parse(orders[i - 1]!.created_at)
        const curr = Date.parse(orders[i]!.created_at)
        intervalsDays.push(Math.round((curr - prev) / 86400000))
      }
    }
  }

  const totalBuyers = oneTimeBuyers + repeatBuyers
  const repeatPurchaseRate = totalBuyers > 0 ? repeatBuyers / totalBuyers : 0
  const avgDaysBetweenOrders =
    intervalsDays.length > 0 ? Math.round(intervalsDays.reduce((acc, d) => acc + d, 0) / intervalsDays.length) : 0

  const recurrence: B2bRecurrenceMetrics = {
    oneTimeBuyers,
    repeatBuyers,
    repeatPurchaseRate,
    avgDaysBetweenOrders
  }

  // Calculate Commercial Terms (Condiciones comerciales reales)
  // 1. Payment Terms & Credit from latest b2b_credit_commands per company
  const creditRows = await database
    .prepare(
      `SELECT c.company_id, c.payment_days, c.credit_limit_cents, c.blocked
       FROM b2b_credit_commands c
       INNER JOIN (
         SELECT company_id, MAX(expected_version) as max_v
         FROM b2b_credit_commands
         GROUP BY company_id
       ) latest ON latest.company_id = c.company_id AND latest.max_v = c.expected_version`
    )
    .all<{
      company_id: string
      payment_days: number
      credit_limit_cents: number
      blocked: number
    }>()

  const paymentTermsCountMap = new Map<number, number>()
  let totalCreditLimitCents = 0
  let blockedCompaniesCount = 0

  for (const row of creditRows.results ?? []) {
    const current = paymentTermsCountMap.get(row.payment_days) ?? 0
    paymentTermsCountMap.set(row.payment_days, current + 1)
    totalCreditLimitCents += row.credit_limit_cents
    if (row.blocked === 1) {
      blockedCompaniesCount++
    }
  }

  const paymentTermsDistribution: B2bPaymentTermsDistributionItem[] = []
  for (const [days, count] of paymentTermsCountMap.entries()) {
    paymentTermsDistribution.push({ paymentDays: days, companiesCount: count })
  }
  paymentTermsDistribution.sort((a, b) => a.paymentDays - b.paymentDays)

  // 2. Pricing Tiers from b2b_company_assignments
  const pricingRows = await database
    .prepare(
      `SELECT price_list_id, COUNT(company_id) as comp_count
       FROM b2b_company_assignments
       WHERE active = 1
       GROUP BY price_list_id
       ORDER BY comp_count DESC`
    )
    .all<{ price_list_id: string; comp_count: number }>()

  const pricingTiersDistribution: B2bPricingTierDistributionItem[] = (pricingRows.results ?? []).map((r) => ({
    priceListId: r.price_list_id,
    companiesCount: r.comp_count
  }))

  const commercialTerms: B2bCommercialTermsMetrics = {
    paymentTermsDistribution,
    creditExposure: {
      totalCreditLimitCents,
      blockedCompaniesCount
    },
    pricingTiersDistribution
  }

  // Top companies ranking
  const topCompanies: B2bTopCompanyItem[] = []
  for (const [compId, orders] of companyOrders.entries()) {
    const comp = allCompanies.find((c) => c.id === compId)
    const ordersTotalNet = orders.reduce((sum, o) => sum + o.total_net_cents, 0)
    topCompanies.push({
      companyId: compId,
      legalName: comp?.legal_name ?? 'Empresa',
      ordersCount: orders.length,
      revenueNetCents: ordersTotalNet
    })
  }

  topCompanies.sort((a, b) => b.revenueNetCents - a.revenueNetCents)

  return {
    activation,
    conversion,
    recurrence,
    commercialTerms,
    topCompanies
  }
}

export async function recordB2bSalesDailySnapshot(
  database: D1Database,
  claims: VerifiedSessionClaims,
  input: unknown,
  options: { commandId?: string; now?: () => string } = {}
): Promise<{ snapshotRecorded: boolean; date: string }> {
  const now = options.now?.() ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  await assertAdmin(database, claims, now)

  const parsed = recordB2bDailySnapshotSchema.safeParse(input)
  if (!parsed.success) {
    throw new B2bSalesMetricsError('invalid_input', parsed.error.message)
  }
  const data: RecordB2bDailySnapshotInput = parsed.data

  await database
    .prepare(
      `INSERT INTO b2b_sales_daily_snapshots (
        snapshot_date, total_companies, approved_companies, activated_companies,
        orders_count, revenue_gross_cents, revenue_net_cents, average_order_value_cents,
        credit_limit_total_cents, credit_utilized_cents, overdue_cents, blocked_companies_count, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(snapshot_date) DO UPDATE SET
        total_companies = excluded.total_companies,
        approved_companies = excluded.approved_companies,
        activated_companies = excluded.activated_companies,
        orders_count = excluded.orders_count,
        revenue_gross_cents = excluded.revenue_gross_cents,
        revenue_net_cents = excluded.revenue_net_cents,
        average_order_value_cents = excluded.average_order_value_cents,
        credit_limit_total_cents = excluded.credit_limit_total_cents,
        credit_utilized_cents = excluded.credit_utilized_cents,
        overdue_cents = excluded.overdue_cents,
        blocked_companies_count = excluded.blocked_companies_count`
    )
    .bind(
      data.date,
      data.totalCompanies,
      data.approvedCompanies,
      data.activatedCompanies,
      data.ordersCount,
      data.revenueGrossCents,
      data.revenueNetCents,
      data.averageOrderValueCents,
      data.creditLimitTotalCents,
      data.creditUtilizedCents,
      data.overdueCents,
      data.blockedCompaniesCount,
      now
    )
    .run()

  return { snapshotRecorded: true, date: data.date }
}

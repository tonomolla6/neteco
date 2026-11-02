import { z } from 'zod'
import { catalogPolicyOwnJson } from '../../shared/catalog-publication-policy'
import type { VerifiedSessionClaims } from '../catalog/authorization'
import {
  AnalyticsMeasurementError,
  analyticsAssertEnabled,
  analyticsAssertCurrentConfiguration,
  analyticsAssertUnchanged,
  analyticsAuthorizeAdmin,
  analyticsClock,
  analyticsDatabase,
  analyticsPolicyFingerprint,
  type AnalyticsMeasurementDependencies
} from './authority'

export const cohortsQuerySchema = z
  .object({
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
    segment: z.enum(['all', 'particular', 'professional']).default('all'),
    categoryId: z.string().min(1).max(200).default('all'),
    churnDays: z.coerce.number().int().positive().max(730).default(90)
  })
  .strict()

export type CohortsAnalyticsQuery = z.infer<typeof cohortsQuerySchema>

export interface CohortRateMetric {
  count: number
  rate: number
}

export interface CohortSegmentMetric {
  count: number
  repeatCount: number
  repeatRate: number
}

export interface CohortCategoryBreakdown {
  categoryId: string
  categoryName: string
  customerCount: number
}

export interface CohortItem {
  cohort: string // 'YYYY-MM'
  size: number
  repeat30Days: CohortRateMetric
  repeat60Days: CohortRateMetric
  repeat90Days: CohortRateMetric
  repeat180Days: CohortRateMetric
  medianDaysToRepurchase: number | null
  churn: {
    days: number
    count: number
    rate: number
  }
  segments: {
    particular: CohortSegmentMetric
    professional: CohortSegmentMetric
  }
  topCategories: CohortCategoryBreakdown[]
}

export interface CohortsAnalyticsResponse {
  period: {
    from: string
    to: string
  }
  filters: {
    segment: string
    categoryId: string
    churnDays: number
  }
  definitionVersion: string
  definitions: Record<string, string>
  summary: {
    totalCustomers: number
    totalRepeatCustomers: number
    overallRepeatRate: number
    medianDaysToRepurchase: number | null
    overallChurnRate: number
  }
  cohorts: CohortItem[]
}

const DEFINITIONS_V1: Record<string, string> = {
  cohort: 'Mes natural (YYYY-MM) de la primera compra válida del cliente.',
  validOrders:
    'Pedidos con estado de pago "paid", no cancelados, y cuyo importe reembolsado acumulado sea estrictamente inferior al total bruto del pedido.',
  customerIdentifier:
    'Identificador unívoco del cliente: customer_id para clientes con cuenta o hash SHA-256 del email de contacto para compras como invitado.',
  retentionWindows:
    'Porcentaje de clientes de la cohorte que completaron su segunda compra válida en un plazo menor o igual a 30, 60, 90 o 180 días naturales desde la primera compra.',
  medianDaysToRepurchase:
    'Mediana de días transcurridos entre la primera y la segunda compra entre los clientes de la cohorte que efectivamente recompraron.',
  churn:
    'Cliente inactivo sin ningún pedido válido en los últimos N días (parámetro configurable churnDays, por defecto 90 días) respecto a la fecha de consulta.',
  segmentation:
    'Profesional si el pedido contiene razón social/NIF de empresa o el cliente tiene empresa aprobada; particular en caso contrario.'
}

interface RawOrderRow {
  order_id: string
  buyer_id: string
  created_at: string
  segment: 'particular' | 'professional'
  category_id: string | null
  category_name: string | null
}

export async function readCohortsAnalytics(
  deps: AnalyticsMeasurementDependencies,
  claims: VerifiedSessionClaims,
  rawQuery: Partial<CohortsAnalyticsQuery> = {}
): Promise<CohortsAnalyticsResponse> {
  const policy = analyticsAssertEnabled(deps)
  const origin = deps.origin
  const database = analyticsDatabase(deps)

  await analyticsAuthorizeAdmin(deps, claims)
  const fingerprint = await analyticsPolicyFingerprint(policy)
  await analyticsAssertUnchanged(deps, fingerprint)
  analyticsAssertCurrentConfiguration(deps, policy, origin)

  let query: CohortsAnalyticsQuery
  try {
    query = cohortsQuerySchema.parse(catalogPolicyOwnJson(rawQuery))
  } catch {
    throw new AnalyticsMeasurementError('invalid_input')
  }

  const now = analyticsClock(deps)
  const to = query.to ?? now
  const from = query.from ?? new Date(Date.parse(to) - 365 * 86400000).toISOString().replace(/\.\d{3}Z$/, 'Z')
  const churnDays = query.churnDays

  // Fetch all valid orders with refund exclusion, payment status check, and cancellation check
  const sql = `
    SELECT
      o.id AS order_id,
      COALESCE(o.customer_id, 'email:' || o.contact_email_hash) AS buyer_id,
      o.created_at,
      CASE
        WHEN (o.buyer_company_name IS NOT NULL AND trim(o.buyer_company_name) != '')
          OR (o.buyer_tax_id IS NOT NULL AND trim(o.buyer_tax_id) != '')
          OR EXISTS(SELECT 1 FROM companies c WHERE c.customer_id=o.customer_id AND c.status='approved')
        THEN 'professional'
        ELSE 'particular'
      END AS segment,
      (
        SELECT p.category_id
        FROM order_lines ol
        JOIN variants v ON v.id = ol.variant_id
        JOIN products p ON p.id = v.product_id
        WHERE ol.order_id = o.id
        ORDER BY ol.gross_cents DESC
        LIMIT 1
      ) AS category_id,
      (
        SELECT cat.name
        FROM order_lines ol
        JOIN variants v ON v.id = ol.variant_id
        JOIN products p ON p.id = v.product_id
        JOIN categories cat ON cat.id = p.category_id
        WHERE ol.order_id = o.id
        ORDER BY ol.gross_cents DESC
        LIMIT 1
      ) AS category_name
    FROM orders o
    JOIN order_payment_states ops ON ops.order_id = o.id AND ops.status = 'paid'
    WHERE o.status != 'cancelled'
      AND COALESCE((
        SELECT SUM(rc.amount_gross_cents)
        FROM refund_contracts rc
        JOIN refund_work rw ON rw.refund_id = rc.id
        WHERE rc.order_id = o.id AND rw.status = 'completed'
      ), 0) < o.total_gross_cents
    ORDER BY o.created_at ASC
  `

  const rows = (await database.prepare(sql).all<RawOrderRow>()).results ?? []

  // Group orders by buyer
  const buyerOrders = new Map<string, RawOrderRow[]>()
  for (const row of rows) {
    let list = buyerOrders.get(row.buyer_id)
    if (!list) {
      list = []
      buyerOrders.set(row.buyer_id, list)
    }
    list.push(row)
  }

  // Intermediate structure for cohort grouping
  interface BuyerCohortData {
    buyerId: string
    cohortMonth: string
    firstOrderAt: string
    secondOrderAt: string | null
    lastOrderAt: string
    daysToSecond: number | null
    segment: 'particular' | 'professional'
    firstCategoryId: string | null
    firstCategoryName: string | null
  }

  const cohortMap = new Map<string, BuyerCohortData[]>()
  const fromMonth = from.slice(0, 7)
  const toMonth = to.slice(0, 7)

  for (const [buyerId, orderList] of buyerOrders.entries()) {
    // Orders are ordered by created_at ASC
    const firstOrder = orderList[0]
    const lastOrder = orderList[orderList.length - 1]
    if (!firstOrder || !lastOrder) continue
    const cohortMonth = firstOrder.created_at.slice(0, 7)

    // Check if within queried cohort months
    if (cohortMonth < fromMonth || cohortMonth > toMonth) {
      continue
    }

    // Apply segment filter
    if (query.segment !== 'all' && firstOrder.segment !== query.segment) {
      continue
    }

    // Apply category filter
    if (query.categoryId !== 'all' && firstOrder.category_id !== query.categoryId) {
      continue
    }

    const secondOrder = orderList.length > 1 ? orderList[1] : null

    let daysToSecond: number | null = null
    if (secondOrder) {
      const diffMs = Date.parse(secondOrder.created_at) - Date.parse(firstOrder.created_at)
      daysToSecond = Math.max(0, diffMs / 86400000)
    }

    const buyerData: BuyerCohortData = {
      buyerId,
      cohortMonth,
      firstOrderAt: firstOrder.created_at,
      secondOrderAt: secondOrder?.created_at ?? null,
      lastOrderAt: lastOrder.created_at,
      daysToSecond,
      segment: firstOrder.segment,
      firstCategoryId: firstOrder.category_id,
      firstCategoryName: firstOrder.category_name
    }

    let list = cohortMap.get(cohortMonth)
    if (!list) {
      list = []
      cohortMap.set(cohortMonth, list)
    }
    list.push(buyerData)
  }

  // Calculate cohort metrics
  const sortedMonths = Array.from(cohortMap.keys()).sort()
  const cohorts: CohortItem[] = []
  let totalCustomersAcrossAll = 0
  let totalRepeatCustomersAcrossAll = 0
  const allDaysToRepurchase: number[] = []
  let totalChurnedAcrossAll = 0
  const queryTimeMs = Date.parse(now)

  for (const month of sortedMonths) {
    const buyers = cohortMap.get(month)!
    const size = buyers.length
    totalCustomersAcrossAll += size

    let repeat30 = 0
    let repeat60 = 0
    let repeat90 = 0
    let repeat180 = 0
    const cohortRepurchaseDays: number[] = []
    let churnCount = 0

    const segmentStats = {
      particular: { count: 0, repeatCount: 0 },
      professional: { count: 0, repeatCount: 0 }
    }

    const categoryCounts = new Map<string, { name: string; count: number }>()

    for (const b of buyers) {
      segmentStats[b.segment].count++

      if (b.daysToSecond !== null) {
        cohortRepurchaseDays.push(b.daysToSecond)
        allDaysToRepurchase.push(b.daysToSecond)
        totalRepeatCustomersAcrossAll++
        segmentStats[b.segment].repeatCount++

        if (b.daysToSecond <= 30) repeat30++
        if (b.daysToSecond <= 60) repeat60++
        if (b.daysToSecond <= 90) repeat90++
        if (b.daysToSecond <= 180) repeat180++
      }

      // Churn check: inactive for > churnDays relative to query to time
      const daysSinceLastOrder = (queryTimeMs - Date.parse(b.lastOrderAt)) / 86400000
      if (daysSinceLastOrder > churnDays) {
        churnCount++
        totalChurnedAcrossAll++
      }

      // Category count
      if (b.firstCategoryId) {
        const catEntry = categoryCounts.get(b.firstCategoryId) ?? {
          name: b.firstCategoryName ?? b.firstCategoryId,
          count: 0
        }
        catEntry.count++
        categoryCounts.set(b.firstCategoryId, catEntry)
      }
    }

    // Median days to second purchase for this cohort
    cohortRepurchaseDays.sort((a, b) => a - b)
    let medianDays: number | null = null
    if (cohortRepurchaseDays.length > 0) {
      const mid = Math.floor(cohortRepurchaseDays.length / 2)
      if (cohortRepurchaseDays.length % 2 === 1) {
        medianDays = Math.round(cohortRepurchaseDays[mid]!)
      } else {
        medianDays = Math.round((cohortRepurchaseDays[mid - 1]! + cohortRepurchaseDays[mid]!) / 2)
      }
    }

    const topCategories: CohortCategoryBreakdown[] = Array.from(categoryCounts.entries())
      .map(([id, data]) => ({
        categoryId: id,
        categoryName: data.name,
        customerCount: data.count
      }))
      .sort((a, b) => b.customerCount - a.customerCount)
      .slice(0, 10)

    cohorts.push({
      cohort: month,
      size,
      repeat30Days: { count: repeat30, rate: size > 0 ? Math.round((repeat30 / size) * 1000) / 1000 : 0 },
      repeat60Days: { count: repeat60, rate: size > 0 ? Math.round((repeat60 / size) * 1000) / 1000 : 0 },
      repeat90Days: { count: repeat90, rate: size > 0 ? Math.round((repeat90 / size) * 1000) / 1000 : 0 },
      repeat180Days: { count: repeat180, rate: size > 0 ? Math.round((repeat180 / size) * 1000) / 1000 : 0 },
      medianDaysToRepurchase: medianDays,
      churn: {
        days: churnDays,
        count: churnCount,
        rate: size > 0 ? Math.round((churnCount / size) * 1000) / 1000 : 0
      },
      segments: {
        particular: {
          count: segmentStats.particular.count,
          repeatCount: segmentStats.particular.repeatCount,
          repeatRate:
            segmentStats.particular.count > 0
              ? Math.round((segmentStats.particular.repeatCount / segmentStats.particular.count) * 1000) / 1000
              : 0
        },
        professional: {
          count: segmentStats.professional.count,
          repeatCount: segmentStats.professional.repeatCount,
          repeatRate:
            segmentStats.professional.count > 0
              ? Math.round((segmentStats.professional.repeatCount / segmentStats.professional.count) * 1000) / 1000
              : 0
        }
      },
      topCategories
    })
  }

  // Global median
  allDaysToRepurchase.sort((a, b) => a - b)
  let globalMedianDays: number | null = null
  if (allDaysToRepurchase.length > 0) {
    const mid = Math.floor(allDaysToRepurchase.length / 2)
    if (allDaysToRepurchase.length % 2 === 1) {
      globalMedianDays = Math.round(allDaysToRepurchase[mid]!)
    } else {
      globalMedianDays = Math.round((allDaysToRepurchase[mid - 1]! + allDaysToRepurchase[mid]!) / 2)
    }
  }

  return {
    period: { from, to },
    filters: {
      segment: query.segment,
      categoryId: query.categoryId,
      churnDays: query.churnDays
    },
    definitionVersion: '2026-10-v1',
    definitions: DEFINITIONS_V1,
    summary: {
      totalCustomers: totalCustomersAcrossAll,
      totalRepeatCustomers: totalRepeatCustomersAcrossAll,
      overallRepeatRate:
        totalCustomersAcrossAll > 0
          ? Math.round((totalRepeatCustomersAcrossAll / totalCustomersAcrossAll) * 1000) / 1000
          : 0,
      medianDaysToRepurchase: globalMedianDays,
      overallChurnRate:
        totalCustomersAcrossAll > 0 ? Math.round((totalChurnedAcrossAll / totalCustomersAcrossAll) * 1000) / 1000 : 0
    },
    cohorts
  }
}

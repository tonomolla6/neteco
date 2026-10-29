import { authorizeD1Session, type VerifiedSessionClaims } from './authorization'
import type { AdminOrderSummary, AdminStats } from '../../shared/types/admin'
import { readPublicProductMedia } from '../media/public-catalog'
import { inventoryPositionCtes } from './inventory-position-sql'
import { splitGross } from '../../server/domain/money'
import { readOrderPurchaseOrderReference } from './order-customer-reference'

/** Read capabilities describe persisted D1 facts, not the legacy PostgreSQL UI. */
export const ADMIN_ORDER_CAPABILITIES = {
  orderStatusUpdate: false,
  shipments: false,
  tracking: false,
  refunds: false,
  returns: false,
  invoices: false,
  notes: false,
  customerPreview: false,
  paymentsRead: true,
  inventoryRead: true,
  fulfillmentRead: true,
  orderHistory: true
} as const

export interface AdminOrderQuery {
  page: number
  perPage: number
  q: string
  bucket: 'todos' | 'por_preparar' | 'por_cobrar' | 'incidencia'
  sortKey: 'id' | 'createdAt' | 'name' | 'total'
  sortDir: 'asc' | 'desc'
  paymentStatus?: string
  orderStatus?: string
  shippingMethod?: string
  customerType?: 'b2c' | 'b2b'
  from?: string
  to?: string
}

export type AdminReadResult<T> =
  | { outcome: 'found'; data: T }
  | { outcome: 'not_found' }
  | { outcome: 'denied'; code: 'unauthenticated' | 'email_unverified' | 'mfa_required' | 'forbidden' }

async function authorized<T>(
  database: D1Database,
  claims: VerifiedSessionClaims | null,
  now: string,
  read: (instant: string) => Promise<T | null>
): Promise<AdminReadResult<T>> {
  if (!claims) return { outcome: 'denied', code: 'unauthenticated' }
  const started = Date.now()
  const authorizationInstant = () =>
    new Date(Date.parse(now) + Math.max(0, Date.now() - started)).toISOString().replace(/\.\d{3}Z$/, 'Z')
  const before = await authorizeD1Session(database, claims, 'administration.manage', { now: authorizationInstant() })
  if (!before.allowed) return { outcome: 'denied', code: before.code }
  const data = await read(authorizationInstant())
  // A revoked session/grant during a multi-query read must not release private data.
  const after = await authorizeD1Session(database, claims, 'administration.manage', { now: authorizationInstant() })
  if (!after.allowed) return { outcome: 'denied', code: after.code }
  return data === null ? { outcome: 'not_found' } : { outcome: 'found', data }
}

const PAYMENT = `CASE COALESCE(payment.status, 'awaiting_payment')
  WHEN 'awaiting_payment' THEN 'pending' WHEN 'paid' THEN 'captured'
  WHEN 'provider_authorised' THEN 'authorized' ELSE payment.status END`
const COMMERCIAL = `CASE WHEN o.status = 'cancelled' THEN 'cancelado'
  WHEN payment.status = 'paid' THEN 'pagado' WHEN payment.status = 'stock_exception' THEN 'incidencia_stock'
  WHEN payment.status IN ('failed','cancelled') THEN 'pago_fallido'
  WHEN payment.status IN ('processing','provider_authorised') THEN 'procesando_pago'
  ELSE 'pendiente_pago' END`
const NAME = `COALESCE(o.contact_name, address.recipient_name, '')`
const COMPANY = `COALESCE(o.buyer_company_name, address.company_name)`
const SPANISH_SEARCH_FOLD = [
  ['Á', 'a'],
  ['á', 'a'],
  ['É', 'e'],
  ['é', 'e'],
  ['Í', 'i'],
  ['í', 'i'],
  ['Ó', 'o'],
  ['ó', 'o'],
  ['Ú', 'u'],
  ['ú', 'u'],
  ['Ü', 'u'],
  ['ü', 'u'],
  ['Ñ', 'n'],
  ['ñ', 'n']
] as const

/** SQLite lower() is ASCII-only. Fold the same Spanish characters on both
 * sides before searching; accents and ñ/n are intentionally equivalent.
 * This stays in SQL so matches, totals and page boundaries remain consistent. */
function spanishSearchSql(expression: string) {
  return `lower(${SPANISH_SEARCH_FOLD.reduce((sql, [from, to]) => `replace(${sql}, '${from}', '${to}')`, expression)})`
}

function spanishSearchTerm(term: string) {
  return SPANISH_SEARCH_FOLD.reduce((value, [from, to]) => value.replaceAll(from, to), term).toLowerCase()
}
const JOINS = `FROM orders o LEFT JOIN order_payment_states payment ON payment.order_id = o.id
  LEFT JOIN order_shipping_address address ON address.order_id = o.id
  LEFT JOIN inventory_reservations reservation ON reservation.id = o.reservation_id
  LEFT JOIN order_fulfillments fulfillment ON fulfillment.order_id = o.id`
const SUMMARY = `SELECT o.id, ${COMMERCIAL} AS status, o.status AS orderStatus,
  ${PAYMENT} AS paymentStatus, COALESCE(fulfillment.status, 'pending') AS fulfillmentStatus, 'unavailable' AS invoiceStatus,
  CASE WHEN reservation.status = 'assigned' THEN 'allocated'
    WHEN reservation.status = 'reserved' AND reservation.expires_at <= ?1 THEN 'expired'
    ELSE COALESCE(reservation.status, 'unavailable') END AS inventoryStatus,
  ${NAME} AS name, ${COMPANY} AS company, o.contact_email AS email,
  COALESCE(address.city, '') AS city,
  COALESCE((SELECT method FROM payment_intents p WHERE p.order_id = o.id
    ORDER BY p.created_at DESC, p.id DESC LIMIT 1), '') AS paymentMethod,
  CASE o.shipping_method_code WHEN 'pickup' THEN 'recogida' WHEN 'parcel' THEN 'envio'
    WHEN 'own_delivery' THEN 'reparto' ELSE o.shipping_method_code END AS shippingMethod,
  o.total_gross_cents AS total, o.created_at AS createdAt,
  (SELECT count(*) FROM order_lines l WHERE l.order_id = o.id) AS lines,
  NULL AS shipmentId, NULL AS trackingNumber, NULL AS shipmentStatus ${JOINS}`

export interface AdminOrderList {
  source: 'cloudflare'
  items: AdminOrderSummary[]
  pagination: { page: number; perPage: number; total: number; pages: number }
  capabilities: typeof ADMIN_ORDER_CAPABILITIES
}

/** One source of SQL predicates/projection/order for the queue and bounded exports.
 * Callers add their own bounded LIMIT, never a different filter policy. */
export function buildD1AdminOrderReadQuery(now: string, query: AdminOrderQuery) {
  const values: (string | number)[] = [now]
  const conditions: string[] = []
  const bind = (value: string | number) => {
    values.push(value)
    return `?${values.length}`
  }
  if (query.q) {
    const parameter = bind(spanishSearchTerm(query.q))
    conditions.push(`(instr(${spanishSearchSql('o.id')}, ${parameter}) > 0 OR instr(${spanishSearchSql(NAME)}, ${parameter}) > 0
      OR instr(${spanishSearchSql('o.contact_email')}, ${parameter}) > 0 OR instr(${spanishSearchSql(`COALESCE(${COMPANY}, '')`)}, ${parameter}) > 0
      OR instr(lower(COALESCE(o.buyer_tax_id, '')), ${parameter}) > 0
      OR EXISTS(SELECT 1 FROM order_billing_address billing WHERE billing.order_id=o.id
        AND instr(lower(COALESCE(billing.nif, '')), ${parameter}) > 0))`)
  }
  // Queue membership describes work outstanding, not permission/readiness to
  // execute it. The dedicated operational DTO revalidates payment, allocation,
  // warehouse and audited history before exposing any transition.
  if (query.bucket === 'por_preparar')
    conditions.push(
      `o.status <> 'cancelled' AND payment.status = 'paid' AND COALESCE(fulfillment.status, 'pending') IN ('pending','picking','packed')`
    )
  if (query.bucket === 'por_cobrar') conditions.push(`o.status <> 'cancelled' AND ${PAYMENT} = 'pending'`)
  if (query.bucket === 'incidencia')
    conditions.push(
      `(o.status = 'cancelled' OR payment.status IN ('failed','cancelled','stock_exception') OR fulfillment.status = 'exception')`
    )
  if (query.paymentStatus) conditions.push(`${PAYMENT} = ${bind(query.paymentStatus)}`)
  if (query.orderStatus) conditions.push(`o.status = ${bind(query.orderStatus)}`)
  if (query.shippingMethod) conditions.push(`o.shipping_method_code = ${bind(query.shippingMethod)}`)
  if (query.customerType) conditions.push(`${COMPANY} IS ${query.customerType === 'b2b' ? 'NOT ' : ''}NULL`)
  if (query.from) conditions.push(`o.created_at >= ${bind(`${query.from}T00:00:00Z`)}`)
  if (query.to)
    conditions.push(
      `o.created_at < ${bind(new Date(Date.parse(`${query.to}T00:00:00Z`) + 86400000).toISOString().replace(/\.\d{3}Z$/, 'Z'))}`
    )
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
  const sort = {
    id: { source: 'o.id', projected: 'id' },
    createdAt: { source: 'o.created_at', projected: 'createdAt' },
    name: { source: NAME, projected: 'name' },
    total: { source: 'o.total_gross_cents', projected: 'total' }
  }[query.sortKey]
  if (
    !sort ||
    !['asc', 'desc'].includes(query.sortDir) ||
    !Number.isSafeInteger(query.page) ||
    query.page < 1 ||
    query.page > 1000000 ||
    !Number.isSafeInteger(query.perPage) ||
    query.perPage < 1 ||
    query.perPage > 100
  )
    throw new Error('invalid_admin_order_query')
  return {
    parameters: values,
    countSql: `SELECT count(*) AS total ${JOINS} ${where || 'WHERE ?1 IS NOT NULL'}${where ? ' AND ?1 IS NOT NULL' : ''}`,
    rowsSql: `${SUMMARY} ${where} ORDER BY ${sort.source} ${query.sortDir}, o.id ${query.sortDir}`,
    projectedOrderSql: `${sort.projected} ${query.sortDir}, id ${query.sortDir}`
  }
}

export async function listD1AdminOrders(
  database: D1Database,
  claims: VerifiedSessionClaims | null,
  now: string,
  query: AdminOrderQuery
): Promise<AdminReadResult<AdminOrderList>> {
  return authorized(database, claims, now, async () => {
    const read = buildD1AdminOrderReadQuery(now, query)
    const total = await database
      .prepare(read.countSql)
      .bind(...read.parameters)
      .first<{ total: number }>()
    const items = (
      await database
        .prepare(
          `${read.rowsSql}
        LIMIT ?${read.parameters.length + 1} OFFSET ?${read.parameters.length + 2}`
        )
        .bind(...read.parameters, query.perPage, (query.page - 1) * query.perPage)
        .all<AdminOrderSummary>()
    ).results
    return {
      source: 'cloudflare',
      items,
      pagination: {
        page: query.page,
        perPage: query.perPage,
        total: total?.total ?? 0,
        pages: Math.ceil((total?.total ?? 0) / query.perPage)
      },
      capabilities: ADMIN_ORDER_CAPABILITIES
    }
  })
}

type Address = Record<string, string | null>
export interface D1AdminOrderDetail {
  source: 'cloudflare'
  capabilities: typeof ADMIN_ORDER_CAPABILITIES
  order: {
    id: string
    purchaseOrderReference?: string | null
    status: string
    orderStatus: string
    paymentStatus: string
    inventoryStatus: string
    fulfillmentStatus: string
    invoiceStatus: string
    shippingMethod: string
    paymentMethod: string
    createdAt: string
    updatedAt: string
    confirmedAt: null
    totals: { subtotalNet: number; discountNet: number | null; shippingNet: number; tax: number; total: number }
  }
  customer: {
    name: string | null
    email: string
    phone: string | null
    company: string | null
    companyStatus: string | null
    taxId: string | null
    isGuest: boolean
  }
  shippingAddress: Address | null
  billingAddress: Address | null
  lines: Array<{
    id: string
    sku: string
    name: string
    format: string
    unitLabel: string
    quantity: number
    unitNet: number
    discountNet: number | null
    taxRate: number
    tax: number
    lineGross: number
    slug: string | null
    image: string | null
    imageAlt: string | null
    visual: { type: string; color: string } | null
    returned: null
    inCatalog: boolean
  }>
  payments: Array<{
    id: string
    provider: string
    method: string
    status: string
    amount: number
    reference: string | null
    createdAt: string
    updatedAt: string
    lastEvent: string | null
    lastResponseCode: string | null
    lastEventAt: string | null
    refunded: null
  }>
  shipments: never[]
  returns: never[]
  invoices: never[]
  notes: never[]
  timeline: Array<{
    id: string
    eventType: string
    actorType: string
    origin: string
    reason: null
    createdAt: string
    fromState: null
    toState: null
  }>
  history: Array<{ id: string; total: number; status: string; createdAt: string }>
  fiscalEvaluation: { status: string; createdAt: string } | null
}

function visual(value: string | null): { type: string; color: string } | null {
  try {
    const parsed: unknown = value ? JSON.parse(value) : null
    if (
      parsed &&
      typeof parsed === 'object' &&
      'type' in parsed &&
      'color' in parsed &&
      typeof parsed.type === 'string' &&
      typeof parsed.color === 'string'
    )
      return { type: parsed.type, color: parsed.color }
  } catch {
    /* Ignore malformed optional catalog decorations. */
  }
  return null
}

export async function readD1AdminOrder(
  database: D1Database,
  claims: VerifiedSessionClaims | null,
  now: string,
  orderId: string
): Promise<AdminReadResult<D1AdminOrderDetail>> {
  return authorized(database, claims, now, async () => {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(orderId)) return null
    const row = await database
      .prepare(
        `${SUMMARY.replace(
          'SELECT o.id,',
          `SELECT o.customer_id AS customerId,
      o.contact_phone AS contactPhone, o.buyer_tax_id AS taxId, o.updated_at AS updatedAt,
      o.total_net_cents - o.shipping_net_cents AS subtotalNet, o.total_tax_cents AS tax,
      o.shipping_net_cents AS shippingNet, o.id,`
        )} WHERE o.id = ?2`
      )
      .bind(now, orderId)
      .first<
        AdminOrderSummary & {
          customerId: string | null
          contactPhone: string | null
          taxId: string | null
          updatedAt: string
          subtotalNet: number
          shippingNet: number
          tax: number
        }
      >()
    if (!row) return null
    const [shippingAddress, billingAddress, company, lineRows, payments, timeline, history, fiscalEvaluation] =
      await Promise.all([
        database
          .prepare(
            `SELECT recipient_name AS recipientName, company_name AS companyName, tax_id AS taxId,
        line1, line2, city, province AS region, postal_code AS postalCode, country_code AS countryCode,
        phone, instructions FROM order_shipping_address WHERE order_id = ?1`
          )
          .bind(orderId)
          .first<Address>(),
        database
          .prepare(
            `SELECT recipient_name AS recipientName, company_name AS companyName, nif AS taxId,
        line1, line2, city, province AS region, postal_code AS postalCode, country_code AS countryCode,
        instructions FROM order_billing_address WHERE order_id = ?1`
          )
          .bind(orderId)
          .first<Address>(),
        database
          // The current profile is not the order's company snapshot. Only show
          // its review state if it still identifies the same contractual buyer.
          .prepare('SELECT status FROM companies WHERE customer_id = ?1 AND legal_name = ?2 AND tax_id = ?3')
          .bind(row.customerId, row.company, row.taxId)
          .first<{ status: string }>(),
        database
          .prepare(
            `SELECT l.order_id || ':' || l.line_index AS id, l.sku, l.name,
        l.variant_id AS variantUuid, p.id AS productUuid, v.sku AS currentSku,
        COALESCE(q.format, '') AS format, COALESCE(q.unit_label, '') AS unitLabel, l.quantity,
        l.unit_gross_cents AS unitGross, l.net_cents AS lineNet, l.tax_rate_basis_points AS taxRate, l.tax_cents AS tax, l.gross_cents AS lineGross,
        CASE WHEN v.status = 'published' AND p.status = 'published' AND category.status = 'published' THEN p.slug ELSE NULL END AS slug,
        CASE WHEN v.status = 'published' AND p.status = 'published' AND category.status = 'published' THEN json_extract(p.attributes, '$.visual') ELSE NULL END AS visual,
        (v.status = 'published' AND p.status = 'published' AND category.status = 'published') AS inCatalog
        FROM order_lines l JOIN orders o ON o.id = l.order_id
        LEFT JOIN checkout_quote_lines q ON q.quote_id = o.quote_id AND q.line_index = l.line_index
        LEFT JOIN variants v ON v.id = l.variant_id LEFT JOIN products p ON p.id = v.product_id
        LEFT JOIN categories category ON category.id = p.category_id
        WHERE l.order_id = ?1 ORDER BY l.line_index`
          )
          .bind(orderId)
          .all<{
            id: string
            sku: string
            currentSku: string | null
            variantUuid: string
            productUuid: string | null
            name: string
            format: string
            unitLabel: string
            quantity: number
            unitGross: number
            lineNet: number
            taxRate: number
            tax: number
            lineGross: number
            slug: string | null
            visual: string | null
            inCatalog: number | null
          }>(),
        database
          .prepare(
            `SELECT p.id, p.provider, p.method, p.status, p.amount_gross_cents AS amount,
        p.provider_reference AS reference, p.created_at AS createdAt, p.updated_at AS updatedAt,
        (SELECT e.event_type FROM payment_events e WHERE e.payment_intent_id = p.id ORDER BY e.created_at DESC, e.id DESC LIMIT 1) AS lastEvent,
        COALESCE((SELECT e.response_code FROM payment_events e WHERE e.payment_intent_id = p.id ORDER BY e.created_at DESC, e.id DESC LIMIT 1), p.response_code) AS lastResponseCode,
        (SELECT e.created_at FROM payment_events e WHERE e.payment_intent_id = p.id ORDER BY e.created_at DESC, e.id DESC LIMIT 1) AS lastEventAt
        FROM payment_intents p WHERE p.order_id = ?1 ORDER BY p.created_at DESC, p.id DESC`
          )
          .bind(orderId)
          .all<Omit<D1AdminOrderDetail['payments'][number], 'refunded'>>(),
        // Do NOT select payload_json, hashes or correlation/credential identifiers.
        database
          .prepare(
            `SELECT id, event_type AS eventType, 'system' AS actorType, 'D1' AS origin,
        created_at AS createdAt, NULL AS reason, NULL AS fromState, NULL AS toState
        FROM order_events WHERE order_id = ?1
        UNION ALL SELECT id, event_type AS eventType, 'provider' AS actorType, 'redsys' AS origin,
        created_at AS createdAt, NULL AS reason, NULL AS fromState, NULL AS toState
        FROM payment_events WHERE order_id = ?1 ORDER BY createdAt DESC, id DESC LIMIT 100`
          )
          .bind(orderId)
          .all<D1AdminOrderDetail['timeline'][number]>(),
        database
          .prepare(
            `SELECT o.id, o.total_gross_cents AS total, ${COMMERCIAL} AS status, o.created_at AS createdAt
        FROM orders o LEFT JOIN order_payment_states payment ON payment.order_id = o.id
        WHERE o.customer_id = ?1 AND o.id <> ?2 ORDER BY o.created_at DESC, o.id DESC LIMIT 5`
          )
          .bind(row.customerId, orderId)
          .all<D1AdminOrderDetail['history'][number]>(),
        database
          .prepare(
            `SELECT delivery.status, e.created_at AS createdAt FROM fiscal_outbox_events e
        JOIN fiscal_outbox_delivery delivery ON delivery.event_id = e.id WHERE e.order_id = ?1`
          )
          .bind(orderId)
          .first<{ status: string; createdAt: string }>()
      ])
    // Keep enrichment inside authorized(): its final live MFA/grant/session gate
    // must also cover this additional read before any private detail is released.
    const publishedMedia = await readPublicProductMedia(
      database,
      lineRows.results.flatMap((line) => (line.productUuid ? [line.productUuid] : []))
    )
    const netDiscount = (line: (typeof lineRows.results)[number]) =>
      splitGross(line.unitGross * line.quantity, line.taxRate).netCents - line.lineNet
    const discountNet = lineRows.results.reduce((sum, line) => sum + netDiscount(line), 0)
    const purchaseOrderReference = await readOrderPurchaseOrderReference(database, orderId)
    return {
      source: 'cloudflare',
      capabilities: ADMIN_ORDER_CAPABILITIES,
      order: {
        id: row.id,
        purchaseOrderReference,
        status: row.status,
        orderStatus: row.orderStatus,
        paymentStatus: row.paymentStatus,
        fulfillmentStatus: row.fulfillmentStatus,
        inventoryStatus: row.inventoryStatus,
        invoiceStatus: row.invoiceStatus,
        shippingMethod: row.shippingMethod,
        paymentMethod: row.paymentMethod,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        confirmedAt: null,
        totals: {
          subtotalNet: row.subtotalNet + discountNet,
          discountNet: discountNet || null,
          shippingNet: row.shippingNet,
          tax: row.tax,
          total: row.total
        }
      },
      customer: {
        name: row.name || null,
        email: row.email,
        phone: row.contactPhone ?? shippingAddress?.phone ?? null,
        company: row.company,
        companyStatus: company?.status ?? null,
        taxId: row.taxId ?? billingAddress?.taxId ?? null,
        isGuest: row.customerId === null
      },
      shippingAddress,
      billingAddress,
      lines: lineRows.results.map(({ lineNet, unitGross, productUuid, variantUuid, currentSku, ...line }) => {
        const photo =
          currentSku === line.sku && productUuid
            ? publishedMedia.get(productUuid)?.variants.get(variantUuid)
            : undefined
        return {
          ...line,
          image: photo?.image ?? null,
          imageAlt: photo?.imageAlt ?? null,
          unitNet: splitGross(unitGross * line.quantity, line.taxRate).netCents / line.quantity,
          discountNet: splitGross(unitGross * line.quantity, line.taxRate).netCents - lineNet || null,
          returned: null,
          inCatalog: !!line.inCatalog,
          visual: visual(line.visual)
        }
      }),
      payments: payments.results.map((payment) => ({ ...payment, refunded: null })),
      shipments: [],
      returns: [],
      invoices: [],
      notes: [],
      timeline: timeline.results,
      history: history.results,
      fiscalEvaluation
    }
  })
}

export interface D1AdminStats extends AdminStats {
  source: 'cloudflare'
  awaitingPayment: number
  paidOrders: number
  readyToShip: null
  capabilities: typeof ADMIN_ORDER_CAPABILITIES
}

export async function readD1AdminStats(
  database: D1Database,
  claims: VerifiedSessionClaims | null,
  now: string
): Promise<AdminReadResult<D1AdminStats>> {
  return authorized(database, claims, now, async () => {
    const stats = await database
      .prepare(
        `SELECT
      (SELECT count(*) FROM products) AS products, (SELECT count(*) FROM variants) AS variants,
      (SELECT count(*) FROM categories) AS categories, (SELECT count(*) FROM identities) AS users,
      (SELECT count(*) FROM orders) AS orders, (SELECT count(*) FROM orders WHERE status <> 'cancelled') AS openOrders,
      (SELECT count(*) FROM orders o LEFT JOIN order_payment_states p ON p.order_id = o.id
        WHERE o.status <> 'cancelled' AND COALESCE(p.status, 'awaiting_payment') = 'awaiting_payment') AS awaitingPayment,
      (SELECT count(*) FROM orders o JOIN order_payment_states p ON p.order_id = o.id
        WHERE o.status <> 'cancelled' AND p.status = 'paid') AS paidOrders`
      )
      .first<AdminStats & { awaitingPayment: number; paidOrders: number }>()
    if (!stats) throw new Error('admin_stats_missing')
    return { ...stats, source: 'cloudflare', readyToShip: null, capabilities: ADMIN_ORDER_CAPABILITIES }
  })
}

export async function readD1AdminOperations(database: D1Database, claims: VerifiedSessionClaims | null, now: string) {
  return authorized(database, claims, now, async (instant) => {
    const summary = await database
      .prepare(
        `WITH ${inventoryPositionCtes()} SELECT
      ((SELECT count(*) FROM fiscal_outbox_delivery WHERE status IN ('ready','leased')) +
       (SELECT count(*) FROM email_outbox_delivery WHERE status IN ('ready','leased')) +
       (SELECT count(*) FROM payment_recovery_jobs WHERE status = 'pending')) AS queueDepth,
      (SELECT count(*) FROM (
        SELECT event_id FROM fiscal_outbox_delivery WHERE status IN ('blocked_policy','manual_review')
        UNION SELECT event_id FROM fiscal_evaluation_inbox WHERE status = 'blocked_policy'
      )) AS fiscalExceptions,
      (SELECT available FROM inventory_scope) AS inventoryAvailable,
      (SELECT count(*) FROM inventory_flags WHERE ledger_divergent = 1 OR availability_deficit = 1)
        AS inventoryAffectedBalances,
      (SELECT count(*) FROM inventory_flags WHERE ledger_divergent = 1) AS inventoryLedgerDivergences,
      (SELECT count(*) FROM inventory_flags WHERE availability_deficit = 1) AS inventoryAvailabilityDeficits,
      (SELECT count(*) FROM inventory_flags WHERE backorder_commitment = 1) AS inventoryBackorderCommitments,
      (SELECT count(*) FROM inventory_reservations WHERE status = 'reserved' AND expires_at <= ?1)
        AS inventoryReservationExpiryPending,
      (SELECT count(*) FROM order_payment_states WHERE status = 'stock_exception') AS inventoryStockExceptionOrders,
      (SELECT count(*) FROM email_outbox_delivery WHERE status = 'manual_review') AS emailDeliveryExceptions,
      (SELECT count(*) FROM support_tickets
        WHERE state IN ('open','waiting_customer','waiting_provider') AND sla_due_at < ?1) AS supportOverdue,
      (SELECT count(*) FROM support_tickets
        WHERE state IN ('open','waiting_customer','waiting_provider') AND next_action_at < ?1) AS supportNextActionOverdue`
      )
      .bind(instant)
      .first<{
        queueDepth: number
        fiscalExceptions: number
        inventoryAvailable: number
        inventoryAffectedBalances: number
        inventoryLedgerDivergences: number
        inventoryAvailabilityDeficits: number
        inventoryBackorderCommitments: number
        inventoryReservationExpiryPending: number
        inventoryStockExceptionOrders: number
        emailDeliveryExceptions: number
        supportOverdue: number
        supportNextActionOverdue: number
      }>()
    if (!summary) throw new Error('admin_operations_missing')
    const { inventoryAvailable, inventoryAffectedBalances, ...counters } = summary
    const available = inventoryAvailable === 1
    // Counts cover the complete snapshot, not a visible page. A balance with
    // multiple causes counts once. A missing balance with active commitments
    // is an orphan reservation target, but retired net-zero history alone is
    // not a fabricated physical balance/drift. TTL pending and allowed backorders
    // remain separate operational facts, not invented stock failures. No private
    // references, free-text reasons or actors are projected.
    return {
      source: 'cloudflare' as const,
      generatedAt: instant,
      summary: {
        ...counters,
        inventoryExceptions: available ? inventoryAffectedBalances + counters.inventoryStockExceptionOrders : null,
        inventoryLedgerDivergences: available ? counters.inventoryLedgerDivergences : null,
        inventoryAvailabilityDeficits: available ? counters.inventoryAvailabilityDeficits : null,
        inventoryBackorderCommitments: available ? counters.inventoryBackorderCommitments : null,
        inventoryReservationExpiryPending: available ? counters.inventoryReservationExpiryPending : null,
        deadLetters: null,
        staleRefunds: null,
        staleShipments: null,
        communicationFailures: null,
        bankTransfersPendingReview: null
      },
      capabilities: {
        queueDepth: true,
        fiscalExceptions: true,
        inventoryExceptions: available,
        inventoryLedgerDivergences: available,
        inventoryAvailabilityDeficits: available,
        inventoryBackorderCommitments: available,
        inventoryReservationExpiryPending: available,
        inventoryStockExceptionOrders: true,
        emailDeliveryExceptions: true,
        deadLetters: false,
        supportOverdue: true,
        supportNextActionOverdue: true,
        staleRefunds: false,
        staleShipments: false,
        communicationFailures: false,
        bankTransfersPendingReview: false
      },
      queues: [],
      deadLetters: [],
      bankTransfers: []
    }
  })
}

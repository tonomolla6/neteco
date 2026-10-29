import type { VerifiedSessionClaims } from './authorization'
import { readPublicProductMedia } from '../media/public-catalog'
import { fulfillmentActionSchema, type FulfillmentAction } from '../../shared/order-fulfillment'
import { orderReorderOfferSchema, type OrderReorderOffer } from '../../shared/order-reorder'
import { MAX_CART_QUANTITY } from '../../shared/cart-limits'
import { selectVolumeUnitPrice, splitGross, validateQuantity } from '../../server/domain/money'
import { effectiveGovernedVersionIdExpression, PRICE_INSTANT_TOKEN } from './pricing'
import { publicationValidityExpression } from './publication-validity'
import { sellableExpression } from './inventory'
import { parseVolumeTiers } from './volume-pricing'

// Same confirmed-history proof as fulfillment/admin.ts: the last immutable
// command, its matching audit and the full version counts confirm a projection.
// Only its public state is selected; operational evidence never leaves SQL.
const fulfillmentAuditColumns =
  'actor_id,order_id,location_id,action,input,expected_version,result_version,from_state,to_state,interrupted_state,reason,evidence,source_snapshot,response,created_at'
const fulfillmentAuditMatch = fulfillmentAuditColumns
  .split(',')
  .map((column) => `audit.${column} IS command.${column}`)
  .join(' AND ')
export function customerFulfillmentSql(orderIdSql: string, customerIdSql: string, clockSql: string) {
  return `(SELECT fulfillment.status FROM order_fulfillments fulfillment
  JOIN orders owned ON owned.id=fulfillment.order_id AND owned.customer_id IS ${customerIdSql}
  JOIN order_fulfillment_commands command ON command.id=fulfillment.last_command_id
    AND command.order_id=fulfillment.order_id AND command.location_id=fulfillment.location_id
    AND command.result_version=fulfillment.version AND command.to_state=fulfillment.status
    AND command.interrupted_state IS fulfillment.interrupted_state AND command.created_at=fulfillment.updated_at
  WHERE fulfillment.order_id=${orderIdSql} AND fulfillment.updated_at<=${clockSql}
    AND fulfillment.location_id=(SELECT location_id FROM order_lines WHERE order_id=owned.id ORDER BY line_index LIMIT 1)
    AND EXISTS(SELECT 1 FROM order_fulfillment_audit audit WHERE audit.command_id=command.id AND ${fulfillmentAuditMatch})
    AND (SELECT count(*) FROM order_fulfillment_commands WHERE order_id=owned.id)=fulfillment.version
    AND (SELECT count(*) FROM order_fulfillment_audit WHERE order_id=owned.id)=fulfillment.version)`
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function validClaims(claims: VerifiedSessionClaims | null): claims is VerifiedSessionClaims {
  return (
    !!claims &&
    UUID.test(claims.identityId) &&
    UUID.test(claims.sessionId) &&
    Number.isSafeInteger(claims.sessionVersion) &&
    claims.sessionVersion > 0
  )
}

function validInstant(now: string): boolean {
  const parsed = Date.parse(now)
  return (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(now) &&
    Number.isFinite(parsed) &&
    new Date(parsed).toISOString().replace(/\.\d{3}Z$/, 'Z') === now
  )
}

/** The cookie is verified at the HTTP boundary. This check then reads live D1
 * session/identity/customer state; an email address is never an owner proof.
 */
export async function activeOrderCustomerId(
  database: D1Database,
  claims: VerifiedSessionClaims | null,
  now: string
): Promise<string | null> {
  return (await activeOrderCustomerRow(database, claims, now))?.id ?? null
}
async function activeOrderCustomerRow(
  database: D1Database,
  claims: VerifiedSessionClaims | null,
  now: string,
  orderId?: string
): Promise<{ id: string; fulfillmentStatus?: unknown; reorderRows?: ReorderRow[] } | null> {
  if (!validInstant(now)) throw new Error('invalid_customer_order_instant')
  if (!validClaims(claims)) return null
  if (orderId !== undefined) return readCurrentOrderCustomerOffers(database, claims, orderId, now)
  const row = await database
    .prepare(
      `SELECT c.id${orderId === undefined ? '' : `,${customerFulfillmentSql('?5', 'c.id', '?4')} AS fulfillmentStatus`} FROM auth_sessions s
     JOIN identities i ON i.id = s.identity_id
     JOIN customers c ON c.id = i.customer_id AND c.status = 'active'
     WHERE s.id = ?1 AND s.identity_id = ?2 AND s.session_version = ?3
       AND i.session_version = s.session_version AND i.status = 'active'
       AND i.email_verified_at IS NOT NULL AND i.email_verified_at <= ?4
       AND s.revoked_at IS NULL AND s.created_at <= ?4 AND s.expires_at > ?4`
    )
    .bind(claims.sessionId, claims.identityId, claims.sessionVersion, now, ...(orderId === undefined ? [] : [orderId]))
    .first<{ id: string; fulfillmentStatus?: unknown }>()
  return row
}

interface ReorderRow {
  lineIndex: number | null
  historicalSku: string
  currentSku: string | null
  quantity: number
  variantId: number | null
  productUuid: string | null
  currentSlug: string | null
  currentVisual: string | null
  variantStatus: string | null
  productStatus: string | null
  categoryStatus: string | null
  publicationValid: number | null
  unitGrossCents: number
  volumeTiersJson: string
  pricingVersion: string
  taxRateBasisPoints: number
  minimumQuantity: number
  maximumQuantity: number | null
  quantityIncrement: number
  availableQuantity: number
  activeLocations: number
  backorderAllowed: number
  evaluatedAt: string
}

/** The last await returns owner proof AND the entire current offer snapshot.
 * Materialization bounds SQL expression height and prevents N+1 per line. */
async function readCurrentOrderCustomerOffers(
  database: D1Database,
  claims: VerifiedSessionClaims,
  orderId: string,
  now: string
) {
  const selectedPrice = effectiveGovernedVersionIdExpression('v').replaceAll(
    PRICE_INSTANT_TOKEN,
    '(SELECT milliseconds FROM gate_clock)'
  )
  const rows = (
    await database
      .prepare(
        `WITH gate_clock AS MATERIALIZED (
      SELECT strftime('%Y-%m-%dT%H:%M:%SZ','now') AS now, strftime('%Y-%m-%dT%H:%M:%fZ','now') AS milliseconds
    ), current_owner AS MATERIALIZED (
      SELECT c.id,${customerFulfillmentSql('?5', 'c.id', '(SELECT now FROM gate_clock)')} AS fulfillmentStatus
      FROM auth_sessions s JOIN identities i ON i.id=s.identity_id
      JOIN customers c ON c.id=i.customer_id AND c.status='active'
      WHERE s.id=?1 AND s.identity_id=?2 AND s.session_version=?3
        AND i.session_version=s.session_version AND i.status='active'
        AND i.email_verified_at IS NOT NULL AND i.email_verified_at<=(SELECT now FROM gate_clock)
        AND s.revoked_at IS NULL AND s.created_at<=(SELECT now FROM gate_clock) AND s.expires_at>(SELECT now FROM gate_clock)
    ), reorder_source AS MATERIALIZED (
      SELECT line.line_index AS lineIndex,line.sku AS historicalSku,v.sku AS currentSku,line.quantity,
        v.legacy_id AS variantId,p.id AS productUuid,p.slug AS currentSlug,json_extract(p.attributes,'$.visual') AS currentVisual,
        v.status AS variantStatus,p.status AS productStatus,category.status AS categoryStatus,
        ${publicationValidityExpression('p', '(SELECT now FROM gate_clock)')} AS publicationValid,
        COALESCE(price.gross_cents,v.price_gross_cents) AS unitGrossCents,COALESCE(price.volume_tiers,'[]') AS volumeTiersJson,
        COALESCE(price.id,'legacy:'||v.id) AS pricingVersion,t.rate_basis_points AS taxRateBasisPoints,
        v.minimum_quantity AS minimumQuantity,v.maximum_quantity AS maximumQuantity,v.quantity_increment AS quantityIncrement,
        COALESCE((SELECT max(${sellableExpression()}) FROM inventory_balances b
          JOIN inventory_locations location ON location.id=b.location_id AND location.active=1 WHERE b.variant_id=v.id),0) AS availableQuantity,
        (SELECT count(*) FROM inventory_balances b JOIN inventory_locations location ON location.id=b.location_id AND location.active=1
          WHERE b.variant_id=v.id) AS activeLocations,v.backorder_allowed AS backorderAllowed,(SELECT now FROM gate_clock) AS evaluatedAt
      FROM current_owner owner JOIN orders o ON o.customer_id=owner.id JOIN order_lines line ON line.order_id=o.id
      LEFT JOIN variants v ON v.id=line.variant_id LEFT JOIN products p ON p.id=v.product_id
      LEFT JOIN categories category ON category.id=p.category_id LEFT JOIN tax_classes t ON t.id=v.tax_class_id
      LEFT JOIN variant_price_versions price ON price.id=${selectedPrice} AND price.variant_id=v.id
      WHERE o.id=?5
    ) SELECT owner.id,owner.fulfillmentStatus,offer.* FROM current_owner owner LEFT JOIN reorder_source offer ON 1=1 ORDER BY offer.lineIndex`
      )
      .bind(claims.sessionId, claims.identityId, claims.sessionVersion, now, orderId)
      .all<ReorderRow & { id: string; fulfillmentStatus: unknown }>()
  ).results
  if (!rows[0]) return null
  return {
    id: rows[0].id,
    fulfillmentStatus: rows[0].fulfillmentStatus,
    reorderRows: rows.filter((row) => row.lineIndex !== null)
  }
}

function reorderOffer(row: ReorderRow | undefined): OrderReorderOffer | null {
  if (
    !row ||
    row.variantStatus !== 'published' ||
    row.productStatus !== 'published' ||
    row.categoryStatus !== 'published' ||
    row.publicationValid !== 1 ||
    row.currentSku !== row.historicalSku ||
    !Number.isSafeInteger(row.variantId) ||
    Number(row.variantId) <= 0
  )
    return null
  let quantityAllowed = row.quantity <= MAX_CART_QUANTITY
  try {
    validateQuantity(row.quantity, row)
  } catch {
    quantityAllowed = false
  }
  const unitGross = selectVolumeUnitPrice(
    row.unitGrossCents,
    row.quantity,
    parseVolumeTiers(row.volumeTiersJson, row.unitGrossCents)
  )
  const lineGross = unitGross * row.quantity
  if (unitGross <= 0 || lineGross <= 0) return null
  const stockSufficient =
    row.activeLocations > 0 && (row.backorderAllowed === 1 || row.availableQuantity >= row.quantity)
  return orderReorderOfferSchema.parse({
    evaluatedAt: row.evaluatedAt,
    unitGross,
    lineGross,
    unitNet: splitGross(unitGross, row.taxRateBasisPoints).netCents,
    lineNet: splitGross(lineGross, row.taxRateBasisPoints).netCents,
    taxRateBasisPoints: row.taxRateBasisPoints,
    pricingVersion: row.pricingVersion,
    minimumQuantity: row.minimumQuantity,
    maximumQuantity: row.maximumQuantity,
    quantityIncrement: row.quantityIncrement,
    availableQuantity: row.availableQuantity,
    backorderAllowed: row.backorderAllowed === 1,
    quantityAllowed,
    stockSufficient,
    purchasable: quantityAllowed && stockSufficient
  })
}

export interface CustomerOrderSummary {
  id: string
  status: string
  total: number
  createdAt: string
  lines: number
  invoiceAvailable: false
  fullDetailAvailable: true
}

function publicStatus(
  orderStatus: string,
  paymentStatus: string | null,
  fulfillmentStatus: FulfillmentAction | null
): string {
  if (orderStatus === 'cancelled') return 'cancelado'
  if (paymentStatus === 'paid') {
    if (fulfillmentStatus === 'picking' || fulfillmentStatus === 'packed') return 'preparando'
    if (fulfillmentStatus === 'ready_for_pickup') return 'listo_recogida'
    if (fulfillmentStatus === 'in_transit') return 'enviado'
    if (fulfillmentStatus === 'delivered') return 'entregado'
    return 'pagado'
  }
  if (paymentStatus === 'stock_exception') return 'incidencia_stock'
  if (paymentStatus === 'failed' || paymentStatus === 'cancelled') return 'pago_fallido'
  if (paymentStatus === 'processing' || paymentStatus === 'provider_authorised') return 'procesando_pago'
  return 'pendiente_pago'
}

function publicShippingMethod(method: string): string {
  if (method === 'pickup') return 'recogida'
  if (method === 'own_delivery') return 'reparto'
  if (method === 'parcel') return 'envio'
  return method
}

/** Returns null for no valid active customer session, not an empty order list. */
export async function listD1CustomerOrders(
  database: D1Database,
  claims: VerifiedSessionClaims | null,
  now: string
): Promise<{ orders: CustomerOrderSummary[] } | null> {
  const customerId = await activeOrderCustomerId(database, claims, now)
  if (!customerId || !claims) return null
  const rows = (
    await database
      .prepare(
        `SELECT o.id, o.status, o.total_gross_cents AS total, o.created_at AS createdAt,
       (SELECT count(*) FROM order_lines l WHERE l.order_id = o.id) AS lines,
       payment.status AS paymentStatus,${customerFulfillmentSql('o.id', 'o.customer_id', '?5')} AS fulfillmentStatus
     FROM orders o LEFT JOIN order_payment_states payment ON payment.order_id = o.id
     WHERE o.customer_id = ?1
       AND EXISTS (
         SELECT 1 FROM auth_sessions s JOIN identities i ON i.id = s.identity_id
         JOIN customers c ON c.id = i.customer_id AND c.status = 'active'
         WHERE s.id = ?2 AND s.identity_id = ?3 AND s.session_version = ?4
           AND i.session_version = s.session_version AND i.status = 'active'
           AND i.email_verified_at IS NOT NULL AND i.email_verified_at <= ?5
           AND s.revoked_at IS NULL AND s.created_at <= ?5 AND s.expires_at > ?5
           AND c.id = o.customer_id
       )
     ORDER BY o.created_at DESC, o.id DESC LIMIT 200`
      )
      .bind(customerId, claims.sessionId, claims.identityId, claims.sessionVersion, now)
      .all<{
        id: string
        status: string
        total: number
        createdAt: string
        lines: number
        paymentStatus: string | null
        fulfillmentStatus: unknown
      }>()
  ).results
  return {
    orders: rows.map((row) => ({
      id: row.id,
      status: publicStatus(
        row.status,
        row.paymentStatus,
        fulfillmentActionSchema.nullable().parse(row.fulfillmentStatus)
      ),
      total: row.total,
      createdAt: row.createdAt,
      lines: row.lines,
      invoiceAvailable: false,
      fullDetailAvailable: true
    }))
  }
}

export interface CustomerOrderLine {
  sku: string
  name: string
  format: string
  quantity: number
  unitGross: number
  lineGross: number
  variantId: number | null
  slug: string | null
  image: string | null
  imageAlt: string | null
  visual: { type: string; color: string } | null
  available: boolean
  reason: string | null
  reorderOffer?: OrderReorderOffer | null
}

export interface CustomerOrderDetail {
  orderId: string
  orderedAt: string
  shippingMethod: string
  paymentMethod: string | null
  /** Last confirmed operational state; absence never invents pending work. */
  fulfillmentStatus: FulfillmentAction | null
  destination: { line1: null; postalCode: string; city: string } | null
  totals: { subtotalNet: number; shippingNet: number; tax: number; total: number }
  shipment: null
  lines: CustomerOrderLine[]
}

function parseVisual(value: string | null): CustomerOrderLine['visual'] {
  if (!value) return null
  try {
    const parsed: unknown = JSON.parse(value)
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
    /* A malformed catalog decoration must not block the contractual order. */
  }
  return null
}

export type CustomerOrderDetailResult =
  { outcome: 'unauthenticated' } | { outcome: 'not_found' } | { outcome: 'found'; detail: CustomerOrderDetail }

/** Other customers' ids and unknown ids are deliberately indistinguishable. */
export async function readD1CustomerOrderLines(
  database: D1Database,
  claims: VerifiedSessionClaims | null,
  orderId: string,
  now: string
): Promise<CustomerOrderDetailResult> {
  const started = Date.now()
  const customerId = await activeOrderCustomerId(database, claims, now)
  if (!customerId || !claims) return { outcome: 'unauthenticated' }
  if (!UUID.test(orderId)) return { outcome: 'not_found' }
  const order = await database
    .prepare(
      `SELECT o.id, o.created_at AS orderedAt, o.shipping_method_code AS shippingMethod,
       o.total_net_cents - o.shipping_net_cents AS subtotalNet,
       o.shipping_net_cents AS shippingNet, o.total_tax_cents AS tax,
       o.total_gross_cents AS total, address.city, address.postal_code AS postalCode,
       (SELECT method FROM payment_intents p WHERE p.order_id = o.id
        ORDER BY p.created_at DESC, p.id DESC LIMIT 1) AS paymentMethod
     FROM orders o LEFT JOIN order_shipping_address address ON address.order_id = o.id
     WHERE o.id = ?1 AND o.customer_id = ?2
       AND EXISTS (
         SELECT 1 FROM auth_sessions s JOIN identities i ON i.id = s.identity_id
         JOIN customers c ON c.id = i.customer_id AND c.status = 'active'
         WHERE s.id = ?3 AND s.identity_id = ?4 AND s.session_version = ?5
           AND i.session_version = s.session_version AND i.status = 'active'
           AND i.email_verified_at IS NOT NULL AND i.email_verified_at <= ?6
           AND s.revoked_at IS NULL AND s.created_at <= ?6 AND s.expires_at > ?6
           AND c.id = o.customer_id
       )`
    )
    .bind(orderId, customerId, claims.sessionId, claims.identityId, claims.sessionVersion, now)
    .first<{
      id: string
      orderedAt: string
      shippingMethod: string
      subtotalNet: number
      shippingNet: number
      tax: number
      total: number
      city: string | null
      postalCode: string | null
      paymentMethod: string | null
    }>()
  if (!order) return { outcome: 'not_found' }
  const rows = (
    await database
      .prepare(
        `SELECT line.line_index AS lineIndex,line.sku, line.name, COALESCE(quote.format, '') AS format,
       line.variant_id AS variantUuid, product.id AS productUuid, variant.sku AS currentSku,
       line.quantity, line.unit_gross_cents AS unitGross, line.gross_cents AS lineGross,
       CASE WHEN variant.status = 'published' AND product.status = 'published'
         THEN variant.legacy_id ELSE NULL END AS variantId,
       CASE WHEN variant.status = 'published' AND product.status = 'published'
         THEN product.slug ELSE NULL END AS slug,
       CASE WHEN variant.status = 'published' AND product.status = 'published'
         THEN json_extract(product.attributes, '$.visual') ELSE NULL END AS visual
     FROM order_lines line JOIN orders o ON o.id = line.order_id
     LEFT JOIN checkout_quote_lines quote ON quote.quote_id = o.quote_id AND quote.line_index = line.line_index
     LEFT JOIN variants variant ON variant.id = line.variant_id
     LEFT JOIN products product ON product.id = variant.product_id
     WHERE line.order_id = ?1 AND o.customer_id = ?2
       AND EXISTS (
         SELECT 1 FROM auth_sessions s JOIN identities i ON i.id = s.identity_id
         JOIN customers c ON c.id = i.customer_id AND c.status = 'active'
         WHERE s.id = ?3 AND s.identity_id = ?4 AND s.session_version = ?5
           AND i.session_version = s.session_version AND i.status = 'active'
           AND i.email_verified_at IS NOT NULL AND i.email_verified_at <= ?6
           AND s.revoked_at IS NULL AND s.created_at <= ?6 AND s.expires_at > ?6
           AND c.id = o.customer_id
       )
     ORDER BY line.line_index`
      )
      .bind(orderId, customerId, claims.sessionId, claims.identityId, claims.sessionVersion, now)
      .all<{
        lineIndex: number
        sku: string
        currentSku: string | null
        variantUuid: string
        productUuid: string | null
        name: string
        format: string
        quantity: number
        unitGross: number
        lineGross: number
        variantId: number | null
        slug: string | null
        visual: string | null
      }>()
  ).results
  const publishedMedia = await readPublicProductMedia(
    database,
    rows.flatMap((row) => (row.productUuid ? [row.productUuid] : []))
  )
  // Preserve the private owner gate after the additional asynchronous read.
  // Rebinding an identity to another customer cannot release this old order.
  const authorizationInstant = new Date(Date.parse(now) + Math.max(0, Date.now() - started))
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z')
  const current = await activeOrderCustomerRow(database, claims, authorizationInstant, orderId)
  if (current?.id !== customerId) return { outcome: 'unauthenticated' }
  const fulfillmentStatus = fulfillmentActionSchema.nullable().parse(current.fulfillmentStatus)
  const currentRows = new Map(current.reorderRows?.map((row) => [row.lineIndex, row]))
  return {
    outcome: 'found',
    detail: {
      orderId: order.id,
      orderedAt: order.orderedAt,
      shippingMethod: publicShippingMethod(order.shippingMethod),
      paymentMethod: order.paymentMethod,
      fulfillmentStatus,
      destination:
        order.city && order.postalCode ? { line1: null, postalCode: order.postalCode, city: order.city } : null,
      totals: { subtotalNet: order.subtotalNet, shippingNet: order.shippingNet, tax: order.tax, total: order.total },
      shipment: null,
      lines: rows.map((row) => {
        const currentRow = currentRows.get(row.lineIndex)
        const offer = reorderOffer(currentRow)
        const available = offer !== null
        const photo =
          available && row.currentSku === row.sku && row.productUuid && currentRow?.productUuid === row.productUuid
            ? publishedMedia.get(row.productUuid)?.variants.get(row.variantUuid)
            : undefined
        return {
          sku: row.sku,
          name: row.name,
          format: row.format,
          quantity: row.quantity,
          unitGross: row.unitGross,
          lineGross: row.lineGross,
          variantId: available ? (currentRow?.variantId ?? null) : null,
          slug: available ? (currentRow?.currentSlug ?? null) : null,
          image: photo?.image ?? null,
          imageAlt: photo?.imageAlt ?? null,
          visual: available ? parseVisual(currentRow?.currentVisual ?? null) : null,
          available,
          reason: available ? null : 'No disponible ahora mismo',
          reorderOffer: offer
        }
      })
    }
  }
}

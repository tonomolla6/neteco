import { useDatabase } from '../../../../db/client'
import { requireAdmin } from '../../../../utils/admin'
import { publicOrderStatus } from '../../../../utils/order-status'

/**
 * Ficha completa de un pedido para el panel. Solo lectura.
 *
 * Hasta ahora el panel no tenía detalle: desde el listado se saltaba a la ficha
 * pública del cliente, que oculta a propósito casi todo lo que necesita quien
 * atiende el teléfono —el intento de pago y su código de respuesta, los eventos
 * del transportista, las notas internas, la traza de cambios de estado—. Quien
 * gestiona pedidos acababa consultando la base de datos a mano.
 *
 * Devuelve de una sola vez las siete cosas que se miran juntas al resolver una
 * incidencia. Son consultas pequeñas sobre un único pedido, así que agruparlas
 * en una respuesta evita siete idas y vueltas y, sobre todo, evita que la
 * pantalla se pinte a trozos mientras alguien tiene al cliente esperando.
 *
 * No expone `private_data` de los eventos ni el payload de pasarela: la traza
 * puede contener datos del proveedor que no tienen por qué salir a una pantalla.
 * Se muestran los campos saneados que ya son visibles en otros puntos del panel.
 */
export default defineEventHandler(async (event) => {
  await requireAdmin(event)
  const publicNumber = getRouterParam(event, 'id')
  if (!publicNumber) throw createError({ statusCode: 400, statusMessage: 'Falta el número de pedido' })

  const sql = useDatabase()

  const [order] = await sql<
    Array<{
      id: string
      publicNumber: string
      orderStatus: string
      paymentStatus: string
      fulfillmentStatus: string
      inventoryStatus: string
      invoiceStatus: string
      shippingMethod: string
      paymentMethod: string
      subtotalNet: number
      discountNet: number
      shippingNet: number
      tax: number
      total: number
      createdAt: Date
      confirmedAt: Date | null
      updatedAt: Date
      customer: Record<string, string | null> | null
      shipping: Record<string, string | null> | null
      billing: Record<string, string | null> | null
      customerId: string | null
      companyName: string | null
      companyStatus: string | null
    }>
  >`
    SELECT o.id, o.public_number AS "publicNumber", o.order_status AS "orderStatus",
           o.payment_status AS "paymentStatus", o.fulfillment_status AS "fulfillmentStatus",
           o.inventory_status AS "inventoryStatus", o.invoice_status AS "invoiceStatus",
           o.shipping_method AS "shippingMethod", o.payment_method AS "paymentMethod",
           o.subtotal_net_cents AS "subtotalNet", o.discount_net_cents AS "discountNet",
           o.shipping_net_cents AS "shippingNet", o.tax_cents AS tax,
           o.total_gross_cents AS total, o.created_at AS "createdAt",
           o.confirmed_at AS "confirmedAt", o.updated_at AS "updatedAt",
           o.customer_snapshot AS customer, o.shipping_snapshot AS shipping,
           o.billing_snapshot AS billing, o.customer_id AS "customerId",
           company.legal_name AS "companyName", company.status AS "companyStatus"
    FROM orders o
    LEFT JOIN company_locations location ON location.id = o.company_location_id
    LEFT JOIN companies company ON company.id = location.company_id
    WHERE o.public_number = ${publicNumber}
  `
  if (!order) throw createError({ statusCode: 404, statusMessage: 'Pedido no encontrado' })

  const [lines, payments, shipments, returns, invoices, notes, timeline, history] = await Promise.all([
    sql<
      Array<{
        id: string
        sku: string
        name: string
        format: string
        unitLabel: string
        quantity: number
        unitNet: number
        discountNet: number
        taxRate: number
        tax: number
        lineGross: number
        slug: string | null
        image: string | null
        visual: { type: string; color: string } | null
        variantStatus: string | null
        returned: number | null
      }>
    >`
      SELECT line.id, line.sku, line.name, line.variant_name AS format,
             line.unit_label AS "unitLabel", line.quantity,
             line.unit_net_cents AS "unitNet", line.discount_net_cents AS "discountNet",
             line.tax_rate_basis_points AS "taxRate", line.tax_cents AS tax,
             line.total_gross_cents AS "lineGross",
             product.slug, product.attributes ->> 'image' AS image,
             product.attributes -> 'visual' AS visual,
             variant.status AS "variantStatus",
             (
               SELECT sum(return_line.quantity)::int
               FROM return_lines return_line
               WHERE return_line.order_line_id = line.id
             ) AS returned
      FROM order_lines line
      LEFT JOIN variants variant ON variant.id = line.variant_id
      LEFT JOIN products product ON product.id = line.product_id
      WHERE line.order_id = ${order.id}
      ORDER BY line.name
    `,
    sql<
      Array<{
        id: string
        provider: string
        method: string
        status: string
        amount: number
        reference: string | null
        createdAt: Date
        updatedAt: Date
        lastEvent: string | null
        lastResponseCode: string | null
        lastEventAt: Date | null
        refunded: number | null
      }>
    >`
      SELECT intent.id, intent.provider, intent.method, intent.status,
             intent.amount_cents AS amount, intent.provider_reference AS reference,
             intent.created_at AS "createdAt", intent.updated_at AS "updatedAt",
             last_event.event_type AS "lastEvent", last_event.response_code AS "lastResponseCode",
             last_event.received_at AS "lastEventAt",
             (
               SELECT sum(refund.amount_cents)::int
               FROM refunds refund
               WHERE refund.payment_intent_id = intent.id AND refund.status = 'succeeded'
             ) AS refunded
      FROM payment_intents intent
      LEFT JOIN LATERAL (
        SELECT payment_event.event_type, payment_event.response_code, payment_event.received_at
        FROM payment_events payment_event
        WHERE payment_event.payment_intent_id = intent.id
        ORDER BY payment_event.received_at DESC
        LIMIT 1
      ) last_event ON true
      WHERE intent.order_id = ${order.id}
      ORDER BY intent.created_at DESC
    `,
    sql<
      Array<{
        id: string
        provider: string
        serviceCode: string
        trackingNumber: string | null
        status: string
        estimatedCost: number
        actualCost: number | null
        hasLabel: boolean
        createdAt: Date
        updatedAt: Date
      }>
    >`
      SELECT shipment.id, shipment.provider, shipment.service_code AS "serviceCode",
             shipment.tracking_number AS "trackingNumber", shipment.status,
             shipment.estimated_cost_cents AS "estimatedCost",
             shipment.actual_cost_cents AS "actualCost",
             shipment.label_asset_id IS NOT NULL AS "hasLabel",
             shipment.created_at AS "createdAt", shipment.updated_at AS "updatedAt"
      FROM shipments shipment
      JOIN fulfillments fulfillment ON fulfillment.id = shipment.fulfillment_id
      WHERE fulfillment.order_id = ${order.id}
      ORDER BY shipment.created_at DESC
    `,
    sql<
      Array<{
        id: string
        publicNumber: string
        status: string
        reason: string
        resolution: string | null
        createdAt: Date
        units: number | null
      }>
    >`
      SELECT ret.id, ret.public_number AS "publicNumber", ret.status, ret.reason,
             ret.resolution, ret.created_at AS "createdAt",
             (SELECT sum(quantity)::int FROM return_lines WHERE return_id = ret.id) AS units
      FROM returns ret
      WHERE ret.order_id = ${order.id}
      ORDER BY ret.created_at DESC
    `,
    sql<Array<{ id: string; series: string; kind: string; status: string; amount: number; createdAt: Date }>>`
      SELECT invoice.id, invoice.series, invoice.kind, invoice.status,
             invoice.amount_cents AS amount, invoice.created_at AS "createdAt"
      FROM invoices invoice
      WHERE invoice.order_id = ${order.id}
      ORDER BY invoice.created_at DESC
    `,
    sql<Array<{ id: string; note: string; author: string | null; createdAt: Date }>>`
      SELECT note.id, note.note, identity.email AS author, note.created_at AS "createdAt"
      FROM order_notes note
      LEFT JOIN identities identity ON identity.id = note.author_identity_id
      WHERE note.order_id = ${order.id}
      ORDER BY note.created_at DESC
    `,
    sql<
      Array<{
        id: string
        eventType: string
        actorType: string
        origin: string
        reason: string | null
        createdAt: Date
        fromState: Record<string, string> | null
        toState: Record<string, string> | null
      }>
    >`
      SELECT order_event.id, order_event.event_type AS "eventType",
             order_event.actor_type AS "actorType", order_event.origin,
             order_event.reason, order_event.created_at AS "createdAt",
             order_event.from_state AS "fromState", order_event.to_state AS "toState"
      FROM order_events order_event
      WHERE order_event.order_id = ${order.id}
      ORDER BY order_event.created_at DESC
      LIMIT 100
    `,
    sql<Array<{ publicNumber: string; total: number; createdAt: Date; status: string }>>`
      SELECT other.public_number AS "publicNumber", other.total_gross_cents AS total,
             other.created_at AS "createdAt", other.order_status AS status
      FROM orders other
      WHERE other.customer_id = ${order.customerId} AND other.id <> ${order.id}
      ORDER BY other.created_at DESC
      LIMIT 5
    `
  ])

  const shipmentIds = shipments.map((shipment) => shipment.id)
  const shipmentEvents = shipmentIds.length
    ? await sql<
        Array<{
          shipmentId: string
          status: string
          location: string | null
          description: string | null
          occurredAt: Date
        }>
      >`
        SELECT shipment_id AS "shipmentId", status, location, description, occurred_at AS "occurredAt"
        FROM shipment_events
        WHERE shipment_id = ANY(${shipmentIds}::uuid[])
        ORDER BY occurred_at DESC
      `
    : []

  return {
    order: {
      id: order.publicNumber,
      status: publicOrderStatus(order),
      orderStatus: order.orderStatus,
      paymentStatus: order.paymentStatus,
      fulfillmentStatus: order.fulfillmentStatus,
      inventoryStatus: order.inventoryStatus,
      invoiceStatus: order.invoiceStatus,
      shippingMethod: order.shippingMethod,
      paymentMethod: order.paymentMethod,
      createdAt: order.createdAt.toISOString(),
      confirmedAt: order.confirmedAt?.toISOString() ?? null,
      updatedAt: order.updatedAt.toISOString(),
      totals: {
        subtotalNet: order.subtotalNet,
        discountNet: order.discountNet,
        shippingNet: order.shippingNet,
        tax: order.tax,
        total: order.total
      }
    },
    customer: {
      name: order.customer?.name ?? null,
      email: order.customer?.email ?? null,
      phone: order.customer?.phone ?? null,
      company: order.companyName ?? order.customer?.company ?? null,
      companyStatus: order.companyStatus,
      taxId: order.billing?.taxId ?? null,
      isGuest: order.customerId === null
    },
    shippingAddress: order.shipping,
    billingAddress: order.billing,
    lines: lines.map((line) => ({
      ...line,
      returned: line.returned ?? 0,
      inCatalog: line.variantStatus === 'published'
    })),
    payments: payments.map((payment) => ({
      ...payment,
      refunded: payment.refunded ?? 0,
      createdAt: payment.createdAt.toISOString(),
      updatedAt: payment.updatedAt.toISOString(),
      lastEventAt: payment.lastEventAt?.toISOString() ?? null
    })),
    shipments: shipments.map((shipment) => ({
      ...shipment,
      createdAt: shipment.createdAt.toISOString(),
      updatedAt: shipment.updatedAt.toISOString(),
      events: shipmentEvents
        .filter((shipmentEvent) => shipmentEvent.shipmentId === shipment.id)
        .map((shipmentEvent) => ({
          status: shipmentEvent.status,
          location: shipmentEvent.location,
          description: shipmentEvent.description,
          occurredAt: shipmentEvent.occurredAt.toISOString()
        }))
    })),
    returns: returns.map((ret) => ({
      ...ret,
      units: ret.units ?? 0,
      createdAt: ret.createdAt.toISOString()
    })),
    invoices: invoices.map((invoice) => ({ ...invoice, createdAt: invoice.createdAt.toISOString() })),
    notes: notes.map((note) => ({ ...note, createdAt: note.createdAt.toISOString() })),
    timeline: timeline.map((entry) => ({
      id: entry.id,
      eventType: entry.eventType,
      actorType: entry.actorType,
      origin: entry.origin,
      reason: entry.reason,
      createdAt: entry.createdAt.toISOString(),
      fromState: entry.fromState,
      toState: entry.toState
    })),
    history: history.map((other) => ({
      id: other.publicNumber,
      total: other.total,
      status: other.status,
      createdAt: other.createdAt.toISOString()
    }))
  }
})

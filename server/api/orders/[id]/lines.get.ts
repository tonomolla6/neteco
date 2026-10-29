import { useDatabase } from '../../../db/client'
import { requireVerifiedIdentity } from '../../../utils/auth-session'

/**
 * Contenido de un pedido del cliente: qué llevaba, con imagen, y en qué estado va el envío.
 *
 * Alimenta dos cosas a la vez, y por eso es un solo endpoint:
 *   1. El desplegable del listado «Mis pedidos», para poder ver lo que llevaba un pedido
 *      sin salir de la lista.
 *   2. El diálogo de «Volver a pedir», que necesita saber qué referencias siguen a la venta.
 *
 * Es de solo lectura y no toca el carrito: el cliente revisa y confirma, y las líneas se
 * añaden después con el flujo de carrito existente, que es el que valida stock, mínimos,
 * incrementos y precio vigente.
 */
export default defineEventHandler(async (event) => {
  const authenticated = await requireVerifiedIdentity(event)
  const publicNumber = getRouterParam(event, 'id')
  if (!publicNumber) throw createError({ statusCode: 400, statusMessage: 'Falta el número de pedido' })

  const sql = useDatabase()
  const [order] = await sql<
    Array<{
      id: string
      publicNumber: string
      createdAt: Date
      shippingMethod: string
      paymentMethod: string
      fulfillmentStatus: string
      subtotalNet: number
      shippingNet: number
      tax: number
      total: number
      city: string | null
      line1: string | null
      postalCode: string | null
    }>
  >`
    SELECT o.id, o.public_number AS "publicNumber", o.created_at AS "createdAt",
           o.shipping_method AS "shippingMethod", o.payment_method AS "paymentMethod",
           o.fulfillment_status AS "fulfillmentStatus",
           o.subtotal_net_cents AS "subtotalNet", o.shipping_net_cents AS "shippingNet",
           o.tax_cents AS tax, o.total_gross_cents AS total,
           o.shipping_snapshot ->> 'city' AS city,
           o.shipping_snapshot ->> 'line1' AS line1,
           o.shipping_snapshot ->> 'postalCode' AS "postalCode"
    FROM orders o
    JOIN identities identity ON identity.customer_id = o.customer_id
    WHERE identity.id = ${authenticated.profile.id} AND o.public_number = ${publicNumber}
  `
  if (!order) throw createError({ statusCode: 404, statusMessage: 'Pedido no encontrado' })

  const lines = await sql<
    Array<{
      sku: string
      name: string
      format: string
      quantity: number
      unitGross: number
      lineGross: number
      variantId: number | null
      slug: string | null
      status: string | null
      image: string | null
      visual: { type: string; color: string } | null
    }>
  >`
    SELECT line.sku, line.name, line.variant_name AS format, line.quantity,
           COALESCE((line.logistics_snapshot ->> 'unitGrossCents')::int,
                    line.total_gross_cents / NULLIF(line.quantity, 0)) AS "unitGross",
           line.total_gross_cents AS "lineGross",
           variant.legacy_id AS "variantId", product.slug, variant.status,
           product.attributes ->> 'image' AS image,
           product.attributes -> 'visual' AS visual
    FROM order_lines line
    LEFT JOIN variants variant ON variant.id = line.variant_id
    LEFT JOIN products product ON product.id = line.product_id
    WHERE line.order_id = ${order.id}
    ORDER BY line.name
  `

  const [shipment] = await sql<
    Array<{ status: string; trackingNumber: string | null; provider: string; updatedAt: Date }>
  >`
    SELECT shipment.status, shipment.tracking_number AS "trackingNumber",
           shipment.provider, shipment.updated_at AS "updatedAt"
    FROM shipments shipment
    JOIN fulfillments fulfillment ON fulfillment.id = shipment.fulfillment_id
    WHERE fulfillment.order_id = ${order.id}
    ORDER BY shipment.updated_at DESC
    LIMIT 1
  `

  return {
    orderId: order.publicNumber,
    orderedAt: order.createdAt.toISOString(),
    shippingMethod: order.shippingMethod,
    paymentMethod: order.paymentMethod,
    fulfillmentStatus: order.fulfillmentStatus,
    destination: order.city ? { line1: order.line1, postalCode: order.postalCode, city: order.city } : null,
    totals: {
      subtotalNet: order.subtotalNet,
      shippingNet: order.shippingNet,
      tax: order.tax,
      total: order.total
    },
    shipment: shipment
      ? {
          status: shipment.status,
          trackingNumber: shipment.trackingNumber,
          provider: shipment.provider,
          updatedAt: shipment.updatedAt.toISOString()
        }
      : null,
    lines: lines.map((line) => {
      const available = line.variantId !== null && line.status === 'published'
      return {
        sku: line.sku,
        name: line.name,
        format: line.format,
        quantity: line.quantity,
        unitGross: line.unitGross ?? 0,
        lineGross: line.lineGross,
        variantId: line.variantId,
        slug: line.slug,
        image: line.image,
        visual: line.visual,
        available,
        reason: available ? null : line.variantId === null ? 'Ya no está en el catálogo' : 'No disponible ahora mismo'
      }
    })
  }
})

import { createHash, randomUUID } from 'node:crypto'
import { createError } from 'h3'
import { useDatabase } from '../db/client'
import { carrierProviderFromEnvironment } from '../integrations/carrier-factory'
import type { Parcel, ShippingAddress } from '../integrations/carrier-provider'
import { shippingCommercialPolicy } from '../utils/shipping-policy'
import { calculateQuote } from '../domain/money'
import { selectVolumeUnitPrice, type VolumePriceTier } from '../domain/money'
import { classifyShipment } from '../domain/shipping'

interface ShipmentOrder {
  id: string
  publicNumber: string
  orderStatus: string
  paymentStatus: string
  fulfillmentId: string
  fulfillmentStatus: string
  shippingMethod: string
  shipping: {
    recipientName: string
    line1: string
    postalCode: string
    city: string
    region: string
    countryCode: string
    phone: string
  }
}

function shippingAddress(order: ShipmentOrder): ShippingAddress {
  return {
    name: order.shipping.recipientName,
    line1: order.shipping.line1,
    postalCode: order.shipping.postalCode,
    city: order.shipping.city,
    region: order.shipping.region,
    countryCode: order.shipping.countryCode,
    phone: order.shipping.phone
  }
}

async function shipmentOrder(publicNumber: string) {
  const sql = useDatabase()
  const [order] = await sql<ShipmentOrder[]>`
    SELECT orders.id, orders.public_number AS "publicNumber", orders.order_status AS "orderStatus",
           orders.payment_status AS "paymentStatus", fulfillment.id AS "fulfillmentId",
           fulfillment.status AS "fulfillmentStatus", orders.shipping_method AS "shippingMethod",
           orders.shipping_snapshot AS shipping
    FROM orders
    JOIN fulfillments fulfillment ON fulfillment.order_id = orders.id
    WHERE orders.public_number = ${publicNumber}
    ORDER BY fulfillment.created_at
    LIMIT 1
  `
  return order
}

async function orderParcels(orderId: string) {
  const sql = useDatabase()
  const lines = await sql<
    Array<{
      sku: string
      quantity: number
      weightGrams: number
      widthMm: number
      heightMm: number
      depthMm: number
      profile: string
    }>
  >`
    SELECT line.sku, line.quantity, variant.weight_grams AS "weightGrams",
           variant.width_mm AS "widthMm", variant.height_mm AS "heightMm", variant.depth_mm AS "depthMm",
           profile.kind AS profile
    FROM order_lines line
    JOIN variants variant ON variant.id = line.variant_id
    JOIN shipping_profiles profile ON profile.id = variant.shipping_profile_id
    WHERE line.order_id = ${orderId}
    ORDER BY line.id
  `
  if (lines.length === 0) throw createError({ statusCode: 409, statusMessage: 'El pedido no tiene líneas expedibles' })
  return lines.map((line): Parcel => ({
    weightGrams: line.weightGrams * line.quantity,
    widthMm: line.widthMm,
    heightMm: line.heightMm,
    depthMm: line.depthMm,
    contents: [{ sku: line.sku, quantity: line.quantity }],
    handling: line.profile === 'adr' ? 'adr' : line.profile === 'pallet' ? 'pallet' : 'parcel'
  }))
}

export async function quoteCartShipping(cartId: string, destination: ShippingAddress) {
  const sql = useDatabase()
  const lines = await sql<
    Array<{
      sku: string
      quantity: number
      weightGrams: number
      widthMm: number
      heightMm: number
      depthMm: number
      profile: string
      priceGrossCents: number
      volumeTiers: VolumePriceTier[]
      taxRateBasisPoints: number
      sourceVersion: string | null
    }>
  >`
    SELECT variant.sku, item.quantity, price.gross_cents AS "priceGrossCents",
           price.volume_tiers AS "volumeTiers", tax.rate_basis_points AS "taxRateBasisPoints",
           price.pricing_version AS "sourceVersion",
           variant.weight_grams AS "weightGrams",
           variant.width_mm AS "widthMm", variant.height_mm AS "heightMm", variant.depth_mm AS "depthMm",
           profile.kind AS profile
    FROM cart_items item
    JOIN variants variant ON variant.id = item.variant_id
    JOIN effective_variant_prices price ON price.variant_id = variant.id
    JOIN tax_classes tax ON tax.id = variant.tax_class_id
    JOIN shipping_profiles profile ON profile.id = variant.shipping_profile_id
    WHERE item.cart_id = ${cartId}
    ORDER BY item.added_at, item.id
  `
  if (lines.length === 0) throw createError({ statusCode: 409, statusMessage: 'El carrito está vacío' })
  const pricedLines = lines.map((line) => ({
    ...line,
    priceGrossCents: selectVolumeUnitPrice(line.priceGrossCents, line.quantity, line.volumeTiers)
  }))
  const parcels = pricedLines.map((line): Parcel => ({
    weightGrams: line.weightGrams * line.quantity,
    widthMm: line.widthMm,
    heightMm: line.heightMm,
    depthMm: line.depthMm,
    contents: [{ sku: line.sku, quantity: line.quantity }],
    handling: line.profile === 'adr' ? 'adr' : line.profile === 'pallet' ? 'pallet' : 'parcel'
  }))
  const provider = carrierProviderFromEnvironment()
  const quotedRates = await provider.rates({ originPostalCode: '46870', destination, parcels })
  const goodsGross = pricedLines.reduce((total, line) => total + line.priceGrossCents * line.quantity, 0)
  const policy = shippingCommercialPolicy()
  const rates = quotedRates.map((rate) => ({
    ...rate,
    netCents:
      policy.freeShippingThresholdCents !== null &&
      goodsGross >= policy.freeShippingThresholdCents &&
      ['parcel', 'multi_parcel'].includes(rate.profile)
        ? 0
        : rate.netCents
  }))
  const now = new Date()
  return [
    ...rates,
    {
      provider: 'neteco',
      serviceCode: 'WAREHOUSE-PICKUP',
      label: 'Recogida en almacén NETECO',
      netCents: 0,
      taxRateBasisPoints: 2100,
      estimatedDeliveryFrom: now.toISOString(),
      estimatedDeliveryTo: now.toISOString(),
      profile: 'pickup' as const
    }
  ].map((rate) => {
    const shippingNetCents = rate.netCents
    const shippingGrossCents = shippingNetCents + Math.round((shippingNetCents * rate.taxRateBasisPoints) / 10_000)
    const pricingVersion = `catalog:${pricedLines
      .map((line) => line.sourceVersion ?? 'unknown')
      .sort()
      .join('+')};shipping:${rate.provider}:${rate.serviceCode}`
    const quote = calculateQuote({
      pricingVersion,
      lines: pricedLines.map((line) => ({
        variantId: line.sku,
        sku: line.sku,
        quantity: line.quantity,
        unitGrossCents: line.priceGrossCents,
        taxRateBasisPoints: line.taxRateBasisPoints
      })),
      shippingGrossCents,
      shippingTaxRateBasisPoints: rate.taxRateBasisPoints
    })
    return {
      ...rate,
      pricingVersion,
      subtotalNetCents: quote.subtotalNetCents,
      taxCents: quote.taxCents,
      totalGrossCents: quote.totalGrossCents
    }
  })
}

export async function quoteProductDelivery(input: {
  variantId: string
  quantity: number
  postalCode: string
  city: string
}) {
  const sql = useDatabase()
  const [variant] = await sql<
    Array<{
      sku: string
      minimumQuantity: number
      maximumQuantity: number | null
      quantityIncrement: number
      weightGrams: number
      widthMm: number
      heightMm: number
      depthMm: number
      profile: string
      available: number
      backorderAllowed: boolean
      leadTimeDays: number | null
    }>
  >`
    SELECT variant.sku, variant.minimum_quantity AS "minimumQuantity",
           variant.maximum_quantity AS "maximumQuantity", variant.quantity_increment AS "quantityIncrement",
           variant.weight_grams AS "weightGrams", variant.width_mm AS "widthMm",
           variant.height_mm AS "heightMm", variant.depth_mm AS "depthMm", profile.kind AS profile,
           greatest(COALESCE(sum(balance.physical_quantity - balance.blocked_quantity), 0)
             - variant.safety_stock - COALESCE((
               SELECT sum(reservation.quantity)::int FROM inventory_reservations reservation
               WHERE reservation.variant_id = variant.id AND reservation.status = 'active'
                 AND reservation.expires_at > now()
             ), 0), 0)::int AS available,
           variant.backorder_allowed AS "backorderAllowed", variant.lead_time_days AS "leadTimeDays"
    FROM variants variant
    JOIN products product ON product.id = variant.product_id
    JOIN shipping_profiles profile ON profile.id = variant.shipping_profile_id
    LEFT JOIN inventory_balances balance ON balance.variant_id = variant.id
    WHERE variant.id = ${input.variantId} AND variant.status = 'published' AND product.status = 'published'
    GROUP BY variant.id, profile.kind
  `
  if (!variant) throw createError({ statusCode: 404, statusMessage: 'Variante no disponible' })
  if (
    input.quantity < variant.minimumQuantity ||
    (input.quantity - variant.minimumQuantity) % variant.quantityIncrement !== 0 ||
    (variant.maximumQuantity !== null && input.quantity > variant.maximumQuantity)
  ) {
    throw createError({ statusCode: 422, statusMessage: 'La cantidad no cumple el mínimo o incremento comercial' })
  }
  if (!variant.backorderAllowed && input.quantity > variant.available) {
    throw createError({ statusCode: 409, statusMessage: 'No hay stock suficiente para calcular esa entrega' })
  }
  const parcel: Parcel = {
    weightGrams: variant.weightGrams * input.quantity,
    widthMm: variant.widthMm,
    heightMm: variant.heightMm,
    depthMm: variant.depthMm,
    contents: [{ sku: variant.sku, quantity: input.quantity }],
    handling: variant.profile === 'adr' ? 'adr' : variant.profile === 'pallet' ? 'pallet' : 'parcel'
  }
  classifyShipment([parcel])
  const provider = carrierProviderFromEnvironment()
  const rates = await provider.rates({
    originPostalCode: '46870',
    destination: {
      name: 'Cotización de producto',
      line1: 'Dirección pendiente en checkout',
      postalCode: input.postalCode,
      city: input.city,
      region: input.city,
      countryCode: 'ES'
    },
    parcels: [parcel]
  })
  return {
    stockCondition: variant.available >= input.quantity ? ('in_stock' as const) : ('backorder' as const),
    leadTimeDays: variant.leadTimeDays,
    rates: rates.map((rate) => ({
      serviceCode: rate.serviceCode,
      label: rate.label,
      profile: rate.profile,
      estimatedDeliveryFrom: rate.estimatedDeliveryFrom,
      estimatedDeliveryTo: rate.estimatedDeliveryTo
    }))
  }
}

export async function createOrderShipment(input: {
  publicNumber: string
  serviceCode: string
  actorId: string
  correlationId: string
}) {
  const sql = useDatabase()
  const order = await shipmentOrder(input.publicNumber)
  if (!order) throw createError({ statusCode: 404, statusMessage: 'Pedido no encontrado' })
  const [existing] = await sql<
    { id: string; tracking_number: string | null; status: string; provider_shipment_id: string | null }[]
  >`
    SELECT id, tracking_number, status, provider_shipment_id
    FROM shipments WHERE fulfillment_id = ${order.fulfillmentId}
    ORDER BY created_at DESC LIMIT 1
  `
  if (existing && existing.status !== 'cancelled') return { ...existing, duplicate: true }
  if (
    !['confirmed', 'completed'].includes(order.orderStatus) ||
    !['captured', 'partially_refunded'].includes(order.paymentStatus)
  ) {
    throw createError({ statusCode: 409, statusMessage: 'El pedido debe estar confirmado y cobrado' })
  }
  if (order.shippingMethod === 'recogida') {
    throw createError({ statusCode: 409, statusMessage: 'La recogida no genera una expedición de transportista' })
  }

  const provider = carrierProviderFromEnvironment()
  const parcels = await orderParcels(order.id)
  const destination = shippingAddress(order)
  const rates = await provider.rates({ originPostalCode: '46870', destination, parcels })
  const rate = rates.find((candidate) => candidate.serviceCode === input.serviceCode)
  if (!rate) throw createError({ statusCode: 422, statusMessage: 'El servicio no es elegible para esta expedición' })
  const idempotencyKey = `shipment:${order.fulfillmentId}:v1`
  const shipment = await provider.createShipment({
    orderNumber: order.publicNumber,
    destination,
    parcels,
    serviceCode: input.serviceCode,
    idempotencyKey
  })
  const shipmentId = randomUUID()
  const checksum = createHash('sha256').update(shipment.label).digest('hex')
  return sql.begin('isolation level serializable', async (transaction) => {
    const [concurrent] = await transaction<
      { id: string; tracking_number: string | null; status: string; provider_shipment_id: string | null }[]
    >`
      SELECT id, tracking_number, status, provider_shipment_id FROM shipments
      WHERE idempotency_key = ${idempotencyKey} FOR UPDATE
    `
    if (concurrent) return { ...concurrent, duplicate: true }
    await transaction`
      INSERT INTO shipments (
        id, fulfillment_id, provider, provider_shipment_id, service_code, tracking_number, status,
        profile, estimated_cost_cents, currency, estimated_delivery_from, estimated_delivery_to, idempotency_key
      ) VALUES (
        ${shipmentId}, ${order.fulfillmentId}, ${provider.name}, ${shipment.providerShipmentId},
        ${input.serviceCode}, ${shipment.trackingNumber}, ${shipment.status}, ${rate.profile}, ${rate.netCents},
        'EUR', ${rate.estimatedDeliveryFrom}, ${rate.estimatedDeliveryTo}, ${idempotencyKey}
      )
    `
    await transaction`
      INSERT INTO shipment_documents (shipment_id, kind, content_type, bytes, checksum_sha256)
      VALUES (${shipmentId}, 'label', 'application/pdf', ${shipment.label}, ${checksum})
    `
    await transaction`
      INSERT INTO shipment_events (
        shipment_id, provider_event_id, status, description, occurred_at, payload_hash
      ) VALUES (
        ${shipmentId}, ${`created:${shipment.providerShipmentId}`}, ${shipment.status}, 'Expedición creada', now(),
        ${createHash('sha256').update(`${shipment.providerShipmentId}:created`).digest('hex')}
      )
    `
    await transaction`
      UPDATE fulfillments SET status = 'in_transit', updated_at = now() WHERE id = ${order.fulfillmentId}
    `
    await transaction`
      UPDATE orders SET fulfillment_status = 'in_transit', updated_at = now() WHERE id = ${order.id}
    `
    await transaction`
      INSERT INTO order_events (
        order_id, event_type, actor_type, actor_id, origin, to_state, public_data, private_data,
        correlation_id, idempotency_key
      ) VALUES (
        ${order.id}, 'shipment.created', 'staff', ${input.actorId}, 'admin',
        ${transaction.json({ fulfillment: 'in_transit' })},
        ${transaction.json({ trackingNumber: shipment.trackingNumber, eta: rate.estimatedDeliveryTo })},
        ${transaction.json({ providerShipmentId: shipment.providerShipmentId, costCents: rate.netCents, checksum })},
        ${input.correlationId}, ${`shipment:${shipmentId}:created`}
      )
    `
    await transaction`
      INSERT INTO outbox_events (
        aggregate_type, aggregate_id, event_type, payload, correlation_id, idempotency_key
      ) VALUES (
        'order', ${order.id}, 'order.shipped',
        ${transaction.json({
          orderId: order.id,
          orderNumber: order.publicNumber,
          statusLabel: 'enviado',
          trackingNumber: shipment.trackingNumber
        })}, ${input.correlationId}, ${`order:${order.id}:shipment:${shipmentId}:email`}
      ) ON CONFLICT (idempotency_key) DO NOTHING
    `
    return {
      id: shipmentId,
      trackingNumber: shipment.trackingNumber,
      status: shipment.status,
      providerShipmentId: shipment.providerShipmentId,
      estimatedDeliveryFrom: rate.estimatedDeliveryFrom,
      estimatedDeliveryTo: rate.estimatedDeliveryTo,
      duplicate: false
    }
  })
}

export async function syncShipmentTracking(shipmentId: string, correlationId: string) {
  const sql = useDatabase()
  const [shipment] = await sql<
    { id: string; provider_shipment_id: string | null; fulfillment_id: string; order_id: string }[]
  >`
    SELECT shipment.id, shipment.provider_shipment_id, shipment.fulfillment_id, fulfillment.order_id
    FROM shipments shipment JOIN fulfillments fulfillment ON fulfillment.id = shipment.fulfillment_id
    WHERE shipment.id = ${shipmentId}
  `
  if (!shipment?.provider_shipment_id) throw createError({ statusCode: 404, statusMessage: 'Expedición no encontrada' })
  const provider = carrierProviderFromEnvironment()
  const events = await provider.tracking(shipment.provider_shipment_id)
  await sql.begin(async (transaction) => {
    for (const item of events) {
      const payloadHash = createHash('sha256')
        .update(`${shipment.provider_shipment_id}:${item.status}:${item.occurredAt}`)
        .digest('hex')
      await transaction`
        INSERT INTO shipment_events (
          shipment_id, provider_event_id, status, occurred_at, payload_hash
        ) VALUES (
          ${shipment.id}, ${payloadHash.slice(0, 32)}, ${item.status}, ${item.occurredAt}, ${payloadHash}
        ) ON CONFLICT (shipment_id, provider_event_id) DO NOTHING
      `
    }
    const latestEvent = events.at(-1)
    if (latestEvent) {
      const latest = latestEvent.status
      const fulfillmentStatus =
        latest === 'delivered' ? 'delivered' : latest === 'in_transit' ? 'in_transit' : 'exception'
      await transaction`UPDATE shipments SET status = ${latest}, updated_at = now() WHERE id = ${shipment.id}`
      await transaction`
        UPDATE fulfillments SET status = ${fulfillmentStatus}, updated_at = now() WHERE id = ${shipment.fulfillment_id}
      `
      await transaction`
        UPDATE orders
        SET fulfillment_status = ${fulfillmentStatus},
            delivered_at = CASE
              WHEN ${fulfillmentStatus} = 'delivered' THEN COALESCE(delivered_at, ${latestEvent.occurredAt}::timestamptz)
              ELSE delivered_at
            END,
            updated_at = now()
        WHERE id = ${shipment.order_id}
      `
      await transaction`
        INSERT INTO order_events (
          order_id, event_type, actor_type, origin, to_state, public_data, private_data,
          correlation_id, idempotency_key
        ) VALUES (
          ${shipment.order_id}, 'shipment.tracking.updated', 'provider', ${provider.name},
          ${transaction.json({ fulfillment: fulfillmentStatus })}, ${transaction.json({ status: latest })},
          ${transaction.json({ shipmentId })}, ${correlationId}, ${`tracking:${shipmentId}:${latest}:${latestEvent.occurredAt}`}
        ) ON CONFLICT (order_id, idempotency_key) DO NOTHING
      `
      if (latest === 'delivered') {
        await transaction`
          INSERT INTO outbox_events (
            aggregate_type, aggregate_id, event_type, payload, correlation_id, idempotency_key
          )
          SELECT 'order', orders.id, 'order.delivered',
                 ${transaction.json({ orderId: shipment.order_id, statusLabel: 'entregado' })}
                   || jsonb_build_object('orderNumber', orders.public_number),
                 ${correlationId}, ${`order:${shipment.order_id}:delivered:email`}
          FROM orders WHERE id = ${shipment.order_id}
          ON CONFLICT (idempotency_key) DO NOTHING
        `
      }
    }
  })
  return { id: shipment.id, events }
}

export async function cancelOrderShipment(shipmentId: string, actorId: string, correlationId: string, reason: string) {
  const sql = useDatabase()
  const [shipment] = await sql<
    { provider_shipment_id: string | null; fulfillment_id: string; order_id: string; status: string }[]
  >`
    SELECT shipment.provider_shipment_id, shipment.fulfillment_id, fulfillment.order_id, shipment.status
    FROM shipments shipment JOIN fulfillments fulfillment ON fulfillment.id = shipment.fulfillment_id
    WHERE shipment.id = ${shipmentId}
  `
  if (!shipment?.provider_shipment_id) throw createError({ statusCode: 404, statusMessage: 'Expedición no encontrada' })
  if (shipment.status === 'cancelled') return { id: shipmentId, status: 'cancelled', duplicate: true }
  const provider = carrierProviderFromEnvironment()
  await provider.cancelShipment(shipment.provider_shipment_id)
  await sql.begin(async (transaction) => {
    await transaction`UPDATE shipments SET status = 'cancelled', updated_at = now() WHERE id = ${shipmentId}`
    await transaction`
      UPDATE fulfillments SET status = 'exception', updated_at = now() WHERE id = ${shipment.fulfillment_id}
    `
    await transaction`
      UPDATE orders SET fulfillment_status = 'exception', updated_at = now() WHERE id = ${shipment.order_id}
    `
    await transaction`
      INSERT INTO order_events (
        order_id, event_type, actor_type, actor_id, origin, reason, to_state, public_data,
        private_data, correlation_id, idempotency_key
      ) VALUES (
        ${shipment.order_id}, 'shipment.cancelled', 'staff', ${actorId}, 'admin', ${reason},
        ${transaction.json({ fulfillment: 'exception' })}, ${transaction.json({})},
        ${transaction.json({ shipmentId })}, ${correlationId}, ${`shipment:${shipmentId}:cancelled`}
      ) ON CONFLICT (order_id, idempotency_key) DO NOTHING
    `
  })
  return { id: shipmentId, status: 'cancelled', duplicate: false }
}

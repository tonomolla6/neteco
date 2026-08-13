import { randomBytes, randomUUID } from 'node:crypto'
import { createError } from 'h3'
import type { TransactionSql } from 'postgres'
import { calculateQuote, splitGross } from '../domain/money'
import { sellableQuantity } from '../domain/inventory'
import { chargeableWeightGrams, classifyShipment, standardShippingNetCents } from '../domain/shipping'
import type { Parcel } from '../integrations/carrier-provider'
import type { PaymentNotification } from '../integrations/payment-provider'
import { useDatabase } from '../db/client'
import { hashAccessToken } from '../utils/access-token'
import { shippingCommercialPolicy } from '../utils/shipping-policy'

export const TERMS_VERSION = process.env.LEGAL_TERMS_VERSION || 'purchase-2026-08-12'
export const PRIVACY_VERSION = process.env.LEGAL_PRIVACY_VERSION || 'privacy-2026-08-12'
export const CHECKOUT_RESERVATION_MINUTES = 30
export const TRANSFER_RESERVATION_HOURS = 72

export interface CheckoutCustomer {
  name: string
  company: string
  nif: string
  email: string
  phone: string
}

export interface CheckoutAddress {
  recipientName: string
  companyName: string
  taxId: string
  line1: string
  line2: string
  postalCode: string
  city: string
  region: string
  countryCode: 'ES'
  phone: string
  instructions: string
}

export interface CreateOrderInput {
  customer: CheckoutCustomer
  shippingAddress: CheckoutAddress
  billingAddress: CheckoutAddress
  shippingMethod: 'reparto' | 'envio' | 'recogida'
  paymentMethod: 'tarjeta' | 'bizum' | 'transferencia'
  cartId: string
  cartVersion: number
  idempotencyKey: string
  guestToken: string
  guestTokenEnvelope?: string
  termsAccepted: true
  marketingConsent: boolean
  correlationId: string
}

interface VariantRecord {
  id: string
  legacy_id: number
  product_id: string
  name: string
  format: string
  sku: string
  unit_label: string
  price_gross_cents: number
  minimum_quantity: number
  maximum_quantity: number | null
  quantity_increment: number
  safety_stock: number
  backorder_allowed: boolean
  tax_rate_basis_points: number
  source_version: string | null
  shipping_profile: string
  weight_grams: number
  width_mm: number
  height_mm: number
  depth_mm: number
}

interface InventoryRecord {
  location_id: string
  physical_quantity: number
  blocked_quantity: number
}

interface ExistingOrder {
  id: string
  public_number: string
  guest_access_hash: string | null
  payment_method: string
  payment_status: string
  total_gross_cents: number
  expires_at: Date | null
}

function publicOrderNumber() {
  return `NE${randomBytes(8).toString('hex').slice(0, 10).toUpperCase()}`
}

function publicStatus(paymentMethod: string, paymentStatus: string) {
  if (paymentStatus === 'captured' || paymentStatus === 'authorized') return 'pagado'
  if (paymentStatus === 'cancelled') return 'cancelado'
  if (paymentMethod === 'transferencia') return 'pendiente_transferencia'
  return 'pendiente_pago'
}

function orderResponse(order: ExistingOrder, guestToken: string) {
  return {
    id: order.public_number,
    token: guestToken,
    status: publicStatus(order.payment_method, order.payment_status),
    total: order.total_gross_cents,
    expiresAt: order.expires_at?.toISOString() ?? null
  }
}

function serializableFailure(error: unknown) {
  return !!error && typeof error === 'object' && 'code' in error && ['40001', '40P01'].includes(String(error.code))
}

async function inSerializableTransaction<T>(operation: (transaction: TransactionSql) => Promise<T>) {
  const sql = useDatabase()
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await sql.begin('isolation level serializable', operation)
    } catch (error) {
      if (!serializableFailure(error) || attempt === 3) throw error
    }
  }
  throw new Error('Unreachable transaction retry state')
}

export async function createOrder(input: CreateOrderInput) {
  return inSerializableTransaction(async (transaction) => {
    const guestAccessHash = hashAccessToken(input.guestToken)
    const [existing] = await transaction<ExistingOrder[]>`
      SELECT id, public_number, guest_access_hash, payment_method, payment_status,
             total_gross_cents, expires_at
      FROM orders
      WHERE idempotency_key = ${input.idempotencyKey}
      FOR UPDATE
    `
    if (existing) {
      if (existing.guest_access_hash !== guestAccessHash) {
        throw createError({ statusCode: 409, statusMessage: 'La clave de idempotencia pertenece a otra compra' })
      }
      return orderResponse(existing, input.guestToken)
    }

    const [cart] = await transaction<{ id: string; version: number; status: string }[]>`
      SELECT id, version, status FROM carts WHERE id = ${input.cartId} FOR UPDATE
    `
    if (!cart || cart.status !== 'active' || cart.version !== input.cartVersion) {
      throw createError({ statusCode: 409, statusMessage: 'El carrito ha cambiado; revisa el resumen' })
    }
    const requested = await transaction<{ variantId: number; qty: number }[]>`
      SELECT v.legacy_id AS "variantId", ci.quantity AS qty
      FROM cart_items ci JOIN variants v ON v.id = ci.variant_id
      WHERE ci.cart_id = ${cart.id}
      ORDER BY ci.added_at, ci.id
    `
    if (requested.length === 0) throw createError({ statusCode: 409, statusMessage: 'El carrito está vacío' })
    const legacyIds = requested.map((item) => item.variantId)
    const variants = await transaction<VariantRecord[]>`
      SELECT v.id, v.legacy_id, v.product_id, p.name, v.format, v.sku, v.unit_label,
             v.price_gross_cents, v.minimum_quantity, v.maximum_quantity, v.quantity_increment,
             v.safety_stock, v.backorder_allowed, t.rate_basis_points AS tax_rate_basis_points,
             v.source_version, shipping.kind AS shipping_profile,
             v.weight_grams, v.width_mm, v.height_mm, v.depth_mm
      FROM variants v
      JOIN products p ON p.id = v.product_id
      JOIN tax_classes t ON t.id = v.tax_class_id
      JOIN shipping_profiles shipping ON shipping.id = v.shipping_profile_id
      WHERE v.legacy_id IN ${transaction(legacyIds)}
        AND v.status = 'published'
        AND p.status = 'published'
      ORDER BY v.id
    `
    if (variants.length !== requested.length) {
      throw createError({ statusCode: 409, statusMessage: 'Uno o más artículos ya no están disponibles' })
    }
    const quantityByVariant = new Map(requested.map((item) => [item.variantId, item.qty]))
    const lines = variants.map((variant) => ({
      variantId: variant.id,
      sku: variant.sku,
      quantity: quantityByVariant.get(variant.legacy_id)!,
      unitGrossCents: variant.price_gross_cents,
      taxRateBasisPoints: variant.tax_rate_basis_points,
      minimumQuantity: variant.minimum_quantity,
      maximumQuantity: variant.maximum_quantity,
      quantityIncrement: variant.quantity_increment
    }))
    const goodsGross = lines.reduce((total, line) => total + line.unitGrossCents * line.quantity, 0)
    const parcels = variants.map((variant): Parcel => ({
      weightGrams: variant.weight_grams * quantityByVariant.get(variant.legacy_id)!,
      widthMm: variant.width_mm,
      heightMm: variant.height_mm,
      depthMm: variant.depth_mm,
      contents: [{ sku: variant.sku, quantity: quantityByVariant.get(variant.legacy_id)! }],
      handling: variant.shipping_profile === 'adr' ? 'adr' : variant.shipping_profile === 'pallet' ? 'pallet' : 'parcel'
    }))
    const shippingProfile = classifyShipment(parcels)
    const chargeableGrams = parcels.reduce((total, parcel) => total + chargeableWeightGrams(parcel), 0)
    const standardShippingNet = standardShippingNetCents(shippingProfile, chargeableGrams)
    const standardShippingGross = standardShippingNet + Math.round((standardShippingNet * 2100) / 10_000)
    const commercialPolicy = shippingCommercialPolicy()
    const freeParcelShipping =
      commercialPolicy.freeShippingThresholdCents !== null &&
      goodsGross >= commercialPolicy.freeShippingThresholdCents &&
      ['parcel', 'multi_parcel'].includes(shippingProfile)
    const shippingGross = input.shippingMethod === 'envio' && !freeParcelShipping ? standardShippingGross : 0
    if (
      input.shippingMethod === 'reparto' &&
      !commercialPolicy.ownDeliveryPostalPrefixes.some((prefix) => input.shippingAddress.postalCode.startsWith(prefix))
    ) {
      throw createError({ statusCode: 422, statusMessage: 'El código postal está fuera del reparto propio' })
    }
    if (input.shippingMethod === 'reparto' && !['parcel', 'multi_parcel'].includes(shippingProfile)) {
      throw createError({ statusCode: 422, statusMessage: 'La mercancía no es compatible con reparto propio' })
    }
    const quote = calculateQuote({
      pricingVersion: `catalog:${variants
        .map((variant) => variant.source_version ?? 'unknown')
        .sort()
        .join('+')}`,
      lines,
      shippingGrossCents: shippingGross,
      shippingTaxRateBasisPoints: 2100
    })

    const orderId = randomUUID()
    const publicNumber = publicOrderNumber()
    const expiresAt = new Date(
      Date.now() +
        (input.paymentMethod === 'transferencia'
          ? TRANSFER_RESERVATION_HOURS * 60 * 60_000
          : CHECKOUT_RESERVATION_MINUTES * 60_000)
    )

    for (const variant of variants) {
      const [balance] = await transaction<InventoryRecord[]>`
        SELECT location_id, physical_quantity, blocked_quantity
        FROM inventory_balances
        WHERE variant_id = ${variant.id}
        ORDER BY physical_quantity DESC, location_id
        LIMIT 1
        FOR UPDATE
      `
      if (!balance) {
        throw createError({ statusCode: 409, statusMessage: `Sin inventario configurado para ${variant.sku}` })
      }
      const [reservation] = await transaction<{ quantity: number }[]>`
        SELECT COALESCE(sum(quantity), 0)::int AS quantity
        FROM inventory_reservations
        WHERE variant_id = ${variant.id}
          AND location_id = ${balance.location_id}
          AND status = 'active'
          AND expires_at > now()
      `
      const available = sellableQuantity({
        physicalQuantity: balance.physical_quantity,
        reservedQuantity: reservation?.quantity ?? 0,
        blockedQuantity: balance.blocked_quantity,
        safetyStock: variant.safety_stock,
        backorderAllowed: variant.backorder_allowed
      })
      const quantity = quantityByVariant.get(variant.legacy_id)!
      if (!variant.backorder_allowed && quantity > available) {
        throw createError({
          statusCode: 409,
          statusMessage: `Stock insuficiente para ${variant.name} · ${variant.format}`
        })
      }
    }

    const normalizedEmail = input.customer.email.trim().toLowerCase()
    const [customer] = await transaction<{ id: string }[]>`
      INSERT INTO customers (email, name, phone)
      VALUES (${normalizedEmail}, ${input.customer.name.trim()}, ${input.customer.phone.trim()})
      ON CONFLICT (email) WHERE email IS NOT NULL AND merged_into_id IS NULL DO UPDATE SET
        name = EXCLUDED.name,
        phone = EXCLUDED.phone,
        updated_at = now()
      RETURNING id
    `
    if (!customer) throw new Error('Customer upsert returned no row')

    const addressSnapshot = (address: CheckoutAddress) => ({
      recipientName: address.recipientName.trim(),
      companyName: address.companyName.trim() || null,
      taxId: address.taxId.trim() || null,
      line1: address.line1.trim(),
      line2: address.line2.trim() || null,
      postalCode: address.postalCode.trim(),
      city: address.city.trim(),
      region: address.region.trim(),
      countryCode: address.countryCode,
      phone: address.phone.trim(),
      instructions: address.instructions.trim() || null
    })
    const shippingSnapshot = {
      ...addressSnapshot(input.shippingAddress),
      shippingProfile,
      serviceCode:
        input.shippingMethod === 'recogida'
          ? 'WAREHOUSE-PICKUP'
          : input.shippingMethod === 'reparto'
            ? 'OWN-DAY'
            : `STANDARD-${shippingProfile.toUpperCase()}`
    }
    const billingSnapshot = addressSnapshot(input.billingAddress)
    const customerSnapshot = {
      name: input.customer.name.trim(),
      company: input.customer.company.trim() || null,
      taxId: input.customer.nif.trim() || null,
      email: normalizedEmail,
      phone: input.customer.phone.trim()
    }
    const termsSnapshot = {
      accepted: input.termsAccepted,
      acceptedAt: new Date().toISOString(),
      termsVersion: TERMS_VERSION,
      privacyVersion: PRIVACY_VERSION
    }
    const [order] = await transaction<ExistingOrder[]>`
      INSERT INTO orders (
        id, public_number, guest_access_hash, guest_access_expires_at, cart_id, customer_id, order_status, payment_status,
        inventory_status, fulfillment_status, invoice_status, currency, subtotal_net_cents,
        discount_net_cents, shipping_net_cents, tax_cents, total_gross_cents, shipping_method,
        payment_method, billing_snapshot, shipping_snapshot, customer_snapshot, terms_snapshot,
        pricing_version, correlation_id, idempotency_key, expires_at
      ) VALUES (
        ${orderId}, ${publicNumber}, ${guestAccessHash}, ${new Date(Date.now() + 30 * 24 * 60 * 60_000)},
        ${cart.id}, ${customer.id}, 'awaiting_payment',
        ${input.paymentMethod === 'transferencia' ? 'pending' : 'initiated'}, 'reserved', 'pending',
        'not_requested', 'EUR', ${quote.subtotalNetCents}, 0, ${quote.shipping.netCents},
        ${quote.taxCents}, ${quote.totalGrossCents}, ${input.shippingMethod}, ${input.paymentMethod},
        ${transaction.json(billingSnapshot)}, ${transaction.json(shippingSnapshot)},
        ${transaction.json(customerSnapshot)}, ${transaction.json(termsSnapshot)}, ${quote.pricingVersion},
        ${input.correlationId}, ${input.idempotencyKey}, ${expiresAt}
      )
      RETURNING id, public_number, guest_access_hash, payment_method, payment_status,
                total_gross_cents, expires_at
    `
    if (!order) throw new Error('Order insert returned no row')

    for (const variant of variants) {
      const quantity = quantityByVariant.get(variant.legacy_id)!
      const quoted = quote.lines.find((line) => line.variantId === variant.id)!
      const [balance] = await transaction<InventoryRecord[]>`
        SELECT location_id, physical_quantity, blocked_quantity
        FROM inventory_balances
        WHERE variant_id = ${variant.id}
        ORDER BY physical_quantity DESC, location_id
        LIMIT 1
      `
      if (!balance) throw new Error('Locked inventory balance disappeared')
      await transaction`
        INSERT INTO order_lines (
          order_id, product_id, variant_id, sku, name, variant_name, quantity, unit_label,
          unit_net_cents, discount_net_cents, tax_rate_basis_points, tax_cents,
          total_gross_cents, regulatory_snapshot, logistics_snapshot
        ) VALUES (
          ${orderId}, ${variant.product_id}, ${variant.id}, ${variant.sku}, ${variant.name},
          ${variant.format}, ${quantity}, ${variant.unit_label},
          ${Math.floor(quoted.netCents / quantity)}, 0, ${quoted.taxRateBasisPoints},
          ${quoted.taxCents}, ${quoted.grossCents}, ${transaction.json({})},
          ${transaction.json({
            unitGrossCents: variant.price_gross_cents,
            profile: variant.shipping_profile,
            weightGrams: variant.weight_grams,
            widthMm: variant.width_mm,
            heightMm: variant.height_mm,
            depthMm: variant.depth_mm
          })}
        )
      `
      await transaction`
        INSERT INTO inventory_reservations (
          variant_id, location_id, order_id, quantity, status, expires_at, idempotency_key
        ) VALUES (
          ${variant.id}, ${balance.location_id}, ${orderId}, ${quantity}, 'active', ${expiresAt},
          ${`${input.idempotencyKey}:reserve:${variant.id}`}
        )
      `
      await transaction`
        INSERT INTO inventory_movements (
          variant_id, location_id, movement_type, quantity, physical_delta, reserved_delta,
          reference_type, reference_id,
          reason, idempotency_key
        ) VALUES (
          ${variant.id}, ${balance.location_id}, 'reserve', ${-quantity}, 0, ${quantity}, 'order', ${orderId},
          'Checkout stock reservation', ${`${input.idempotencyKey}:reserve-movement:${variant.id}`}
        )
      `
    }

    const paymentProvider = input.paymentMethod === 'transferencia' ? 'bank-transfer' : 'redsys'
    await transaction`
      INSERT INTO payment_intents (
        order_id, provider, method, status, amount_cents, currency, idempotency_key, expires_at
      ) VALUES (
        ${orderId}, ${paymentProvider}, ${input.paymentMethod},
        ${input.paymentMethod === 'transferencia' ? 'pending' : 'initiated'},
        ${quote.totalGrossCents}, 'EUR', ${`${input.idempotencyKey}:payment`}, ${expiresAt}
      )
    `
    await transaction`
      INSERT INTO order_events (
        order_id, event_type, actor_type, origin, to_state, public_data, private_data,
        correlation_id, idempotency_key
      ) VALUES (
        ${orderId}, 'order.created', 'customer', 'storefront',
        ${transaction.json({ order: 'awaiting_payment', payment: input.paymentMethod === 'transferencia' ? 'pending' : 'initiated', inventory: 'reserved' })},
        ${transaction.json({ publicNumber })}, ${transaction.json({})}, ${input.correlationId},
        ${`${input.idempotencyKey}:created`}
      )
    `
    await transaction`
      INSERT INTO consent_events (customer_id, purpose, channel, action, policy_version, text_hash, source)
      VALUES (
        ${customer.id}, 'purchase_terms', 'web', 'granted', ${TERMS_VERSION},
        encode(digest(${TERMS_VERSION}, 'sha256'), 'hex'), 'checkout'
      )
    `
    if (input.marketingConsent) {
      await transaction`
        INSERT INTO consent_events (customer_id, purpose, channel, action, policy_version, text_hash, source)
        VALUES (
          ${customer.id}, 'newsletter', 'email', 'granted', ${PRIVACY_VERSION},
          encode(digest(${`newsletter:${PRIVACY_VERSION}`}, 'sha256'), 'hex'), 'checkout'
        )
      `
      await transaction`
        INSERT INTO customer_preferences (customer_id, purpose, channel, enabled, frequency)
        VALUES (${customer.id}, 'newsletter', 'email', true, 'weekly')
        ON CONFLICT (customer_id, purpose, channel) DO UPDATE
        SET enabled = true, updated_at = now()
      `
    }
    await transaction`
      INSERT INTO outbox_events (
        aggregate_type, aggregate_id, event_type, payload, correlation_id, idempotency_key
      ) VALUES (
        'order', ${orderId}, 'order.created',
        ${transaction.json({ orderId, publicNumber, tokenEnvelope: input.guestTokenEnvelope })},
        ${input.correlationId}, ${`${input.idempotencyKey}:outbox:created`}
      )
    `
    await transaction`
      UPDATE carts SET status = 'converted', updated_at = now() WHERE id = ${cart.id}
    `

    return orderResponse(order, input.guestToken)
  })
}

interface PaymentOrderRecord extends ExistingOrder {
  order_currency: string
  order_status: string
  inventory_status: string
  payment_intent_id: string
  payment_intent_status: string
  amount_cents: number
  payment_currency: string
  provider: string
  method: string
  idempotency_key: string
}

async function lockedPaymentOrder(transaction: TransactionSql, publicNumber: string) {
  const [order] = await transaction<PaymentOrderRecord[]>`
    SELECT o.id, o.public_number, o.guest_access_hash, o.currency AS order_currency,
           o.order_status, o.payment_status,
           o.inventory_status, o.payment_method, o.total_gross_cents, o.expires_at,
           pi.id AS payment_intent_id, pi.status AS payment_intent_status,
           pi.amount_cents, pi.currency AS payment_currency, pi.provider, pi.method, pi.idempotency_key
    FROM orders o
    JOIN payment_intents pi ON pi.order_id = o.id
    WHERE o.public_number = ${publicNumber}
    FOR UPDATE OF o, pi
  `
  return order
}

async function holdCapturedOrder(
  transaction: TransactionSql,
  order: PaymentOrderRecord,
  correlationId: string,
  providerEventId: string,
  providerReference: string,
  reason: string,
  privateData: Record<string, unknown> = {}
) {
  await transaction`
    UPDATE payment_intents
    SET status = 'captured', provider_reference = COALESCE(provider_reference, ${providerReference}), updated_at = now()
    WHERE id = ${order.payment_intent_id}
  `
  await transaction`
    UPDATE orders
    SET order_status = 'on_hold', payment_status = 'captured', updated_at = now()
    WHERE id = ${order.id}
  `
  await transaction`
    INSERT INTO order_events (
      order_id, event_type, actor_type, origin, from_state, to_state, public_data,
      private_data, correlation_id, idempotency_key
    ) VALUES (
      ${order.id}, 'payment.captured_without_stock', 'provider', ${order.provider},
      ${transaction.json({ order: order.order_status, payment: order.payment_status, inventory: order.inventory_status })},
      ${transaction.json({ order: 'on_hold', payment: 'captured', inventory: order.inventory_status })},
      ${transaction.json({ actionRequired: true })},
      ${transaction.json({ providerEventId, reason, ...privateData })},
      ${correlationId}, ${`payment:${providerEventId}:captured-without-stock`}
    ) ON CONFLICT (order_id, idempotency_key) DO NOTHING
  `
  await transaction`
    INSERT INTO outbox_events (
      aggregate_type, aggregate_id, event_type, payload, correlation_id, idempotency_key
    ) VALUES (
      'order', ${order.id}, 'payment.refund.review.requested',
      ${transaction.json({ orderId: order.id, orderNumber: order.public_number, reason })},
      ${correlationId}, ${`refund-review:${order.id}:${providerEventId}`}
    ) ON CONFLICT (idempotency_key) DO NOTHING
  `
}

async function allocateOrder(
  transaction: TransactionSql,
  order: PaymentOrderRecord,
  correlationId: string,
  providerEventId: string,
  providerReference = providerEventId
) {
  if (['captured', 'partially_refunded', 'refunded', 'chargeback'].includes(order.payment_status)) return
  const reservations = await transaction<{ id: string; variant_id: string; location_id: string; quantity: number }[]>`
    SELECT id, variant_id, location_id, quantity
    FROM inventory_reservations
    WHERE order_id = ${order.id} AND status = 'active'
    ORDER BY variant_id, location_id, id
    FOR UPDATE
  `
  const lateOrCancelled =
    order.order_status === 'cancelled' ||
    ['failed', 'cancelled'].includes(order.payment_status) ||
    (!!order.expires_at && order.expires_at <= new Date())
  if (lateOrCancelled) {
    for (const reservation of reservations) {
      await transaction`
        UPDATE inventory_reservations SET status = 'released', updated_at = now()
        WHERE id = ${reservation.id} AND status = 'active'
      `
      await transaction`
        INSERT INTO inventory_movements (
          variant_id, location_id, movement_type, quantity, physical_delta, reserved_delta,
          reference_type, reference_id,
          reason, idempotency_key
        ) VALUES (
          ${reservation.variant_id}, ${reservation.location_id}, 'release', ${reservation.quantity},
          0, ${-reservation.quantity},
          'order', ${order.id}, 'Late capture after order expiry or cancellation',
          ${`${order.idempotency_key}:late-capture-release:${reservation.id}`}
        ) ON CONFLICT (idempotency_key) DO NOTHING
      `
    }
    if (reservations.length > 0) {
      await transaction`
        UPDATE orders SET inventory_status = 'released', updated_at = now() WHERE id = ${order.id}
      `
      order.inventory_status = 'released'
    }
    await holdCapturedOrder(
      transaction,
      order,
      correlationId,
      providerEventId,
      providerReference,
      order.order_status === 'cancelled' ? 'order_cancelled' : 'reservation_expired'
    )
    return
  }
  if (reservations.length === 0 && order.inventory_status !== 'allocated') {
    await holdCapturedOrder(
      transaction,
      order,
      correlationId,
      providerEventId,
      providerReference,
      'reservation_missing'
    )
    return
  }

  const unavailable: string[] = []
  for (const reservation of reservations) {
    const [balance] = await transaction<{ physical_quantity: number }[]>`
      SELECT physical_quantity
      FROM inventory_balances
      WHERE variant_id = ${reservation.variant_id} AND location_id = ${reservation.location_id}
      FOR UPDATE
    `
    if (!balance || balance.physical_quantity < reservation.quantity) unavailable.push(reservation.id)
  }
  if (unavailable.length > 0) {
    await transaction`
      UPDATE inventory_reservations
      SET expires_at = GREATEST(expires_at, now() + interval '7 days'), updated_at = now()
      WHERE order_id = ${order.id} AND status = 'active'
    `
    await holdCapturedOrder(
      transaction,
      order,
      correlationId,
      providerEventId,
      providerReference,
      'insufficient_physical_stock',
      { unavailableReservationIds: unavailable }
    )
    return
  }

  for (const reservation of reservations) {
    await transaction`
      UPDATE inventory_balances
      SET physical_quantity = physical_quantity - ${reservation.quantity},
          version = version + 1,
          updated_at = now()
      WHERE variant_id = ${reservation.variant_id} AND location_id = ${reservation.location_id}
    `
    await transaction`
      UPDATE inventory_reservations
      SET status = 'allocated', updated_at = now()
      WHERE id = ${reservation.id} AND status = 'active'
    `
    await transaction`
      INSERT INTO inventory_movements (
        variant_id, location_id, movement_type, quantity, physical_delta, reserved_delta,
        reference_type, reference_id,
        reason, idempotency_key
      ) VALUES (
        ${reservation.variant_id}, ${reservation.location_id}, 'allocate', ${-reservation.quantity},
        ${-reservation.quantity}, ${-reservation.quantity}, 'order', ${order.id}, 'Payment captured',
        ${`${order.idempotency_key}:allocate:${reservation.id}`}
      ) ON CONFLICT (idempotency_key) DO NOTHING
    `
    await transaction`
      INSERT INTO fulfillments (order_id, location_id, status)
      VALUES (${order.id}, ${reservation.location_id}, 'pending')
      ON CONFLICT (order_id, location_id) DO NOTHING
    `
  }
  await transaction`
    UPDATE payment_intents
    SET status = 'captured', provider_reference = COALESCE(provider_reference, ${providerReference}), updated_at = now()
    WHERE id = ${order.payment_intent_id}
  `
  await transaction`
    UPDATE orders
    SET order_status = 'confirmed', payment_status = 'captured', inventory_status = 'allocated',
        invoice_status = 'queued', confirmed_at = COALESCE(confirmed_at, now()), updated_at = now()
    WHERE id = ${order.id}
  `
  await transaction`
    INSERT INTO order_events (
      order_id, event_type, actor_type, origin, from_state, to_state, public_data,
      private_data, correlation_id, idempotency_key
    ) VALUES (
      ${order.id}, 'payment.captured', 'provider', ${order.provider},
      ${transaction.json({ order: order.order_status, payment: order.payment_status, inventory: order.inventory_status })},
      ${transaction.json({ order: 'confirmed', payment: 'captured', inventory: 'allocated', invoice: 'queued' })},
      ${transaction.json({})}, ${transaction.json({ providerEventId })}, ${correlationId},
      ${`payment:${providerEventId}:captured`}
    ) ON CONFLICT (order_id, idempotency_key) DO NOTHING
  `
  await transaction`
    INSERT INTO outbox_events (
      aggregate_type, aggregate_id, event_type, payload, correlation_id, idempotency_key
    ) VALUES (
      'order', ${order.id}, 'invoice.issue.requested',
      ${transaction.json({ orderId: order.id, orderNumber: order.public_number })},
      ${correlationId}, ${`invoice:${order.id}:issue:v1`}
    ) ON CONFLICT (idempotency_key) DO NOTHING
  `
  await transaction`
    INSERT INTO outbox_events (
      aggregate_type, aggregate_id, event_type, payload, correlation_id, idempotency_key
    ) VALUES (
      'order', ${order.id}, 'order.confirmed',
      ${transaction.json({ orderId: order.id, orderNumber: order.public_number })},
      ${correlationId}, ${`order:${order.id}:confirmed`}
    ) ON CONFLICT (idempotency_key) DO NOTHING
  `
  await transaction`
    INSERT INTO analytics_events (
      event_id, event_name, source, order_id, dedupe_key, properties, occurred_at
    ) VALUES (
      gen_random_uuid(), 'order_confirmed', 'server', ${order.id}, ${`order:${order.id}:confirmed`},
      ${transaction.json({
        orderNumber: order.public_number,
        totalCents: order.total_gross_cents,
        currency: order.order_currency,
        paymentMethod: order.payment_method
      })}, now()
    ) ON CONFLICT (dedupe_key) DO NOTHING
  `
}

async function authorizeOrder(
  transaction: TransactionSql,
  order: PaymentOrderRecord,
  correlationId: string,
  providerEventId: string,
  providerReference = providerEventId
) {
  if (!['initiated', 'pending'].includes(order.payment_status)) return
  await transaction`
    UPDATE inventory_reservations
    SET expires_at = 'infinity'::timestamptz, updated_at = now()
    WHERE order_id = ${order.id} AND status = 'active'
  `
  await transaction`
    UPDATE payment_intents
    SET status = 'authorized', provider_reference = COALESCE(provider_reference, ${providerReference}), updated_at = now()
    WHERE id = ${order.payment_intent_id}
  `
  await transaction`
    UPDATE orders SET payment_status = 'authorized', expires_at = NULL, updated_at = now()
    WHERE id = ${order.id}
  `
  await transaction`
    INSERT INTO order_events (
      order_id, event_type, actor_type, origin, from_state, to_state, public_data,
      private_data, correlation_id, idempotency_key
    ) VALUES (
      ${order.id}, 'payment.authorized', 'provider', ${order.provider},
      ${transaction.json({ payment: order.payment_status })}, ${transaction.json({ payment: 'authorized' })},
      ${transaction.json({})}, ${transaction.json({ providerEventId })}, ${correlationId},
      ${`payment:${providerEventId}:authorized`}
    ) ON CONFLICT (order_id, idempotency_key) DO NOTHING
  `
}

async function releaseOrder(
  transaction: TransactionSql,
  order: PaymentOrderRecord,
  correlationId: string,
  providerEventId: string
) {
  if (!['initiated', 'pending', 'authorized', 'failed'].includes(order.payment_status)) return
  const reservations = await transaction<{ id: string; variant_id: string; location_id: string; quantity: number }[]>`
    UPDATE inventory_reservations
    SET status = 'released', updated_at = now()
    WHERE order_id = ${order.id} AND status = 'active'
    RETURNING id, variant_id, location_id, quantity
  `
  for (const reservation of reservations) {
    await transaction`
      INSERT INTO inventory_movements (
        variant_id, location_id, movement_type, quantity, physical_delta, reserved_delta,
        reference_type, reference_id,
        reason, idempotency_key
      ) VALUES (
        ${reservation.variant_id}, ${reservation.location_id}, 'release', ${reservation.quantity},
        0, ${-reservation.quantity},
        'order', ${order.id}, 'Payment cancelled',
        ${`${order.idempotency_key}:release:${reservation.id}`}
      ) ON CONFLICT (idempotency_key) DO NOTHING
    `
  }
  await transaction`
    UPDATE payment_intents SET status = 'cancelled', updated_at = now() WHERE id = ${order.payment_intent_id}
  `
  await transaction`
    UPDATE orders
    SET order_status = 'cancelled', payment_status = 'cancelled', inventory_status = 'released', updated_at = now()
    WHERE id = ${order.id}
  `
  await transaction`
    INSERT INTO order_events (
      order_id, event_type, actor_type, origin, from_state, to_state, public_data,
      private_data, correlation_id, idempotency_key
    ) VALUES (
      ${order.id}, 'payment.cancelled', 'provider', ${order.provider},
      ${transaction.json({ order: order.order_status, payment: order.payment_status, inventory: order.inventory_status })},
      ${transaction.json({ order: 'cancelled', payment: 'cancelled', inventory: 'released' })},
      ${transaction.json({})}, ${transaction.json({ providerEventId })}, ${correlationId},
      ${`payment:${providerEventId}:cancelled`}
    ) ON CONFLICT (order_id, idempotency_key) DO NOTHING
  `
}

export async function confirmMockPayment(input: {
  publicNumber: string
  guestToken: string
  method: 'tarjeta' | 'bizum'
  correlationId: string
}) {
  return inSerializableTransaction(async (transaction) => {
    const order = await lockedPaymentOrder(transaction, input.publicNumber)
    if (!order || order.guest_access_hash !== hashAccessToken(input.guestToken)) {
      throw createError({ statusCode: 404, statusMessage: 'Pedido no encontrado' })
    }
    if (order.method !== input.method || order.provider !== 'redsys') {
      throw createError({ statusCode: 409, statusMessage: 'El método de pago no coincide con el pedido' })
    }
    if (order.order_status === 'cancelled') {
      throw createError({ statusCode: 409, statusMessage: 'El pedido está cancelado' })
    }
    if (order.expires_at && order.expires_at.getTime() <= Date.now()) {
      throw createError({ statusCode: 410, statusMessage: 'La reserva de stock ha caducado' })
    }
    const providerEventId = `mock:${order.public_number}:captured`
    await transaction`
      INSERT INTO payment_events (
        payment_intent_id, provider_event_id, event_type, status, amount_cents,
        response_code, payload_hash, sanitized_payload, correlation_id
      ) VALUES (
        ${order.payment_intent_id}, ${providerEventId}, 'payment.captured', 'captured', ${order.amount_cents},
        '0000', encode(digest(${providerEventId}, 'sha256'), 'hex'), ${transaction.json({ provider: 'mock' })},
        ${input.correlationId}
      ) ON CONFLICT (payment_intent_id, provider_event_id) DO NOTHING
    `
    await allocateOrder(transaction, order, input.correlationId, providerEventId)
    return orderResponse({ ...order, payment_status: 'captured' }, input.guestToken)
  })
}

export async function markPaymentRedirectPending(input: {
  publicNumber: string
  guestToken: string
  method: 'tarjeta' | 'bizum'
}) {
  return inSerializableTransaction(async (transaction) => {
    const order = await lockedPaymentOrder(transaction, input.publicNumber)
    if (!order || order.guest_access_hash !== hashAccessToken(input.guestToken)) {
      throw createError({ statusCode: 404, statusMessage: 'Pedido no encontrado' })
    }
    if (order.method !== input.method || order.provider !== 'redsys') {
      throw createError({ statusCode: 409, statusMessage: 'El método de pago no coincide con el pedido' })
    }
    if (!['initiated', 'failed', 'pending'].includes(order.payment_intent_status)) {
      throw createError({ statusCode: 409, statusMessage: 'Este pedido no admite un nuevo intento de pago' })
    }
    if (order.expires_at && order.expires_at.getTime() <= Date.now()) {
      throw createError({ statusCode: 410, statusMessage: 'La reserva de stock ha caducado' })
    }
    await transaction`
      UPDATE payment_intents SET status = 'pending', updated_at = now() WHERE id = ${order.payment_intent_id}
    `
    await transaction`
      UPDATE orders SET payment_status = 'pending', updated_at = now() WHERE id = ${order.id}
    `
    return order
  })
}

export async function processPaymentNotification(notification: PaymentNotification, correlationId: string) {
  return inSerializableTransaction(async (transaction) => {
    const inserted = await transaction<{ id: string }[]>`
      INSERT INTO webhook_inbox (
        provider, provider_event_id, payload_hash, sanitized_payload, signature_valid, status, correlation_id
      ) VALUES (
        'redsys', ${notification.providerEventId}, ${notification.payloadHash},
        ${transaction.json({
          orderReference: notification.orderReference,
          amountCents: notification.amountCents,
          currency: notification.currency,
          status: notification.status,
          responseCode: notification.responseCode,
          providerReference: notification.providerReference
        })}, true, 'processing', ${correlationId}
      ) ON CONFLICT DO NOTHING
      RETURNING id
    `
    if (!inserted[0]) return { accepted: true, duplicate: true }

    const order = await lockedPaymentOrder(transaction, notification.orderReference)
    if (!order || order.provider !== 'redsys') {
      await transaction`
        UPDATE webhook_inbox SET status = 'rejected', processed_at = now() WHERE id = ${inserted[0].id}
      `
      return { accepted: false, duplicate: false, reason: 'order_not_found' }
    }
    if (
      order.amount_cents !== notification.amountCents ||
      order.total_gross_cents !== notification.amountCents ||
      notification.currency !== 'EUR' ||
      order.order_currency !== notification.currency ||
      order.payment_currency !== notification.currency
    ) {
      await transaction`
        UPDATE webhook_inbox SET status = 'rejected', processed_at = now() WHERE id = ${inserted[0].id}
      `
      return { accepted: false, duplicate: false, reason: 'amount_mismatch' }
    }
    await transaction`
      INSERT INTO payment_events (
        payment_intent_id, provider_event_id, event_type, status, amount_cents,
        response_code, payload_hash, sanitized_payload, correlation_id
      ) VALUES (
        ${order.payment_intent_id}, ${notification.providerEventId}, ${`payment.${notification.status}`},
        ${notification.status}, ${notification.amountCents}, ${notification.responseCode},
        ${notification.payloadHash}, ${transaction.json({ responseCode: notification.responseCode })},
        ${correlationId}
      ) ON CONFLICT (payment_intent_id, provider_event_id) DO NOTHING
    `
    if (notification.status === 'captured') {
      await allocateOrder(
        transaction,
        order,
        correlationId,
        notification.providerEventId,
        notification.providerReference
      )
    } else if (notification.status === 'authorized') {
      await authorizeOrder(
        transaction,
        order,
        correlationId,
        notification.providerEventId,
        notification.providerReference
      )
    } else if (notification.status === 'cancelled') {
      await releaseOrder(transaction, order, correlationId, notification.providerEventId)
    } else if (!['authorized', 'captured', 'cancelled'].includes(order.payment_status)) {
      await transaction`
        UPDATE payment_intents SET status = ${notification.status}, updated_at = now()
        WHERE id = ${order.payment_intent_id} AND status <> 'captured'
      `
      await transaction`
        UPDATE orders SET payment_status = ${notification.status}, updated_at = now()
        WHERE id = ${order.id} AND payment_status <> 'captured'
      `
    }
    await transaction`
      UPDATE webhook_inbox SET status = 'processed', processed_at = now() WHERE id = ${inserted[0].id}
    `
    return { accepted: true, duplicate: false }
  })
}

export async function recordRejectedWebhook(input: { payloadHash: string; correlationId: string; reason: string }) {
  const sql = useDatabase()
  await sql`
    INSERT INTO webhook_inbox (
      provider, payload_hash, sanitized_payload, signature_valid, status, correlation_id, processed_at
    ) VALUES (
      'redsys', ${input.payloadHash}, ${sql.json({ reason: input.reason })}, false, 'rejected',
      ${input.correlationId}, now()
    ) ON CONFLICT (provider, payload_hash) DO NOTHING
  `
}

export async function expireInventoryReservations(limit = 100) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) throw new RangeError('Expiry batch limit is invalid')
  const correlationId = randomUUID()
  return inSerializableTransaction(async (transaction) => {
    const orders = await transaction<PaymentOrderRecord[]>`
      SELECT o.id, o.public_number, o.guest_access_hash, o.order_status, o.payment_status,
             o.inventory_status, o.payment_method, o.total_gross_cents, o.expires_at,
             pi.id AS payment_intent_id, pi.status AS payment_intent_status,
             pi.amount_cents, pi.provider, pi.method, pi.idempotency_key
      FROM orders o
      JOIN payment_intents pi ON pi.order_id = o.id
      WHERE o.expires_at <= now()
        AND o.payment_status NOT IN ('captured', 'authorized')
        AND EXISTS (
          SELECT 1 FROM inventory_reservations reservation
          WHERE reservation.order_id = o.id AND reservation.status = 'active'
        )
      ORDER BY o.expires_at, o.id
      LIMIT ${limit}
      FOR UPDATE OF o, pi SKIP LOCKED
    `
    for (const order of orders) {
      const reservations = await transaction<
        { id: string; variant_id: string; location_id: string; quantity: number }[]
      >`
        UPDATE inventory_reservations
        SET status = 'expired', updated_at = now()
        WHERE order_id = ${order.id} AND status = 'active'
        RETURNING id, variant_id, location_id, quantity
      `
      for (const reservation of reservations) {
        await transaction`
          INSERT INTO inventory_movements (
            variant_id, location_id, movement_type, quantity, physical_delta, reserved_delta,
            reference_type, reference_id,
            reason, idempotency_key
          ) VALUES (
            ${reservation.variant_id}, ${reservation.location_id}, 'release', ${reservation.quantity},
            0, ${-reservation.quantity},
            'order', ${order.id}, 'Reservation TTL expired',
            ${`${order.idempotency_key}:expiry-release:${reservation.id}`}
          ) ON CONFLICT (idempotency_key) DO NOTHING
        `
      }
      await transaction`
        UPDATE payment_intents SET status = 'cancelled', updated_at = now()
        WHERE id = ${order.payment_intent_id} AND status NOT IN ('captured', 'authorized')
      `
      await transaction`
        UPDATE orders
        SET order_status = 'cancelled', payment_status = 'cancelled', inventory_status = 'released', updated_at = now()
        WHERE id = ${order.id} AND payment_status NOT IN ('captured', 'authorized')
      `
      await transaction`
        INSERT INTO order_events (
          order_id, event_type, actor_type, origin, from_state, to_state, public_data,
          private_data, correlation_id, idempotency_key
        ) VALUES (
          ${order.id}, 'reservation.expired', 'system', 'reservation-worker',
          ${transaction.json({ order: order.order_status, payment: order.payment_status, inventory: order.inventory_status })},
          ${transaction.json({ order: 'cancelled', payment: 'cancelled', inventory: 'released' })},
          ${transaction.json({})}, ${transaction.json({ expiresAt: order.expires_at?.toISOString() })},
          ${correlationId}, ${`reservation:${order.id}:expired`}
        ) ON CONFLICT (order_id, idempotency_key) DO NOTHING
      `
      await transaction`
        INSERT INTO outbox_events (
          aggregate_type, aggregate_id, event_type, payload, correlation_id, idempotency_key
        ) VALUES (
          'order', ${order.id}, 'order.reservation.expired',
          ${transaction.json({ orderId: order.id, orderNumber: order.public_number })},
          ${correlationId}, ${`order:${order.id}:reservation-expired`}
        ) ON CONFLICT (idempotency_key) DO NOTHING
      `
    }
    return { correlationId, expiredOrders: orders.length }
  })
}

export async function cancelOrderByAdmin(input: {
  publicNumber: string
  actorId: string
  reason: string
  correlationId: string
}) {
  return inSerializableTransaction(async (transaction) => {
    const [order] = await transaction<
      Array<
        PaymentOrderRecord & {
          fulfillment_status: string
          invoice_status: string
        }
      >
    >`
      SELECT o.id, o.public_number, o.guest_access_hash, o.currency AS order_currency,
             o.order_status, o.payment_status, o.inventory_status, o.fulfillment_status,
             o.invoice_status, o.payment_method, o.total_gross_cents, o.expires_at,
             pi.id AS payment_intent_id, pi.status AS payment_intent_status,
             pi.amount_cents, pi.currency AS payment_currency, pi.provider, pi.method, pi.idempotency_key
      FROM orders o
      JOIN payment_intents pi ON pi.order_id = o.id
      WHERE o.public_number = ${input.publicNumber}
      FOR UPDATE OF o, pi
    `
    if (!order) throw createError({ statusCode: 404, statusMessage: 'Pedido no encontrado' })
    if (order.order_status === 'cancelled') {
      return { id: input.publicNumber, orderStatus: 'cancelled', duplicate: true }
    }
    if (order.fulfillment_status !== 'pending') {
      throw createError({
        statusCode: 409,
        statusMessage: 'El pedido ya está en preparación o expedición; debe tramitarse como devolución'
      })
    }

    const active = await transaction<{ id: string; variant_id: string; location_id: string; quantity: number }[]>`
      UPDATE inventory_reservations SET status = 'released', updated_at = now()
      WHERE order_id = ${order.id} AND status = 'active'
      RETURNING id, variant_id, location_id, quantity
    `
    for (const reservation of active) {
      await transaction`
        INSERT INTO inventory_movements (
          variant_id, location_id, movement_type, quantity, physical_delta, reserved_delta,
          reference_type, reference_id, actor_id, reason, idempotency_key
        ) VALUES (
          ${reservation.variant_id}, ${reservation.location_id}, 'release', ${reservation.quantity},
          0, ${-reservation.quantity}, 'order', ${order.id}, ${input.actorId}, ${input.reason},
          ${`${order.idempotency_key}:admin-cancel-release:${reservation.id}`}
        ) ON CONFLICT (idempotency_key) DO NOTHING
      `
    }

    const allocated = await transaction<{ id: string; variant_id: string; location_id: string; quantity: number }[]>`
      UPDATE inventory_reservations SET status = 'released', updated_at = now()
      WHERE order_id = ${order.id} AND status = 'allocated'
      RETURNING id, variant_id, location_id, quantity
    `
    for (const reservation of allocated) {
      await transaction`
        UPDATE inventory_balances
        SET physical_quantity = physical_quantity + ${reservation.quantity},
            version = version + 1,
            updated_at = now()
        WHERE variant_id = ${reservation.variant_id} AND location_id = ${reservation.location_id}
      `
      await transaction`
        INSERT INTO inventory_movements (
          variant_id, location_id, movement_type, quantity, physical_delta, reserved_delta,
          reference_type, reference_id, actor_id, reason, idempotency_key
        ) VALUES (
          ${reservation.variant_id}, ${reservation.location_id}, 'return', ${reservation.quantity},
          ${reservation.quantity}, 0, 'order', ${order.id}, ${input.actorId}, ${input.reason},
          ${`${order.idempotency_key}:admin-cancel-restock:${reservation.id}`}
        ) ON CONFLICT (idempotency_key) DO NOTHING
      `
    }

    const authorizedOnly = order.payment_status === 'authorized'
    const paid = ['captured', 'partially_refunded'].includes(order.payment_status)
    let refundId: string | null = null
    if (authorizedOnly) {
      await transaction`
        INSERT INTO outbox_events (
          aggregate_type, aggregate_id, event_type, payload, correlation_id, idempotency_key
        ) VALUES (
          'payment_intent', ${order.payment_intent_id}, 'payment.authorization.void.requested',
          ${transaction.json({ paymentIntentId: order.payment_intent_id, orderId: order.id, provider: order.provider })},
          ${input.correlationId}, ${`payment:${order.payment_intent_id}:void`}
        ) ON CONFLICT (idempotency_key) DO NOTHING
      `
    }
    if (paid) {
      const [existingCancellationRefund] = await transaction<{ id: string }[]>`
        SELECT id FROM refunds WHERE idempotency_key = ${`cancel:${order.id}:refund`}
      `
      refundId = existingCancellationRefund?.id ?? null
      if (refundId) {
        return { id: input.publicNumber, orderStatus: 'on_hold', refundId, duplicate: true }
      }
      const [refunded] = await transaction<{ amount: number }[]>`
        SELECT COALESCE(sum(amount_cents), 0)::int AS amount
        FROM refunds
        WHERE payment_intent_id = ${order.payment_intent_id}
          AND status NOT IN ('failed', 'cancelled')
      `
      const remaining = order.amount_cents - (refunded?.amount ?? 0)
      if (remaining > 0) {
        const [refund] = await transaction<{ id: string }[]>`
          INSERT INTO refunds (
            order_id, payment_intent_id, amount_cents, status, reason, idempotency_key
          ) VALUES (
            ${order.id}, ${order.payment_intent_id}, ${remaining}, 'requested',
            ${`Cancelación: ${input.reason}`}, ${`cancel:${order.id}:refund`}
          ) ON CONFLICT (idempotency_key) DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key
          RETURNING id
        `
        refundId = refund?.id ?? null
        if (refundId) {
          const fiscalLines = await transaction<
            Array<{
              id: string
              quantity: number
              grossCents: number
              taxRateBasisPoints: number
              sku: string
              name: string
              variantName: string
            }>
          >`
            SELECT id, quantity, total_gross_cents AS "grossCents",
                   tax_rate_basis_points AS "taxRateBasisPoints", sku, name,
                   variant_name AS "variantName"
            FROM order_lines WHERE order_id = ${order.id} ORDER BY id
          `
          const goodsGross = fiscalLines.reduce((total, line) => total + line.grossCents, 0)
          const components = [
            ...fiscalLines.map((line) => ({
              orderLineId: line.id,
              componentType: 'line' as const,
              quantity: line.quantity,
              grossCapacity: line.grossCents,
              taxRateBasisPoints: line.taxRateBasisPoints,
              snapshot: { sku: line.sku, name: line.name, variantName: line.variantName }
            })),
            ...(order.total_gross_cents > goodsGross
              ? [
                  {
                    orderLineId: null,
                    componentType: 'shipping' as const,
                    quantity: 1,
                    grossCapacity: order.total_gross_cents - goodsGross,
                    taxRateBasisPoints: 2100,
                    snapshot: { sku: 'ENVIO', name: 'Gastos de envío', variantName: '' }
                  }
                ]
              : [])
          ]
          let fiscalAllocated = 0
          const fiscalCapacity = components.reduce((total, component) => total + component.grossCapacity, 0)
          for (const [index, component] of components.entries()) {
            const grossCents =
              index === components.length - 1
                ? remaining - fiscalAllocated
                : Math.min(
                    component.grossCapacity,
                    Math.floor((remaining * component.grossCapacity) / Math.max(fiscalCapacity, 1))
                  )
            if (grossCents <= 0) continue
            fiscalAllocated += grossCents
            const split = splitGross(grossCents, component.taxRateBasisPoints)
            await transaction`
              INSERT INTO refund_lines (
                refund_id, order_line_id, component_type, quantity, gross_cents, net_cents,
                tax_cents, tax_rate_basis_points, fiscal_snapshot
              ) VALUES (
                ${refundId}, ${component.orderLineId}, ${component.componentType}, ${component.quantity},
                ${grossCents}, ${split.netCents}, ${split.taxCents}, ${component.taxRateBasisPoints},
                ${transaction.json(component.snapshot)}
              )
            `
          }
          if (fiscalAllocated !== remaining) throw new Error('Cancellation refund fiscal allocation does not balance')
          await transaction`
            INSERT INTO outbox_events (
              aggregate_type, aggregate_id, event_type, payload, correlation_id, idempotency_key
            ) VALUES (
              'refund', ${refundId}, 'refund.execute.requested',
              ${transaction.json({ refundId, orderId: order.id, amountCents: remaining, source: 'admin_cancellation' })},
              ${input.correlationId}, ${`refund:${refundId}:execute`}
            ) ON CONFLICT (idempotency_key) DO NOTHING
          `
        }
      }
    }

    if (!paid && !authorizedOnly) {
      await transaction`
        UPDATE payment_intents SET status = 'cancelled', updated_at = now()
        WHERE id = ${order.payment_intent_id}
      `
    }
    if (!['issued', 'fiscal_pending', 'rectified'].includes(order.invoice_status)) {
      await transaction`
        UPDATE outbox_events
        SET status = 'completed', completed_at = now(), locked_at = NULL, locked_by = NULL,
            last_error_code = 'order_cancelled', last_error_message = 'Invoice cancelled before issue'
        WHERE aggregate_id = ${order.id} AND event_type = 'invoice.issue.requested'
          AND status IN ('pending', 'retry')
      `
    }
    const orderStatus = authorizedOnly || (paid && refundId) ? 'on_hold' : 'cancelled'
    const paymentStatus = authorizedOnly ? 'authorized' : paid ? order.payment_status : 'cancelled'
    await transaction`
      UPDATE orders
      SET order_status = ${orderStatus}, payment_status = ${paymentStatus}, inventory_status = 'released',
          invoice_status = CASE
            WHEN invoice_status IN ('issued', 'fiscal_pending', 'rectified') THEN invoice_status
            ELSE 'not_requested'
          END,
          updated_at = now()
      WHERE id = ${order.id}
    `
    await transaction`
      INSERT INTO order_events (
        order_id, event_type, actor_type, actor_id, origin, reason, from_state, to_state,
        public_data, private_data, correlation_id, idempotency_key
      ) VALUES (
        ${order.id}, ${paid || authorizedOnly ? 'order.cancellation_requested' : 'order.cancelled'}, 'staff', ${input.actorId},
        'admin', ${input.reason},
        ${transaction.json({ order: order.order_status, payment: order.payment_status, inventory: order.inventory_status })},
        ${transaction.json({ order: orderStatus, payment: paymentStatus, inventory: 'released' })},
        ${transaction.json({ refundPending: !!refundId })}, ${transaction.json({ refundId })},
        ${input.correlationId}, ${`admin-cancel:${order.id}`}
      ) ON CONFLICT (order_id, idempotency_key) DO NOTHING
    `
    await transaction`
      INSERT INTO audit_log (
        actor_type, actor_id, action, resource_type, resource_id, before_redacted,
        after_redacted, reason, correlation_id
      ) VALUES (
        'staff', ${input.actorId}, 'order.cancel', 'order', ${input.publicNumber},
        ${transaction.json({ order: order.order_status, payment: order.payment_status, inventory: order.inventory_status })},
        ${transaction.json({ order: orderStatus, payment: paymentStatus, inventory: 'released', refundId })},
        ${input.reason}, ${input.correlationId}
      )
    `
    await transaction`
      INSERT INTO outbox_events (
        aggregate_type, aggregate_id, event_type, payload, correlation_id, idempotency_key
      ) VALUES (
        'order', ${order.id}, ${orderStatus === 'cancelled' ? 'order.cancelled' : 'order.cancellation.requested'},
        ${transaction.json({
          orderId: order.id,
          orderNumber: order.public_number,
          statusLabel: orderStatus === 'cancelled' ? 'cancelado' : 'con cancelación en proceso'
        })}, ${input.correlationId}, ${`order:${order.id}:cancellation-notice`}
      ) ON CONFLICT (idempotency_key) DO NOTHING
    `
    return { id: input.publicNumber, orderStatus, refundId, duplicate: false }
  })
}
